// 情報理論系エントロピー

// Shannonエントロピー (ヒストグラムベース)
export function shannonEntropy(values: number[], bins: number = 20): number {
  if (values.length === 0) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) return 0;

  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(Math.floor(((v - min) / range) * bins), bins - 1);
    counts[idx]++;
  }

  let entropy = 0;
  const n = values.length;
  for (const c of counts) {
    if (c > 0) {
      const p = c / n;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

// Permutation Entropy (順序パターンエントロピー)
export function permutationEntropy(
  values: number[],
  order: number = 3,
  delay: number = 1
): number {
  const n = values.length;
  const patternCounts = new Map<string, number>();
  let totalPatterns = 0;

  for (let i = 0; i <= n - (order - 1) * delay - 1; i++) {
    // 遅延座標からパターンを取得
    const indices: number[] = [];
    for (let j = 0; j < order; j++) {
      indices.push(i + j * delay);
    }
    const subseq = indices.map((idx) => values[idx]);

    // ランク(順列パターン)を求める
    const ranked = subseq
      .map((v, idx) => ({ v, idx }))
      .sort((a, b) => a.v - b.v)
      .map((item) => item.idx);

    const pattern = ranked.join(",");
    patternCounts.set(pattern, (patternCounts.get(pattern) || 0) + 1);
    totalPatterns++;
  }

  if (totalPatterns === 0) return 0;

  let entropy = 0;
  for (const count of patternCounts.values()) {
    const p = count / totalPatterns;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  // 正規化 (0〜1)
  const maxEntropy = Math.log2(factorial(order));
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

function factorial(n: number): number {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

// Sample Entropy (サンプルエントロピー)
export function sampleEntropy(
  values: number[],
  m: number = 2,
  r?: number
): number {
  const n = values.length;
  if (n < m + 2) return 0;

  // しきい値: デフォルトは標準偏差の0.2倍
  if (r === undefined) {
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(
      values.reduce((a, v) => a + (v - mean) ** 2, 0) / n
    );
    r = 0.2 * std;
  }

  function countMatches(templateLen: number): number {
    let count = 0;
    for (let i = 0; i < n - templateLen; i++) {
      for (let j = i + 1; j < n - templateLen; j++) {
        let match = true;
        for (let k = 0; k < templateLen; k++) {
          if (Math.abs(values[i + k] - values[j + k]) > r!) {
            match = false;
            break;
          }
        }
        if (match) count++;
      }
    }
    return count;
  }

  const A = countMatches(m + 1);
  const B = countMatches(m);

  if (B === 0) return 0;
  return -Math.log(A / B);
}

// エントロピーの時系列推移（ローリング）
export interface RollingEntropy {
  time: string;
  shannon: number;
  permutation: number;
}

export function rollingEntropy(
  values: number[],
  times: string[],
  window: number = 60
): RollingEntropy[] {
  const result: RollingEntropy[] = [];
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    result.push({
      time: times[i],
      shannon: shannonEntropy(slice),
      permutation: permutationEntropy(slice, 3, 1),
    });
  }
  return result;
}
