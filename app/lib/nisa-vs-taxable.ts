// NISA(非課税・バイ&ホールド) vs 現物(課税・曜日タイミング戦略) の税引後リターン比較。
// -------------------------------------------------------------------------------------
// 「1年運用したとき、年初に全枠使い切って持ち切るNISA」と「期待値がマイナスの区間
// (例: 金曜引け→月曜)は持たず、良い区間だけ現物で回す戦略」の、税・コスト控除後の
// 最終リターンはどちらが上回るか——を同一エンジンで公平に比較するための純粋関数群。
//
// 中核は「円建て清算価値ウォーカー」。各営業日の終値時点で『今すべて売って税を精算
// したら手元にいくら残るか(清算価値)』を計算し、これを税引後エクイティとする。
//   ・NISA          : ポジション常時+1、非課税(applyTax=false)
//   ・現物 バイ&ホールド: ポジション常時+1、清算時に一括課税
//   ・現物 曜日戦略   : 曜日プランのポジション、往復ごとに実現→課税
// これにより3シナリオが (ポジションベクトル, 課税ON/OFF, 税モデル) の違いだけで表現でき、
// weekday-trade.ts の buildPositionVector を唯一の生成源として戦略のプレタックス経路が
// シミュレータと完全一致する。
//
// 税モデル:
//   Model A (yearEnd / 源泉徴収なし)  : 年内はプレタックスで複利、清算(=年末)に実現純益へ
//                                       一括課税。日本の一般口座/特定口座(源泉なし)に対応。
//   Model B (withholding / 源泉あり)  : 往復ごとに源泉徴収して再投資元本を削る。年内損益通算
//                                       の還付をバッファで再現。複利ドラッグが乗る。
//
// 損益分岐(核心): 益が出る前提で、戦略が非課税バイ&ホールド R を上回る条件は
//   R_strat・(1−τ) > R  ⟺  R_strat > R/(1−τ)。τ=0.20315 なら約 R×1.255。
//   つまり曜日戦略は NISA より約25.5%多くグロスで稼いで初めて同点になる。
import { PricePoint } from "./types";
import {
  TradeSpec,
  PlanGapFill,
  buildPositionVector,
  type Segment,
} from "./weekday-trade";
import {
  DEFAULT_MARGIN_RATE_LONG as RM_MARGIN_LONG,
  DEFAULT_SHORT_FEE_RATE as RM_SHORT_FEE,
  DEFAULT_MAINTENANCE as RM_MAINTENANCE,
  MAX_LEVERAGE as RM_MAX_LEVERAGE,
  adminFeeMonthlyRate as rmAdminFeeMonthlyRate,
  transferFeeAnnualRate as rmTransferFeeAnnualRate,
  DAYS_PER_MONTH,
  DEFAULT_LOT_SIZE,
  DEFAULT_RECORD_DATES_PER_YEAR,
} from "./rakuten-margin";

export const TAX_RATE = 0.20315; // 所得税15% + 復興特別2.1%相当 + 住民税5% = 20.315%
export const GROWTH_QUOTA = 2_400_000; // NISA成長投資枠(年) 円
export const TSUMITATE_QUOTA = 1_200_000; // つみたて投資枠(年) 円
export const ANNUAL_QUOTA = GROWTH_QUOTA + TSUMITATE_QUOTA; // 年間上限 360万円

// 信用取引の既定パラメータ。NISAは信用不可なので、レバレッジ戦略は必ず課税口座になる。
// 実際のコストは楽天証券・制度信用（通常）を単一ソース rakuten-margin.ts から取り込む。
export const DEFAULT_MARGIN_RATE_LONG = RM_MARGIN_LONG; // 制度信用 買方金利(年率 2.80%)
export const DEFAULT_SHORT_FEE_RATE = RM_SHORT_FEE; // 貸株料(年率 1.10%)。逆日歩は変動なので別途注記。
export const DEFAULT_MAINTENANCE = RM_MAINTENANCE; // 委託保証金維持率(これを割ると追証)
export const MAX_LEVERAGE = RM_MAX_LEVERAGE; // 委託保証金率30%の逆数 ≒ 現実的なレバ上限

export type TaxModel = "yearEnd" | "withholding"; // A / B

export interface SimPoint {
  t: number; // ms
  pre: number; // 税引前の清算価値(1始まり)
  post: number; // 税引後の清算価値(1始まり)
}

export interface SimResult {
  path: SimPoint[]; // 日次(各営業日終値)
  preTaxReturn: number; // 税引前 最終リターン
  afterTaxReturn: number; // 税引後 最終リターン(=清算価値-1)
  grossReturn: number; // レバ後・摩擦控除前 最終リターン
  taxPaid: number; // 支払税額(富比。pre - post)
  cost: number; // 取引コストで失った富
  carryCost: number; // 信用金利・貸株料で失った富(合計)
  carryLong: number; // うち買い方金利
  carryShort: number; // うち貸株料(売り建て)
  adminFee: number; // 事務管理費で失った富(建玉1か月経過ごと・両建て課金)
  transferFee: number; // 名義書換料で失った富(買建て・権利確定日跨ぎの期待値)
  miscCost: number; // 諸経費合計(adminFee + transferFee)
  exposure: number; // 市場滞在率(0..1, セグメント比)
  nRoundTrips: number; // 実現(手仕舞い)回数
  volAnnual: number; // 税引前日次リターンの年率ボラ
  maxDD: number; // 税引前清算価値のドローダウン(負)
  sharpe: number; // 税引前日次Sharpe(年率)
  marginCall: boolean; // 期間内に一度でも追証(維持率割れ)が発生したか
  ruin: boolean; // 期間内に一度でも証拠金が枯渇(破産)したか
}

interface SimOptions {
  taxModel: TaxModel;
  taxRate: number;
  costBps: number; // 片道コスト(bps)
  applyTax: boolean; // false=NISA(非課税)
  leverage: number; // 建玉倍率(1=現物相当)。>1で信用の買い建て/売り建て
  marginRateLong: number; // 買い方金利(年率)
  shortFeeRate: number; // 貸株料(年率)
  maintenanceMargin: number; // 委託保証金維持率(割れで追証)
  adminFeeMonthlyRate: number; // 事務管理費(建玉notional比・1か月あたり)。0で無効
  transferFeeAnnualRate: number; // 名義書換料(買建notional比・年率期待値)。0で無効
}

const EMPTY_SIM: SimResult = {
  path: [], preTaxReturn: 0, afterTaxReturn: 0, grossReturn: 0, taxPaid: 0,
  cost: 0, carryCost: 0, carryLong: 0, carryShort: 0, adminFee: 0, transferFee: 0,
  miscCost: 0, exposure: 0, nRoundTrips: 0,
  volAnnual: 0, maxDD: 0, sharpe: 0, marginCall: false, ruin: false,
};

// 清算価値ウォーカー本体(コア)。segs/pos は buildPositionVector の出力。
// レバレッジ・信用キャリー・追証/破産判定を単一口座(acct)モデルで処理する。
// acct = 口座純資産(証拠金)。建玉中は acct が原資産×レバで動き、キャリー(金利/貸株料)を
// 日数比例で控除。追証/破産は「静的建玉」の維持率で判定する(constant-leverage の複利とは分離)。
function walk(segs: Segment[], pos: number[], opts: SimOptions): SimResult {
  const nSeg = segs.length;
  if (nSeg < 1) return EMPTY_SIM;

  const costRate = opts.costBps / 10000;
  const tau = opts.applyTax ? opts.taxRate : 0;
  const lev = opts.leverage;
  const rLong = opts.marginRateLong;
  const rShort = opts.shortFeeRate;
  const maint = opts.maintenanceMargin;
  const adminRate = opts.adminFeeMonthlyRate; // 事務管理費(1か月あたり notional比)
  const transferRate = opts.transferFeeAnnualRate; // 名義書換料(年率 notional比, 買建のみ)

  let acct = 1; // 口座純資産(1始まり)。摩擦・税・キャリーをすべて反映
  let acctEntry = 0; // 現トリップ開始時の口座価値(コスト控除前)
  let undMul = 1; // 現トリップの原資産(無レバ・無サイド)累積倍率。追証/破産判定用
  let sideSign = 0;
  let ytdRealized = 0;
  let taxWithheld = 0;
  let grossMul = 1; // レバ後の純市場グロス(摩擦なし)
  let tradeCost = 0, carryLong = 0, carryShort = 0, adminFee = 0, transferFee = 0;
  let tripDays = 0, adminMonths = 0; // 現トリップの継続暦日と課金済み事務管理費の月数
  let prevPos = 0, inMarketSeg = 0, nRoundTrips = 0;
  let marginCall = false, ruin = false;

  const path: SimPoint[] = [];
  const dailyPreRet: number[] = [];
  let lastPre = 1;

  for (let s = 0; s < nSeg; s++) {
    const p = pos[s];
    const r = segs[s].ret;
    const days = segs[s].days;

    // --- ポジション変更: 取引コスト(建玉notional=lev×|Δpos|)→手仕舞い実現→新規建て ---
    if (p !== prevPos) {
      const c = acct * costRate * lev * Math.abs(p - prevPos);
      acct -= c; tradeCost += c;
      if (prevPos !== 0) {
        const pnl = acct - acctEntry; // 実現損益(コスト・キャリー込み=経費控除後)
        ytdRealized += pnl;
        nRoundTrips++;
        if (opts.applyTax && opts.taxModel === "withholding") {
          const owed = tau * Math.max(0, ytdRealized);
          const delta = owed - taxWithheld; // >0追加徴収 / <0還付(年内通算)
          acct -= delta; taxWithheld += delta;
        }
      }
      if (p !== 0) { acctEntry = acct; sideSign = p; undMul = 1; tripDays = 0; adminMonths = 0; }
      else sideSign = 0;
      prevPos = p;
    }

    // --- セグメント収益(レバ後)＋キャリー(持ち越し日数比例) ---
    if (p !== 0) {
      acct *= 1 + lev * p * r;
      grossMul *= 1 + lev * p * r;
      if (days > 0) {
        // 買い建て: 借入(lev−1)に金利 / 売り建て: 建玉lev分に貸株料
        const carryRate = p > 0 ? (lev - 1) * rLong : lev * rShort;
        if (carryRate > 0) {
          const cc = acct * carryRate * (days / 365);
          acct -= cc;
          if (p > 0) carryLong += cc; else carryShort += cc;
        }
        // 名義書換料(買建のみ・年率期待値の日割り)。権利確定日跨ぎを期待値で近似。
        if (p > 0 && transferRate > 0) {
          const tf = acct * lev * transferRate * (days / 365);
          acct -= tf; transferFee += tf;
        }
        // 事務管理費(両建て)。建玉継続が満1か月を跨ぐごとに1株11銭相当を課金。
        // 週内で手仕舞う短期戦略は満1か月に届かず課金0になる(実際の課金ルールに忠実)。
        if (adminRate > 0) {
          tripDays += days;
          while (tripDays >= (adminMonths + 1) * DAYS_PER_MONTH) {
            const af = acct * lev * adminRate;
            acct -= af; adminFee += af; adminMonths++;
          }
        }
      }
      inMarketSeg++;

      // --- 追証/破産判定(静的建玉の維持率) ---
      undMul *= 1 + r; // 原資産の累積(サイド適用前)
      const x = sideSign * (undMul - 1); // 建玉のP&L率(有利で正)
      const equityRatio = 1 + lev * x; // 建玉時E=1基準の静的エクイティ
      if (equityRatio <= 0) ruin = true;
      else if (undMul > 0) {
        const ratio = equityRatio / (lev * undMul); // 維持率=純資産/建玉評価額
        if (ratio < maint) marginCall = true;
      }
    }

    // --- 日次(その日の終値時点)で清算価値を記録 ---
    if (segs[s].isClose) {
      const liqCost = sideSign !== 0 ? acct * costRate * lev : 0; // 清算時の手仕舞いコスト
      const pre = acct - liqCost; // 税引前清算価値
      const realizedIfLiq = ytdRealized + (sideSign !== 0 ? pre - acctEntry : 0);
      const owedTotal = tau * Math.max(0, realizedIfLiq);
      const post = opts.taxModel === "withholding"
        ? pre - Math.max(0, owedTotal - taxWithheld)
        : pre - owedTotal;
      path.push({ t: segs[s].t, pre, post });
      dailyPreRet.push(pre / lastPre - 1);
      lastPre = pre;
    }
  }

  if (path.length === 0) return EMPTY_SIM;
  const last = path[path.length - 1];
  const preTaxReturn = last.pre - 1;

  const rets = dailyPreRet.slice(1);
  const avg = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const variance = rets.length > 1 ? rets.reduce((a, v) => a + (v - avg) ** 2, 0) / (rets.length - 1) : 0;
  const sd = Math.sqrt(variance);

  let peak = -Infinity, maxDD = 0;
  for (const pt of path) {
    peak = Math.max(peak, pt.pre);
    const dd = (pt.pre - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  return {
    path,
    preTaxReturn,
    afterTaxReturn: last.post - 1,
    grossReturn: grossMul - 1,
    taxPaid: last.pre - last.post,
    cost: tradeCost,
    carryCost: carryLong + carryShort,
    carryLong,
    carryShort,
    adminFee,
    transferFee,
    miscCost: adminFee + transferFee,
    exposure: nSeg ? inMarketSeg / nSeg : 0,
    nRoundTrips,
    volAnnual: sd * Math.sqrt(252),
    maxDD,
    sharpe: sd > 0 ? (avg / sd) * Math.sqrt(252) : 0,
    marginCall,
    ruin,
  };
}

function simulate(prices: PricePoint[], legs: TradeSpec[], gapFill: PlanGapFill, opts: SimOptions): SimResult {
  const { segs, pos } = buildPositionVector(prices, legs, gapFill);
  return walk(segs, pos, opts);
}

export interface ComparisonInput {
  prices: PricePoint[];
  legs: TradeSpec[]; // 曜日戦略のレグ(bestCombination or 手動)
  gapFill: PlanGapFill; // 戦略の隙間の埋め方(通常 "cash")
  taxModel: TaxModel;
  taxRate: number;
  costBps: number;
  // 信用取引(戦略シナリオにのみ適用。NISA/現物BHは常に現物ロング=lev1・キャリー0)
  leverage?: number; // 既定1
  marginRateLong?: number;
  shortFeeRate?: number;
  maintenanceMargin?: number;
  // 諸経費(事務管理費・名義書換料)。楽天証券の実額を建玉notional比に換算して計上。
  includeAdminFee?: boolean; // 事務管理費を計上(既定 true)
  includeTransferFee?: boolean; // 名義書換料を計上(既定 true)
  refPrice?: number; // 諸経費換算の基準株価(円)。未指定なら prices の終値平均
  lotSize?: number; // 売買単位(名義書換料の1単位株数, 既定100)
  recordDatesPerYear?: number; // 権利確定日/年(名義書換料の跨ぎ回数期待値, 既定2)
}

// 諸経費換算の基準株価: prices の終値平均(0除算・欠損に頑健)。
function meanClose(prices: PricePoint[]): number {
  let sum = 0, n = 0;
  for (const p of prices) { if (p.close > 0) { sum += p.close; n++; } }
  return n > 0 ? sum / n : 0;
}

// 現物ロング(NISA/現物BH)用: レバ1・キャリー0・諸経費0(信用取引ではないため)。
function cashOpts(taxModel: TaxModel, taxRate: number, applyTax: boolean): SimOptions {
  return {
    taxModel, taxRate, costBps: 0, applyTax, leverage: 1,
    marginRateLong: 0, shortFeeRate: 0, maintenanceMargin: DEFAULT_MAINTENANCE,
    adminFeeMonthlyRate: 0, transferFeeAnnualRate: 0,
  };
}

// 戦略(信用可)用のオプションを input から解決。諸経費は基準株価から notional 比へ換算。
function stratOpts(input: ComparisonInput, leverageOverride?: number): SimOptions {
  const refPrice = input.refPrice ?? meanClose(input.prices);
  const lotSize = input.lotSize ?? DEFAULT_LOT_SIZE;
  const recordDates = input.recordDatesPerYear ?? DEFAULT_RECORD_DATES_PER_YEAR;
  const admin = (input.includeAdminFee ?? true) ? rmAdminFeeMonthlyRate(refPrice) : 0;
  const transfer = (input.includeTransferFee ?? true) ? rmTransferFeeAnnualRate(refPrice, lotSize, recordDates) : 0;
  return {
    taxModel: input.taxModel,
    taxRate: input.taxRate,
    costBps: input.costBps,
    applyTax: true,
    leverage: leverageOverride ?? input.leverage ?? 1,
    marginRateLong: input.marginRateLong ?? DEFAULT_MARGIN_RATE_LONG,
    shortFeeRate: input.shortFeeRate ?? DEFAULT_SHORT_FEE_RATE,
    maintenanceMargin: input.maintenanceMargin ?? DEFAULT_MAINTENANCE,
    adminFeeMonthlyRate: admin,
    transferFeeAnnualRate: transfer,
  };
}

export interface Comparison {
  nisa: SimResult; // NISA: 常時ロング・非課税
  taxableBH: SimResult; // 現物バイ&ホールド: 常時ロング・清算時課税
  strategy: SimResult; // 現物 曜日戦略: 課税
  winner: "nisa" | "strategy" | "tie";
  edge: number; // strategy.afterTaxReturn - nisa.afterTaxReturn
  breakEvenGross: number; // 戦略が非課税BHに並ぶのに必要な税引前リターン
  requiredEdge: number; // 上記 − NISAリターン(税が課す"上乗せハードル")
}

// 3シナリオを同一エンジンで評価して比較する。
export function compareNisaVsTaxable(input: ComparisonInput): Comparison {
  const { prices, legs, gapFill, taxModel, taxRate } = input;
  // NISA / 現物BH は常時ロング(legs=[], gapFill="hold" → pos全区間+1)・現物(lev1)
  const nisa = simulate(prices, [], "hold", cashOpts(taxModel, taxRate, false));
  const taxableBH = simulate(prices, [], "hold", cashOpts(taxModel, taxRate, true));
  const strategy = simulate(prices, legs, gapFill, stratOpts(input));

  const edge = strategy.afterTaxReturn - nisa.afterTaxReturn;
  const winner: Comparison["winner"] = Math.abs(edge) < 1e-9 ? "tie" : edge > 0 ? "strategy" : "nisa";
  // 損益分岐: 益前提で R_strat(1−τ) = R_nisa → R_strat = R_nisa/(1−τ)
  const R = nisa.afterTaxReturn;
  const breakEvenGross = R > 0 ? R / (1 - taxRate) : R;
  return {
    nisa, taxableBH, strategy, winner, edge,
    breakEvenGross,
    requiredEdge: breakEvenGross - R,
  };
}

export interface RollingPoint {
  startT: number;
  endT: number;
  nisa: number; // NISA 税引後リターン(1年)
  taxableBH: number; // 現物BH 税引後
  strategy: number; // 戦略 税引後
  edge: number; // strategy − nisa
}

export interface RollingResult {
  points: RollingPoint[];
  winRate: number; // 戦略がNISAを上回った窓の割合
  medianEdge: number;
  meanEdge: number;
  p5: number;
  p95: number;
}

// 10年履歴をローリング窓(既定252営業日)で回し、各1年窓での税引後リターン差の分布を得る。
// 単年は誤差が大きいため、こちらが頑健な結論を与える。
export function rollingComparison(
  input: ComparisonInput,
  window = 252,
  step = 5,
): RollingResult {
  const { prices, legs, gapFill, taxModel, taxRate } = input;
  const nisaOpts = cashOpts(taxModel, taxRate, false);
  const bhOpts = cashOpts(taxModel, taxRate, true);
  const sOpts = stratOpts(input);
  const points: RollingPoint[] = [];
  if (prices.length < window) {
    return { points, winRate: 0, medianEdge: 0, meanEdge: 0, p5: 0, p95: 0 };
  }
  for (let i = 0; i + window <= prices.length; i += step) {
    const slice = prices.slice(i, i + window);
    const nisa = simulate(slice, [], "hold", nisaOpts);
    const taxableBH = simulate(slice, [], "hold", bhOpts);
    const strategy = simulate(slice, legs, gapFill, sOpts);
    points.push({
      startT: new Date(slice[0].time).getTime(),
      endT: new Date(slice[slice.length - 1].time).getTime(),
      nisa: nisa.afterTaxReturn,
      taxableBH: taxableBH.afterTaxReturn,
      strategy: strategy.afterTaxReturn,
      edge: strategy.afterTaxReturn - nisa.afterTaxReturn,
    });
  }
  const edges = points.map((p) => p.edge).sort((a, b) => a - b);
  const n = edges.length;
  const q = (f: number) => (n === 0 ? 0 : edges[Math.min(n - 1, Math.max(0, Math.round(f * (n - 1))))]);
  const winRate = n ? points.filter((p) => p.edge > 0).length / n : 0;
  const meanEdge = n ? edges.reduce((a, b) => a + b, 0) / n : 0;
  return {
    points,
    winRate,
    medianEdge: q(0.5),
    meanEdge,
    p5: q(0.05),
    p95: q(0.95),
  };
}

// 円建てモード: 初期資本 capital をNISA枠 quota で上限を掛ける。
// 枠超過分は課税口座でのバイ&ホールド(清算時課税)として扱う。
export interface YenResult {
  nisaFinalYen: number; // NISA(枠内)税引後の最終評価額
  overflowFinalYen: number; // 枠超過分(課税BH)の最終評価額
  nisaTotalYen: number; // NISA運用側 合計(枠内+超過)
  strategyFinalYen: number; // 全額を現物戦略で回した場合の税引後
  capital: number;
  quotaUsed: number;
  overflow: number;
}

export function yenComparison(
  cmp: Comparison,
  capital: number,
  quota: number,
): YenResult {
  const quotaUsed = Math.min(capital, quota);
  const overflow = Math.max(0, capital - quota);
  const nisaFinalYen = quotaUsed * (1 + cmp.nisa.afterTaxReturn);
  const overflowFinalYen = overflow * (1 + cmp.taxableBH.afterTaxReturn);
  return {
    nisaFinalYen,
    overflowFinalYen,
    nisaTotalYen: nisaFinalYen + overflowFinalYen,
    strategyFinalYen: capital * (1 + cmp.strategy.afterTaxReturn),
    capital,
    quotaUsed,
    overflow,
  };
}

// =============================================================
// レバレッジ探索: 「NISAを上回るのに必要な最小レバ k*」とリスクの代償
// -------------------------------------------------------------
// 信用取引で戦略の建玉倍率を上げれば期待リターンは伸びるが、ボラ・MaxDD・追証/破産確率も
// 比例拡大し、キャリーコスト(金利/貸株料)も増える。レバkをスイープし、税引後リターンが
// NISA中央値に並ぶ最小レバ k* を求めつつ、その代償(リスク指標)を同時に返す。
// 確率(追証/破産)は分布仮定を置かず、10年をローリング1年窓で回した実現頻度で推定する。
// =============================================================

function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface LeveragePoint {
  leverage: number;
  afterTaxReturn: number; // ローリング1年窓の税引後リターン中央値
  maxDD: number; // 平均MaxDD(負)
  volAnnual: number; // 平均年率ボラ
  marginCallProb: number; // 追証が発生した窓の割合
  ruinProb: number; // 破産(証拠金枯渇)した窓の割合
  carryCost: number; // 平均キャリーコスト(富比)
  miscCost: number; // 平均諸経費(事務管理費+名義書換料, 富比)
}

export interface LeverageSweep {
  points: LeveragePoint[];
  nisaAfterTax: number; // NISA税引後リターン中央値(レバ非依存の基準線)
  kStar: number | null; // NISA中央値を上回る最小レバ(なければnull)
  atLev1: LeveragePoint | null; // レバ1倍(現物相当)の点
}

export function leverageSweep(
  input: ComparisonInput,
  levs: number[],
  window = 252,
  step = 5,
): LeverageSweep {
  const { prices, legs, gapFill, taxModel, taxRate } = input;
  const nisaOpts = cashOpts(taxModel, taxRate, false);
  const empty: LeverageSweep = { points: [], nisaAfterTax: 0, kStar: null, atLev1: null };
  if (prices.length < window) return empty;

  // 窓ごとにポジションベクトルを1回だけ構築し、全レバで再利用(計算量を窓×レバに抑える)
  const stratWindows: { segs: Segment[]; pos: number[] }[] = [];
  const nisaRets: number[] = [];
  for (let i = 0; i + window <= prices.length; i += step) {
    const slice = prices.slice(i, i + window);
    const nisaPV = buildPositionVector(slice, [], "hold");
    nisaRets.push(walk(nisaPV.segs, nisaPV.pos, nisaOpts).afterTaxReturn);
    const stratPV = buildPositionVector(slice, legs, gapFill);
    stratWindows.push({ segs: stratPV.segs, pos: stratPV.pos });
  }
  const nisaAfterTax = median(nisaRets);
  const nW = stratWindows.length || 1;

  const points: LeveragePoint[] = levs.map((lev) => {
    const sOpts = stratOpts(input, lev);
    const rets: number[] = [], dds: number[] = [], vols: number[] = [], carries: number[] = [], miscs: number[] = [];
    let mc = 0, ru = 0;
    for (const w of stratWindows) {
      const res = walk(w.segs, w.pos, sOpts);
      rets.push(res.afterTaxReturn); dds.push(res.maxDD); vols.push(res.volAnnual);
      carries.push(res.carryCost); miscs.push(res.miscCost);
      if (res.marginCall) mc++;
      if (res.ruin) ru++;
    }
    return {
      leverage: lev,
      afterTaxReturn: median(rets),
      maxDD: mean(dds),
      volAnnual: mean(vols),
      marginCallProb: mc / nW,
      ruinProb: ru / nW,
      carryCost: mean(carries),
      miscCost: mean(miscs),
    };
  });

  // k*: 税引後中央値が NISA中央値に最初に到達するレバ(点間は線形補間)
  let kStar: number | null = null;
  for (let i = 0; i < points.length; i++) {
    if (points[i].afterTaxReturn >= nisaAfterTax) {
      if (i === 0) kStar = points[0].leverage;
      else {
        const a = points[i - 1], b = points[i];
        const denom = b.afterTaxReturn - a.afterTaxReturn || 1;
        const t = (nisaAfterTax - a.afterTaxReturn) / denom;
        kStar = a.leverage + t * (b.leverage - a.leverage);
      }
      break;
    }
  }
  const atLev1 = points.find((p) => Math.abs(p.leverage - 1) < 1e-9) ?? null;
  return { points, nisaAfterTax, kStar, atLev1 };
}
