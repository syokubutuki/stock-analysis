// エントロピー拡張: Renyi, Tsallis, ApEn, Weighted PE, Conditional Entropy, Entropy Rate, Excess Entropy

import { shannonEntropy } from "./entropy";

// ヒストグラム確率分布を作成
function makeProbDist(values: number[], bins: number): number[] {
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

// 2次元ヒストグラム確率分布
function makeJointDist(x: number[], y: number[], bins: number): { joint: number[][]; margX: number[]; margY: number[] } {
  const n = Math.min(x.length, y.length);
  if (n === 0) return { joint: [], margX: [], margY: [] };
  const xMin = Math.min(...x), xMax = Math.max(...x);
  const yMin = Math.min(...y), yMax = Math.max(...y);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const joint = Array.from({ length: bins }, () => new Array(bins).fill(0));
  const margX = new Array(bins).fill(0);
  const margY = new Array(bins).fill(0);

  for (let i = 0; i < n; i++) {
    const bx = Math.min(Math.floor(((x[i] - xMin) / xRange) * bins), bins - 1);
    const by = Math.min(Math.floor(((y[i] - yMin) / yRange) * bins), bins - 1);
    joint[bx][by]++;
    margX[bx]++;
    margY[by]++;
  }

  // 正規化
  for (let i = 0; i < bins; i++) {
    for (let j = 0; j < bins; j++) joint[i][j] /= n;
    margX[i] /= n;
    margY[i] /= n;
  }
  return { joint, margX, margY };
}

// Renyiエントロピー: H_α = (1/(1-α)) * log2(Σ p_i^α)
export function renyiEntropy(values: number[], alpha: number = 2, bins: number = 20): number {
  if (values.length === 0 || alpha === 1) return shannonEntropy(values, bins);
  const probs = makeProbDist(values, bins);
  let sum = 0;
  for (const p of probs) {
    if (p > 0) sum += Math.pow(p, alpha);
  }
  if (sum === 0) return 0;
  return (1 / (1 - alpha)) * Math.log2(sum);
}

// Tsallisエントロピー: S_q = (1/(q-1)) * (1 - Σ p_i^q)
export function tsallisEntropy(values: number[], q: number = 1.5, bins: number = 20): number {
  if (values.length === 0) return 0;
  if (Math.abs(q - 1) < 1e-10) return shannonEntropy(values, bins);
  const probs = makeProbDist(values, bins);
  let sum = 0;
  for (const p of probs) {
    if (p > 0) sum += Math.pow(p, q);
  }
  return (1 / (q - 1)) * (1 - sum);
}

// Approximate Entropy (自己マッチ含むSample Entropy)
export function approximateEntropy(values: number[], m: number = 2, r?: number): number {
  const n = values.length;
  if (n < m + 2) return 0;

  if (r === undefined) {
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
    r = 0.2 * std;
  }

  function phi(templateLen: number): number {
    let count = 0;
    let total = 0;
    for (let i = 0; i <= n - templateLen; i++) {
      let matches = 0;
      for (let j = 0; j <= n - templateLen; j++) {
        let match = true;
        for (let k = 0; k < templateLen; k++) {
          if (Math.abs(values[i + k] - values[j + k]) > r!) {
            match = false;
            break;
          }
        }
        if (match) matches++;
      }
      count += Math.log(matches / (n - templateLen + 1));
      total++;
    }
    return total > 0 ? count / total : 0;
  }

  return phi(m) - phi(m + 1);
}

// 重み付き順列エントロピー (振幅で重み付け)
export function weightedPermutationEntropy(values: number[], order: number = 3, delay: number = 1): number {
  const n = values.length;
  const patternWeights = new Map<string, number>();
  let totalWeight = 0;

  for (let i = 0; i <= n - (order - 1) * delay - 1; i++) {
    const indices: number[] = [];
    for (let j = 0; j < order; j++) indices.push(i + j * delay);
    const subseq = indices.map((idx) => values[idx]);

    // 振幅重み = 分散
    const mean = subseq.reduce((a, b) => a + b, 0) / order;
    const weight = subseq.reduce((a, v) => a + (v - mean) ** 2, 0) / order;

    const ranked = subseq
      .map((v, idx) => ({ v, idx }))
      .sort((a, b) => a.v - b.v)
      .map((item) => item.idx);
    const pattern = ranked.join(",");

    patternWeights.set(pattern, (patternWeights.get(pattern) || 0) + weight);
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;

  let entropy = 0;
  for (const w of patternWeights.values()) {
    const p = w / totalWeight;
    if (p > 0) entropy -= p * Math.log2(p);
  }

  const maxEntropy = Math.log2(factorial(order));
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

function factorial(n: number): number {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

// 条件付きエントロピー H(X|Y) = H(X,Y) - H(Y)
export function conditionalEntropy(x: number[], y: number[], bins: number = 16): number {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0;
  const { joint, margY } = makeJointDist(x.slice(0, n), y.slice(0, n), bins);

  let hJoint = 0;
  for (let i = 0; i < bins; i++) {
    for (let j = 0; j < bins; j++) {
      if (joint[i][j] > 0) hJoint -= joint[i][j] * Math.log2(joint[i][j]);
    }
  }

  let hY = 0;
  for (const p of margY) {
    if (p > 0) hY -= p * Math.log2(p);
  }

  return Math.max(0, hJoint - hY);
}

// エントロピー率: ブロック長kごとのH(k)/k
export function entropyRate(values: number[], maxBlock: number = 8, bins: number = 16): { blockSize: number; rate: number }[] {
  const result: { blockSize: number; rate: number }[] = [];
  const n = values.length;

  for (let k = 1; k <= maxBlock; k++) {
    if (n < k * 10) break;
    // ブロック化してシンボル列を作成
    const nBlocks = Math.floor(n / k);
    const blockValues: number[] = [];
    for (let i = 0; i < nBlocks; i++) {
      let sum = 0;
      for (let j = 0; j < k; j++) sum += values[i * k + j];
      blockValues.push(sum / k);
    }
    const h = shannonEntropy(blockValues, Math.min(bins, nBlocks));
    result.push({ blockSize: k, rate: h / k });
  }
  return result;
}

// 過剰エントロピー (Excess Entropy): 過去と未来の相互情報量
export function excessEntropy(values: number[], maxBlock: number = 8, bins: number = 16): number {
  const n = values.length;
  if (n < maxBlock * 4) return 0;

  const rates = entropyRate(values, maxBlock, bins);
  if (rates.length < 2) return 0;

  // E = Σ_{k=1}^{K} [h(k) - h_∞] where h_∞ is the limiting rate
  const hInf = rates[rates.length - 1].rate;
  let excess = 0;
  for (const r of rates) {
    excess += (r.rate - hInf) * r.blockSize;
  }
  return Math.max(0, excess);
}

// --- ローリング版 ---

export interface RollingPoint {
  time: string;
  value: number;
}

export function rollingRenyi(values: number[], times: string[], window: number = 60, alpha: number = 2): RollingPoint[] {
  const result: RollingPoint[] = [];
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    result.push({ time: times[i], value: renyiEntropy(slice, alpha) });
  }
  return result;
}

export function rollingTsallis(values: number[], times: string[], window: number = 60, q: number = 1.5): RollingPoint[] {
  const result: RollingPoint[] = [];
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    result.push({ time: times[i], value: tsallisEntropy(slice, q) });
  }
  return result;
}

export function rollingApEn(values: number[], times: string[], window: number = 60): RollingPoint[] {
  const result: RollingPoint[] = [];
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    result.push({ time: times[i], value: approximateEntropy(slice, 2) });
  }
  return result;
}

export function rollingWeightedPE(values: number[], times: string[], window: number = 60): RollingPoint[] {
  const result: RollingPoint[] = [];
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    result.push({ time: times[i], value: weightedPermutationEntropy(slice, 3, 1) });
  }
  return result;
}

export function rollingConditionalEntropy(x: number[], y: number[], times: string[], window: number = 60): RollingPoint[] {
  const result: RollingPoint[] = [];
  const n = Math.min(x.length, y.length);
  for (let i = window - 1; i < n; i++) {
    const sx = x.slice(i - window + 1, i + 1);
    const sy = y.slice(i - window + 1, i + 1);
    result.push({ time: times[i], value: conditionalEntropy(sx, sy) });
  }
  return result;
}
