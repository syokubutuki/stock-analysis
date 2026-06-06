// Fractional Brownian Motion (fBM) Simulation
// Hosking method O(n^2) for generating fBM paths

export interface FBMResult {
  hurstExponent: number;
  paths: number[][];
  percentiles: {
    p5: number[];
    p25: number[];
    p50: number[];
    p75: number[];
    p95: number[];
  };
  msdCurve: { t: number; msd: number; theoretical: number }[];
  interpretation: string;
}

function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function boxMuller(rng: () => number): number {
  const u1 = rng() || 1e-10;
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * fBM autocovariance: gamma(k) = 0.5 * (|k-1|^{2H} + |k+1|^{2H} - 2|k|^{2H})
 */
function fbmAutocovariance(k: number, H: number): number {
  if (k === 0) return 1;
  return 0.5 * (Math.pow(Math.abs(k - 1), 2 * H) + Math.pow(Math.abs(k + 1), 2 * H) - 2 * Math.pow(Math.abs(k), 2 * H));
}

/**
 * Hosking method (Durbin-Levinson recursion)
 * O(n^2) per path, memory O(n)
 */
function generateFBMPath(n: number, H: number, rng: () => number): number[] {
  const x = new Array(n).fill(0);
  const phi = new Array(n).fill(0);
  const psi = new Array(n).fill(0);

  // gamma(k) = autocovariance at lag k
  const gamma = (k: number) => fbmAutocovariance(k, H);

  // First value
  x[0] = boxMuller(rng);

  if (n === 1) return x;

  // Durbin-Levinson recursion
  let v = gamma(0); // prediction error variance
  phi[0] = gamma(1) / v;
  v = v * (1 - phi[0] * phi[0]);

  // x[1] = phi[0] * x[0] + sqrt(v) * Z
  x[1] = phi[0] * x[0] + Math.sqrt(Math.max(v, 1e-12)) * boxMuller(rng);

  for (let t = 2; t < n; t++) {
    // Update phi using Durbin-Levinson
    // phi_new[t-1] = (gamma(t) - sum_{j=0}^{t-2} phi[j] * gamma(t-1-j)) / v
    let sum = 0;
    for (let j = 0; j < t - 1; j++) {
      sum += phi[j] * gamma(t - 1 - j);
    }
    const phiNew = (gamma(t) - sum) / v;

    // Update: psi[j] = phi[j] - phiNew * phi[t-2-j]
    for (let j = 0; j < t - 1; j++) {
      psi[j] = phi[j] - phiNew * phi[t - 2 - j];
    }
    psi[t - 1] = phiNew;

    // Update v
    v = v * (1 - phiNew * phiNew);
    if (v < 1e-12) v = 1e-12;

    // Copy psi -> phi
    for (let j = 0; j < t; j++) phi[j] = psi[j];

    // Generate x[t]
    let pred = 0;
    for (let j = 0; j < t; j++) {
      pred += phi[j] * x[t - 1 - j];
    }
    x[t] = pred + Math.sqrt(v) * boxMuller(rng);
  }

  return x;
}

export function simulateFBM(
  hurst: number,
  n: number = 200,
  nPaths: number = 200,
  sigma: number = 0.01,
  S0: number = 100,
  seed: number = 42
): FBMResult {
  const H = Math.max(0.01, Math.min(0.99, hurst));
  const rng = mulberry32(seed);

  // パス長の制限（性能対策）
  const pathLen = Math.min(n, 200);

  const paths: number[][] = [];
  const allPrices: number[][] = Array.from({ length: pathLen + 1 }, () => []);

  for (let p = 0; p < nPaths; p++) {
    const increments = generateFBMPath(pathLen, H, rng);
    const path = [S0];
    for (let i = 0; i < pathLen; i++) {
      const prev = path[path.length - 1];
      path.push(prev * Math.exp(sigma * increments[i]));
    }
    paths.push(path);
    for (let d = 0; d <= pathLen; d++) allPrices[d].push(path[d]);
  }

  // Percentiles
  const percentiles = {
    p5: new Array(pathLen + 1),
    p25: new Array(pathLen + 1),
    p50: new Array(pathLen + 1),
    p75: new Array(pathLen + 1),
    p95: new Array(pathLen + 1),
  };

  for (let d = 0; d <= pathLen; d++) {
    const sorted = allPrices[d].sort((a, b) => a - b);
    const pct = (q: number) => sorted[Math.floor(q * sorted.length)] || sorted[0];
    percentiles.p5[d] = pct(0.05);
    percentiles.p25[d] = pct(0.25);
    percentiles.p50[d] = pct(0.5);
    percentiles.p75[d] = pct(0.75);
    percentiles.p95[d] = pct(0.95);
  }

  // MSD (Mean Squared Displacement) curve
  const maxLag = Math.min(50, Math.floor(pathLen / 2));
  const msdCurve: FBMResult["msdCurve"] = [];

  for (let lag = 1; lag <= maxLag; lag++) {
    let sumSqDisp = 0;
    let count = 0;
    for (const path of paths.slice(0, 100)) {
      for (let i = 0; i + lag < path.length; i++) {
        const logDisp = Math.log(path[i + lag] / path[i]);
        sumSqDisp += logDisp * logDisp;
        count++;
      }
    }
    const msd = count > 0 ? sumSqDisp / count : 0;
    const theoretical = sigma * sigma * Math.pow(lag, 2 * H);
    msdCurve.push({ t: lag, msd, theoretical });
  }

  let interpretation = `Hurst指数 H=${H.toFixed(3)} の分数ブラウン運動をシミュレーション。`;
  if (H > 0.6) {
    interpretation += `H>0.5は持続性（トレンド）を示し、上昇/下落が続きやすいパスが生成されます。`;
  } else if (H < 0.4) {
    interpretation += `H<0.5は反持続性（平均回帰）を示し、価格が振動的に動くパスが生成されます。`;
  } else {
    interpretation += `H≈0.5は通常のブラウン運動に近く、独立なリターンを持つパスが生成されます。`;
  }
  interpretation += `MSD曲線が理論値(∝t^{2H})に従えば、モデルの妥当性が確認できます。`;

  return {
    hurstExponent: H,
    paths: paths.slice(0, 30),
    percentiles,
    msdCurve,
    interpretation,
  };
}
