// リターン分布分析 + QQプロット

export interface HistogramBin {
  x: number; // bin center
  count: number;
  density: number;
}

export interface QQPoint {
  theoretical: number;
  observed: number;
}

export interface DistributionStats {
  mean: number;
  std: number;
  skewness: number;
  kurtosis: number; // excess
  jarqueBera: number; // 正規性検定統計量
  jbPValue: number;
}

// ヒストグラム生成
export function histogram(values: number[], bins: number = 40): HistogramBin[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const binWidth = range / bins;

  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(Math.floor((v - min) / binWidth), bins - 1);
    counts[idx]++;
  }

  const n = values.length;
  return counts.map((count, i) => ({
    x: min + (i + 0.5) * binWidth,
    count,
    density: count / (n * binWidth),
  }));
}

// 正規分布のPDF
export function normalPDF(x: number, mean: number, std: number): number {
  if (std <= 0) return 0;
  const z = (x - mean) / std;
  return Math.exp(-0.5 * z * z) / (std * Math.sqrt(2 * Math.PI));
}

// 正規分布のQuantile (逆CDF) — Beasley-Springer-Moro近似
function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [
    -3.969683028665376e+01, 2.209460984245205e+02,
    -2.759285104469687e+02, 1.383577518672690e+02,
    -3.066479806614716e+01, 2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01, 1.615858368580409e+02,
    -1.556989798598866e+02, 6.680131188771972e+01,
    -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03, -3.223964580411365e-01,
    -2.400758277161838e+00, -2.549732539343734e+00,
    4.374664141464968e+00, 2.938163982698783e+00,
  ];
  const d = [
    7.784695709041462e-03, 3.224671290700398e-01,
    2.445134137142996e+00, 3.754408661907416e+00,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    const r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

// QQプロット: 観測値 vs 正規分布の理論分位
export function qqPlot(values: number[]): QQPoint[] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / n);

  return sorted.map((v, i) => ({
    theoretical: mean + std * normalQuantile((i + 0.5) / n),
    observed: v,
  }));
}

// 分布の統計量
export function distributionStats(values: number[]): DistributionStats {
  const n = values.length;
  if (n < 4) return { mean: 0, std: 0, skewness: 0, kurtosis: 0, jarqueBera: 0, jbPValue: 1 };

  const mean = values.reduce((a, b) => a + b, 0) / n;
  const m2 = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(m2);
  if (std === 0) return { mean, std: 0, skewness: 0, kurtosis: 0, jarqueBera: 0, jbPValue: 1 };

  const m3 = values.reduce((a, v) => a + ((v - mean) / std) ** 3, 0) / n;
  const m4 = values.reduce((a, v) => a + ((v - mean) / std) ** 4, 0) / n;
  const skewness = m3;
  const kurtosis = m4 - 3;

  // Jarque-Bera検定
  const jb = (n / 6) * (skewness ** 2 + (kurtosis ** 2) / 4);
  // χ²(2)分布での近似p値
  const jbPValue = Math.exp(-jb / 2);

  return { mean, std, skewness, kurtosis, jarqueBera: jb, jbPValue };
}
