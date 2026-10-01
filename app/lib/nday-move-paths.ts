// ① 条件成立後の分布（後から分かった値動きの記述。売買の成績ではない）。
//
// 各イベント t（条件成立日＝0日目）について、終値ベースで次を測る。
// - 経路: pathPct[k] = 100(C[t+k]/C[t] − 1), k = 0 … A（A = min(H, end − t)）
// - 観測窓内の最低・最高終値までの日数と変化率。**0日目も候補に含め、同値なら最初の日**。
//   H日目の極値は「窓の端」であって反転の確認ではない。窓を伸ばせば更新されうる。
// - 初めて前日終値を下回るまでの日数（C[t+k] < C[t+k−1] となる最初の k ≥ 1）
// - 条件成立後の最高終値から q% 下落するまでの日数（走行最高値は0日目を含む）
//   この2つは期間内に起きない事例があるので、Kaplan–Meier（survival.ts）で扱う。
// - 翌朝の窓 100(O[t+1]/C[t] − 1)。実行可能な売買（翌日寄りで買う）が取れない部分。
//
// 極値と経路の分布・分位帯は「H日を完全に観測した事例」だけで作る。末尾で観測が足りない事例は
// 一覧に残し、分布からは除く（暫定の極値を混ぜると、窓が短いほど極値が浅く出る偏りが入る）。

import type { PricePoint } from "./types";
import {
  type AnalysisRange, type MoveCondition, type PriceAudit, type Quantiles, type Trigger,
  adoptEvents, indexSet, preEventSigma, scanTriggers, summarize, THRESHOLD_EPS, calendarDays,
} from "./nday-move";
import { kaplanMeierDaily, survivalQuantile, type SurvivalDay } from "./survival";

export interface DistributionOptions {
  /** 観測期間 H（営業日） */
  horizon: number;
  excludeOverlap: boolean;
  /** 「最高終値から q% 下落」の q（%） */
  drawdownPct: number;
}

export interface EventPath extends Trigger {
  /** 観測できた日数 A = min(H, end − t) */
  available: number;
  complete: boolean;
  /** k = 0 … A の累積騰落率（%）。pathPct[0] = 0 */
  pathPct: number[];
  /** 観測窓（0 … A）内の最低終値の日と変化率。complete でなければ暫定 */
  minDay: number;
  minPct: number;
  maxDay: number;
  maxPct: number;
  /** 初めて前日終値を下回った日。observed=false は打ち切り（time = A） */
  firstDown: { time: number; observed: boolean };
  /** 走行最高終値から q% 下落した日。observed=false は打ち切り */
  drawdown: { time: number; observed: boolean };
  /** 翌朝の窓（%）。翌営業日が期間外・約定できない日・投信型なら null */
  gapPct: number | null;
  /** H日目の騰落率（complete のときだけ） */
  finalPct: number | null;
  /** 判定区間か観測窓に、出来高0で4本値が同値の行を含む */
  touchesNoTrade: boolean;
  /** 事前ボラ σ̂（日次対数リターン）。推定できなければ null */
  preSigma: number | null;
  /** 同期間の市場（ベンチマーク）の騰落率（%）。取得できなければ null */
  marketLookbackPct: number | null;
  marketForwardPct: number | null;
}

export interface PathBand {
  k: number;
  n: number;
  q10: number;
  q25: number;
  q50: number;
  q75: number;
  q90: number;
}

export interface GroupSummary {
  label: string;
  n: number;
  finalMedian: number | null;
  maxMedian: number | null;
  minMedian: number | null;
}

export interface DistributionResult {
  error: string | null;
  horizon: number;
  counts: {
    conditionDays: number;
    triggers: number;
    leading: number;
    overlap: number;
    adopted: number;
    complete: number;
    incomplete: number;
    touchesNoTrade: number;
  };
  leading: Trigger | null;
  overlapExcluded: Trigger[];
  events: EventPath[];
  /** 完全窓の事例による日別の分位帯 */
  bands: PathBand[];
  /** 日別中央値の線に最も近い実在の事例（events の添字）。完全窓が無ければ null */
  medoid: number | null;
  /** 無条件（期間内の全営業日を起点）の日別分位帯 */
  baseline: PathBand[];
  /** 最低・最高終値の日（0 … H）の度数。完全窓のみ */
  minDayHist: number[];
  maxDayHist: number[];
  finalPct: Quantiles | null;
  maxPct: Quantiles | null;
  minPct: Quantiles | null;
  gapPct: Quantiles | null;
  firstDownKM: SurvivalDay[];
  drawdownKM: SurvivalDay[];
  firstDownMedian: number | null;
  drawdownMedian: number | null;
  /** 事前ボラの三分位での層別（完全窓のみ） */
  byPreVol: GroupSummary[];
  /** 市場も同じ向きに動いたか（完全窓のみ・ベンチマークがあるとき） */
  byMarket: GroupSummary[];
}

/** 日付で引く as-of 検索（その日以前で最も新しい終値。7暦日より古ければ null）。 */
export function asOfCloseLookup(bench: PricePoint[] | null | undefined): (date: string) => number | null {
  if (!bench || bench.length === 0) return () => null;
  const dates = bench.map((b) => b.time);
  return (date: string) => {
    let lo = 0;
    let hi = dates.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (found < 0 || calendarDays(dates[found], date) > 7) return null;
    const close = bench[found].close;
    return Number.isFinite(close) && close > 0 ? close : null;
  };
}

function bandsFrom(paths: number[][], horizon: number): PathBand[] {
  const bands: PathBand[] = [];
  for (let k = 0; k <= horizon; k++) {
    const values = paths.map((p) => p[k]).filter((v) => Number.isFinite(v));
    const s = summarize(values);
    if (!s) continue;
    bands.push({ k, n: s.n, q10: s.q10, q25: s.q25, q50: s.q50, q75: s.q75, q90: s.q90 });
  }
  return bands;
}

function groupSummary(label: string, events: EventPath[]): GroupSummary {
  const med = (xs: (number | null)[]) => summarize(xs.filter((v): v is number => v !== null))?.q50 ?? null;
  return {
    label, n: events.length,
    finalMedian: med(events.map((e) => e.finalPct)),
    maxMedian: med(events.map((e) => e.maxPct)),
    minMedian: med(events.map((e) => e.minPct)),
  };
}

export function validateDistributionOptions(options: DistributionOptions): string | null {
  if (!Number.isInteger(options.horizon) || options.horizon < 1 || options.horizon > 252) {
    return "観測期間 H は 1〜252 の整数で指定してください。";
  }
  if (!Number.isFinite(options.drawdownPct) || options.drawdownPct <= 0 || options.drawdownPct >= 100) {
    return "反落の幅 q は 0 より大きく 100 未満（%）で指定してください。";
  }
  return null;
}

export function computeDistribution(
  prices: PricePoint[],
  audit: PriceAudit,
  condition: MoveCondition,
  range: AnalysisRange,
  options: DistributionOptions,
  bench?: PricePoint[] | null,
): DistributionResult {
  const { horizon, drawdownPct } = options;
  const result: DistributionResult = {
    error: null, horizon,
    counts: { conditionDays: 0, triggers: 0, leading: 0, overlap: 0, adopted: 0, complete: 0, incomplete: 0, touchesNoTrade: 0 },
    leading: null, overlapExcluded: [], events: [], bands: [], medoid: null, baseline: [],
    minDayHist: Array<number>(horizon + 1).fill(0), maxDayHist: Array<number>(horizon + 1).fill(0),
    finalPct: null, maxPct: null, minPct: null, gapPct: null,
    firstDownKM: [], drawdownKM: [], firstDownMedian: null, drawdownMedian: null,
    byPreVol: [], byMarket: [],
  };
  if (audit.error) { result.error = audit.error; return result; }
  const optionError = validateDistributionOptions(options);
  if (optionError) { result.error = optionError; return result; }

  const scan = scanTriggers(prices, condition, range);
  const { adopted, overlapExcluded } = adoptEvents(scan.triggers, horizon, options.excludeOverlap);
  result.leading = scan.leading;
  result.overlapExcluded = overlapExcluded;
  const noTrade = indexSet(audit.noTradeBars, prices.length);
  const benchClose = asOfCloseLookup(bench);

  for (const trigger of adopted) {
    const t = trigger.index;
    const available = Math.min(horizon, range.end - t);
    const base = prices[t].close;
    const pathPct: number[] = [0];
    let minDay = 0, maxDay = 0;
    let firstDown: EventPath["firstDown"] = { time: available, observed: false };
    let drawdown: EventPath["drawdown"] = { time: available, observed: false };
    let peak = base;
    for (let k = 1; k <= available; k++) {
      const close = prices[t + k].close;
      pathPct.push(100 * (close / base - 1));
      // 同値は最初の日を採用するため、厳密に更新したときだけ動かす。
      if (close < prices[t + minDay].close) minDay = k;
      if (close > prices[t + maxDay].close) maxDay = k;
      if (!firstDown.observed && close < prices[t + k - 1].close) firstDown = { time: k, observed: true };
      peak = Math.max(peak, close);
      const dd = 100 * (1 - close / peak);
      if (!drawdown.observed && dd > 0 && dd + THRESHOLD_EPS >= drawdownPct) drawdown = { time: k, observed: true };
    }
    let touchesNoTrade = false;
    for (let i = Math.max(0, t - condition.lookback); i <= t + available; i++) {
      if (noTrade[i]) { touchesNoTrade = true; break; }
    }
    const next = t + 1;
    const gapPct = !audit.closeOnly && next <= range.end && !noTrade[next]
      ? 100 * (prices[next].open / base - 1) : null;
    const bLook = benchClose(prices[t - condition.lookback].time);
    const bNow = benchClose(prices[t].time);
    const bEnd = available === horizon ? benchClose(prices[t + horizon].time) : null;
    result.events.push({
      ...trigger, available, complete: available === horizon, pathPct,
      minDay, minPct: pathPct[minDay], maxDay, maxPct: pathPct[maxDay],
      firstDown, drawdown, gapPct,
      finalPct: available === horizon ? pathPct[horizon] : null,
      touchesNoTrade,
      preSigma: preEventSigma(prices, t, condition.lookback),
      marketLookbackPct: bLook !== null && bNow !== null ? 100 * (bNow / bLook - 1) : null,
      marketForwardPct: bNow !== null && bEnd !== null ? 100 * (bEnd / bNow - 1) : null,
    });
  }

  const events = result.events;
  const complete = events.filter((e) => e.complete);
  result.counts = {
    conditionDays: scan.conditionDays,
    triggers: scan.triggers.length,
    leading: scan.leading ? 1 : 0,
    overlap: overlapExcluded.length,
    adopted: events.length,
    complete: complete.length,
    incomplete: events.length - complete.length,
    touchesNoTrade: events.filter((e) => e.touchesNoTrade).length,
  };

  result.bands = bandsFrom(complete.map((e) => e.pathPct), horizon);
  if (complete.length > 0 && result.bands.length === horizon + 1) {
    let best = Infinity;
    for (const e of complete) {
      let d = 0;
      for (let k = 1; k <= horizon; k++) d += (e.pathPct[k] - result.bands[k].q50) ** 2;
      if (d < best) { best = d; result.medoid = events.indexOf(e); }
    }
  }
  for (const e of complete) {
    result.minDayHist[e.minDay]++;
    result.maxDayHist[e.maxDay]++;
  }
  result.finalPct = summarize(complete.map((e) => e.finalPct as number));
  result.maxPct = summarize(complete.map((e) => e.maxPct));
  result.minPct = summarize(complete.map((e) => e.minPct));
  result.gapPct = summarize(events.map((e) => e.gapPct).filter((v): v is number => v !== null));

  result.firstDownKM = kaplanMeierDaily(events.map((e) => ({ time: e.firstDown.time, event: e.firstDown.observed })), horizon);
  result.drawdownKM = kaplanMeierDaily(events.map((e) => ({ time: e.drawdown.time, event: e.drawdown.observed })), horizon);
  result.firstDownMedian = survivalQuantile(result.firstDownKM, 0.5);
  result.drawdownMedian = survivalQuantile(result.drawdownKM, 0.5);

  // 無条件の比較基準: 期間内で判定できる最初の日から、H日の完全窓を取れる全営業日を起点にする。
  const baselineStart = scan.firstSignalIndex ?? range.start;
  const baselinePaths: number[][] = [];
  for (let s = baselineStart; s + horizon <= range.end; s++) {
    const b = prices[s].close;
    const path: number[] = [];
    for (let k = 0; k <= horizon; k++) path.push(100 * (prices[s + k].close / b - 1));
    baselinePaths.push(path);
  }
  result.baseline = bandsFrom(baselinePaths, horizon);

  // 層別（記述のみ・有意性は主張しない）。事前ボラで切る: 同時点の騰落で切ると機械的な相関が入る。
  const withVol = complete.filter((e) => e.preSigma !== null).sort((a, b) => (a.preSigma as number) - (b.preSigma as number));
  if (withVol.length >= 3) {
    const cut1 = Math.floor(withVol.length / 3);
    const cut2 = Math.floor((2 * withVol.length) / 3);
    result.byPreVol = [
      groupSummary("事前ボラ 低", withVol.slice(0, cut1)),
      groupSummary("事前ボラ 中", withVol.slice(cut1, cut2)),
      groupSummary("事前ボラ 高", withVol.slice(cut2)),
    ];
  }
  const withMarket = complete.filter((e) => e.marketLookbackPct !== null);
  if (withMarket.length > 0) {
    // 市場も同じ向きに、銘柄の騰落の半分以上動いていれば「市場と連動」。
    const linked = (e: EventPath) => (e.marketLookbackPct as number) / e.movePct >= 0.5;
    result.byMarket = [
      groupSummary("市場も同じ向きに動いた", withMarket.filter(linked)),
      groupSummary("銘柄固有の動き", withMarket.filter((e) => !linked(e))),
    ];
  }
  return result;
}
