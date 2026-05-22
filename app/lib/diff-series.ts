import { PricePoint } from "./types";

export interface DiffPoint {
  time: string;
  value: number;
}

export interface DiffSeries {
  lag: number;
  data: DiffPoint[];
}

// 差分系列: price[i] - price[i - lag]
export function computeDiffSeries(
  prices: PricePoint[],
  lag: number
): DiffPoint[] {
  const result: DiffPoint[] = [];
  for (let i = lag; i < prices.length; i++) {
    result.push({
      time: prices[i].time,
      value: prices[i].close - prices[i - lag].close,
    });
  }
  return result;
}

// 差分系列の変化率版: (price[i] - price[i - lag]) / price[i - lag] * 100
export function computeDiffSeriesPercent(
  prices: PricePoint[],
  lag: number
): DiffPoint[] {
  const result: DiffPoint[] = [];
  for (let i = lag; i < prices.length; i++) {
    const base = prices[i - lag].close;
    if (base === 0) continue;
    result.push({
      time: prices[i].time,
      value: ((prices[i].close - base) / base) * 100,
    });
  }
  return result;
}

// 差分系列の統計サマリー
export interface DiffStats {
  lag: number;
  mean: number;
  stdDev: number;
  positiveRatio: number; // 正の割合（上昇日の割合）
  maxUp: number;
  maxDown: number;
}

export function computeDiffStats(diff: DiffPoint[]): Omit<DiffStats, "lag"> {
  if (diff.length === 0)
    return { mean: 0, stdDev: 0, positiveRatio: 0, maxUp: 0, maxDown: 0 };

  const values = diff.map((d) => d.value);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;
  const variance =
    values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  const positiveCount = values.filter((v) => v > 0).length;

  return {
    mean,
    stdDev,
    positiveRatio: positiveCount / values.length,
    maxUp: Math.max(...values),
    maxDown: Math.min(...values),
  };
}
