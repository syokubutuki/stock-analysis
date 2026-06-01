// 複雑度指標: Statistical Complexity, Lempel-Ziv, Kolmogorov近似, AIS, Predictability, InfoRatio

import { permutationEntropy } from "./entropy";
import { sampleEntropy } from "./entropy";
import { multiscaleEntropy } from "./multiscale-entropy";

// --- 順列分布ヘルパー ---
function getPermutationDistribution(values: number[], order: number, delay: number): Map<string, number> {
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

  // 正規化
  const dist = new Map<string, number>();
  for (const [k, v] of counts) dist.set(k, v / total);
  return dist;
}

function factorial(n: number): number {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

// Jensen-Shannon divergence
function jsDivergence(p: Map<string, number>, q: Map<string, number>): number {
  const allKeys = new Set([...p.keys(), ...q.keys()]);
  let div = 0;
  for (const k of allKeys) {
    const pk = p.get(k) || 0;
    const qk = q.get(k) || 0;
    const mk = (pk + qk) / 2;
    if (pk > 0 && mk > 0) div += pk * Math.log2(pk / mk) / 2;
    if (qk > 0 && mk > 0) div += qk * Math.log2(qk / mk) / 2;
  }
  return div;
}

// Statistical Complexity: C = H_JS(P, P_uniform) * PE_normalized
export function statisticalComplexity(values: number[], order: number = 3, delay: number = 1): number {
  const dist = getPermutationDistribution(values, order, delay);
  const nPerms = factorial(order);
  const pe = permutationEntropy(values, order, delay); // normalized 0-1

  // 一様分布
  const uniform = new Map<string, number>();
  for (const k of dist.keys()) uniform.set(k, 1 / nPerms);
  // 一様分布のキーが足りない場合を補完
  for (let i = 0; i < nPerms; i++) {
    // 全パターンを列挙する代わりにJSDに既存キーのみ使用
  }

  const qFactor = -1 / ((nPerms + 1) / nPerms * Math.log2((nPerms + 1) / 2) + Math.log2(nPerms));

  const jsd = jsDivergence(dist, uniform);
  return qFactor * jsd * pe;
}

export interface CEPlanePoint {
  time: string;
  pe: number;
  sc: number;
}

// ローリングCE平面軌跡
export function rollingCEPlane(values: number[], times: string[], order: number = 3, window: number = 60): CEPlanePoint[] {
  const result: CEPlanePoint[] = [];
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    const pe = permutationEntropy(slice, order, 1);
    const sc = statisticalComplexity(slice, order, 1);
    result.push({ time: times[i], pe, sc });
  }
  return result;
}

// Lempel-Ziv Complexity
export function lempelZivComplexity(values: number[]): number {
  if (values.length === 0) return 0;
  // バイナリ化: 中央値より大きければ1、そうでなければ0
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const binary = values.map((v) => (v > median ? "1" : "0")).join("");

  // LZ76アルゴリズム
  let complexity = 1;
  let i = 0;
  let l = 1;
  const n = binary.length;

  while (i + l <= n) {
    const substr = binary.substring(i, i + l);
    const searchRange = binary.substring(0, i + l - 1);
    if (searchRange.includes(substr)) {
      l++;
    } else {
      complexity++;
      i = i + l;
      l = 1;
    }
  }
  return complexity;
}

export function normalizedLZComplexity(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const c = lempelZivComplexity(values);
  const theoretical = n / Math.log2(n);
  return theoretical > 0 ? c / theoretical : 0;
}

// Kolmogorov複雑度近似 (ランレングス圧縮比)
export function kolmogorovApprox(values: number[], bins: number = 16): number {
  if (values.length === 0) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  // シンボル化
  const symbols = values.map((v) =>
    Math.min(Math.floor(((v - min) / range) * bins), bins - 1)
  );

  // ランレングスエンコーディング
  let compressed = 0;
  let i = 0;
  while (i < symbols.length) {
    const sym = symbols[i];
    let run = 1;
    while (i + run < symbols.length && symbols[i + run] === sym) run++;
    compressed++;
    i += run;
  }

  return compressed / symbols.length;
}

// Active Information Storage: MI(X_past; X_t)
export function activeInformationStorage(values: number[], k: number = 3, bins: number = 16): number {
  const n = values.length;
  if (n < k + 10) return 0;

  // 過去kステップの平均をX_pastとして使用
  const xPast: number[] = [];
  const xCurr: number[] = [];
  for (let i = k; i < n; i++) {
    let sum = 0;
    for (let j = 1; j <= k; j++) sum += values[i - j];
    xPast.push(sum / k);
    xCurr.push(values[i]);
  }

  return mutualInformationSimple(xPast, xCurr, bins);
}

function mutualInformationSimple(x: number[], y: number[], bins: number): number {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0;
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

  let mi = 0;
  for (let bx = 0; bx < bins; bx++) {
    for (let by = 0; by < bins; by++) {
      if (joint[bx][by] > 0 && margX[bx] > 0 && margY[by] > 0) {
        const pxy = joint[bx][by] / n;
        const px = margX[bx] / n;
        const py = margY[by] / n;
        mi += pxy * Math.log2(pxy / (px * py));
      }
    }
  }
  return Math.max(0, mi);
}

export interface RollingPoint {
  time: string;
  value: number;
}

export function rollingAIS(values: number[], times: string[], window: number = 60, k: number = 3): RollingPoint[] {
  const result: RollingPoint[] = [];
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    result.push({ time: times[i], value: activeInformationStorage(slice, k) });
  }
  return result;
}

// Predictability Index: 1 - normalized PE
export function predictabilityIndex(values: number[], order: number = 3, delay: number = 1): number {
  return 1 - permutationEntropy(values, order, delay);
}

export function rollingPredictability(values: number[], times: string[], window: number = 60): RollingPoint[] {
  const result: RollingPoint[] = [];
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    result.push({ time: times[i], value: predictabilityIndex(slice) });
  }
  return result;
}

// Information Ratio of Scales: 短期MSE / 長期MSE
export function infoRatioOfScales(
  values: number[],
  shortScales: number[] = [1, 2, 3],
  longScales: number[] = [8, 10, 12]
): number {
  const mse = multiscaleEntropy(values, Math.max(...longScales) + 1, 2);
  if (mse.length === 0) return 1;

  const mseMap = new Map(mse.map((m) => [m.scale, m.entropy]));

  let shortSum = 0, shortCount = 0;
  for (const s of shortScales) {
    const v = mseMap.get(s);
    if (v !== undefined && isFinite(v)) { shortSum += v; shortCount++; }
  }

  let longSum = 0, longCount = 0;
  for (const s of longScales) {
    const v = mseMap.get(s);
    if (v !== undefined && isFinite(v)) { longSum += v; longCount++; }
  }

  if (shortCount === 0 || longCount === 0 || longSum === 0) return 1;
  return (shortSum / shortCount) / (longSum / longCount);
}

export function rollingInfoRatio(values: number[], times: string[], window: number = 120): RollingPoint[] {
  const result: RollingPoint[] = [];
  const step = 5;
  for (let i = window - 1; i < values.length; i += step) {
    const slice = values.slice(i - window + 1, i + 1);
    result.push({ time: times[i], value: infoRatioOfScales(slice) });
  }
  return result;
}
