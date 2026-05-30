// OHLC Extended Analysis: Intraday Path Estimation, Close Position, True Range Decomposition

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

// ========== A. Intraday Path Estimation ==========

export interface IntradayPathResult {
  patterns: {
    name: string;
    description: string;
    count: number;
    pct: number;
    avgNextReturn: number;
    winRate: number;
  }[];
  ohRatio: number[];
  olRatio: number[];
  dates: string[];
}

export function computeIntradayPath(prices: PricePoint[]): IntradayPathResult {
  const empty: IntradayPathResult = { patterns: [], ohRatio: [], olRatio: [], dates: [] };
  if (prices.length < 5) return empty;

  const n = prices.length;
  const dates: string[] = [];
  const ohRatio: number[] = [];
  const olRatio: number[] = [];

  // Classify each day
  const dayPatterns: number[] = []; // 0-3
  const patternNames = [
    "OH→OL",
    "OL→OH",
    "OH→OL→Close down",
    "OL→OH→Close down",
  ];
  const patternDescs = [
    "高値先行の上昇日",
    "安値先行の反転上昇日",
    "高値先行の反転下落日",
    "安値先行の下落日",
  ];

  for (let i = 0; i < n; i++) {
    const { open, high, low, close } = prices[i];
    const range = high - low;
    dates.push(prices[i].time);

    if (range <= 0) {
      ohRatio.push(0.5);
      olRatio.push(0.5);
      dayPatterns.push(-1);
      continue;
    }

    const oh = high - open;   // distance open to high
    const ol = open - low;    // distance open to low
    const bullish = close > open;

    ohRatio.push(oh / range);
    olRatio.push(ol / range);

    if (oh > ol && bullish) {
      dayPatterns.push(0); // OH→OL (bullish, high first)
    } else if (ol > oh && bullish) {
      dayPatterns.push(1); // OL→OH (bullish reversal)
    } else if (oh > ol && !bullish) {
      dayPatterns.push(2); // OH→OL→Close down (bearish reversal)
    } else {
      dayPatterns.push(3); // OL→OH→Close down (bearish, low first)
    }
  }

  // For each pattern compute next-day log return stats
  const patternReturns: number[][] = [[], [], [], []];
  for (let i = 0; i < n - 1; i++) {
    const p = dayPatterns[i];
    if (p < 0) continue;
    const c0 = prices[i].close;
    const c1 = prices[i + 1].close;
    if (c0 > 0 && c1 > 0) {
      patternReturns[p].push(Math.log(c1 / c0));
    }
  }

  const total = dayPatterns.filter(p => p >= 0).length;
  const patterns = patternNames.map((name, idx) => {
    const rets = patternReturns[idx];
    const count = dayPatterns.filter(p => p === idx).length;
    return {
      name,
      description: patternDescs[idx],
      count,
      pct: total > 0 ? count / total : 0,
      avgNextReturn: mean(rets),
      winRate: rets.length > 0 ? rets.filter(r => r > 0).length / rets.length : 0,
    };
  });

  return { patterns, ohRatio, olRatio, dates };
}

// ========== B. Close Position Analysis ==========

export interface ClosePositionResult {
  dates: string[];
  closePosition: number[];
  rollingAvg: number[];
  bucketReturns: { range: string; avgReturn: number; winRate: number; n: number }[];
}

export function computeClosePosition(prices: PricePoint[]): ClosePositionResult {
  const empty: ClosePositionResult = { dates: [], closePosition: [], rollingAvg: [], bucketReturns: [] };
  if (prices.length < 5) return empty;

  const n = prices.length;
  const dates = prices.map(p => p.time);
  const closePosition: number[] = [];

  for (let i = 0; i < n; i++) {
    const range = prices[i].high - prices[i].low;
    if (range <= 0) {
      closePosition.push(0.5);
    } else {
      closePosition.push((prices[i].close - prices[i].low) / range);
    }
  }

  // 20-day rolling average
  const rollingAvg: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < 19) {
      rollingAvg.push(NaN);
    } else {
      let sum = 0;
      for (let j = i - 19; j <= i; j++) sum += closePosition[j];
      rollingAvg.push(sum / 20);
    }
  }

  // Log returns
  const logReturns: number[] = [NaN];
  for (let i = 1; i < n; i++) {
    const c0 = prices[i - 1].close;
    const c1 = prices[i].close;
    logReturns.push(c0 > 0 && c1 > 0 ? Math.log(c1 / c0) : NaN);
  }

  // Split closePosition into 5 buckets and compute next-day return
  const bucketLabels = ["0-20%", "20-40%", "40-60%", "60-80%", "80-100%"];
  const bucketReturns: ClosePositionResult["bucketReturns"] = [];

  for (let b = 0; b < 5; b++) {
    const lo = b * 0.2;
    const hi = (b + 1) * 0.2;
    const rets: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const cp = closePosition[i];
      if (cp >= lo && (b === 4 ? cp <= hi : cp < hi) && !isNaN(logReturns[i + 1])) {
        rets.push(logReturns[i + 1]);
      }
    }
    bucketReturns.push({
      range: bucketLabels[b],
      avgReturn: mean(rets),
      winRate: rets.length > 0 ? rets.filter(r => r > 0).length / rets.length : 0,
      n: rets.length,
    });
  }

  return {
    dates,
    closePosition,
    rollingAvg: rollingAvg.map(v => isNaN(v) ? 0 : v),
    bucketReturns,
  };
}

// ========== C. True Range Decomposition ==========

export interface TRDecompResult {
  dates: string[];
  trueRange: number[];
  hlComponent: number[];
  gapUpComponent: number[];
  gapDownComponent: number[];
  gapContribution: number[];
  dominantComponent: ("intraday" | "gapUp" | "gapDown")[];
}

export function computeTRDecomp(prices: PricePoint[]): TRDecompResult {
  const empty: TRDecompResult = {
    dates: [], trueRange: [], hlComponent: [], gapUpComponent: [],
    gapDownComponent: [], gapContribution: [], dominantComponent: [],
  };
  if (prices.length < 3) return empty;

  const n = prices.length;
  const dates: string[] = [prices[0].time];
  const trueRange: number[] = [prices[0].high - prices[0].low];
  const hlComponent: number[] = [prices[0].high - prices[0].low];
  const gapUpComponent: number[] = [0];
  const gapDownComponent: number[] = [0];
  const dominantComponent: ("intraday" | "gapUp" | "gapDown")[] = ["intraday"];

  for (let i = 1; i < n; i++) {
    const { high, low } = prices[i];
    const prevClose = prices[i - 1].close;

    const hl = high - low;
    const gapUp = Math.abs(high - prevClose);
    const gapDown = Math.abs(low - prevClose);

    const tr = Math.max(hl, gapUp, gapDown);

    dates.push(prices[i].time);
    trueRange.push(tr);
    hlComponent.push(hl);
    gapUpComponent.push(gapUp);
    gapDownComponent.push(gapDown);

    // Determine dominant component
    if (hl >= gapUp && hl >= gapDown) {
      dominantComponent.push("intraday");
    } else if (gapUp >= gapDown) {
      dominantComponent.push("gapUp");
    } else {
      dominantComponent.push("gapDown");
    }
  }

  // Rolling 20-day gap contribution ratio
  const gapContribution: number[] = [];
  for (let i = 0; i < dates.length; i++) {
    if (i < 19) {
      gapContribution.push(0);
      continue;
    }
    let sumTR = 0;
    let sumGap = 0;
    for (let j = i - 19; j <= i; j++) {
      sumTR += trueRange[j];
      // Gap component = TR - HL when gap dominates, otherwise 0
      const gapPart = Math.max(0, trueRange[j] - hlComponent[j]);
      sumGap += gapPart;
    }
    gapContribution.push(sumTR > 0 ? sumGap / sumTR : 0);
  }

  return { dates, trueRange, hlComponent, gapUpComponent, gapDownComponent, gapContribution, dominantComponent };
}
