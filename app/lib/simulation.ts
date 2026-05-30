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

function logReturns(prices: PricePoint[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    r.push(Math.log(prices[i].close / prices[i - 1].close));
  }
  return r;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Simple seeded PRNG (mulberry32)
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── A. Monte Carlo Bootstrap (#19) ─────────────────────────────────

export interface MonteCarloResult {
  horizon: number;
  paths: number[][];
  percentiles: {
    p5: number[];
    p25: number[];
    p50: number[];
    p75: number[];
    p95: number[];
  };
  finalDistribution: {
    mean: number;
    std: number;
    skew: number;
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
  };
}

export function computeMonteCarlo(
  prices: PricePoint[],
  horizon: number = 60,
  nPaths: number = 1000,
): MonteCarloResult {
  const emptyResult: MonteCarloResult = {
    horizon,
    paths: [],
    percentiles: { p5: [], p25: [], p50: [], p75: [], p95: [] },
    finalDistribution: { mean: 0, std: 0, skew: 0, p5: 0, p25: 0, p50: 0, p75: 0, p95: 0 },
  };

  if (prices.length < 10) return emptyResult;

  const ret = logReturns(prices);
  if (ret.length < 5) return emptyResult;

  const rng = mulberry32(42);
  const allPaths: number[][] = [];

  for (let p = 0; p < nPaths; p++) {
    const path: number[] = [0];
    let cum = 0;
    for (let t = 0; t < horizon; t++) {
      const idx = Math.floor(rng() * ret.length);
      cum += ret[idx];
      path.push(cum);
    }
    allPaths.push(path);
  }

  // Compute percentile bands at each time step
  const p5: number[] = [];
  const p25: number[] = [];
  const p50: number[] = [];
  const p75: number[] = [];
  const p95: number[] = [];

  for (let t = 0; t <= horizon; t++) {
    const vals = allPaths.map(path => path[t]).sort((a, b) => a - b);
    p5.push(percentile(vals, 5));
    p25.push(percentile(vals, 25));
    p50.push(percentile(vals, 50));
    p75.push(percentile(vals, 75));
    p95.push(percentile(vals, 95));
  }

  // Final distribution
  const finals = allPaths.map(path => path[horizon]).sort((a, b) => a - b);

  // Select 500 paths for display
  const displayPaths = allPaths.slice(0, Math.min(500, nPaths));

  return {
    horizon,
    paths: displayPaths,
    percentiles: { p5, p25, p50, p75, p95 },
    finalDistribution: {
      mean: mean(finals),
      std: stddev(finals),
      skew: skewness(finals),
      p5: percentile(finals, 5),
      p25: percentile(finals, 25),
      p50: percentile(finals, 50),
      p75: percentile(finals, 75),
      p95: percentile(finals, 95),
    },
  };
}

// ─── B. GARCH-based VaR (#20) ───────────────────────────────────────

export interface GarchVarResult {
  dates: string[];
  returns: number[];
  conditionalVol: number[];
  var95: number[];
  var99: number[];
  violations95: number;
  violations99: number;
  expectedViolations95: number;
  expectedViolations99: number;
  kupiecTest95: { statistic: number; pValue: number; pass: boolean };
  kupiecTest99: { statistic: number; pValue: number; pass: boolean };
}

function chiSquaredPValue1(x: number): number {
  // Approximation of chi-squared CDF with 1 degree of freedom
  // P(X <= x) using the normal approximation: chi2(1) = Z^2
  if (x <= 0) return 1;
  const z = Math.sqrt(x);
  // Standard normal survival function approximation (Abramowitz & Stegun)
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014327; // 1/sqrt(2*pi)
  const p =
    d * Math.exp(-0.5 * z * z) *
    (t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))));
  // Two-tailed: P(chi2 > x) = 2 * P(Z > sqrt(x)) = 2 * p
  return 2 * p;
}

export function computeGarchVar(prices: PricePoint[]): GarchVarResult {
  const emptyResult: GarchVarResult = {
    dates: [], returns: [], conditionalVol: [], var95: [], var99: [],
    violations95: 0, violations99: 0, expectedViolations95: 0, expectedViolations99: 0,
    kupiecTest95: { statistic: 0, pValue: 1, pass: true },
    kupiecTest99: { statistic: 0, pValue: 1, pass: true },
  };

  if (prices.length < 30) return emptyResult;

  const ret = logReturns(prices);
  const dates = prices.slice(1).map(p => p.time);
  const n = ret.length;

  // Unconditional variance
  const mu = mean(ret);
  let uncondVar = 0;
  for (let i = 0; i < n; i++) uncondVar += (ret[i] - mu) ** 2;
  uncondVar /= n;

  // GARCH(1,1) parameters with variance targeting
  let alpha = 0.1;
  let beta = 0.85;

  // Iterate to refine (variance targeting approach)
  for (let iter = 0; iter < 20; iter++) {
    const omega = (1 - alpha - beta) * uncondVar;
    const sigma2: number[] = [uncondVar];

    for (let i = 1; i < n; i++) {
      sigma2.push(omega + alpha * (ret[i - 1] - mu) ** 2 + beta * sigma2[i - 1]);
    }

    // Simple update: adjust alpha/beta based on how well the model fits
    // Compute log-likelihood gradient approximation
    let sumRatio = 0;
    for (let i = 1; i < n; i++) {
      const eps2 = (ret[i] - mu) ** 2;
      sumRatio += eps2 / sigma2[i] - 1;
    }
    // Nudge alpha
    const grad = sumRatio / (n - 1);
    alpha = Math.max(0.01, Math.min(0.3, alpha + 0.001 * grad));
    beta = Math.max(0.5, Math.min(0.98, 0.95 - alpha));
  }

  const omega = (1 - alpha - beta) * uncondVar;
  const sigma2: number[] = [uncondVar];
  for (let i = 1; i < n; i++) {
    sigma2.push(Math.max(1e-10, omega + alpha * (ret[i - 1] - mu) ** 2 + beta * sigma2[i - 1]));
  }

  const conditionalVol = sigma2.map(Math.sqrt);
  const var95 = conditionalVol.map(s => mu - 1.645 * s);
  const var99 = conditionalVol.map(s => mu - 2.326 * s);

  // Count violations
  let violations95 = 0;
  let violations99 = 0;
  for (let i = 0; i < n; i++) {
    if (ret[i] < var95[i]) violations95++;
    if (ret[i] < var99[i]) violations99++;
  }

  const expectedViolations95 = n * 0.05;
  const expectedViolations99 = n * 0.01;

  // Kupiec test
  function kupiecLR(n1: number, n0: number, p: number): { statistic: number; pValue: number; pass: boolean } {
    const total = n1 + n0;
    if (total === 0 || n1 === 0 || n0 === 0) {
      return { statistic: 0, pValue: 1, pass: true };
    }
    const pHat = n1 / total;
    // LR = -2 * [n1*ln(p) + n0*ln(1-p) - n1*ln(pHat) - n0*ln(1-pHat)]
    const lr = -2 * (
      n1 * Math.log(p) + n0 * Math.log(1 - p) -
      n1 * Math.log(pHat) - n0 * Math.log(1 - pHat)
    );
    const pValue = chiSquaredPValue1(lr);
    return { statistic: lr, pValue, pass: pValue > 0.05 };
  }

  const kupiecTest95 = kupiecLR(violations95, n - violations95, 0.05);
  const kupiecTest99 = kupiecLR(violations99, n - violations99, 0.01);

  return {
    dates,
    returns: ret,
    conditionalVol,
    var95,
    var99,
    violations95,
    violations99,
    expectedViolations95,
    expectedViolations99,
    kupiecTest95,
    kupiecTest99,
  };
}
