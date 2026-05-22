// Visibility Graph: 時系列 → ネットワーク変換

export interface VGMetrics {
  numNodes: number;
  numEdges: number;
  avgDegree: number;
  maxDegree: number;
  clusteringCoefficient: number;
  degreeDistribution: { degree: number; count: number; ratio: number }[];
  powerLawExponent: number; // 次数分布のべき乗則指数
  degreeSeries: { time: string; degree: number }[]; // 各時点の次数
}

// Natural Visibility Graph
// 2点 (i, y_i) と (j, y_j) が可視 ⇔ 中間の全てのk について
// y_k < y_i + (y_j - y_i) * (k - i) / (j - i)
export function computeVisibilityGraph(
  values: number[],
  times: string[],
  maxLookback: number = 100
): VGMetrics {
  const n = values.length;
  if (n < 3) {
    return {
      numNodes: n,
      numEdges: 0,
      avgDegree: 0,
      maxDegree: 0,
      clusteringCoefficient: 0,
      degreeDistribution: [],
      powerLawExponent: 0,
      degreeSeries: [],
    };
  }

  // 隣接リスト
  const adj: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  let numEdges = 0;

  for (let i = 0; i < n; i++) {
    const limit = Math.min(i + maxLookback, n);
    for (let j = i + 1; j < limit; j++) {
      let visible = true;
      for (let k = i + 1; k < j; k++) {
        const interpolated =
          values[i] + ((values[j] - values[i]) * (k - i)) / (j - i);
        if (values[k] >= interpolated) {
          visible = false;
          break;
        }
      }
      if (visible) {
        adj[i].add(j);
        adj[j].add(i);
        numEdges++;
      }
    }
  }

  // 次数
  const degrees = adj.map((s) => s.size);
  const maxDegree = Math.max(...degrees);
  const avgDegree = degrees.reduce((a, b) => a + b, 0) / n;

  // 次数分布
  const degreeCounts = new Map<number, number>();
  for (const d of degrees) {
    degreeCounts.set(d, (degreeCounts.get(d) || 0) + 1);
  }
  const degreeDistribution = Array.from(degreeCounts.entries())
    .map(([degree, count]) => ({ degree, count, ratio: count / n }))
    .sort((a, b) => a.degree - b.degree);

  // クラスタ係数
  let totalCC = 0;
  let ccCount = 0;
  for (let i = 0; i < n; i++) {
    const neighbors = Array.from(adj[i]);
    const k = neighbors.length;
    if (k < 2) continue;
    let triangles = 0;
    for (let a = 0; a < k; a++) {
      for (let b = a + 1; b < k; b++) {
        if (adj[neighbors[a]].has(neighbors[b])) {
          triangles++;
        }
      }
    }
    totalCC += (2 * triangles) / (k * (k - 1));
    ccCount++;
  }
  const clusteringCoefficient = ccCount > 0 ? totalCC / ccCount : 0;

  // べき乗則指数の推定 (log-logの傾き)
  const nonZeroDist = degreeDistribution.filter((d) => d.degree > 0 && d.ratio > 0);
  let powerLawExponent = 0;
  if (nonZeroDist.length >= 3) {
    const logK = nonZeroDist.map((d) => Math.log10(d.degree));
    const logP = nonZeroDist.map((d) => Math.log10(d.ratio));
    const nPts = logK.length;
    const sumX = logK.reduce((a, b) => a + b, 0);
    const sumY = logP.reduce((a, b) => a + b, 0);
    const sumXY = logK.reduce((a, x, i) => a + x * logP[i], 0);
    const sumX2 = logK.reduce((a, x) => a + x * x, 0);
    powerLawExponent = -(nPts * sumXY - sumX * sumY) / (nPts * sumX2 - sumX * sumX);
  }

  const degreeSeries = degrees.map((d, i) => ({
    time: times[i],
    degree: d,
  }));

  return {
    numNodes: n,
    numEdges,
    avgDegree,
    maxDegree,
    clusteringCoefficient,
    degreeDistribution,
    powerLawExponent,
    degreeSeries,
  };
}
