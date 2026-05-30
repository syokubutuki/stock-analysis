import { PricePoint } from "./types";

// ─── Helper functions ───────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += (arr[i] - m) ** 2;
  return Math.sqrt(s / (arr.length - 1));
}

function skewness(arr: number[]): number {
  if (arr.length < 3) return 0;
  const m = mean(arr);
  const n = arr.length;
  let m2 = 0, m3 = 0;
  for (let i = 0; i < n; i++) {
    const d = arr[i] - m;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;
  const s = Math.sqrt(m2);
  return s > 0 ? m3 / (s * s * s) : 0;
}

function kurtosis(arr: number[]): number {
  if (arr.length < 4) return 0;
  const m = mean(arr);
  const n = arr.length;
  let m2 = 0, m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = arr[i] - m;
    m2 += d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m4 /= n;
  return m2 > 0 ? m4 / (m2 * m2) : 0;
}

function acf1(arr: number[]): number {
  if (arr.length < 3) return 0;
  const m = mean(arr);
  let num = 0, den = 0;
  for (let i = 0; i < arr.length; i++) den += (arr[i] - m) ** 2;
  if (den === 0) return 0;
  for (let i = 1; i < arr.length; i++) {
    num += (arr[i] - m) * (arr[i - 1] - m);
  }
  return num / den;
}

function logReturns(prices: PricePoint[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    r.push(Math.log(prices[i].close / prices[i - 1].close));
  }
  return r;
}

// ─── Interfaces ─────────────────────────────────────────────────────

export interface TimeframeStats {
  timeframe: string;
  n: number;
  meanReturn: number;
  stdReturn: number;
  sharpe: number;
  skewness: number;
  kurtosis: number;
  hurst: number;
  acf1: number;
  maxDrawdown: number;
}

export interface MultiTimeframeResult {
  stats: TimeframeStats[];
  weeklyPrices: PricePoint[];
  monthlyPrices: PricePoint[];
}

// ─── Resampling helpers ─────────────────────────────────────────────

function getISOWeekKey(dateStr: string): string {
  // Group by ISO week: YYYY-Www
  const d = new Date(dateStr + "T00:00:00Z");
  const dayOfWeek = d.getUTCDay() || 7; // Mon=1..Sun=7
  // Adjust to Thursday of the same week for ISO week number
  const thu = new Date(d);
  thu.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((thu.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${thu.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function getMonthKey(dateStr: string): string {
  return dateStr.slice(0, 7); // YYYY-MM
}

function resample(prices: PricePoint[], keyFn: (d: string) => string): PricePoint[] {
  if (prices.length === 0) return [];

  const groups = new Map<string, PricePoint[]>();
  for (const p of prices) {
    const key = keyFn(p.time);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  const result: PricePoint[] = [];
  const keys = Array.from(groups.keys());
  for (const key of keys) {
    const group = groups.get(key)!;
    if (group.length === 0) continue;
    const last = group[group.length - 1];
    let high = -Infinity, low = Infinity, vol = 0;
    for (const p of group) {
      if (p.high > high) high = p.high;
      if (p.low < low) low = p.low;
      vol += p.volume;
    }
    result.push({
      time: last.time,
      open: group[0].open,
      high,
      low,
      close: last.close,
      volume: vol,
    });
  }

  // Sort by date
  result.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return result;
}

// ─── Hurst exponent (R/S method) ────────────────────────────────────

function hurstExponent(returns: number[]): number {
  const n = returns.length;
  if (n < 20) return 0.5;

  const blockSizes = [10, 20, 40, 80, 160].filter(s => s <= n / 2);
  if (blockSizes.length < 2) return 0.5;

  const logN: number[] = [];
  const logRS: number[] = [];

  for (const size of blockSizes) {
    const nBlocks = Math.floor(n / size);
    if (nBlocks === 0) continue;

    let rsSum = 0;
    let validBlocks = 0;

    for (let b = 0; b < nBlocks; b++) {
      const block = returns.slice(b * size, (b + 1) * size);
      const m = mean(block);
      const s = stddev(block);
      if (s === 0) continue;

      // Cumulative deviations
      let cumSum = 0;
      let maxCum = -Infinity;
      let minCum = Infinity;
      for (let i = 0; i < block.length; i++) {
        cumSum += block[i] - m;
        if (cumSum > maxCum) maxCum = cumSum;
        if (cumSum < minCum) minCum = cumSum;
      }

      const range = maxCum - minCum;
      rsSum += range / s;
      validBlocks++;
    }

    if (validBlocks > 0) {
      logN.push(Math.log(size));
      logRS.push(Math.log(rsSum / validBlocks));
    }
  }

  if (logN.length < 2) return 0.5;

  // Linear regression: logRS = H * logN + c
  const mX = mean(logN);
  const mY = mean(logRS);
  let num = 0, den = 0;
  for (let i = 0; i < logN.length; i++) {
    num += (logN[i] - mX) * (logRS[i] - mY);
    den += (logN[i] - mX) ** 2;
  }
  return den > 0 ? num / den : 0.5;
}

// ─── Max drawdown ───────────────────────────────────────────────────

function maxDrawdown(returns: number[]): number {
  if (returns.length === 0) return 0;
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  for (const r of returns) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// ─── Compute stats for a timeframe ──────────────────────────────────

function computeStats(label: string, prices: PricePoint[]): TimeframeStats {
  const ret = logReturns(prices);
  const n = ret.length;
  const m = mean(ret);
  const s = stddev(ret);
  const annFactor = label === "日足" ? 252 : label === "週足" ? 52 : 12;

  return {
    timeframe: label,
    n,
    meanReturn: m,
    stdReturn: s,
    sharpe: s > 0 ? (m * annFactor) / (s * Math.sqrt(annFactor)) : 0,
    skewness: skewness(ret),
    kurtosis: kurtosis(ret),
    hurst: hurstExponent(ret),
    acf1: acf1(ret),
    maxDrawdown: maxDrawdown(ret),
  };
}

// ─── Main function ──────────────────────────────────────────────────

export function computeMultiTimeframe(prices: PricePoint[]): MultiTimeframeResult {
  if (prices.length < 5) {
    return { stats: [], weeklyPrices: [], monthlyPrices: [] };
  }

  const weeklyPrices = resample(prices, getISOWeekKey);
  const monthlyPrices = resample(prices, getMonthKey);

  const stats: TimeframeStats[] = [
    computeStats("日足", prices),
    computeStats("週足", weeklyPrices),
    computeStats("月足", monthlyPrices),
  ];

  return { stats, weeklyPrices, monthlyPrices };
}
