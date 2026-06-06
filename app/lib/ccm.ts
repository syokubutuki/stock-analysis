// Convergent Cross Mapping (CCM)
// Sugihara et al. 2012 - Nonlinear causality via Takens embedding

import { PricePoint } from "./types";

export interface CCMPoint {
  librarySize: number;
  rho: number;
}

/** Per-trial rho values at each library size */
export interface CCMTrialPoint {
  librarySize: number;
  trialRhos: number[];
  meanRho: number;
}

/** Cross-map prediction vs actual at largest library size */
export interface CCMScatter {
  predicted: number[];
  actual: number[];
  rho: number;
}

export interface CCMDetailedResult {
  points: CCMPoint[];
  trials: CCMTrialPoint[];
  scatter: CCMScatter;
}

export interface CCMResult {
  returnToVol: CCMPoint[];
  volToReturn: CCMPoint[];
  returnToVolume: CCMPoint[];
  volumeToReturn: CCMPoint[];
  convergenceReturnVol: boolean;
  convergenceReturnVolume: boolean;
  interpretation: string;
  // Intermediate data
  detailed: {
    returnToVol: CCMDetailedResult;
    volToReturn: CCMDetailedResult;
    returnToVolume: CCMDetailedResult;
    volumeToReturn: CCMDetailedResult;
  };
  inputSeries: {
    returns: number[];
    absReturns: number[];
    volumeChanges: number[];
  };
}

/**
 * Takens embedding: create shadow manifold
 */
function embed(values: number[], E: number, tau: number): number[][] {
  const n = values.length - (E - 1) * tau;
  if (n <= 0) return [];
  const embedded: number[][] = [];
  for (let i = 0; i < n; i++) {
    const point: number[] = [];
    for (let d = 0; d < E; d++) {
      point.push(values[i + d * tau]);
    }
    embedded.push(point);
  }
  return embedded;
}

/**
 * Euclidean distance between two points
 */
function dist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

/**
 * Cross-map prediction: predict Y from X's shadow manifold
 * Returns correlation and optionally the prediction/actual arrays
 */
function crossMap(
  Mx: number[][], // X's shadow manifold
  y: number[], // target Y values (aligned with Mx)
  E: number,
  libIndices: number[],
  returnScatter?: boolean
): { rho: number; predicted: number[]; actual: number[] } {
  const nn = E + 1; // number of nearest neighbors
  const predictions: number[] = [];
  const actuals: number[] = [];

  for (const idx of libIndices) {
    // Find nn nearest neighbors (excluding self)
    const distances: { d: number; i: number }[] = [];
    for (const j of libIndices) {
      if (j === idx) continue;
      distances.push({ d: dist(Mx[idx], Mx[j]), i: j });
    }
    distances.sort((a, b) => a.d - b.d);

    const neighbors = distances.slice(0, nn);
    if (neighbors.length < nn) continue;

    // Weights: w_i = exp(-d_i / d_1) normalized
    const d1 = Math.max(neighbors[0].d, 1e-10);
    const weights = neighbors.map((nb) => Math.exp(-nb.d / d1));
    const wSum = weights.reduce((a, b) => a + b, 0);

    if (wSum < 1e-15) continue;

    // Predicted Y
    let yPred = 0;
    for (let k = 0; k < neighbors.length; k++) {
      yPred += (weights[k] / wSum) * y[neighbors[k].i];
    }

    predictions.push(yPred);
    actuals.push(y[idx]);
  }

  // Pearson correlation
  const rho = predictions.length < 5 ? 0 : pearsonCorr(predictions, actuals);
  return {
    rho,
    predicted: returnScatter ? predictions : [],
    actual: returnScatter ? actuals : [],
  };
}

function pearsonCorr(x: number[], y: number[]): number {
  const n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;

  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }

  const denom = Math.sqrt(vx * vy);
  return denom > 1e-15 ? cov / denom : 0;
}

/**
 * Compute CCM between two series at multiple library sizes
 * Returns detailed results including per-trial rho and scatter data
 */
export function computeCCMDetailed(
  x: number[],
  y: number[],
  E: number = 3,
  tau: number = 1,
  libSizes?: number[]
): CCMDetailedResult {
  const emptyResult: CCMDetailedResult = {
    points: [],
    trials: [],
    scatter: { predicted: [], actual: [], rho: 0 },
  };

  // Subsample for performance
  const maxN = 1000;
  let xSub = x;
  let ySub = y;
  if (x.length > maxN) {
    const stride = Math.ceil(x.length / maxN);
    xSub = x.filter((_, i) => i % stride === 0);
    ySub = y.filter((_, i) => i % stride === 0);
  }

  const Mx = embed(xSub, E, tau);
  const n = Mx.length;
  if (n < 20) return emptyResult;

  // Align Y to embedding
  const yAligned = ySub.slice((E - 1) * tau);
  if (yAligned.length < n) return emptyResult;

  // Library sizes
  const defaultSizes = [20, 50, 100, 200, 500, n].filter((s) => s <= n && s >= E + 2);
  const sizes = libSizes || defaultSizes;

  const rng = mulberry32Ccm(42);
  const nTrials = 5;

  const points: CCMPoint[] = [];
  const trials: CCMTrialPoint[] = [];

  for (let si = 0; si < sizes.length; si++) {
    const L = sizes[si];
    const isLast = si === sizes.length - 1;
    const trialRhos: number[] = [];
    let lastScatter: { predicted: number[]; actual: number[] } = { predicted: [], actual: [] };

    for (let trial = 0; trial < nTrials; trial++) {
      const indices = Array.from({ length: n }, (_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      const libIndices = indices.slice(0, L);

      const res = crossMap(Mx, yAligned, E, libIndices, isLast && trial === 0);
      trialRhos.push(res.rho);
      if (isLast && trial === 0) {
        lastScatter = { predicted: res.predicted, actual: res.actual };
      }
    }

    const meanRho = trialRhos.reduce((a, b) => a + b, 0) / nTrials;
    points.push({ librarySize: L, rho: meanRho });
    trials.push({ librarySize: L, trialRhos, meanRho });

    if (isLast) {
      return {
        points,
        trials,
        scatter: { ...lastScatter, rho: meanRho },
      };
    }
  }

  return { points, trials, scatter: { predicted: [], actual: [], rho: 0 } };
}

/** Backward-compatible wrapper */
export function computeCCM(
  x: number[],
  y: number[],
  E: number = 3,
  tau: number = 1,
  libSizes?: number[]
): CCMPoint[] {
  return computeCCMDetailed(x, y, E, tau, libSizes).points;
}

function mulberry32Ccm(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Full CCM analysis between return, volatility, and volume
 */
export function fullCCMAnalysis(prices: PricePoint[]): CCMResult {
  const emptyDetailed: CCMDetailedResult = {
    points: [],
    trials: [],
    scatter: { predicted: [], actual: [], rho: 0 },
  };
  const empty: CCMResult = {
    returnToVol: [],
    volToReturn: [],
    returnToVolume: [],
    volumeToReturn: [],
    convergenceReturnVol: false,
    convergenceReturnVolume: false,
    interpretation: "データが不足しています。",
    detailed: {
      returnToVol: emptyDetailed,
      volToReturn: emptyDetailed,
      returnToVolume: emptyDetailed,
      volumeToReturn: emptyDetailed,
    },
    inputSeries: { returns: [], absReturns: [], volumeChanges: [] },
  };

  if (prices.length < 60) return empty;

  // Compute returns
  const returns: number[] = [];
  const absReturns: number[] = []; // proxy for volatility
  const volumeChanges: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    const r = prices[i - 1].close > 0
      ? Math.log(prices[i].close / prices[i - 1].close)
      : 0;
    returns.push(r);
    absReturns.push(Math.abs(r));
    const vc = prices[i - 1].volume > 0
      ? Math.log(prices[i].volume / prices[i - 1].volume)
      : 0;
    volumeChanges.push(vc);
  }

  // CCM with detailed results
  const dReturnToVol = computeCCMDetailed(returns, absReturns, 3, 1);
  const dVolToReturn = computeCCMDetailed(absReturns, returns, 3, 1);
  const dReturnToVolume = computeCCMDetailed(returns, volumeChanges, 3, 1);
  const dVolumeToReturn = computeCCMDetailed(volumeChanges, returns, 3, 1);

  // Convergence test: rho increases with library size
  const checkConvergence = (pts: CCMPoint[]): boolean => {
    if (pts.length < 3) return false;
    const first = pts[0].rho;
    const last = pts[pts.length - 1].rho;
    return last > first + 0.05 && last > 0.1;
  };

  const convergenceReturnVol = checkConvergence(dReturnToVol.points);
  const convergenceReturnVolume = checkConvergence(dReturnToVolume.points);

  // Interpretation
  const parts: string[] = [];

  if (convergenceReturnVol) {
    parts.push("リターン→ボラティリティの因果関係が示唆されます（レバレッジ効果と整合的）");
  }
  if (checkConvergence(dVolToReturn.points)) {
    parts.push("ボラティリティ→リターンの因果関係が示唆されます（ボラティリティフィードバック）");
  }
  if (convergenceReturnVolume) {
    parts.push("リターン→出来高の因果関係が示唆されます");
  }
  if (checkConvergence(dVolumeToReturn.points)) {
    parts.push("出来高→リターンの因果関係が示唆されます");
  }

  const interpretation =
    parts.length > 0
      ? `CCM非線形因果分析: ${parts.join("。")}。ライブラリサイズ増加に伴う予測精度の収束が因果の証拠です。`
      : "CCM分析では明確な非線形因果関係は検出されませんでした。Granger因果（線形）も併せて確認してください。";

  return {
    returnToVol: dReturnToVol.points,
    volToReturn: dVolToReturn.points,
    returnToVolume: dReturnToVolume.points,
    volumeToReturn: dVolumeToReturn.points,
    convergenceReturnVol,
    convergenceReturnVolume,
    interpretation,
    detailed: {
      returnToVol: dReturnToVol,
      volToReturn: dVolToReturn,
      returnToVolume: dReturnToVolume,
      volumeToReturn: dVolumeToReturn,
    },
    inputSeries: { returns, absReturns, volumeChanges },
  };
}
