// GJR-GARCH(1,1) / EGARCH(1,1) - 非対称ボラティリティモデル

export interface GJRResult {
  omega: number;
  alpha: number;
  beta: number;
  gamma: number;  // 非対称項 (γ>0: 下落時vol増大)
  persistence: number;
  conditionalVol: number[];
  logLikelihood: number;
  leverageRatio: number;  // (α+γ)/α: 下落時の反応倍率
}

export interface EGARCHResult {
  omega: number;
  alpha: number;
  beta: number;
  gamma: number;  // γ<0: 非対称効果
  conditionalVol: number[];
  logLikelihood: number;
}

export interface AsymmetricGarchResult {
  gjr: GJRResult;
  egarch: EGARCHResult;
  standardGarch: { alpha: number; beta: number; logLikelihood: number };
  bestModel: "GJR" | "EGARCH" | "GARCH";
  interpretation: string;
}

// --- GJR-GARCH(1,1) ---
// σ²_t = ω + (α + γI_{ε<0})ε²_{t-1} + βσ²_{t-1}
export function fitGJR(returns: number[]): GJRResult {
  const n = returns.length;
  const variance = returns.reduce((a, v) => a + v * v, 0) / n;

  let bestOmega = variance * 0.05;
  let bestAlpha = 0.05;
  let bestBeta = 0.85;
  let bestGamma = 0.05;
  let bestLL = -Infinity;

  // Grid search
  for (const alpha of [0.02, 0.05, 0.08, 0.12]) {
    for (const beta of [0.75, 0.8, 0.85, 0.9]) {
      for (const gamma of [0, 0.03, 0.06, 0.1, 0.15]) {
        if (alpha + beta + gamma / 2 >= 0.999) continue;
        const omega = variance * (1 - alpha - beta - gamma / 2);
        if (omega <= 0) continue;
        const ll = gjrLogLikelihood(returns, omega, alpha, beta, gamma);
        if (ll > bestLL) {
          bestLL = ll;
          bestOmega = omega; bestAlpha = alpha; bestBeta = beta; bestGamma = gamma;
        }
      }
    }
  }

  // Coordinate descent refinement
  const step = [bestOmega * 0.1, 0.01, 0.01, 0.01];
  for (let iter = 0; iter < 40; iter++) {
    for (let dim = 0; dim < 4; dim++) {
      const params = [bestOmega, bestAlpha, bestBeta, bestGamma];
      for (const dir of [-1, 1]) {
        const trial = [...params];
        trial[dim] += dir * step[dim];
        if (trial[0] <= 0 || trial[1] < 0 || trial[2] <= 0 || trial[3] < 0) continue;
        if (trial[1] + trial[2] + trial[3] / 2 >= 0.999) continue;
        const ll = gjrLogLikelihood(returns, trial[0], trial[1], trial[2], trial[3]);
        if (ll > bestLL) {
          bestLL = ll;
          bestOmega = trial[0]; bestAlpha = trial[1]; bestBeta = trial[2]; bestGamma = trial[3];
        }
      }
    }
    step[0] *= 0.8; step[1] *= 0.8; step[2] *= 0.8; step[3] *= 0.8;
  }

  const conditionalVol = gjrConditionalVol(returns, bestOmega, bestAlpha, bestBeta, bestGamma);
  const persistence = bestAlpha + bestBeta + bestGamma / 2;
  const leverageRatio = bestAlpha > 0 ? (bestAlpha + bestGamma) / bestAlpha : 1;

  return {
    omega: bestOmega, alpha: bestAlpha, beta: bestBeta, gamma: bestGamma,
    persistence, conditionalVol, logLikelihood: bestLL, leverageRatio,
  };
}

function gjrLogLikelihood(r: number[], w: number, a: number, b: number, g: number): number {
  const n = r.length;
  let s2 = r.reduce((s, v) => s + v * v, 0) / n;
  let ll = 0;
  for (let t = 0; t < n; t++) {
    if (s2 < 1e-20) s2 = 1e-20;
    ll += -0.5 * (Math.log(2 * Math.PI) + Math.log(s2) + r[t] * r[t] / s2);
    const indicator = r[t] < 0 ? 1 : 0;
    s2 = w + (a + g * indicator) * r[t] * r[t] + b * s2;
  }
  return ll;
}

function gjrConditionalVol(r: number[], w: number, a: number, b: number, g: number): number[] {
  const n = r.length;
  let s2 = r.reduce((s, v) => s + v * v, 0) / n;
  const vol: number[] = [];
  for (let t = 0; t < n; t++) {
    vol.push(Math.sqrt(Math.max(s2, 1e-20)));
    const indicator = r[t] < 0 ? 1 : 0;
    s2 = w + (a + g * indicator) * r[t] * r[t] + b * s2;
    if (s2 < 1e-20) s2 = 1e-20;
  }
  return vol;
}

// --- EGARCH(1,1) ---
// ln(σ²_t) = ω + α|z_{t-1}| + γz_{t-1} + β·ln(σ²_{t-1})
// z_t = ε_t / σ_t
export function fitEGARCH(returns: number[]): EGARCHResult {
  const n = returns.length;
  const variance = returns.reduce((a, v) => a + v * v, 0) / n;
  const lnVar = Math.log(variance);

  let bestOmega = lnVar * 0.05;
  let bestAlpha = 0.15;
  let bestBeta = 0.95;
  let bestGamma = -0.05;
  let bestLL = -Infinity;

  // Grid search
  for (const omega of [lnVar * 0.02, lnVar * 0.05, lnVar * 0.1, lnVar * 0.2]) {
    for (const alpha of [0.05, 0.1, 0.15, 0.25]) {
      for (const beta of [0.85, 0.9, 0.95, 0.98]) {
        for (const gamma of [-0.15, -0.1, -0.05, 0, 0.05]) {
          const ll = egarchLogLikelihood(returns, omega, alpha, beta, gamma);
          if (ll > bestLL) {
            bestLL = ll;
            bestOmega = omega; bestAlpha = alpha; bestBeta = beta; bestGamma = gamma;
          }
        }
      }
    }
  }

  // Coordinate descent
  const step = [Math.abs(bestOmega) * 0.1 + 0.001, 0.01, 0.005, 0.01];
  for (let iter = 0; iter < 40; iter++) {
    for (let dim = 0; dim < 4; dim++) {
      const params = [bestOmega, bestAlpha, bestBeta, bestGamma];
      for (const dir of [-1, 1]) {
        const trial = [...params];
        trial[dim] += dir * step[dim];
        if (trial[1] < 0 || trial[2] < 0 || trial[2] > 0.999) continue;
        const ll = egarchLogLikelihood(returns, trial[0], trial[1], trial[2], trial[3]);
        if (ll > bestLL) {
          bestLL = ll;
          bestOmega = trial[0]; bestAlpha = trial[1]; bestBeta = trial[2]; bestGamma = trial[3];
        }
      }
    }
    step[0] *= 0.8; step[1] *= 0.8; step[2] *= 0.8; step[3] *= 0.8;
  }

  const conditionalVol = egarchConditionalVol(returns, bestOmega, bestAlpha, bestBeta, bestGamma);

  return {
    omega: bestOmega, alpha: bestAlpha, beta: bestBeta, gamma: bestGamma,
    conditionalVol, logLikelihood: bestLL,
  };
}

function egarchLogLikelihood(r: number[], w: number, a: number, b: number, g: number): number {
  const n = r.length;
  let lnS2 = Math.log(r.reduce((s, v) => s + v * v, 0) / n);
  let ll = 0;
  for (let t = 0; t < n; t++) {
    const s2 = Math.exp(lnS2);
    if (s2 < 1e-20 || !isFinite(s2)) return -Infinity;
    ll += -0.5 * (Math.log(2 * Math.PI) + lnS2 + r[t] * r[t] / s2);
    const z = r[t] / Math.sqrt(s2);
    lnS2 = w + a * (Math.abs(z) - Math.sqrt(2 / Math.PI)) + g * z + b * lnS2;
    if (!isFinite(lnS2)) return -Infinity;
  }
  return ll;
}

function egarchConditionalVol(r: number[], w: number, a: number, b: number, g: number): number[] {
  const n = r.length;
  let lnS2 = Math.log(r.reduce((s, v) => s + v * v, 0) / n);
  const vol: number[] = [];
  for (let t = 0; t < n; t++) {
    const s2 = Math.exp(lnS2);
    vol.push(Math.sqrt(Math.max(s2, 1e-20)));
    const z = r[t] / Math.sqrt(Math.max(s2, 1e-20));
    lnS2 = w + a * (Math.abs(z) - Math.sqrt(2 / Math.PI)) + g * z + b * lnS2;
    if (!isFinite(lnS2)) lnS2 = Math.log(1e-20);
  }
  return vol;
}

// --- 統合分析 ---
export function fitAsymmetricGarch(returns: number[]): AsymmetricGarchResult {
  const gjr = fitGJR(returns);
  const egarch = fitEGARCH(returns);

  // Standard GARCH for comparison (simple version)
  const n = returns.length;
  const variance = returns.reduce((a, v) => a + v * v, 0) / n;
  let gAlpha = 0.1, gBeta = 0.85;
  let gLL = -Infinity;
  for (const a of [0.03, 0.05, 0.08, 0.1, 0.15]) {
    for (const b of [0.75, 0.8, 0.85, 0.9]) {
      if (a + b >= 0.999) continue;
      const w = variance * (1 - a - b);
      if (w <= 0) continue;
      const ll = simpleGarchLL(returns, w, a, b);
      if (ll > gLL) { gLL = ll; gAlpha = a; gBeta = b; }
    }
  }
  const standardGarch = { alpha: gAlpha, beta: gBeta, logLikelihood: gLL };

  // Select best by log-likelihood (BIC would be better but LL is simpler here)
  const models: [string, number][] = [
    ["GJR", gjr.logLikelihood],
    ["EGARCH", egarch.logLikelihood],
    ["GARCH", gLL],
  ];
  models.sort((a, b) => b[1] - a[1]);
  const bestModel = models[0][0] as "GJR" | "EGARCH" | "GARCH";

  const hasLeverage = gjr.gamma > 0.01 || egarch.gamma < -0.01;
  const interpretation = hasLeverage
    ? `非対称効果（レバレッジ効果）が検出されました。下落時のボラティリティ反応は上昇時の${gjr.leverageRatio.toFixed(1)}倍です。${bestModel}モデルが最適。`
    : `非対称効果は弱い（GJR γ=${gjr.gamma.toFixed(4)}）。標準的なGARCH(1,1)で十分です。`;

  return { gjr, egarch, standardGarch, bestModel, interpretation };
}

function simpleGarchLL(r: number[], w: number, a: number, b: number): number {
  const n = r.length;
  let s2 = r.reduce((s, v) => s + v * v, 0) / n;
  let ll = 0;
  for (let t = 0; t < n; t++) {
    if (s2 < 1e-20) s2 = 1e-20;
    ll += -0.5 * (Math.log(2 * Math.PI) + Math.log(s2) + r[t] * r[t] / s2);
    s2 = w + a * r[t] * r[t] + b * s2;
  }
  return ll;
}
