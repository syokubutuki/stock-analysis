// Lomb-Scargle Periodogram
// 不等間隔データ対応のスペクトル推定

export interface LombScarglePoint {
  frequency: number;
  period: number;
  power: number;
}

export interface LombScarlgePeak {
  period: number;
  power: number;
  fap: number; // False Alarm Probability
}

export interface LombScargleResult {
  spectrum: LombScarglePoint[];
  peakPeriods: LombScarlgePeak[];
  interpretation: string;
}

/**
 * 日付文字列を最初の日付からの経過日数に変換
 */
function datesToDays(times: string[]): number[] {
  if (times.length === 0) return [];
  const t0 = new Date(times[0]).getTime();
  return times.map((t) => (new Date(t).getTime() - t0) / 86400000);
}

/**
 * Lomb-Scargle ペリオドグラム計算
 */
export function computeLombScargle(
  values: number[],
  times: string[],
  nFreqs: number = 300
): LombScargleResult {
  const n = values.length;
  const empty: LombScargleResult = {
    spectrum: [],
    peakPeriods: [],
    interpretation: "データが不足しています。",
  };
  if (n < 30) return empty;

  const t = datesToDays(times);

  // 平均を引く
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;

  const x: number[] = values.map((v) => v - mean);

  // 分散
  let variance = 0;
  for (const xi of x) variance += xi * xi;
  variance /= n;
  if (variance < 1e-16) return empty;

  // 周波数範囲: f_min = 1/(total span), f_max = 1/(2 * median dt)
  const totalSpan = t[n - 1] - t[0];
  if (totalSpan <= 0) return empty;

  // メディアンdt
  const dts: number[] = [];
  for (let i = 1; i < n; i++) dts.push(t[i] - t[i - 1]);
  dts.sort((a, b) => a - b);
  const medianDt = dts[Math.floor(dts.length / 2)] || 1;

  const fMin = 1 / totalSpan;
  const fMax = 1 / (2 * medianDt);
  const df = (fMax - fMin) / (nFreqs - 1);

  const spectrum: LombScarglePoint[] = [];

  for (let fi = 0; fi < nFreqs; fi++) {
    const freq = fMin + fi * df;
    const omega = 2 * Math.PI * freq;

    // tau: 位相補正
    let s2 = 0, c2 = 0;
    for (let i = 0; i < n; i++) {
      s2 += Math.sin(2 * omega * t[i]);
      c2 += Math.cos(2 * omega * t[i]);
    }
    const tau = Math.atan2(s2, c2) / (2 * omega);

    // パワー計算
    let cosSum = 0, sinSum = 0;
    let cos2Sum = 0, sin2Sum = 0;

    for (let i = 0; i < n; i++) {
      const phase = omega * (t[i] - tau);
      const cosP = Math.cos(phase);
      const sinP = Math.sin(phase);
      cosSum += x[i] * cosP;
      sinSum += x[i] * sinP;
      cos2Sum += cosP * cosP;
      sin2Sum += sinP * sinP;
    }

    const power =
      cos2Sum > 1e-12 && sin2Sum > 1e-12
        ? (cosSum * cosSum / cos2Sum + sinSum * sinSum / sin2Sum) / (2 * variance)
        : 0;

    spectrum.push({
      frequency: freq,
      period: 1 / freq,
      power,
    });
  }

  // ピーク検出 (局所最大値)
  const peaks: LombScarlgePeak[] = [];
  for (let i = 1; i < spectrum.length - 1; i++) {
    if (
      spectrum[i].power > spectrum[i - 1].power &&
      spectrum[i].power > spectrum[i + 1].power &&
      spectrum[i].power > 3 // 有意水準の目安
    ) {
      // False Alarm Probability: FAP = 1 - (1 - e^{-z})^M
      const z = spectrum[i].power;
      const M = nFreqs; // 独立周波数数の近似
      const fap = 1 - Math.pow(1 - Math.exp(-z), M);
      peaks.push({
        period: spectrum[i].period,
        power: spectrum[i].power,
        fap: Math.max(0, Math.min(1, fap)),
      });
    }
  }

  // パワー降順でソート
  peaks.sort((a, b) => b.power - a.power);
  const topPeaks = peaks.slice(0, 5);

  // 解釈
  let interpretation = "";
  const sigPeaks = topPeaks.filter((p) => p.fap < 0.01);
  if (sigPeaks.length === 0) {
    interpretation =
      "統計的に有意な周期成分は検出されませんでした。この時系列にはランダムなノイズが支配的か、スペクトルが広帯域に分散しています。";
  } else {
    const periodTexts = sigPeaks.map((p) => {
      const days = Math.round(p.period);
      if (days >= 200 && days <= 280) return `${days}日(約1年の営業日)`;
      if (days >= 100 && days <= 140) return `${days}日(約半年)`;
      if (days >= 55 && days <= 70) return `${days}日(約3ヶ月)`;
      if (days >= 18 && days <= 24) return `${days}日(約1ヶ月)`;
      if (days >= 4 && days <= 6) return `${days}日(約1週)`;
      return `${days}日`;
    });
    interpretation = `有意な周期成分: ${periodTexts.join(", ")}。これらの周期はFFTでは検出しにくい不等間隔データに対応した推定結果です。`;
  }

  return { spectrum, peakPeriods: topPeaks, interpretation };
}
