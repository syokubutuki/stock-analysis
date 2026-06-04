// ADF (Augmented Dickey-Fuller) / KPSS 単位根検定

export interface ADFResult {
  testStat: number;
  pValue: number;
  lags: number;
  criticalValues: { "1%": number; "5%": number; "10%": number };
  isStationary: boolean;
  interpretation: string;
}

export interface KPSSResult {
  testStat: number;
  criticalValues: { "1%": number; "5%": number; "10%": number };
  isStationary: boolean;
  interpretation: string;
}

export interface UnitRootResult {
  adf: ADFResult;
  kpss: KPSSResult;
  conclusion: "stationary" | "unit_root" | "ambiguous";
  rollingADF: { time: string; stat: number; critical5: number }[];
}

// --- OLS Helper ---
function olsRegression(
  X: number[][],
  y: number[]
): { coeffs: number[]; residuals: number[]; sse: number; se: number[] } {
  const n = y.length;
  const k = X[0].length;

  // X'X
  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let t = 0; t < n; t++) s += X[t][i] * X[t][j];
      XtX[i][j] = s;
    }
  }

  // X'y
  const Xty: number[] = new Array(k).fill(0);
  for (let i = 0; i < k; i++) {
    let s = 0;
    for (let t = 0; t < n; t++) s += X[t][i] * y[t];
    Xty[i] = s;
  }

  // Solve via Gauss elimination
  const coeffs = solveLinear(XtX, Xty);

  // Residuals
  const residuals: number[] = new Array(n);
  let sse = 0;
  for (let t = 0; t < n; t++) {
    let yHat = 0;
    for (let j = 0; j < k; j++) yHat += X[t][j] * coeffs[j];
    residuals[t] = y[t] - yHat;
    sse += residuals[t] * residuals[t];
  }

  // Standard errors
  const s2 = sse / Math.max(n - k, 1);
  const inv = invertMatrix(XtX);
  const se = inv ? inv.map((row, i) => Math.sqrt(Math.max(s2 * row[i], 0))) : new Array(k).fill(0);

  return { coeffs, residuals, sse, se };
}

function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  const aug = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Pivot
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-15) continue;

    for (let j = col; j <= n; j++) aug[col][j] /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = col; j <= n; j++) aug[row][j] -= factor * aug[col][j];
    }
  }

  return aug.map((row) => row[n]);
}

function invertMatrix(A: number[][]): number[][] | null {
  const n = A.length;
  const aug = A.map((row, i) => {
    const r = new Array(2 * n).fill(0);
    for (let j = 0; j < n; j++) r[j] = row[j];
    r[n + i] = 1;
    return r;
  });

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-15) return null;
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = aug[row][col];
      for (let j = 0; j < 2 * n; j++) aug[row][j] -= f * aug[col][j];
    }
  }

  return aug.map((row) => row.slice(n));
}

// --- ADF Test ---
// H₀: unit root exists (γ = 0)
// ΔY_t = α + γY_{t-1} + Σδ_iΔY_{t-i} + ε_t
export function adfTest(values: number[], maxLag?: number): ADFResult {
  const n = values.length;
  if (n < 20) return emptyADF();

  // Differences
  const dy: number[] = [];
  for (let i = 1; i < n; i++) dy.push(values[i] - values[i - 1]);

  // Select lag by BIC
  const maxP = maxLag ?? Math.min(Math.floor(12 * Math.pow(n / 100, 0.25)), Math.floor(n / 5));
  let bestLag = 0;
  let bestBIC = Infinity;

  for (let p = 0; p <= maxP; p++) {
    const result = adfRegression(values, dy, p);
    if (!result) continue;
    const m = result.n;
    const k = result.k;
    const bic = m * Math.log(result.sse / m) + k * Math.log(m);
    if (bic < bestBIC) {
      bestBIC = bic;
      bestLag = p;
    }
  }

  const reg = adfRegression(values, dy, bestLag);
  if (!reg) return emptyADF();

  const tStat = reg.gamma / reg.gammaSE;

  // MacKinnon critical values (with constant, no trend) approximate
  const cv1 = -3.43;
  const cv5 = -2.86;
  const cv10 = -2.57;

  // Approximate p-value using MacKinnon (1994) response surface
  const pValue = adfPValue(tStat, n);

  const isStationary = tStat < cv5;

  return {
    testStat: tStat,
    pValue,
    lags: bestLag,
    criticalValues: { "1%": cv1, "5%": cv5, "10%": cv10 },
    isStationary,
    interpretation: isStationary
      ? `ADF検定統計量 ${tStat.toFixed(3)} < 5%臨界値 ${cv5}。帰無仮説（単位根あり）を棄却→定常系列の可能性が高い。`
      : `ADF検定統計量 ${tStat.toFixed(3)} ≥ 5%臨界値 ${cv5}。帰無仮説を棄却できない→単位根が存在する可能性が高い。`,
  };
}

function adfRegression(
  y: number[],
  dy: number[],
  p: number
): { gamma: number; gammaSE: number; sse: number; n: number; k: number } | null {
  const nObs = dy.length - p;
  if (nObs < 10) return null;

  const X: number[][] = [];
  const Y: number[] = [];

  for (let t = p; t < dy.length; t++) {
    const row: number[] = [1, y[t]]; // intercept + Y_{t-1} (level)
    for (let j = 1; j <= p; j++) row.push(dy[t - j]);
    X.push(row);
    Y.push(dy[t]);
  }

  const ols = olsRegression(X, Y);
  return {
    gamma: ols.coeffs[1],
    gammaSE: ols.se[1] || 1e-10,
    sse: ols.sse,
    n: nObs,
    k: 2 + p,
  };
}

function adfPValue(tau: number, n: number): number {
  // Simplified MacKinnon p-value approximation for "c" (constant, no trend)
  if (tau < -4.5) return 0.001;
  if (tau > -0.5) return 0.99;
  // Linear interpolation from tabulated values
  const table: [number, number][] = [
    [-4.5, 0.001], [-4.0, 0.003], [-3.5, 0.01], [-3.0, 0.03],
    [-2.86, 0.05], [-2.57, 0.10], [-2.0, 0.25], [-1.5, 0.45],
    [-1.0, 0.65], [-0.5, 0.80],
  ];
  for (let i = 1; i < table.length; i++) {
    if (tau <= table[i][0]) {
      const [t0, p0] = table[i - 1];
      const [t1, p1] = table[i];
      return p0 + ((p1 - p0) * (tau - t0)) / (t1 - t0);
    }
  }
  return 0.99;
}

// --- KPSS Test ---
// H₀: stationary (σ²_u = 0)
export function kpssTest(values: number[], type: "level" | "trend" = "level"): KPSSResult {
  const n = values.length;
  if (n < 20) return emptyKPSS();

  // Detrend: regress on constant (level) or constant + trend (trend)
  const X: number[][] = [];
  for (let t = 0; t < n; t++) {
    X.push(type === "trend" ? [1, t] : [1]);
  }
  const ols = olsRegression(X, values);
  const e = ols.residuals;

  // Partial sums
  const S: number[] = new Array(n);
  S[0] = e[0];
  for (let t = 1; t < n; t++) S[t] = S[t - 1] + e[t];

  // Estimate long-run variance using Newey-West
  const bandwidth = Math.floor(4 * Math.pow(n / 100, 0.25));
  let s2 = 0;
  for (let t = 0; t < n; t++) s2 += e[t] * e[t];
  s2 /= n;

  for (let j = 1; j <= bandwidth; j++) {
    const w = 1 - j / (bandwidth + 1); // Bartlett kernel
    let cov = 0;
    for (let t = j; t < n; t++) cov += e[t] * e[t - j];
    cov /= n;
    s2 += 2 * w * cov;
  }

  if (s2 <= 0) s2 = 1e-10;

  // KPSS statistic
  let stat = 0;
  for (let t = 0; t < n; t++) stat += S[t] * S[t];
  stat /= n * n * s2;

  // Critical values (level stationarity)
  const cv = type === "level"
    ? { "1%": 0.739, "5%": 0.463, "10%": 0.347 }
    : { "1%": 0.216, "5%": 0.146, "10%": 0.119 };

  const isStationary = stat < cv["5%"];

  return {
    testStat: stat,
    criticalValues: cv,
    isStationary,
    interpretation: isStationary
      ? `KPSS検定統計量 ${stat.toFixed(4)} < 5%臨界値 ${cv["5%"]}。帰無仮説（定常）を棄却できない→定常系列の可能性が高い。`
      : `KPSS検定統計量 ${stat.toFixed(4)} ≥ 5%臨界値 ${cv["5%"]}。帰無仮説（定常）を棄却→非定常の可能性が高い。`,
  };
}

// --- Combined Test ---
export function unitRootTest(
  values: number[],
  times: string[],
  window: number = 252
): UnitRootResult {
  const adf = adfTest(values);
  const kpss = kpssTest(values);

  let conclusion: "stationary" | "unit_root" | "ambiguous";
  if (adf.isStationary && kpss.isStationary) {
    conclusion = "stationary";
  } else if (!adf.isStationary && !kpss.isStationary) {
    conclusion = "unit_root";
  } else {
    conclusion = "ambiguous";
  }

  // Rolling ADF
  const rollingADF: { time: string; stat: number; critical5: number }[] = [];
  for (let i = window; i < values.length; i++) {
    const slice = values.slice(i - window, i + 1);
    const r = adfTest(slice);
    rollingADF.push({
      time: times[i],
      stat: r.testStat,
      critical5: r.criticalValues["5%"],
    });
  }

  return { adf, kpss, conclusion, rollingADF };
}

function emptyADF(): ADFResult {
  return {
    testStat: 0, pValue: 1, lags: 0,
    criticalValues: { "1%": -3.43, "5%": -2.86, "10%": -2.57 },
    isStationary: false,
    interpretation: "データ不足",
  };
}

function emptyKPSS(): KPSSResult {
  return {
    testStat: 0,
    criticalValues: { "1%": 0.739, "5%": 0.463, "10%": 0.347 },
    isStationary: true,
    interpretation: "データ不足",
  };
}
