// R/S Analysis, DCCA (Detrended Cross-Correlation), Correlation Dimension

// ---- R/S Analysis (Rescaled Range) ----

export interface RSResult {
  hurst: number;
  scales: number[];
  rsValues: number[];
  confidence: [number, number]; // 95% CI
  interpretation: string;
}

export function rsAnalysis(values: number[]): RSResult {
  const n = values.length;
  const scales: number[] = [];
  const rsValues: number[] = [];

  // Divide into segments of size s, compute R/S for each
  for (let s = 10; s <= Math.floor(n / 2); s = Math.ceil(s * 1.3)) {
    const numSegs = Math.floor(n / s);
    if (numSegs < 2) break;

    let rsSum = 0;
    for (let seg = 0; seg < numSegs; seg++) {
      const start = seg * s;
      const segment = values.slice(start, start + s);
      const mean = segment.reduce((a, b) => a + b, 0) / s;

      // Cumulative deviations
      const cumDev: number[] = [];
      let cum = 0;
      for (let i = 0; i < s; i++) {
        cum += segment[i] - mean;
        cumDev.push(cum);
      }

      const R = Math.max(...cumDev) - Math.min(...cumDev);
      const S = Math.sqrt(segment.reduce((a, v) => a + (v - mean) ** 2, 0) / s);

      if (S > 0) rsSum += R / S;
    }

    scales.push(s);
    rsValues.push(rsSum / numSegs);
  }

  // Log-log regression
  const logS = scales.map(Math.log);
  const logRS = rsValues.map((v) => Math.log(v + 1e-20));
  const { slope, slopeErr } = linearRegression(logS, logRS);

  const hurst = slope;
  const confidence: [number, number] = [
    hurst - 1.96 * slopeErr,
    hurst + 1.96 * slopeErr,
  ];

  let interpretation: string;
  if (hurst < 0.4) interpretation = "強い反平均回帰 (anti-persistent)";
  else if (hurst < 0.45) interpretation = "弱い反平均回帰";
  else if (hurst < 0.55) interpretation = "ランダムウォーク";
  else if (hurst < 0.6) interpretation = "弱いトレンド持続性";
  else interpretation = "強いトレンド持続性 (persistent)";

  return { hurst, scales, rsValues, confidence, interpretation };
}

// ---- DCCA (Detrended Cross-Correlation Analysis) ----

export interface DCCAResult {
  scales: number[];
  rho: number[];      // DCCA correlation coefficient per scale
  crossHurst: number;
  fxx: number[];      // DFA of x
  fyy: number[];      // DFA of y
  fxy: number[];      // Cross-fluctuation
}

export function computeDCCA(x: number[], y: number[]): DCCAResult {
  const n = Math.min(x.length, y.length);

  // Cumulative sums (profiles)
  const meanX = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const meanY = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const profileX: number[] = [0];
  const profileY: number[] = [0];
  for (let i = 0; i < n; i++) {
    profileX.push(profileX[i] + (x[i] - meanX));
    profileY.push(profileY[i] + (y[i] - meanY));
  }

  const scales: number[] = [];
  const fxx: number[] = [];
  const fyy: number[] = [];
  const fxy: number[] = [];
  const rho: number[] = [];

  for (let s = 8; s <= Math.floor(n / 4); s = Math.ceil(s * 1.3)) {
    const numSegs = Math.floor(n / s);
    if (numSegs < 2) break;

    let sumXX = 0, sumYY = 0, sumXY = 0;

    for (let seg = 0; seg < numSegs; seg++) {
      const start = seg * s;
      // Linear detrend each segment
      const detX = detrendSegment(profileX, start, s);
      const detY = detrendSegment(profileY, start, s);

      let sxx = 0, syy = 0, sxy = 0;
      for (let i = 0; i < s; i++) {
        sxx += detX[i] * detX[i];
        syy += detY[i] * detY[i];
        sxy += detX[i] * detY[i];
      }
      sumXX += sxx / s;
      sumYY += syy / s;
      sumXY += sxy / s;
    }

    const avgXX = sumXX / numSegs;
    const avgYY = sumYY / numSegs;
    const avgXY = sumXY / numSegs;

    scales.push(s);
    fxx.push(Math.sqrt(avgXX));
    fyy.push(Math.sqrt(avgYY));
    fxy.push(avgXY);
    rho.push(avgXY / (Math.sqrt(avgXX * avgYY) || 1e-20));
  }

  // Cross-Hurst from log-log slope of |F_xy|
  const logS = scales.map(Math.log);
  const logFxy = fxy.map((v) => Math.log(Math.abs(v) + 1e-20));
  const { slope } = linearRegression(logS, logFxy);
  const crossHurst = slope / 2;

  return { scales, rho, crossHurst, fxx, fyy, fxy };
}

function detrendSegment(profile: number[], start: number, s: number): number[] {
  // Linear least squares detrend
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < s; i++) {
    xs.push(i);
    ys.push(profile[start + i + 1]);
  }
  const { intercept, slope } = linearRegressionSimple(xs, ys);
  return ys.map((y, i) => y - (intercept + slope * i));
}

function linearRegressionSimple(x: number[], y: number[]): { slope: number; intercept: number } {
  const n = x.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i]; sxy += x[i] * y[i]; sxx += x[i] * x[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

// ---- Correlation Dimension (Grassberger-Procaccia) ----

export interface CorrelationDimensionResult {
  dimension: number;
  logR: number[];
  logC: number[];
  scalingRegion: [number, number]; // indices of linear region
}

export function correlationDimension(
  values: number[],
  embeddingDim: number = 3,
  tau: number = 1,
  numRPoints: number = 20
): CorrelationDimensionResult {
  const n = values.length;
  const nEmb = n - (embeddingDim - 1) * tau;
  if (nEmb < 20) {
    return { dimension: 0, logR: [], logC: [], scalingRegion: [0, 0] };
  }

  // Takens embedding
  const embedded: number[][] = [];
  for (let i = 0; i < nEmb; i++) {
    const vec: number[] = [];
    for (let d = 0; d < embeddingDim; d++) {
      vec.push(values[i + d * tau]);
    }
    embedded.push(vec);
  }

  // Compute pairwise distances (subsample if too many points)
  const maxPoints = Math.min(nEmb, 300);
  const step = Math.max(1, Math.floor(nEmb / maxPoints));
  const points = embedded.filter((_, i) => i % step === 0);
  const np = points.length;

  const distances: number[] = [];
  for (let i = 0; i < np; i++) {
    for (let j = i + 1; j < np; j++) {
      let d = 0;
      for (let k = 0; k < embeddingDim; k++) {
        d += (points[i][k] - points[j][k]) ** 2;
      }
      distances.push(Math.sqrt(d));
    }
  }
  distances.sort((a, b) => a - b);

  const minDist = distances[Math.floor(distances.length * 0.01)] || 1e-10;
  const maxDist = distances[Math.floor(distances.length * 0.99)] || 1;

  const logR: number[] = [];
  const logC: number[] = [];
  const nPairs = distances.length;

  for (let i = 0; i < numRPoints; i++) {
    const logri = Math.log(minDist) + (i / (numRPoints - 1)) * (Math.log(maxDist) - Math.log(minDist));
    const r = Math.exp(logri);
    // C(r) = fraction of pairs with distance < r
    let count = 0;
    for (const d of distances) {
      if (d < r) count++;
      else break; // distances are sorted
    }
    const cr = count / nPairs;
    if (cr > 0) {
      logR.push(logri);
      logC.push(Math.log(cr));
    }
  }

  // Find scaling region (middle portion of the curve)
  const start = Math.floor(logR.length * 0.2);
  const end = Math.floor(logR.length * 0.8);
  const { slope } = linearRegression(logR.slice(start, end), logC.slice(start, end));

  return { dimension: slope, logR, logC, scalingRegion: [start, end] };
}

// ---- Utility ----

function linearRegression(x: number[], y: number[]): { slope: number; intercept: number; slopeErr: number } {
  const n = x.length;
  if (n < 2) return { slope: 0, intercept: 0, slopeErr: 0 };
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i]; sxy += x[i] * y[i]; sxx += x[i] * x[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;

  // Standard error of slope
  let ssr = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * x[i];
    ssr += (y[i] - pred) ** 2;
  }
  const mse = ssr / Math.max(1, n - 2);
  const slopeErr = denom !== 0 ? Math.sqrt(mse * n / denom) : 0;

  return { slope, intercept, slopeErr };
}
