// AR(p) モデル推定・予測
// Y_t = c + φ₁Y_{t-1} + φ₂Y_{t-2} + ... + φ_pY_{t-p} + ε_t

export interface ARResult {
  order: number;        // p
  coeffs: number[];     // [c, φ₁, ..., φ_p]
  sigma: number;        // 残差の標準偏差
  aic: number;
  bic: number;
  residuals: number[];
  rSquared: number;
  interpretation: string;
}

export interface ARForecast {
  point: number[];     // 点予測
  upper95: number[];   // 95%上限
  lower95: number[];   // 95%下限
}

export interface ArimaResult {
  original: ARResult;       // 原系列のAR
  differenced: ARResult;    // 差分系列のAR (ARIMA(p,1,0))
  bestModel: "AR" | "ARIMA";
  forecast: ARForecast;
  fittedValues: number[];
  interpretation: string;
}

// --- AR(p) 推定 (Yule-Walker) ---
export function fitAR(values: number[], maxOrder: number = 10): ARResult {
  const n = values.length;
  if (n < 30) return emptyAR();

  // Mean center
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;

  const y = values.map(v => v - mean);

  // Compute ACF
  const maxP = Math.min(maxOrder, Math.floor(n / 5));
  const acfVals = computeACF(y, maxP);

  // Select order by BIC
  let bestP = 0;
  let bestBIC = Infinity;
  let bestResult: ARResult | null = null;

  for (let p = 0; p <= maxP; p++) {
    const result = fitAROrder(values, y, mean, p, acfVals, n);
    if (!result) continue;
    if (result.bic < bestBIC) {
      bestBIC = result.bic;
      bestP = p;
      bestResult = result;
    }
  }

  return bestResult || emptyAR();
}

function fitAROrder(
  original: number[],
  centered: number[],
  mean: number,
  p: number,
  acfVals: number[],
  n: number
): ARResult | null {
  if (p === 0) {
    // AR(0): just constant
    const residuals = centered.slice();
    let sse = 0;
    for (const r of residuals) sse += r * r;
    const sigma = Math.sqrt(sse / n);
    const logL = -n / 2 * (1 + Math.log(2 * Math.PI) + Math.log(sse / n));
    return {
      order: 0,
      coeffs: [mean],
      sigma,
      aic: -2 * logL + 2,
      bic: -2 * logL + Math.log(n),
      residuals,
      rSquared: 0,
      interpretation: "AR(0): 定数のみ（ホワイトノイズ）",
    };
  }

  // Yule-Walker: solve R * φ = r
  // R[i][j] = acf[|i-j|], r[i] = acf[i+1]
  const R: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => acfVals[Math.abs(i - j)])
  );
  const r = Array.from({ length: p }, (_, i) => acfVals[i + 1]);

  const phi = solveLinear(R, r);
  if (!phi) return null;

  // Compute residuals and constant
  // c = mean * (1 - Σφᵢ)
  let sumPhi = 0;
  for (const v of phi) sumPhi += v;
  const c = mean * (1 - sumPhi);

  const coeffs = [c, ...phi];

  // Residuals
  const residuals: number[] = new Array(original.length).fill(0);
  let sse = 0;
  let count = 0;
  for (let t = p; t < original.length; t++) {
    let predicted = c;
    for (let j = 0; j < p; j++) {
      predicted += phi[j] * original[t - 1 - j];
    }
    residuals[t] = original[t] - predicted;
    sse += residuals[t] * residuals[t];
    count++;
  }

  const sigma = Math.sqrt(sse / Math.max(count - p - 1, 1));

  // R²
  let ssTot = 0;
  for (let t = p; t < original.length; t++) {
    ssTot += (original[t] - mean) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - sse / ssTot : 0;

  // Information criteria
  const logL = -count / 2 * (1 + Math.log(2 * Math.PI) + Math.log(sse / count));
  const k = p + 1; // constant + p coefficients
  const aic = -2 * logL + 2 * k;
  const bic = -2 * logL + k * Math.log(count);

  return {
    order: p,
    coeffs,
    sigma,
    aic,
    bic,
    residuals,
    rSquared,
    interpretation: `AR(${p}): ${phi.map((v, i) => `φ${i + 1}=${v.toFixed(4)}`).join(", ")}`,
  };
}

// --- 差分系列のAR → ARIMA(p,1,0) ---
export function fitARIMA(values: number[], maxOrder: number = 10): ArimaResult {
  const n = values.length;
  if (n < 30) return emptyARIMA();

  // Original series AR
  const arOriginal = fitAR(values, maxOrder);

  // First difference
  const diff: number[] = [];
  for (let i = 1; i < n; i++) diff.push(values[i] - values[i - 1]);

  const arDiff = fitAR(diff, maxOrder);

  // Which is better? Compare BIC
  const bestModel = arOriginal.bic < arDiff.bic ? "AR" as const : "ARIMA" as const;
  const bestAR = bestModel === "AR" ? arOriginal : arDiff;

  // Forecast
  const horizon = 20;
  const forecast = bestModel === "AR"
    ? forecastAR(values, arOriginal, horizon)
    : forecastARIMA(values, diff, arDiff, horizon);

  // Fitted values
  const fittedValues = computeFitted(values, bestModel === "AR" ? arOriginal : arDiff, bestModel);

  const interpretation = bestModel === "AR"
    ? `原系列にAR(${arOriginal.order})が最適。BIC=${arOriginal.bic.toFixed(1)}。R²=${arOriginal.rSquared.toFixed(4)}。系列に自己回帰構造が検出されました。`
    : `差分系列にAR(${arDiff.order})（=ARIMA(${arDiff.order},1,0)）が最適。BIC=${arDiff.bic.toFixed(1)}。原系列は非定常で、差分を取ることで定常化されます。`;

  return {
    original: arOriginal,
    differenced: arDiff,
    bestModel,
    forecast,
    fittedValues,
    interpretation,
  };
}

// --- AR 予測 ---
function forecastAR(values: number[], ar: ARResult, horizon: number): ARForecast {
  const p = ar.order;
  const c = ar.coeffs[0];
  const phi = ar.coeffs.slice(1);

  const history = [...values];
  const point: number[] = [];
  const upper95: number[] = [];
  const lower95: number[] = [];

  // Cumulative forecast variance
  let cumVar = 0;
  const psiCoeffs = computePsiWeights(phi, horizon);

  for (let h = 0; h < horizon; h++) {
    let pred = c;
    for (let j = 0; j < p; j++) {
      const idx = history.length - 1 - j;
      if (idx >= 0) pred += phi[j] * history[idx];
    }
    history.push(pred);
    point.push(pred);

    cumVar += psiCoeffs[h] ** 2 * ar.sigma ** 2;
    const se = Math.sqrt(cumVar);
    upper95.push(pred + 1.96 * se);
    lower95.push(pred - 1.96 * se);
  }

  return { point, upper95, lower95 };
}

function forecastARIMA(
  original: number[],
  diff: number[],
  arDiff: ARResult,
  horizon: number
): ARForecast {
  const diffForecast = forecastAR(diff, arDiff, horizon);
  const lastValue = original[original.length - 1];

  // Cumulative sum to get level forecast
  const point: number[] = [];
  const upper95: number[] = [];
  const lower95: number[] = [];

  let cumPoint = lastValue;
  let cumUpper = lastValue;
  let cumLower = lastValue;

  for (let h = 0; h < horizon; h++) {
    cumPoint += diffForecast.point[h];
    cumUpper += diffForecast.upper95[h] - diffForecast.point[h];
    cumLower += diffForecast.lower95[h] - diffForecast.point[h];

    point.push(cumPoint);
    upper95.push(cumPoint + (cumUpper - cumPoint) * Math.sqrt(h + 1));
    lower95.push(cumPoint - (cumPoint - cumLower) * Math.sqrt(h + 1));
  }

  // Recalculate bounds properly
  const sigma = arDiff.sigma;
  for (let h = 0; h < horizon; h++) {
    const se = sigma * Math.sqrt(h + 1);
    upper95[h] = point[h] + 1.96 * se;
    lower95[h] = point[h] - 1.96 * se;
  }

  return { point, upper95, lower95 };
}

// Ψ weights for forecast error variance
function computePsiWeights(phi: number[], horizon: number): number[] {
  const p = phi.length;
  const psi: number[] = [1]; // ψ₀ = 1

  for (let h = 1; h <= horizon; h++) {
    let val = 0;
    for (let j = 0; j < Math.min(h, p); j++) {
      val += phi[j] * (h - 1 - j >= 0 ? psi[h - 1 - j] : 0);
    }
    psi.push(val);
  }

  return psi;
}

function computeFitted(values: number[], ar: ARResult, model: "AR" | "ARIMA"): number[] {
  const p = ar.order;
  const c = ar.coeffs[0];
  const phi = ar.coeffs.slice(1);

  if (model === "AR") {
    const fitted: number[] = new Array(values.length).fill(NaN);
    for (let t = p; t < values.length; t++) {
      let pred = c;
      for (let j = 0; j < p; j++) pred += phi[j] * values[t - 1 - j];
      fitted[t] = pred;
    }
    return fitted;
  } else {
    // ARIMA: fit on differences, then integrate
    const diff: number[] = [];
    for (let i = 1; i < values.length; i++) diff.push(values[i] - values[i - 1]);

    const fitted: number[] = new Array(values.length).fill(NaN);
    for (let t = p; t < diff.length; t++) {
      let pred = c;
      for (let j = 0; j < p; j++) pred += phi[j] * diff[t - 1 - j];
      fitted[t + 1] = values[t] + pred;
    }
    return fitted;
  }
}

// --- ACF ---
function computeACF(centered: number[], maxLag: number): number[] {
  const n = centered.length;
  let c0 = 0;
  for (const v of centered) c0 += v * v;
  c0 /= n;

  if (c0 === 0) return new Array(maxLag + 1).fill(0);

  const acf: number[] = [1];
  for (let k = 1; k <= maxLag; k++) {
    let ck = 0;
    for (let t = k; t < n; t++) ck += centered[t] * centered[t - k];
    ck /= n;
    acf.push(ck / c0);
  }
  return acf;
}

// --- Gauss elimination ---
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const aug = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-15) return null;

    for (let j = col; j <= n; j++) aug[col][j] /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = aug[row][col];
      for (let j = col; j <= n; j++) aug[row][j] -= f * aug[col][j];
    }
  }

  return aug.map(row => row[n]);
}

// --- Empty results ---
function emptyAR(): ARResult {
  return {
    order: 0, coeffs: [0], sigma: 0, aic: Infinity, bic: Infinity,
    residuals: [], rSquared: 0, interpretation: "データ不足",
  };
}

function emptyARIMA(): ArimaResult {
  return {
    original: emptyAR(), differenced: emptyAR(), bestModel: "ARIMA",
    forecast: { point: [], upper95: [], lower95: [] },
    fittedValues: [], interpretation: "データ不足",
  };
}
