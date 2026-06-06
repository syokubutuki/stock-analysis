// スケール・変換系

export interface TimeValue {
  time: string;
  value: number;
}

// 対数差分(ログリターン): ln(P_t / P_{t-1})
export function logReturns(closes: number[]): number[] {
  const result: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] <= 0 || closes[i] <= 0) {
      result.push(0);
    } else {
      result.push(Math.log(closes[i] / closes[i - 1]));
    }
  }
  return result;
}

// 順位変換(ランク化) — 値を0〜1のランクに変換
export function rankTransform(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(n);
  for (let r = 0; r < n; r++) {
    ranks[indexed[r].i] = (r + 1) / n;
  }
  return ranks;
}

// ボラティリティ正規化リターン: r_t / σ_t
// σ_t は直近 window 期間の標準偏差
export function volNormalizedReturns(
  closes: number[],
  window: number = 20
): number[] {
  const lr = logReturns(closes);
  const result: number[] = [];
  for (let i = 0; i < lr.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = lr.slice(start, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance =
      slice.reduce((a, v) => a + (v - mean) ** 2, 0) / slice.length;
    const sigma = Math.sqrt(variance);
    result.push(sigma > 1e-10 ? lr[i] / sigma : 0);
  }
  return result;
}

// 累積ログリターン（リターンの積み上げ）
export function cumulativeLogReturns(closes: number[]): number[] {
  const lr = logReturns(closes);
  const result: number[] = [0];
  let sum = 0;
  for (const r of lr) {
    sum += r;
    result.push(sum);
  }
  return result;
}

// 差分変換（1次・2次）
export function differencing(values: number[], order: number = 1): number[] {
  let result = values.slice();
  for (let d = 0; d < order; d++) {
    const next: number[] = [];
    for (let i = 1; i < result.length; i++) {
      next.push(result[i] - result[i - 1]);
    }
    result = next;
  }
  return result;
}

// Box-Cox変換: λ=0 → ln(x), λ≠0 → (x^λ - 1)/λ
export function boxCoxTransform(values: number[], lambda: number = 0.5): number[] {
  return values.map((v) => {
    if (v <= 0) return 0;
    if (Math.abs(lambda) < 1e-10) return Math.log(v);
    return (Math.pow(v, lambda) - 1) / lambda;
  });
}

// ドローダウン: ピークからの下落率
export function drawdown(values: number[]): number[] {
  if (values.length === 0) return [];
  let peak = values[0];
  return values.map((v) => {
    if (v > peak) peak = v;
    return peak > 0 ? (v - peak) / peak : 0;
  });
}

// ローリングZスコア: (x_t - μ_w) / σ_w
export function rollingZScore(values: number[], window: number = 60): number[] {
  return values.map((v, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, x) => a + (x - mean) ** 2, 0) / slice.length;
    const sigma = Math.sqrt(variance);
    return sigma > 1e-10 ? (v - mean) / sigma : 0;
  });
}
