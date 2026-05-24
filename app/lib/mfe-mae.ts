import { PricePoint } from "./types";

export interface MFEMAEPoint {
  time: string;
  mfe: number; // (high - open) / open
  mae: number; // (open - low) / open
  realized: number; // (close - open) / open
}

export function computeMFEMAE(prices: PricePoint[]): MFEMAEPoint[] {
  const result: MFEMAEPoint[] = [];
  for (const p of prices) {
    if (p.open <= 0) continue;
    result.push({
      time: p.time,
      mfe: (p.high - p.open) / p.open,
      mae: (p.open - p.low) / p.open,
      realized: (p.close - p.open) / p.open,
    });
  }
  return result;
}

export interface MFEMAEStats {
  avgMFE: number;
  avgMAE: number;
  medianMFE: number;
  medianMAE: number;
  mfeMAERatio: number; // avgMFE / avgMAE — > 1なら上方向に動きやすい
  // MFE利用率: realized / MFE (利益をどれだけ取れているか)
  avgMFECapture: number;
  // 勝率 (close > open)
  winRate: number;
  // リスクリワード: avgMFE / avgMAE
  riskReward: number;
  // MFE/MAEの相関
  correlation: number;
}

export function computeMFEMAEStats(points: MFEMAEPoint[]): MFEMAEStats {
  const n = points.length;
  if (n === 0) {
    return {
      avgMFE: 0, avgMAE: 0, medianMFE: 0, medianMAE: 0,
      mfeMAERatio: 0, avgMFECapture: 0, winRate: 0, riskReward: 0, correlation: 0,
    };
  }

  const mfes = points.map((p) => p.mfe);
  const maes = points.map((p) => p.mae);
  const avgMFE = mean(mfes);
  const avgMAE = mean(maes);

  const sortedMFE = [...mfes].sort((a, b) => a - b);
  const sortedMAE = [...maes].sort((a, b) => a - b);
  const medianMFE = sortedMFE[Math.floor(n / 2)];
  const medianMAE = sortedMAE[Math.floor(n / 2)];

  // MFE capture: 陽線の日のみ、realized / mfe
  const bullish = points.filter((p) => p.realized > 0 && p.mfe > 0);
  const avgMFECapture = bullish.length > 0
    ? bullish.reduce((a, p) => a + p.realized / p.mfe, 0) / bullish.length
    : 0;

  const winRate = points.filter((p) => p.realized > 0).length / n;

  return {
    avgMFE,
    avgMAE,
    medianMFE,
    medianMAE,
    mfeMAERatio: avgMAE > 0 ? avgMFE / avgMAE : 0,
    avgMFECapture,
    winRate,
    riskReward: avgMAE > 0 ? avgMFE / avgMAE : 0,
    correlation: corr(mfes, maes),
  };
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function corr(x: number[], y: number[]): number {
  const n = x.length;
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
