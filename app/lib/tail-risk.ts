// Extreme Value Theory (EVT), Higher-Order Cumulants, Tail Dependence

// ---- EVT: Generalized Pareto Distribution ----

export interface EVTResult {
  shape: number;      // ξ (shape parameter)
  scale: number;      // β (scale parameter)
  threshold: number;  // u (threshold)
  nExceedances: number;
  var95: number;
  var99: number;
  expectedShortfall95: number;
  expectedShortfall99: number;
  returnLevels: { period: number; level: number }[];
  qqPlot: { theoretical: number; empirical: number }[];
  interpretation: string;
}

export function extremeValueAnalysis(returns: number[], quantile: number = 0.9): EVTResult {
  const n = returns.length;
  // Work with losses (negative returns)
  const losses = returns.map((r) => -r).sort((a, b) => a - b);
  const thresholdIdx = Math.floor(n * quantile);
  const threshold = losses[thresholdIdx];
  const exceedances = losses.filter((l) => l > threshold).map((l) => l - threshold);
  const nExc = exceedances.length;

  if (nExc < 10) {
    return emptyEVTResult(threshold);
  }

  // Fit GPD by maximum likelihood (Grimshaw's method simplified)
  // For ξ ≠ 0: f(x) = (1/β)(1 + ξx/β)^(-1/ξ - 1)
  // MLE via profile likelihood over ξ
  let bestShape = 0;
  let bestScale = mean(exceedances);
  let bestLL = -Infinity;

  for (let xi = -0.5; xi <= 1.0; xi += 0.01) {
    const beta = estimateGPDScale(exceedances, xi);
    if (beta <= 0) continue;
    const ll = gpdLogLikelihood(exceedances, xi, beta);
    if (ll > bestLL) {
      bestLL = ll;
      bestShape = xi;
      bestScale = beta;
    }
  }

  // Refine
  for (let delta = 0.005; delta >= 0.0005; delta /= 2) {
    for (const xi of [bestShape - delta, bestShape, bestShape + delta]) {
      const beta = estimateGPDScale(exceedances, xi);
      if (beta <= 0) continue;
      const ll = gpdLogLikelihood(exceedances, xi, beta);
      if (ll > bestLL) { bestLL = ll; bestShape = xi; bestScale = beta; }
    }
  }

  const xi = bestShape;
  const beta = bestScale;
  const excRate = nExc / n;

  // VaR: u + (β/ξ) * ((n/nExc * (1-p))^(-ξ) - 1)
  const var95 = gpdVaR(0.95, threshold, xi, beta, excRate);
  const var99 = gpdVaR(0.99, threshold, xi, beta, excRate);
  const es95 = xi < 1 ? var95 / (1 - xi) + (beta - xi * threshold) / (1 - xi) : Infinity;
  const es99 = xi < 1 ? var99 / (1 - xi) + (beta - xi * threshold) / (1 - xi) : Infinity;

  // Return levels
  const returnLevels = [10, 20, 50, 100, 250, 500].map((period) => ({
    period,
    level: gpdReturnLevel(period, threshold, xi, beta, excRate),
  }));

  // Q-Q plot
  const sortedExc = exceedances.slice().sort((a, b) => a - b);
  const qqPlot = sortedExc.map((v, i) => {
    const p = (i + 0.5) / nExc;
    const theoretical = xi !== 0
      ? (beta / xi) * (Math.pow(1 - p, -xi) - 1)
      : -beta * Math.log(1 - p);
    return { theoretical, empirical: v };
  });

  let interpretation: string;
  if (xi > 0.3) interpretation = "非常に厚い裾 (パレート型) — 極端なリスクが高い";
  else if (xi > 0) interpretation = "厚い裾 — 正規分布より大きなテイルリスク";
  else if (xi > -0.1) interpretation = "指数型の裾 — 適度なテイルリスク";
  else interpretation = "薄い裾 — テイルリスクは限定的";

  return {
    shape: xi, scale: beta, threshold, nExceedances: nExc,
    var95, var99, expectedShortfall95: es95, expectedShortfall99: es99,
    returnLevels, qqPlot, interpretation,
  };
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function estimateGPDScale(exceedances: number[], xi: number): number {
  const n = exceedances.length;
  if (Math.abs(xi) < 1e-6) {
    return mean(exceedances);
  }
  // β = (1 + ξ) * mean(exceedances) for method of moments
  // More precise: from MLE condition
  let sum = 0;
  for (const x of exceedances) {
    const val = 1 + xi * x / (mean(exceedances) * (1 + xi));
    if (val <= 0) return -1;
    sum += Math.log(val);
  }
  return mean(exceedances) * (1 + xi);
}

function gpdLogLikelihood(exceedances: number[], xi: number, beta: number): number {
  if (beta <= 0) return -Infinity;
  let ll = 0;
  for (const x of exceedances) {
    if (Math.abs(xi) < 1e-6) {
      ll += -Math.log(beta) - x / beta;
    } else {
      const val = 1 + xi * x / beta;
      if (val <= 0) return -Infinity;
      ll += -Math.log(beta) - (1 / xi + 1) * Math.log(val);
    }
  }
  return ll;
}

function gpdVaR(p: number, u: number, xi: number, beta: number, excRate: number): number {
  const m = 1 / excRate;
  if (Math.abs(xi) < 1e-6) {
    return u + beta * Math.log(m * (1 - p));
  }
  return u + (beta / xi) * (Math.pow(m * (1 - p), -xi) - 1);
}

function gpdReturnLevel(period: number, u: number, xi: number, beta: number, excRate: number): number {
  const p = 1 - 1 / period;
  return gpdVaR(p, u, xi, beta, excRate);
}

function emptyEVTResult(threshold: number): EVTResult {
  return {
    shape: 0, scale: 0, threshold, nExceedances: 0,
    var95: 0, var99: 0, expectedShortfall95: 0, expectedShortfall99: 0,
    returnLevels: [], qqPlot: [], interpretation: "データ不足",
  };
}

// ---- Higher-Order Cumulants ----

export interface CumulantResult {
  mean: number;
  variance: number;
  skewness: number;    // κ₃ / κ₂^(3/2)
  kurtosis: number;    // κ₄ / κ₂²
  c5: number;          // normalized 5th cumulant
  c6: number;          // normalized 6th cumulant
  isGaussian: boolean; // all higher cumulants near zero
}

export function higherOrderCumulants(values: number[]): CumulantResult {
  const n = values.length;
  const m = values.reduce((a, b) => a + b, 0) / n;
  const centered = values.map((v) => v - m);

  const mu2 = centered.reduce((a, v) => a + v ** 2, 0) / n;
  const mu3 = centered.reduce((a, v) => a + v ** 3, 0) / n;
  const mu4 = centered.reduce((a, v) => a + v ** 4, 0) / n;
  const mu5 = centered.reduce((a, v) => a + v ** 5, 0) / n;
  const mu6 = centered.reduce((a, v) => a + v ** 6, 0) / n;

  const sigma = Math.sqrt(mu2) || 1e-10;
  const skewness = mu3 / sigma ** 3;
  const kurtosis = mu4 / sigma ** 4 - 3; // excess kurtosis

  // 5th and 6th cumulants (excess)
  // κ₅ = μ₅ - 10μ₃μ₂
  // κ₆ = μ₆ - 15μ₄μ₂ - 10μ₃² + 30μ₂³
  const k5 = mu5 - 10 * mu3 * mu2;
  const k6 = mu6 - 15 * mu4 * mu2 - 10 * mu3 * mu3 + 30 * mu2 * mu2 * mu2;

  const c5 = k5 / sigma ** 5;
  const c6 = k6 / sigma ** 6;

  const isGaussian = Math.abs(skewness) < 0.5 && Math.abs(kurtosis) < 1 && Math.abs(c5) < 1 && Math.abs(c6) < 2;

  return { mean: m, variance: mu2, skewness, kurtosis, c5, c6, isGaussian };
}

// ---- Tail Dependence (price returns vs volume returns) ----

export interface TailDependenceResult {
  lowerTail: number;  // λ_L
  upperTail: number;  // λ_U
  kendallTau: number;
  quantilesUsed: number;
}

export function tailDependence(x: number[], y: number[], quantile: number = 0.1): TailDependenceResult {
  const n = Math.min(x.length, y.length);

  // Convert to ranks (empirical CDF)
  const rankX = toRanks(x.slice(0, n));
  const rankY = toRanks(y.slice(0, n));

  // Lower tail: λ_L = P(U ≤ q | V ≤ q) for small q
  let lowerCount = 0, lowerTotal = 0;
  let upperCount = 0, upperTotal = 0;
  const q = quantile;

  for (let i = 0; i < n; i++) {
    if (rankY[i] <= q) {
      lowerTotal++;
      if (rankX[i] <= q) lowerCount++;
    }
    if (rankY[i] >= 1 - q) {
      upperTotal++;
      if (rankX[i] >= 1 - q) upperCount++;
    }
  }

  const lowerTail = lowerTotal > 0 ? lowerCount / lowerTotal : 0;
  const upperTail = upperTotal > 0 ? upperCount / upperTotal : 0;

  // Kendall's tau
  let concordant = 0, discordant = 0;
  const sampleSize = Math.min(n, 500);
  const stepK = Math.max(1, Math.floor(n / sampleSize));
  for (let i = 0; i < n; i += stepK) {
    for (let j = i + stepK; j < n; j += stepK) {
      const dx = x[i] - x[j];
      const dy = y[i] - y[j];
      if (dx * dy > 0) concordant++;
      else if (dx * dy < 0) discordant++;
    }
  }
  const kendallTau = (concordant + discordant) > 0
    ? (concordant - discordant) / (concordant + discordant)
    : 0;

  return { lowerTail, upperTail, kendallTau, quantilesUsed: q };
}

function toRanks(values: number[]): number[] {
  const n = values.length;
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(n);
  for (let i = 0; i < n; i++) {
    ranks[indexed[i].i] = (i + 0.5) / n;
  }
  return ranks;
}
