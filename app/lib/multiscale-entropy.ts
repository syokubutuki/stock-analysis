// Multiscale Entropy (MSE) & Fisher Information

import { sampleEntropy } from "./entropy";

export interface MSEPoint {
  scale: number;
  entropy: number;
}

// 粗視化 (coarse-graining): スケールτで平均を取る
function coarseGrain(values: number[], scale: number): number[] {
  const n = Math.floor(values.length / scale);
  const result: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < scale; j++) {
      sum += values[i * scale + j];
    }
    result.push(sum / scale);
  }
  return result;
}

// Multiscale Entropy
export function multiscaleEntropy(
  values: number[],
  maxScale: number = 20,
  m: number = 2
): MSEPoint[] {
  const result: MSEPoint[] = [];
  const actualMax = Math.min(maxScale, Math.floor(values.length / (m + 2)));

  for (let scale = 1; scale <= actualMax; scale++) {
    const coarsed = coarseGrain(values, scale);
    if (coarsed.length < m + 2) break;
    const se = sampleEntropy(coarsed, m);
    result.push({ scale, entropy: se });
  }
  return result;
}

// Fisher Information (ローリング)
export interface FisherPoint {
  time: string;
  value: number;
}

// Fisher Information: 確率分布の「変化の鋭敏さ」
// 離散近似: FI = Σ (1/p_i) * (dp_i/dt)²
// ここではPDFのヒストグラムベースで計算
export function fisherInformation(
  values: number[],
  times: string[],
  window: number = 60,
  bins: number = 20
): FisherPoint[] {
  const result: FisherPoint[] = [];

  for (let i = window; i < values.length; i++) {
    const prev = values.slice(i - window, i - Math.floor(window / 2));
    const curr = values.slice(i - Math.floor(window / 2), i);

    const prevHist = makeHistogram(prev, bins);
    const currHist = makeHistogram(curr, bins);

    let fi = 0;
    for (let b = 0; b < bins; b++) {
      const p = (prevHist[b] + currHist[b]) / 2;
      const dp = currHist[b] - prevHist[b];
      if (p > 1e-10) {
        fi += (dp * dp) / p;
      }
    }

    result.push({ time: times[i], value: fi });
  }
  return result;
}

function makeHistogram(values: number[], bins: number): number[] {
  const n = values.length;
  if (n === 0) return new Array(bins).fill(0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(Math.floor(((v - min) / range) * bins), bins - 1);
    counts[idx]++;
  }
  return counts.map((c) => c / n);
}
