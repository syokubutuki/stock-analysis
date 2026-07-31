// 戦略 vs バイ&ホールド の共通比較層（trading-usability-improvements.md §5）
//
// 動機: 条件付き戦略系の各コンポーネントが、それぞれ独自に「B&Hとの超過リターン」を
// 計算・表示していた（原型は CustomReturnChart:478-493）。さらにコストは
// 「コスト未考慮」というガイド注記だけで、実数として効かせていなかった。
// ここに集約し、往復コストを実額で控除し、回転率（年間往復回数）を必ず併記する。
//
// コストの効かせ方（比例コストなので対数空間で厳密）:
//   富の推移は  W *= (1 + r) · (1 − c)   （c = 建玉額に比例する往復コスト）
//   両辺の対数をとると  log W += r_log + ln(1 − c)
// よって「1往復あたり ln(1−c) を対数リターンに加える」のが厳密な控除であり、
// 近似ではない。既存 overnight-intraday.ts の単利控除とは c² のオーダーで一致する。
//
// なぜ回転率を必ず出すか: コストの総額は「1往復あたりのコスト × 往復回数」で決まる。
// B&H は期間全体で1往復しかしないので、日次で建て直す戦略は同じエッジでも
// 252倍のコストを払う。この非対称性が超過リターンの主要な決定要因になることが多く、
// 回転率を隠したままの超過リターンは読めない。

import { PricePoint } from "./types";

// ───────────────────────── コスト・モデル ─────────────────────────

export interface CostModel {
  enabled: boolean;
  spreadRT: number; // 往復スプレッド（比率）。spread-estimator の representativeSpread の戻り値
  feeBps: number; // 片道手数料（bps）。往復で 2 倍かかる
}

export const ZERO_COST: CostModel = { enabled: false, spreadRT: 0, feeBps: 0 };

// 1往復（建てて畳む）あたりの控除率。
export function roundTripCost(c: CostModel): number {
  if (!c.enabled) return 0;
  const spread = Number.isFinite(c.spreadRT) && c.spreadRT > 0 ? c.spreadRT : 0;
  const fee = Number.isFinite(c.feeBps) && c.feeBps > 0 ? (c.feeBps / 10000) * 2 : 0;
  const total = spread + fee;
  // 1往復で資産の全部を失うようなコストは入力ミスなので上限を置く
  return Math.min(0.5, Math.max(0, total));
}

// ───────────────────────── パフォーマンス統計 ─────────────────────────

export interface PerfStats {
  n: number; // バー数
  years: number;
  totalReturn: number; // 累積対数リターン Σr
  annualReturn: number; // Σr / years
  annualVol: number; // σ_daily · √252
  sharpe: number;
  maxDD: number; // 累積対数リターン曲線の最大下落幅（正値）
  winRate: number;
}

function perfOf(daily: number[]): PerfStats {
  const n = daily.length;
  if (n === 0) {
    return { n: 0, years: 0, totalReturn: 0, annualReturn: 0, annualVol: 0, sharpe: 0, maxDD: 0, winRate: 0 };
  }
  let sum = 0;
  for (const v of daily) sum += v;
  const avg = sum / n;
  let sq = 0;
  for (const v of daily) sq += (v - avg) ** 2;
  const stdev = Math.sqrt(sq / n);

  // 最大ドローダウン（累積対数リターンのピークからの下落幅）
  let cum = 0, peak = 0, maxDD = 0;
  for (const v of daily) {
    cum += v;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }

  const years = n / 252;
  const annualReturn = years > 0 ? sum / years : 0;
  const annualVol = stdev * Math.sqrt(252);
  return {
    n,
    years,
    totalReturn: sum,
    annualReturn,
    annualVol,
    sharpe: annualVol > 0 ? annualReturn / annualVol : 0,
    maxDD,
    winRate: daily.filter((v) => v > 0).length / n,
  };
}

// ───────────────────────── 比較結果 ─────────────────────────

export interface StrategyComparison {
  strategy: PerfStats; // コスト控除後
  strategyGross: PerfStats; // コスト控除前
  buyHold: PerfStats; // B&H（1往復ぶんのコストのみ控除）
  excessTotal: number; // 戦略 − B&H（累積）
  excessAnnual: number;
  excessSharpe: number;
  costRT: number; // 1往復あたり控除率
  roundTrips: number; // 期間内の往復回数（戦略側）
  tripsPerYear: number; // 年間往復回数＝回転率
  costTotal: number; // 期間中に払った総コスト（対数リターン単位、正値）
  costAnnual: number;
  flipsSign: boolean; // コスト控除で超過リターンの符号が反転したか
}

function buildComparison(
  strategyDaily: number[],
  buyHoldDaily: number[],
  roundTrips: number,
  costRT: number
): StrategyComparison {
  const gross = perfOf(strategyDaily);
  // 比例コストの対数控除。1往復あたり ln(1−c) を、往復回数ぶん総額として配る。
  const perTrip = costRT > 0 ? -Math.log(1 - costRT) : 0; // 正値（払う側）
  const costTotal = perTrip * roundTrips;
  const perBar = gross.n > 0 ? costTotal / gross.n : 0;
  const net = perfOf(strategyDaily.map((r) => r - perBar));

  // B&H も現実には建てて畳むので1往復ぶんは払う（回転率の非対称性を誠実に出すため）
  const bhGross = perfOf(buyHoldDaily);
  const bhPerBar = bhGross.n > 0 ? perTrip / bhGross.n : 0;
  const bh = perfOf(buyHoldDaily.map((r) => r - bhPerBar));

  const excessTotal = net.totalReturn - bh.totalReturn;
  const grossExcess = gross.totalReturn - bhGross.totalReturn;

  return {
    strategy: net,
    strategyGross: gross,
    buyHold: bh,
    excessTotal,
    excessAnnual: net.annualReturn - bh.annualReturn,
    excessSharpe: net.sharpe - bh.sharpe,
    costRT,
    roundTrips,
    tripsPerYear: net.years > 0 ? roundTrips / net.years : 0,
    costTotal,
    costAnnual: net.years > 0 ? costTotal / net.years : 0,
    flipsSign: costRT > 0 && grossExcess > 0 && excessTotal <= 0,
  };
}

// 日次対数リターン列から比較する（最も一般的な入口）。
// roundTrips を渡せばそれを使う（マスク型戦略など、往復回数がバーごとに一定でない場合）。
// 渡さなければ roundTripsPerBar（既定1＝毎日建て直す）× バー数。
export function compareLogStrategy(p: {
  strategyDaily: number[];
  buyHoldDaily: number[];
  cost: CostModel;
  roundTripsPerBar?: number;
  roundTrips?: number;
}): StrategyComparison {
  const clean = p.strategyDaily.filter((v) => Number.isFinite(v));
  const bh = p.buyHoldDaily.filter((v) => Number.isFinite(v));
  const trips = p.roundTrips ?? clean.length * (p.roundTripsPerBar ?? 1);
  return buildComparison(clean, bh, trips, roundTripCost(p.cost));
}

// ───────────────────────── マスク型戦略のための小道具 ─────────────────────────

// 選択マスクから往復回数を数える。
//  mergeContiguous=true : 連続した選択日は「保有継続」とみなし、1つの連なりで1往復
//                         （例: シグナル後N日保有。日をまたいで持ち続ける戦略）
//  mergeContiguous=false: 選択された各バーが独立に建てて畳む＝1バー1往復
//                         （例: 夜間だけ保有・日中だけ保有のようなセグメント戦略）
export function countRoundTrips(mask: boolean[], mergeContiguous: boolean): number {
  if (!mergeContiguous) return mask.reduce((s, m) => s + (m ? 1 : 0), 0);
  let trips = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && (i === 0 || !mask[i - 1])) trips++;
  }
  return trips;
}

// 選択された日だけ建てる戦略の日次リターン列（非選択日は現金＝0）。
export function maskedDaily(daily: number[], mask: boolean[], side: 1 | -1 = 1): number[] {
  return daily.map((r, i) => (mask[i] && Number.isFinite(r) ? side * r : 0));
}

// 建玉ベクトルを選択マスクから作る（連続選択は保有継続）。
export function positionsFromMask(mask: boolean[], side: 1 | -1 = 1): number[] {
  return mask.map((m) => (m ? side : 0));
}

// シグナル発生インデックスから「発生日に建てて hold バー保有」する建玉ベクトルを作る。
// 重複シグナルは積み増さず保有期間の延長として扱う（ピラミッディングなし）。
export function positionsFromSignals(
  length: number,
  signalIdx: number[],
  hold: number,
  side: 1 | -1 = 1
): number[] {
  const q = new Array(length).fill(0);
  if (hold < 1) return q;
  for (const i of signalIdx) {
    if (!(i >= 0) || i >= length) continue;
    for (let k = i; k < Math.min(length, i + hold); k++) q[k] = side;
  }
  return q;
}

// 建玉ベクトル q_t から比較する（回転率を実測できるので、こちらが厳密）。
// q は各バーの保有比率（1=フル、0=現金、負=売り）。戦略リターンは q_{t-1}·r_t。
export function compareFromPositions(p: {
  prices: PricePoint[];
  positions: number[];
  cost: CostModel;
}): StrategyComparison {
  const { prices, positions } = p;
  const strat: number[] = [];
  const bh: number[] = [];
  let turnover = 0; // Σ|Δq|
  let prevQ = 0;

  for (let i = 1; i < prices.length && i < positions.length; i++) {
    const c0 = prices[i - 1].close;
    const c1 = prices[i].close;
    if (!(c0 > 0) || !(c1 > 0)) continue;
    const r = Math.log(c1 / c0);
    const q = Number.isFinite(positions[i - 1]) ? positions[i - 1] : 0;
    turnover += Math.abs(q - prevQ);
    prevQ = q;
    strat.push(q * r);
    bh.push(r);
  }
  turnover += Math.abs(prevQ); // 最終的に畳む

  // 1往復 = 建てて畳む = Σ|Δq| が 2 進む
  return buildComparison(strat, bh, turnover / 2, roundTripCost(p.cost));
}
