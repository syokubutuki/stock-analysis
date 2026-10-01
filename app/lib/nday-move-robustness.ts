// ③ 頑健性と過剰適合の点検。「一番よかった組み合わせ」だけを出さないための計算。
//
// 1. 候補格子（方向 × n × p × h）の全件を、同じ期間・同じ費用・同じ資金規則で評価して台帳に残す。
//    共通の評価期間は「最大の n でも判定できる最初の日」の翌日から。候補ごとに開始日がずれると、
//    成績の差に期間の差が混ざる（CSCV の前提「行列の行が同じ日付」も崩れる）。
// 2. 年代順のウォークフォワード（暦年単位・拡大窓）。
//    - 訓練: 評価開始〜前年末。決済が訓練末を越える取引は建てない（境界のパージ）。
//      訓練の成績はその期間の価格だけで決まり、検証期間の値動きも損益も入らない。
//    - 選択: 訓練で最低取引件数を満たす候補のうち、日次シャープ（待機日0・費用込み）が最大のもの。
//      正の候補が無ければ「取引しない（現金）」。同点は格子の並びで先の候補。
//    - 検証: 選んだ規則を翌1年に固定して適用する。前年末の引けのシグナルから新しい規則が効く。
//      期をまたいで保有中の建玉は、建てた期の規則のまま満期まで持つ（同一銘柄で建玉は1つ）。
//    - 検証期間をつないだ1本の口座の資産曲線は、当時の情報だけで実行できる。
//    ただし候補格子・既定値は全期間を見た設計者が決めているので「擬似」アウトオブサンプルと呼ぶ。
// 3. CSCV による PBO（cscv-pbo.ts）。前提を満たさなければ計算せず理由を返す。
// 4. 現在の規則の利益の集中（年・上位の取引）と、格子上の近傍。

import type { PricePoint } from "./types";
import {
  type AnalysisRange, type MoveCondition, type MoveDirection, type PriceAudit, type ThresholdUnit, type TriggerMode,
  firstComputableIndex, indexSet, scanTriggers,
} from "./nday-move";
import {
  type CapitalModel, type CostModel, type EquityStats, type SimulationSignal, type TradeRecord,
  equityStats, oneWayCost, simulateAccount, simulateBuyHold, tradeStats,
} from "./nday-move-trades";
import { cscvPbo, type CscvResult } from "./cscv-pbo";

export interface GridSpec {
  directions: MoveDirection[];
  lookbacks: number[];
  thresholds: number[];
  holds: number[];
}

export const DEFAULT_GRID_PCT: GridSpec = { directions: ["down", "up"], lookbacks: [3, 5, 10, 20], thresholds: [3, 5, 7, 10], holds: [3, 5, 10] };
export const DEFAULT_GRID_SIGMA: GridSpec = { directions: ["down", "up"], lookbacks: [3, 5, 10, 20], thresholds: [1, 1.5, 2, 2.5], holds: [3, 5, 10] };

export interface RobustnessConfig {
  grid: GridSpec;
  unit: ThresholdUnit;
  trigger: TriggerMode;
  cost: CostModel;
  capital: CapitalModel;
  walkForward: { minTrainYears: number; minTrades: number };
  cscv: { S: number; minTradesMedian: number; minDistinct: number; minBlockBars: number };
}

export const DEFAULT_WF = { minTrainYears: 3, minTrades: 10 };
export const DEFAULT_CSCV = { S: 16, minTradesMedian: 20, minDistinct: 10, minBlockBars: 20 };

export interface CandidateSpec {
  key: string;
  direction: MoveDirection;
  lookback: number;
  threshold: number;
  hold: number;
}

export interface CandidateMetrics extends CandidateSpec {
  signals: number;
  trades: number;
  meanNet: number | null;
  medianNet: number | null;
  winRate: number | null;
  sumNetLog: number;
  logGrowth: number;
  cagr: number | null;
  sharpe: number | null;
  maxDrawdown: number;
  exposure: number;
}

export interface WalkForwardFold {
  year: number;
  trainStartDate: string;
  trainEndDate: string;
  testStartDate: string;
  testEndDate: string;
  /** null は「取引しない（現金）」 */
  selected: CandidateSpec | null;
  /** 最低取引件数を満たした候補の数 */
  eligible: number;
  trainTrades: number | null;
  trainSharpe: number | null;
  trainLogGrowth: number | null;
  /** この期に建てた取引の数 */
  testTrades: number;
  /** この期の口座の対数成長（時価評価。前期から持ち越した建玉の損益を含む） */
  testLogGrowth: number;
  buyHoldLogGrowth: number;
}

export interface WalkForwardResult {
  status: "ok" | "insufficient";
  reason: string | null;
  folds: WalkForwardFold[];
  equity: { date: string; strategy: number; buyHold: number }[];
  trades: TradeRecord[];
  strategy: EquityStats | null;
  buyHold: EquityStats | null;
  cashFolds: number;
}

export interface CscvStatus {
  ok: boolean;
  reasons: string[];
  S: number;
}

export interface RobustnessResult {
  error: string | null;
  evalStart: number;
  end: number;
  evalStartDate: string;
  endDate: string;
  candidates: CandidateMetrics[];
  /** 共通の評価期間での買い持ち（候補と同じ日・同じ初期資金） */
  buyHold: EquityStats | null;
  walkForward: WalkForwardResult;
  cscv: CscvResult | null;
  cscvStatus: CscvStatus;
}

export type RobustnessProgress = (stage: "candidates" | "walk-forward" | "cscv", done: number, total: number) => void;

export function candidateKey(c: { direction: MoveDirection; lookback: number; threshold: number; hold: number }): string {
  return `${c.direction}|n${c.lookback}|p${c.threshold}|h${c.hold}`;
}

export function expandGrid(grid: GridSpec): CandidateSpec[] {
  const out: CandidateSpec[] = [];
  const seen = new Set<string>();
  const ints = (xs: number[]) => xs.filter((x) => Number.isInteger(x) && x >= 1 && x <= 252);
  for (const direction of grid.directions) {
    for (const lookback of ints(grid.lookbacks)) {
      for (const threshold of grid.thresholds.filter((x) => Number.isFinite(x) && x > 0)) {
        for (const hold of ints(grid.holds)) {
          const spec = { direction, lookback, threshold, hold };
          const key = candidateKey(spec);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ key, ...spec });
        }
      }
    }
  }
  return out;
}

/** 数値の並びの入力（"3, 5, 10"）を読む。 */
export function parseNumberList(text: string): number[] {
  return text.split(/[,\s、，]+/).map((s) => s.trim()).filter(Boolean).map(Number).filter((v) => Number.isFinite(v));
}

function dailyLogReturns(equity: number[], initial: number): Float64Array {
  const out = new Float64Array(equity.length);
  let prev = initial;
  for (let i = 0; i < equity.length; i++) {
    out[i] = Math.log(equity[i] / prev);
    prev = equity[i];
  }
  return out;
}

interface SimContext {
  prices: PricePoint[];
  noTrade: Uint8Array;
  singlePrice: Uint8Array;
  cost: number;
  capital: CapitalModel;
}

function conditionOf(spec: CandidateSpec, config: RobustnessConfig): MoveCondition {
  return { direction: spec.direction, lookback: spec.lookback, threshold: spec.threshold, unit: config.unit, trigger: config.trigger };
}

export function runRobustness(
  prices: PricePoint[],
  audit: PriceAudit,
  range: AnalysisRange,
  config: RobustnessConfig,
  onProgress?: RobustnessProgress,
): RobustnessResult {
  const specs = expandGrid(config.grid);
  const emptyWf: WalkForwardResult = { status: "insufficient", reason: null, folds: [], equity: [], trades: [], strategy: null, buyHold: null, cashFolds: 0 };
  const result: RobustnessResult = {
    error: null, evalStart: range.start, end: range.end, evalStartDate: "", endDate: "",
    candidates: [], buyHold: null, walkForward: emptyWf, cscv: null, cscvStatus: { ok: false, reasons: [], S: config.cscv.S },
  };
  if (audit.error) return { ...result, error: audit.error };
  if (audit.closeOnly) return { ...result, error: "終値しか配信されていない系列では、始値で約定する売買検証はできません。" };
  if (specs.length === 0) return { ...result, error: "候補格子が空です。方向・n・p・h をそれぞれ1つ以上指定してください。" };
  if (specs.length > 400) return { ...result, error: `候補が${specs.length}通りあります。400通り以下に絞ってください。` };

  const commonFirst = Math.max(range.start, ...specs.map((s) => firstComputableIndex(conditionOf(s, config))));
  if (commonFirst + 2 > range.end) {
    return { ...result, error: "分析期間が短すぎて、最大の n でも判定と約定ができる日がありません。" };
  }
  const evalStart = commonFirst + 1;
  const end = range.end;
  result.evalStart = evalStart;
  result.evalStartDate = prices[evalStart].time;
  result.endDate = prices[end].time;
  const ctx: SimContext = {
    prices,
    noTrade: indexSet(audit.noTradeBars, prices.length),
    singlePrice: indexSet(audit.singlePriceBars, prices.length),
    cost: oneWayCost(config.cost),
    capital: config.capital,
  };

  // 条件（方向・n・p）ごとのシグナルを共有する（h に依存しない）。
  const triggerCache = new Map<string, { index: number; movePct: number }[]>();
  const triggersFor = (spec: CandidateSpec) => {
    const key = `${spec.direction}|${spec.lookback}|${spec.threshold}`;
    let cached = triggerCache.get(key);
    if (!cached) {
      cached = scanTriggers(prices, conditionOf(spec, config), { start: commonFirst, end }).triggers
        .map((t) => ({ index: t.index, movePct: t.movePct }));
      triggerCache.set(key, cached);
    }
    return cached;
  };
  const signalsFor = (spec: CandidateSpec, from: number, to: number): SimulationSignal[] =>
    triggersFor(spec).filter((t) => t.index >= from && t.index <= to).map((t) => ({ ...t, holdDays: spec.hold }));

  // 1. 候補格子
  const columns: Float64Array[] = [];
  specs.forEach((spec, k) => {
    const sim = simulateAccount({
      ...ctx, signals: signalsFor(spec, commonFirst, end), evalStart, end, purgeBeyondEnd: false,
    });
    const stats = tradeStats(sim.trades);
    const eq = equityStats(sim.equity, sim.invested, ctx.capital.initialCapital, sim.finalLiquidation, prices[evalStart].time, prices[end].time);
    columns.push(dailyLogReturns(sim.equity, ctx.capital.initialCapital));
    result.candidates.push({
      ...spec,
      signals: triggersFor(spec).length,
      trades: stats.closed,
      meanNet: stats.meanNet, medianNet: stats.medianNet, winRate: stats.winRate, sumNetLog: stats.sumNetLog,
      logGrowth: eq.logGrowth, cagr: eq.cagr, sharpe: eq.sharpe, maxDrawdown: eq.maxDrawdown, exposure: eq.timeInMarket,
    });
    onProgress?.("candidates", k + 1, specs.length);
  });
  const bh = simulateBuyHold(prices, ctx.noTrade, ctx.cost, ctx.capital, evalStart, end);
  result.buyHold = equityStats(bh.equity, bh.equity.map((_, k) => bh.entryIndex !== null && evalStart + k >= bh.entryIndex),
    ctx.capital.initialCapital, bh.finalLiquidation, prices[evalStart].time, prices[end].time);

  // 2. ウォークフォワード
  result.walkForward = walkForward(ctx, specs, signalsFor, evalStart, end, config, onProgress);

  // 3. CSCV
  const T = end - evalStart + 1;
  const reasons: string[] = [];
  let S = config.cscv.S;
  while (S > 2 && Math.floor(T / S) < config.cscv.minBlockBars) S -= 2;
  if (S < 8) reasons.push(`評価期間が${T}営業日しかなく、1塊${config.cscv.minBlockBars}営業日以上で8分割以上できません（分割が粗すぎると組合せが70通り未満になる）。`);
  if (specs.length < 2) reasons.push("候補が2つ未満です。");
  const tradeCounts = result.candidates.map((c) => c.trades).sort((a, b) => a - b);
  const medianTrades = tradeCounts.length > 0 ? tradeCounts[Math.floor((tradeCounts.length - 1) / 2)] : 0;
  if (medianTrades < config.cscv.minTradesMedian) {
    reasons.push(`候補の取引件数の中央値が${medianTrades}件で、${config.cscv.minTradesMedian}件に届きません（半分の期間あたり約${Math.floor(medianTrades / 2)}件では各候補の成績を推定できない）。`);
  }
  if (reasons.length === 0) {
    const distinct = new Set(columns.map((c) => Array.from(c, (v) => v.toFixed(12)).join(","))).size;
    if (distinct < config.cscv.minDistinct) {
      reasons.push(`中身の異なる候補が${distinct}通りしかありません（${config.cscv.minDistinct}通り以上必要。順位の刻みが粗く PBO が不連続になる）。`);
    }
  }
  result.cscvStatus = { ok: reasons.length === 0, reasons, S };
  if (reasons.length === 0) {
    result.cscv = cscvPbo(columns, S, Math.sqrt(252), (done, total) => onProgress?.("cscv", done, total));
  }
  return result;
}

function walkForward(
  ctx: SimContext,
  specs: CandidateSpec[],
  signalsFor: (spec: CandidateSpec, from: number, to: number) => SimulationSignal[],
  evalStart: number,
  end: number,
  config: RobustnessConfig,
  onProgress?: RobustnessProgress,
): WalkForwardResult {
  const { prices } = ctx;
  const out: WalkForwardResult = { status: "insufficient", reason: null, folds: [], equity: [], trades: [], strategy: null, buyHold: null, cashFolds: 0 };
  // 暦年ごとの最初と最後の添字
  const years: { year: number; first: number; last: number }[] = [];
  for (let i = evalStart; i <= end; i++) {
    const year = Number(prices[i].time.slice(0, 4));
    const current = years[years.length - 1];
    if (!current || current.year !== year) years.push({ year, first: i, last: i });
    else current.last = i;
  }
  const trainStartDate = prices[evalStart].time;
  const folds = years.filter((y) => {
    const trainEnd = y.first - 1;
    if (trainEnd < evalStart) return false;
    const trainYears = (Date.parse(`${prices[trainEnd].time}T00:00:00Z`) - Date.parse(`${trainStartDate}T00:00:00Z`)) / (365.25 * 86_400_000);
    return trainYears >= config.walkForward.minTrainYears - 0.05;
  });
  if (folds.length === 0) {
    out.reason = `訓練に${config.walkForward.minTrainYears}年以上を取ると、検証に回せる年が残りません（評価期間 ${trainStartDate}〜${prices[end].time}）。`;
    return out;
  }

  const selections: { fold: typeof folds[number]; spec: CandidateSpec | null; eligible: number; trainTrades: number | null; trainSharpe: number | null; trainLogGrowth: number | null }[] = [];
  folds.forEach((fold, k) => {
    const trainEnd = fold.first - 1;
    let best: { spec: CandidateSpec; sharpe: number; trades: number; logGrowth: number } | null = null;
    let eligible = 0;
    for (const spec of specs) {
      // 訓練期間の価格だけで判定・売買する。決済が訓練末を越える取引は建てない。
      const sim = simulateAccount({
        ...ctx, signals: signalsFor(spec, evalStart - 1, trainEnd), evalStart, end: trainEnd, purgeBeyondEnd: true,
      });
      const stats = tradeStats(sim.trades);
      if (stats.closed < config.walkForward.minTrades) continue;
      eligible++;
      const eq = equityStats(sim.equity, sim.invested, ctx.capital.initialCapital, sim.finalLiquidation, prices[evalStart].time, prices[trainEnd].time);
      if (eq.sharpe === null) continue;
      if (!best || eq.sharpe > best.sharpe) best = { spec, sharpe: eq.sharpe, trades: stats.closed, logGrowth: eq.logGrowth };
    }
    const chosen = best && best.sharpe > 0 ? best : null;
    selections.push({
      fold, spec: chosen?.spec ?? null, eligible,
      trainTrades: chosen?.trades ?? null, trainSharpe: chosen?.sharpe ?? null, trainLogGrowth: chosen?.logGrowth ?? null,
    });
    onProgress?.("walk-forward", k + 1, folds.length);
  });

  // 検証期間をつないだ1本の口座。期 k の規則は、前期末の引け〜当期最終日の前日の引けのシグナルに効く。
  const testStart = folds[0].first;
  const signals: SimulationSignal[] = [];
  for (const s of selections) {
    if (!s.spec) continue;
    const from = s.fold.first - 1;
    const to = s.fold.last === end ? end : s.fold.last - 1;
    signals.push(...signalsFor(s.spec, from, to));
  }
  signals.sort((a, b) => a.index - b.index);
  const sim = simulateAccount({ ...ctx, signals, evalStart: testStart, end, purgeBeyondEnd: false });
  const bh = simulateBuyHold(prices, ctx.noTrade, ctx.cost, ctx.capital, testStart, end);
  const eqAt = (series: number[], index: number) => (index < testStart ? ctx.capital.initialCapital : series[index - testStart]);
  out.folds = selections.map((s) => ({
    year: s.fold.year,
    trainStartDate,
    trainEndDate: prices[s.fold.first - 1].time,
    testStartDate: prices[s.fold.first].time,
    testEndDate: prices[s.fold.last].time,
    selected: s.spec,
    eligible: s.eligible,
    trainTrades: s.trainTrades,
    trainSharpe: s.trainSharpe,
    trainLogGrowth: s.trainLogGrowth,
    testTrades: sim.trades.filter((t) => t.entryIndex >= s.fold.first && t.entryIndex <= s.fold.last).length,
    testLogGrowth: Math.log(eqAt(sim.equity, s.fold.last) / eqAt(sim.equity, s.fold.first - 1)),
    buyHoldLogGrowth: Math.log(eqAt(bh.equity, s.fold.last) / eqAt(bh.equity, s.fold.first - 1)),
  }));
  out.cashFolds = selections.filter((s) => !s.spec).length;
  out.equity = sim.equity.map((value, k) => ({ date: prices[testStart + k].time, strategy: value, buyHold: bh.equity[k] }));
  out.trades = sim.trades;
  out.strategy = equityStats(sim.equity, sim.invested, ctx.capital.initialCapital, sim.finalLiquidation, prices[testStart].time, prices[end].time);
  out.buyHold = equityStats(bh.equity, bh.equity.map((_, k) => bh.entryIndex !== null && testStart + k >= bh.entryIndex),
    ctx.capital.initialCapital, bh.finalLiquidation, prices[testStart].time, prices[end].time);
  out.status = "ok";
  return out;
}

// ───────────────────────── 集中・近傍・水増しの目安 ─────────────────────────

export interface ConcentrationResult {
  trades: number;
  totalLog: number;
  byYear: { year: number; trades: number; sumLog: number }[];
  /** 上位 k 件（対数リターンの大きい順）を除いたときの Σ対数 */
  withoutTop: { k: number; totalLog: number }[];
  /** 上位10%の取引が、利益（正の対数リターンの合計）に占める割合 */
  top10ShareOfGains: number | null;
  /** 1年ずつ除いたときの Σ対数の最小・最大 */
  leaveOneYearOut: { min: number; max: number; minYear: number; maxYear: number } | null;
}

export function concentration(trades: TradeRecord[]): ConcentrationResult {
  const closed = trades.filter((t) => t.status === "closed");
  const totalLog = closed.reduce((s, t) => s + t.netLog, 0);
  const byYearMap = new Map<number, { trades: number; sumLog: number }>();
  for (const t of closed) {
    const year = Number(t.entryDate.slice(0, 4));
    const e = byYearMap.get(year) ?? { trades: 0, sumLog: 0 };
    e.trades++;
    e.sumLog += t.netLog;
    byYearMap.set(year, e);
  }
  const byYear = [...byYearMap.entries()].sort((a, b) => a[0] - b[0]).map(([year, v]) => ({ year, ...v }));
  const sorted = closed.map((t) => t.netLog).sort((a, b) => b - a);
  const withoutTop = [1, 3, 5].filter((k) => k < sorted.length).map((k) => ({
    k, totalLog: totalLog - sorted.slice(0, k).reduce((s, v) => s + v, 0),
  }));
  const gains = sorted.filter((v) => v > 0);
  const gainSum = gains.reduce((s, v) => s + v, 0);
  const topCount = Math.max(1, Math.ceil(closed.length * 0.1));
  const top10ShareOfGains = gainSum > 0 ? sorted.slice(0, topCount).filter((v) => v > 0).reduce((s, v) => s + v, 0) / gainSum : null;
  let leaveOneYearOut: ConcentrationResult["leaveOneYearOut"] = null;
  if (byYear.length >= 2) {
    const values = byYear.map((y) => ({ year: y.year, total: totalLog - y.sumLog }));
    const min = values.reduce((a, b) => (b.total < a.total ? b : a));
    const max = values.reduce((a, b) => (b.total > a.total ? b : a));
    leaveOneYearOut = { min: min.total, max: max.total, minYear: min.year, maxYear: max.year };
  }
  return { trades: closed.length, totalLog, byYear, withoutTop, top10ShareOfGains, leaveOneYearOut };
}

export interface NeighborResult {
  center: CandidateMetrics;
  neighbors: CandidateMetrics[];
  neighborSharpeMedian: number | null;
}

/** 格子上で n・p・h のどれか1つだけを1段ずらした候補（同じ方向）。 */
export function neighborsOf(
  candidates: CandidateMetrics[], grid: GridSpec,
  current: { direction: MoveDirection; lookback: number; threshold: number; hold: number },
): NeighborResult | null {
  const center = candidates.find((c) => c.key === candidateKey(current));
  if (!center) return null;
  const axes: { values: number[]; get: (c: CandidateSpec) => number }[] = [
    { values: [...new Set(grid.lookbacks)].sort((a, b) => a - b), get: (c) => c.lookback },
    { values: [...new Set(grid.thresholds)].sort((a, b) => a - b), get: (c) => c.threshold },
    { values: [...new Set(grid.holds)].sort((a, b) => a - b), get: (c) => c.hold },
  ];
  const neighbors = candidates.filter((c) => {
    if (c.direction !== center.direction || c.key === center.key) return false;
    let moved = 0;
    for (const axis of axes) {
      const a = axis.values.indexOf(axis.get(c));
      const b = axis.values.indexOf(axis.get(center));
      if (a !== b) {
        if (Math.abs(a - b) !== 1) return false;
        moved++;
      }
    }
    return moved === 1;
  });
  const sharpes = neighbors.map((n) => n.sharpe).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const neighborSharpeMedian = sharpes.length > 0
    ? (sharpes[Math.floor((sharpes.length - 1) / 2)] + sharpes[Math.ceil((sharpes.length - 1) / 2)]) / 2 : null;
  return { center, neighbors, neighborSharpeMedian };
}

/**
 * N 通りから最良を選んだときに、取引平均が偶然だけで押し上げられる量の目安（系C26）。
 * E[max] − 平均 ≈ SE·√(2 ln N)、SE = 取引1回の標準偏差 / √件数。
 */
export function selectionInflation(sdPerTrade: number, trades: number, candidates: number): number | null {
  if (!(sdPerTrade > 0) || trades < 2 || candidates < 2) return null;
  return (sdPerTrade / Math.sqrt(trades)) * Math.sqrt(2 * Math.log(candidates));
}
