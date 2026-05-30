// Candlestick Pattern Detection with Statistical Validation

import { PricePoint } from "./types";

// ========== Helpers ==========

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function stddev(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
}

// ========== Types ==========

export interface CandlestickPattern {
  name: string;
  nameJa: string;
  type: "bullish" | "bearish" | "neutral";
  indices: number[];
  stats: {
    count: number;
    avgReturn1d: number;
    avgReturn5d: number;
    winRate1d: number;
    winRate5d: number;
    tStat: number;
    significant: boolean;
  };
}

// ========== Pattern Detection Helpers ==========

function bodySize(p: PricePoint): number {
  return Math.abs(p.close - p.open);
}

function upperShadow(p: PricePoint): number {
  return p.high - Math.max(p.open, p.close);
}

function lowerShadow(p: PricePoint): number {
  return Math.min(p.open, p.close) - p.low;
}

function range(p: PricePoint): number {
  return p.high - p.low;
}

function isBullish(p: PricePoint): boolean {
  return p.close > p.open;
}

function isBearish(p: PricePoint): boolean {
  return p.close < p.open;
}

function bodyTop(p: PricePoint): number {
  return Math.max(p.open, p.close);
}

function bodyBottom(p: PricePoint): number {
  return Math.min(p.open, p.close);
}

// ========== Main Function ==========

export function detectCandlestickPatterns(prices: PricePoint[]): CandlestickPattern[] {
  if (prices.length < 5) return [];

  const n = prices.length;

  // Precompute log returns
  const logReturn1d: number[] = new Array(n).fill(NaN);
  const logReturn5d: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n - 1; i++) {
    if (prices[i].close > 0 && prices[i + 1].close > 0) {
      logReturn1d[i] = Math.log(prices[i + 1].close / prices[i].close);
    }
  }
  for (let i = 0; i < n - 5; i++) {
    if (prices[i].close > 0 && prices[i + 5].close > 0) {
      logReturn5d[i] = Math.log(prices[i + 5].close / prices[i].close);
    }
  }

  // Detect each pattern
  type Detector = {
    name: string;
    nameJa: string;
    type: "bullish" | "bearish" | "neutral";
    detect: () => number[];
  };

  const detectors: Detector[] = [
    {
      name: "Doji",
      nameJa: "ドジ",
      type: "neutral",
      detect: () => {
        const indices: number[] = [];
        for (let i = 0; i < n; i++) {
          const r = range(prices[i]);
          if (r <= 0) continue;
          const b = bodySize(prices[i]);
          if (b < 0.1 * r && upperShadow(prices[i]) > 0 && lowerShadow(prices[i]) > 0) {
            indices.push(i);
          }
        }
        return indices;
      },
    },
    {
      name: "Hammer",
      nameJa: "ハンマー",
      type: "bullish",
      detect: () => {
        const indices: number[] = [];
        for (let i = 0; i < n; i++) {
          const b = bodySize(prices[i]);
          const ls = lowerShadow(prices[i]);
          const us = upperShadow(prices[i]);
          const r = range(prices[i]);
          if (r <= 0 || b <= 0) continue;
          // Small body at top, lower shadow >= 2x body, tiny upper shadow
          if (ls >= 2 * b && us <= b * 0.5) {
            indices.push(i);
          }
        }
        return indices;
      },
    },
    {
      name: "Shooting Star",
      nameJa: "流れ星",
      type: "bearish",
      detect: () => {
        const indices: number[] = [];
        for (let i = 0; i < n; i++) {
          const b = bodySize(prices[i]);
          const us = upperShadow(prices[i]);
          const ls = lowerShadow(prices[i]);
          const r = range(prices[i]);
          if (r <= 0 || b <= 0) continue;
          // Small body at bottom, upper shadow >= 2x body
          if (us >= 2 * b && ls <= b * 0.5) {
            indices.push(i);
          }
        }
        return indices;
      },
    },
    {
      name: "Bullish Engulfing",
      nameJa: "陽の包み足",
      type: "bullish",
      detect: () => {
        const indices: number[] = [];
        for (let i = 1; i < n; i++) {
          const prev = prices[i - 1];
          const curr = prices[i];
          if (!isBearish(prev) || !isBullish(curr)) continue;
          if (bodyBottom(curr) <= bodyBottom(prev) && bodyTop(curr) >= bodyTop(prev) && bodySize(curr) > bodySize(prev)) {
            indices.push(i);
          }
        }
        return indices;
      },
    },
    {
      name: "Bearish Engulfing",
      nameJa: "陰の包み足",
      type: "bearish",
      detect: () => {
        const indices: number[] = [];
        for (let i = 1; i < n; i++) {
          const prev = prices[i - 1];
          const curr = prices[i];
          if (!isBullish(prev) || !isBearish(curr)) continue;
          if (bodyBottom(curr) <= bodyBottom(prev) && bodyTop(curr) >= bodyTop(prev) && bodySize(curr) > bodySize(prev)) {
            indices.push(i);
          }
        }
        return indices;
      },
    },
    {
      name: "Morning Star",
      nameJa: "明けの明星",
      type: "bullish",
      detect: () => {
        const indices: number[] = [];
        for (let i = 2; i < n; i++) {
          const first = prices[i - 2];
          const second = prices[i - 1];
          const third = prices[i];
          // 1st: big bearish
          if (!isBearish(first) || bodySize(first) < range(first) * 0.3) continue;
          // 2nd: small body, gap down
          if (bodySize(second) > range(first) * 0.3) continue;
          if (bodyTop(second) > bodyBottom(first)) continue; // gap down check
          // 3rd: big bullish
          if (!isBullish(third) || bodySize(third) < range(third) * 0.3) continue;
          indices.push(i);
        }
        return indices;
      },
    },
    {
      name: "Evening Star",
      nameJa: "宵の明星",
      type: "bearish",
      detect: () => {
        const indices: number[] = [];
        for (let i = 2; i < n; i++) {
          const first = prices[i - 2];
          const second = prices[i - 1];
          const third = prices[i];
          // 1st: big bullish
          if (!isBullish(first) || bodySize(first) < range(first) * 0.3) continue;
          // 2nd: small body, gap up
          if (bodySize(second) > range(first) * 0.3) continue;
          if (bodyBottom(second) < bodyTop(first)) continue; // gap up check
          // 3rd: big bearish
          if (!isBearish(third) || bodySize(third) < range(third) * 0.3) continue;
          indices.push(i);
        }
        return indices;
      },
    },
    {
      name: "Three White Soldiers",
      nameJa: "赤三兵",
      type: "bullish",
      detect: () => {
        const indices: number[] = [];
        for (let i = 2; i < n; i++) {
          const a = prices[i - 2], b = prices[i - 1], c = prices[i];
          if (!isBullish(a) || !isBullish(b) || !isBullish(c)) continue;
          if (b.close > a.close && c.close > b.close) {
            indices.push(i);
          }
        }
        return indices;
      },
    },
    {
      name: "Three Black Crows",
      nameJa: "黒三兵",
      type: "bearish",
      detect: () => {
        const indices: number[] = [];
        for (let i = 2; i < n; i++) {
          const a = prices[i - 2], b = prices[i - 1], c = prices[i];
          if (!isBearish(a) || !isBearish(b) || !isBearish(c)) continue;
          if (b.close < a.close && c.close < b.close) {
            indices.push(i);
          }
        }
        return indices;
      },
    },
    {
      name: "Harami",
      nameJa: "はらみ足",
      type: "neutral",
      detect: () => {
        const indices: number[] = [];
        for (let i = 1; i < n; i++) {
          const prev = prices[i - 1];
          const curr = prices[i];
          // Current body within previous body
          if (bodyTop(curr) <= bodyTop(prev) && bodyBottom(curr) >= bodyBottom(prev) && bodySize(curr) < bodySize(prev)) {
            indices.push(i);
          }
        }
        return indices;
      },
    },
  ];

  const results: CandlestickPattern[] = [];

  for (const det of detectors) {
    const indices = det.detect();
    // Compute forward returns for detected pattern indices
    const returns1d: number[] = [];
    const returns5d: number[] = [];
    for (const idx of indices) {
      if (!isNaN(logReturn1d[idx])) returns1d.push(logReturn1d[idx]);
      if (!isNaN(logReturn5d[idx])) returns5d.push(logReturn5d[idx]);
    }

    const mean1d = mean(returns1d);
    const std1d = stddev(returns1d);
    const tStat = returns1d.length > 1 && std1d > 0
      ? mean1d / (std1d / Math.sqrt(returns1d.length))
      : 0;

    results.push({
      name: det.name,
      nameJa: det.nameJa,
      type: det.type,
      indices,
      stats: {
        count: indices.length,
        avgReturn1d: mean1d,
        avgReturn5d: mean(returns5d),
        winRate1d: returns1d.length > 0 ? returns1d.filter(r => r > 0).length / returns1d.length : 0,
        winRate5d: returns5d.length > 0 ? returns5d.filter(r => r > 0).length / returns5d.length : 0,
        tStat,
        significant: Math.abs(tStat) > 1.96,
      },
    });
  }

  return results;
}
