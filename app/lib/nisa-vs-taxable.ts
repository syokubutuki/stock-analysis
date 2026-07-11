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
} from "./weekday-trade";

export const TAX_RATE = 0.20315; // 所得税15% + 復興特別2.1%相当 + 住民税5% = 20.315%
export const GROWTH_QUOTA = 2_400_000; // NISA成長投資枠(年) 円
export const TSUMITATE_QUOTA = 1_200_000; // つみたて投資枠(年) 円
export const ANNUAL_QUOTA = GROWTH_QUOTA + TSUMITATE_QUOTA; // 年間上限 360万円

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
  grossReturn: number; // コスト控除前 最終リターン
  taxPaid: number; // 支払税額(富比。pre - post)
  cost: number; // 取引コストで失った富(gross - pre)
  exposure: number; // 市場滞在率(0..1, セグメント比)
  nRoundTrips: number; // 実現(手仕舞い)回数
  volAnnual: number; // 税引前日次リターンの年率ボラ
  maxDD: number; // 税引前清算価値のドローダウン(負)
  sharpe: number; // 税引前日次Sharpe(年率)
}

interface SimOptions {
  taxModel: TaxModel;
  taxRate: number;
  costBps: number; // 片道コスト(bps)
  applyTax: boolean; // false=NISA(非課税)
}

// 清算価値ウォーカー本体。pos は buildPositionVector が返すセグメント毎の目標ポジション。
function simulate(
  prices: PricePoint[],
  legs: TradeSpec[],
  gapFill: PlanGapFill,
  opts: SimOptions,
): SimResult {
  const { segs, pos } = buildPositionVector(prices, legs, gapFill);
  const nSeg = segs.length;
  const empty: SimResult = {
    path: [], preTaxReturn: 0, afterTaxReturn: 0, grossReturn: 0, taxPaid: 0,
    cost: 0, exposure: 0, nRoundTrips: 0, volAnnual: 0, maxDD: 0, sharpe: 0,
  };
  if (nSeg < 1) return empty;

  const costRate = opts.costBps / 10000;
  const tau = opts.applyTax ? opts.taxRate : 0;

  // 状態(すべて富=1基準の円建て。初期資本1をキャッシュで保有)
  let cash = 1; // 市場外の現金(Model Bでは源泉徴収後の額)
  let basis = 0; // 建玉のコスト基準(取得時の投入額)
  let mv = 0; // 建玉の時価
  let sideSign = 0; // 建玉の符号(+1/-1)
  let ytdRealized = 0; // 年内の実現損益(通算後の対象額の素)
  let taxWithheld = 0; // Model B: 年内すでに源泉徴収した税
  let grossMul = 1; // コスト・税を一切引かないグロス富(参考)
  let prevPos = 0;
  let inMarketSeg = 0;
  let nRoundTrips = 0;

  const path: SimPoint[] = [];
  const dailyPreRet: number[] = []; // 税引前日次リターン(リスク指標用)
  let lastPre = 1;

  for (let s = 0; s < nSeg; s++) {
    const p = pos[s];
    const r = segs[s].ret;

    // --- ポジション変更: 旧建玉を手仕舞い、新建玉を建てる ---
    if (p !== prevPos) {
      if (prevPos !== 0) {
        // 手仕舞い(exit): 時価に片道コスト、実現損益を確定して現金化
        mv *= 1 - costRate;
        const pnl = mv - basis;
        cash += mv;
        ytdRealized += pnl;
        nRoundTrips++;
        if (opts.applyTax && opts.taxModel === "withholding") {
          // 源泉徴収あり: 年内通算後の要納税額との差分を都度精算(損なら還付)
          const owed = tau * Math.max(0, ytdRealized);
          const delta = owed - taxWithheld; // >0で追加徴収, <0で還付
          cash -= delta;
          taxWithheld += delta;
        }
        mv = 0; basis = 0; sideSign = 0;
      }
      if (p !== 0) {
        // 建て(entry): 現金全額を投入、片道コスト
        cash *= 1 - costRate;
        basis = cash;
        mv = cash;
        cash = 0;
        sideSign = p;
      }
      prevPos = p;
    }

    // --- セグメント収益を建玉に適用 ---
    if (p !== 0) {
      mv *= 1 + p * r;
      grossMul *= 1 + p * r;
      inMarketSeg++;
    }

    // --- 日次(その日の終値時点)で清算価値を記録 ---
    if (segs[s].isClose) {
      // いま清算したら: 建玉に手仕舞いコスト → 実現、年内通算で要納税額を精算
      const mvLiq = sideSign !== 0 ? mv * (1 - costRate) : mv;
      const unreal = sideSign !== 0 ? mvLiq - basis : 0;
      const realizedIfLiq = ytdRealized + unreal;
      const owedTotal = tau * Math.max(0, realizedIfLiq);
      const pre = cash + mvLiq; // 税引前清算価値
      let post: number;
      if (opts.taxModel === "withholding") {
        post = pre - Math.max(0, owedTotal - taxWithheld);
      } else {
        post = pre - owedTotal;
      }
      path.push({ t: segs[s].t, pre, post });
      dailyPreRet.push(pre / lastPre - 1);
      lastPre = pre;
    }
  }

  if (path.length === 0) return empty;
  const last = path[path.length - 1];
  const preTaxReturn = last.pre - 1;
  const afterTaxReturn = last.post - 1;
  const grossReturn = grossMul - 1;

  // リスク指標(税引前日次)
  const rets = dailyPreRet.slice(1); // 先頭は基準からの差でノイズになるため除外
  const avg = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const variance = rets.length > 1 ? rets.reduce((a, v) => a + (v - avg) ** 2, 0) / (rets.length - 1) : 0;
  const sd = Math.sqrt(variance);
  const volAnnual = sd * Math.sqrt(252);
  const sharpe = sd > 0 ? (avg / sd) * Math.sqrt(252) : 0;

  let peak = -Infinity, maxDD = 0;
  for (const pt of path) {
    peak = Math.max(peak, pt.pre);
    const dd = (pt.pre - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  return {
    path,
    preTaxReturn,
    afterTaxReturn,
    grossReturn,
    taxPaid: last.pre - last.post,
    cost: grossReturn - preTaxReturn,
    exposure: nSeg ? inMarketSeg / nSeg : 0,
    nRoundTrips,
    volAnnual,
    maxDD,
    sharpe,
  };
}

export interface ComparisonInput {
  prices: PricePoint[];
  legs: TradeSpec[]; // 曜日戦略のレグ(bestCombination or 手動)
  gapFill: PlanGapFill; // 戦略の隙間の埋め方(通常 "cash")
  taxModel: TaxModel;
  taxRate: number;
  costBps: number;
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
  const { prices, legs, gapFill, taxModel, taxRate, costBps } = input;
  // NISA / 現物BH は常時ロング(legs=[], gapFill="hold" → pos全区間+1)
  const nisa = simulate(prices, [], "hold", { taxModel, taxRate, costBps: 0, applyTax: false });
  const taxableBH = simulate(prices, [], "hold", { taxModel, taxRate, costBps: 0, applyTax: true });
  const strategy = simulate(prices, legs, gapFill, { taxModel, taxRate, costBps, applyTax: true });

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
  const { prices, legs, gapFill, taxModel, taxRate, costBps } = input;
  const points: RollingPoint[] = [];
  if (prices.length < window) {
    return { points, winRate: 0, medianEdge: 0, meanEdge: 0, p5: 0, p95: 0 };
  }
  for (let i = 0; i + window <= prices.length; i += step) {
    const slice = prices.slice(i, i + window);
    const nisa = simulate(slice, [], "hold", { taxModel, taxRate, costBps: 0, applyTax: false });
    const taxableBH = simulate(slice, [], "hold", { taxModel, taxRate, costBps: 0, applyTax: true });
    const strategy = simulate(slice, legs, gapFill, { taxModel, taxRate, costBps, applyTax: true });
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
