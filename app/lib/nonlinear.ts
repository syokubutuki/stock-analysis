// 非線形動力学: Takens埋め込み、Recurrence Plot、Lyapunov指数

export interface EmbeddingPoint {
  x: number;
  y: number;
  z?: number;
  time: string;
}

// Takens埋め込みによる位相空間再構成
// (r_t, r_{t-τ}, r_{t-2τ}, ...)
export function takensEmbedding(
  values: number[],
  times: string[],
  tau: number = 1,
  dim: number = 3
): EmbeddingPoint[] {
  const result: EmbeddingPoint[] = [];
  const start = (dim - 1) * tau;
  for (let i = start; i < values.length; i++) {
    const point: EmbeddingPoint = {
      x: values[i],
      y: values[i - tau],
      time: times[i],
    };
    if (dim >= 3) {
      point.z = values[i - 2 * tau];
    }
    result.push(point);
  }
  return result;
}

// Recurrence Plot用の距離行列
// 戻り値: n x n の Uint8Array (1 = recurrence, 0 = not)
export interface RecurrencePlotData {
  matrix: Uint8Array; // n*n の flat array
  n: number;
  recurrenceRate: number;
  determinism: number;
  laminarity: number;      // 垂直線構造の割合
  trappingTime: number;    // 平均滞留時間
  diagEntropy: number;     // 対角線長のShannon Entropy
  maxDiagLength: number;   // 最長対角線
  maxVertLength: number;   // 最長垂直線
}

export function computeRecurrencePlot(
  values: number[],
  tau: number = 1,
  dim: number = 3,
  threshold?: number
): RecurrencePlotData {
  const n = values.length - (dim - 1) * tau;
  if (n <= 0) {
    return { matrix: new Uint8Array(0), n: 0, recurrenceRate: 0, determinism: 0, laminarity: 0, trappingTime: 0, diagEntropy: 0, maxDiagLength: 0, maxVertLength: 0 };
  }

  // 埋め込みベクトルの生成
  const vectors: number[][] = [];
  for (let i = 0; i < n; i++) {
    const vec: number[] = [];
    for (let d = 0; d < dim; d++) {
      vec.push(values[i + d * tau]);
    }
    vectors.push(vec);
  }

  // しきい値の自動決定: 全距離の10パーセンタイル
  if (threshold === undefined) {
    const distances: number[] = [];
    const sampleSize = Math.min(n, 200);
    const step = Math.max(1, Math.floor(n / sampleSize));
    for (let i = 0; i < n; i += step) {
      for (let j = i + 1; j < n; j += step) {
        let d = 0;
        for (let k = 0; k < dim; k++) {
          d += (vectors[i][k] - vectors[j][k]) ** 2;
        }
        distances.push(Math.sqrt(d));
      }
    }
    distances.sort((a, b) => a - b);
    threshold = distances[Math.floor(distances.length * 0.1)] || 1;
  }

  // サイズ制限 (パフォーマンス)
  const maxN = Math.min(n, 500);
  const stride = Math.max(1, Math.floor(n / maxN));
  const effectiveN = Math.ceil(n / stride);

  const matrix = new Uint8Array(effectiveN * effectiveN);
  let recurrenceCount = 0;

  for (let i = 0; i < effectiveN; i++) {
    const ii = i * stride;
    for (let j = 0; j < effectiveN; j++) {
      const jj = j * stride;
      let d = 0;
      for (let k = 0; k < dim; k++) {
        d += (vectors[ii][k] - vectors[jj][k]) ** 2;
      }
      if (Math.sqrt(d) < threshold) {
        matrix[i * effectiveN + j] = 1;
        recurrenceCount++;
      }
    }
  }

  const total = effectiveN * effectiveN;
  const recurrenceRate = recurrenceCount / total;

  // 対角線長の分布を計算
  const diagLengths: number[] = [];
  for (let offset = 1; offset < effectiveN; offset++) {
    let len = 0;
    for (let i = 0; i < effectiveN - offset; i++) {
      if (matrix[i * effectiveN + (i + offset)] === 1) {
        len++;
      } else {
        if (len > 0) diagLengths.push(len);
        len = 0;
      }
    }
    if (len > 0) diagLengths.push(len);
  }

  const diagPointsInLines = diagLengths.filter(l => l >= 2).reduce((a, l) => a + l, 0);
  const totalDiagRecurrence = diagLengths.reduce((a, l) => a + l, 0);
  const determinism = totalDiagRecurrence > 0 ? diagPointsInLines / totalDiagRecurrence : 0;
  const maxDiagLength = diagLengths.length > 0 ? Math.max(...diagLengths) : 0;

  // 対角線長のエントロピー
  const diagLenCounts = new Map<number, number>();
  for (const l of diagLengths.filter(l => l >= 2)) {
    diagLenCounts.set(l, (diagLenCounts.get(l) || 0) + 1);
  }
  let diagEntropy = 0;
  const totalDiagLines = diagLengths.filter(l => l >= 2).length;
  if (totalDiagLines > 0) {
    for (const count of diagLenCounts.values()) {
      const p = count / totalDiagLines;
      if (p > 0) diagEntropy -= p * Math.log(p);
    }
  }

  // 垂直線の分布 (Laminarity, Trapping Time)
  const vertLengths: number[] = [];
  for (let col = 0; col < effectiveN; col++) {
    let len = 0;
    for (let row = 0; row < effectiveN; row++) {
      if (matrix[row * effectiveN + col] === 1) {
        len++;
      } else {
        if (len > 0) vertLengths.push(len);
        len = 0;
      }
    }
    if (len > 0) vertLengths.push(len);
  }

  const vertPointsInLines = vertLengths.filter(l => l >= 2).reduce((a, l) => a + l, 0);
  const totalVertPoints = vertLengths.reduce((a, l) => a + l, 0);
  const laminarity = totalVertPoints > 0 ? vertPointsInLines / totalVertPoints : 0;
  const vertLinesOnly = vertLengths.filter(l => l >= 2);
  const trappingTime = vertLinesOnly.length > 0
    ? vertLinesOnly.reduce((a, l) => a + l, 0) / vertLinesOnly.length : 0;
  const maxVertLength = vertLengths.length > 0 ? Math.max(...vertLengths) : 0;

  return { matrix, n: effectiveN, recurrenceRate, determinism, laminarity, trappingTime, diagEntropy, maxDiagLength, maxVertLength };
}

// 最大Lyapunov指数の推定
export function estimateLyapunov(
  values: number[],
  tau: number = 1,
  dim: number = 3,
  steps: number = 10
): { exponent: number; divergence: number[] } {
  const n = values.length - (dim - 1) * tau;
  if (n < 20) return { exponent: 0, divergence: [] };

  const vectors: number[][] = [];
  for (let i = 0; i < n; i++) {
    const vec: number[] = [];
    for (let d = 0; d < dim; d++) {
      vec.push(values[i + d * tau]);
    }
    vectors.push(vec);
  }

  const maxSteps = Math.min(steps, Math.floor(n / 2));
  const divergence = new Array<number>(maxSteps).fill(0);
  const counts = new Array<number>(maxSteps).fill(0);

  // 各点について最近傍を探し、時間発展に伴う距離の変化を追跡
  for (let i = 0; i < n - maxSteps; i++) {
    let minDist = Infinity;
    let nearestIdx = -1;
    for (let j = 0; j < n - maxSteps; j++) {
      if (Math.abs(i - j) < dim * tau + 1) continue; // 時間的に近い点は除外
      let d = 0;
      for (let k = 0; k < dim; k++) {
        d += (vectors[i][k] - vectors[j][k]) ** 2;
      }
      d = Math.sqrt(d);
      if (d < minDist && d > 1e-10) {
        minDist = d;
        nearestIdx = j;
      }
    }
    if (nearestIdx < 0) continue;

    for (let s = 0; s < maxSteps; s++) {
      if (i + s >= n || nearestIdx + s >= n) break;
      let d = 0;
      for (let k = 0; k < dim; k++) {
        d += (vectors[i + s][k] - vectors[nearestIdx + s][k]) ** 2;
      }
      d = Math.sqrt(d);
      if (d > 1e-10) {
        divergence[s] += Math.log(d);
        counts[s]++;
      }
    }
  }

  for (let s = 0; s < maxSteps; s++) {
    if (counts[s] > 0) divergence[s] /= counts[s];
  }

  // 傾きからLyapunov指数を推定
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  let validN = 0;
  for (let s = 1; s < maxSteps; s++) {
    if (counts[s] > 0) {
      sumX += s;
      sumY += divergence[s];
      sumXY += s * divergence[s];
      sumX2 += s * s;
      validN++;
    }
  }

  const exponent =
    validN > 1
      ? (validN * sumXY - sumX * sumY) / (validN * sumX2 - sumX * sumX)
      : 0;

  return { exponent, divergence };
}
