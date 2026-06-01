/**
 * Density Matrix: HMM事後確率による複数レジーム同時保持
 * 市場が複数状態の混合である確率を可視化
 */
import { PricePoint } from "./types";

export interface DensityMatrixResult {
  /** 各時点でのレジーム確率 */
  data: DensityMatrixPoint[];
  /** レジーム定義 */
  regimes: RegimeDef[];
  /** 現在のレジーム確率 */
  currentProbabilities: number[];
  /** レジーム間遷移行列 */
  transitionMatrix: number[][];
  /** フォンノイマンエントロピー（混合度） */
  entropy: number[];
}

export interface DensityMatrixPoint {
  time: string;
  /** 各レジームの事後確率 [0-1] */
  probabilities: number[];
  /** 支配的レジーム */
  dominantRegime: number;
  /** エントロピー（不確実性の度合い） */
  entropy: number;
}

export interface RegimeDef {
  id: number;
  label: string;
  color: string;
  meanReturn: number;
  volatility: number;
}

export function computeDensityMatrix(
  prices: PricePoint[],
  nRegimes: number = 3
): DensityMatrixResult {
  const empty: DensityMatrixResult = {
    data: [],
    regimes: [],
    currentProbabilities: [],
    transitionMatrix: [],
    entropy: [],
  };
  if (prices.length < 60) return empty;

  const closes = prices.map((p) => p.close);
  const n = closes.length;

  // 対数リターン
  const lr: number[] = [];
  for (let i = 1; i < n; i++) lr.push(Math.log(closes[i] / closes[i - 1]));

  // K-meansでリターンをnRegimes個に分類（簡易HMM代替）
  const { centers, assignments, variances } = kmeansGaussian(lr, nRegimes);

  // レジーム定義（リターン順にソート）
  const order = centers.map((c, i) => ({ c, i })).sort((a, b) => a.c - b.c);
  const regimeMap = new Map<number, number>();
  order.forEach((o, newIdx) => regimeMap.set(o.i, newIdx));

  const labels = nRegimes === 3
    ? ["下落", "中立", "上昇"]
    : nRegimes === 2
    ? ["下落", "上昇"]
    : Array.from({ length: nRegimes }, (_, i) => `状態${i + 1}`);
  const colors = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6"].slice(0, nRegimes);

  const regimes: RegimeDef[] = order.map((o, newIdx) => ({
    id: newIdx,
    label: labels[newIdx],
    color: colors[newIdx],
    meanReturn: o.c * 252, // 年率化
    volatility: Math.sqrt(variances[o.i]) * Math.sqrt(252),
  }));

  // 遷移行列の推定
  const transitionCounts = Array.from({ length: nRegimes }, () =>
    new Array(nRegimes).fill(0)
  );
  const remapped = assignments.map((a) => regimeMap.get(a)!);
  for (let i = 1; i < remapped.length; i++) {
    transitionCounts[remapped[i - 1]][remapped[i]]++;
  }
  const transitionMatrix = transitionCounts.map((row) => {
    const total = row.reduce((a, b) => a + b, 0);
    return total > 0 ? row.map((v) => v / total) : row.map(() => 1 / nRegimes);
  });

  // Forward algorithmで事後確率を計算
  const data: DensityMatrixPoint[] = [];
  const entropyArr: number[] = [];

  // 初期確率
  let prob = new Array(nRegimes).fill(1 / nRegimes);

  for (let t = 0; t < lr.length; t++) {
    // 観測尤度
    const likelihoods = order.map((o) => {
      const sigma = Math.sqrt(Math.max(1e-10, variances[o.i]));
      const z = (lr[t] - o.c) / sigma;
      return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
    });

    // 予測ステップ
    const predicted = new Array(nRegimes).fill(0);
    for (let j = 0; j < nRegimes; j++) {
      for (let i = 0; i < nRegimes; i++) {
        predicted[j] += transitionMatrix[i][j] * prob[i];
      }
    }

    // 更新ステップ
    const updated = predicted.map((p, j) => p * likelihoods[j]);
    const total = updated.reduce((a, b) => a + b, 0);
    prob = total > 0 ? updated.map((p) => p / total) : new Array(nRegimes).fill(1 / nRegimes);

    // エントロピー
    let entropy = 0;
    for (const p of prob) {
      if (p > 1e-10) entropy -= p * Math.log2(p);
    }

    const dominantRegime = prob.indexOf(Math.max(...prob));

    data.push({
      time: prices[t + 1].time,
      probabilities: [...prob],
      dominantRegime,
      entropy,
    });
    entropyArr.push(entropy);
  }

  const currentProbabilities = data.length > 0 ? data[data.length - 1].probabilities : [];

  return {
    data,
    regimes,
    currentProbabilities,
    transitionMatrix,
    entropy: entropyArr,
  };
}

function kmeansGaussian(
  data: number[],
  k: number,
  maxIter: number = 50
): { centers: number[]; assignments: number[]; variances: number[] } {
  const sorted = [...data].sort((a, b) => a - b);
  // 初期中心: 等間隔パーセンタイル
  const centers = Array.from({ length: k }, (_, i) =>
    sorted[Math.floor(((i + 0.5) / k) * sorted.length)]
  );
  let assignments = new Array(data.length).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    // 割り当て
    const newAssignments = data.map((x) => {
      let minDist = Infinity;
      let best = 0;
      for (let j = 0; j < k; j++) {
        const d = Math.abs(x - centers[j]);
        if (d < minDist) {
          minDist = d;
          best = j;
        }
      }
      return best;
    });

    // 中心更新
    let changed = false;
    for (let j = 0; j < k; j++) {
      const members = data.filter((_, i) => newAssignments[i] === j);
      if (members.length > 0) {
        const newCenter = members.reduce((a, b) => a + b, 0) / members.length;
        if (Math.abs(newCenter - centers[j]) > 1e-10) changed = true;
        centers[j] = newCenter;
      }
    }

    assignments = newAssignments;
    if (!changed) break;
  }

  // 各クラスタの分散
  const variances = centers.map((c, j) => {
    const members = data.filter((_, i) => assignments[i] === j);
    if (members.length < 2) return 1e-6;
    const m = members.reduce((a, b) => a + b, 0) / members.length;
    return members.reduce((s, x) => s + (x - m) ** 2, 0) / members.length;
  });

  return { centers, assignments, variances };
}
