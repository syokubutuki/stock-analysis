// リアプノフスペクトル解析: 全スペクトル計算, ベクトル分解, カプラン-ヨーク次元

// ============================================================
// 1. リアプノフスペクトル (全指数の計算)
// ============================================================

export interface LyapunovSpectrumResult {
  exponents: number[];         // λ⁽¹⁾ ≥ λ⁽²⁾ ≥ ... ≥ λ⁽ᴺ⁾
  dim: number;
  tau: number;
  kaplanYorkeDim: number;
  kolmogorovSinaiEntropy: number; // Σ λᵢ>0
  attractorVolume: number;        // Σ λᵢ (体積収縮率)
}

export function computeLyapunovSpectrum(
  values: number[],
  tau: number = 1,
  dim: number = 5,
  evolveSteps: number = 4,
  transient: number = 20
): LyapunovSpectrumResult {
  const n = values.length - (dim - 1) * tau;
  if (n < 50) {
    return { exponents: new Array(dim).fill(0), dim, tau, kaplanYorkeDim: 0, kolmogorovSinaiEntropy: 0, attractorVolume: 0 };
  }

  // Build embedding vectors
  const vectors: number[][] = [];
  for (let i = 0; i < n; i++) {
    const vec: number[] = [];
    for (let d = 0; d < dim; d++) vec.push(values[i + d * tau]);
    vectors.push(vec);
  }

  // Initialize orthonormal perturbation matrix (dim x dim)
  let Q = identityMatrix(dim);
  const lyapSums = new Float64Array(dim);
  let totalSteps = 0;

  // Sample reference points
  const sampleSize = Math.min(n - evolveSteps - 1, 150);
  const step = Math.max(1, Math.floor((n - evolveSteps - 1) / sampleSize));

  for (let refIdx = transient; refIdx < n - evolveSteps - 1; refIdx += step) {
    // Find nearest neighbor (Theiler window exclusion)
    let nnIdx = -1;
    let minDist = Infinity;
    for (let j = 0; j < n - evolveSteps - 1; j++) {
      if (Math.abs(j - refIdx) < dim * tau + 1) continue;
      const d = vecDist(vectors[refIdx], vectors[j]);
      if (d < minDist && d > 1e-10) {
        minDist = d;
        nnIdx = j;
      }
    }
    if (nnIdx < 0) continue;

    // Approximate local Jacobian from multiple neighbor pairs
    const J = estimateLocalJacobian(vectors, refIdx, dim, tau);

    // Apply Jacobian to perturbation vectors: Q' = J * Q
    const JQ = matMul(J, Q);

    // QR decomposition (Gram-Schmidt)
    const { q, r } = qrDecomposition(JQ);
    Q = q;

    // Accumulate log of diagonal of R
    for (let i = 0; i < dim; i++) {
      const rii = Math.abs(r[i][i]);
      if (rii > 1e-15) {
        lyapSums[i] += Math.log(rii);
      }
    }
    totalSteps++;
  }

  // Average to get Lyapunov exponents
  const exponents: number[] = [];
  for (let i = 0; i < dim; i++) {
    exponents.push(totalSteps > 0 ? lyapSums[i] / totalSteps : 0);
  }

  // Sort descending
  exponents.sort((a, b) => b - a);

  const kaplanYorkeDim = computeKaplanYorkeDim(exponents);
  const kolmogorovSinaiEntropy = exponents.filter(e => e > 0).reduce((a, b) => a + b, 0);
  const attractorVolume = exponents.reduce((a, b) => a + b, 0);

  return { exponents, dim, tau, kaplanYorkeDim, kolmogorovSinaiEntropy, attractorVolume };
}

// ============================================================
// 2. ローリング・カプラン-ヨーク次元
// ============================================================

export interface RollingKYResult {
  times: string[];
  kyDimension: number[];
  maxLyapunov: number[];
  entropy: number[];
  spectra: number[][];  // 各時点のフルスペクトル
}

export function rollingKaplanYorke(
  values: number[],
  times: string[],
  tau: number = 1,
  dim: number = 5,
  windowSize: number = 150,
  stepSize: number = 5
): RollingKYResult {
  const resultTimes: string[] = [];
  const kyDimension: number[] = [];
  const maxLyapunov: number[] = [];
  const entropy: number[] = [];
  const spectra: number[][] = [];

  for (let t = windowSize - 1; t < values.length; t += stepSize) {
    const windowValues = values.slice(t - windowSize + 1, t + 1);
    const spectrum = computeLyapunovSpectrum(windowValues, tau, dim, 3, 10);

    resultTimes.push(times[t]);
    kyDimension.push(spectrum.kaplanYorkeDim);
    maxLyapunov.push(spectrum.exponents[0]);
    entropy.push(spectrum.kolmogorovSinaiEntropy);
    spectra.push([...spectrum.exponents]);
  }

  return { times: resultTimes, kyDimension, maxLyapunov, entropy, spectra };
}

// ============================================================
// 3. リアプノフベクトル変動要因分解
// ============================================================

export interface LyapunovVectorResult {
  times: string[];
  // 各時点で各埋め込み次元が最大リアプノフ方向にどれだけ寄与するか (0-1)
  contributions: number[][];  // [time][dim]
  dominantDim: number[];      // 各時点の支配的次元インデックス
  instabilityProfile: number[]; // 全体平均の寄与プロファイル
}

export function lyapunovVectorDecomposition(
  values: number[],
  times: string[],
  tau: number = 1,
  dim: number = 5,
  windowSize: number = 150,
  stepSize: number = 5
): LyapunovVectorResult {
  const resultTimes: string[] = [];
  const contributions: number[][] = [];
  const dominantDim: number[] = [];

  for (let t = windowSize - 1; t < values.length; t += stepSize) {
    const windowValues = values.slice(t - windowSize + 1, t + 1);
    const vec = computeLeadingLyapunovVector(windowValues, tau, dim);

    resultTimes.push(times[t]);
    contributions.push(vec);
    dominantDim.push(vec.indexOf(Math.max(...vec)));
  }

  // 全体平均プロファイル
  const instabilityProfile = new Array(dim).fill(0);
  for (const c of contributions) {
    for (let d = 0; d < dim; d++) {
      instabilityProfile[d] += (c[d] || 0);
    }
  }
  const total = instabilityProfile.reduce((a: number, b: number) => a + b, 0) || 1;
  for (let d = 0; d < dim; d++) {
    instabilityProfile[d] /= total;
  }

  return { times: resultTimes, contributions, dominantDim, instabilityProfile };
}

// ============================================================
// 内部ユーティリティ
// ============================================================

function computeLeadingLyapunovVector(
  values: number[],
  tau: number,
  dim: number
): number[] {
  const n = values.length - (dim - 1) * tau;
  if (n < 30) return new Array(dim).fill(1 / dim);

  const vectors: number[][] = [];
  for (let i = 0; i < n; i++) {
    const vec: number[] = [];
    for (let d = 0; d < dim; d++) vec.push(values[i + d * tau]);
    vectors.push(vec);
  }

  // Power iteration: start with random vector, multiply by Jacobians
  let v = new Array(dim).fill(0).map(() => Math.random() - 0.5);
  let norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  v = v.map(x => x / norm);

  const sampleSize = Math.min(n - 2, 80);
  const step = Math.max(1, Math.floor((n - 2) / sampleSize));

  for (let refIdx = 0; refIdx < n - 2; refIdx += step) {
    const J = estimateLocalJacobian(vectors, refIdx, dim, tau);
    // v = J * v
    const newV = new Array(dim).fill(0);
    for (let i = 0; i < dim; i++) {
      for (let j = 0; j < dim; j++) {
        newV[i] += J[i][j] * v[j];
      }
    }
    norm = Math.sqrt(newV.reduce((a, b) => a + b * b, 0));
    if (norm > 1e-15) {
      v = newV.map(x => x / norm);
    }
  }

  // Return absolute contributions (normalized)
  const absV = v.map(x => x * x);
  const sum = absV.reduce((a, b) => a + b, 0) || 1;
  return absV.map(x => x / sum);
}

function estimateLocalJacobian(
  vectors: number[][],
  refIdx: number,
  dim: number,
  tau: number
): number[][] {
  const n = vectors.length;

  // Find 2*dim nearest neighbors for regression
  const k = Math.min(2 * dim + 1, n - 1);
  const dists: { idx: number; dist: number }[] = [];
  for (let j = 0; j < n - 1; j++) {
    if (j === refIdx || Math.abs(j - refIdx) < Math.max(tau, 1)) continue;
    const d = vecDist(vectors[refIdx], vectors[j]);
    if (d > 1e-10) dists.push({ idx: j, dist: d });
  }
  dists.sort((a, b) => a.dist - b.dist);
  const neighbors = dists.slice(0, k);

  if (neighbors.length < dim) {
    return identityMatrix(dim);
  }

  // Weighted least squares: Δy = J · Δx
  // Δx_i = vectors[nb] - vectors[ref], Δy_i = vectors[nb+1] - vectors[ref+1]
  const J: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));

  if (refIdx + 1 >= n) return identityMatrix(dim);

  // Build X and Y matrices
  const nNb = neighbors.length;
  const X: number[][] = [];
  const Y: number[][] = [];
  const W: number[] = [];

  for (const nb of neighbors) {
    if (nb.idx + 1 >= n) continue;
    const dx: number[] = [];
    const dy: number[] = [];
    for (let d = 0; d < dim; d++) {
      dx.push(vectors[nb.idx][d] - vectors[refIdx][d]);
      dy.push(vectors[nb.idx + 1][d] - (refIdx + 1 < n ? vectors[refIdx + 1][d] : vectors[refIdx][d]));
    }
    X.push(dx);
    Y.push(dy);
    W.push(Math.exp(-nb.dist / (neighbors[0].dist * 2 || 1)));
  }

  if (X.length < dim) return identityMatrix(dim);

  // Solve J = Y^T W X (X^T W X)^{-1} for each row
  // Simplified: weighted pseudo-inverse
  for (let row = 0; row < dim; row++) {
    // For each output dimension, solve weighted LS
    const coeffs = weightedLeastSquares(X, Y.map(y => y[row]), W);
    for (let col = 0; col < dim; col++) {
      J[row][col] = coeffs[col];
    }
  }

  return J;
}

function weightedLeastSquares(X: number[][], y: number[], w: number[]): number[] {
  const m = X[0].length;
  const n = X.length;

  // XtWX = X^T W X (m x m), XtWy = X^T W y (m)
  const XtWX: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  const XtWy = new Array(m).fill(0);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      XtWy[j] += X[i][j] * w[i] * y[i];
      for (let k = 0; k < m; k++) {
        XtWX[j][k] += X[i][j] * w[i] * X[i][k];
      }
    }
  }

  // Regularization
  for (let i = 0; i < m; i++) {
    XtWX[i][i] += 1e-6;
  }

  // Solve via Gauss elimination
  return solveLinear(XtWX, XtWy);
}

function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  const aug: number[][] = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Pivot
    let maxVal = Math.abs(aug[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    if (Math.abs(aug[col][col]) < 1e-12) continue;

    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / aug[col][col];
      for (let j = col; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  // Back substitution
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = aug[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= aug[i][j] * x[j];
    }
    x[i] = Math.abs(aug[i][i]) > 1e-12 ? sum / aug[i][i] : 0;
  }
  return x;
}

function identityMatrix(n: number): number[][] {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );
}

function matMul(A: number[][], B: number[][]): number[][] {
  const n = A.length;
  const m = B[0].length;
  const p = B.length;
  const C: number[][] = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      for (let k = 0; k < p; k++) {
        C[i][j] += A[i][k] * B[k][j];
      }
    }
  }
  return C;
}

function qrDecomposition(A: number[][]): { q: number[][]; r: number[][] } {
  const n = A.length;
  const m = A[0].length;
  const q: number[][] = Array.from({ length: n }, (_, i) => [...A[i]]);
  const r: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));

  for (let j = 0; j < m; j++) {
    // Orthogonalize against previous columns
    for (let i = 0; i < j; i++) {
      let dot = 0;
      for (let k = 0; k < n; k++) dot += q[k][i] * q[k][j];
      r[i][j] = dot;
      for (let k = 0; k < n; k++) q[k][j] -= dot * q[k][i];
    }
    // Normalize
    let norm = 0;
    for (let k = 0; k < n; k++) norm += q[k][j] * q[k][j];
    norm = Math.sqrt(norm);
    r[j][j] = norm;
    if (norm > 1e-15) {
      for (let k = 0; k < n; k++) q[k][j] /= norm;
    }
  }

  return { q, r };
}

function vecDist(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i] - b[i]) ** 2;
  return Math.sqrt(d);
}

export function computeKaplanYorkeDim(exponents: number[]): number {
  // D_KY = j + (Σᵢ₌₁ʲ λᵢ) / |λⱼ₊₁|
  // where j is the largest integer such that Σᵢ₌₁ʲ λᵢ ≥ 0
  let sum = 0;
  let j = 0;
  for (let i = 0; i < exponents.length; i++) {
    sum += exponents[i];
    if (sum >= 0) {
      j = i + 1;
    } else {
      break;
    }
  }

  if (j === 0) return 0;
  if (j >= exponents.length) return exponents.length;

  const partialSum = exponents.slice(0, j).reduce((a, b) => a + b, 0);
  const nextExp = Math.abs(exponents[j]);
  return nextExp > 1e-15 ? j + partialSum / nextExp : j;
}
