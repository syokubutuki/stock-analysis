// ② 当時の情報だけで実行できる、買いのみの売買検証。
//
// ## 売買の約束（変えるとテストが落ちる）
// - t 日の終値で条件を判定する（t 日の引け後に分かる）。
// - t+1 営業日の始値で買う。買った日を保有1日目とし、h 営業日目（t+h 日）の終値で売る。
//   h = 1 は「翌日の寄りで買って同じ日の引けで売る」。
// - 同一銘柄で建玉は1つ。保有中に出た新しいシグナル（t′ < 決済日）は無視して件数を数える。
//   決済日の引けに出たシグナルは、翌日の寄りで建ててよい。
// - 出来高0で4本値が同値の日（休場日の擬似行・売買なし）の寄りでは約定させない（見送り）。
//   予定の決済日がそういう日なら、次に約定できる日の終値へ延ばす（売れない日に売れたことにしない）。
// - 期間末に保有中なら「未決済」とし、最終日の終値の清算価値（売りの費用を控除）で評価する。
//   確定取引の統計には入れない。
//
// ## 費用
// 片道の比率 c = 手数料% + スリッページ%。買いでも売りでも資産に (1 − c) を掛ける。
// 1往復の対数控除は 2·ln(1 − c) で、近似ではない（strategy-vs-benchmark.ts と同じく対数空間で厳密）。
// 買い持ちも期首の買いと期末の清算で1往復分を払う（回転率の違いを誠実に出すため）。
//
// ## 価格
// /api/stock の価格は配当・分割の調整後（終値=調整後終値、始値・高値・安値も同じ倍率）。
// 配当は価格に再投資済みで含まれているので、**別途加算しない**（二重計上になる）。
// 配当額・権利落ち日は取得できないので、税引後の成績は計算しない（税引前・配当込み）。
// 待機資金の利息は 0%。

import type { PricePoint } from "./types";
import {
  type AnalysisRange, type MoveCondition, type PriceAudit, type Quantiles,
  calendarDays, indexSet, mulberry32, scanTriggers, summarize,
} from "./nday-move";

export interface CostModel {
  /** 片道の手数料（%） */
  commissionPct: number;
  /** 片道のスリッページ（%） */
  slippagePct: number;
}

export interface CapitalModel {
  initialCapital: number;
  /** 1回の建玉に回す比率（%）。100 = 全額 */
  allocationPct: number;
  /** 売買単位（株）。0 は端数株を許す */
  lotSize: number;
}

export interface TradeOptions {
  /** 保有日数 h（営業日） */
  holdDays: number;
  cost: CostModel;
  capital: CapitalModel;
}

export type SkipReason = "holding" | "entry-no-trade" | "no-next-bar" | "insufficient-capital" | "purged";

export interface SkippedSignal {
  index: number;
  date: string;
  reason: SkipReason;
}

export interface TradeRecord {
  id: number;
  signalIndex: number;
  signalDate: string;
  movePct: number;
  entryIndex: number;
  entryDate: string;
  /** 約定した始値（調整後価格） */
  entryPrice: number;
  exitIndex: number;
  exitDate: string;
  exitPrice: number;
  /** 予定の決済日 t+h（期間外なら期間末で打ち切る前の値） */
  scheduledExitIndex: number;
  status: "closed" | "open";
  /** 予定の決済日が約定できない日で、次の約定可能日へ延ばした */
  exitDelayed: boolean;
  /** 約定日（買いか売り）の4本値が同値（値幅制限の張り付きの疑い） */
  suspectFill: boolean;
  shares: number;
  /** 買いに出した現金・売りで戻った現金（open は清算価値） */
  cashOut: number;
  cashIn: number;
  /** exit/entry − 1（費用前） */
  grossReturn: number;
  /** (1 − c)²·exit/entry − 1 */
  netReturn: number;
  netLog: number;
  holdingBars: number;
  /** 保有中の終値ベースの最大含み損・含み益（費用前、entry 比） */
  maeClose: number;
  mfeClose: number;
}

export interface SimulationSignal {
  index: number;
  movePct: number;
  holdDays: number;
}

export interface SimulationInput {
  prices: PricePoint[];
  noTrade: Uint8Array;
  singlePrice: Uint8Array;
  signals: SimulationSignal[];
  /** 片道の費用比率 c */
  cost: number;
  capital: CapitalModel;
  /** 口座を開く日（この日の寄りから売買できる） */
  evalStart: number;
  end: number;
  /** true なら決済が end を越える取引を建てない（ウォークフォワードの訓練期間の境界パージ） */
  purgeBeyondEnd: boolean;
}

export interface SimulationOutput {
  trades: TradeRecord[];
  skipped: SkippedSignal[];
  /** evalStart … end の各終値での時価評価（清算費用は控除しない） */
  equity: number[];
  /** その日に建玉を持っていたか（寄りで買った日・引けで売った日を含む） */
  invested: boolean[];
  /** end の終値で全て清算した場合の資産（売りの費用を控除） */
  finalLiquidation: number;
}

export function oneWayCost(cost: CostModel): number {
  const c = (Math.max(0, cost.commissionPct || 0) + Math.max(0, cost.slippagePct || 0)) / 100;
  return Math.min(0.5, c);
}

function sharesFor(amount: number, price: number, c: number, lot: number): number {
  const raw = (amount * (1 - c)) / price;
  if (!(lot > 0)) return raw;
  return Math.floor(raw / lot) * lot;
}

/**
 * 1口座のシミュレーション。signals は index 昇順で、1日に高々1件。
 * 各シグナルは自分の保有日数を持つ（ウォークフォワードで規則が期ごとに替わるため）。
 */
export function simulateAccount(input: SimulationInput): SimulationOutput {
  const { prices, noTrade, singlePrice, signals, cost: c, capital, evalStart, end, purgeBeyondEnd } = input;
  const out: SimulationOutput = { trades: [], skipped: [], equity: [], invested: [], finalLiquidation: capital.initialCapital };
  let cash = capital.initialCapital;
  let shares = 0;
  let open: {
    signal: SimulationSignal; entryIndex: number; entryPrice: number; exitIndex: number; scheduledExitIndex: number;
    cashOut: number; exitDelayed: boolean; mae: number; mfe: number;
  } | null = null;
  let ptr = 0;
  const allocation = Math.min(100, Math.max(0, capital.allocationPct)) / 100;

  const nextTradable = (from: number): number | null => {
    for (let j = from; j <= end; j++) if (!noTrade[j]) return j;
    return null;
  };

  const closeTrade = (i: number, status: TradeRecord["status"]) => {
    if (!open) return;
    const exitPrice = prices[i].close;
    const cashIn = shares * exitPrice * (1 - c);
    const gross = exitPrice / open.entryPrice - 1;
    const netLog = Math.log(exitPrice / open.entryPrice) + 2 * Math.log(1 - c);
    out.trades.push({
      id: out.trades.length + 1,
      signalIndex: open.signal.index, signalDate: prices[open.signal.index].time, movePct: open.signal.movePct,
      entryIndex: open.entryIndex, entryDate: prices[open.entryIndex].time, entryPrice: open.entryPrice,
      exitIndex: i, exitDate: prices[i].time, exitPrice,
      scheduledExitIndex: open.scheduledExitIndex,
      status, exitDelayed: open.exitDelayed,
      suspectFill: !!singlePrice[open.entryIndex] || (status === "closed" && !!singlePrice[i]),
      shares, cashOut: open.cashOut, cashIn,
      grossReturn: gross, netReturn: Math.expm1(netLog), netLog,
      holdingBars: i - open.entryIndex + 1,
      maeClose: open.mae, mfeClose: open.mfe,
    });
    if (status === "closed") {
      cash += cashIn;
      shares = 0;
    }
    open = null;
  };

  for (let i = evalStart; i <= end; i++) {
    // 前日の引けのシグナルを、今日の寄りで執行する。
    while (ptr < signals.length && signals[ptr].index < i - 1) ptr++;
    if (ptr < signals.length && signals[ptr].index === i - 1) {
      const signal = signals[ptr++];
      const skip = (reason: SkipReason) => out.skipped.push({ index: signal.index, date: prices[signal.index].time, reason });
      const scheduledExit = signal.index + signal.holdDays;
      if (open) skip("holding");
      else if (noTrade[i]) skip("entry-no-trade");
      else if (purgeBeyondEnd && scheduledExit > end) skip("purged");
      else {
        const entryPrice = prices[i].open;
        const budget = cash * allocation;
        const qty = sharesFor(budget, entryPrice, c, capital.lotSize);
        if (!(qty > 0)) skip("insufficient-capital");
        else {
          const cashOut = (qty * entryPrice) / (1 - c);
          cash -= cashOut;
          shares = qty;
          open = {
            signal, entryIndex: i, entryPrice, exitIndex: scheduledExit, scheduledExitIndex: scheduledExit,
            cashOut, exitDelayed: false, mae: Infinity, mfe: -Infinity,
          };
        }
      }
    }
    const holdingToday = open !== null;
    if (open) {
      const rel = prices[i].close / open.entryPrice - 1;
      open.mae = Math.min(open.mae, rel);
      open.mfe = Math.max(open.mfe, rel);
      if (i === open.exitIndex) {
        if (noTrade[i]) {
          const next = nextTradable(i + 1);
          open.exitDelayed = true;
          open.exitIndex = next ?? Infinity;
        } else {
          closeTrade(i, "closed");
        }
      }
    }
    out.equity.push(cash + shares * prices[i].close);
    out.invested.push(holdingToday);
  }
  // 期間末のシグナル（翌営業日が無い）
  while (ptr < signals.length) {
    const signal = signals[ptr++];
    if (signal.index >= end) out.skipped.push({ index: signal.index, date: prices[signal.index].time, reason: "no-next-bar" });
  }
  if (open) {
    const liquidation = shares * prices[end].close * (1 - c);
    closeTrade(end, "open");
    out.finalLiquidation = cash + liquidation;
  } else {
    out.finalLiquidation = cash;
  }
  return out;
}

// ───────────────────────── 集計 ─────────────────────────

export interface EquityStats {
  initial: number;
  /** 期間末に全て清算した場合の資産 */
  finalValue: number;
  totalReturn: number;
  logGrowth: number;
  years: number;
  /** 幾何平均の年率（資産曲線から。取引平均×回数ではない） */
  cagr: number | null;
  annVol: number | null;
  sharpe: number | null;
  /** 時価評価の最大下落率（正の比率） */
  maxDrawdown: number;
  /** 建玉を持っていた日の割合 */
  timeInMarket: number;
}

export function equityStats(
  equity: number[], invested: boolean[], initial: number, finalValue: number, startDate: string, endDate: string,
): EquityStats {
  const years = (calendarDays(startDate, endDate) + 1) / 365.25;
  const rets: number[] = [];
  let prev = initial;
  let peak = initial;
  let maxDrawdown = 0;
  for (const value of equity) {
    rets.push(Math.log(value / prev));
    prev = value;
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, 1 - value / peak);
  }
  const n = rets.length;
  const mean = n > 0 ? rets.reduce((s, v) => s + v, 0) / n : 0;
  const variance = n > 1 ? rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const logGrowth = Math.log(finalValue / initial);
  return {
    initial, finalValue, totalReturn: finalValue / initial - 1, logGrowth, years,
    cagr: years > 0 ? Math.exp(logGrowth / years) - 1 : null,
    annVol: n > 1 ? sd * Math.sqrt(252) : null,
    sharpe: n > 1 && sd > 0 ? (mean / sd) * Math.sqrt(252) : null,
    maxDrawdown,
    timeInMarket: n > 0 ? invested.filter(Boolean).length / n : 0,
  };
}

export interface TradeStats {
  closed: number;
  open: number;
  meanNet: number | null;
  medianNet: number | null;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** 平均利益 / |平均損失| */
  payoff: number | null;
  bestNet: number | null;
  worstNet: number | null;
  sumNetLog: number;
  /** 確定取引を順に複利でつないだ倍率 − 1（待機期間を含まない） */
  compoundNet: number;
  meanGross: number | null;
  netQuantiles: Quantiles | null;
  meanHoldingBars: number | null;
}

export function tradeStats(trades: TradeRecord[]): TradeStats {
  const closed = trades.filter((t) => t.status === "closed");
  const net = closed.map((t) => t.netReturn);
  const wins = net.filter((v) => v > 0);
  const losses = net.filter((v) => v < 0);
  const avg = (xs: number[]) => (xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  const avgWin = avg(wins);
  const avgLoss = avg(losses);
  const q = summarize(net);
  const sumNetLog = closed.reduce((s, t) => s + t.netLog, 0);
  return {
    closed: closed.length,
    open: trades.length - closed.length,
    meanNet: avg(net),
    medianNet: q?.q50 ?? null,
    winRate: closed.length > 0 ? wins.length / closed.length : null,
    avgWin, avgLoss,
    payoff: avgWin !== null && avgLoss !== null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null,
    bestNet: q?.max ?? null,
    worstNet: q?.min ?? null,
    sumNetLog,
    compoundNet: Math.expm1(sumNetLog),
    meanGross: avg(closed.map((t) => t.grossReturn)),
    netQuantiles: q,
    meanHoldingBars: avg(closed.map((t) => t.holdingBars)),
  };
}

// ───────────────────────── 予測力（資金制約なし）と無条件 ─────────────────────────

export interface ForwardSample {
  index: number;
  date: string;
  netReturn: number;
  netLog: number;
}

/**
 * 起点 t ごとに「t+1 の寄りで買い t+h の引けで売る」1回分の損益（資金制約・建玉の重複を問わない）。
 * 予測力を見るための標本で、資金制約つきの戦略成績とは別物。
 */
export function forwardSamples(
  prices: PricePoint[], noTrade: Uint8Array, starts: number[], holdDays: number, c: number, end: number,
): ForwardSample[] {
  const out: ForwardSample[] = [];
  for (const t of starts) {
    const entry = t + 1;
    let exit = t + holdDays;
    if (entry > end || exit > end || noTrade[entry]) continue;
    while (exit <= end && noTrade[exit]) exit++;
    if (exit > end) continue;
    const netLog = Math.log(prices[exit].close / prices[entry].open) + 2 * Math.log(1 - c);
    out.push({ index: t, date: prices[t].time, netReturn: Math.expm1(netLog), netLog });
  }
  return out;
}

export interface SampleSummary {
  n: number;
  mean: number | null;
  median: number | null;
  winRate: number | null;
  sd: number | null;
}

function sampleSummary(samples: ForwardSample[]): SampleSummary {
  const xs = samples.map((s) => s.netReturn);
  const n = xs.length;
  if (n === 0) return { n, mean: null, median: null, winRate: null, sd: null };
  const mean = xs.reduce((s, v) => s + v, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : null;
  return { n, mean, median: summarize(xs)?.q50 ?? null, winRate: xs.filter((v) => v > 0).length / n, sd };
}

export interface PredictiveComparison {
  signal: SampleSummary;
  unconditional: SampleSummary;
  /** 平均の差（シグナル − 無条件、単純リターン） */
  diffMean: number | null;
  diffMedian: number | null;
  /** 移動ブロック・ブートストラップの95%区間（平均の差） */
  ci95: [number, number] | null;
  /** ブートストラップ標準誤差 */
  bootSe: number | null;
  /** 差を2標準誤差で見分けるのに要る件数の目安（独立を仮定した下限） */
  requiredN: number | null;
  blockLength: number;
  draws: number;
  seed: number;
}

/**
 * シグナル起点と無条件（全営業日起点）の平均の差を、営業日の並びを保った移動ブロックで再標本化する。
 * 保有期間の重なり（無条件側は h 日ずつ重なる）と相場局面の偏りを、ブロック内に残すため。
 * 独立標本を仮定した p 値は出さない。
 */
export function comparePredictive(
  signal: ForwardSample[], unconditional: ForwardSample[], from: number, to: number,
  holdDays: number, draws: number, seed: number,
): PredictiveComparison {
  const blockLength = Math.max(holdDays, 21);
  const s = sampleSummary(signal);
  const u = sampleSummary(unconditional);
  const result: PredictiveComparison = {
    signal: s, unconditional: u,
    diffMean: s.mean !== null && u.mean !== null ? s.mean - u.mean : null,
    diffMedian: s.median !== null && u.median !== null ? s.median - u.median : null,
    ci95: null, bootSe: null, requiredN: null, blockLength, draws, seed,
  };
  if (result.diffMean !== null && s.sd !== null && result.diffMean !== 0) {
    result.requiredN = Math.ceil((2 * s.sd / Math.abs(result.diffMean)) ** 2);
  }
  const len = to - from + 1;
  if (s.n < 5 || u.n < 20 || len < blockLength * 2) return result;
  const sigAt = new Float64Array(len).fill(NaN);
  const uncAt = new Float64Array(len).fill(NaN);
  for (const x of signal) if (x.index >= from && x.index <= to) sigAt[x.index - from] = x.netReturn;
  for (const x of unconditional) if (x.index >= from && x.index <= to) uncAt[x.index - from] = x.netReturn;
  const rand = mulberry32(seed);
  const blocks = Math.ceil(len / blockLength);
  const diffs: number[] = [];
  let guard = 0;
  while (diffs.length < draws && guard < draws * 5) {
    guard++;
    let ss = 0, sn = 0, us = 0, un = 0;
    for (let b = 0; b < blocks; b++) {
      const start = Math.floor(rand() * len);
      for (let j = 0; j < blockLength; j++) {
        const k = (start + j) % len;
        const sv = sigAt[k];
        const uv = uncAt[k];
        if (!Number.isNaN(sv)) { ss += sv; sn++; }
        if (!Number.isNaN(uv)) { us += uv; un++; }
      }
    }
    if (sn === 0 || un === 0) continue;
    diffs.push(ss / sn - us / un);
  }
  if (diffs.length < draws / 2) return result;
  diffs.sort((a, b) => a - b);
  const mean = diffs.reduce((acc, v) => acc + v, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (diffs.length - 1));
  const at = (q: number) => diffs[Math.min(diffs.length - 1, Math.max(0, Math.round(q * (diffs.length - 1))))];
  result.ci95 = [at(0.025), at(0.975)];
  result.bootSe = sd;
  return result;
}

// ───────────────────────── 無作為タイミング（プラセボ） ─────────────────────────

export interface PlaceboResult {
  draws: number;
  /** 置けた回（件数 K を配置できなかった回は数えない） */
  completed: number;
  trades: number;
  holdDays: number;
  /** 各回の Σ netLog（昇順） */
  totals: number[];
  actualTotal: number;
  /** 実際の成績を下回った回の割合（同値は半分） */
  percentile: number;
  seed: number;
}

/**
 * 同じ件数・同じ保有日数・重ならない規則で、建てる日だけを無作為にしたときの成績の分布。
 * 露出（市場にいた日数）を揃えた対照で、B&H との差のうち「市場にいた日数」の分を取り除いた後に
 * タイミングの価値が残るかを見る。配置は無作為な逐次配置（重なれば引き直す）で、厳密な一様ではない。
 */
export function placeboTiming(
  prices: PricePoint[], noTrade: Uint8Array, trades: number, holdDays: number, c: number,
  from: number, end: number, actualTotal: number, draws: number, seed: number,
): PlaceboResult | null {
  if (trades < 1) return null;
  const eligible: number[] = [];
  for (let e = from; e + holdDays - 1 <= end; e++) {
    if (!noTrade[e] && !noTrade[e + holdDays - 1]) eligible.push(e);
  }
  if (eligible.length < trades) return null;
  const netLogAt = new Map<number, number>();
  for (const e of eligible) {
    netLogAt.set(e, Math.log(prices[e + holdDays - 1].close / prices[e].open) + 2 * Math.log(1 - c));
  }
  const rand = mulberry32(seed);
  const occupied = new Uint8Array(end + 2);
  const totals: number[] = [];
  for (let d = 0; d < draws; d++) {
    occupied.fill(0);
    let placed = 0;
    let total = 0;
    let attempts = 0;
    while (placed < trades && attempts < trades * 200) {
      attempts++;
      const e = eligible[Math.floor(rand() * eligible.length)];
      let free = true;
      for (let j = e; j < e + holdDays; j++) if (occupied[j]) { free = false; break; }
      if (!free) continue;
      for (let j = e; j < e + holdDays; j++) occupied[j] = 1;
      total += netLogAt.get(e) as number;
      placed++;
    }
    if (placed === trades) totals.push(total);
  }
  if (totals.length === 0) return null;
  totals.sort((a, b) => a - b);
  let below = 0, ties = 0;
  for (const v of totals) {
    if (v < actualTotal - 1e-12) below++;
    else if (Math.abs(v - actualTotal) <= 1e-12) ties++;
  }
  return {
    draws, completed: totals.length, trades, holdDays, totals, actualTotal,
    percentile: (below + ties / 2) / totals.length, seed,
  };
}

// ───────────────────────── ②の入口 ─────────────────────────

export interface BreakEven {
  /** 取引1回の平均（確定取引・対数）が0になる片道費用（%）。費用前で既に負なら null */
  tradeOneWayPct: number | null;
  /** 買い持ちと資産が並ぶ片道費用（%）。全額・端数株のときだけ計算。費用ゼロでも下回るなら null */
  versusBuyHoldOneWayPct: number | null;
  /** 計算しなかった理由 */
  note: string | null;
}

export interface EquityPoint {
  index: number;
  date: string;
  strategy: number;
  buyHold: number;
  invested: boolean;
}

export interface TradeAnalysis {
  error: string | null;
  /** 条件を判定できる最初の日（期間内） */
  firstSignalIndex: number | null;
  evalStart: number;
  end: number;
  signals: number;
  trades: TradeRecord[];
  skipped: SkippedSignal[];
  equity: EquityPoint[];
  stats: TradeStats;
  strategy: EquityStats | null;
  buyHold: EquityStats | null;
  buyHoldEntryIndex: number | null;
  breakEven: BreakEven;
  predictive: PredictiveComparison | null;
  placebo: PlaceboResult | null;
  cost: number;
}

export interface TradeAnalysisExtras {
  bootstrapDraws: number;
  placeboDraws: number;
  seed: number;
}

export const DEFAULT_TRADE_EXTRAS: TradeAnalysisExtras = { bootstrapDraws: 1000, placeboDraws: 1000, seed: 20260930 };

export function validateTradeOptions(options: TradeOptions): string | null {
  if (!Number.isInteger(options.holdDays) || options.holdDays < 1 || options.holdDays > 252) {
    return "保有日数 h は 1〜252 の整数で指定してください。";
  }
  const { commissionPct, slippagePct } = options.cost;
  if (!Number.isFinite(commissionPct) || commissionPct < 0 || !Number.isFinite(slippagePct) || slippagePct < 0
    || commissionPct + slippagePct >= 50) {
    return "手数料とスリッページは 0 以上（片道の合計が 50% 未満）で指定してください。";
  }
  const { initialCapital, allocationPct, lotSize } = options.capital;
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) return "初期資金は正の値で指定してください。";
  if (!Number.isFinite(allocationPct) || allocationPct <= 0 || allocationPct > 100) return "投入比率は 0 より大きく 100 以下（%）で指定してください。";
  if (!Number.isInteger(lotSize) || lotSize < 0) return "売買単位は 0（端数株）か正の整数で指定してください。";
  return null;
}

/** 買い持ち: 口座を開いた日以降で最初に約定できる日の寄りで全額を買い、期末に清算する。 */
export function simulateBuyHold(
  prices: PricePoint[], noTrade: Uint8Array, c: number, capital: CapitalModel, evalStart: number, end: number,
): { equity: number[]; entryIndex: number | null; finalLiquidation: number } {
  const equity: number[] = [];
  let entryIndex: number | null = null;
  let cash = capital.initialCapital;
  let shares = 0;
  for (let i = evalStart; i <= end; i++) {
    if (entryIndex === null && !noTrade[i]) {
      const qty = sharesFor(cash, prices[i].open, c, capital.lotSize);
      if (qty > 0) {
        cash -= (qty * prices[i].open) / (1 - c);
        shares = qty;
        entryIndex = i;
      }
    }
    equity.push(cash + shares * prices[i].close);
  }
  return { equity, entryIndex, finalLiquidation: cash + shares * prices[end].close * (1 - c) };
}

export function computeTrades(
  prices: PricePoint[],
  audit: PriceAudit,
  condition: MoveCondition,
  range: AnalysisRange,
  options: TradeOptions,
  extras: TradeAnalysisExtras = DEFAULT_TRADE_EXTRAS,
): TradeAnalysis {
  const c = oneWayCost(options.cost);
  const empty: TradeAnalysis = {
    error: null, firstSignalIndex: null, evalStart: range.start, end: range.end, signals: 0,
    trades: [], skipped: [], equity: [], stats: tradeStats([]), strategy: null, buyHold: null, buyHoldEntryIndex: null,
    breakEven: { tradeOneWayPct: null, versusBuyHoldOneWayPct: null, note: null },
    predictive: null, placebo: null, cost: c,
  };
  if (audit.error) return { ...empty, error: audit.error };
  if (audit.closeOnly) {
    return { ...empty, error: "この系列は終値しか配信されていない（投信の基準価額など）ため、始値で約定する売買検証はできません。①の分布は終値だけで計算できます。" };
  }
  const optionError = validateTradeOptions(options);
  if (optionError) return { ...empty, error: optionError };

  const scan = scanTriggers(prices, condition, range);
  if (scan.firstSignalIndex === null || scan.firstSignalIndex >= range.end) {
    return { ...empty, error: "分析期間が短すぎて、条件を判定して翌日に約定できる日がありません。期間を長くしてください。" };
  }
  const noTrade = indexSet(audit.noTradeBars, prices.length);
  const singlePrice = indexSet(audit.singlePriceBars, prices.length);
  const evalStart = scan.firstSignalIndex + 1;
  const signals: SimulationSignal[] = scan.triggers.map((t) => ({ index: t.index, movePct: t.movePct, holdDays: options.holdDays }));
  const sim = simulateAccount({
    prices, noTrade, singlePrice, signals, cost: c, capital: options.capital, evalStart, end: range.end, purgeBeyondEnd: false,
  });
  const bh = simulateBuyHold(prices, noTrade, c, options.capital, evalStart, range.end);
  const startDate = prices[evalStart].time;
  const endDate = prices[range.end].time;
  const equity: EquityPoint[] = sim.equity.map((value, k) => ({
    index: evalStart + k, date: prices[evalStart + k].time, strategy: value, buyHold: bh.equity[k], invested: sim.invested[k],
  }));
  const stats = tradeStats(sim.trades);

  // 損益分岐の片道費用
  const breakEven: BreakEven = { tradeOneWayPct: null, versusBuyHoldOneWayPct: null, note: null };
  const closed = sim.trades.filter((t) => t.status === "closed");
  if (closed.length > 0) {
    const meanGrossLog = closed.reduce((s, t) => s + Math.log(t.exitPrice / t.entryPrice), 0) / closed.length;
    if (meanGrossLog > 0) breakEven.tradeOneWayPct = 100 * (1 - Math.exp(-meanGrossLog / 2));
  }
  if (options.capital.allocationPct === 100 && options.capital.lotSize === 0 && bh.entryIndex !== null && sim.trades.length > 1) {
    const sumG = sim.trades.reduce((s, t) => s + Math.log(t.exitPrice / t.entryPrice), 0);
    const gBh = Math.log(prices[range.end].close / prices[bh.entryIndex].open);
    const k = sim.trades.length;
    if (sumG > gBh) breakEven.versusBuyHoldOneWayPct = 100 * (1 - Math.exp((gBh - sumG) / (2 * (k - 1))));
  } else if (options.capital.allocationPct !== 100 || options.capital.lotSize !== 0) {
    breakEven.note = "買い持ちとの損益分岐は、全額投入・端数株の設定でのみ計算します。";
  }

  // 予測力: 全シグナル（保有中を問わない）と無条件（全営業日）
  const from = scan.firstSignalIndex;
  const signalSamples = forwardSamples(prices, noTrade, scan.triggers.map((t) => t.index), options.holdDays, c, range.end);
  const allStarts: number[] = [];
  for (let t = from; t <= range.end; t++) allStarts.push(t);
  const unconditional = forwardSamples(prices, noTrade, allStarts, options.holdDays, c, range.end);
  const predictive = comparePredictive(signalSamples, unconditional, from, range.end - options.holdDays,
    options.holdDays, extras.bootstrapDraws, extras.seed);

  const placebo = placeboTiming(prices, noTrade, stats.closed, options.holdDays, c, evalStart, range.end,
    stats.sumNetLog, extras.placeboDraws, extras.seed + 1);

  return {
    error: null,
    firstSignalIndex: scan.firstSignalIndex,
    evalStart, end: range.end,
    signals: scan.triggers.length,
    trades: sim.trades, skipped: sim.skipped, equity, stats,
    strategy: equityStats(sim.equity, sim.invested, options.capital.initialCapital, sim.finalLiquidation, startDate, endDate),
    buyHold: equityStats(bh.equity, bh.equity.map((_, k) => bh.entryIndex !== null && evalStart + k >= bh.entryIndex),
      options.capital.initialCapital, bh.finalLiquidation, startDate, endDate),
    buyHoldEntryIndex: bh.entryIndex,
    breakEven, predictive, placebo, cost: c,
  };
}
