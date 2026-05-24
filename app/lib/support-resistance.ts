import { PricePoint } from "./types";

export interface PivotPoint {
  time: string;
  price: number;
  type: "high" | "low";
  index: number;
}

export interface SRLevel {
  price: number;
  type: "support" | "resistance";
  touches: number;
  lastTouch: string;
  strength: number;       // 0-100
  distancePercent: number; // distance from current price (%)
}

// Detect pivot highs/lows
function detectPivots(prices: PricePoint[], leftBars: number = 5, rightBars: number = 5): PivotPoint[] {
  const pivots: PivotPoint[] = [];

  for (let i = leftBars; i < prices.length - rightBars; i++) {
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= leftBars; j++) {
      if (prices[i].high <= prices[i - j].high) isHigh = false;
      if (prices[i].low >= prices[i - j].low) isLow = false;
    }
    for (let j = 1; j <= rightBars; j++) {
      if (prices[i].high <= prices[i + j].high) isHigh = false;
      if (prices[i].low >= prices[i + j].low) isLow = false;
    }

    if (isHigh) {
      pivots.push({ time: prices[i].time, price: prices[i].high, type: "high", index: i });
    }
    if (isLow) {
      pivots.push({ time: prices[i].time, price: prices[i].low, type: "low", index: i });
    }
  }

  return pivots;
}

// Compute ATR for clustering threshold
function computeATR(prices: PricePoint[], period: number = 14): number {
  if (prices.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 1; i < Math.min(prices.length, period + 1); i++) {
    const tr = Math.max(
      prices[i].high - prices[i].low,
      Math.abs(prices[i].high - prices[i - 1].close),
      Math.abs(prices[i].low - prices[i - 1].close)
    );
    sum += tr;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

// Cluster nearby prices
function clusterPrices(pivots: PivotPoint[], threshold: number): PivotPoint[][] {
  if (pivots.length === 0) return [];

  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: PivotPoint[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const lastCluster = clusters[clusters.length - 1];
    const clusterMean =
      lastCluster.reduce((a, p) => a + p.price, 0) / lastCluster.length;

    if (Math.abs(sorted[i].price - clusterMean) <= threshold) {
      lastCluster.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }

  return clusters;
}

export function detectSupportResistance(
  prices: PricePoint[],
  maxLevels: number = 8
): SRLevel[] {
  if (prices.length < 20) return [];

  const pivots = detectPivots(prices, 5, 5);
  if (pivots.length === 0) return [];

  const atr = computeATR(prices);
  const threshold = atr * 0.5;

  const clusters = clusterPrices(pivots, threshold);
  const currentPrice = prices[prices.length - 1].close;
  const n = prices.length;

  const levels: SRLevel[] = clusters
    .filter((c) => c.length >= 2) // at least 2 touches
    .map((cluster) => {
      const avgPrice =
        cluster.reduce((a, p) => a + p.price, 0) / cluster.length;
      const touches = cluster.length;
      const lastTouchIdx = Math.max(...cluster.map((p) => p.index));
      const lastTouch = cluster.reduce((latest, p) =>
        p.index > latest.index ? p : latest
      ).time;

      // Recency weight: more recent touches are more important
      const recencyScore = cluster.reduce((a, p) => {
        const age = (n - p.index) / n; // 0 = most recent, 1 = oldest
        return a + (1 - age * 0.5);
      }, 0);

      const strength = Math.min(100, Math.round(
        (touches * 15 + recencyScore * 10) *
          (lastTouchIdx > n * 0.5 ? 1.2 : 0.8)
      ));

      const distancePercent =
        currentPrice > 0 ? ((avgPrice - currentPrice) / currentPrice) * 100 : 0;

      return {
        price: Math.round(avgPrice * 100) / 100,
        type: avgPrice >= currentPrice ? "resistance" as const : "support" as const,
        touches,
        lastTouch,
        strength,
        distancePercent,
      };
    })
    .sort((a, b) => b.strength - a.strength)
    .slice(0, maxLevels)
    .sort((a, b) => b.price - a.price);

  return levels;
}
