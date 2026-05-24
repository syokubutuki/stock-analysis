import { PricePoint } from "./types";

export interface ATRPoint {
  time: string;
  tr: number;
  atr: number;
  atrPercent: number;
}

export interface KeltnerPoint {
  time: string;
  upper: number;
  middle: number;
  lower: number;
  close: number;
}

/**
 * Standard EMA calculation.
 * Returns an array of the same length as `values`.
 * The first (period - 1) elements are seeded with the simple average of the
 * first `period` values, then Wilder-style — but this helper uses the standard
 * EMA multiplier k = 2 / (period + 1).
 */
export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = new Array(values.length);

  // Seed with simple average of first `period` values (or all available)
  const seedLen = Math.min(period, values.length);
  let sum = 0;
  for (let i = 0; i < seedLen; i++) sum += values[i];
  const seed = sum / seedLen;

  // Fill up to seed index
  for (let i = 0; i < seedLen; i++) result[i] = seed;

  // EMA forward
  for (let i = seedLen; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }

  return result;
}

/**
 * Compute ATR (Average True Range) using Wilder's smoothing.
 *
 * - TR_i = max(H-L, |H-prevClose|, |L-prevClose|)
 * - First ATR = simple average of first `period` TRs
 * - ATR_i = (ATR_{i-1} * (period-1) + TR_i) / period
 * - ATR% = ATR / close * 100
 */
export function computeATR(prices: PricePoint[], period = 14): ATRPoint[] {
  if (prices.length < 2) return [];

  // Compute True Range for each bar (starting at index 1)
  const trValues: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const { high, low } = prices[i];
    const prevClose = prices[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trValues.push(tr);
  }

  if (trValues.length < period) return [];

  const result: ATRPoint[] = [];

  // First ATR = simple average of first `period` TRs
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trValues[i];
  atr /= period;

  // The first ATR corresponds to prices[period] (index shifted by 1 due to TR starting at i=1)
  result.push({
    time: prices[period].time,
    tr: trValues[period - 1],
    atr,
    atrPercent: (atr / prices[period].close) * 100,
  });

  // Wilder smoothing for the rest
  for (let i = period; i < trValues.length; i++) {
    atr = (atr * (period - 1) + trValues[i]) / period;
    const priceIdx = i + 1; // trValues[i] corresponds to prices[i+1]
    result.push({
      time: prices[priceIdx].time,
      tr: trValues[i],
      atr,
      atrPercent: (atr / prices[priceIdx].close) * 100,
    });
  }

  return result;
}

/**
 * Compute Keltner Channel.
 *
 * - Middle = EMA(close, emaPeriod)
 * - Upper  = Middle + atrMultiplier * ATR
 * - Lower  = Middle - atrMultiplier * ATR
 */
export function computeKeltnerChannel(
  prices: PricePoint[],
  emaPeriod = 20,
  atrMultiplier = 2,
  atrPeriod = 14
): KeltnerPoint[] {
  if (prices.length < Math.max(emaPeriod, atrPeriod) + 1) return [];

  const closes = prices.map((p) => p.close);
  const emaValues = ema(closes, emaPeriod);

  const atrPoints = computeATR(prices, atrPeriod);
  // Build a lookup: time -> atr
  const atrMap = new Map<string, number>();
  for (const a of atrPoints) atrMap.set(a.time, a.atr);

  const result: KeltnerPoint[] = [];
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    const atrVal = atrMap.get(p.time);
    if (atrVal === undefined) continue;
    const middle = emaValues[i];
    result.push({
      time: p.time,
      upper: middle + atrMultiplier * atrVal,
      middle,
      lower: middle - atrMultiplier * atrVal,
      close: p.close,
    });
  }

  return result;
}
