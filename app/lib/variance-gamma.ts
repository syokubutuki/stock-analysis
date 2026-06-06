// Variance Gamma Process
// X(t) = theta * G(t) + sigma * W(G(t))
// G: ガンマ過程 (内在時間), W: 標準ブラウン運動

export interface VGParams {
  sigma: number; // BM volatility
  theta: number; // drift (skewness control)
  nu: number; // variance rate of Gamma (kurtosis control)
  mu: number; // overall drift
}

export interface VGResult {
  params: VGParams;
  paths: number[][];
  percentiles: {
    p5: number[];
    p25: number[];
    p50: number[];
    p75: number[];
    p95: number[];
  };
  densityComparison: { x: number; empirical: number; vg: number; normal: number }[];
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
 * ガンマ変量生成 (Marsaglia-Tsang method for shape >= 1)
 * shape < 1 の場合は Ahrens-Dieter で補正
 */
function gammaVariate(shape: number, scale: number, rng: () => number): number {
  if (shape < 1) {
    // Gamma(a) = Gamma(a+1) * U^(1/a)
    return gammaVariate(shape + 1, scale, rng) * Math.pow(rng() || 1e-10, 1 / shape);
  }

  // Marsaglia-Tsang
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  for (let iter = 0; iter < 1000; iter++) {
    let x: number, v: number;
    do {
      x = boxMuller(rng);
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = rng();

    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }

  return shape * scale; // fallback
}

export function fitVarianceGamma(returns: number[]): VGParams {
  const n = returns.length;
  if (n < 50) return { sigma: 0.01, theta: 0, nu: 0.5, mu: 0 };

  let m1 = 0, m2 = 0, m3 = 0, m4 = 0;
  for (const r of returns) {
    m1 += r;
    m2 += r * r;
    m3 += r * r * r;
    m4 += r * r * r * r;
  }
  m1 /= n; m2 /= n; m3 /= n; m4 /= n;

  const variance = m2 - m1 * m1;
  const sd = Math.sqrt(Math.max(variance, 1e-12));
  const skewness = (m3 - 3 * m1 * m2 + 2 * m1 ** 3) / (sd ** 3);
  const excessKurt = Math.max(
    (m4 - 4 * m1 * m3 + 6 * m1 * m1 * m2 - 3 * m1 ** 4) / (sd ** 4) - 3,
    0.01
  );

  // Moment matching: nu = excessKurt / 3 (approximately)
  const nu = Math.max(0.01, Math.min(2, excessKurt / 3));

  // theta controls skewness: skew = 2 * theta * nu^(3/2) / sigma^3 (approximately)
  const theta = (skewness * sd) / (3 * Math.sqrt(Math.max(nu, 0.01)));
  const clampedTheta = Math.max(-0.1, Math.min(0.1, theta));

  // sigma: total variance = sigma^2 + theta^2 * nu
  const sigma = Math.sqrt(Math.max(variance - clampedTheta * clampedTheta * nu, variance * 0.5));

  return { sigma, theta: clampedTheta, nu, mu: m1 };
}

export function simulateVG(
  params: VGParams,
  S0: number,
  days: number = 60,
  nPaths: number = 500,
  seed: number = 42
): VGResult {
  const rng = mulberry32(seed);
  const { sigma, theta, nu, mu } = params;

  // VG correction: omega = (1/nu) * ln(1 - theta*nu - sigma^2*nu/2)
  const omega = nu > 1e-10
    ? Math.log(Math.max(1 - theta * nu - (sigma * sigma * nu) / 2, 0.01)) / nu
    : 0;

  const paths: number[][] = [];
  const allPrices: number[][] = Array.from({ length: days + 1 }, () => []);

  for (let p = 0; p < nPaths; p++) {
    const path = [S0];
    for (let d = 1; d <= days; d++) {
      // Gamma subordinator: G ~ Gamma(1/nu, nu)
      const G = gammaVariate(1 / nu, nu, rng);

      // VG increment: X = theta*G + sigma*sqrt(G)*Z
      const Z = boxMuller(rng);
      const X = theta * G + sigma * Math.sqrt(Math.max(G, 0)) * Z;

      // Price: S(t+1) = S(t) * exp(mu + omega + X)
      const prevPrice = path[path.length - 1];
      const nextPrice = prevPrice * Math.exp(mu + omega + X);
      path.push(Math.max(nextPrice, 0.01));
    }
    paths.push(path);
    for (let d = 0; d <= days; d++) allPrices[d].push(path[d]);
  }

  // Percentiles
  const percentiles = {
    p5: new Array(days + 1),
    p25: new Array(days + 1),
    p50: new Array(days + 1),
    p75: new Array(days + 1),
    p95: new Array(days + 1),
  };

  for (let d = 0; d <= days; d++) {
    const sorted = allPrices[d].sort((a, b) => a - b);
    const pct = (q: number) => sorted[Math.floor(q * sorted.length)] || sorted[0];
    percentiles.p5[d] = pct(0.05);
    percentiles.p25[d] = pct(0.25);
    percentiles.p50[d] = pct(0.5);
    percentiles.p75[d] = pct(0.75);
    percentiles.p95[d] = pct(0.95);
  }

  // Density comparison
  const simReturns: number[] = [];
  for (const path of paths.slice(0, 200)) {
    for (let d = 1; d < path.length; d++) {
      simReturns.push(Math.log(path[d] / path[d - 1]));
    }
  }

  const muR = params.mu;
  const sigR = params.sigma;
  const nBins = 50;
  const rMin = -5 * sigR, rMax = 5 * sigR;
  const binW = (rMax - rMin) / nBins;

  const densityComparison: VGResult["densityComparison"] = [];
  const empiricalHist = new Array(nBins).fill(0);
  const vgHist = new Array(nBins).fill(0);

  for (const r of simReturns) {
    const bin = Math.floor((r - rMin) / binW);
    if (bin >= 0 && bin < nBins) vgHist[bin]++;
  }

  // 正規分布密度
  for (let i = 0; i < nBins; i++) {
    const x = rMin + (i + 0.5) * binW;
    const normalDensity =
      Math.exp(-((x - muR) ** 2) / (2 * sigR * sigR)) /
      (sigR * Math.sqrt(2 * Math.PI));
    const vgDensity = simReturns.length > 0
      ? vgHist[i] / (simReturns.length * binW)
      : 0;

    densityComparison.push({
      x,
      empirical: 0, // will be filled by component with actual data
      vg: vgDensity,
      normal: normalDensity,
    });
  }

  const interpretation =
    `VGパラメータ: sigma=${sigma.toFixed(4)}, theta=${theta.toFixed(4)}, nu=${nu.toFixed(3)}。` +
    (Math.abs(theta) > 0.001
      ? `theta${theta < 0 ? "<0" : ">0"}は${theta < 0 ? "負" : "正"}の歪度（${theta < 0 ? "下落" : "上昇"}方向のジャンプが多い）を示します。`
      : "theta≈0で分布はほぼ対称です。") +
    `nu=${nu.toFixed(3)}${nu > 0.5 ? "は裾の厚い分布" : "は正規分布に近い形状"}を示します。` +
    `60日後の中央値は${percentiles.p50[days].toFixed(0)}、90%区間は[${percentiles.p5[days].toFixed(0)}, ${percentiles.p95[days].toFixed(0)}]です。`;

  return {
    params,
    paths: paths.slice(0, 50),
    percentiles,
    densityComparison,
    interpretation,
  };
}
