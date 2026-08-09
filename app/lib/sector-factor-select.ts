// 系C27「セクター内選別 ─ ファクター感応度の識別可能性」の計算層 ─ P0（前提診断）。
//
// 出発点は C26（drift-identifiability.ts）の不可能性:
//   SE(μ̂) = σ/√T は観測頻度で縮まない（μ̂ = log(P_T/P_0)/T は両端2点の恒等式）。
//   ゆえに「どの銘柄が上がるか」を過去の価格から選ぶことはできない。
//
// C27 はその唯一の抜け道を形式化する。回帰係数の精度は
//   SE(b̂) = σ_ε / (σ_F·√T)
// であり、毎日の観測が情報として入るぶん**頻度で縮む**。σ が測れて μ が測れないのと
// 同じ非対称性が b と μ の間にも成り立つ。よってセクター内選別は
//   「どれが上がるか」ではなく「どれがファクターに強く連動するか」
// を問う形に置き換えれば実行可能になる。
//
// ただしこれは**エッジの創出ではなく増幅**である。期待値の源泉は投資家が外から持ち込む
// 見立て E[F] = m > 0 にあり、m の符号が誤っていれば同じ倍率で損失も増幅される。
// だから最初に検証すべきは銘柄の順位ではなく「その見立ての前提が実データで成り立つか」。
//
// 本ファイル（P0）はその前提診断だけを担う:
//   ・セクター因子は本当に金利で動いているか（R²・符号・t）      ← 前提そのものの検証
//   ・銘柄の分散は市場/セクター/固有にどう割れているか            ← 何が「払われている」か
//   ・生の相関 ρ̄ と残差の相関 ρ̄_ε はどれだけ違うか               ← 「分散できていない」の中身
//   ・ゆえに k 本に分けると σ がどれだけ落ちるか                   ← 1本集中の機会損失
//
// P1 以降（銘柄別 b̂・S=b/σ_ε ランキング・w∝b/σ_ε²・WF検証）は
// 本ファイルの buildPanel / olsNW をそのまま土台に積む。設計は docs/sector-factor-selection.md。

import { PricePoint } from "./types";

const TRADING_DAYS = 252;

/** 前提診断に最低限必要な営業日数（≒1年）。これ未満は診断を返さない。 */
const MIN_OBS = 240;

/**
 * §3.5 の成長率利得を年率 pp に翻訳するときに置くシャープレシオの基準値。
 * g* = SR²/2（ケリー最適時の成長率）なので、SR の水準を仮定しないと pp に落ちない。
 * これは**仮定であって推定値ではない**ため、UI 側に必ず「SR=0.5 と仮定」と明示すること。
 */
export const ASSUMED_SHARPE = 0.5;

/** 「値動きが違う」と判定する ρ の閾値。実測の断層（0.564 → 0.775）の中間に置く。 */
export const RHO_ODD_THRESHOLD = 0.75;

/** 何に対する感応度を測るか。 */
export type FactorMode = "sector" | "rate";
/** セクター因子の作り方。ETF が窓長に足りなければ basket へ自動退避する。 */
export type FactorSource = "etf" | "basket";

export interface SectorPremiseParams {
  factorMode: FactorMode; // 既定 "sector"
  factorSource: FactorSource; // 既定 "etf"
  window: number; // 使用する営業日数（既定 750 ≒ 3年）
}

export const DEFAULT_PREMISE_PARAMS: SectorPremiseParams = {
  factorMode: "sector",
  factorSource: "etf",
  window: 750,
};

/** 因子として渡す価格系列。sector/rate は無くてもよい（無い場合は代替 or 診断スキップ）。 */
export interface FactorPrices {
  market: PricePoint[]; // 市場（TOPIX ETF 等）。必須
  sector: PricePoint[] | null; // セクター ETF（1615.T 等）。null なら basket
  rate: PricePoint[] | null; // 金利プロキシ（^TNX 等）。null なら金利診断をスキップ
  marketTicker: string;
  sectorTicker: string;
  rateTicker: string;
}

export interface PremiseDiag {
  // ---- 標本 ----
  nObs: number;
  dateFrom: string;
  dateTo: string;
  universeSize: number;
  usedTickers: string[];
  usedFactorSource: FactorSource;
  /** ETF 因子と等加重バスケット因子の相関。1に近いほど因子の作り方は結論に効かない。 */
  etfVsBasketCorr: number | null;

  // ---- 前提の中核: セクターは金利で動いているか ----
  rateAvailable: boolean;
  rateProxyTicker: string;
  /** 金利プロキシがセクター因子の分散の何割を説明するか（0..1）。 */
  rateR2: number;
  /** 金利 +1pp あたりのセクター因子の日次リターン。正なら「金利上昇＝銀行上昇」。 */
  rateBeta: number;
  /** rateBeta の Newey-West t 値。 */
  rateT: number;
  /** 金利プロキシが取れた日数。 */
  rateN: number;
  /** ^TNX が 10倍表記だったため 1/10 したか（Yahoo の系列差の吸収）。 */
  rateRescaled: boolean;

  // ---- 分散の内訳（平均銘柄）----
  marketShare: number; // c²Var(M)/Var(r)
  sectorShare: number; // b²Var(F)/Var(r)
  residShare: number; // Var(ε)/Var(r)

  // ---- 「分散できていない」の中身 ----
  meanRho: number; // 生リターンの平均ペア相関
  /** 残差の平均ペア相関。識別できない構成のときは null（下記 rhoResidSource 参照）。 */
  meanRhoResid: number | null;
  /**
   * ρ̄_ε をどの因子の残差から測ったか。
   *   "etf"  … パネルの外にある因子（セクターETF）の残差＝識別可能
   *   "none" … 外生因子が無く、パネル内平均しか使えないため識別不能
   * パネル内の等加重平均を引いた残差は、真の ρ に関係なく平均ペア相関が
   * 恒等的に −1/(N−1) になる（情報が消える）。詳細は computeSectorPremise の実装注記。
   */
  rhoResidSource: "etf" | "none";
  nEffRaw: number; // N/(1+(N−1)ρ̄)
  nEffResid: number | null; // 残差だけで見た実効独立数
  /** k=5 等加重にしたとき総ボラが何割落ちるか（0.094 なら −9.4%）。識別不能なら null。 */
  sigmaCutK5: number | null;
  /** 同じ露出のまま拾える成長率（年率 pp）。SR=ASSUMED_SHARPE を仮定した概算。 */
  growthGainK5: number | null;

  // ---- 生存者バイアス ----
  survivorsToEnd: number;
  /** 履歴が窓に足りず自動的に外した銘柄。 */
  droppedForHistory: string[];
  /** 価格スケール破損として修復した点数。 */
  glitchesFixed: number;

  warnings: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// 数値ユーティリティ（P1 以降でも使う共通部品）
// ════════════════════════════════════════════════════════════════════════════

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

function variance(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1);
}

function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Gauss-Jordan による逆行列。特異なら null。 */
function matInv(A: number[][]): number[][] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row.slice(n));
}

export interface OlsFit {
  /** 係数。X の列順（呼び出し側が定数項を含めること）。 */
  beta: number[];
  /** Newey-West（HAC）標準誤差。 */
  se: number[];
  /** t 値。 */
  t: number[];
  resid: number[];
  r2: number;
  /** 残差の標準偏差（日次）。 */
  sigmaResid: number;
  n: number;
}

/**
 * Newey-West 標準誤差つき OLS。X は [t][k]（定数項は呼び出し側で列に入れる）。
 * lag は自己相関の打ち切り次数。日次リターン回帰では 5 程度で十分（既定）。
 *
 * Var(β̂) = (X'X)⁻¹ S (X'X)⁻¹,
 *   S = Σ_t u_t² x_t x_t' + Σ_{l=1..L} (1 − l/(L+1)) Σ_t [x_t u_t u_{t−l} x_{t−l}' + 転置]
 */
export function olsNW(y: number[], X: number[][], lag = 5): OlsFit | null {
  const n = y.length;
  if (n < 20 || X.length !== n) return null;
  const k = X[0].length;
  if (n <= k + 2) return null;

  // X'X と X'y
  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty: number[] = new Array(k).fill(0);
  for (let t = 0; t < n; t++) {
    const xt = X[t];
    for (let i = 0; i < k; i++) {
      Xty[i] += xt[i] * y[t];
      for (let j = i; j < k; j++) XtX[i][j] += xt[i] * xt[j];
    }
  }
  for (let i = 0; i < k; i++) for (let j = 0; j < i; j++) XtX[i][j] = XtX[j][i];

  const inv = matInv(XtX);
  if (!inv) return null;

  const beta = new Array(k).fill(0);
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) beta[i] += inv[i][j] * Xty[j];

  const resid = new Array(n).fill(0);
  for (let t = 0; t < n; t++) {
    let fit = 0;
    for (let i = 0; i < k; i++) fit += X[t][i] * beta[i];
    resid[t] = y[t] - fit;
  }

  const my = mean(y);
  let sst = 0;
  let sse = 0;
  for (let t = 0; t < n; t++) {
    sst += (y[t] - my) * (y[t] - my);
    sse += resid[t] * resid[t];
  }
  const r2 = sst > 0 ? Math.max(0, 1 - sse / sst) : 0;

  // HAC のミート行列 S
  const S: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let t = 0; t < n; t++) {
    const u = resid[t];
    const xt = X[t];
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) S[i][j] += u * u * xt[i] * xt[j];
  }
  const L = Math.max(0, Math.min(lag, n - 2));
  for (let l = 1; l <= L; l++) {
    const w = 1 - l / (L + 1);
    for (let t = l; t < n; t++) {
      const ut = resid[t];
      const ul = resid[t - l];
      const xt = X[t];
      const xl = X[t - l];
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) {
          S[i][j] += w * (xt[i] * ut * ul * xl[j] + xl[i] * ul * ut * xt[j]);
        }
      }
    }
  }

  // (X'X)⁻¹ S (X'X)⁻¹ の対角
  const se = new Array(k).fill(0);
  for (let i = 0; i < k; i++) {
    let v = 0;
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) v += inv[i][a] * S[a][b] * inv[b][i];
    }
    se[i] = v > 0 ? Math.sqrt(v) : 0;
  }
  const tvals = beta.map((b, i) => (se[i] > 0 ? b / se[i] : 0));

  return { beta, se, t: tvals, resid, r2, sigmaResid: Math.sqrt(sse / (n - k)), n };
}

/**
 * y を x（定数項こみ）に回帰した残差を返す＝直交化。失敗時は y をそのまま返す。
 *
 * セクター因子から市場成分を抜いて「セクターだけの動き」を作るのに使う。
 * 直交化しておくと Var(r) = c²Var(M) + b²Var(F) + Var(ε) がきれいに割れる。
 * P2（sector-factor-stability.ts）もローリング推定で同じ直交化を使うため export する。
 */
export function orthogonalize(y: number[], x: number[]): number[] {
  const X = x.map((v) => [1, v]);
  const fit = olsNW(y, X, 0);
  return fit ? fit.resid : y;
}

// ════════════════════════════════════════════════════════════════════════════
// パネル構築（P1 以降と共有）
// ════════════════════════════════════════════════════════════════════════════

export interface ReturnPanel {
  tickers: string[];
  dates: string[]; // length T
  ret: number[][]; // [asset][t] 対数リターン
  market: number[]; // [t]
  /** 等加重バスケット（全銘柄平均）。leave-one-out はここから引いて作る。 */
  basket: number[];
  /** セクター ETF のリターン（無ければ null）。 */
  etf: number[] | null;
  /** 生存診断: 終端日まで価格がある銘柄数。 */
  survivorsToEnd: number;
  /** 履歴が窓に足りず自動的に外した銘柄（新規上場・持株会社化直後など）。 */
  droppedForHistory: string[];
  /** 価格スケール破損として 0 に潰したリターンの点数（repairGlitches）。 */
  glitchesFixed: number;
}

/** 窓に対してこの割合の営業日をカバーしていない銘柄はパネルから外す。 */
const HISTORY_COVERAGE = 0.95;

/** データ破損とみなす1日あたり対数リターンの下限（|log r| > これ）。±35%。 */
const GLITCH_THRESHOLD = 0.3;
/** 破損した価格水準が元に戻るまでに許す営業日数。 */
const GLITCH_MAX_GAP = 5;

/**
 * 価格スケールのデータ破損（split/併合の調整漏れ等）に対する二重の網。
 *
 * **一次の修復は取得層に移した**（`app/lib/price-sanity.ts` / `/api/stock`）。あちらは価格
 * 水準そのものを倍率で復元するので、σ・β だけでなく OHLC・ドローダウンまで正しくなる。
 * 実例の 1306.T（2026-03-30〜31 に 1/10）は取得層で解決済みで、放置した場合の市場βは
 * 0.05、修復後は 1.10（7203.T 実測）。
 *
 * ここに残すのは、取得層が**修復を見送った**破損に対する網。取得層は「倍率が 1/10 等の
 * 切りのいいスケール比に一致する」ことを必須にしており（正しいデータを黙って書き換える
 * 方が有害なため）、端数倍率の破損は水準を復元できず素通りする。回帰の分母 Var(M) は
 * 1点の異常値で100倍になり全回帰を無意味にするので、パネル構築時にリターン水準でも潰す。
 *
 * 判定は「大きなジャンプが、数日以内にほぼ同じ大きさで戻る」ことに限定する。
 *   ・|r_t| > 0.3（±35%）かつ
 *   ・t..s の累積が |r_t| の 20% 未満に戻る s が t+1..t+5 に存在し、かつ |r_s| > 0.3
 * このとき入口 r_t と出口 r_s だけを 0 にする（破損区間の内部は水準が一定倍なので
 * 日々のリターン自体は正しく、潰してはいけない）。真の暴落・ストップ安は数日で
 * 完全には戻らないため、この条件で誤検出することは実質ない。
 */
export function repairGlitches(r: number[]): { repaired: number[]; fixed: number } {
  const out = [...r];
  let fixed = 0;
  for (let t = 0; t < out.length; t++) {
    if (Math.abs(out[t]) <= GLITCH_THRESHOLD) continue;
    let cum = out[t];
    let best = -1;
    let bestAbs = Infinity;
    for (let s = t + 1; s < Math.min(out.length, t + 1 + GLITCH_MAX_GAP); s++) {
      cum += out[s];
      if (Math.abs(out[s]) > GLITCH_THRESHOLD && Math.abs(cum) < bestAbs) {
        bestAbs = Math.abs(cum);
        best = s;
      }
    }
    if (best >= 0 && bestAbs < 0.2 * Math.abs(out[t])) {
      out[t] = 0;
      out[best] = 0;
      fixed += 2;
      t = best;
    }
  }
  return { repaired: out, fixed };
}

/**
 * 銘柄群＋市場＋（あれば）セクターETF を共通営業日で整列し、対数リターンのパネルを作る。
 *
 * 共通日付は積集合なので、**1銘柄でも歴史が短いとパネル全体がそこまで削られる**。
 * 実データでは持株会社化で新コードに移った地銀（静岡FG 5831.T・いよぎんHD 5830.T は
 * 2022-10 上場）がこれに該当し、放置すると10年窓を選んでも3年しか使えなくなる。
 * そこで先に「市場（＋ETF）だけで決めた窓」を基準に、その 95% をカバーしない銘柄を
 * 落としてから積集合を取る。落とした銘柄は droppedForHistory で報告する。
 */
export function buildPanel(
  pricesByTicker: Record<string, PricePoint[]>,
  market: PricePoint[],
  etf: PricePoint[] | null,
  window: number
): ReturnPanel | null {
  const all = Object.keys(pricesByTicker).filter((t) => (pricesByTicker[t]?.length ?? 0) > 30);
  if (all.length < 3 || market.length < 30) return null;

  const toMap = (ps: PricePoint[]) => {
    const m = new Map<string, number>();
    for (const p of ps) if (p.close > 0) m.set(p.time, p.close);
    return m;
  };
  const mktMap = toMap(market);
  const etfMap = etf && etf.length > 30 ? toMap(etf) : null;

  // ① 銘柄を見ずに窓を決める（因子側だけの共通日付 → 直近 window+1 日）
  let base = [...mktMap.keys()];
  if (etfMap) base = base.filter((d) => etfMap.has(d));
  base.sort();
  if (base.length > window + 1) base = base.slice(base.length - (window + 1));
  if (base.length < MIN_OBS + 1) return null;

  // ② その窓を十分カバーしない銘柄を落とす
  const need = base.length * HISTORY_COVERAGE;
  const droppedForHistory: string[] = [];
  const tickers: string[] = [];
  for (const t of all) {
    const m = toMap(pricesByTicker[t]);
    let hit = 0;
    for (const d of base) if (m.has(d)) hit++;
    if (hit >= need) tickers.push(t);
    else droppedForHistory.push(t);
  }
  if (tickers.length < 3) return null;

  // ③ 残った銘柄で積集合を取る
  const maps = tickers.map((t) => toMap(pricesByTicker[t]));
  let common = base;
  for (const m of maps) common = common.filter((d) => m.has(d));
  if (common.length < MIN_OBS + 1) return null;

  let glitchesFixed = 0;
  const logRet = (m: Map<string, number>) => {
    const r: number[] = [];
    for (let t = 1; t < common.length; t++) {
      const c0 = m.get(common[t - 1])!;
      const c1 = m.get(common[t])!;
      r.push(c0 > 0 && c1 > 0 ? Math.log(c1 / c0) : 0);
    }
    // 1点の価格破損が Var(M) を100倍にして全回帰を潰すので、必ず修復を通す。
    const { repaired, fixed } = repairGlitches(r);
    glitchesFixed += fixed;
    return repaired;
  };

  const ret = maps.map(logRet);
  const mkt = logRet(mktMap);
  const etfRet = etfMap ? logRet(etfMap) : null;
  const T = mkt.length;

  const basket: number[] = new Array(T).fill(0);
  for (let t = 0; t < T; t++) {
    let s = 0;
    for (let i = 0; i < ret.length; i++) s += ret[i][t];
    basket[t] = s / ret.length;
  }

  // 生存診断: 各銘柄の最終価格日が全体の終端に届いているか（暦で5営業日以内を生存とみなす）。
  const endDate = common[common.length - 1];
  let survivors = 0;
  for (const t of tickers) {
    const ps = pricesByTicker[t];
    const last = ps[ps.length - 1]?.time ?? "";
    if (last >= endDate) survivors++;
  }

  return {
    tickers,
    dates: common.slice(1),
    ret,
    market: mkt,
    basket,
    etf: etfRet,
    survivorsToEnd: survivors,
    droppedForHistory,
    glitchesFixed,
  };
}

/**
 * 銘柄 i を除いた等加重バスケット（leave-one-out）。
 * 自分を含むバスケットに自分を回帰すると b̂ が上方に偏るため、basket モードでは必須。
 *   F^(-i) = (N·basket − r_i) / (N−1)
 */
export function leaveOneOut(panel: ReturnPanel, i: number): number[] {
  const N = panel.ret.length;
  if (N < 2) return panel.basket;
  return panel.basket.map((b, t) => (N * b - panel.ret[i][t]) / (N - 1));
}

/**
 * 金利プロキシを「前営業日までに確定した変化」として日本の各営業日に対応づける。
 * ^TNX は米国の系列なので、当日の米国終値は日本の翌営業日にしか効かない。
 * 各 JP 日 d について、d より**前**の最新の米国観測とその1つ前の差分（pp）を返す。
 * 対応が取れない日は null。
 *
 * 値のスケール: Yahoo の ^TNX は利回り(%)だが、系列によっては 10倍表記のことがある。
 * 中央値が 20 を超えていれば 10倍表記とみなして 1/10 する（rescaled で通知）。
 */
export function prevSessionRateDiff(
  jpDates: string[],
  ratePrices: PricePoint[]
): { diff: (number | null)[]; rescaled: boolean } {
  const us = ratePrices
    .filter((p) => p.close > 0)
    .map((p) => ({ date: p.time, y: p.close }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (us.length < 10) return { diff: jpDates.map(() => null), rescaled: false };

  const sorted = [...us.map((u) => u.y)].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const rescaled = med > 20;
  const scale = rescaled ? 0.1 : 1;

  const diff: (number | null)[] = [];
  let j = 0;
  for (const d of jpDates) {
    while (j < us.length && us[j].date < d) j++;
    const idx = j - 1; // d より前の最新
    if (idx < 1) {
      diff.push(null);
      continue;
    }
    diff.push((us[idx].y - us[idx - 1].y) * scale);
  }
  return { diff, rescaled };
}

// ════════════════════════════════════════════════════════════════════════════
// P0: 前提診断
// ════════════════════════════════════════════════════════════════════════════

export function computeSectorPremise(
  pricesByTicker: Record<string, PricePoint[]>,
  factors: FactorPrices,
  paramsIn: Partial<SectorPremiseParams> & { excludeTickers?: string[] } = {}
): PremiseDiag | null {
  const excluded = new Set(paramsIn.excludeTickers ?? []);
  const includedPrices = excluded.size
    ? Object.fromEntries(Object.entries(pricesByTicker).filter(([ticker]) => !excluded.has(ticker)))
    : pricesByTicker;
  const params = { ...DEFAULT_PREMISE_PARAMS, ...paramsIn };
  const warnings: string[] = [];

  // ETF は factorSource に関わらず常にパネルへ載せる。basket モードでも
  // 残差相関 ρ̄_ε の識別には「パネル外の因子」が要るため（下の実装注記を参照）。
  const panel = buildPanel(includedPrices, factors.market, factors.sector, params.window);
  if (!panel) return null;

  const T = panel.market.length;
  const N = panel.ret.length;

  // ---- 因子の決定（ETF が無ければ basket へ退避）----------------------------
  let usedFactorSource: FactorSource = params.factorSource;
  if (params.factorSource === "etf" && !panel.etf) {
    usedFactorSource = "basket";
    warnings.push(
      "セクターETFの履歴が窓長に足りない（または未取得）ため、等加重バスケット因子に自動退避した。"
    );
  }
  const etfVsBasketCorr = panel.etf ? corr(panel.etf, panel.basket) : null;
  if (etfVsBasketCorr !== null && etfVsBasketCorr < 0.9) {
    warnings.push(
      `ETF因子と等加重バスケット因子の相関が ${etfVsBasketCorr.toFixed(2)} と低い。ETFの構成がこのユニバースと乖離している可能性がある。`
    );
  }
  if (usedFactorSource === "etf") {
    warnings.push(
      "ETF因子には各銘柄自身が時価加重で含まれるため、b̂ にわずかな自己混入バイアスが残る（メガバンクほど大きい）。厳密な除去が要る場合は等加重バスケット（leave-one-out）に切り替えること。"
    );
  }

  // 市場に直交化したセクター因子。これ以降 F は市場と無相関。
  const rawSector = usedFactorSource === "etf" && panel.etf ? panel.etf : panel.basket;
  const F = orthogonalize(rawSector, panel.market);

  // ---- 前提の中核: セクター因子は金利で動いているか -------------------------
  let rateAvailable = false;
  let rateR2 = 0;
  let rateBeta = 0;
  let rateT = 0;
  let rateN = 0;
  let rateRescaled = false;

  if (factors.rate && factors.rate.length > 30) {
    const { diff, rescaled } = prevSessionRateDiff(panel.dates, factors.rate);
    rateRescaled = rescaled;
    const yy: number[] = [];
    const xx: number[][] = [];
    for (let t = 0; t < T; t++) {
      const d = diff[t];
      if (d === null || !Number.isFinite(d)) continue;
      yy.push(F[t]);
      xx.push([1, d]);
    }
    rateN = yy.length;
    if (rateN >= MIN_OBS) {
      const fit = olsNW(yy, xx, 5);
      if (fit) {
        rateAvailable = true;
        rateR2 = fit.r2;
        rateBeta = fit.beta[1];
        rateT = fit.t[1];
      }
    } else {
      warnings.push(`金利プロキシの対応日数が ${rateN} 日しかなく、前提診断には不足（${MIN_OBS}日以上が必要）。`);
    }
  } else {
    warnings.push("金利プロキシ（^TNX 等）が取得できていないため、「セクター＝金利の賭け」の検証をスキップした。");
  }

  // ---- 分散の内訳と残差 ------------------------------------------------------
  //
  // 残差は2種類作る。目的が違うので混ぜてはいけない。
  //
  //   (a) 分散の3分解用   … 選ばれた因子（basket なら leave-one-out）。b の推定と整合させる。
  //   (b) 残差相関 ρ̄_ε 用 … **必ず外生因子（セクターETF）**。理由は以下。
  //
  // パネル内の等加重平均を引いた残差は、真の相関 ρ が何であっても平均ペア相関が
  // 恒等的に −1/(N−1) になる。等相関 ρ・分散 σ² の e_i を横断で中心化すると
  //   Cov(ẽ_i,ẽ_j) = σ²(ρ−1)/N,  Var(ẽ_i) = σ²(N−1)(1−ρ)/N
  //   ⇒ corr(ẽ_i,ẽ_j) = −1/(N−1)   （ρ が完全に消える）
  // 実データでも basket モードの ρ̄_ε は −0.074（N=13 の −1/12=−0.083）に張り付き、
  // 情報がゼロであることが確認できる。よって basket しか無い場合は ρ̄_ε を「識別不能」
  // として null を返す。ETF はパネル外の銘柄も含む時価加重なので span から外れており、
  // 情報が残る（ただし構成に自銘柄を含むぶん下方バイアスは残る＝分散利得は上界）。
  const varM = variance(panel.market);
  const Fetf = panel.etf ? orthogonalize(panel.etf, panel.market) : null;
  const residForRho: number[][] = [];
  let sumMarketShare = 0;
  let sumSectorShare = 0;
  let sumResidShare = 0;
  let counted = 0;

  for (let i = 0; i < N; i++) {
    // basket モードでは leave-one-out で自己混入を除く。ETF モードは自己ウェイトを除去できない。
    const Fi =
      usedFactorSource === "basket" ? orthogonalize(leaveOneOut(panel, i), panel.market) : F;
    const X: number[][] = [];
    for (let t = 0; t < T; t++) X.push([1, panel.market[t], Fi[t]]);
    const fit = olsNW(panel.ret[i], X, 5);
    if (fit) {
      const vTot = variance(panel.ret[i]);
      if (vTot > 0) {
        const c = fit.beta[1];
        const b = fit.beta[2];
        sumMarketShare += (c * c * varM) / vTot;
        sumSectorShare += (b * b * variance(Fi)) / vTot;
        sumResidShare += variance(fit.resid) / vTot;
        counted++;
      }
    }

    // (b) ρ̄_ε 用は常に ETF 残差。ETF モードなら (a) と同一なので再計算を避ける。
    if (Fetf) {
      if (usedFactorSource === "etf" && fit) {
        residForRho.push(fit.resid);
      } else {
        const Xe: number[][] = [];
        for (let t = 0; t < T; t++) Xe.push([1, panel.market[t], Fetf[t]]);
        const fe = olsNW(panel.ret[i], Xe, 5);
        residForRho.push(fe ? fe.resid : panel.ret[i]);
      }
    }
  }

  const marketShare = counted ? sumMarketShare / counted : 0;
  const sectorShare = counted ? sumSectorShare / counted : 0;
  const residShare = counted ? sumResidShare / counted : 1;

  // ---- 生の相関 vs 残差の相関 -----------------------------------------------
  // N_eff = N/(1+(N−1)ρ̄)。ρ̄ が −1/(N−1) に近いと発散するので下限でクランプし、上限も N。
  const nEff = (n: number, rho: number) => {
    if (n < 2) return n;
    const lo = -1 / (n - 1) + 1e-3;
    const denom = 1 + (n - 1) * Math.max(rho, lo);
    return denom > 0 ? Math.min(n, n / denom) : n;
  };

  let sumRho = 0;
  let sumRhoE = 0;
  let pairs = 0;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      sumRho += corr(panel.ret[i], panel.ret[j]);
      if (residForRho.length === N) sumRhoE += corr(residForRho[i], residForRho[j]);
      pairs++;
    }
  }
  const meanRho = pairs ? sumRho / pairs : 0;

  const rhoResidSource: "etf" | "none" = residForRho.length === N && Fetf ? "etf" : "none";
  const meanRhoResid = rhoResidSource === "etf" && pairs ? sumRhoE / pairs : null;
  const nEffResid = meanRhoResid === null ? null : nEff(N, meanRhoResid);
  const nEffRaw = nEff(N, meanRho);

  if (rhoResidSource === "none") {
    warnings.push(
      `セクターETFが無いため残差相関 ρ̄_ε を識別できない（したがって分散の利得も出せない）。` +
        `パネル内の等加重平均を引いた残差は、真の相関が何であっても平均ペア相関が恒等的に −1/(N−1)＝${(-1 / (N - 1)).toFixed(3)} になり情報が消えるため、` +
        `その値を ρ̄_ε として報告することはしない。`
    );
  }

  // ---- k=5 に分けたときの利得（等相関近似・§3.5）------------------------------
  // σ_p²/σ² ≈ (共通シェア) + (固有シェア)·(1+(k−1)ρ_ε)/k
  let sigmaCutK5: number | null = null;
  let growthGainK5: number | null = null;
  if (meanRhoResid !== null) {
    const K = 5;
    const sysShare = Math.max(0, Math.min(1, 1 - residShare));
    const kFactor = (1 + (K - 1) * meanRhoResid) / K;
    const varRatioK5 = Math.max(1e-6, sysShare + residShare * kFactor);
    sigmaCutK5 = 1 - Math.sqrt(varRatioK5);
    // 同じ露出（＝同じ b）のまま σ だけ落ちるので SR は 1/√比 倍になる。g* = SR²/2。
    const srK5 = ASSUMED_SHARPE / Math.sqrt(varRatioK5);
    growthGainK5 = (srK5 * srK5 - ASSUMED_SHARPE * ASSUMED_SHARPE) / 2;
    warnings.push(
      "分散の利得は上界として読むこと: ρ̄_ε をセクターETFの残差から測っているが、ETF の構成には各銘柄自身が含まれるため ρ̄_ε は下方に偏り、利得は過大に出る方向。"
    );
  }

  // ---- 生存者バイアス --------------------------------------------------------
  if (panel.survivorsToEnd === N) {
    warnings.push(
      `全 ${N} 銘柄が終端まで生存している＝現存リストは過去の勝者に偏る（生存者バイアス）。地銀は統合・再編で消えた行が多く、実際の選別成績は本分析より悪くなる方向に歪む。`
    );
  }
  if (T < 500) {
    warnings.push(`標本が ${T} 営業日（約${(T / TRADING_DAYS).toFixed(1)}年）と短い。b の推定は可能だが期間分割による安定性検証はできない。`);
  }
  if (panel.glitchesFixed > 0) {
    warnings.push(
      `価格スケールの破損が ${panel.glitchesFixed} 点、取得層の修復（app/lib/price-sanity.ts）を通り抜けたためリターンを 0 に置換した。` +
        `倍率が切りのいいスケール比でない等、水準としては直せない破損が残っていた可能性がある。`
    );
  }
  if (panel.droppedForHistory.length > 0) {
    warnings.push(
      `履歴がこの窓に足りないため ${panel.droppedForHistory.length} 銘柄を自動的に外した（${panel.droppedForHistory.join(", ")}）。` +
        `持株会社化で新コードに移った地銀は上場が新しく、窓を短くすれば戻る。`
    );
  }

  return {
    nObs: T,
    dateFrom: panel.dates[0],
    dateTo: panel.dates[panel.dates.length - 1],
    universeSize: N,
    usedTickers: panel.tickers,
    usedFactorSource,
    etfVsBasketCorr,
    rateAvailable,
    rateProxyTicker: factors.rateTicker,
    rateR2,
    rateBeta,
    rateT,
    rateN,
    rateRescaled,
    marketShare,
    sectorShare,
    residShare,
    meanRho,
    meanRhoResid,
    rhoResidSource,
    nEffRaw,
    nEffResid,
    sigmaCutK5,
    growthGainK5,
    survivorsToEnd: panel.survivorsToEnd,
    droppedForHistory: panel.droppedForHistory,
    glitchesFixed: panel.glitchesFixed,
    warnings,
  };
}

/**
 * 前提が成り立っているかの三段判定。UI のバナー色に対応する。
 *   ok    … 金利で有意に説明でき、符号も正（＝金利上昇局面のセクター・ドリフトという前提と整合）
 *   weak  … 符号は正だが説明力が弱い／有意でない
 *   fail  … 符号が負、または金利プロキシが使えない
 */
export function premiseVerdict(d: PremiseDiag): { level: "ok" | "weak" | "fail"; label: string; detail: string } {
  if (!d.rateAvailable) {
    return {
      level: "fail",
      label: "前提を検証できない",
      detail: "金利プロキシが取得できていないため、「銀行セクター＝金利の賭け」かどうかを実データで確かめられない。",
    };
  }
  if (d.rateBeta < 0 && Math.abs(d.rateT) >= 2) {
    return {
      level: "fail",
      label: "前提と符号が逆",
      detail:
        "金利が上がるとセクターは有意に下がっている。金利上昇局面のドリフトを狙うという前提が、この標本では成り立っていない。",
    };
  }
  if (Math.abs(d.rateT) < 2 || d.rateR2 < 0.02) {
    return {
      level: "weak",
      label: "前提の裏づけが弱い",
      detail:
        "セクターの動きのうち金利で説明できる部分が小さい（または有意でない）。セクターは動いていても、その駆動因子は金利以外である可能性が高い。",
    };
  }
  // 有意でも R² が小さいことは普通に起きる（日次では 5% 程度でも t は 5 を超える）。
  // 「向きは本物だが、セクターの動きの大半は金利以外」を隠さずに書く。
  const weakR2 = d.rateR2 < 0.15;
  return {
    level: "ok",
    label: "前提と整合",
    detail: weakR2
      ? `金利上昇はセクターの上昇と有意に結びついている（向きは本物）。ただし説明できるのは ${(d.rateR2 * 100).toFixed(1)}% だけで、` +
        `セクターの動きの ${((1 - d.rateR2) * 100).toFixed(0)}% は金利以外の要因である。` +
        `金利観が当たっても、それだけでセクターの値動きが決まるわけではない点は織り込むこと。`
      : "金利上昇はセクターの上昇と有意に結びついており、説明力も十分。感応度による銘柄選別（P1以降）へ進む前提が満たされている。",
  };
}

// ════════════════════════════════════════════════════════════════════════════
// P1: 銘柄別の感応度推定と S = b/σ_ε ランキング
// ════════════════════════════════════════════════════════════════════════════

export interface SectorSelectParams extends SectorPremiseParams {
  /** ユニバースから最初から存在しなかったものとして除外する銘柄。 */
  excludeTickers: string[];
  /** James-Stein 収縮を S の計算に使うか（既定 true）。 */
  shrink: boolean;
  /** 採用本数（表の強調と推奨ウェイトの対象）。 */
  topK: number;
  /** 1銘柄あたりのウェイト上限。 */
  maxWeight: number;
  /** 順位CI のブートストラップ反復数。 */
  nBoot: number;
  /** ブロック・ブートストラップのブロック長（営業日）。 */
  blockLen: number;
  /** 乱数種（再現性）。 */
  seed: number;
  /** C26 の必要期間 T* を計算するときの t ハードル κ。 */
  kappa: number;
}

export const DEFAULT_SELECT_PARAMS: SectorSelectParams = {
  ...DEFAULT_PREMISE_PARAMS,
  excludeTickers: [],
  shrink: true,
  topK: 5,
  maxWeight: 0.35,
  nBoot: 300,
  blockLen: 21,
  seed: 42,
  kappa: 2,
};

export interface AssetFactorFit {
  ticker: string;

  /** 残り全行の等加重バスケット（leave-one-out）との生リターン相関。低いほど「値動きが違う」。 */
  rhoBasket: number;

  // ---- セクター感応度（選別の主役）----
  /** b̂: 市場に直交化したセクター因子への感応度。 */
  b: number;
  bSe: number;
  bT: number;
  bLo: number; // 95%CI
  bHi: number;
  /** James-Stein で横断平均へ収縮した b。 */
  bShrunk: number;

  // ---- 市場感応度（「金利プレイのつもりが実は高β」の切り分け用）----
  /** ĉ: 市場βそのもの。F は市場に直交化済みなので単回帰の市場βと一致する。 */
  cMkt: number;
  cMktSe: number;
  cMktT: number;

  // ---- 分散の分解（この銘柄の中で何が効いているか）----
  marketShare: number; // c²Var(M)/Var(r)
  sectorShare: number; // b²Var(F)/Var(r)
  residShare: number; // Var(ε)/Var(r)
  /**
   * 露出の純度 = セクター寄与 /（市場寄与＋セクター寄与）。
   * 1 に近いほど「純粋なセクター（金利）プレイ」、0 に近いほど
   * 「金利プレイのつもりで実は市場全体を買っている」。
   */
  purity: number;

  // ---- リスクとランク ----
  sigmaEps: number; // 固有ボラ（年率）
  sigmaTot: number; // 総ボラ（年率）
  r2: number;
  /** S = b/σ_ε（shrink=true なら bShrunk を使用）＝情報比。ランクの基準。 */
  score: number;
  rank: number;
  rankLo: number; // ブートによる順位95%CI
  rankHi: number;
  /** 順位が最上位（1位）になったブート比率。 */
  rankTopShare: number;

  // ---- C26 との並置（同じ標本で μ は測れないことを示す）----
  muHat: number; // 実現年率ドリフト
  muSe: number; // σ/√T（年率）
  muT: number; // 横断平均との差の t
  yearsNeeded: number; // T* =(κσ/Δμ)²

  // ---- 配分 ----
  weightUnc: number; // w ∝ b/σ_ε²（制約なし）
  weight: number; // long-only＋上限を適用後（topK 外は 0）
}

export interface SectorSelectResult {
  params: SectorSelectParams;
  premise: PremiseDiag;
  assets: AssetFactorFit[]; // score 降順
  /** b̂ の横断平均（収縮の中心）。 */
  bMean: number;
  /** James-Stein の収縮率（0=収縮なし, 1=全部平均へ）。見かけの差のうちノイズの割合。 */
  shrinkFactor: number;
  /** b の差の識別力: 上位と下位の b 差 / その差の SE。 */
  spreadT: number;

  // ---- μ 側（C26 との並置）--------------------------------------------------
  /** 観測された μ̂ の最大−最小（年率）。 */
  muSpreadObs: number;
  /**
   * 「真の μ が全銘柄同一」というヌルの下で期待される μ̂ 最大−最小（年率）。
   * 極値統計の近似 E[max−min] ≈ SE·2√(2 ln N)（C26 の勝者の呪いと同じ式）。
   * 観測スプレッドがこれを下回るなら、μ̂ の順位は**丸ごとノイズと整合**する。
   */
  muSpreadNull: number;
  /** 観測 μ̂ スプレッドがヌル期待の何倍か。1未満なら μ で選ぶ根拠はゼロ。 */
  muSpreadRatio: number;
  /** 経済的に意味のある差 Δμ=5pp を t>κ で識別するのに必要な年数（中央値σを使用）。 */
  muYearsFor5pp: number;
  nBootDone: number;
  warnings: string[];
}

/** mulberry32（種つき一様乱数）。既存の他モジュールと同じ実装。P2 のブートでも使う。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * James-Stein 収縮（横断平均 b̄ へ）。
 *   b_JS = b̄ + max(0, 1 − (N−3)·s̄² / Σ(b_i−b̄)²)·(b_i − b̄),  s̄² = mean(SE_i²)
 * 収縮率 1−c がそのまま「見かけの銘柄間差のうちノイズが占める割合」の推定になる。
 * 銀行の b は SE が小さい（§3.2）ため収縮はほとんどかからないはずで、
 * **かかってしまう場合は「順位に意味が無い」というシグナル**として読む。
 */
function jamesStein(b: number[], se: number[]): { shrunk: number[]; factor: number; mean: number } {
  const N = b.length;
  const bMean = mean(b);
  if (N < 4) return { shrunk: [...b], factor: 0, mean: bMean };
  const ss = b.reduce((s, v) => s + (v - bMean) * (v - bMean), 0);
  const s2 = mean(se.map((v) => v * v));
  if (ss <= 0) return { shrunk: b.map(() => bMean), factor: 1, mean: bMean };
  const c = Math.max(0, 1 - ((N - 3) * s2) / ss); // 保持率
  return { shrunk: b.map((v) => bMean + c * (v - bMean)), factor: 1 - c, mean: bMean };
}

/** long-only＋1銘柄上限の反復キャップ。合計1に正規化する。 */
function capWeights(raw: number[], maxWeight: number): number[] {
  let w = raw.map((v) => Math.max(0, v));
  let sum = w.reduce((s, v) => s + v, 0);
  if (sum <= 0) return raw.map(() => 0);
  w = w.map((v) => v / sum);
  // 上限を超えた銘柄を上限に固定し、残りを再配分（最大 20 回）。
  for (let iter = 0; iter < 20; iter++) {
    const over = w.map((v) => v > maxWeight + 1e-9);
    if (!over.some(Boolean)) break;
    const fixed = w.reduce((s, v, i) => s + (over[i] ? maxWeight : 0), 0);
    const freeSum = w.reduce((s, v, i) => s + (over[i] ? 0 : v), 0);
    const room = Math.max(0, 1 - fixed);
    w = w.map((v, i) => (over[i] ? maxWeight : freeSum > 0 ? (v / freeSum) * room : 0));
  }
  sum = w.reduce((s, v) => s + v, 0);
  return sum > 0 ? w.map((v) => v / sum) : w;
}

/** 各銘柄が使うセクター因子（basket なら leave-one-out）を市場直交化して返す。 */
function factorFor(panel: ReturnPanel, i: number, source: FactorSource, common: number[]): number[] {
  if (source === "basket") return orthogonalize(leaveOneOut(panel, i), panel.market);
  return common;
}

/**
 * P1 本体。L0（前提診断）に銘柄別の b̂・S ランキング・推奨ウェイトを重ねて返す。
 *
 * 設計の核心は「b と市場β を必ず並べて出す」こと。銀行株は分散の 46% が市場由来で、
 * セクター由来（22%）より大きい（P0 実測）。b だけを見て選ぶと
 * **金利プレイのつもりで単に高βの銘柄を買う**事故が起きるので、purity（露出の純度）を
 * 常に併記し、散布図でも2軸に分けて見せる。
 */
export function computeSectorSelect(
  pricesByTicker: Record<string, PricePoint[]>,
  factors: FactorPrices,
  paramsIn: Partial<SectorSelectParams> = {}
): SectorSelectResult | null {
  const params = { ...DEFAULT_SELECT_PARAMS, ...paramsIn };
  const excluded = new Set(params.excludeTickers);
  const includedPrices = excluded.size
    ? Object.fromEntries(Object.entries(pricesByTicker).filter(([ticker]) => !excluded.has(ticker)))
    : pricesByTicker;
  const premise = computeSectorPremise(includedPrices, factors, params);
  if (!premise) return null;

  const panel = buildPanel(includedPrices, factors.market, factors.sector, params.window);
  if (!panel) return null;
  const T = panel.market.length;
  const N = panel.ret.length;
  const warnings: string[] = [];

  const source = premise.usedFactorSource;
  const rawSector = source === "etf" && panel.etf ? panel.etf : panel.basket;
  const Fcommon = orthogonalize(rawSector, panel.market);
  const varM = variance(panel.market);
  const years = T / TRADING_DAYS;

  // ---- 各銘柄の回帰（NW 標準誤差）------------------------------------------
  const bs: number[] = [];
  const bSes: number[] = [];
  const rows: Omit<AssetFactorFit, "rhoBasket" | "bShrunk" | "score" | "rank" | "rankLo" | "rankHi" | "rankTopShare" | "weight" | "weightUnc" | "muT" | "yearsNeeded">[] = [];

  // 回帰が落ちた銘柄は rows に入らないので、rows の添字とパネルの添字がずれる。
  // 順位ブートは panel.ret を引くため、対応表を持たないと**別の銘柄の系列で順位を作る**。
  const keptIdx: number[] = [];
  const keptFactor: number[][] = [];

  for (let i = 0; i < N; i++) {
    const Fi = factorFor(panel, i, source, Fcommon);
    const X: number[][] = [];
    for (let t = 0; t < T; t++) X.push([1, panel.market[t], Fi[t]]);
    const fit = olsNW(panel.ret[i], X, 5);
    if (!fit) continue;
    keptIdx.push(i);
    keptFactor.push(Fi);

    const c = fit.beta[1];
    const b = fit.beta[2];
    const vTot = variance(panel.ret[i]);
    const varF = variance(Fi);
    const marketShare = vTot > 0 ? (c * c * varM) / vTot : 0;
    const sectorShare = vTot > 0 ? (b * b * varF) / vTot : 0;
    const residShare = vTot > 0 ? variance(fit.resid) / vTot : 1;
    const sysShare = marketShare + sectorShare;

    const sigmaEps = fit.sigmaResid * Math.sqrt(TRADING_DAYS);
    const sigmaTot = Math.sqrt(vTot) * Math.sqrt(TRADING_DAYS);
    const muHat = mean(panel.ret[i]) * TRADING_DAYS;

    bs.push(b);
    bSes.push(fit.se[2]);
    rows.push({
      ticker: panel.tickers[i],
      b,
      bSe: fit.se[2],
      bT: fit.t[2],
      bLo: b - 1.96 * fit.se[2],
      bHi: b + 1.96 * fit.se[2],
      cMkt: c,
      cMktSe: fit.se[1],
      cMktT: fit.t[1],
      marketShare,
      sectorShare,
      residShare,
      purity: sysShare > 0 ? sectorShare / sysShare : 0,
      sigmaEps,
      sigmaTot,
      r2: fit.r2,
      muHat,
      // σ/√T（年率）。C26 の通り観測頻度では縮まない。
      muSe: years > 0 ? sigmaTot / Math.sqrt(years) : 0,
    });
  }
  if (rows.length < 3) return null;

  // ---- James-Stein 収縮 -----------------------------------------------------
  const js = jamesStein(bs, bSes);

  // ---- μ 側（C26 との並置）--------------------------------------------------
  const muMean = mean(rows.map((r) => r.muHat));

  // ---- スコアと配分 ---------------------------------------------------------
  const scored = rows.map((r, i) => {
    const bUse = params.shrink ? js.shrunk[i] : r.b;
    const dMu = r.muHat - muMean;
    return {
      ...r,
      // 回帰失敗で rows と panel の添字はずれうるため、必ず keptIdx を経由する。
      rhoBasket: corr(panel.ret[keptIdx[i]], leaveOneOut(panel, keptIdx[i])),
      bShrunk: js.shrunk[i],
      score: r.sigmaEps > 0 ? bUse / r.sigmaEps : 0,
      muT: r.muSe > 0 ? dMu / r.muSe : 0,
      // T* = (κσ/Δμ)²: この銘柄の μ が横断平均と違うことを t>κ で言うのに必要な年数
      yearsNeeded:
        Math.abs(dMu) > 1e-9 ? Math.pow((params.kappa * r.sigmaTot) / Math.abs(dMu), 2) : Infinity,
    };
  });

  const order = [...scored.keys()].sort((a, b) => scored[b].score - scored[a].score);
  const rankOf = new Map<number, number>();
  order.forEach((idx, pos) => rankOf.set(idx, pos + 1));

  // 推奨ウェイト w ∝ b/σ_ε²（採用は上位 topK のみ）
  const topSet = new Set(order.slice(0, Math.max(1, Math.min(params.topK, order.length))));
  const rawAll = scored.map((s) => {
    const bUse = params.shrink ? s.bShrunk : s.b;
    return s.sigmaEps > 0 ? bUse / (s.sigmaEps * s.sigmaEps) : 0;
  });
  const rawTop = rawAll.map((v, i) => (topSet.has(i) ? v : 0));
  const wTop = capWeights(rawTop, params.maxWeight);
  const sumUnc = rawAll.reduce((s, v) => s + Math.max(0, v), 0);
  const wUnc = rawAll.map((v) => (sumUnc > 0 ? Math.max(0, v) / sumUnc : 0));

  // ---- 順位のブートストラップCI（移動ブロック）------------------------------
  // NW は使わない（点推定だけあればよく、B×N 回まわすので軽さを優先）。
  const rand = mulberry32(params.seed);
  const nBlocks = Math.ceil(T / params.blockLen);
  const rankCount: number[][] = scored.map(() => new Array(scored.length + 1).fill(0));
  let nBootDone = 0;

  for (let bIter = 0; bIter < params.nBoot; bIter++) {
    // 時間インデックス列を作り、全銘柄・全因子に同じ列を適用＝横断相関を保存する。
    const idx: number[] = [];
    for (let k = 0; k < nBlocks; k++) {
      const start = Math.floor(rand() * Math.max(1, T - params.blockLen));
      for (let j = 0; j < params.blockLen && idx.length < T; j++) idx.push(start + j);
    }
    const Mb = idx.map((t) => panel.market[t]);
    const sc: { i: number; s: number }[] = [];
    for (let i = 0; i < scored.length; i++) {
      // 因子は点推定と同じもの（basket モードなら leave-one-out）を使う。
      // Fcommon を共用すると basket モードで自分自身を含むバスケットに回帰することになり、
      // b̂ が上振れ・σ_ε が下振れして、順位CI が点推定と別のスコア定義の上で作られてしまう。
      const Fi = keptFactor[i];
      const yb = idx.map((t) => panel.ret[keptIdx[i]][t]);
      const Xb: number[][] = [];
      for (let t = 0; t < yb.length; t++) Xb.push([1, Mb[t], Fi[idx[t]]]);
      const f = olsNW(yb, Xb, 0);
      if (!f) continue;
      const se = f.sigmaResid * Math.sqrt(TRADING_DAYS);
      sc.push({ i, s: se > 0 ? f.beta[2] / se : 0 });
    }
    if (sc.length !== scored.length) continue;
    sc.sort((a, b) => b.s - a.s);
    sc.forEach((x, pos) => rankCount[x.i][pos + 1]++);
    nBootDone++;
  }

  const assets: AssetFactorFit[] = scored.map((s, i) => {
    let lo = 1;
    let hi = scored.length;
    let top = 0;
    if (nBootDone > 0) {
      const counts = rankCount[i];
      top = counts[1] / nBootDone;
      let acc = 0;
      for (let r = 1; r <= scored.length; r++) {
        acc += counts[r];
        if (acc >= 0.025 * nBootDone) {
          lo = r;
          break;
        }
      }
      acc = 0;
      for (let r = scored.length; r >= 1; r--) {
        acc += counts[r];
        if (acc >= 0.025 * nBootDone) {
          hi = r;
          break;
        }
      }
    }
    return {
      ...s,
      rank: rankOf.get(i) ?? 0,
      rankLo: lo,
      rankHi: hi,
      rankTopShare: top,
      weight: wTop[i],
      weightUnc: wUnc[i],
    };
  });
  assets.sort((a, b) => a.rank - b.rank);

  // ---- 識別力の要約: b の上下差は測れるが μ の上下差は測れない ---------------
  //
  // 「b の差は測れる」を示す統計量なので、**b の最大と最小**で取る。assets は S=b/σ_ε 順なので
  // その両端を使うと、b が最大でも σ_ε が大きくて S が最下位、という銘柄で t が負になり、
  // 「b は測れる」の緑カードに負の t が出る（画面の文言と矛盾する）。
  const byB = [...assets].sort((x, y) => y.b - x.b);
  const best = byB[0];
  const worst = byB[byB.length - 1];
  const dB = best.b - worst.b;
  const seDiff = Math.sqrt(best.bSe * best.bSe + worst.bSe * worst.bSe);
  const spreadT = seDiff > 0 ? dB / seDiff : 0;

  // μ 側は「観測スプレッドから必要年数を逆算」してはいけない。
  // 最大−最小は選抜バイアスが最も強く乗る統計量なので、そこから T* を出すと
  // μ が測れるかのように見えてしまう（実際 7203.T 級の分散でも「7年」と出る）。
  // 正しい問いは「観測スプレッドは、真の μ が全銘柄同じでも出る大きさか」。
  const muHats = assets.map((a) => a.muHat);
  const muSpreadObs = Math.max(...muHats) - Math.min(...muHats);
  const meanMuSe = mean(assets.map((a) => a.muSe));
  const muSpreadNull = meanMuSe * 2 * Math.sqrt(2 * Math.log(Math.max(2, assets.length)));
  const muSpreadRatio = muSpreadNull > 0 ? muSpreadObs / muSpreadNull : 0;
  const sigmasSorted = [...assets.map((a) => a.sigmaTot)].sort((a, b) => a - b);
  const sigMed = sigmasSorted[Math.floor(sigmasSorted.length / 2)];
  const muYearsFor5pp = Math.pow((params.kappa * sigMed) / 0.05, 2);

  if (muSpreadRatio < 1) {
    warnings.push(
      `μ̂ の銘柄間スプレッドは ${(muSpreadObs * 100).toFixed(0)}pp/年だが、真の μ が全銘柄同一でも` +
        `ノイズだけで ${(muSpreadNull * 100).toFixed(0)}pp/年 は出る（勝者の呪い）。` +
        `**過去リターンの順位はノイズと区別できない**ので、選別に使わないこと。`
    );
  }

  if (js.factor > 0.3) {
    warnings.push(
      `James-Stein の収縮率が ${(js.factor * 100).toFixed(0)}% と大きい。見かけの b の銘柄間差の` +
        `${(js.factor * 100).toFixed(0)}% は推定ノイズと整合的で、順位の信頼度は低い。`
    );
  }
  const lowPurity = assets.filter((a) => a.purity < 0.25);
  if (lowPurity.length > 0) {
    warnings.push(
      `純度が 25% 未満の銘柄が ${lowPurity.length} 本ある（${lowPurity.slice(0, 4).map((a) => a.ticker).join(", ")}${lowPurity.length > 4 ? " ほか" : ""}）。` +
        `これらは金利ではなく市場全体に連動している比率が高く、b が大きくても「金利プレイ」にはならない。`
    );
  }
  if (nBootDone < params.nBoot * 0.8) {
    warnings.push(`順位ブートストラップが ${nBootDone}/${params.nBoot} 回しか成立しなかった。順位CIは参考値。`);
  }

  return {
    params,
    premise,
    assets,
    bMean: js.mean,
    shrinkFactor: js.factor,
    spreadT,
    muSpreadObs,
    muSpreadNull,
    muSpreadRatio,
    muYearsFor5pp,
    nBootDone,
    warnings,
  };
}
