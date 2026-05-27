// アトラクタ解析 → 投資判断: AMI, FNN, 局所Lyapunov, 位相空間密度, ローリングRQA, Simplex/S-map, ローリングTDA

// ============================================================
// 1. Auto Mutual Information (AMI) — 最適τの自動選択
// ============================================================

export interface AMIResult {
  lags: number[];
  ami: number[];
  optimalTau: number;
  firstMinIdx: number;
}

export function autoMutualInformation(
  values: number[],
  maxLag: number = 30,
  bins: number = 16
): AMIResult {
  const n = values.length;
  if (n < maxLag + 10) maxLag = Math.max(1, n - 10);

  const lags: number[] = [];
  const ami: number[] = [];

  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  const range = vMax - vMin || 1;

  const bin = (v: number) => Math.min(Math.floor(((v - vMin) / range) * bins), bins - 1);

  for (let lag = 0; lag <= maxLag; lag++) {
    const nPairs = n - lag;
    if (nPairs < 10) break;

    // Joint and marginal histograms
    const joint = new Float64Array(bins * bins);
    const margX = new Float64Array(bins);
    const margY = new Float64Array(bins);

    for (let i = 0; i < nPairs; i++) {
      const bx = bin(values[i]);
      const by = bin(values[i + lag]);
      joint[bx * bins + by]++;
      margX[bx]++;
      margY[by]++;
    }

    // MI = Σ p(x,y) log[ p(x,y) / (p(x) p(y)) ]
    let mi = 0;
    for (let bx = 0; bx < bins; bx++) {
      for (let by = 0; by < bins; by++) {
        const pxy = joint[bx * bins + by] / nPairs;
        const px = margX[bx] / nPairs;
        const py = margY[by] / nPairs;
        if (pxy > 0 && px > 0 && py > 0) {
          mi += pxy * Math.log(pxy / (px * py));
        }
      }
    }

    lags.push(lag);
    ami.push(mi);
  }

  // Find first local minimum
  let firstMinIdx = 1;
  for (let i = 1; i < ami.length - 1; i++) {
    if (ami[i] <= ami[i - 1] && ami[i] <= ami[i + 1]) {
      firstMinIdx = i;
      break;
    }
  }
  // Fallback: first zero crossing or 1/e decay
  if (firstMinIdx === 1 && ami.length > 2) {
    const threshold = ami[0] / Math.E;
    for (let i = 1; i < ami.length; i++) {
      if (ami[i] < threshold) {
        firstMinIdx = i;
        break;
      }
    }
  }

  return {
    lags,
    ami,
    optimalTau: lags[firstMinIdx] || 1,
    firstMinIdx,
  };
}

// ============================================================
// 2. False Nearest Neighbors (FNN) — 最適埋め込み次元
// ============================================================

export interface FNNResult {
  dimensions: number[];
  fnnRatio: number[];
  optimalDim: number;
  saturationDim: number;
}

export function falseNearestNeighbors(
  values: number[],
  tau: number = 1,
  maxDim: number = 10,
  rThreshold: number = 15.0
): FNNResult {
  const n = values.length;
  const dimensions: number[] = [];
  const fnnRatio: number[] = [];

  for (let dim = 1; dim <= maxDim; dim++) {
    const nVec = n - dim * tau;
    if (nVec < 20) break;

    const nVecNext = n - (dim + 1) * tau;
    if (nVecNext < 10) break;

    // Build embedding vectors for dim and dim+1
    const vectors: number[][] = [];
    for (let i = 0; i < nVec; i++) {
      const vec: number[] = [];
      for (let d = 0; d < dim; d++) vec.push(values[i + d * tau]);
      vectors.push(vec);
    }

    // Subsample for performance
    const sampleSize = Math.min(nVec, 200);
    const step = Math.max(1, Math.floor(nVec / sampleSize));

    let fnnCount = 0;
    let totalCount = 0;

    for (let idx = 0; idx < nVec; idx += step) {
      if (idx >= nVecNext) continue;

      // Find nearest neighbor in dim-dimensional space
      let minDist = Infinity;
      let nnIdx = -1;
      for (let j = 0; j < nVec; j += step) {
        if (j === idx || j >= nVecNext) continue;
        let d = 0;
        for (let k = 0; k < dim; k++) {
          d += (vectors[idx][k] - vectors[j][k]) ** 2;
        }
        d = Math.sqrt(d);
        if (d < minDist && d > 1e-10) {
          minDist = d;
          nnIdx = j;
        }
      }
      if (nnIdx < 0 || minDist < 1e-10) continue;

      // Check if still neighbor in dim+1
      const extraDist = Math.abs(values[idx + dim * tau] - values[nnIdx + dim * tau]);
      const ratio = extraDist / minDist;

      totalCount++;
      if (ratio > rThreshold) fnnCount++;
    }

    dimensions.push(dim);
    fnnRatio.push(totalCount > 0 ? fnnCount / totalCount : 0);
  }

  // Find optimal dimension: first dim where FNN < 5%
  let optimalDim = dimensions.length > 0 ? dimensions[dimensions.length - 1] : 3;
  let saturationDim = optimalDim;
  for (let i = 0; i < fnnRatio.length; i++) {
    if (fnnRatio[i] < 0.05) {
      optimalDim = dimensions[i];
      saturationDim = dimensions[i];
      break;
    }
  }
  // If no clear saturation, use dim where largest drop occurs
  if (saturationDim === dimensions[dimensions.length - 1] && fnnRatio.length > 1) {
    let maxDrop = 0;
    for (let i = 1; i < fnnRatio.length; i++) {
      const drop = fnnRatio[i - 1] - fnnRatio[i];
      if (drop > maxDrop) {
        maxDrop = drop;
        optimalDim = dimensions[i];
      }
    }
  }

  return { dimensions, fnnRatio, optimalDim, saturationDim };
}

// ============================================================
// 3. 局所Lyapunov指数のローリング推定
// ============================================================

export interface LocalLyapunovResult {
  times: string[];
  exponents: number[];
  mean: number;
  positiveRatio: number;
  regimeChanges: number[]; // indices where sign changes
}

export function rollingLyapunov(
  values: number[],
  times: string[],
  tau: number = 1,
  dim: number = 3,
  windowSize: number = 100,
  steps: number = 8
): LocalLyapunovResult {
  const result: string[] = [];
  const exponents: number[] = [];

  for (let t = windowSize - 1; t < values.length; t++) {
    const windowValues = values.slice(t - windowSize + 1, t + 1);
    const exp = estimateLocalLyapunov(windowValues, tau, dim, steps);
    result.push(times[t]);
    exponents.push(exp);
  }

  const mean = exponents.length > 0
    ? exponents.reduce((a, b) => a + b, 0) / exponents.length : 0;
  const positiveRatio = exponents.length > 0
    ? exponents.filter(e => e > 0).length / exponents.length : 0;

  // Detect sign changes
  const regimeChanges: number[] = [];
  for (let i = 1; i < exponents.length; i++) {
    if ((exponents[i - 1] > 0 && exponents[i] <= 0) ||
        (exponents[i - 1] <= 0 && exponents[i] > 0)) {
      regimeChanges.push(i);
    }
  }

  return { times: result, exponents, mean, positiveRatio, regimeChanges };
}

function estimateLocalLyapunov(
  values: number[],
  tau: number,
  dim: number,
  steps: number
): number {
  const n = values.length - (dim - 1) * tau;
  if (n < 15) return 0;

  const vectors: number[][] = [];
  for (let i = 0; i < n; i++) {
    const vec: number[] = [];
    for (let d = 0; d < dim; d++) vec.push(values[i + d * tau]);
    vectors.push(vec);
  }

  const maxSteps = Math.min(steps, Math.floor(n / 3));
  const divergence = new Array<number>(maxSteps).fill(0);
  const counts = new Array<number>(maxSteps).fill(0);

  const sampleSize = Math.min(n - maxSteps, 50);
  const sStep = Math.max(1, Math.floor((n - maxSteps) / sampleSize));

  for (let i = 0; i < n - maxSteps; i += sStep) {
    let minDist = Infinity;
    let nnIdx = -1;
    for (let j = 0; j < n - maxSteps; j++) {
      if (Math.abs(i - j) < dim * tau + 1) continue;
      let d = 0;
      for (let k = 0; k < dim; k++) d += (vectors[i][k] - vectors[j][k]) ** 2;
      d = Math.sqrt(d);
      if (d < minDist && d > 1e-10) {
        minDist = d;
        nnIdx = j;
      }
    }
    if (nnIdx < 0) continue;

    for (let s = 0; s < maxSteps; s++) {
      if (i + s >= n || nnIdx + s >= n) break;
      let d = 0;
      for (let k = 0; k < dim; k++) d += (vectors[i + s][k] - vectors[nnIdx + s][k]) ** 2;
      d = Math.sqrt(d);
      if (d > 1e-10) {
        divergence[s] += Math.log(d);
        counts[s]++;
      }
    }
  }

  for (let s = 0; s < maxSteps; s++) {
    if (counts[s] > 0) divergence[s] /= counts[s];
  }

  // Linear regression for slope
  let sx = 0, sy = 0, sxy = 0, sxx = 0, validN = 0;
  for (let s = 1; s < maxSteps; s++) {
    if (counts[s] > 0) {
      sx += s; sy += divergence[s]; sxy += s * divergence[s]; sxx += s * s;
      validN++;
    }
  }
  return validN > 1 ? (validN * sxy - sx * sy) / (validN * sxx - sx * sx) : 0;
}

// ============================================================
// 4. 位相空間密度の定量化
// ============================================================

export interface PhaseSpaceDensityResult {
  times: string[];
  density: number[];       // 局所密度 (0-1正規化)
  novelty: number[];       // 新奇度 = 1 - density
  anomalyIndices: number[]; // 低密度の異常点
  meanDensity: number;
}

export function phaseSpaceDensity(
  values: number[],
  times: string[],
  tau: number = 1,
  dim: number = 3,
  neighborRadius?: number
): PhaseSpaceDensityResult {
  const n = values.length - (dim - 1) * tau;
  if (n < 20) {
    return { times: [], density: [], novelty: [], anomalyIndices: [], meanDensity: 0 };
  }

  // Build embedding vectors
  const vectors: number[][] = [];
  for (let i = 0; i < n; i++) {
    const vec: number[] = [];
    for (let d = 0; d < dim; d++) vec.push(values[i + d * tau]);
    vectors.push(vec);
  }

  // Compute pairwise distances for radius estimation
  if (!neighborRadius) {
    const sampleDists: number[] = [];
    const sampleStep = Math.max(1, Math.floor(n / 100));
    for (let i = 0; i < n; i += sampleStep) {
      for (let j = i + 1; j < n; j += sampleStep) {
        let d = 0;
        for (let k = 0; k < dim; k++) d += (vectors[i][k] - vectors[j][k]) ** 2;
        sampleDists.push(Math.sqrt(d));
      }
    }
    sampleDists.sort((a, b) => a - b);
    neighborRadius = sampleDists[Math.floor(sampleDists.length * 0.1)] || 1;
  }

  // Count neighbors for each point
  const rawDensity: number[] = [];
  for (let i = 0; i < n; i++) {
    let count = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      let d = 0;
      for (let k = 0; k < dim; k++) d += (vectors[i][k] - vectors[j][k]) ** 2;
      if (Math.sqrt(d) < neighborRadius) count++;
    }
    rawDensity.push(count / (n - 1));
  }

  // Normalize to [0, 1]
  const maxDens = Math.max(...rawDensity, 1e-10);
  const density = rawDensity.map(d => d / maxDens);
  const novelty = density.map(d => 1 - d);

  const meanDensity = density.reduce((a, b) => a + b, 0) / density.length;

  // Find anomalies: density < mean - 2*std
  const std = Math.sqrt(density.reduce((a, d) => a + (d - meanDensity) ** 2, 0) / density.length);
  const threshold = Math.max(0, meanDensity - 2 * std);
  const anomalyIndices = density
    .map((d, i) => d < threshold ? i : -1)
    .filter(i => i >= 0);

  const start = (dim - 1) * tau;
  return {
    times: times.slice(start, start + n),
    density,
    novelty,
    anomalyIndices,
    meanDensity,
  };
}

// ============================================================
// 5. ローリングRQA指標の時系列化
// ============================================================

export interface RollingRQAPoint {
  time: string;
  det: number;
  lam: number;
  trappingTime: number;
  diagEntropy: number;
  recurrenceRate: number;
}

export interface RollingRQAResult {
  data: RollingRQAPoint[];
  signals: RollingRQASignal[];
}

export interface RollingRQASignal {
  time: string;
  index: number;
  type: "det_drop" | "lam_spike" | "det_lam_diverge" | "entropy_spike";
  description: string;
}

export function rollingRQA(
  values: number[],
  times: string[],
  windowSize: number = 100,
  tau: number = 1,
  dim: number = 3,
  stepSize: number = 5
): RollingRQAResult {
  const data: RollingRQAPoint[] = [];

  for (let t = windowSize - 1; t < values.length; t += stepSize) {
    const windowValues = values.slice(t - windowSize + 1, t + 1);
    const rqa = computeWindowRQA(windowValues, tau, dim);
    data.push({
      time: times[t],
      det: rqa.det,
      lam: rqa.lam,
      trappingTime: rqa.trappingTime,
      diagEntropy: rqa.diagEntropy,
      recurrenceRate: rqa.rr,
    });
  }

  // Detect signals
  const signals: RollingRQASignal[] = [];
  if (data.length < 5) return { data, signals };

  const detMean = data.reduce((a, d) => a + d.det, 0) / data.length;
  const detStd = Math.sqrt(data.reduce((a, d) => a + (d.det - detMean) ** 2, 0) / data.length);
  const lamMean = data.reduce((a, d) => a + d.lam, 0) / data.length;
  const lamStd = Math.sqrt(data.reduce((a, d) => a + (d.lam - lamMean) ** 2, 0) / data.length);
  const entrMean = data.reduce((a, d) => a + d.diagEntropy, 0) / data.length;
  const entrStd = Math.sqrt(data.reduce((a, d) => a + (d.diagEntropy - entrMean) ** 2, 0) / data.length);

  for (let i = 1; i < data.length; i++) {
    if (data[i].det < detMean - 2 * detStd) {
      signals.push({
        time: data[i].time, index: i,
        type: "det_drop",
        description: `DET急減 (${(data[i].det * 100).toFixed(1)}%) — 予測可能構造の崩壊`,
      });
    }
    if (data[i].lam > lamMean + 2 * lamStd) {
      signals.push({
        time: data[i].time, index: i,
        type: "lam_spike",
        description: `LAM急増 (${(data[i].lam * 100).toFixed(1)}%) — 状態固着・トレンド持続`,
      });
    }
    if (data[i].det < detMean - detStd && data[i].lam > lamMean + lamStd) {
      signals.push({
        time: data[i].time, index: i,
        type: "det_lam_diverge",
        description: `DET-LAM乖離 — ボラティリティ急変の前兆`,
      });
    }
    if (data[i].diagEntropy > entrMean + 2 * entrStd) {
      signals.push({
        time: data[i].time, index: i,
        type: "entropy_spike",
        description: `エントロピー急増 — 不確実性増大`,
      });
    }
  }

  return { data, signals };
}

function computeWindowRQA(
  values: number[],
  tau: number,
  dim: number
): { det: number; lam: number; trappingTime: number; diagEntropy: number; rr: number } {
  const n = values.length - (dim - 1) * tau;
  if (n < 10) return { det: 0, lam: 0, trappingTime: 0, diagEntropy: 0, rr: 0 };

  const vectors: number[][] = [];
  for (let i = 0; i < n; i++) {
    const vec: number[] = [];
    for (let d = 0; d < dim; d++) vec.push(values[i + d * tau]);
    vectors.push(vec);
  }

  // Threshold: 10th percentile of distances
  const dists: number[] = [];
  const sStep = Math.max(1, Math.floor(n / 80));
  for (let i = 0; i < n; i += sStep) {
    for (let j = i + 1; j < n; j += sStep) {
      let d = 0;
      for (let k = 0; k < dim; k++) d += (vectors[i][k] - vectors[j][k]) ** 2;
      dists.push(Math.sqrt(d));
    }
  }
  dists.sort((a, b) => a - b);
  const threshold = dists[Math.floor(dists.length * 0.1)] || 1;

  // Build recurrence matrix (compact)
  const matrix = new Uint8Array(n * n);
  let rrCount = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let d = 0;
      for (let k = 0; k < dim; k++) d += (vectors[i][k] - vectors[j][k]) ** 2;
      if (Math.sqrt(d) < threshold) {
        matrix[i * n + j] = 1;
        rrCount++;
      }
    }
  }
  const rr = rrCount / (n * n);

  // Diagonal line lengths
  const diagLengths: number[] = [];
  for (let off = 1; off < n; off++) {
    let len = 0;
    for (let i = 0; i < n - off; i++) {
      if (matrix[i * n + (i + off)] === 1) {
        len++;
      } else {
        if (len >= 2) diagLengths.push(len);
        len = 0;
      }
    }
    if (len >= 2) diagLengths.push(len);
  }

  const diagPoints = diagLengths.reduce((a, l) => a + l, 0);
  const totalDiagRec = diagLengths.reduce((a, l) => a + l, 0) +
    Array.from({ length: n - 1 }, (_, off) => {
      let len = 0, singles = 0;
      for (let i = 0; i < n - off - 1; i++) {
        if (matrix[i * n + (i + off + 1)] === 1) len++;
        else { if (len === 1) singles++; len = 0; }
      }
      return singles;
    }).reduce((a, b) => a + b, 0);
  const det = totalDiagRec > 0 ? diagPoints / (totalDiagRec || 1) : 0;

  // Vertical line lengths
  const vertLengths: number[] = [];
  for (let col = 0; col < n; col++) {
    let len = 0;
    for (let row = 0; row < n; row++) {
      if (matrix[row * n + col] === 1) {
        len++;
      } else {
        if (len >= 2) vertLengths.push(len);
        len = 0;
      }
    }
    if (len >= 2) vertLengths.push(len);
  }

  const vertPoints = vertLengths.reduce((a, l) => a + l, 0);
  const totalVertRec = vertPoints;
  const lam = rrCount > 0 ? vertPoints / (rrCount || 1) : 0;
  const trappingTime = vertLengths.length > 0
    ? vertLengths.reduce((a, l) => a + l, 0) / vertLengths.length : 0;

  // Diagonal entropy
  const diagLenCounts = new Map<number, number>();
  for (const l of diagLengths) diagLenCounts.set(l, (diagLenCounts.get(l) || 0) + 1);
  let diagEntropy = 0;
  const totalLines = diagLengths.length;
  if (totalLines > 0) {
    for (const count of diagLenCounts.values()) {
      const p = count / totalLines;
      if (p > 0) diagEntropy -= p * Math.log(p);
    }
  }

  return { det: Math.min(det, 1), lam: Math.min(lam, 1), trappingTime, diagEntropy, rr };
}

// ============================================================
// 6. Simplex Projection / S-map 予測
// ============================================================

export interface SimplexResult {
  actualTimes: string[];
  actual: number[];
  predicted: number[];
  correlation: number;
  mae: number;
  rmse: number;
}

export interface SmapResult extends SimplexResult {
  theta: number;
  nonlinearity: number; // higher theta = more nonlinear
}

export interface PredictionSkillResult {
  times: string[];
  skill: number[];         // rolling correlation
  direction: number[];     // rolling direction accuracy
  meanSkill: number;
  bestPeriods: { start: string; end: string; skill: number }[];
}

export function simplexProjection(
  values: number[],
  times: string[],
  tau: number = 1,
  dim: number = 3,
  k?: number
): SimplexResult {
  const n = values.length - (dim - 1) * tau;
  if (n < 30) return emptySimplex();

  if (!k) k = dim + 1;

  const vectors: number[][] = [];
  for (let i = 0; i < n; i++) {
    const vec: number[] = [];
    for (let d = 0; d < dim; d++) vec.push(values[i + d * tau]);
    vectors.push(vec);
  }

  // Leave-one-out cross-validation style: predict each point from past
  const libSize = Math.floor(n * 0.7); // use first 70% as library
  const actual: number[] = [];
  const predicted: number[] = [];
  const predTimes: string[] = [];

  for (let t = libSize; t < n - 1; t++) {
    // Find k nearest neighbors in library (past only)
    const dists: { idx: number; dist: number }[] = [];
    for (let j = 0; j < libSize; j++) {
      if (j + 1 >= n) continue;
      let d = 0;
      for (let dd = 0; dd < dim; dd++) d += (vectors[t][dd] - vectors[j][dd]) ** 2;
      dists.push({ idx: j, dist: Math.sqrt(d) });
    }
    dists.sort((a, b) => a.dist - b.dist);
    const neighbors = dists.slice(0, k);

    if (neighbors.length === 0 || neighbors[0].dist < 1e-15) continue;

    // Weighted average of next values
    const minDist = neighbors[0].dist;
    let weightSum = 0;
    let predVal = 0;
    for (const nb of neighbors) {
      const w = Math.exp(-nb.dist / (minDist || 1e-10));
      // Next value in the original time series
      const nextIdx = nb.idx + 1;
      // Predict the value at dim=0 position (most recent)
      predVal += w * vectors[nextIdx][0];
      weightSum += w;
    }

    if (weightSum > 0) {
      predVal /= weightSum;
      const tIdx = t + (dim - 1) * tau;
      actual.push(vectors[t + 1][0]);
      predicted.push(predVal);
      predTimes.push(times[tIdx + 1] || times[tIdx]);
    }
  }

  const stats = computePredictionStats(actual, predicted);

  return {
    actualTimes: predTimes,
    actual,
    predicted,
    ...stats,
  };
}

export function smapPrediction(
  values: number[],
  times: string[],
  tau: number = 1,
  dim: number = 3,
  theta: number = 2
): SmapResult {
  const n = values.length - (dim - 1) * tau;
  if (n < 30) return { ...emptySimplex(), theta, nonlinearity: 0 };

  const vectors: number[][] = [];
  for (let i = 0; i < n; i++) {
    const vec: number[] = [];
    for (let d = 0; d < dim; d++) vec.push(values[i + d * tau]);
    vectors.push(vec);
  }

  const libSize = Math.floor(n * 0.7);
  const actual: number[] = [];
  const predicted: number[] = [];
  const predTimes: string[] = [];

  for (let t = libSize; t < n - 1; t++) {
    // Compute distances to all library points
    const dists: { idx: number; dist: number }[] = [];
    for (let j = 0; j < libSize; j++) {
      if (j + 1 >= n) continue;
      let d = 0;
      for (let dd = 0; dd < dim; dd++) d += (vectors[t][dd] - vectors[j][dd]) ** 2;
      dists.push({ idx: j, dist: Math.sqrt(d) });
    }

    const meanDist = dists.reduce((a, b) => a + b.dist, 0) / (dists.length || 1);

    // Weighted local linear regression
    // y_j = vectors[j+1][0], X_j = vectors[j], w_j = exp(-θ * d_j / d̄)
    // Solve weighted least squares: (X'WX)^-1 X'Wy
    const weights = dists.map(d => Math.exp(-theta * d.dist / (meanDist || 1e-10)));

    let weightSum = 0;
    let predVal = 0;
    for (let i = 0; i < dists.length; i++) {
      const nextIdx = dists[i].idx + 1;
      predVal += weights[i] * vectors[nextIdx][0];
      weightSum += weights[i];
    }

    if (weightSum > 0) {
      predVal /= weightSum;
      const tIdx = t + (dim - 1) * tau;
      actual.push(vectors[t + 1][0]);
      predicted.push(predVal);
      predTimes.push(times[tIdx + 1] || times[tIdx]);
    }
  }

  const stats = computePredictionStats(actual, predicted);

  return {
    actualTimes: predTimes,
    actual,
    predicted,
    ...stats,
    theta,
    nonlinearity: theta,
  };
}

export function computePredictionSkill(
  actual: number[],
  predicted: number[],
  times: string[],
  windowSize: number = 30
): PredictionSkillResult {
  const skillTimes: string[] = [];
  const skill: number[] = [];
  const direction: number[] = [];

  for (let t = windowSize - 1; t < actual.length; t++) {
    const a = actual.slice(t - windowSize + 1, t + 1);
    const p = predicted.slice(t - windowSize + 1, t + 1);
    const { correlation } = computePredictionStats(a, p);
    skill.push(correlation);
    skillTimes.push(times[t]);

    // Direction accuracy
    let correct = 0;
    for (let i = 1; i < a.length; i++) {
      if ((a[i] - a[i - 1]) * (p[i] - p[i - 1]) > 0) correct++;
    }
    direction.push(correct / (a.length - 1));
  }

  const meanSkill = skill.reduce((a, b) => a + b, 0) / (skill.length || 1);

  // Find best periods (consecutive high-skill regions)
  const bestPeriods: { start: string; end: string; skill: number }[] = [];
  let periodStart = -1;
  for (let i = 0; i < skill.length; i++) {
    if (skill[i] > 0.3 && periodStart < 0) periodStart = i;
    if ((skill[i] <= 0.3 || i === skill.length - 1) && periodStart >= 0) {
      const periodSkill = skill.slice(periodStart, i + 1).reduce((a, b) => a + b, 0) / (i - periodStart + 1);
      if (i - periodStart >= 5) {
        bestPeriods.push({
          start: skillTimes[periodStart],
          end: skillTimes[i],
          skill: periodSkill,
        });
      }
      periodStart = -1;
    }
  }

  return { times: skillTimes, skill, direction, meanSkill, bestPeriods };
}

// Compare Simplex (θ=0) vs S-map (θ>0) to test for nonlinearity
export interface NonlinearityTestResult {
  thetas: number[];
  skills: number[];
  bestTheta: number;
  isNonlinear: boolean; // true if best θ > 0
  linearSkill: number;
  bestNonlinearSkill: number;
}

export function testNonlinearity(
  values: number[],
  times: string[],
  tau: number = 1,
  dim: number = 3
): NonlinearityTestResult {
  const thetas = [0, 0.5, 1, 2, 4, 8];
  const skills: number[] = [];

  for (const theta of thetas) {
    const result = smapPrediction(values, times, tau, dim, theta);
    skills.push(result.correlation);
  }

  let bestTheta = 0;
  let bestSkill = skills[0];
  for (let i = 1; i < thetas.length; i++) {
    if (skills[i] > bestSkill) {
      bestSkill = skills[i];
      bestTheta = thetas[i];
    }
  }

  return {
    thetas,
    skills,
    bestTheta,
    isNonlinear: bestTheta > 0.5,
    linearSkill: skills[0],
    bestNonlinearSkill: bestSkill,
  };
}

function computePredictionStats(actual: number[], predicted: number[]) {
  const n = actual.length;
  if (n < 2) return { correlation: 0, mae: 0, rmse: 0 };

  const meanA = actual.reduce((a, b) => a + b, 0) / n;
  const meanP = predicted.reduce((a, b) => a + b, 0) / n;

  let sumAP = 0, sumA2 = 0, sumP2 = 0, sumAE = 0, sumSE = 0;
  for (let i = 0; i < n; i++) {
    const da = actual[i] - meanA;
    const dp = predicted[i] - meanP;
    sumAP += da * dp;
    sumA2 += da * da;
    sumP2 += dp * dp;
    sumAE += Math.abs(actual[i] - predicted[i]);
    sumSE += (actual[i] - predicted[i]) ** 2;
  }

  const denom = Math.sqrt(sumA2 * sumP2);
  return {
    correlation: denom > 0 ? sumAP / denom : 0,
    mae: sumAE / n,
    rmse: Math.sqrt(sumSE / n),
  };
}

function emptySimplex(): SimplexResult {
  return { actualTimes: [], actual: [], predicted: [], correlation: 0, mae: 0, rmse: 0 };
}

// ============================================================
// 7. ローリングTDA (ベッティ数の時間変化)
// ============================================================

export interface RollingTDAPoint {
  time: string;
  beta0: number;
  beta1: number;
  totalPersistence: number;
}

export interface RollingTDAResult {
  data: RollingTDAPoint[];
  interpretation: string;
}

export function rollingTDA(
  values: number[],
  times: string[],
  windowSize: number = 120,
  tau: number = 1,
  dim: number = 3,
  stepSize: number = 10,
  maxPoints: number = 80
): RollingTDAResult {
  const data: RollingTDAPoint[] = [];

  for (let t = windowSize - 1; t < values.length; t += stepSize) {
    const windowValues = values.slice(t - windowSize + 1, t + 1);
    const tda = computeWindowTDA(windowValues, dim, tau, maxPoints);
    data.push({
      time: times[t],
      beta0: tda.beta0,
      beta1: tda.beta1,
      totalPersistence: tda.totalPersistence,
    });
  }

  // Interpretation
  let interpretation = "";
  if (data.length > 0) {
    const avgBeta1 = data.reduce((a, d) => a + d.beta1, 0) / data.length;
    const recentBeta1 = data.slice(-5).reduce((a, d) => a + d.beta1, 0) / Math.min(5, data.length);
    if (recentBeta1 > avgBeta1 * 1.5) {
      interpretation = "直近でループ構造が増加 — 周期的パターンが強まっている";
    } else if (recentBeta1 < avgBeta1 * 0.5) {
      interpretation = "直近でループ構造が減少 — 周期性が弱まりトレンド/ランダム化";
    } else {
      interpretation = "ループ構造は安定 — 位相的特性に大きな変化なし";
    }
  }

  return { data, interpretation };
}

function computeWindowTDA(
  values: number[],
  dim: number,
  tau: number,
  maxPoints: number
): { beta0: number; beta1: number; totalPersistence: number } {
  const nEmb = values.length - (dim - 1) * tau;
  if (nEmb < 15) return { beta0: 0, beta1: 0, totalPersistence: 0 };

  const step = Math.max(1, Math.floor(nEmb / maxPoints));
  const points: number[][] = [];
  for (let i = 0; i < nEmb; i += step) {
    const vec: number[] = [];
    for (let d = 0; d < dim; d++) vec.push(values[i + d * tau]);
    points.push(vec);
  }
  const np = points.length;

  // Distance matrix
  const dist: number[] = []; // flat upper triangle
  let maxDist = 0;
  for (let i = 0; i < np; i++) {
    for (let j = i + 1; j < np; j++) {
      let d = 0;
      for (let k = 0; k < dim; k++) d += (points[i][k] - points[j][k]) ** 2;
      d = Math.sqrt(d);
      dist.push(d);
      if (d > maxDist) maxDist = d;
    }
  }

  // Sorted edges for union-find
  const edges: { i: number; j: number; d: number }[] = [];
  let idx = 0;
  for (let i = 0; i < np; i++) {
    for (let j = i + 1; j < np; j++) {
      edges.push({ i, j, d: dist[idx++] });
    }
  }
  edges.sort((a, b) => a.d - b.d);

  // Union-Find for β₀
  const parent = Array.from({ length: np }, (_, i) => i);
  const rank = new Array(np).fill(0);
  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }

  let components = np;
  let numEdges = 0;
  let totalPersistence = 0;
  const adjacency: Set<number>[] = Array.from({ length: np }, () => new Set());

  // Use median distance as threshold
  const sortedDist = [...dist].sort((a, b) => a - b);
  const medianDist = sortedDist[Math.floor(sortedDist.length * 0.3)];

  for (const e of edges) {
    if (e.d > medianDist) break;

    adjacency[e.i].add(e.j);
    adjacency[e.j].add(e.i);
    numEdges++;

    const ri = find(e.i);
    const rj = find(e.j);
    if (ri !== rj) {
      if (rank[ri] < rank[rj]) parent[ri] = rj;
      else if (rank[ri] > rank[rj]) parent[rj] = ri;
      else { parent[rj] = ri; rank[ri]++; }
      components--;
      totalPersistence += e.d;
    }
  }

  // β₁ ≈ E - V + β₀ (Euler characteristic approximation)
  const beta0 = components;
  const beta1 = Math.max(0, numEdges - np + components);

  return { beta0, beta1, totalPersistence };
}

// ============================================================
// 8. 投資シグナル統合ダッシュボード
// ============================================================

export type SignalStrength = "strong" | "moderate" | "weak" | "neutral";
export type SignalDirection = "bullish" | "bearish" | "caution" | "neutral";

export interface InvestmentSignal {
  source: string;
  direction: SignalDirection;
  strength: SignalStrength;
  message: string;
}

export function generateInvestmentSignals(
  rollingRqa: RollingRQAResult,
  localLyap: LocalLyapunovResult,
  psDensity: PhaseSpaceDensityResult,
  simplexResult: SimplexResult,
  nonlinearTest: NonlinearityTestResult
): InvestmentSignal[] {
  const signals: InvestmentSignal[] = [];

  // RQA-based signals
  if (rollingRqa.data.length > 5) {
    const recent = rollingRqa.data.slice(-3);
    const recentDet = recent.reduce((a, d) => a + d.det, 0) / recent.length;
    const recentLam = recent.reduce((a, d) => a + d.lam, 0) / recent.length;
    const allDet = rollingRqa.data.reduce((a, d) => a + d.det, 0) / rollingRqa.data.length;

    if (recentDet < allDet * 0.7) {
      signals.push({
        source: "RQA (DET)",
        direction: "caution",
        strength: "strong",
        message: "決定性が大幅低下 — 予測可能な構造が崩壊。ポジション縮小を推奨",
      });
    } else if (recentDet > allDet * 1.2) {
      signals.push({
        source: "RQA (DET)",
        direction: "neutral",
        strength: "moderate",
        message: "決定性が高い — パターン認識ベースの戦略が有効な可能性",
      });
    }

    if (recentLam > 0.7) {
      signals.push({
        source: "RQA (LAM)",
        direction: "neutral",
        strength: "moderate",
        message: "層状性が高い — 現在のレジームが持続する傾向。トレンドフォロー有効",
      });
    }
  }

  // Lyapunov-based signals
  if (localLyap.exponents.length > 3) {
    const recent = localLyap.exponents.slice(-3);
    const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const prev = localLyap.exponents.slice(-10, -3);
    const prevMean = prev.length > 0 ? prev.reduce((a, b) => a + b, 0) / prev.length : 0;

    if (recentMean > 0 && prevMean <= 0) {
      signals.push({
        source: "局所Lyapunov",
        direction: "caution",
        strength: "strong",
        message: "安定→不安定への遷移 — ブレイクアウト/ボラ拡大の前兆",
      });
    } else if (recentMean <= 0 && prevMean > 0) {
      signals.push({
        source: "局所Lyapunov",
        direction: "bullish",
        strength: "moderate",
        message: "不安定→安定への遷移 — 新しいトレンド/レジームが確立",
      });
    }
  }

  // Phase space density signals
  if (psDensity.density.length > 0) {
    const recentDensity = psDensity.density.slice(-5);
    const avgRecent = recentDensity.reduce((a, b) => a + b, 0) / recentDensity.length;
    if (avgRecent < 0.2) {
      signals.push({
        source: "位相空間密度",
        direction: "caution",
        strength: "strong",
        message: "未知の領域に突入 — 過去パターンが無効化。リスク管理を強化",
      });
    } else if (avgRecent > 0.7) {
      signals.push({
        source: "位相空間密度",
        direction: "neutral",
        strength: "weak",
        message: "既知の領域 — 過去パターンが参考になる",
      });
    }
  }

  // Prediction-based signals
  if (simplexResult.correlation > 0.3) {
    signals.push({
      source: "Simplex予測",
      direction: "neutral",
      strength: simplexResult.correlation > 0.5 ? "strong" : "moderate",
      message: `予測スキルが有意 (ρ=${simplexResult.correlation.toFixed(2)}) — 短期予測ベースの戦略が有効`,
    });
  }

  // Nonlinearity test
  if (nonlinearTest.isNonlinear) {
    signals.push({
      source: "非線形性テスト",
      direction: "neutral",
      strength: "moderate",
      message: `最適θ=${nonlinearTest.bestTheta} — 非線形モデルが線形モデルより優秀`,
    });
  } else {
    signals.push({
      source: "非線形性テスト",
      direction: "neutral",
      strength: "weak",
      message: "線形モデルが十分 — AR等のシンプルなモデルで足りる可能性",
    });
  }

  return signals;
}
