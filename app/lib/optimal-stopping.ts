// Optimal Stopping Problem (最適停止問題)
// 後退帰納法 + Secretary Problem (1/e rule)

export interface OptimalStoppingResult {
  exerciseBoundary: number[];
  optimalSellIndex: number;
  expectedReturn: number;
  actualReturn: number;
  secretaryThreshold: number;
  secretaryPick: number;
  secretaryReturn: number;
  interpretation: string;
}

function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeOptimalStopping(
  prices: number[],
  discountRate: number = 0
): OptimalStoppingResult {
  const n = prices.length;
  const empty: OptimalStoppingResult = {
    exerciseBoundary: [],
    optimalSellIndex: -1,
    expectedReturn: 0,
    actualReturn: 0,
    secretaryThreshold: 0,
    secretaryPick: -1,
    secretaryReturn: 0,
    interpretation: "データが不足しています。",
  };
  if (n < 30) return empty;

  // 分析対象を直近N日に制限（計算量対策）
  const maxN = Math.min(n, 500);
  const startIdx = n - maxN;
  const p = prices.slice(startIdx);
  const N = p.length;
  const S0 = p[0];
  if (S0 <= 0) return empty;

  // 正規化価格
  const norm = p.map((v) => v / S0);

  // リターン分布の推定
  const returns: number[] = [];
  for (let i = 1; i < N; i++) {
    returns.push(Math.log(p[i] / p[i - 1]));
  }

  // --- 後退帰納法 ---
  // V(T) = S(T), V(t) = max(S(t), discount * E[V(t+1) | S(t)])
  // 継続価値はブートストラップで推定
  const rng = mulberry32(42);
  const nSim = 200;
  const dailyDiscount = 1 - discountRate / 252;

  // exerciseBoundary[t]: 時刻tで売るべき最低価格（正規化）
  const boundary = new Array(N).fill(0);
  const continuationValue = new Array(N).fill(0);

  // 終端: V(T) = S(T)
  boundary[N - 1] = 0; // 最終日は必ず売る
  continuationValue[N - 1] = norm[N - 1];

  // 後退帰納
  for (let t = N - 2; t >= 0; t--) {
    // 時刻tでの継続価値のモンテカルロ推定
    let sumCV = 0;
    for (let s = 0; s < nSim; s++) {
      // ブートストラップ: ランダムにリターンを選んで1ステップ進める
      const rIdx = Math.floor(rng() * returns.length);
      const nextPrice = norm[t] * Math.exp(returns[rIdx]);
      // 次の期の価値: max(nextPrice, continuationValue[t+1]の推定)
      // 簡易化: 次期のboundaryと比較
      const nextValue =
        nextPrice >= boundary[t + 1]
          ? nextPrice
          : dailyDiscount * continuationValue[t + 1] * (nextPrice / norm[t + 1] || 1);
      sumCV += nextValue;
    }
    const expectedCV = dailyDiscount * (sumCV / nSim);

    // 行使境界: 即時行使 >= 継続価値 となる最低価格
    boundary[t] = expectedCV;
    continuationValue[t] = Math.max(norm[t], expectedCV);
  }

  // 最適売却ポイント: 最初に価格が行使境界を超えた時点
  let optSellIdx = N - 1;
  for (let t = 0; t < N; t++) {
    if (norm[t] >= boundary[t] && t > 0) {
      optSellIdx = t;
      break;
    }
  }

  const expectedReturn = (norm[optSellIdx] - 1) * 100;
  const actualReturn = (norm[N - 1] - 1) * 100;

  // --- Secretary Problem (1/e rule) ---
  const observeN = Math.max(1, Math.floor(N / Math.E));
  let maxInObserve = -Infinity;
  for (let t = 0; t < observeN; t++) {
    if (norm[t] > maxInObserve) maxInObserve = norm[t];
  }

  let secPick = N - 1; // デフォルト: 最後
  for (let t = observeN; t < N; t++) {
    if (norm[t] > maxInObserve) {
      secPick = t;
      break;
    }
  }
  const secretaryReturn = (norm[secPick] - 1) * 100;

  // 行使境界を元の価格スケールに戻す
  const exerciseBoundary = boundary.map((b) => b * S0);

  // 解釈
  const peakIdx = norm.indexOf(Math.max(...norm));
  const peakReturn = (norm[peakIdx] - 1) * 100;

  let interpretation = `分析期間(${N}日): `;
  interpretation += `最適停止ルールでは${optSellIdx}日目（リターン${expectedReturn.toFixed(1)}%）が売却ポイント。`;
  interpretation += `Secretary法(観察${observeN}日)では${secPick}日目（${secretaryReturn.toFixed(1)}%）。`;
  interpretation += `実際のピークは${peakIdx}日目（${peakReturn.toFixed(1)}%）、`;
  interpretation += `バイ＆ホールドは${actualReturn.toFixed(1)}%でした。`;

  return {
    exerciseBoundary,
    optimalSellIndex: startIdx + optSellIdx,
    expectedReturn,
    actualReturn,
    secretaryThreshold: observeN,
    secretaryPick: startIdx + secPick,
    secretaryReturn,
    interpretation,
  };
}
