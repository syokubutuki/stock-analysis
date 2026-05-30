// Regime Extended: Distribution by Regime, Regime Transitions

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

function skewness(v: number[]): number {
  if (v.length < 3) return 0;
  const m = mean(v);
  const s = stddev(v);
  if (s === 0) return 0;
  return (v.reduce((a, x) => a + ((x - m) / s) ** 3, 0)) / v.length;
}

function kurtosis(v: number[]): number {
  if (v.length < 4) return 0;
  const m = mean(v);
  const s = stddev(v);
  if (s === 0) return 0;
  return (v.reduce((a, x) => a + ((x - m) / s) ** 4, 0)) / v.length - 3;
}

// Classify each day into regime 0,1,2 using 20-day rolling volatility terciles
function classifyRegimes(prices: PricePoint[]): { logReturns: number[]; regimes: number[] } {
  const closes = prices.map(p => p.close);
  const n = closes.length;

  const lr: number[] = [];
  for (let i = 1; i < n; i++) {
    lr.push(closes[i - 1] > 0 && closes[i] > 0 ? Math.log(closes[i] / closes[i - 1]) : 0);
  }

  const volWindow = 20;
  const rollingVol: number[] = [];
  for (let i = 0; i < lr.length; i++) {
    if (i < volWindow - 1) {
      rollingVol.push(0);
      continue;
    }
    const slice = lr.slice(i - volWindow + 1, i + 1);
    rollingVol.push(stddev(slice));
  }

  const validVols = rollingVol.filter(v => v > 0);
  const sortedVols = [...validVols].sort((a, b) => a - b);
  const q33 = sortedVols[Math.floor(sortedVols.length * 0.33)] || 0;
  const q66 = sortedVols[Math.floor(sortedVols.length * 0.66)] || Infinity;

  const regimes = rollingVol.map(v => (v <= q33 ? 0 : v <= q66 ? 1 : 2));

  return { logReturns: lr, regimes };
}

// Gaussian KDE
function gaussianKDE(data: number[], nPoints: number): { x: number; y: number }[] {
  if (data.length === 0) return [];
  const sorted = [...data].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const range = max - min;
  if (range === 0) return [{ x: min, y: 1 }];

  // Silverman bandwidth
  const s = stddev(data);
  const iqrIdx25 = Math.floor(data.length * 0.25);
  const iqrIdx75 = Math.floor(data.length * 0.75);
  const sortedData = [...data].sort((a, b) => a - b);
  const iqr = sortedData[iqrIdx75] - sortedData[iqrIdx25];
  const h = 0.9 * Math.min(s, iqr / 1.34) * Math.pow(data.length, -0.2);
  const bandwidth = h > 0 ? h : 0.01;

  const margin = range * 0.1;
  const xMin = min - margin;
  const xMax = max + margin;
  const step = (xMax - xMin) / (nPoints - 1);

  const result: { x: number; y: number }[] = [];
  const invSqrt2Pi = 1 / Math.sqrt(2 * Math.PI);

  for (let i = 0; i < nPoints; i++) {
    const x = xMin + i * step;
    let sum = 0;
    for (const d of data) {
      const z = (x - d) / bandwidth;
      sum += invSqrt2Pi * Math.exp(-0.5 * z * z);
    }
    result.push({ x, y: sum / (data.length * bandwidth) });
  }

  return result;
}

// ========== A. Regime Distribution ==========

export interface RegimeDistResult {
  regimes: {
    label: string;
    color: string;
    returns: number[];
    mean: number;
    std: number;
    skew: number;
    kurtosis: number;
    n: number;
    kde: { x: number; y: number }[];
  }[];
}

export function computeRegimeDistribution(prices: PricePoint[]): RegimeDistResult {
  const empty: RegimeDistResult = { regimes: [] };
  if (prices.length < 25) return empty;

  const { logReturns, regimes } = classifyRegimes(prices);

  const labels = ["低ボラティリティ", "中ボラティリティ", "高ボラティリティ"];
  const colors = ["#22c55e", "#f59e0b", "#ef4444"]; // green, amber, red

  const result: RegimeDistResult = { regimes: [] };

  for (let r = 0; r < 3; r++) {
    const rets: number[] = [];
    for (let i = 0; i < regimes.length; i++) {
      if (regimes[i] === r) {
        rets.push(logReturns[i]);
      }
    }

    result.regimes.push({
      label: labels[r],
      color: colors[r],
      returns: rets,
      mean: mean(rets),
      std: stddev(rets),
      skew: skewness(rets),
      kurtosis: kurtosis(rets),
      n: rets.length,
      kde: gaussianKDE(rets, 100),
    });
  }

  return result;
}

// ========== B. Regime Transition ==========

export interface RegimeTransitionResult {
  dates: string[];
  regimeStates: number[];
  rollingMatrix: {
    date: string;
    matrix: number[][];
  }[];
  overallMatrix: number[][];
  avgDuration: number[];
}

export function computeRegimeTransition(prices: PricePoint[], rollingWindow?: number): RegimeTransitionResult {
  const window = rollingWindow ?? 120;
  const empty: RegimeTransitionResult = {
    dates: [],
    regimeStates: [],
    rollingMatrix: [],
    overallMatrix: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    avgDuration: [0, 0, 0],
  };
  if (prices.length < 25) return empty;

  const { logReturns, regimes } = classifyRegimes(prices);

  // dates correspond to logReturns (offset by 1 from prices)
  const dates = prices.slice(1).map(p => p.time);

  // Overall transition matrix
  const counts: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < regimes.length - 1; i++) {
    counts[regimes[i]][regimes[i + 1]]++;
  }

  const overallMatrix: number[][] = counts.map(row => {
    const total = row.reduce((a, b) => a + b, 0);
    return total > 0 ? row.map(c => c / total) : [0, 0, 0];
  });

  // Rolling transition matrix
  const rollingMatrix: RegimeTransitionResult["rollingMatrix"] = [];
  for (let i = window; i < regimes.length; i++) {
    const rc: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let j = i - window; j < i - 1; j++) {
      rc[regimes[j]][regimes[j + 1]]++;
    }
    const mat = rc.map(row => {
      const total = row.reduce((a, b) => a + b, 0);
      return total > 0 ? row.map(c => c / total) : [0, 0, 0];
    });
    rollingMatrix.push({ date: dates[i], matrix: mat });
  }

  // Average duration in each regime
  const durations: number[][] = [[], [], []];
  let currentRegime = regimes[0];
  let currentDuration = 1;
  for (let i = 1; i < regimes.length; i++) {
    if (regimes[i] === currentRegime) {
      currentDuration++;
    } else {
      durations[currentRegime].push(currentDuration);
      currentRegime = regimes[i];
      currentDuration = 1;
    }
  }
  // Push last segment
  durations[currentRegime].push(currentDuration);

  const avgDuration = durations.map(d => mean(d));

  return {
    dates,
    regimeStates: regimes,
    rollingMatrix,
    overallMatrix,
    avgDuration,
  };
}
