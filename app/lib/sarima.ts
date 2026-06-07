// SARIMA(p,d,q)(P,D,Q)_s モデル
//
// 季節 ARIMA。バックシフト演算子 B (B^k y_t = y_{t-k}) を用いて
//   φ(B)Φ(B^s)(1-B)^d(1-B^s)^D y_t = c + θ(B)Θ(B^s)ε_t
// と表される。MA 項は Hannan-Rissanen 2 段階法で推定する。
//
//   φ(B)  = 1 - φ₁B - … - φ_pB^p          （非季節 AR）
//   Φ(B^s)= 1 - Φ₁B^s - … - Φ_PB^{sP}     （季節 AR）
//   θ(B)  = 1 + θ₁B + … + θ_qB^q          （非季節 MA）
//   Θ(B^s)= 1 + Θ₁B^s + … + Θ_QB^{sQ}     （季節 MA）

import { acf, pacf, type ACFPoint } from "./autocorrelation";

export interface SarimaSpec {
  p: number;
  d: number;
  q: number;
  P: number;
  D: number;
  Q: number;
  s: number; // 季節周期（0 または 1 で季節成分なし）
}

export interface CoeffStat {
  name: string; // "φ1", "Φ1", "θ1", "Θ1", "c"
  est: number;
  se: number;
  t: number;
  pValue: number;
}

export interface SarimaFit {
  spec: SarimaSpec;
  c: number;
  ar: number[]; // φ
  ma: number[]; // θ
  sar: number[]; // Φ
  sma: number[]; // Θ
  sigma2: number;
  loglik: number;
  aic: number;
  bic: number;
  nParams: number;
  nObs: number; // 残差の有効数
  coeffStats: CoeffStat[];
  residuals: number[]; // 元系列インデックスに揃えた残差（ウォームアップは NaN）
  fitted: number[]; // 元系列インデックスに揃えた 1 期先フィット値（ウォームアップは NaN）
  ok: boolean;
}

export interface SarimaForecast {
  point: number[];
  upper95: number[];
  lower95: number[];
}

export interface LjungBoxResult {
  stat: number;
  pValue: number;
  df: number;
  lags: number;
}

export interface SarimaDiagnostics {
  ljungBox: LjungBoxResult;
  jarqueBera: { stat: number; pValue: number; skew: number; kurt: number };
  residAcf: ACFPoint[];
  residPacf: ACFPoint[];
}

// =====================================================================
//  数値ユーティリティ
// =====================================================================

// erf 近似 (Abramowitz & Stegun 7.1.26)
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// 両側 p 値（t 統計量を正規近似）
function twoSidedPValue(t: number): number {
  return 2 * (1 - normalCdf(Math.abs(t)));
}

function gammaln(x: number): number {
  const g = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let xx = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++xx;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// 正則化下側不完全ガンマ P(a,x)
function gammp(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    // 級数展開
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 200; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
  } else {
    // 連分数（上側 Q を求めて 1-Q）
    let b = x + 1 - a;
    let c = 1e30;
    let dInv = 1 / b;
    let h = dInv;
    for (let i = 1; i <= 200; i++) {
      const an = -i * (i - a);
      b += 2;
      dInv = an * dInv + b;
      if (Math.abs(dInv) < 1e-30) dInv = 1e-30;
      c = b + an / c;
      if (Math.abs(c) < 1e-30) c = 1e-30;
      dInv = 1 / dInv;
      const del = dInv * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-12) break;
    }
    const q = Math.exp(-x + a * Math.log(x) - gammaln(a)) * h;
    return 1 - q;
  }
}

// カイ二乗 上側確率（p 値）
function chiSquareSurvival(x: number, k: number): number {
  if (k <= 0 || x <= 0) return 1;
  return 1 - gammp(k / 2, x / 2);
}

// 多項式の畳み込み（積）
function polyMul(a: number[], b: number[]): number[] {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  return out;
}

// 行列の逆行列（Gauss-Jordan）。特異なら null
function invertMatrix(m: number[][]): number[][] | null {
  const n = m.length;
  const a = m.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    const d = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

interface OLSResult {
  beta: number[];
  se: number[];
  residuals: number[];
  sigma2: number;
}

// 最小二乗 (正規方程式)。X: n×k, y: n。標準誤差付き
function ols(X: number[][], y: number[]): OLSResult | null {
  const n = X.length;
  if (n === 0) return null;
  const k = X[0].length;
  if (n <= k) return null;

  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = X[i];
    for (let a = 0; a < k; a++) {
      Xty[a] += xi[a] * y[i];
      for (let b = a; b < k; b++) XtX[a][b] += xi[a] * xi[b];
    }
  }
  for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) XtX[a][b] = XtX[b][a];

  const inv = invertMatrix(XtX);
  if (!inv) return null;

  const beta = new Array(k).fill(0);
  for (let a = 0; a < k; a++)
    for (let b = 0; b < k; b++) beta[a] += inv[a][b] * Xty[b];

  const residuals = new Array(n);
  let sse = 0;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let a = 0; a < k; a++) pred += X[i][a] * beta[a];
    residuals[i] = y[i] - pred;
    sse += residuals[i] * residuals[i];
  }
  const dof = Math.max(n - k, 1);
  const sigma2 = sse / dof;
  const se = inv.map((row, a) => Math.sqrt(Math.max(sigma2 * row[a], 0)));

  return { beta, se, residuals, sigma2 };
}

// =====================================================================
//  差分・積分
// =====================================================================

function diffRegularOnce(x: number[]): number[] {
  const out = new Array(Math.max(x.length - 1, 0));
  for (let i = 1; i < x.length; i++) out[i - 1] = x[i] - x[i - 1];
  return out;
}

function diffSeasonalOnce(x: number[], s: number): number[] {
  if (s <= 0 || x.length <= s) return x.slice(s);
  const out = new Array(x.length - s);
  for (let i = s; i < x.length; i++) out[i - s] = x[i] - x[i - s];
  return out;
}

interface DiffChain {
  w: number[]; // 完全に差分した定常系列
  regStages: number[][]; // regStages[k] = 正則差分 k 回後（regStages[0]=values）
  seasStages: number[][]; // seasStages[j] = 正則 d 回 + 季節 j 回後（seasStages[0]=regStages[d]）
  offset: number; // 差分で失われた先頭の点数 = d + D*s
}

function buildDiffChain(values: number[], spec: SarimaSpec): DiffChain {
  const { d, D, s } = spec;
  const seasonal = s > 1 ? s : 0;

  const regStages: number[][] = [values];
  for (let k = 1; k <= d; k++) regStages.push(diffRegularOnce(regStages[k - 1]));

  const seasStages: number[][] = [regStages[d]];
  const Deff = seasonal ? D : 0;
  for (let j = 1; j <= Deff; j++)
    seasStages.push(diffSeasonalOnce(seasStages[j - 1], seasonal));

  return {
    w: seasStages[Deff],
    regStages,
    seasStages,
    offset: d + Deff * seasonal,
  };
}

// =====================================================================
//  Hannan-Rissanen 2 段階推定
// =====================================================================

export function fitSarima(values: number[], spec: SarimaSpec): SarimaFit {
  const seasonal = spec.s > 1 ? spec.s : 0;
  const P = seasonal ? spec.P : 0;
  const Q = seasonal ? spec.Q : 0;
  const { p, q } = spec;

  const chain = buildDiffChain(values, spec);
  const w = chain.w;
  const m = w.length;

  const nParams = p + q + P + Q + 1; // + 定数
  if (m < nParams + 20) return emptyFit(spec);

  // --- Stage 1: 長め AR で残差プロキシ ê を得る ---
  const maxModelLag = Math.max(p, seasonal * P, q, seasonal * Q);
  const kAR = Math.min(
    Math.max(maxModelLag + 8, Math.floor(Math.sqrt(m))),
    Math.floor(m / 3),
    40
  );
  const eHat = stage1Residuals(w, kAR);
  // eHat[i] は w[i] に対応（i < kAR は 0）

  // --- Stage 2: ARMA を OLS 回帰 ---
  const arLags: number[] = [];
  for (let i = 1; i <= p; i++) arLags.push(i);
  for (let j = 1; j <= P; j++) arLags.push(seasonal * j);
  const maLags: number[] = [];
  for (let i = 1; i <= q; i++) maLags.push(i);
  for (let j = 1; j <= Q; j++) maLags.push(seasonal * j);

  const maxArLag = arLags.length ? Math.max(...arLags) : 0;
  const maxMaLag = maLags.length ? Math.max(...maLags) : 0;
  const t0 = Math.max(maxArLag, kAR + maxMaLag);

  const X: number[][] = [];
  const Y: number[] = [];
  for (let t = t0; t < m; t++) {
    const row = [1]; // 定数
    for (const L of arLags) row.push(w[t - L]);
    for (const L of maLags) row.push(eHat[t - L]);
    X.push(row);
    Y.push(w[t]);
  }

  const reg = ols(X, Y);
  if (!reg) return emptyFit(spec);

  const beta = reg.beta;
  const se = reg.se;
  let bi = 0;
  const c = beta[bi];
  const cSe = se[bi];
  bi++;
  const ar = arLags.slice(0, p).map(() => beta[bi++]);
  const sar = arLags.slice(p).map(() => beta[bi++]);
  const ma = maLags.slice(0, q).map(() => beta[bi++]);
  const sma = maLags.slice(q).map(() => beta[bi++]);

  // --- Stage 3: 推定 ARMA で残差を再帰再計算 ---
  const eFull = new Array(m).fill(0);
  let sse = 0;
  let cnt = 0;
  for (let t = 0; t < m; t++) {
    if (t < t0) {
      eFull[t] = 0;
      continue;
    }
    let pred = c;
    for (let i = 0; i < p; i++) pred += ar[i] * w[t - (i + 1)];
    for (let j = 0; j < P; j++) pred += sar[j] * w[t - seasonal * (j + 1)];
    for (let i = 0; i < q; i++) pred += ma[i] * eFull[t - (i + 1)];
    for (let j = 0; j < Q; j++) pred += sma[j] * eFull[t - seasonal * (j + 1)];
    eFull[t] = w[t] - pred;
    sse += eFull[t] * eFull[t];
    cnt++;
  }

  const sigma2 = cnt > 0 ? sse / cnt : 0;
  const loglik =
    sigma2 > 0
      ? (-cnt / 2) * (1 + Math.log(2 * Math.PI) + Math.log(sigma2))
      : 0;
  const kTotal = nParams + 1; // + 分散
  const aic = -2 * loglik + 2 * kTotal;
  const bic = -2 * loglik + kTotal * Math.log(Math.max(cnt, 1));

  // 係数統計
  const coeffStats: CoeffStat[] = [];
  const pushStat = (name: string, est: number, sErr: number) => {
    const tStat = sErr > 0 ? est / sErr : 0;
    coeffStats.push({ name, est, se: sErr, t: tStat, pValue: twoSidedPValue(tStat) });
  };
  let si = 1;
  pushStat("c", c, cSe);
  ar.forEach((v, i) => pushStat(`φ${i + 1}`, v, se[si++]));
  sar.forEach((v, i) => pushStat(`Φ${i + 1}`, v, se[si++]));
  ma.forEach((v, i) => pushStat(`θ${i + 1}`, v, se[si++]));
  sma.forEach((v, i) => pushStat(`Θ${i + 1}`, v, se[si++]));

  // 元系列インデックスに揃える（fitted は 1 期先予測 = value - residual）
  const N = values.length;
  const residuals = new Array(N).fill(NaN);
  const fitted = new Array(N).fill(NaN);
  for (let t = t0; t < m; t++) {
    const idx = t + chain.offset;
    if (idx < N) {
      residuals[idx] = eFull[t];
      fitted[idx] = values[idx] - eFull[t];
    }
  }

  return {
    spec: { ...spec, s: seasonal, P, Q },
    c,
    ar,
    ma,
    sar,
    sma,
    sigma2,
    loglik,
    aic,
    bic,
    nParams: kTotal,
    nObs: cnt,
    coeffStats,
    residuals,
    fitted,
    ok: true,
  };
}

// Stage1: AR(k) を OLS 推定し残差を返す（w のインデックスに対応、先頭 k は 0）
function stage1Residuals(w: number[], k: number): number[] {
  const m = w.length;
  const e = new Array(m).fill(0);
  if (k <= 0 || m <= k + 1) return e;

  const X: number[][] = [];
  const Y: number[] = [];
  for (let t = k; t < m; t++) {
    const row = [1];
    for (let i = 1; i <= k; i++) row.push(w[t - i]);
    X.push(row);
    Y.push(w[t]);
  }
  const reg = ols(X, Y);
  if (!reg) return e;
  for (let t = k; t < m; t++) e[t] = reg.residuals[t - k];
  return e;
}

function emptyFit(spec: SarimaSpec): SarimaFit {
  return {
    spec,
    c: 0,
    ar: [],
    ma: [],
    sar: [],
    sma: [],
    sigma2: 0,
    loglik: 0,
    aic: Infinity,
    bic: Infinity,
    nParams: 0,
    nObs: 0,
    coeffStats: [],
    residuals: [],
    fitted: [],
    ok: false,
  };
}

// =====================================================================
//  予測
// =====================================================================

export function forecastSarima(
  values: number[],
  fit: SarimaFit,
  horizon: number
): SarimaForecast {
  if (!fit.ok || horizon <= 0)
    return { point: [], upper95: [], lower95: [] };

  const spec = fit.spec;
  const seasonal = spec.s > 1 ? spec.s : 0;
  const chain = buildDiffChain(values, spec);
  const w = chain.w;
  const m = w.length;
  const { ar, sar, ma, sma, c } = fit;
  const p = ar.length;
  const P = sar.length;
  const q = ma.length;
  const Q = sma.length;

  // 残差（w インデックス）を再構成
  const eFull = new Array(m).fill(0);
  const offset = chain.offset;
  for (let i = 0; i < m; i++) {
    const idx = i + offset;
    if (idx < fit.residuals.length && !isNaN(fit.residuals[idx]))
      eFull[i] = fit.residuals[idx];
  }

  // w の点予測（再帰）
  const wExt = w.slice();
  const eExt = eFull.slice();
  const wFuture: number[] = [];
  for (let h = 0; h < horizon; h++) {
    const idx = wExt.length;
    let pred = c;
    for (let i = 0; i < p; i++) pred += ar[i] * wExt[idx - (i + 1)];
    for (let j = 0; j < P; j++) pred += sar[j] * (wExt[idx - seasonal * (j + 1)] ?? 0);
    for (let i = 0; i < q; i++) pred += ma[i] * (eExt[idx - (i + 1)] ?? 0);
    for (let j = 0; j < Q; j++) pred += sma[j] * (eExt[idx - seasonal * (j + 1)] ?? 0);
    wExt.push(pred);
    eExt.push(0);
    wFuture.push(pred);
  }

  // 季節差分 → 正則差分の順で積分して水準復元
  let cur = wFuture;
  const Deff = seasonal ? spec.D : 0;
  for (let j = Deff; j >= 1; j--) {
    cur = integrateSeasonal(chain.seasStages[j - 1], cur, seasonal);
  }
  for (let k = spec.d; k >= 1; k--) {
    cur = integrateRegular(chain.regStages[k - 1], cur);
  }
  const point = cur;

  // 予測誤差分散（完全モデルの ψ 重み）
  const psi = psiWeights(fit, horizon);
  const upper95: number[] = [];
  const lower95: number[] = [];
  let cumVar = 0;
  for (let h = 0; h < horizon; h++) {
    cumVar += psi[h] * psi[h] * fit.sigma2;
    const seF = Math.sqrt(Math.max(cumVar, 0));
    upper95.push(point[h] + 1.96 * seF);
    lower95.push(point[h] - 1.96 * seF);
  }

  return { point, upper95, lower95 };
}

function integrateRegular(histPrev: number[], futureDiff: number[]): number[] {
  let last = histPrev[histPrev.length - 1];
  return futureDiff.map((fd) => (last += fd));
}

function integrateSeasonal(
  histPrev: number[],
  futureDiff: number[],
  s: number
): number[] {
  const ext = histPrev.slice();
  const out: number[] = [];
  for (let h = 0; h < futureDiff.length; h++) {
    const val = ext[ext.length - s] + futureDiff[h];
    ext.push(val);
    out.push(val);
  }
  return out;
}

// 完全モデル（差分含む）の MA(∞) ψ 重み
function psiWeights(fit: SarimaFit, horizon: number): number[] {
  const spec = fit.spec;
  const seasonal = spec.s > 1 ? spec.s : 0;

  // AR 側多項式 φ(B): [1, -φ1, -φ2, ...]
  let arPoly = [1];
  if (fit.ar.length) arPoly = polyMul(arPoly, [1, ...fit.ar.map((v) => -v)]);
  // 季節 AR Φ(B^s)
  if (seasonal && fit.sar.length) {
    for (const v of fit.sar) {
      const f = new Array(seasonal + 1).fill(0);
      f[0] = 1;
      f[seasonal] = -v;
      arPoly = polyMul(arPoly, f);
    }
  }
  // 正則差分 (1-B)^d
  for (let k = 0; k < spec.d; k++) arPoly = polyMul(arPoly, [1, -1]);
  // 季節差分 (1-B^s)^D
  if (seasonal) {
    const sd = new Array(seasonal + 1).fill(0);
    sd[0] = 1;
    sd[seasonal] = -1;
    for (let k = 0; k < spec.D; k++) arPoly = polyMul(arPoly, sd);
  }

  // MA 側多項式 θ(B): [1, θ1, θ2, ...]
  let maPoly = [1];
  if (fit.ma.length) maPoly = polyMul(maPoly, [1, ...fit.ma]);
  if (seasonal && fit.sma.length) {
    for (const v of fit.sma) {
      const f = new Array(seasonal + 1).fill(0);
      f[0] = 1;
      f[seasonal] = v;
      maPoly = polyMul(maPoly, f);
    }
  }

  // ψ_0=1, ψ_j = maPoly_j - Σ_{i>=1} arPoly_i ψ_{j-i}
  const psi = [1];
  for (let j = 1; j <= horizon; j++) {
    let val = j < maPoly.length ? maPoly[j] : 0;
    for (let i = 1; i < arPoly.length && i <= j; i++) {
      val -= arPoly[i] * psi[j - i];
    }
    psi.push(val);
  }
  return psi;
}

// =====================================================================
//  診断
// =====================================================================

export function ljungBox(
  residuals: number[],
  lags: number,
  nParams: number
): LjungBoxResult {
  const r = residuals.filter((v) => !isNaN(v));
  const n = r.length;
  if (n < lags + 1) return { stat: 0, pValue: 1, df: 1, lags };

  const acfVals = acf(r, lags);
  let stat = 0;
  for (let k = 1; k <= lags; k++) {
    const rho = acfVals[k]?.value ?? 0;
    stat += (rho * rho) / (n - k);
  }
  stat *= n * (n + 2);
  const df = Math.max(lags - nParams, 1);
  return { stat, pValue: chiSquareSurvival(stat, df), df, lags };
}

export function diagnose(fit: SarimaFit): SarimaDiagnostics {
  const r = fit.residuals.filter((v) => !isNaN(v));
  const n = r.length;
  const lbLags = Math.min(20, Math.max(Math.floor(n / 5), 1));
  const arOrder = fit.ar.length + fit.sar.length + fit.ma.length + fit.sma.length;

  // Jarque-Bera
  let skew = 0;
  let kurt = 0;
  let jb = 0;
  let jbP = 1;
  if (n >= 4) {
    const mean = r.reduce((a, b) => a + b, 0) / n;
    const m2 = r.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
    const std = Math.sqrt(m2);
    if (std > 0) {
      skew = r.reduce((a, v) => a + ((v - mean) / std) ** 3, 0) / n;
      kurt = r.reduce((a, v) => a + ((v - mean) / std) ** 4, 0) / n - 3;
      jb = (n / 6) * (skew ** 2 + kurt ** 2 / 4);
      jbP = chiSquareSurvival(jb, 2);
    }
  }

  const maxLag = Math.min(30, Math.max(Math.floor(n / 4), 5));
  return {
    ljungBox: ljungBox(fit.residuals, lbLags, arOrder),
    jarqueBera: { stat: jb, pValue: jbP, skew, kurt },
    residAcf: acf(r, maxLag),
    residPacf: pacf(r, maxLag),
  };
}

// =====================================================================
//  グリッド探索
// =====================================================================

export interface GridRanges {
  pMax: number;
  dMax: number;
  qMax: number;
  PMax: number;
  DMax: number;
  QMax: number;
}

export interface GridCandidate {
  spec: SarimaSpec;
  aic: number;
  bic: number;
  loglik: number;
  ok: boolean;
}

export function gridSearchSarima(
  values: number[],
  ranges: GridRanges,
  s: number,
  topN: number = 8
): GridCandidate[] {
  const seasonal = s > 1 ? s : 0;
  const Pmax = seasonal ? ranges.PMax : 0;
  const Dmax = seasonal ? ranges.DMax : 0;
  const Qmax = seasonal ? ranges.QMax : 0;

  const candidates: GridCandidate[] = [];
  for (let d = 0; d <= ranges.dMax; d++)
    for (let D = 0; D <= Dmax; D++)
      for (let p = 0; p <= ranges.pMax; p++)
        for (let q = 0; q <= ranges.qMax; q++)
          for (let P = 0; P <= Pmax; P++)
            for (let Q = 0; Q <= Qmax; Q++) {
              if (p + q + P + Q === 0 && d + D === 0) continue; // 純粋なホワイトノイズは除外
              const spec: SarimaSpec = { p, d, q, P, D, Q, s: seasonal };
              const fit = fitSarima(values, spec);
              candidates.push({
                spec,
                aic: fit.aic,
                bic: fit.bic,
                loglik: fit.loglik,
                ok: fit.ok,
              });
            }

  candidates.sort((a, b) => a.aic - b.aic);
  return candidates.filter((c) => c.ok && isFinite(c.aic)).slice(0, topN);
}

// 入力（差分後）系列の ACF/PACF（次数同定用）
export function differencedSeriesAcf(
  values: number[],
  spec: SarimaSpec,
  maxLag: number = 30
): { acf: ACFPoint[]; pacf: ACFPoint[]; w: number[] } {
  const chain = buildDiffChain(values, spec);
  const lag = Math.min(maxLag, Math.max(Math.floor(chain.w.length / 4), 5));
  return { acf: acf(chain.w, lag), pacf: pacf(chain.w, lag), w: chain.w };
}

export function formatSpec(spec: SarimaSpec): string {
  const base = `(${spec.p},${spec.d},${spec.q})`;
  if (spec.s > 1 && (spec.P || spec.D || spec.Q))
    return `SARIMA${base}(${spec.P},${spec.D},${spec.Q})_${spec.s}`;
  return `ARIMA${base}`;
}
