import { PricePoint } from "./types";

export interface StochPoint {
  time: string;
  fastK: number;
  fastD: number;
  slowK: number;
  slowD: number;
}

export interface StochSignal {
  type: "buy" | "sell" | "info";
  message: string;
}

function sma(values: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    const slice = values.slice(i - period + 1, i + 1);
    result.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return result;
}

export function computeStochastics(
  prices: PricePoint[],
  kPeriod: number = 14,
  dPeriod: number = 3,
  slowPeriod: number = 3
): StochPoint[] {
  if (prices.length < kPeriod) return [];

  // Compute raw %K for each bar where we have enough lookback
  const rawKValues: number[] = [];
  const rawKTimes: string[] = [];

  for (let i = kPeriod - 1; i < prices.length; i++) {
    const window = prices.slice(i - kPeriod + 1, i + 1);
    const highest = Math.max(...window.map((p) => p.high));
    const lowest = Math.min(...window.map((p) => p.low));
    const close = prices[i].close;

    const range = highest - lowest;
    const k = range === 0 ? 50 : ((close - lowest) / range) * 100;
    rawKValues.push(k);
    rawKTimes.push(prices[i].time);
  }

  if (rawKValues.length < dPeriod) return [];

  // Fast %D = SMA(dPeriod) of raw %K
  const fastDValues = sma(rawKValues, dPeriod);
  // Align: fastD[0] corresponds to rawKValues index dPeriod-1
  const fastKAligned = rawKValues.slice(dPeriod - 1);
  const fastTimesAligned = rawKTimes.slice(dPeriod - 1);

  if (fastKAligned.length < slowPeriod) return [];

  // Slow %K = Fast %D (already computed above, aligned)
  // We need slowK = SMA(slowPeriod) of fastK (which equals fastD in fast stochastic)
  // Actually: Slow%K = %D from fast stoch (i.e. fastDValues), Slow%D = SMA(slowPeriod) of Slow%K
  const slowKValues = sma(fastDValues, slowPeriod);
  // Align slow values
  const fastKAligned2 = fastKAligned.slice(slowPeriod - 1);
  const fastDAligned2 = fastDValues.slice(slowPeriod - 1);
  const timesAligned2 = fastTimesAligned.slice(slowPeriod - 1);

  if (slowKValues.length < slowPeriod) return [];

  const slowDValues = sma(slowKValues, slowPeriod);
  // Align slow%D
  const offset = slowPeriod - 1;
  const finalFastK = fastKAligned2.slice(offset);
  const finalFastD = fastDAligned2.slice(offset);
  const finalSlowK = slowKValues.slice(offset);
  const finalTimes = timesAligned2.slice(offset);

  return finalTimes.map((time, i) => ({
    time,
    fastK: finalFastK[i],
    fastD: finalFastD[i],
    slowK: finalSlowK[i],
    slowD: slowDValues[i],
  }));
}

export function detectStochSignals(points: StochPoint[]): StochSignal[] {
  const signals: StochSignal[] = [];
  if (points.length < 2) return signals;

  const prev = points[points.length - 2];
  const curr = points[points.length - 1];

  // Buy: slowK crosses above slowD in oversold zone (<20)
  const crossedUp =
    prev.slowK <= prev.slowD && curr.slowK > curr.slowD;
  const crossedDown =
    prev.slowK >= prev.slowD && curr.slowK < curr.slowD;

  if (crossedUp && curr.slowK < 20) {
    signals.push({
      type: "buy",
      message: `売られすぎゾーン(<20)でSlow%%Kがゾールデンクロス (Slow%%K: ${curr.slowK.toFixed(1)})`,
    });
  }

  if (crossedDown && curr.slowK > 80) {
    signals.push({
      type: "sell",
      message: `買われすぎゾーン(>80)でSlow%%Kがデッドクロス (Slow%%K: ${curr.slowK.toFixed(1)})`,
    });
  }

  // Info: current zone status
  if (curr.slowK >= 80) {
    signals.push({
      type: "info",
      message: `買われすぎゾーン: Slow%%K ${curr.slowK.toFixed(1)}, Slow%%D ${curr.slowD.toFixed(1)}`,
    });
  } else if (curr.slowK <= 20) {
    signals.push({
      type: "info",
      message: `売られすぎゾーン: Slow%%K ${curr.slowK.toFixed(1)}, Slow%%D ${curr.slowD.toFixed(1)}`,
    });
  } else {
    signals.push({
      type: "info",
      message: `中立ゾーン: Slow%%K ${curr.slowK.toFixed(1)}, Slow%%D ${curr.slowD.toFixed(1)}`,
    });
  }

  return signals;
}
