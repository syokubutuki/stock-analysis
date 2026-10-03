import type { PricePoint } from "./types";
import { kaplanMeierDaily, survivalQuantile } from "./survival";

export interface SurgeOptions {
  risePct: number;
  dropPct: number;
  rallyPct: number;
  horizon: number;
  window: number;
  basis: "signal" | "peak" | "daily";
  position: "all" | "upper" | "lower";
  newHighOnly: boolean;
  excludeOverlap: boolean;
}

export interface WavePoint {
  time: string;
  index: number;
  close: number;
  high: number;
  low: number;
  position: number | null;
  highAge: number;
  lowAge: number;
  newHigh: boolean;
  newLow: boolean;
  highExpired: boolean;
  lowExpired: boolean;
}

export interface SurgeEvent {
  time: string;
  index: number;
  rise: number;
  position: number | null;
  available: number;
  dropDay: number | null;
  rallyDay: number | null;
  maxRiseBeforeDrop: number;
  path: number[];
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const x = (sorted.length - 1) * q;
  return sorted[Math.floor(x)] + (sorted[Math.ceil(x)] - sorted[Math.floor(x)]) * (x % 1);
}

/** 同値の高安は直近の日を採用。高安の更新と、窓落ちによるレンジの変化を区別する。 */
function rollingWave(prices: PricePoint[], window: number): WavePoint[] {
  const points: WavePoint[] = [];
  for (let i = window - 1; i < prices.length; i++) {
    let hi = i - window + 1, lo = hi;
    for (let j = hi + 1; j <= i; j++) {
      if (prices[j].high >= prices[hi].high) hi = j;
      if (prices[j].low <= prices[lo].low) lo = j;
    }
    const high = prices[hi].high, low = prices[lo].low;
    const prev = points.at(-1);
    points.push({ time: prices[i].time, index: i, close: prices[i].close, high, low,
      position: high === low ? null : 100 * (prices[i].close - low) / (high - low),
      highAge: i - hi, lowAge: i - lo,
      newHigh: !!prev && prices[i].high > prev.high,
      newLow: !!prev && prices[i].low < prev.low,
      highExpired: !!prev && high < prev.high,
      lowExpired: !!prev && low > prev.low });
  }
  return points;
}

function summarize(events: SurgeEvent[], horizon: number) {
  const days = kaplanMeierDaily(events.map((e) => ({
    time: e.dropDay ?? e.available, event: e.dropDay !== null,
  })), horizon);
  // 経路と先着比較は、全H日を観測した同じ母集団。成功例だけを採用しない。
  const complete = events.filter((e) => e.available === horizon);
  const paths = Array.from({ length: horizon + 1 }, (_, day) => {
    const values = complete.map((e) => e.path[day]);
    return { day, median: quantile(values, 0.5), p25: quantile(values, 0.25), p75: quantile(values, 0.75) };
  });
  const first = { drop: 0, rally: 0, neither: 0, tie: 0 };
  for (const e of complete) {
    if (e.dropDay === null && e.rallyDay === null) first.neither++;
    else if (e.dropDay !== null && e.dropDay === e.rallyDay) first.tie++;
    else if (e.dropDay !== null && (e.rallyDay === null || e.dropDay < e.rallyDay)) first.drop++;
    else first.rally++;
  }
  return { events, days, paths, first, completeCount: complete.length,
    observed: events.filter((e) => e.dropDay !== null).length,
    horizonCensored: events.filter((e) => e.dropDay === null && e.available === horizon).length,
    endCensored: events.filter((e) => e.dropDay === null && e.available < horizon).length,
    zeroFollowup: events.filter((e) => e.available === 0).length,
    median: survivalQuantile(days, 0.5),
    maxRiseMedian: quantile(complete.map((e) => e.maxRiseBeforeDrop), 0.5) };
}

/** 入力は選択期間の昇順日足。価格の修復や欠損の詰め直しは取得層に任せる。 */
export function computeSurgePullback(prices: PricePoint[], options: SurgeOptions) {
  const empty = { error: null as string | null, waves: [] as WavePoint[], rawSignals: 0,
    selected: summarize([], 0), baseline: summarize([], 0) };
  const { risePct, dropPct, rallyPct, horizon, window, basis, position, newHighOnly, excludeOverlap } = options;
  if (![risePct, dropPct, rallyPct].every((x) => Number.isFinite(x) && x > 0)
    || risePct > 1000 || dropPct >= 100 || rallyPct > 1000
    || !Number.isInteger(horizon) || horizon < 1 || horizon > 60
    || !Number.isInteger(window) || window < 2 || window > 60
    || !["signal", "peak", "daily"].includes(basis) || !["all", "upper", "lower"].includes(position)) {
    return { ...empty, error: "N・続伸率は0超〜1000%、下落率は0超〜100%未満、観測期間は1〜60、窓は2〜60営業日で指定してください。" };
  }
  if (prices.some((p, i) => ![p.close, p.high, p.low].every((x) => Number.isFinite(x) && x > 0)
    || p.low > p.close || p.high < p.close || !/^\d{4}-\d{2}-\d{2}$/.test(p.time)
    || (i > 0 && p.time <= prices[i - 1].time))) {
    return { ...empty, error: "価格または日付の並びが不正なため集計できません。価格データを再取得してください。" };
  }
  if (prices.length < window + 1) {
    return { ...empty, error: `少なくとも${window + 1}本の日足が必要です。分析期間を長くしてください。` };
  }
  const waves = rollingWave(prices, window);
  const selected: SurgeEvent[] = [], baseline: SurgeEvent[] = [];
  let nextSignal = 0, nextBaseline = 0, rawSignals = 0;
  for (const w of waves) {
    // 前の完全な窓も必要にして、新高値条件と無条件のウォームアップをそろえる。
    const t = w.index;
    if (t < window) continue;
    if (position !== "all" && (w.position === null || (position === "upper" ? w.position < 80 : w.position > 20))) continue;
    if (newHighOnly && !w.newHigh) continue;
    const rise = 100 * (prices[t].close / prices[t - 1].close - 1);
    const signal = rise + 1e-10 >= risePct;
    if (signal) rawSignals++;
    if (excludeOverlap && t < (signal ? nextSignal : nextBaseline)) continue;
    if (signal) nextSignal = t + horizon + 1;
    else nextBaseline = t + horizon + 1;
    const available = Math.min(horizon, prices.length - t - 1);
    const start = prices[t].close;
    let peak = start, dropDay: number | null = null, rallyDay: number | null = null;
    let maxRiseBeforeDrop = 0;
    const path = [0];
    for (let k = 1; k <= available; k++) {
      const close = prices[t + k].close;
      peak = Math.max(peak, close);
      const value = 100 * (close / start - 1);
      path.push(value);
      const reference = basis === "signal" ? start : basis === "peak" ? peak : prices[t + k - 1].close;
      const drop = 100 * (1 - close / reference);
      if (dropDay === null) {
        if (drop + 1e-10 >= dropPct) dropDay = k;
        else maxRiseBeforeDrop = Math.max(maxRiseBeforeDrop, value);
      }
      if (rallyDay === null && value + 1e-10 >= rallyPct) rallyDay = k;
    }
    (signal ? selected : baseline).push({ time: w.time, index: t, rise, position: w.position,
      available, dropDay, rallyDay, maxRiseBeforeDrop, path });
  }
  return { error: null, waves, rawSignals, selected: summarize(selected, horizon), baseline: summarize(baseline, horizon) };
}

export type SurgeResult = ReturnType<typeof computeSurgePullback>;
