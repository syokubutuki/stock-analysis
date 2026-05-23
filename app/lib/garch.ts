// GARCH(1,1), Leverage Effect, Jump Detection, Realized Variance Decomposition

export interface GarchResult {
  omega: number;
  alpha: number;
  beta: number;
  persistence: number;       // α + β
  halfLife: number;           // log(0.5)/log(α+β) — ボラショックの半減期(日)
  conditionalVol: number[];   // σ(t)
  logLikelihood: number;
}

export function fitGarch(returns: number[]): GarchResult {
  const n = returns.length;
  const variance = returns.reduce((a, v) => a + v * v, 0) / n;

  // Nelder-Mead で対数尤度を最大化
  // パラメータ: [omega, alpha, beta] を制約付きで探索
  let bestOmega = variance * 0.05;
  let bestAlpha = 0.1;
  let bestBeta = 0.85;
  let bestLL = -Infinity;

  // Grid search for initialization
  const alphas = [0.03, 0.05, 0.08, 0.1, 0.15, 0.2];
  const betas = [0.7, 0.75, 0.8, 0.85, 0.9, 0.93];

  for (const alpha of alphas) {
    for (const beta of betas) {
      if (alpha + beta >= 0.999) continue;
      const omega = variance * (1 - alpha - beta);
      if (omega <= 0) continue;
      const ll = garchLogLikelihood(returns, omega, alpha, beta);
      if (ll > bestLL) {
        bestLL = ll;
        bestOmega = omega;
        bestAlpha = alpha;
        bestBeta = beta;
      }
    }
  }

  // Refine with simple coordinate descent
  const step = [bestOmega * 0.1, 0.01, 0.01];
  for (let iter = 0; iter < 50; iter++) {
    for (let dim = 0; dim < 3; dim++) {
      const params = [bestOmega, bestAlpha, bestBeta];
      for (const dir of [-1, 1]) {
        const trial = [...params];
        trial[dim] += dir * step[dim];
        if (trial[0] <= 0 || trial[1] <= 0 || trial[2] <= 0) continue;
        if (trial[1] + trial[2] >= 0.999) continue;
        const ll = garchLogLikelihood(returns, trial[0], trial[1], trial[2]);
        if (ll > bestLL) {
          bestLL = ll;
          bestOmega = trial[0];
          bestAlpha = trial[1];
          bestBeta = trial[2];
        }
      }
    }
    step[0] *= 0.8;
    step[1] *= 0.8;
    step[2] *= 0.8;
  }

  const persistence = bestAlpha + bestBeta;
  const halfLife = persistence < 1 ? Math.log(0.5) / Math.log(persistence) : Infinity;
  const conditionalVol = garchConditionalVol(returns, bestOmega, bestAlpha, bestBeta);

  return {
    omega: bestOmega,
    alpha: bestAlpha,
    beta: bestBeta,
    persistence,
    halfLife,
    conditionalVol,
    logLikelihood: bestLL,
  };
}

function garchLogLikelihood(
  returns: number[], omega: number, alpha: number, beta: number
): number {
  const n = returns.length;
  let sigma2 = returns.reduce((a, v) => a + v * v, 0) / n;
  let ll = 0;
  for (let t = 0; t < n; t++) {
    if (sigma2 < 1e-20) sigma2 = 1e-20;
    ll += -0.5 * (Math.log(2 * Math.PI) + Math.log(sigma2) + (returns[t] * returns[t]) / sigma2);
    sigma2 = omega + alpha * returns[t] * returns[t] + beta * sigma2;
  }
  return ll;
}

function garchConditionalVol(
  returns: number[], omega: number, alpha: number, beta: number
): number[] {
  const n = returns.length;
  let sigma2 = returns.reduce((a, v) => a + v * v, 0) / n;
  const vol: number[] = [];
  for (let t = 0; t < n; t++) {
    vol.push(Math.sqrt(sigma2));
    sigma2 = omega + alpha * returns[t] * returns[t] + beta * sigma2;
    if (sigma2 < 1e-20) sigma2 = 1e-20;
  }
  return vol;
}

// ---- Leverage Effect ----

export interface LeverageResult {
  asymmetryCoeff: number;
  newsImpactCurve: { ret: number; vol: number }[];
  negativeVolMean: number;
  positiveVolMean: number;
}

export function analyzeLeverage(returns: number[]): LeverageResult {
  const n = returns.length;
  const absRet = returns.map(Math.abs);

  // 負リターン日 vs 正リターン日の翌日ボラティリティ
  let negSum = 0, negCount = 0;
  let posSum = 0, posCount = 0;
  for (let t = 0; t < n - 1; t++) {
    if (returns[t] < 0) { negSum += absRet[t + 1]; negCount++; }
    else if (returns[t] > 0) { posSum += absRet[t + 1]; posCount++; }
  }
  const negMean = negCount > 0 ? negSum / negCount : 0;
  const posMean = posCount > 0 ? posSum / posCount : 0;
  const asymmetryCoeff = posMean > 0 ? negMean / posMean : 1;

  // News Impact Curve: E[|r_{t+1}| | r_t = x]
  const sorted = returns.slice().sort((a, b) => a - b);
  const numBins = 20;
  const curve: { ret: number; vol: number }[] = [];
  const binSize = Math.ceil(n / numBins);
  for (let i = 0; i < numBins; i++) {
    const start = i * binSize;
    const end = Math.min(start + binSize, n);
    const binReturns = sorted.slice(start, end);
    const meanRet = binReturns.reduce((a, b) => a + b, 0) / binReturns.length;
    // find matching next-day abs returns
    let volSum = 0, count = 0;
    for (let t = 0; t < n - 1; t++) {
      if (returns[t] >= (binReturns[0] ?? 0) && returns[t] <= (binReturns[binReturns.length - 1] ?? 0)) {
        volSum += absRet[t + 1];
        count++;
      }
    }
    curve.push({ ret: meanRet, vol: count > 0 ? volSum / count : 0 });
  }

  return { asymmetryCoeff, newsImpactCurve: curve, negativeVolMean: negMean, positiveVolMean: posMean };
}

// ---- Jump Detection (BNS test) ----

export interface JumpResult {
  jumpDays: number[];
  jumpSizes: number[];
  bipowerVariation: number[];  // rolling bipower
  jumpRatio: number;           // fraction of variance from jumps
  realizedVariance: number;
  continuousVariance: number;
}

export function detectJumps(returns: number[], window: number = 20): JumpResult {
  const n = returns.length;

  // Bipower Variation: BV_t = (π/2) Σ |r_i| |r_{i-1}|
  const mu1 = Math.sqrt(2 / Math.PI); // E[|Z|] for standard normal
  const bipowerVariation: number[] = new Array(n).fill(0);

  for (let t = window; t < n; t++) {
    let bv = 0;
    let rv = 0;
    for (let i = t - window + 1; i <= t; i++) {
      rv += returns[i] * returns[i];
      if (i > t - window + 1) {
        bv += Math.abs(returns[i]) * Math.abs(returns[i - 1]);
      }
    }
    bv *= Math.PI / 2 / (window - 1);
    bipowerVariation[t] = bv;
  }

  // Jump detection: J_t = |r_t|² >> expected from BV
  const jumpDays: number[] = [];
  const jumpSizes: number[] = [];
  const threshold = 3.0; // z-score threshold

  for (let t = window; t < n; t++) {
    const bv = bipowerVariation[t];
    if (bv <= 0) continue;
    const dailyVol = Math.sqrt(bv / window);
    const zScore = Math.abs(returns[t]) / dailyVol;
    if (zScore > threshold) {
      jumpDays.push(t);
      jumpSizes.push(returns[t]);
    }
  }

  const realizedVariance = returns.reduce((a, v) => a + v * v, 0);
  const totalBV = bipowerVariation.reduce((a, v) => a + v, 0) / Math.max(1, n - window);
  const continuousVariance = totalBV;
  const jumpRatio = realizedVariance > 0
    ? Math.max(0, 1 - continuousVariance / (realizedVariance / n))
    : 0;

  return { jumpDays, jumpSizes, bipowerVariation, jumpRatio, realizedVariance, continuousVariance };
}
