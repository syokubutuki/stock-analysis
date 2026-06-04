// Merton Jump-Diffusion Model
// dS/S = (μ - λk)dt + σdW + J·dN
// J ~ N(μ_J, σ²_J), N ~ Poisson(λ)

export interface JumpDiffusionParams {
  mu: number;       // ドリフト
  sigma: number;    // 拡散ボラティリティ
  lambda: number;   // ジャンプ頻度 (年率)
  muJ: number;      // ジャンプサイズ平均
  sigmaJ: number;   // ジャンプサイズ標準偏差
  k: number;        // E[e^J - 1] = e^(μ_J + σ²_J/2) - 1
}

export interface JumpDiffusionResult {
  params: JumpDiffusionParams;
  totalVol: number;        // 連続 + ジャンプの合計ボラティリティ
  jumpContribution: number; // ジャンプが全分散に占める割合
  paths: number[][];        // シミュレーション経路
  percentiles: { p5: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[] };
  interpretation: string;
}

// --- パラメータ推定 (モーメント法) ---
export function fitJumpDiffusion(returns: number[]): JumpDiffusionParams {
  const n = returns.length;
  if (n < 50) return emptyParams();

  let m1 = 0, m2 = 0, m3 = 0, m4 = 0;
  for (const r of returns) {
    m1 += r;
    m2 += r * r;
    m3 += r * r * r;
    m4 += r * r * r * r;
  }
  m1 /= n; m2 /= n; m3 /= n; m4 /= n;

  const variance = m2 - m1 * m1;
  const skew = variance > 0 ? (m3 - 3 * m1 * m2 + 2 * m1 ** 3) / variance ** 1.5 : 0;
  const exKurt = variance > 0 ? (m4 - 4 * m1 * m3 + 6 * m1 * m1 * m2 - 3 * m1 ** 4) / variance ** 2 - 3 : 0;

  // Grid search over λ (0.5 ~ 50 jumps/year)
  let bestLambda = 5;
  let bestMuJ = 0;
  let bestSigmaJ = 0.01;
  let bestSigma = Math.sqrt(variance);
  let bestErr = Infinity;

  for (const lambdaDaily of [0.002, 0.005, 0.01, 0.02, 0.04, 0.08, 0.15]) {
    // From moment equations:
    // E[r] = μ + λ·μ_J  (daily)
    // Var[r] = σ² + λ(μ_J² + σ_J²)
    // Skew = λ(μ_J³ + 3μ_J·σ_J²) / Var^{3/2}
    // ExKurt = λ(μ_J⁴ + 6μ_J²σ_J² + 3σ_J⁴) / Var²

    // From skew: estimate μ_J (negative for stocks)
    // Simplified: if skew < 0, μ_J < 0
    const guessedMuJ = skew !== 0 ? skew * Math.pow(variance, 1.5) / (lambdaDaily * 3) : 0;
    const clampedMuJ = Math.max(-0.1, Math.min(0.1, guessedMuJ));

    // From excess kurtosis: estimate σ_J
    const exKurtNumer = exKurt * variance * variance;
    const sigmaJ2 = lambdaDaily > 0
      ? Math.max(0, (exKurtNumer / lambdaDaily - clampedMuJ ** 4) / 3 - 2 * clampedMuJ ** 2)
      : 0.0001;
    const guessedSigmaJ = Math.sqrt(Math.max(sigmaJ2, 1e-8));

    // σ² = Var - λ(μ_J² + σ_J²)
    const sigma2 = variance - lambdaDaily * (clampedMuJ ** 2 + guessedSigmaJ ** 2);
    if (sigma2 <= 0) continue;
    const guessedSigma = Math.sqrt(sigma2);

    // Compute model moments and compare
    const modelVar = guessedSigma ** 2 + lambdaDaily * (clampedMuJ ** 2 + guessedSigmaJ ** 2);
    const modelSkew = lambdaDaily > 0 && modelVar > 0
      ? lambdaDaily * (clampedMuJ ** 3 + 3 * clampedMuJ * guessedSigmaJ ** 2) / modelVar ** 1.5
      : 0;

    const err = (modelVar - variance) ** 2 / variance ** 2 + (modelSkew - skew) ** 2;

    if (err < bestErr) {
      bestErr = err;
      bestLambda = lambdaDaily * 252;
      bestMuJ = clampedMuJ;
      bestSigmaJ = guessedSigmaJ;
      bestSigma = guessedSigma;
    }
  }

  const mu = m1 * 252; // annualize
  const k = Math.exp(bestMuJ + bestSigmaJ ** 2 / 2) - 1;

  return {
    mu,
    sigma: bestSigma * Math.sqrt(252),
    lambda: bestLambda,
    muJ: bestMuJ,
    sigmaJ: bestSigmaJ,
    k,
  };
}

// --- シミュレーション ---
export function simulateJumpDiffusion(
  params: JumpDiffusionParams,
  startPrice: number,
  days: number,
  numPaths: number = 500,
  seed: number = 42
): JumpDiffusionResult {
  const { mu, sigma, lambda, muJ, sigmaJ } = params;
  const dt = 1 / 252;
  const lambdaDaily = lambda / 252;

  const paths: number[][] = [];
  let rng = mulberry32(seed);

  for (let p = 0; p < numPaths; p++) {
    const path: number[] = [startPrice];
    let s = startPrice;

    for (let t = 0; t < days; t++) {
      // Diffusion
      const z = boxMuller(rng);
      rng = mulberry32(seed + p * 10000 + t * 7);
      const drift = (mu - lambda * params.k - 0.5 * sigma * sigma) * dt;
      const diffusion = sigma * Math.sqrt(dt) * z;

      // Jump
      let jump = 0;
      const u = rng();
      rng = mulberry32(seed + p * 10000 + t * 7 + 3);
      if (u < lambdaDaily) {
        const zj = boxMuller(rng);
        rng = mulberry32(seed + p * 10000 + t * 7 + 5);
        jump = muJ + sigmaJ * zj;
      }

      s = s * Math.exp(drift + diffusion + jump);
      path.push(Math.max(s, 0.001));
    }

    paths.push(path);
  }

  // Compute percentiles at each time step
  const p5: number[] = [];
  const p25: number[] = [];
  const p50: number[] = [];
  const p75: number[] = [];
  const p95: number[] = [];

  for (let t = 0; t <= days; t++) {
    const vals = paths.map(path => path[t]).sort((a, b) => a - b);
    p5.push(vals[Math.floor(numPaths * 0.05)]);
    p25.push(vals[Math.floor(numPaths * 0.25)]);
    p50.push(vals[Math.floor(numPaths * 0.50)]);
    p75.push(vals[Math.floor(numPaths * 0.75)]);
    p95.push(vals[Math.floor(numPaths * 0.95)]);
  }

  const totalVar = sigma ** 2 + lambda * (muJ ** 2 + sigmaJ ** 2);
  const totalVol = Math.sqrt(totalVar);
  const jumpContribution = totalVar > 0 ? lambda * (muJ ** 2 + sigmaJ ** 2) / totalVar : 0;

  const interpretation =
    `推定ジャンプ頻度: 年${lambda.toFixed(1)}回（日次${(lambda / 252 * 100).toFixed(2)}%）。` +
    `ジャンプが全分散の${(jumpContribution * 100).toFixed(1)}%を説明。` +
    (jumpContribution > 0.3
      ? "ジャンプリスクが大きく、通常のGBMではリスクを過小評価。"
      : "ジャンプの影響は限定的。通常のGBMで概ね十分。");

  return {
    params,
    totalVol,
    jumpContribution,
    paths: paths.slice(0, 20), // display paths
    percentiles: { p5, p25, p50, p75, p95 },
    interpretation,
  };
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

function emptyParams(): JumpDiffusionParams {
  return { mu: 0, sigma: 0.2, lambda: 5, muJ: 0, sigmaJ: 0.01, k: 0 };
}
