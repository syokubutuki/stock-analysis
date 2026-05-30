// 分布・相関分析の拡張ライブラリ
// CDF, KDE, t分布, KS/AD検定, Ljung-Box, Runs, BDS, ローリング統計, 条件付き分布, etc.

// === 基本統計ヘルパー ===

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function variance(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length;
}

function stddev(v: number[]): number {
  return Math.sqrt(variance(v));
}

// === 正規分布関連 ===

// 正規CDF (Abramowitz and Stegun 近似)
export function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

// 正規分布の逆CDF (Beasley-Springer-Moro)
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5, r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

// === 1. 経験的CDF ===
export interface CDFPoint {
  x: number;
  empirical: number;
  normal: number;
}

export function empiricalCDF(values: number[]): CDFPoint[] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const m = mean(values);
  const s = stddev(values);
  return sorted.map((x, i) => ({
    x,
    empirical: (i + 1) / n,
    normal: s > 0 ? normalCDF((x - m) / s) : 0.5,
  }));
}

// === 3. カーネル密度推定 (KDE) ===
export interface KDEPoint {
  x: number;
  density: number;
}

export function kde(values: number[], nPoints: number = 200): KDEPoint[] {
  const n = values.length;
  if (n < 2) return [];
  const s = stddev(values);
  // Silverman's rule of thumb
  const h = 1.06 * s * Math.pow(n, -1 / 5);
  if (h <= 0) return [];

  const min = Math.min(...values) - 3 * h;
  const max = Math.max(...values) + 3 * h;
  const step = (max - min) / (nPoints - 1);

  const result: KDEPoint[] = [];
  for (let i = 0; i < nPoints; i++) {
    const x = min + i * step;
    let density = 0;
    for (const v of values) {
      const z = (x - v) / h;
      density += Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    }
    density /= n * h;
    result.push({ x, density });
  }
  return result;
}

// === 4. t分布フィッティング ===

// t分布のPDF
function gammln(x: number): number {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

export function tPDF(x: number, nu: number, mu: number, sigma: number): number {
  if (sigma <= 0 || nu <= 0) return 0;
  const z = (x - mu) / sigma;
  const coef = Math.exp(gammln((nu + 1) / 2) - gammln(nu / 2)) / (Math.sqrt(nu * Math.PI) * sigma);
  return coef * Math.pow(1 + z * z / nu, -(nu + 1) / 2);
}

// t分布のCDF (近似)
function tCDF(x: number, nu: number): number {
  if (nu <= 0) return 0.5;
  const t = x;
  const beta = nu / (nu + t * t);
  // Regularized incomplete beta function (近似)
  const ibeta = regIncBeta(nu / 2, 0.5, beta);
  return t >= 0 ? 1 - 0.5 * ibeta : 0.5 * ibeta;
}

// 正則不完全ベータ関数 (continued fraction 近似)
function regIncBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBeta = gammln(a) + gammln(b) - gammln(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;
  // Lentz's continued fraction
  let f = 1, c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d; f = d;
  for (let i = 1; i <= 200; i++) {
    const m = i;
    let an = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + an * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + an / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    f *= d * c;
    an = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + an * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + an / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    const delta = d * c;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-10) break;
  }
  return front * f;
}

export interface TFitResult {
  nu: number;     // 自由度
  mu: number;     // 位置パラメータ
  sigma: number;  // スケールパラメータ
  logLik: number; // 対数尤度
}

export function fitTDistribution(values: number[]): TFitResult {
  const mu = mean(values);
  const s = stddev(values);
  if (s <= 0) return { nu: Infinity, mu, sigma: s, logLik: -Infinity };

  // Grid search for nu (自由度)
  let bestNu = 5, bestLL = -Infinity;
  for (let nu = 1.5; nu <= 100; nu += 0.5) {
    // MLE: sigma for given nu
    const sigma = s * Math.sqrt((nu - 2) / nu);
    const effSigma = sigma > 0 ? sigma : s;
    let ll = 0;
    for (const x of values) {
      const p = tPDF(x, nu, mu, effSigma);
      ll += Math.log(Math.max(p, 1e-300));
    }
    if (ll > bestLL) { bestLL = ll; bestNu = nu; }
  }

  const bestSigma = s * Math.sqrt(Math.max(0, (bestNu - 2) / bestNu));
  return { nu: bestNu, mu, sigma: bestSigma > 0 ? bestSigma : s, logLik: bestLL };
}

// === 6. 上側/下側テール分析 ===
export interface TailAnalysis {
  side: "upper" | "lower";
  n: number;
  mean: number;
  std: number;
  max: number;
  exceedance1pct: number; // 1%を超える割合
  exceedance2pct: number; // 2%を超える割合
  conditionalMean: number; // 条件付き期待値 (テール内の平均)
}

export function analyzeTails(values: number[], threshold: number = 1): { upper: TailAnalysis; lower: TailAnalysis } {
  const m = mean(values);
  const s = stddev(values);
  if (s <= 0) {
    const empty: TailAnalysis = { side: "upper", n: 0, mean: 0, std: 0, max: 0, exceedance1pct: 0, exceedance2pct: 0, conditionalMean: 0 };
    return { upper: { ...empty }, lower: { ...empty, side: "lower" } };
  }

  const zScores = values.map(v => (v - m) / s);
  const upper = values.filter((_, i) => zScores[i] > threshold);
  const lower = values.filter((_, i) => zScores[i] < -threshold);

  const analyzeSide = (side: "upper" | "lower", tail: number[]): TailAnalysis => {
    const n = tail.length;
    const absTail = side === "lower" ? tail.map(v => -v) : tail;
    return {
      side,
      n,
      mean: n > 0 ? mean(tail) : 0,
      std: n > 0 ? stddev(tail) : 0,
      max: n > 0 ? (side === "upper" ? Math.max(...tail) : Math.min(...tail)) : 0,
      exceedance1pct: values.filter(v => side === "upper" ? v > 0.01 : v < -0.01).length / values.length,
      exceedance2pct: values.filter(v => side === "upper" ? v > 0.02 : v < -0.02).length / values.length,
      conditionalMean: n > 0 ? mean(tail) : 0,
    };
  };

  return {
    upper: analyzeSide("upper", upper),
    lower: analyzeSide("lower", lower),
  };
}

// === 17. PPプロット ===
export interface PPPoint {
  theoretical: number; // 正規CDFの値
  empirical: number;   // 経験的CDFの値
}

export function ppPlot(values: number[]): PPPoint[] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const m = mean(values);
  const s = stddev(values);
  if (s <= 0) return [];

  return sorted.map((x, i) => ({
    theoretical: normalCDF((x - m) / s),
    empirical: (i + 1) / (n + 1),
  }));
}

// === 19. Kolmogorov-Smirnov検定 ===
export interface KSTestResult {
  D: number;         // KS統計量
  pValue: number;    // p値
  maxDeviationAt: number; // 最大乖離の位置 (値)
}

export function ksTest(values: number[]): KSTestResult {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const m = mean(values);
  const s = stddev(values);
  if (s <= 0) return { D: 0, pValue: 1, maxDeviationAt: 0 };

  let D = 0, maxAt = 0;
  for (let i = 0; i < n; i++) {
    const z = (sorted[i] - m) / s;
    const Fn = (i + 1) / n;
    const Fn_prev = i / n;
    const F0 = normalCDF(z);
    const d1 = Math.abs(Fn - F0);
    const d2 = Math.abs(Fn_prev - F0);
    const d = Math.max(d1, d2);
    if (d > D) { D = d; maxAt = sorted[i]; }
  }

  // KS p値の近似 (Kolmogorov-Smirnov分布)
  const sqn = Math.sqrt(n);
  const lambda = (sqn + 0.12 + 0.11 / sqn) * D;
  let pValue = 0;
  for (let k = 1; k <= 100; k++) {
    pValue += 2 * (-1) ** (k + 1) * Math.exp(-2 * k * k * lambda * lambda);
  }
  pValue = Math.max(0, Math.min(1, pValue));

  return { D, pValue, maxDeviationAt: maxAt };
}

// === 20. Anderson-Darling検定 ===
export interface ADTestResult {
  A2: number;       // AD統計量
  A2star: number;   // 修正AD統計量
  pValue: number;
}

export function adTest(values: number[]): ADTestResult {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const m = mean(values);
  const s = stddev(values);
  if (s <= 0 || n < 5) return { A2: 0, A2star: 0, pValue: 1 };

  const z = sorted.map(x => normalCDF((x - m) / s));

  let S = 0;
  for (let i = 0; i < n; i++) {
    const zi = Math.max(1e-10, Math.min(1 - 1e-10, z[i]));
    const zn = Math.max(1e-10, Math.min(1 - 1e-10, z[n - 1 - i]));
    S += (2 * (i + 1) - 1) * (Math.log(zi) + Math.log(1 - zn));
  }
  const A2 = -n - S / n;

  // 修正統計量 (有限サンプル補正)
  const A2star = A2 * (1 + 0.75 / n + 2.25 / (n * n));

  // p値の近似 (Lewis 1961)
  let pValue: number;
  if (A2star >= 0.6) {
    pValue = Math.exp(1.2937 - 5.709 * A2star + 0.0186 * A2star * A2star);
  } else if (A2star >= 0.34) {
    pValue = Math.exp(0.9177 - 4.279 * A2star - 1.38 * A2star * A2star);
  } else if (A2star >= 0.2) {
    pValue = 1 - Math.exp(-8.318 + 42.796 * A2star - 59.938 * A2star * A2star);
  } else {
    pValue = 1 - Math.exp(-13.436 + 101.14 * A2star - 223.73 * A2star * A2star);
  }
  pValue = Math.max(0, Math.min(1, pValue));

  return { A2, A2star, pValue };
}

// === 8. Ljung-Box検定 ===
export interface LjungBoxResult {
  Q: number;       // 統計量
  pValue: number;  // p値
  lags: number;    // 使用ラグ数
}

export function ljungBoxTest(values: number[], maxLag: number = 10): LjungBoxResult {
  const n = values.length;
  if (n < maxLag + 1) return { Q: 0, pValue: 1, lags: maxLag };

  const m = mean(values);
  const v = values.reduce((a, x) => a + (x - m) ** 2, 0) / n;
  if (v === 0) return { Q: 0, pValue: 1, lags: maxLag };

  let Q = 0;
  for (let k = 1; k <= maxLag; k++) {
    let rk = 0;
    for (let i = 0; i < n - k; i++) {
      rk += (values[i] - m) * (values[i + k] - m);
    }
    rk /= (n * v);
    Q += (rk * rk) / (n - k);
  }
  Q *= n * (n + 2);

  // χ²分布のp値近似 (Wilson-Hilferty)
  const df = maxLag;
  const z = Math.pow(Q / df, 1 / 3) - (1 - 2 / (9 * df));
  const denom = Math.sqrt(2 / (9 * df));
  const pValue = 1 - normalCDF(z / denom);

  return { Q, pValue: Math.max(0, Math.min(1, pValue)), lags: maxLag };
}

// === 5. ローリング統計量 ===
export interface RollingMoment {
  time: string;
  skewness: number;
  kurtosis: number;
  mean: number;
  std: number;
}

export function rollingMoments(values: number[], times: string[], window: number = 60): RollingMoment[] {
  const result: RollingMoment[] = [];
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    const m = mean(slice);
    const s = stddev(slice);
    if (s <= 0) {
      result.push({ time: times[i], skewness: 0, kurtosis: 0, mean: m, std: s });
      continue;
    }
    const n = slice.length;
    const m3 = slice.reduce((a, v) => a + ((v - m) / s) ** 3, 0) / n;
    const m4 = slice.reduce((a, v) => a + ((v - m) / s) ** 4, 0) / n;
    result.push({ time: times[i], skewness: m3, kurtosis: m4 - 3, mean: m, std: s });
  }
  return result;
}

// === 10. ローリングACF(1) ===
export interface RollingACF1 {
  time: string;
  acf1: number;
}

export function rollingACF1(values: number[], times: string[], window: number = 60): RollingACF1[] {
  const result: RollingACF1[] = [];
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    const m = mean(slice);
    const v = variance(slice);
    if (v <= 0) { result.push({ time: times[i], acf1: 0 }); continue; }
    let sum = 0;
    for (let j = 0; j < slice.length - 1; j++) {
      sum += (slice[j] - m) * (slice[j + 1] - m);
    }
    result.push({ time: times[i], acf1: sum / (slice.length * v) });
  }
  return result;
}

// === 16. ラグ散布ヒートマップ ===
export interface HeatmapBin {
  xIdx: number;
  yIdx: number;
  count: number;
  density: number;
}

export function lagScatterHeatmap(values: number[], bins: number = 50): {
  data: HeatmapBin[];
  minVal: number;
  maxVal: number;
  binWidth: number;
} {
  if (values.length < 3) return { data: [], minVal: 0, maxVal: 0, binWidth: 0 };

  const pairs: [number, number][] = [];
  for (let i = 1; i < values.length; i++) {
    pairs.push([values[i - 1], values[i]]);
  }

  const allVals = pairs.flatMap(p => p);
  const minVal = Math.min(...allVals);
  const maxVal = Math.max(...allVals);
  const range = maxVal - minVal || 1;
  const binWidth = range / bins;

  const grid = new Array(bins * bins).fill(0);
  for (const [x, y] of pairs) {
    const xi = Math.min(Math.floor((x - minVal) / binWidth), bins - 1);
    const yi = Math.min(Math.floor((y - minVal) / binWidth), bins - 1);
    grid[yi * bins + xi]++;
  }

  const n = pairs.length;
  const data: HeatmapBin[] = [];
  for (let yi = 0; yi < bins; yi++) {
    for (let xi = 0; xi < bins; xi++) {
      const count = grid[yi * bins + xi];
      if (count > 0) {
        data.push({ xIdx: xi, yIdx: yi, count, density: count / n });
      }
    }
  }
  return { data, minVal, maxVal, binWidth };
}

// === 12. コピュラ散布図 ===
export interface CopulaPoint {
  u: number; // rank(x) / (n+1)
  v: number; // rank(y) / (n+1)
}

export function copulaScatter(values: number[]): CopulaPoint[] {
  if (values.length < 3) return [];
  const x = values.slice(0, -1);
  const y = values.slice(1);
  const n = x.length;

  const rankOf = (arr: number[]): number[] => {
    const indexed = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    indexed.forEach((item, rank) => { ranks[item.i] = (rank + 1) / (n + 1); });
    return ranks;
  };

  const rx = rankOf(x);
  const ry = rankOf(y);
  return rx.map((u, i) => ({ u, v: ry[i] }));
}

// === 14. 相互情報量 (ラグ付き) ===
export interface MILagPoint {
  lag: number;
  mi: number;
  acfAbs: number; // |ACF|² for comparison
}

export function mutualInfoByLag(values: number[], maxLag: number = 20, bins: number = 20): MILagPoint[] {
  const n = values.length;
  if (n < maxLag + bins) return [];

  const m = mean(values);
  const v = variance(values);
  const result: MILagPoint[] = [];

  for (let lag = 1; lag <= maxLag; lag++) {
    const x = values.slice(0, n - lag);
    const y = values.slice(lag);
    const mi = computeMI(x, y, bins);

    // ACF for comparison
    let acfVal = 0;
    if (v > 0) {
      for (let i = 0; i < n - lag; i++) {
        acfVal += (values[i] - m) * (values[i + lag] - m);
      }
      acfVal /= n * v;
    }

    result.push({ lag, mi, acfAbs: acfVal * acfVal });
  }
  return result;
}

function computeMI(x: number[], y: number[], bins: number): number {
  const n = x.length;
  const xMin = Math.min(...x), xMax = Math.max(...x);
  const yMin = Math.min(...y), yMax = Math.max(...y);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  const xBinW = xRange / bins;
  const yBinW = yRange / bins;

  const joint = new Array(bins * bins).fill(0);
  const margX = new Array(bins).fill(0);
  const margY = new Array(bins).fill(0);

  for (let i = 0; i < n; i++) {
    const xi = Math.min(Math.floor((x[i] - xMin) / xBinW), bins - 1);
    const yi = Math.min(Math.floor((y[i] - yMin) / yBinW), bins - 1);
    joint[yi * bins + xi]++;
    margX[xi]++;
    margY[yi]++;
  }

  let mi = 0;
  for (let yi = 0; yi < bins; yi++) {
    for (let xi = 0; xi < bins; xi++) {
      const pxy = joint[yi * bins + xi] / n;
      const px = margX[xi] / n;
      const py = margY[yi] / n;
      if (pxy > 0 && px > 0 && py > 0) {
        mi += pxy * Math.log(pxy / (px * py));
      }
    }
  }
  return Math.max(0, mi);
}

// === 7. クロスコレログラム ===
export interface CrossCorrPoint {
  lag: number; // negative = y leads x
  value: number;
}

export function crossCorrelogram(x: number[], y: number[], maxLag: number = 20): CrossCorrPoint[] {
  const n = Math.min(x.length, y.length);
  if (n < 5) return [];
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  const sx = stddev(x.slice(0, n)), sy = stddev(y.slice(0, n));
  if (sx <= 0 || sy <= 0) return [];

  const result: CrossCorrPoint[] = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0, count = 0;
    for (let i = 0; i < n; i++) {
      const j = i + lag;
      if (j >= 0 && j < n) {
        sum += (x.slice(0, n)[i] - mx) * (y.slice(0, n)[j] - my);
        count++;
      }
    }
    result.push({ lag, value: count > 0 ? sum / (count * sx * sy) : 0 });
  }
  return result;
}

// === 13. 条件付き分布 ===
export interface ConditionalBucket {
  label: string;
  values: number[];
  mean: number;
  std: number;
  skewness: number;
  kurtosis: number;
  n: number;
}

export function conditionalDistributions(values: number[]): ConditionalBucket[] {
  if (values.length < 20) return [];
  const s = stddev(values);
  const m = mean(values);
  if (s <= 0) return [];

  const buckets: Record<string, number[]> = {
    "大幅下落 (<-1σ)": [],
    "小幅下落 (-1σ~0)": [],
    "小幅上昇 (0~+1σ)": [],
    "大幅上昇 (>+1σ)": [],
  };

  for (let i = 0; i < values.length - 1; i++) {
    const z = (values[i] - m) / s;
    const next = values[i + 1];
    if (z < -1) buckets["大幅下落 (<-1σ)"].push(next);
    else if (z < 0) buckets["小幅下落 (-1σ~0)"].push(next);
    else if (z < 1) buckets["小幅上昇 (0~+1σ)"].push(next);
    else buckets["大幅上昇 (>+1σ)"].push(next);
  }

  return Object.entries(buckets).map(([label, vals]) => {
    const n = vals.length;
    if (n < 3) return { label, values: vals, mean: 0, std: 0, skewness: 0, kurtosis: 0, n };
    const bm = mean(vals);
    const bs = stddev(vals);
    const m3 = bs > 0 ? vals.reduce((a, v) => a + ((v - bm) / bs) ** 3, 0) / n : 0;
    const m4 = bs > 0 ? vals.reduce((a, v) => a + ((v - bm) / bs) ** 4, 0) / n - 3 : 0;
    return { label, values: vals, mean: bm, std: bs, skewness: m3, kurtosis: m4, n };
  });
}

// === 15. バイオリンプロット用KDE ===
export interface ViolinData {
  label: string;
  kde: KDEPoint[];
  median: number;
  q25: number;
  q75: number;
  n: number;
  mean: number;
}

export function violinByGroup(values: number[], times: string[], groupBy: "weekday" | "month"): ViolinData[] {
  const groups: Record<string, number[]> = {};

  for (let i = 0; i < values.length; i++) {
    const d = new Date(times[i]);
    let key: string;
    if (groupBy === "weekday") {
      const dow = d.getDay();
      if (dow === 0 || dow === 6) continue;
      const labels = ["", "月", "火", "水", "木", "金"];
      key = labels[dow];
    } else {
      key = `${d.getMonth() + 1}月`;
    }
    if (!groups[key]) groups[key] = [];
    groups[key].push(values[i]);
  }

  const order = groupBy === "weekday"
    ? ["月", "火", "水", "木", "金"]
    : ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];

  return order.filter(k => groups[k] && groups[k].length >= 5).map(label => {
    const vals = groups[label];
    const sorted = [...vals].sort((a, b) => a - b);
    const n = sorted.length;
    return {
      label,
      kde: kde(vals, 80),
      median: sorted[Math.floor(n / 2)],
      q25: sorted[Math.floor(n * 0.25)],
      q75: sorted[Math.floor(n * 0.75)],
      n,
      mean: mean(vals),
    };
  });
}

// === 21. Runs検定 ===
export interface RunsTestResult {
  nRuns: number;       // 実際の連の数
  expectedRuns: number; // 期待連数
  zStatistic: number;
  pValue: number;
  nPositive: number;
  nNegative: number;
  interpretation: string;
}

export function runsTest(values: number[]): RunsTestResult {
  const m = mean(values);
  const signs = values.map(v => v > m ? 1 : -1);
  const nPlus = signs.filter(s => s > 0).length;
  const nMinus = signs.filter(s => s < 0).length;
  const n = signs.length;

  if (nPlus === 0 || nMinus === 0) {
    return { nRuns: 1, expectedRuns: 1, zStatistic: 0, pValue: 1, nPositive: nPlus, nNegative: nMinus, interpretation: "一方向のみ" };
  }

  let runs = 1;
  for (let i = 1; i < n; i++) {
    if (signs[i] !== signs[i - 1]) runs++;
  }

  const expectedRuns = 1 + (2 * nPlus * nMinus) / n;
  const varianceRuns = (2 * nPlus * nMinus * (2 * nPlus * nMinus - n)) / (n * n * (n - 1));
  const z = varianceRuns > 0 ? (runs - expectedRuns) / Math.sqrt(varianceRuns) : 0;
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));

  let interpretation: string;
  if (pValue >= 0.05) {
    interpretation = "ランダム (帰無仮説を棄却できない)";
  } else if (runs < expectedRuns) {
    interpretation = "連が少ない → トレンド持続傾向 (モメンタム)";
  } else {
    interpretation = "連が多い → 反転傾向 (ミーンリバージョン)";
  }

  return { nRuns: runs, expectedRuns, zStatistic: z, pValue, nPositive: nPlus, nNegative: nMinus, interpretation };
}

// === 22. BDS検定 ===
export interface BDSTestResult {
  epsilon: number;
  dimensions: { m: number; bds: number; zStat: number; pValue: number }[];
}

export function bdsTest(values: number[], maxDim: number = 5): BDSTestResult {
  const n = values.length;
  const s = stddev(values);
  const epsilon = 0.75 * s; // 一般的な選択: 0.5σ ~ 1.5σ
  if (s <= 0 || n < 50) return { epsilon, dimensions: [] };

  // C(m, epsilon) = (2 / (n_m * (n_m-1))) * Σ_{i<j} I(|x_i^m - x_j^m| < epsilon)
  // ここで x_i^m は m次元埋め込みベクトル

  // C1を先に計算
  let c1Count = 0;
  const nm1 = n;
  for (let i = 0; i < nm1; i++) {
    for (let j = i + 1; j < nm1; j++) {
      if (Math.abs(values[i] - values[j]) < epsilon) c1Count++;
    }
  }
  const C1 = (2 * c1Count) / (nm1 * (nm1 - 1));
  if (C1 <= 0 || C1 >= 1) return { epsilon, dimensions: [] };

  const dimensions: { m: number; bds: number; zStat: number; pValue: number }[] = [];

  for (let m = 2; m <= maxDim; m++) {
    const nm = n - m + 1;
    if (nm < 20) break;

    // Cm計算
    let cmCount = 0;
    for (let i = 0; i < nm; i++) {
      for (let j = i + 1; j < nm; j++) {
        let close = true;
        for (let k = 0; k < m; k++) {
          if (Math.abs(values[i + k] - values[j + k]) >= epsilon) {
            close = false;
            break;
          }
        }
        if (close) cmCount++;
      }
    }
    const Cm = (2 * cmCount) / (nm * (nm - 1));
    const bds = Cm - Math.pow(C1, m);

    // 分散の推定 (簡略化版)
    const K = computeK(values, epsilon);
    const sigma2 = estimateBDSVariance(C1, K, m, n);
    const zStat = sigma2 > 0 ? bds / Math.sqrt(sigma2) : 0;
    const pValue = 2 * (1 - normalCDF(Math.abs(zStat)));

    dimensions.push({ m, bds, zStat, pValue });
  }

  return { epsilon, dimensions };
}

function computeK(values: number[], epsilon: number): number {
  const n = values.length;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        if (Math.abs(values[i] - values[j]) < epsilon &&
            Math.abs(values[i] - values[k]) < epsilon &&
            Math.abs(values[j] - values[k]) < epsilon) {
          count++;
        }
        if (k > j + 50) break; // 計算量制限
      }
      if (j > i + 200) break;
    }
    if (i > 500) break;
  }
  const nTriples = Math.min(n, 501) * 200 * 50 / 6;
  return nTriples > 0 ? count / nTriples : 0;
}

function estimateBDSVariance(C1: number, K: number, m: number, n: number): number {
  // 簡略化された分散推定
  const c2 = C1 * C1;
  const km = Math.pow(K, m);
  const cm1 = Math.pow(C1, m);
  // Brock, Dechert, Scheinkman (1987) の分散推定
  const sigma2 = 4 * (km + (m - 1) * (m - 1) * Math.pow(c2, m) - m * m * K * Math.pow(c2, m - 1)) / n;
  return Math.max(sigma2, 1e-20);
}

// === 18. ローリング密度サーフェス ===
export interface DensitySurfaceRow {
  time: string;
  densities: number[]; // nBins個の密度値
}

export function rollingDensitySurface(
  values: number[],
  times: string[],
  window: number = 60,
  nBins: number = 40,
  step: number = 5
): { rows: DensitySurfaceRow[]; binCenters: number[] } {
  if (values.length < window) return { rows: [], binCenters: [] };

  // グローバルなビン範囲を決定
  const globalMin = Math.min(...values);
  const globalMax = Math.max(...values);
  const range = globalMax - globalMin || 1;
  const binWidth = range / nBins;
  const binCenters = Array.from({ length: nBins }, (_, i) => globalMin + (i + 0.5) * binWidth);

  const rows: DensitySurfaceRow[] = [];
  for (let i = window - 1; i < values.length; i += step) {
    const slice = values.slice(i - window + 1, i + 1);
    const s = stddev(slice);
    const h = s > 0 ? 1.06 * s * Math.pow(slice.length, -1 / 5) : 0.01;

    const densities = binCenters.map(x => {
      let d = 0;
      for (const v of slice) {
        const z = (x - v) / h;
        d += Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
      }
      return d / (slice.length * h);
    });

    rows.push({ time: times[i], densities });
  }

  return { rows, binCenters };
}

// === 11. 散布図行列用のデータ ===
export interface ScatterPair {
  labelX: string;
  labelY: string;
  points: { x: number; y: number }[];
  correlation: number;
}

export function scatterMatrix(
  values: number[],
  times: string[],
  volumes?: number[]
): ScatterPair[] {
  const n = values.length;
  if (n < 10) return [];

  const lag1 = values.slice(1);
  const current = values.slice(0, -1);
  const absVals = values.map(v => Math.abs(v));
  const absLag1 = absVals.slice(1);
  const absCurrent = absVals.slice(0, -1);

  const pairs: ScatterPair[] = [];

  // r[t] vs r[t-1]
  const pts1 = current.map((x, i) => ({ x, y: lag1[i] }));
  pairs.push({ labelX: "r[t-1]", labelY: "r[t]", points: pts1, correlation: corr(current, lag1) });

  // r[t] vs |r[t-1]|
  const pts2 = absCurrent.map((x, i) => ({ x, y: lag1[i] }));
  pairs.push({ labelX: "|r[t-1]|", labelY: "r[t]", points: pts2, correlation: corr(absCurrent, lag1) });

  // |r[t]| vs |r[t-1]|
  const pts3 = absCurrent.map((x, i) => ({ x, y: absLag1[i] }));
  pairs.push({ labelX: "|r[t-1]|", labelY: "|r[t]|", points: pts3, correlation: corr(absCurrent, absLag1) });

  // r[t] vs volume change (if available)
  if (volumes && volumes.length === n) {
    const volChange: number[] = [];
    const rForVol: number[] = [];
    for (let i = 1; i < n; i++) {
      if (volumes[i - 1] > 0) {
        volChange.push(Math.log(volumes[i] / volumes[i - 1]));
        rForVol.push(values[i]);
      }
    }
    if (volChange.length > 10) {
      const pts4 = volChange.map((x, i) => ({ x, y: rForVol[i] }));
      pairs.push({ labelX: "出来高変化", labelY: "r[t]", points: pts4, correlation: corr(volChange, rForVol) });
    }
  }

  return pairs;
}

function corr(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  const sx = stddev(x.slice(0, n)), sy = stddev(y.slice(0, n));
  if (sx <= 0 || sy <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (x[i] - mx) * (y[i] - my);
  return sum / (n * sx * sy);
}
