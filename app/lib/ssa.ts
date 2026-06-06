// Singular Spectrum Analysis (SSA)
// トラジェクトリ行列のSVDによるトレンド/周期/ノイズ分離

export interface SSAComponent {
  index: number;
  singularValue: number;
  contribution: number; // % of total variance
  reconstruction: number[];
  category: "trend" | "periodic" | "noise";
}

export interface SSAResult {
  components: SSAComponent[];
  trend: number[];
  periodic: number[];
  noise: number[];
  original: number[];
  interpretation: string;
}

/**
 * Power iteration with deflation for top-r eigenvectors of symmetric matrix C
 * (Adapted from dmd.ts pattern)
 */
function powerIterationEigen(
  C: number[][],
  m: number,
  r: number
): { eigvals: number[]; eigvecs: number[][] } {
  const eigvecs: number[][] = [];
  const eigvals: number[] = [];
  const Cwork = C.map((row) => [...row]);

  for (let mode = 0; mode < r; mode++) {
    // Random initial vector
    let v = new Array(m).fill(0).map((_, i) => Math.sin(i * 0.7 + mode * 1.3));
    let norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
    v = v.map((x) => x / (norm || 1));

    for (let iter = 0; iter < 150; iter++) {
      const w = new Array(m).fill(0);
      for (let i = 0; i < m; i++) {
        for (let j = 0; j < m; j++) w[i] += Cwork[i][j] * v[j];
      }
      norm = Math.sqrt(w.reduce((a, b) => a + b * b, 0));
      if (norm < 1e-15) break;
      const vNew = w.map((x) => x / norm);

      // Convergence check
      let diff = 0;
      for (let i = 0; i < m; i++) diff += (vNew[i] - v[i]) ** 2;
      v = vNew;
      if (diff < 1e-12) break;
    }

    // Eigenvalue
    let ev = 0;
    for (let i = 0; i < m; i++) {
      let sum = 0;
      for (let j = 0; j < m; j++) sum += Cwork[i][j] * v[j];
      ev += v[i] * sum;
    }

    eigvals.push(Math.max(ev, 0));
    eigvecs.push(v);

    // Deflation
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        Cwork[i][j] -= ev * v[i] * v[j];
      }
    }
  }

  return { eigvals, eigvecs };
}

/**
 * Diagonal averaging (Hankelization) to reconstruct time series from
 * rank-1 trajectory matrix component
 */
function diagonalAverage(component: number[][], L: number, K: number, N: number): number[] {
  const result = new Array(N).fill(0);
  const counts = new Array(N).fill(0);

  for (let i = 0; i < L; i++) {
    for (let j = 0; j < K; j++) {
      result[i + j] += component[i][j];
      counts[i + j]++;
    }
  }

  for (let t = 0; t < N; t++) {
    if (counts[t] > 0) result[t] /= counts[t];
  }

  return result;
}

export function computeSSA(
  values: number[],
  windowSize?: number,
  nComponents: number = 10
): SSAResult {
  const N = values.length;
  const empty: SSAResult = {
    components: [],
    trend: [],
    periodic: [],
    noise: [],
    original: values,
    interpretation: "データが不足しています。",
  };
  if (N < 30) return empty;

  // Window size: default N/3, capped at 100
  const L = windowSize || Math.min(Math.floor(N / 3), 100);
  const K = N - L + 1;

  if (K < L || L < 3) return empty;

  // Trajectory matrix T (L x K)
  // T[i][j] = values[i + j]

  // Compute covariance matrix C = T * T^T (L x L)
  const C: number[][] = [];
  for (let i = 0; i < L; i++) {
    C.push(new Array(L).fill(0));
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = 0; k < K; k++) {
        s += values[i + k] * values[j + k];
      }
      C[i][j] = s;
      if (i !== j) C[j][i] = s;
    }
  }

  // Power iteration SVD
  const r = Math.min(nComponents, L, K);
  const { eigvals, eigvecs } = powerIterationEigen(C, L, r);

  // Total variance
  const totalVar = eigvals.reduce((a, b) => a + b, 0);

  // Reconstruct each component
  const components: SSAComponent[] = [];

  for (let mode = 0; mode < r; mode++) {
    const U = eigvecs[mode]; // L-dimensional eigenvector
    const sigma = Math.sqrt(Math.max(eigvals[mode], 0));

    if (sigma < 1e-12) continue;

    // V = T^T * U / sigma (K-dimensional)
    const V = new Array(K).fill(0);
    for (let j = 0; j < K; j++) {
      let s = 0;
      for (let i = 0; i < L; i++) s += values[i + j] * U[i];
      V[j] = s / sigma;
    }

    // Rank-1 component: sigma * U * V^T
    const comp: number[][] = [];
    for (let i = 0; i < L; i++) {
      comp.push(new Array(K).fill(0));
      for (let j = 0; j < K; j++) {
        comp[i][j] = sigma * U[i] * V[j];
      }
    }

    const reconstruction = diagonalAverage(comp, L, K, N);
    const contribution = totalVar > 0 ? (eigvals[mode] / totalVar) * 100 : 0;

    // Categorize: trend if eigenvector is smooth, periodic if paired eigenvalues
    let category: "trend" | "periodic" | "noise" = "noise";
    if (mode === 0 && contribution > 30) {
      category = "trend";
    } else if (mode <= 4 && contribution > 5) {
      // Check smoothness: count zero crossings of eigenvector
      let crossings = 0;
      for (let i = 1; i < L; i++) {
        if (U[i] * U[i - 1] < 0) crossings++;
      }
      if (crossings <= 2) category = "trend";
      else if (crossings <= L / 3) category = "periodic";
    }

    components.push({
      index: mode,
      singularValue: sigma,
      contribution,
      reconstruction,
      category,
    });
  }

  // Aggregate
  const trend = new Array(N).fill(0);
  const periodic = new Array(N).fill(0);
  const noise = new Array(N).fill(0);

  for (const c of components) {
    for (let t = 0; t < N; t++) {
      if (c.category === "trend") trend[t] += c.reconstruction[t];
      else if (c.category === "periodic") periodic[t] += c.reconstruction[t];
      else noise[t] += c.reconstruction[t];
    }
  }

  // 残差をノイズに追加
  const reconstructedSum = new Array(N).fill(0);
  for (const c of components) {
    for (let t = 0; t < N; t++) reconstructedSum[t] += c.reconstruction[t];
  }
  for (let t = 0; t < N; t++) {
    noise[t] += values[t] - reconstructedSum[t];
  }

  const trendComps = components.filter((c) => c.category === "trend");
  const periodicComps = components.filter((c) => c.category === "periodic");
  const trendPct = trendComps.reduce((s, c) => s + c.contribution, 0);
  const periodicPct = periodicComps.reduce((s, c) => s + c.contribution, 0);

  const interpretation =
    `窓幅L=${L}でSSA分解。` +
    `トレンド成分: ${trendComps.length}個（寄与率${trendPct.toFixed(1)}%）、` +
    `周期成分: ${periodicComps.length}個（寄与率${periodicPct.toFixed(1)}%）。` +
    (trendPct > 80
      ? "トレンドが支配的で、強い方向性を持つ時系列です。"
      : trendPct > 50
      ? "トレンドと変動成分がバランスしています。"
      : "変動成分が大きく、明確なトレンドは弱いです。");

  return { components, trend, periodic, noise, original: values, interpretation };
}
