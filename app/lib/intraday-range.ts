import { PricePoint } from "./types";

export interface IntradayRangePoint {
  time: string;
  normalizedRange: number; // (high - low) / open
  volume: number;
}

export function computeIntradayRange(prices: PricePoint[]): IntradayRangePoint[] {
  const result: IntradayRangePoint[] = [];
  for (const p of prices) {
    if (p.open <= 0) continue;
    result.push({
      time: p.time,
      normalizedRange: (p.high - p.low) / p.open,
      volume: p.volume,
    });
  }
  return result;
}

export interface RangeRollingPoint {
  time: string;
  rangeMA: number;
}

export function rollingRange(
  points: IntradayRangePoint[],
  window: number = 20
): RangeRollingPoint[] {
  const result: RangeRollingPoint[] = [];
  for (let i = window - 1; i < points.length; i++) {
    const slice = points.slice(i - window + 1, i + 1);
    result.push({
      time: points[i].time,
      rangeMA: slice.reduce((a, p) => a + p.normalizedRange, 0) / window,
    });
  }
  return result;
}

export interface IntradayRangeStats {
  meanRange: number;
  medianRange: number;
  stdRange: number;
  maxRange: number;
  minRange: number;
  // レンジの自己相関 (lag=1)
  rangeAutocorr: number;
  // レンジ vs 出来高の相関
  rangeVolumeCorr: number;
}

export function computeRangeStats(points: IntradayRangePoint[]): IntradayRangeStats {
  const n = points.length;
  if (n === 0) {
    return {
      meanRange: 0, medianRange: 0, stdRange: 0,
      maxRange: 0, minRange: 0, rangeAutocorr: 0, rangeVolumeCorr: 0,
    };
  }

  const ranges = points.map((p) => p.normalizedRange);
  const volumes = points.map((p) => p.volume);
  const sorted = [...ranges].sort((a, b) => a - b);

  const meanRange = mean(ranges);
  const stdRange = Math.sqrt(
    ranges.reduce((a, v) => a + (v - meanRange) ** 2, 0) / n
  );

  // Autocorrelation lag=1
  let rangeAutocorr = 0;
  if (n > 2 && stdRange > 0) {
    const variance = ranges.reduce((a, v) => a + (v - meanRange) ** 2, 0) / n;
    let sum = 0;
    for (let i = 0; i < n - 1; i++) {
      sum += (ranges[i] - meanRange) * (ranges[i + 1] - meanRange);
    }
    rangeAutocorr = sum / (n * variance);
  }

  return {
    meanRange,
    medianRange: sorted[Math.floor(n / 2)],
    stdRange,
    maxRange: Math.max(...ranges),
    minRange: Math.min(...ranges),
    rangeAutocorr,
    rangeVolumeCorr: corr(ranges, volumes),
  };
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function corr(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;
  const mx = mean(x);
  const my = mean(y);
  let cov = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    sx += (x[i] - mx) ** 2;
    sy += (y[i] - my) ** 2;
  }
  const denom = Math.sqrt(sx * sy);
  return denom > 1e-10 ? cov / denom : 0;
}
