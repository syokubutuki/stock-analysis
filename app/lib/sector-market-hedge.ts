// 系C30「ファクター露出の分離 ─ ヘッジによる建玉ベクトルの完備化」の計算層 ─ H-1 / H-2。
//
// 出発点は C29（sector-factor-select.ts）P1 の実測:
//   採用5本 ＝ 加重セクターβ b=0.97 ＋ 加重市場β c=1.27
//            ＝「TOPIX を 1.27 倍持ち、そこに銀行ファクターが 0.97 乗っているもの」
// つまり銀行株を1単位持つたびに、市場 c と セクター b が**比 b/c=0.76 に溶接された
// 抱き合わせ**でしか建玉を取れない。ヘッジ手段（先物・ETF信用売り）はこの溶接を外す。
//
// 本層の主張は「純度を上げること」ではない（docs/sector-market-hedge.md §0）。
// 純度は h を上げれば必ず上がる（分母が減るだけ）ので目的関数にならない。目的は g = μ − σ²/2。
// ヘッジの価値は**2つの賭けを独立にサイジングできるようになること**であり、それは
// 一階条件が分離することとして現れる:
//
//   x_M* = (π_M + κ_h)/σ_M²                              …【H-1】 L にも b にも m にも依存しない
//   L*   = (b·m − c·κ_h − ι·1{L>1})/(b²σ_F² + σ_ε,p²)    …【H-2】 π_M が消える
//
// π_M（株式リスクプレミアム）も m（セクター因子のドリフト）も C26 により**測れない**。
// ゆえに本層の出力は数値ではなく「あなたが π_M をいくつだと思うなら h はいくつ」という写像で、
// 既定の見立て（π_M=5%）では h\* は負（＝市場を売るのではなく買い増す）になる公算が高い。
//
// ── 価格系列の性質（ここが本層で決定的・docs §0.5）──────────────────────────
// `/api/stock` が返すのは adjClose ベース＝**配当再投資込みのトータルリターン TR**。
//   ・先物売りは −R_M（超過リターンの符号反転）であって −TR_M ではない。配当は先物価格に
//     織り込まれているので、adjClose の系列をそのまま先物に流用してはいけない（§2.4(a)）。
//   ・ETF 信用売りを −h·TR_M と書くと配当落調整金を100%支払ったことになる。制度信用の実際の
//     支払いは配当の 84.685% なので、差の 15.315%·q を戻す（§2.4(b)）。
//
// このファイルは H-1（キャリー）と H-2（HedgeEnv の推定＋閉形式の最適点・損益分岐）まで。
// H-3（面と掃引）/ H-4（効くかどうかの検定）/ H-5（円建てMC）/ H-6（税の Model A/B の UI）は
// docs/sector-market-hedge.md §10 のとおり後続の run で積む。

import {
  DEFAULT_FUTURES_PRODUCT,
  DEFAULT_INDEX_DIV_YIELD,
  DEFAULT_INDEX_LEVEL,
  DEFAULT_RISK_FREE,
  DEFAULT_ROLL_SLIPPAGE,
  FUTURES_TAX_RATE,
  FuturesProduct,
  futuresCommissionAnnualRate,
  notionalPerLot,
  snapToLotGrid,
  spanMarginRate,
  SUBSTITUTE_HAIRCUT,
} from "./rakuten-futures";
import {
  adminFeeMonthlyRate,
  DEFAULT_MARGIN_KIND,
  INITIAL_MARGIN_RATE,
  MarginKind,
  MAX_LEVERAGE,
  RatePlan,
  resolveMarginRate,
} from "./rakuten-margin";
import { buildPanel, FactorPrices, olsNW, orthogonalize } from "./sector-factor-select";
import { geometricGrowth, TRADING_DAYS } from "./growth-drag";
import { benjaminiHochberg, mean, std, studentTwoSidedP } from "./stats-significance";
import { PricePoint } from "./types";

// ════════════════════════════════════════════════════════════════════════════
// 入力
// ════════════════════════════════════════════════════════════════════════════

export type HedgeInstrument = "futures" | "marginShort";

/**
 * 配当落調整金の支払い率 d。制度信用は源泉税相当（15.315%）を控除した 84.685% を授受する。
 * 売り建てなら d·q を払う（残り (1−d)·q は戻り）、買い建てなら d·q しか受け取れない。
 *
 * 本来 rakuten-margin.ts に置くべき定数だが、★1 の実装では既存ファイルを触らない方針のため
 * ここに置く。信用まわりを整理するときに rakuten-margin.ts へ移すこと。
 */
export const DEFAULT_DIVIDEND_ADJ_RATIO = 0.84685; // 要確認（制度信用。一般信用は 1.0 のことがある）

/** 逆日歩の年率。制度信用のみ発生し、変動する（青天井）。 */
export const DEFAULT_GYAKU_HIBU = 0.003; // 要確認（平時の目安。ストレス時は 0.02 を当てる）
export const STRESS_GYAKU_HIBU = 0.02; // 要確認

export interface HedgeParams {
  // ── 見立て（測れない量。必ずスライダーで開く）──
  /** 株式リスクプレミアム π_M（年率・超過）。 */
  piM: number;
  /** セクター因子のドリフト m（年率）。 */
  m: number;

  // ── 市場環境 ──
  /** 無リスク金利 r（年率）。 */
  riskFree: number;
  /** 指数の配当利回り q（年率）。 */
  indexDivYield: number;
  /** 指数水準（先物の刻み計算用）。 */
  indexLevel: number;

  // ── 手段 ──
  instrument: HedgeInstrument;
  futuresProduct: FuturesProduct;
  marginKind: MarginKind;
  ratePlan: RatePlan;
  /** 逆日歩の年率。制度信用のときだけ効く。 */
  gyakuHibu: number;
  /** 配当落調整金の支払い率 d。 */
  dividendAdjRatio: number;
  /** 限月ロールの滑り（年率）。 */
  rollSlippage: number;

  // ── 税（H-6 で UI を積む。既定は OFF）──
  taxOn: boolean;
  /** netted = Model A（現物と完全通算できる理想）/ realized = Model B（ヘッジ益のみ課税）。 */
  taxModel: "netted" | "realized";
  taxRate: number;
  /** 損の繰越で回収できる割合（0=まったく回収できない, 1=全額回収）。 */
  carryRecovery: number;

  // ── 建玉 ──
  /** 元本 V（円）。 */
  capital: number;
  /** 先物の枚数の刻みを制約に入れるか。 */
  useDiscreteGrid: boolean;
  maxLeverage: number;

  // ── 推定 ──
  /** 推定窓（営業日）。P1 と同じ既定 750。 */
  window: number;
  /** ローリング c の窓（H-4 で使う）。 */
  rollWindow: number;
  /** 円建てMC（H-5）用。 */
  seed: number;
  nPaths: number;
  blockLen: number;
}

export const DEFAULT_HEDGE_PARAMS: HedgeParams = {
  piM: 0.05,
  m: 0.03,
  riskFree: DEFAULT_RISK_FREE,
  indexDivYield: DEFAULT_INDEX_DIV_YIELD,
  indexLevel: DEFAULT_INDEX_LEVEL,
  instrument: "futures",
  futuresProduct: DEFAULT_FUTURES_PRODUCT,
  marginKind: DEFAULT_MARGIN_KIND,
  ratePlan: "standard",
  gyakuHibu: DEFAULT_GYAKU_HIBU,
  dividendAdjRatio: DEFAULT_DIVIDEND_ADJ_RATIO,
  rollSlippage: DEFAULT_ROLL_SLIPPAGE,
  taxOn: false,
  taxModel: "realized",
  taxRate: FUTURES_TAX_RATE,
  carryRecovery: 0.5,
  capital: 10_000_000,
  useDiscreteGrid: false,
  maxLeverage: MAX_LEVERAGE,
  window: 750,
  rollWindow: 250,
  seed: 42,
  nPaths: 2000,
  blockLen: 21,
};

// ════════════════════════════════════════════════════════════════════════════
// 推定された市場環境（実測。仮定ではない）
// ════════════════════════════════════════════════════════════════════════════

export interface HedgeEnv {
  /** 加重市場β（P1 のウェイトで合成したバスケットを [M, F] に回帰した係数）。 */
  c: number;
  cSe: number;
  /** 加重セクターβ。 */
  b: number;
  bSe: number;
  /** 年率ボラ。 */
  sigmaM: number;
  sigmaF: number;
  /** バスケットの固有ボラ σ_ε,p（年率）。 */
  sigmaEps: number;
  /** h=0 の純度（分散ベース）= b²σ_F²/(c²σ_M² + b²σ_F²)。 */
  purity0: number;

  // ── 後続層（H-4/H-5）が使う系列。すべて日次の超過リターン ──
  basketRet: number[];
  marketRet: number[];
  /** 市場に直交化したセクター因子 F（全標本で直交化したもの）。 */
  factorRet: number[];
  /**
   * 直交化する**前**のセクター系列（1615.T か等加重バスケット）。
   * H-4 のローリング推定は「その時点までの窓だけ」で直交化し直さないと、
   * 直交化の係数を通じて全標本の情報が漏れる（先読み）。そのために生の系列を持つ。
   */
  sectorRetRaw: number[];
  dates: string[];

  // ── 診断 ──
  nObs: number;
  dateFrom: string;
  dateTo: string;
  /** 実際に使えたウェイト（パネルから落ちた銘柄を除いて再正規化したもの）。 */
  usedWeights: { ticker: string; weight: number }[];
  /** 信用の事務管理費を年率換算するための市場ETF（1306.T）の直近終値。 */
  etfRefPrice: number;
  factorSource: "etf" | "basket";
  warnings: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// キャリー κ_h（docs §2.4）
// ════════════════════════════════════════════════════════════════════════════

export interface CarryBreakdown {
  /** 先物: 0 / ETF信用売り: +r（売却代金に金利が付かない機会損失）/ 信用買い: ι = 買方金利 − r。 */
  financing: number;
  /** 貸株料。 */
  borrowFee: number;
  gyakuHibu: number;
  /** 配当落調整金の税相当分。売り建てでは戻り（負）、買い建てでは取りっぱぐれ（正）。 */
  dividendCredit: number;
  adminFee: number;
  /** ロール滑り＋売買手数料。 */
  slippage: number;
  taxDrag: number;
  /** κ_h。**符号の約束: 常に「コスト」なので正**。 */
  total: number;
}

const ZERO_CARRY: CarryBreakdown = {
  financing: 0,
  borrowFee: 0,
  gyakuHibu: 0,
  dividendCredit: 0,
  adminFee: 0,
  slippage: 0,
  taxDrag: 0,
  total: 0,
};

function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/** Abramowitz–Stegun 7.1.26 による erf。 */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return s * y;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * 税ドラッグ（docs §2.5）。ヘッジは限月ロール／期限で**必ず定期的に実現する**ので、
 * 現物の含み損益と違って繰延べが効かない。年次のヘッジ損益を X ~ N(−s·π_M, σ_M²)（建玉1単位）
 * と近似し、Model B（実現ベース）では利益側にだけ課税される非対称を年率のコストに直す。
 *
 *   E[X⁺] = μ_X·Φ(μ_X/σ_X) + σ_X·φ(μ_X/σ_X)
 *   税ドラッグ = τ·E[X⁺]·(1 − 繰越回収率)
 *
 * 設計書は φ(0) を使った上界 τ·σ_M·0.399 を書いているが、ドリフトを落とすと売り建てで
 * 3割ほど過大になるので、ここでは E[X⁺] を厳密に評価する（差は報告に載せる）。
 * Model A（完全通算）は水準効果 τ·μ_p であってヘッジ固有のキャリーではないため 0 を返す。
 */
function taxDragRate(env: HedgeEnv, p: HedgeParams, side: 1 | -1): number {
  if (!p.taxOn || p.taxModel !== "realized") return 0;
  const sM = env.sigmaM;
  if (!(sM > 0)) return 0;
  const muX = -side * p.piM;
  const z = muX / sM;
  const ePlus = muX * normalCdf(z) + sM * normalPdf(z);
  return Math.max(0, p.taxRate * ePlus * (1 - p.carryRecovery));
}

/**
 * ヘッジ手段のキャリー κ_h（年率・建玉 notional 比）を内訳つきで返す。
 *
 * **h の符号でキャリーが変わる**。設計書【H-1】は x_M\* = (π_M + κ_h)/σ_M² と書いているが、
 * これは h>0（＝市場を売る）の断面での式であり、そのまま h<0 に使うと
 * 「ヘッジ手段が高いほど市場を買い増すべき」という逆向きの結論が出る。
 * 実体としても、h<0 は市場の**買い**（先物買い／ETF信用買い）であってコストの内訳が別物なので、
 * ここでは sign(h) でキャリーを切り替える。h=0 は売り側（参照値）を返す。
 *
 * 返す total は**常に正のコスト**。一階条件側で
 *   ∂g/∂h = −π_M − sign(h)·κ + (Lc − h)·σ_M²
 * として符号を扱う。
 */
export function hedgeCarry(env: HedgeEnv, p: HedgeParams, h = 1): CarryBreakdown {
  const side: 1 | -1 = h < 0 ? -1 : 1;
  const out: CarryBreakdown = { ...ZERO_CARRY };
  const q = p.indexDivYield;
  const r = p.riskFree;

  if (p.instrument === "futures") {
    // 先物は売りも買いもキャリーが無い（配当は価格に織り込み済み・§2.4(a)）。
    // 残るのはロール滑りと手数料だけで、これは売買の向きに対して対称。
    out.slippage = p.rollSlippage + futuresCommissionAnnualRate(p.indexLevel, p.futuresProduct);
  } else {
    const rate = resolveMarginRate(p.marginKind, p.ratePlan);
    // 事務管理費: 1株あたり月11銭 → 市場ETF の株価で年率換算。**低位株ほど相対負担が重い**。
    // 1306.T は 425円（2026-08 実測）なので 0.31%/年 になり、設計書が想定した 0.04%（株価3,000円）の
    // 8倍。κ_margin の 15% を占めるので無視できない。// 要確認（ETF/ETN の事務管理費が
    // 現物株と同じ 11銭/株/月 かは楽天の規定で要確認。名義書換料は ETF だけ 5.5円と別扱い）。
    out.adminFee = adminFeeMonthlyRate(env.etfRefPrice) * 12;
    if (side > 0) {
      // 売り建て = −TR_M + (1−d)q − f_short − f_gyaku − f_admin
      //          = −(R_M + κ) + r  ⟹  κ = r + f_short + f_gyaku + f_admin − (1−d)q
      out.financing = r;
      out.borrowFee = rate.shortRate;
      // 逆日歩は制度信用にしか発生しない（一般信用は貸株料が高いかわりに逆日歩なし）。
      out.gyakuHibu = p.marginKind === "system" ? p.gyakuHibu : 0;
      out.dividendCredit = -(1 - p.dividendAdjRatio) * q;
    } else {
      // 買い建て（h<0 ＝ 市場の買い増し）= (TR_M − q) + d·q − 買方金利
      //          = TR_M − (1−d)q − 買方金利  ⟹  κ = 買方金利 − r + (1−d)q
      // 配当落調整金は売りでは戻り（負）だったのが、買いでは取りっぱぐれ（正）に反転する。
      //
      // **これは上界**。L<1 なら手元に現金が余っているので、h<0 は信用を使わず
      // 1306.T の現物買いで作れる（docs §1.1）。その経路の κ はほぼ 0（ETF の信託報酬のみ）。
      // 手段セレクタに「現物買い」を足すのは H-3 の UI 作業なので、ここでは保守側に倒しておく。
      out.financing = rate.longRate - r;
      out.dividendCredit = (1 - p.dividendAdjRatio) * q;
    }
  }
  out.taxDrag = taxDragRate(env, p, side);
  out.total =
    out.financing +
    out.borrowFee +
    out.gyakuHibu +
    out.dividendCredit +
    out.adminFee +
    out.slippage +
    out.taxDrag;
  return out;
}

/** 手段を差し替えたキャリーを比較用に両方まとめて出す（画面の H3/H4 で並べる）。 */
export function carryComparison(
  env: HedgeEnv,
  p: HedgeParams
): { futures: CarryBreakdown; marginShort: CarryBreakdown } {
  return {
    futures: hedgeCarry(env, { ...p, instrument: "futures" }, 1),
    marginShort: hedgeCarry(env, { ...p, instrument: "marginShort" }, 1),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 目的関数 g(L, h)
// ════════════════════════════════════════════════════════════════════════════

export interface OptimumPoint {
  L: number;
  h: number;
  /** 市場ファクターへの正味露出 x_M = L·c − h。 */
  xM: number;
  /** セクターへの正味露出 x_F = L·b。 */
  xF: number;
  /** 自己資金の超過リターン（年率・算術）。 */
  mu: number;
  sigma: number;
  /** g = μ − σ²/2。 */
  g: number;
  purity: number;
  feasible: boolean;
  binding: "none" | "leverage" | "margin" | "grid";
}

/** 信用買いのスプレッド ι = 買方金利 − r。L>1 のときだけ効く。 */
export function marginSpread(p: HedgeParams): number {
  return Math.max(0, resolveMarginRate(p.marginKind, p.ratePlan).longRate - p.riskFree);
}

/**
 * 証拠金の充足チェック（静的・新規建て時点）。
 * 追証と強制決済という吸収壁そのものは g = μ − σ²/2 に入らないので H-5 の円建てMCで別に測る。
 * ここで見るのは「そもそもその建玉が建てられるか」だけ。
 *
 *   充当できる担保 / V = L≥1 なら 代用有価証券の掛目 0.80、L<1 なら (1−L) + L·0.80
 *   必要額 / V       = (L−1)⁺·委託保証金率 ＋ ヘッジ分（信用は |h|·委託保証金率、先物は |h|·SPAN率）
 */
function marginOk(p: HedgeParams, L: number, h: number): boolean {
  const collateral = L >= 1 ? SUBSTITUTE_HAIRCUT : 1 - L + L * SUBSTITUTE_HAIRCUT;
  const hedgeNeed =
    p.instrument === "marginShort"
      ? Math.abs(h) * INITIAL_MARGIN_RATE
      : Math.abs(h) * spanMarginRate(p.indexLevel, p.futuresProduct);
  const need = Math.max(0, L - 1) * INITIAL_MARGIN_RATE + hedgeNeed;
  return need <= collateral + 1e-9;
}

/**
 * 任意の (L, h) での μ・σ・g・純度。閉形式の検算（格子探索）にも使うので export する。
 *
 *   μ_p  = L·(c·π_M + b·m) − h·π_M − |h|·κ(sign h) − (L−1)⁺·ι
 *   σ_p² = x_M²σ_M² + x_F²σ_F² + L²σ_ε,p²
 *   g    = μ_p − σ_p²/2      ← μ は算術。対数μに −σ²/2 を重ねない
 */
export function evaluatePoint(env: HedgeEnv, p: HedgeParams, L: number, h: number): OptimumPoint {
  const kappa = hedgeCarry(env, p, h === 0 ? 1 : h).total;
  const iota = marginSpread(p);
  const xM = L * env.c - h;
  const xF = L * env.b;
  const mu =
    L * (env.c * p.piM + env.b * p.m) -
    h * p.piM -
    Math.abs(h) * kappa -
    Math.max(0, L - 1) * iota;
  const varM = xM * xM * env.sigmaM * env.sigmaM;
  const varF = xF * xF * env.sigmaF * env.sigmaF;
  const varE = L * L * env.sigmaEps * env.sigmaEps;
  const sigma = Math.sqrt(Math.max(0, varM + varF + varE));
  const sys = varM + varF;
  return {
    L,
    h,
    xM,
    xF,
    mu,
    sigma,
    g: geometricGrowth(mu, sigma),
    purity: sys > 0 ? varF / sys : 0,
    feasible: L <= p.maxLeverage + 1e-9 && L >= -1e-9 && marginOk(p, L, h),
    binding: "none",
  };
}

/**
 * L を固定したときの最適 h（厳密）。|h|·κ の折れ目があるので3つの領域に分かれる。
 *
 *   h>0 側: x_M = (π_M + κ_short)/σ_M²   … 【H-1】
 *   h<0 側: x_M = (π_M − κ_long )/σ_M²
 *   その間: h = 0（不動帯。キャリーが両側から挟むぶんの幅がある）
 */
export function bestHGivenL(env: HedgeEnv, p: HedgeParams, L: number): number {
  const sM2 = env.sigmaM * env.sigmaM;
  if (!(sM2 > 0)) return 0;
  const kS = hedgeCarry(env, p, 1).total;
  const kL = hedgeCarry(env, p, -1).total;
  const hShort = L * env.c - (p.piM + kS) / sM2;
  if (hShort > 0) return hShort;
  const hLong = L * env.c - (p.piM - kL) / sM2;
  if (hLong < 0) return hLong;
  return 0;
}

/**
 * h を固定したときの最適 L（厳密）。ι の折れ目を L=1 で処理する。
 *   L·(c²σ_M² + b²σ_F² + σ_ε²) = c·π_M + b·m − ι·1{L>1} + h·c·σ_M²
 */
export function bestLGivenH(env: HedgeEnv, p: HedgeParams, h: number): number {
  const sM2 = env.sigmaM * env.sigmaM;
  const D = env.b * env.b * env.sigmaF * env.sigmaF + env.sigmaEps * env.sigmaEps;
  const den = env.c * env.c * sM2 + D;
  if (!(den > 0)) return 0;
  const iota = marginSpread(p);
  const num = env.c * p.piM + env.b * p.m + h * env.c * sM2;
  const withIota = (num - iota) / den;
  const without = num / den;
  const L = withIota > 1 ? withIota : without < 1 ? without : 1;
  return Math.min(p.maxLeverage, Math.max(0, L));
}

function clampL(L: number, p: HedgeParams): number {
  return Math.min(p.maxLeverage, Math.max(0, L));
}

/**
 * 【H-1】【H-2】の閉形式による最適点。
 *
 * g は (L,h) の凹関数（二次形式のマイナス ＋ 凹な折れ目 −|h|κ・−(L−1)⁺ι）なので、
 * 各領域の KKT 点と折れ目・端点を列挙して g 最大を取れば大域最適になる。
 * `useDiscreteGrid` のときは連続解の近傍2点へスナップし、L と h を交互に更新して詰める。
 */
export function optimalPoint(env: HedgeEnv, p: HedgeParams): OptimumPoint {
  const sM2 = env.sigmaM * env.sigmaM;
  const D = env.b * env.b * env.sigmaF * env.sigmaF + env.sigmaEps * env.sigmaEps;
  const iota = marginSpread(p);
  const kS = hedgeCarry(env, p, 1).total;
  const kL = hedgeCarry(env, p, -1).total;

  // L の候補: 3つの h 領域 × ι の有無 の KKT 点、＋ 折れ目 L=1 と端点。
  const cands: number[] = [0, 1, p.maxLeverage];
  if (D > 0) {
    cands.push((env.b * p.m - env.c * kS) / D, (env.b * p.m - env.c * kS - iota) / D);
    cands.push((env.b * p.m + env.c * kL) / D, (env.b * p.m + env.c * kL - iota) / D);
  }
  const denNo = env.c * env.c * sM2 + D;
  if (denNo > 0) {
    cands.push((env.c * p.piM + env.b * p.m) / denNo, (env.c * p.piM + env.b * p.m - iota) / denNo);
  }

  // 刻み制約は先物にしか無い（ETF信用は1単元＝数千円なので実質連続）。
  const useGrid = p.useDiscreteGrid && p.instrument === "futures";
  const step = useGrid ? hedgeGridStep(p) : 0;

  let best = evaluatePoint(env, p, 0, 0);
  const consider = (L: number, h: number) => {
    const pt = evaluatePoint(env, p, clampL(L, p), h);
    if (pt.g > best.g) best = pt;
  };

  for (const raw of cands) {
    const L = clampL(raw, p);
    const hCont = bestHGivenL(env, p, L);
    if (useGrid && step > 0) {
      // g は h について凹なので、L を固定すれば格子上の最適は連続解の両隣のどちらか。
      consider(L, Math.floor(hCont / step) * step);
      consider(L, Math.ceil(hCont / step) * step);
    } else {
      consider(L, hCont);
    }
    consider(L, 0); // 不動帯の内側に落ちる場合の保険（格子上でもあり）
  }

  if (useGrid && step > 0) {
    // 格子に載せると最適 L も動くので、(L,h) を交互最適化して詰める。
    for (const seed of [best.h, 0]) {
      let h = snapToLotGrid(seed, p.capital, p.indexLevel, p.futuresProduct);
      let L = bestLGivenH(env, p, h);
      for (let it = 0; it < 4; it++) {
        h = snapToLotGrid(bestHGivenL(env, p, L), p.capital, p.indexLevel, p.futuresProduct);
        L = bestLGivenH(env, p, h);
      }
      consider(L, h);
    }
  }

  let binding: OptimumPoint["binding"] = "none";
  if (best.L >= p.maxLeverage - 1e-9) binding = "leverage";
  else if (!best.feasible) binding = "margin";
  else if (useGrid && Math.abs(bestHGivenL(env, p, best.L) - best.h) > 1e-9) binding = "grid";
  return { ...best, binding };
}

/** h の刻み幅 = 1枚の想定元本 / 元本 V。元本が小さいほど粗くなる。 */
export function hedgeGridStep(p: HedgeParams): number {
  if (!(p.capital > 0)) return 0;
  return notionalPerLot(p.indexLevel, p.futuresProduct) / p.capital;
}

/** §2.2: ヘッジ手段を持たない（h=0 固定）ときの最適 L。ヘッジの価値はこの点との g 差。 */
export function optimalNoHedge(env: HedgeEnv, p: HedgeParams): OptimumPoint {
  const L = bestLGivenH(env, p, 0);
  const pt = evaluatePoint(env, p, L, 0);
  return { ...pt, binding: L >= p.maxLeverage - 1e-9 ? "leverage" : pt.feasible ? "none" : "margin" };
}

/**
 * 損益分岐（docs §2.1【H-3】/ §2.3【H-4】【H-5】）。すべて L=1 の断面で読む。
 *
 *   anyHedge  : π_M < c·σ_M² − κ      少しでも売るべき
 *   fullHedge : π_M < c·σ_M²/2 − κ    完全ヘッジ h=c が h=0 より g を上げる
 *   mThreshold: m > c·κ/b             そもそも銀行を建てる価値がある金利観（ι=0＝信用買いなし）
 */
export function breakEvenPiM(
  env: HedgeEnv,
  p: HedgeParams
): { anyHedge: number; fullHedge: number; mThreshold: number } {
  const sM2 = env.sigmaM * env.sigmaM;
  const kS = hedgeCarry(env, p, 1).total;
  return {
    anyHedge: env.c * sM2 - kS,
    fullHedge: (env.c * sM2) / 2 - kS,
    mThreshold: env.b > 0 ? (env.c * kS) / env.b : Infinity,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// HedgeEnv の推定（docs §4.3 の手順1〜6）
// ════════════════════════════════════════════════════════════════════════════

/**
 * P1 の採用ウェイトで銀行バスケットを合成し、市場β c・セクターβ b・各ボラを実測する。
 *
 * 手順（設計書 §4.3）:
 *   1. buildPanel（**書き直さない**。履歴カバレッジ95%と価格破損の網が入っている）
 *   2. バスケット日次リターン = Σ_i w_i·ret_i（P1 の weight をそのまま使う）
 *   3. F = orthogonalize(セクターETF or 等加重バスケット, 市場)  ← P1 と同じ因子定義
 *   4. olsNW(basket, [1, M, F]) → c, b, σ_ε,p。σ_M, σ_F は std×√252
 *   5. purity0 = b²σ_F²/(c²σ_M² + b²σ_F²)
 *   6. 系列は超過（−r/252）で保持。H-4 の先読みなし検証がそのまま使えるようにする
 *
 * F は市場に直交化してあるので、[1, M, F] の重回帰の M の係数は単回帰の市場βと一致し、
 * c は「P1 の各銘柄の市場βをウェイトで加重平均したもの」に厳密に一致する（OLS は y に線形）。
 * ＝ 受け入れ基準2（c=1.27 / b=0.97）はこの性質で担保される。
 */
export function buildHedgeEnv(
  pricesByTicker: Record<string, PricePoint[]>,
  factors: FactorPrices,
  weights: { ticker: string; weight: number }[],
  paramsIn: Partial<HedgeParams> = {}
): HedgeEnv | null {
  const p = { ...DEFAULT_HEDGE_PARAMS, ...paramsIn };
  const warnings: string[] = [];

  const panel = buildPanel(pricesByTicker, factors.market, factors.sector, p.window);
  if (!panel) return null;
  const T = panel.market.length;

  // ── 2. ウェイトをパネルの銘柄に対応づけて再正規化 ──
  const wMap = new Map(weights.map((w) => [w.ticker, w.weight]));
  const idx: number[] = [];
  const raw: number[] = [];
  for (let i = 0; i < panel.tickers.length; i++) {
    const w = wMap.get(panel.tickers[i]) ?? 0;
    if (w > 0) {
      idx.push(i);
      raw.push(w);
    }
  }
  const sumW = raw.reduce((s, v) => s + v, 0);
  if (idx.length === 0 || !(sumW > 0)) return null;
  const wNorm = raw.map((v) => v / sumW);
  if (Math.abs(sumW - 1) > 1e-6) {
    warnings.push(
      `採用ウェイトの合計が ${(sumW * 100).toFixed(1)}% だった（パネルに載らなかった銘柄がある）。` +
        `残った ${idx.length} 銘柄で再正規化してバスケットを合成した。`
    );
  }
  const missing = weights.filter((w) => w.weight > 0 && !panel.tickers.includes(w.ticker));
  if (missing.length > 0) {
    warnings.push(
      `採用銘柄のうち ${missing.map((x) => x.ticker).join(", ")} は履歴が窓に足りずパネルから外れた。`
    );
  }

  const basket = new Array<number>(T).fill(0);
  for (let k = 0; k < idx.length; k++) {
    const r = panel.ret[idx[k]];
    for (let t = 0; t < T; t++) basket[t] += wNorm[k] * r[t];
  }

  // ── 3. 因子（P1 と同じ定義。ETF が窓長に足りなければ等加重バスケットへ退避）──
  const factorSource: "etf" | "basket" = panel.etf ? "etf" : "basket";
  if (factorSource === "basket") {
    warnings.push(
      "セクターETF（1615.T）の履歴が窓長に足りないため、等加重バスケットを因子にした。P1 と因子定義が変わるので c/b の水準は直接比較できない。"
    );
  }
  const sectorRaw = factorSource === "etf" ? panel.etf! : panel.basket;
  const F = orthogonalize(sectorRaw, panel.market);

  // ── 4. バスケットを [1, M, F] に回帰 ──
  const X: number[][] = [];
  for (let t = 0; t < T; t++) X.push([1, panel.market[t], F[t]]);
  const fit = olsNW(basket, X, 5);
  if (!fit) return null;

  const c = fit.beta[1];
  const b = fit.beta[2];
  const ann = Math.sqrt(TRADING_DAYS);
  const sigmaM = std(panel.market) * ann;
  const sigmaF = std(F) * ann;
  const sigmaEps = fit.sigmaResid * ann;

  // ── 5. 純度（分散ベース）──
  const varM = c * c * sigmaM * sigmaM;
  const varF = b * b * sigmaF * sigmaF;
  const purity0 = varM + varF > 0 ? varF / (varM + varF) : 0;

  // ── 6. 超過リターンで保持（r は年率なので営業日で割る）──
  const rDaily = p.riskFree / TRADING_DAYS;
  const basketRet = basket.map((v) => v - rDaily);
  const marketRet = panel.market.map((v) => v - rDaily);

  const etfRefPrice = lastClose(factors.market);
  if (!(etfRefPrice > 0)) {
    warnings.push("市場ETF の終値が取れなかったため、信用売りの事務管理費を 0 として扱った。");
  }
  if (panel.glitchesFixed > 0) {
    warnings.push(
      `価格スケールの破損が ${panel.glitchesFixed} 点、取得層の修復を通り抜けたためリターンを 0 に置換した（1306.T は P0 で実際に踏んでいる）。`
    );
  }
  if (T < 500) {
    warnings.push(`標本が ${T} 営業日と短い。σ_M・c の水準は窓依存なので期間分割で必ず確認すること。`);
  }

  return {
    c,
    cSe: fit.se[1],
    b,
    bSe: fit.se[2],
    sigmaM,
    sigmaF,
    sigmaEps,
    purity0,
    basketRet,
    marketRet,
    factorRet: F,
    sectorRetRaw: sectorRaw.map((v) => v - rDaily),
    dates: panel.dates,
    nObs: T,
    dateFrom: panel.dates[0],
    dateTo: panel.dates[panel.dates.length - 1],
    usedWeights: idx.map((i, k) => ({ ticker: panel.tickers[i], weight: wNorm[k] })),
    etfRefPrice: etfRefPrice > 0 ? etfRefPrice : 0,
    factorSource,
    warnings,
  };
}

function lastClose(ps: PricePoint[] | null | undefined): number {
  if (!ps || ps.length === 0) return 0;
  for (let i = ps.length - 1; i >= 0; i--) if (ps[i].close > 0) return ps[i].close;
  return 0;
}

/** 実測の中心値を1行にまとめる（デバッグ・スモークテスト用）。 */
export function describeEnv(env: HedgeEnv): string {
  return (
    `c=${env.c.toFixed(3)}±${env.cSe.toFixed(3)} b=${env.b.toFixed(3)}±${env.bSe.toFixed(3)} ` +
    `σ_M=${(env.sigmaM * 100).toFixed(1)}% σ_F=${(env.sigmaF * 100).toFixed(1)}% ` +
    `σ_ε=${(env.sigmaEps * 100).toFixed(1)}% 純度=${(env.purity0 * 100).toFixed(1)}% ` +
    `n=${env.nObs} (${env.dateFrom}〜${env.dateTo})`
  );
}

/** 平均超過リターンの実測（参考。μ は測れないので判断には使わない）。 */
export function realizedExcessMean(xs: number[]): number {
  return mean(xs) * TRADING_DAYS;
}

// ════════════════════════════════════════════════════════════════════════════
// H-4: ヘッジは本当に効くのか（docs §2.6 の4検定）
// ════════════════════════════════════════════════════════════════════════════
//
// ここまで c を定数として扱ってきたが、P2 は **b の順位は恒久的でも水準は窓依存**、かつ
// 3本（みずほ・りそな・千葉銀）が市場下落日に b を増やすことを実測している。
// c にも同じ疑いがあり、確かめないと「暴落時だけヘッジが足りない」を見逃す。
//
// **この層は h\* の符号と無関係に価値がある**（docs §10）。ヘッジしないと決めた場合でも
// 「暴落時に自分が実際に何倍の市場を持っているか」は建玉判断に必要だからだ。

export interface RollingC {
  date: string;
  c: number;
  se: number;
}

export interface EquityPoint {
  time: string;
  value: number;
}

export interface HedgeEfficacy {
  // ── (i) ローリング c ──
  rollC: RollingC[];
  /** 1 − sd_t(c_t)/mean_t(SE_t)。**負なら c は推定誤差では説明できないほど時変**。 */
  trust: number;

  // ── (ii) 先読みなしヘッジ後の実現β ──
  /** ヘッジ後系列を市場に回帰した係数。0 なら市場露出は消えている。 */
  oosBeta: number;
  oosBetaSe: number;
  oosBetaT: number;
  oosBetaP: number;
  oosN: number;
  oosFrom: string;
  oosTo: string;
  /**
   * 先読みなし検証が成立したか（標本が足りているか）。false のときの oosBeta/t は無意味で、
   * **「|t|<2 だからヘッジ成立」と読んではいけない**。窓が短い・因子が退化している等で起きる。
   */
  oosAvailable: boolean;
  /** 実際に建てた h_t = ĉ_{t−1} の平均と散らばり。 */
  meanHedgeRatio: number;
  sdHedgeRatio: number;

  // ── (iii) 上下非対称 ──
  cUp: number;
  cDown: number;
  asymT: number;
  asymP: number;

  // ── (iv) ヘッジ後の b 保存 ──
  /** ヘッジ後系列の b（OOS 区間）。 */
  bPreserved: number;
  bPreservedSe: number;
  /** 同じ日の無ヘッジ系列の b。窓が違うので env.b とは直接比べない。 */
  bRawOos: number;
  bRawOosSe: number;
  /** 差 (bPreserved − bRawOos) を差の系列で直接検定した t / p。 */
  bDriftT: number;
  bDriftP: number;

  /** 3検定（実現β・非対称・b保存）の BH-FDR 補正後 q 値。 */
  qValues: { oosBeta: number; asym: number; bDrift: number };

  // ── 資産曲線（超過リターンの累積）──
  hedgedEquity: EquityPoint[];
  rawEquity: EquityPoint[];
  hedgedMaxDD: number;
  rawMaxDD: number;
  hedgedVol: number;
  rawVol: number;

  /** |t| < 2 ならヘッジ成立（docs §8-7）。 */
  hedgeHolds: boolean;
  /** c⁻ が c⁺ より有意に大きい＝下げ相場でヘッジが足りない。 */
  asymBroken: boolean;
  warnings: string[];
}

/**
 * 窓 [s, e) だけで c と b を推定する。**F はこの窓の中で直交化し直す**。
 *
 * 全標本で作った env.factorRet を使うと、直交化の係数を通じて未来の情報が漏れる。
 * なお F を窓内で直交化すれば F ⊥ M なので、3変数回帰の M の係数は
 * 単回帰の市場βと厳密に一致する（＝c の点推定はどちらでも同じ）。
 * ここで3変数のまま回すのは、SE を P1 の c の定義と揃えるため。
 */
function windowFit(
  env: HedgeEnv,
  s: number,
  e: number,
  lag: number
): { c: number; cSe: number; b: number } | null {
  if (e - s < 30) return null;
  const M = env.marketRet.slice(s, e);
  const y = env.basketRet.slice(s, e);
  const F = orthogonalize(env.sectorRetRaw.slice(s, e), M);
  const X: number[][] = [];
  for (let t = 0; t < M.length; t++) X.push([1, M[t], F[t]]);
  const fit = olsNW(y, X, lag);
  return fit ? { c: fit.beta[1], cSe: fit.se[1], b: fit.beta[2] } : null;
}

function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) dd = Math.min(dd, v / peak - 1);
  }
  return dd;
}

/**
 * docs §2.6 の4検定。**先読み厳禁**: c は必ずその時点までの窓のみで推定する。
 *
 * (i)   ローリング c と trust
 * (ii)  h_t = ĉ_{t−1} で組んだ先読みなしヘッジ系列の実現β（|t|<2 なら成立）
 * (iii) 市場上昇日 c⁺ / 下落日 c⁻ の非対称（P2 の computeAsymmetry と同じ検定形式）
 * (iv)  ヘッジ後の b 保存
 */
export function computeEfficacy(env: HedgeEnv, p: HedgeParams): HedgeEfficacy {
  const T = env.marketRet.length;
  const warnings: string[] = [];
  const W = Math.max(60, Math.min(p.rollWindow, T - 60));

  // ── (i) ローリング c（21営業日ステップ）─────────────────────────────────
  //
  // trust は P2（sector-factor-stability.ts の computeDecision）と同じ形
  //   trust = 1 − sd_t(ĉ_t) / mean_t(SE_t)
  // だが、**P2 が行っていた横断平均の除去はしない**。P2 は「銀行全体で b の水準が
  // 揃って動いても順位（＝選別）は損なわれない」ので共通成分を抜くのが正しかった。
  // ★1 にはそもそも横断が無く、しかも**ヘッジ量は c の水準そのもの**なので、
  // 共通の水準変化こそが効かないヘッジの原因になる。抜いてはいけない。
  const rollC: RollingC[] = [];
  for (let e = W; e <= T; e += 21) {
    const f = windowFit(env, e - W, e, 5);
    if (f) rollC.push({ date: env.dates[e - 1], c: f.c, se: f.cSe });
  }
  if (rollC.length > 0 && rollC[rollC.length - 1].date !== env.dates[T - 1]) {
    const f = windowFit(env, T - W, T, 5);
    if (f) rollC.push({ date: env.dates[T - 1], c: f.c, se: f.cSe });
  }
  const cSeries = rollC.map((r) => r.c);
  const seMean = mean(rollC.map((r) => r.se));
  const trust = rollC.length >= 3 && seMean > 0 ? 1 - std(cSeries) / seMean : 0;
  if (trust < 0) {
    warnings.push(
      `ローリング c の散らばり（sd=${std(cSeries).toFixed(3)}）が推定誤差（平均SE=${seMean.toFixed(3)}）より大きい。` +
        `c は定数ではなく時変なので、固定 h のヘッジは構造的に取り残しを持つ。`
    );
  }

  // ── (ii) 先読みなしヘッジ ────────────────────────────────────────────
  // 各日 t のヘッジ比は [t−W, t−1] の窓だけで推定した ĉ。t 当日は一切使わない。
  const hedgedLog: number[] = [];
  const rawLog: number[] = [];
  const hedgedSimple: number[] = [];
  const rawSimple: number[] = [];
  const oosDates: string[] = [];
  const hUsed: number[] = [];
  const oosM: number[] = [];
  const oosSector: number[] = [];
  const kShort = hedgeCarry(env, p, 1).total / TRADING_DAYS;
  const kLong = hedgeCarry(env, p, -1).total / TRADING_DAYS;

  for (let t = W; t < T; t++) {
    const f = windowFit(env, t - W, t, 0); // 点推定だけ要るので HAC は不要
    if (!f) continue;
    const h = f.c;
    const carry = Math.abs(h) * (h >= 0 ? kShort : kLong);
    hedgedLog.push(env.basketRet[t] - h * env.marketRet[t]);
    rawLog.push(env.basketRet[t]);
    // 資産曲線は算術（単利）で積む。対数リターンの線形結合は建玉の実損益ではない。
    hedgedSimple.push(Math.expm1(env.basketRet[t]) - h * Math.expm1(env.marketRet[t]) - carry);
    rawSimple.push(Math.expm1(env.basketRet[t]));
    oosDates.push(env.dates[t]);
    hUsed.push(h);
    oosM.push(env.marketRet[t]);
    oosSector.push(env.sectorRetRaw[t]);
  }
  const n = hedgedLog.length;
  if (n < 240) {
    warnings.push(
      `先読みなし検証に使える日数が ${n} 日しかない（窓 ${p.window} 日 − ローリング窓 ${W} 日）。` +
        `実現βの検定力は低い。窓を伸ばすか rollWindow を縮めること。`
    );
  }

  let oosBeta = 0;
  let oosBetaSe = 0;
  let oosBetaT = 0;
  let oosBetaP = 1;
  {
    const X: number[][] = [];
    for (let i = 0; i < n; i++) X.push([1, oosM[i]]);
    const fit = olsNW(hedgedLog, X, 5);
    if (fit) {
      oosBeta = fit.beta[1];
      oosBetaSe = fit.se[1];
      oosBetaT = fit.t[1];
      oosBetaP = studentTwoSidedP(oosBetaT, Math.max(1, fit.n - 2));
    }
  }

  // ── (iii) 上下非対称（P2 の splitFit と同じ形。ただし割るのは F でなく M）──
  //
  //   R_B = α + γ·D + c⁺·M + δ·(M·D) + b·F + ε,   D = 1{M<0}
  //   c⁻ = c⁺ + δ、検定は δ の NW t（両側 student p、df = n − 5）
  //
  // 水準ダミー D も入れる理由は P2 と同じ（D と M·D が相関するので δ に水準差が混ざる）。
  // 条件づけの向きに注意: D は**説明変数 M の符号**で作る（被説明変数の同時点の下落率では
  // 切らない）。後者は相関を機械的に押し下げる既知の罠。
  let cUp = env.c;
  let cDown = env.c;
  let asymT = 0;
  let asymP = 1;
  {
    const X: number[][] = [];
    for (let t = 0; t < T; t++) {
      const D = env.marketRet[t] < 0 ? 1 : 0;
      X.push([1, D, env.marketRet[t], env.marketRet[t] * D, env.factorRet[t]]);
    }
    const fit = olsNW(env.basketRet, X, 5);
    if (fit) {
      cUp = fit.beta[2];
      cDown = fit.beta[2] + fit.beta[3];
      asymT = fit.t[3];
      asymP = studentTwoSidedP(asymT, Math.max(1, fit.n - 5));
    }
  }

  // ── (iv) ヘッジ後の b 保存 ───────────────────────────────────────────
  // OOS 区間だけで F を作り直し、ヘッジ後系列と無ヘッジ系列の b を同じ日で比べる。
  // 差の検定は「差の系列 (hedged − raw) = −ĉ_t·M_t」を直接回帰する。2本の b の SE を
  // 独立として合成すると、同じ F・同じ日を使っている強い相関を無視して t が保守側に潰れる。
  let bPreserved = 0;
  let bPreservedSe = 0;
  let bRawOos = 0;
  let bRawOosSe = 0;
  let bDriftT = 0;
  let bDriftP = 1;
  {
    const Foos = orthogonalize(oosSector, oosM);
    const X: number[][] = [];
    for (let i = 0; i < n; i++) X.push([1, oosM[i], Foos[i]]);
    const fh = olsNW(hedgedLog, X, 5);
    const fr = olsNW(rawLog, X, 5);
    const fd = olsNW(
      hedgedLog.map((v, i) => v - rawLog[i]),
      X,
      5
    );
    if (fh) {
      bPreserved = fh.beta[2];
      bPreservedSe = fh.se[2];
    }
    if (fr) {
      bRawOos = fr.beta[2];
      bRawOosSe = fr.se[2];
    }
    if (fd) {
      bDriftT = fd.t[2];
      bDriftP = studentTwoSidedP(bDriftT, Math.max(1, fd.n - 3));
    }
  }

  // ── 多重検定（docs §7-11）──
  const q = benjaminiHochberg([oosBetaP, asymP, bDriftP]);

  // ── 資産曲線 ──
  const toEquity = (rets: number[]): EquityPoint[] => {
    const out: EquityPoint[] = [];
    let v = 1;
    for (let i = 0; i < rets.length; i++) {
      v *= 1 + rets[i];
      out.push({ time: oosDates[i], value: v });
    }
    return out;
  };
  const hedgedEquity = toEquity(hedgedSimple);
  const rawEquity = toEquity(rawSimple);

  // 標本が足りないときに「|t|<2 だから成立」と言わないこと。検定力が無いだけで、
  // ゼロと整合したのではない。null result と no result を混ぜない。
  // 120営業日（約半年）未満では日次βの t に意味のある検定力が無い。
  // ローリング窓は最大 T−60 まで許すので、rollWindow を伸ばしすぎるとここに落ちる。
  const MIN_OOS = 120;
  const oosAvailable = n >= MIN_OOS;
  const hedgeHolds = oosAvailable && Math.abs(oosBetaT) < 2;
  const asymBroken = cDown > cUp && Math.abs(asymT) >= 2;
  if (!oosAvailable) {
    warnings.push(
      `先読みなし検証が成立しなかった（有効日数 ${n} < ${MIN_OOS}）。実現βの値と t は読まないこと。`
    );
  } else if (!hedgeHolds) {
    warnings.push(
      `先読みなしヘッジ後の実現βが ${oosBeta.toFixed(3)}（t=${oosBetaT.toFixed(2)}）でゼロから有意に離れている。` +
        `ヘッジは未完成で、消したつもりの市場露出が残っている。`
    );
  }
  if (asymBroken) {
    warnings.push(
      `市場下落日の c⁻=${cDown.toFixed(2)} が上昇日の c⁺=${cUp.toFixed(2)} より有意に大きい（t=${asymT.toFixed(2)}）。` +
        `平時の c でヘッジすると下げ相場で取り残しが出る。ヘッジしない場合でも、暴落時の実効市場βは ${cDown.toFixed(2)} として建玉を決めること。`
    );
  }

  return {
    rollC,
    trust,
    oosBeta,
    oosBetaSe,
    oosBetaT,
    oosBetaP,
    oosN: n,
    oosFrom: oosDates[0] ?? "",
    oosTo: oosDates[n - 1] ?? "",
    oosAvailable,
    meanHedgeRatio: mean(hUsed),
    sdHedgeRatio: std(hUsed),
    cUp,
    cDown,
    asymT,
    asymP,
    bPreserved,
    bPreservedSe,
    bRawOos,
    bRawOosSe,
    bDriftT,
    bDriftP,
    qValues: { oosBeta: q[0], asym: q[1], bDrift: q[2] },
    hedgedEquity,
    rawEquity,
    hedgedMaxDD: maxDrawdown(hedgedEquity.map((e) => e.value)),
    rawMaxDD: maxDrawdown(rawEquity.map((e) => e.value)),
    hedgedVol: std(hedgedSimple) * Math.sqrt(TRADING_DAYS),
    rawVol: std(rawSimple) * Math.sqrt(TRADING_DAYS),
    hedgeHolds,
    asymBroken,
    warnings,
  };
}

/**
 * docs §9 のうち H-4 が担当する判定。実現βが有意に残るか c⁻ ≫ c⁺ なら "broken"。
 * noHedge / neutral / hedge の切り分けは h\* の符号と刻みで決まるので H-3 側で合成する。
 */
export function efficacyVerdict(eff: HedgeEfficacy): {
  level: "ok" | "broken" | "unknown";
  label: string;
  sentence: string;
} {
  if (!eff.oosAvailable) {
    return {
      level: "unknown",
      label: "検証できない",
      sentence:
        `先読みなしヘッジを検証できる日数が ${eff.oosN} 日しかなく、実現βの検定力が無い。` +
        `「|t|<2 だからヘッジ成立」とは読めない ─ ゼロと整合したのではなく、何も言えていない。`,
    };
  }
  if (!eff.hedgeHolds) {
    return {
      level: "broken",
      label: "ヘッジが未完成",
      sentence:
        `先読みなしで組んだヘッジ後の実現βは ${eff.oosBeta.toFixed(2)}（t=${eff.oosBetaT.toFixed(2)}）で、` +
        `ゼロから有意に離れている。消したつもりの市場露出が残っており、σ の削減は見かけほど効いていない。`,
    };
  }
  if (eff.asymBroken) {
    return {
      level: "broken",
      label: "平時にしか効かない",
      sentence:
        `実現βはゼロと整合（t=${eff.oosBetaT.toFixed(2)}）だが、市場下落日の c⁻=${eff.cDown.toFixed(2)} は ` +
        `上昇日の c⁺=${eff.cUp.toFixed(2)} より有意に大きい（t=${eff.asymT.toFixed(2)}）。` +
        `平時の c で組んだヘッジは下げ相場で足りない。`,
    };
  }
  return {
    level: "ok",
    label: "ヘッジは成立",
    sentence:
      `先読みなしヘッジ後の実現βは ${eff.oosBeta.toFixed(2)}（t=${eff.oosBetaT.toFixed(2)}, |t|<2）でゼロと整合。` +
      `上下非対称も有意でない（c⁻=${eff.cDown.toFixed(2)} vs c⁺=${eff.cUp.toFixed(2)}, t=${eff.asymT.toFixed(2)}）。`,
  };
}
