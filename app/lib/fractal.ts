// フラクタル・スケーリング: DFA, Hurst指数, MF-DFA

export interface DFAPoint {
  logN: number;
  logF: number;
  n: number;
}

export interface DFAResult {
  points: DFAPoint[];
  hurstExponent: number; // α ≈ H (Hurst指数)
  interpretation: string;
}

// DFA (Detrended Fluctuation Analysis)
export function computeDFA(values: number[]): DFAResult {
  const n = values.length;
  if (n < 20) {
    return {
      points: [],
      hurstExponent: 0.5,
      interpretation: "データ不足",
    };
  }

  // 1. 累積偏差系列
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const profile: number[] = [];
  let cumSum = 0;
  for (const v of values) {
    cumSum += v - mean;
    profile.push(cumSum);
  }

  // 2. 様々なスケールでの変動関数 F(n) を計算
  const minScale = 4;
  const maxScale = Math.floor(n / 4);
  const numScales = 20;
  const scales: number[] = [];
  for (let i = 0; i < numScales; i++) {
    const s = Math.round(
      minScale * Math.pow(maxScale / minScale, i / (numScales - 1))
    );
    if (scales.length === 0 || s !== scales[scales.length - 1]) {
      scales.push(s);
    }
  }

  const points: DFAPoint[] = [];

  for (const s of scales) {
    const numSegments = Math.floor(n / s);
    if (numSegments < 1) continue;

    let totalVariance = 0;
    let count = 0;

    for (let seg = 0; seg < numSegments; seg++) {
      const start = seg * s;
      // 線形トレンド除去
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      for (let j = 0; j < s; j++) {
        sumX += j;
        sumY += profile[start + j];
        sumXY += j * profile[start + j];
        sumX2 += j * j;
      }
      const a = (s * sumXY - sumX * sumY) / (s * sumX2 - sumX * sumX);
      const b = (sumY - a * sumX) / s;

      let variance = 0;
      for (let j = 0; j < s; j++) {
        const trend = a * j + b;
        variance += (profile[start + j] - trend) ** 2;
      }
      totalVariance += variance / s;
      count++;
    }

    if (count > 0) {
      const F = Math.sqrt(totalVariance / count);
      if (F > 0) {
        points.push({
          logN: Math.log10(s),
          logF: Math.log10(F),
          n: s,
        });
      }
    }
  }

  // 3. log-log 回帰でα（Hurst指数）を推定
  const hurstExponent = fitSlope(
    points.map((p) => p.logN),
    points.map((p) => p.logF)
  );

  let interpretation: string;
  if (hurstExponent < 0.4) {
    interpretation = "反持続性 (逆張り傾向)";
  } else if (hurstExponent < 0.6) {
    interpretation = "ランダムウォーク (効率的市場)";
  } else if (hurstExponent < 0.8) {
    interpretation = "持続性 (トレンド傾向)";
  } else {
    interpretation = "強い持続性 (強トレンド)";
  }

  return { points, hurstExponent, interpretation };
}

// MF-DFA (マルチフラクタルDFA)
export interface MFDFAResult {
  qValues: number[];
  hurst: number[]; // h(q) — 一般化Hurst指数
  tauQ: number[];  // τ(q) — スケーリング関数
  singularitySpectrum: { alpha: number; f: number }[];
  width: number; // スペクトル幅 (マルチフラクタル性の強さ)
}

export function computeMFDFA(
  values: number[],
  qRange: number[] = [-5, -3, -1, 0, 1, 2, 3, 5]
): MFDFAResult {
  const n = values.length;
  if (n < 40) {
    return {
      qValues: [],
      hurst: [],
      tauQ: [],
      singularitySpectrum: [],
      width: 0,
    };
  }

  const mean = values.reduce((a, b) => a + b, 0) / n;
  const profile: number[] = [];
  let cumSum = 0;
  for (const v of values) {
    cumSum += v - mean;
    profile.push(cumSum);
  }

  const minScale = 4;
  const maxScale = Math.floor(n / 4);
  const numScales = 15;
  const scales: number[] = [];
  for (let i = 0; i < numScales; i++) {
    const s = Math.round(
      minScale * Math.pow(maxScale / minScale, i / (numScales - 1))
    );
    if (scales.length === 0 || s !== scales[scales.length - 1]) {
      scales.push(s);
    }
  }

  const hurst: number[] = [];
  const tauQ: number[] = [];

  for (const q of qRange) {
    const logN: number[] = [];
    const logFq: number[] = [];

    for (const s of scales) {
      const numSegments = Math.floor(n / s);
      if (numSegments < 1) continue;

      const variances: number[] = [];
      for (let seg = 0; seg < numSegments; seg++) {
        const start = seg * s;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        for (let j = 0; j < s; j++) {
          sumX += j;
          sumY += profile[start + j];
          sumXY += j * profile[start + j];
          sumX2 += j * j;
        }
        const a = (s * sumXY - sumX * sumY) / (s * sumX2 - sumX * sumX);
        const b = (sumY - a * sumX) / s;

        let variance = 0;
        for (let j = 0; j < s; j++) {
          variance += (profile[start + j] - (a * j + b)) ** 2;
        }
        variances.push(variance / s);
      }

      let Fq: number;
      if (q === 0) {
        Fq = Math.exp(
          variances.reduce((a, v) => a + Math.log(Math.sqrt(v) + 1e-20), 0) /
            variances.length
        );
      } else {
        Fq = Math.pow(
          variances.reduce((a, v) => a + Math.pow(Math.sqrt(v), q), 0) /
            variances.length,
          1 / q
        );
      }

      if (Fq > 0) {
        logN.push(Math.log10(s));
        logFq.push(Math.log10(Fq));
      }
    }

    const h = fitSlope(logN, logFq);
    hurst.push(h);
    tauQ.push(q * h - 1);
  }

  // 特異性スペクトル f(α)
  const singularitySpectrum: { alpha: number; f: number }[] = [];
  for (let i = 1; i < qRange.length - 1; i++) {
    const alpha = (tauQ[i + 1] - tauQ[i - 1]) / (qRange[i + 1] - qRange[i - 1]);
    const f = qRange[i] * alpha - tauQ[i];
    singularitySpectrum.push({ alpha, f });
  }

  const alphas = singularitySpectrum.map((s) => s.alpha);
  const width = alphas.length > 0 ? Math.max(...alphas) - Math.min(...alphas) : 0;

  return { qValues: qRange, hurst, tauQ, singularitySpectrum, width };
}

function fitSlope(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0.5;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((a, xi, i) => a + xi * y[i], 0);
  const sumX2 = x.reduce((a, xi) => a + xi * xi, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return 0.5;
  return (n * sumXY - sumX * sumY) / denom;
}
