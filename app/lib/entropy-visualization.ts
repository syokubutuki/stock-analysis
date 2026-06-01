// エントロピー可視化データ: ヒートマップ, パターン分布, 乖離マップ, ウォーターフォール

import { sampleEntropy, shannonEntropy } from "./entropy";
import { mutualInformation } from "./causal";

// コースグレイン
function coarseGrain(values: number[], scale: number): number[] {
  const n = Math.floor(values.length / scale);
  const result: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < scale; j++) sum += values[i * scale + j];
    result.push(sum / scale);
  }
  return result;
}

// エントロピーヒートマップ: time×scale行列
export interface HeatmapData {
  times: string[];
  scales: number[];
  values: number[][]; // [timeIdx][scaleIdx]
}

export function entropyHeatmap(
  values: number[], times: string[], maxScale: number = 20, window: number = 60, step: number = 5
): HeatmapData {
  const timePoints: string[] = [];
  const allValues: number[][] = [];

  for (let i = window - 1; i < values.length; i += step) {
    const slice = values.slice(i - window + 1, i + 1);
    const row: number[] = [];
    for (let s = 1; s <= maxScale; s++) {
      const coarsed = coarseGrain(slice, s);
      if (coarsed.length >= 4) {
        row.push(sampleEntropy(coarsed, 2));
      } else {
        row.push(NaN);
      }
    }
    allValues.push(row);
    timePoints.push(times[i]);
  }

  return {
    times: timePoints,
    scales: Array.from({ length: maxScale }, (_, i) => i + 1),
    values: allValues,
  };
}

// 順列パターン分布
export interface PatternDistribution {
  pattern: string;
  frequency: number;
  label: string;
}

const PATTERN_LABELS: Record<string, string> = {
  "0,1,2": "上昇",
  "2,1,0": "下降",
  "0,2,1": "山型",
  "1,0,2": "谷型",
  "1,2,0": "遅延下降",
  "2,0,1": "遅延上昇",
};

export function permutationPatternDistribution(values: number[], order: number = 3, delay: number = 1): PatternDistribution[] {
  const n = values.length;
  const counts = new Map<string, number>();
  let total = 0;

  for (let i = 0; i <= n - (order - 1) * delay - 1; i++) {
    const subseq: number[] = [];
    for (let j = 0; j < order; j++) subseq.push(values[i + j * delay]);
    const ranked = subseq
      .map((v, idx) => ({ v, idx }))
      .sort((a, b) => a.v - b.v)
      .map((item) => item.idx);
    const pattern = ranked.join(",");
    counts.set(pattern, (counts.get(pattern) || 0) + 1);
    total++;
  }

  const result: PatternDistribution[] = [];
  for (const [pattern, count] of counts) {
    result.push({
      pattern,
      frequency: total > 0 ? count / total : 0,
      label: PATTERN_LABELS[pattern] || pattern,
    });
  }
  result.sort((a, b) => b.frequency - a.frequency);
  return result;
}

// エントロピー乖離マップ: 短期と長期のエントロピーを比較
export interface DivergenceMapPoint {
  time: string;
  shortEntropy: number;
  longEntropy: number;
  divergence: number;
}

export function entropyDivergenceMap(
  values: number[], times: string[], shortWindow: number = 30, longWindow: number = 120
): DivergenceMapPoint[] {
  const result: DivergenceMapPoint[] = [];
  for (let i = longWindow - 1; i < values.length; i++) {
    const shortSlice = values.slice(i - shortWindow + 1, i + 1);
    const longSlice = values.slice(i - longWindow + 1, i + 1);
    const se = shannonEntropy(shortSlice);
    const le = shannonEntropy(longSlice);
    result.push({
      time: times[i],
      shortEntropy: se,
      longEntropy: le,
      divergence: se - le,
    });
  }
  return result;
}

// 情報分解ウォーターフォール
export interface WaterfallItem {
  label: string;
  value: number;
  color: string;
}

export function infoDecompositionWaterfall(
  values: number[], volumes: number[], bins: number = 16
): WaterfallItem[] {
  const n = Math.min(values.length, volumes.length);
  if (n < 30) return [];

  const returns = values.slice(0, n);
  const vols = volumes.slice(0, n);
  const absReturns = returns.map((r) => Math.abs(r));

  const totalEntropy = shannonEntropy(returns, bins);

  // 過去の自己情報
  const pastReturns = returns.slice(0, -1);
  const futureReturns = returns.slice(1);
  const ais = mutualInformation(pastReturns, futureReturns, bins);

  // ボリューム関連情報
  const volMI = mutualInformation(returns, vols, bins);

  // ボラティリティ関連情報
  const volatilityMI = mutualInformation(returns, absReturns, bins);

  // 残差
  const residual = Math.max(0, totalEntropy - ais - volMI - volatilityMI);

  return [
    { label: "自己予測 (AIS)", value: ais, color: "#8b5cf6" },
    { label: "出来高 MI", value: volMI, color: "#3b82f6" },
    { label: "ボラティリティ MI", value: volatilityMI, color: "#f59e0b" },
    { label: "残差エントロピー", value: residual, color: "#6b7280" },
  ];
}
