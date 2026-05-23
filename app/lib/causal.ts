// Transfer Entropy, Granger Causality, Mutual Information

// ---- Mutual Information ----

export function mutualInformation(x: number[], y: number[], bins: number = 16): number {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0;

  const xMin = Math.min(...x), xMax = Math.max(...x);
  const yMin = Math.min(...y), yMax = Math.max(...y);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const joint = Array.from({ length: bins }, () => new Array(bins).fill(0));
  const margX = new Array(bins).fill(0);
  const margY = new Array(bins).fill(0);

  for (let i = 0; i < n; i++) {
    const bx = Math.min(Math.floor(((x[i] - xMin) / xRange) * bins), bins - 1);
    const by = Math.min(Math.floor(((y[i] - yMin) / yRange) * bins), bins - 1);
    joint[bx][by]++;
    margX[bx]++;
    margY[by]++;
  }

  let mi = 0;
  for (let bx = 0; bx < bins; bx++) {
    for (let by = 0; by < bins; by++) {
      if (joint[bx][by] > 0 && margX[bx] > 0 && margY[by] > 0) {
        const pxy = joint[bx][by] / n;
        const px = margX[bx] / n;
        const py = margY[by] / n;
        mi += pxy * Math.log2(pxy / (px * py));
      }
    }
  }
  return mi;
}

// Time-lagged auto-MI (nonlinear ACF)
export function timeLaggedMI(values: number[], maxLag: number = 30, bins: number = 16): number[] {
  const result: number[] = [];
  for (let lag = 0; lag <= maxLag; lag++) {
    const x = values.slice(0, values.length - lag);
    const y = values.slice(lag);
    result.push(mutualInformation(x, y, bins));
  }
  return result;
}

// ---- Transfer Entropy ----

export interface TransferEntropyResult {
  te_xy: number;  // X → Y
  te_yx: number;  // Y → X
  netFlow: number; // te_xy - te_yx
  significance: { te_xy_p: number; te_yx_p: number };
}

export function transferEntropy(
  x: number[], y: number[], lag: number = 1, bins: number = 8
): TransferEntropyResult {
  const n = Math.min(x.length, y.length);
  if (n < lag + 10) return { te_xy: 0, te_yx: 0, netFlow: 0, significance: { te_xy_p: 1, te_yx_p: 1 } };

  const te_xy = computeTE(x, y, lag, bins, n);
  const te_yx = computeTE(y, x, lag, bins, n);

  // Surrogate test (shuffle source)
  const nSurrogates = 50;
  let countXY = 0, countYX = 0;
  for (let s = 0; s < nSurrogates; s++) {
    const shuffledX = shuffle(x.slice());
    const shuffledY = shuffle(y.slice());
    if (computeTE(shuffledX, y, lag, bins, n) >= te_xy) countXY++;
    if (computeTE(shuffledY, x, lag, bins, n) >= te_yx) countYX++;
  }

  return {
    te_xy,
    te_yx,
    netFlow: te_xy - te_yx,
    significance: {
      te_xy_p: (countXY + 1) / (nSurrogates + 1),
      te_yx_p: (countYX + 1) / (nSurrogates + 1),
    },
  };
}

function computeTE(source: number[], target: number[], lag: number, bins: number, n: number): number {
  // TE(X→Y) = Σ p(y_{t+1}, y_t, x_t) * log[ p(y_{t+1}|y_t,x_t) / p(y_{t+1}|y_t) ]
  const tMin = Math.min(...target), tMax = Math.max(...target);
  const sMin = Math.min(...source), sMax = Math.max(...source);
  const tRange = tMax - tMin || 1;
  const sRange = sMax - sMin || 1;

  const count3d: number[][][] = Array.from({ length: bins }, () =>
    Array.from({ length: bins }, () => new Array(bins).fill(0))
  );
  const count2d: number[][] = Array.from({ length: bins }, () => new Array(bins).fill(0));
  let total = 0;

  for (let t = lag; t < n - 1; t++) {
    const yt1 = Math.min(Math.floor(((target[t + 1] - tMin) / tRange) * bins), bins - 1);
    const yt = Math.min(Math.floor(((target[t] - tMin) / tRange) * bins), bins - 1);
    const xt = Math.min(Math.floor(((source[t - lag + 1] - sMin) / sRange) * bins), bins - 1);
    count3d[yt1][yt][xt]++;
    count2d[yt1][yt]++;
    total++;
  }

  if (total === 0) return 0;

  // marginals
  const countYtXt: number[][] = Array.from({ length: bins }, () => new Array(bins).fill(0));
  const countYt: number[] = new Array(bins).fill(0);
  for (let a = 0; a < bins; a++) {
    for (let b = 0; b < bins; b++) {
      for (let c = 0; c < bins; c++) {
        countYtXt[b][c] += count3d[a][b][c];
      }
      countYt[b] += count2d[a][b];
    }
  }

  let te = 0;
  for (let a = 0; a < bins; a++) {
    for (let b = 0; b < bins; b++) {
      for (let c = 0; c < bins; c++) {
        if (count3d[a][b][c] > 0 && countYtXt[b][c] > 0 && count2d[a][b] > 0 && countYt[b] > 0) {
          const p3 = count3d[a][b][c] / total;
          const condJoint = count3d[a][b][c] / countYtXt[b][c];
          const condMarg = count2d[a][b] / countYt[b];
          te += p3 * Math.log2(condJoint / condMarg);
        }
      }
    }
  }
  return Math.max(0, te);
}

function shuffle(arr: number[]): number[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- Granger Causality ----

export interface GrangerResult {
  fStatistic: number;
  pValue: number;
  optimalLag: number;
  direction: "x→y" | "y→x" | "bidirectional" | "none";
  rssRestricted: number;
  rssUnrestricted: number;
}

export function grangerTest(
  x: number[], y: number[], maxLag: number = 5
): GrangerResult {
  const n = Math.min(x.length, y.length);

  // Find optimal lag via BIC
  let bestLag = 1, bestBIC = Infinity;
  for (let lag = 1; lag <= Math.min(maxLag, Math.floor(n / 5)); lag++) {
    const { rssU } = grangerRegression(x, y, lag, n);
    const k = 2 * lag + 1;
    const nEff = n - lag;
    const bic = nEff * Math.log(rssU / nEff) + k * Math.log(nEff);
    if (bic < bestBIC) { bestBIC = bic; bestLag = lag; }
  }

  // Test X → Y
  const { rssR: rssR_xy, rssU: rssU_xy } = grangerRegression(x, y, bestLag, n);
  const fStat_xy = computeFStat(rssR_xy, rssU_xy, bestLag, n);
  const pVal_xy = fToP(fStat_xy, bestLag, n - 2 * bestLag - 1);

  // Test Y → X
  const { rssR: rssR_yx, rssU: rssU_yx } = grangerRegression(y, x, bestLag, n);
  const fStat_yx = computeFStat(rssR_yx, rssU_yx, bestLag, n);
  const pVal_yx = fToP(fStat_yx, bestLag, n - 2 * bestLag - 1);

  const threshold = 0.05;
  let direction: GrangerResult["direction"] = "none";
  if (pVal_xy < threshold && pVal_yx < threshold) direction = "bidirectional";
  else if (pVal_xy < threshold) direction = "x→y";
  else if (pVal_yx < threshold) direction = "y→x";

  return {
    fStatistic: fStat_xy,
    pValue: pVal_xy,
    optimalLag: bestLag,
    direction,
    rssRestricted: rssR_xy,
    rssUnrestricted: rssU_xy,
  };
}

function grangerRegression(
  x: number[], y: number[], lag: number, n: number
): { rssR: number; rssU: number } {
  const nEff = n - lag;

  // Restricted: y_t = Σ a_i * y_{t-i} + e
  // Unrestricted: y_t = Σ a_i * y_{t-i} + Σ b_i * x_{t-i} + e
  let rssR = 0, rssU = 0;

  // Simple OLS via normal equations — for small lag this is fine
  // Build matrices
  const YVec: number[] = [];
  const XrMat: number[][] = [];
  const XuMat: number[][] = [];

  for (let t = lag; t < n; t++) {
    YVec.push(y[t]);
    const rowR: number[] = [1]; // intercept
    const rowU: number[] = [1];
    for (let i = 1; i <= lag; i++) {
      rowR.push(y[t - i]);
      rowU.push(y[t - i]);
    }
    for (let i = 1; i <= lag; i++) {
      rowU.push(x[t - i]);
    }
    XrMat.push(rowR);
    XuMat.push(rowU);
  }

  rssR = olsRSS(XrMat, YVec);
  rssU = olsRSS(XuMat, YVec);

  return { rssR, rssU };
}

function olsRSS(X: number[][], y: number[]): number {
  const n = X.length;
  const p = X[0].length;

  // X'X
  const XtX: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const XtY: number[] = new Array(p).fill(0);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      XtY[j] += X[i][j] * y[i];
      for (let k = 0; k < p; k++) {
        XtX[j][k] += X[i][j] * X[i][k];
      }
    }
  }

  // Solve XtX * beta = XtY (Gaussian elimination)
  const beta = solveLinear(XtX, XtY);
  if (!beta) return y.reduce((a, v) => a + v * v, 0); // fallback

  let rss = 0;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let j = 0; j < p; j++) pred += X[i][j] * beta[j];
    rss += (y[i] - pred) ** 2;
  }
  return rss;
}

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const aug = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    if (Math.abs(aug[col][col]) < 1e-12) return null;

    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / aug[col][col];
      for (let j = col; j <= n; j++) aug[row][j] -= factor * aug[col][j];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = aug[i][n];
    for (let j = i + 1; j < n; j++) x[i] -= aug[i][j] * x[j];
    x[i] /= aug[i][i];
  }
  return x;
}

function computeFStat(rssR: number, rssU: number, q: number, n: number): number {
  const dfU = n - 2 * q - 1;
  if (dfU <= 0 || rssU <= 0) return 0;
  return ((rssR - rssU) / q) / (rssU / dfU);
}

// Approximate F-distribution p-value
function fToP(f: number, df1: number, df2: number): number {
  if (f <= 0 || df2 <= 0) return 1;
  const x = df2 / (df2 + df1 * f);
  return betaIncomplete(df2 / 2, df1 / 2, x);
}

function betaIncomplete(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Simple continued fraction approximation
  const maxIter = 100;
  const eps = 1e-10;
  const lnBeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  let f = 1, c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let an = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + an * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + an / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    f *= d * c;

    an = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + an * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + an / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    const delta = d * c;
    f *= delta;
    if (Math.abs(delta - 1) < eps) break;
  }
  return front * f;
}

function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941678, 24.01409824083091,
    -1.231739572450155, 0.001208650973866179, -0.000005395239384953];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let sum = 1.000000000190015;
  for (let j = 0; j < 6; j++) sum += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * sum / x);
}
