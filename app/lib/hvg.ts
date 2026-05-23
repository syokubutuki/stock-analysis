// Horizontal Visibility Graph (HVG)

export interface HVGResult {
  degreeSeries: number[];
  degreeDistribution: { degree: number; count: number; logCount: number }[];
  meanDegree: number;
  lambda: number;            // exponential decay rate
  theoreticalLambda: number; // ln(3/2) ≈ 0.405 for random series
  isNonlinear: boolean;      // lambda significantly differs from theoretical
  clusteringCoeff: number;
}

export function computeHVG(values: number[], maxLookback: number = 100): HVGResult {
  const n = values.length;
  const adjacency: number[][] = Array.from({ length: n }, () => []);

  // HVG: i and j are connected if all intermediate values < min(v_i, v_j)
  for (let i = 0; i < n; i++) {
    const lookLimit = Math.min(i + maxLookback, n);
    for (let j = i + 1; j < lookLimit; j++) {
      const minVal = Math.min(values[i], values[j]);
      let visible = true;
      for (let k = i + 1; k < j; k++) {
        if (values[k] >= minVal) {
          visible = false;
          break;
        }
      }
      if (visible) {
        adjacency[i].push(j);
        adjacency[j].push(i);
      }
    }
  }

  // Degree series
  const degreeSeries = adjacency.map((neighbors) => neighbors.length);
  const meanDegree = degreeSeries.reduce((a, b) => a + b, 0) / n;

  // Degree distribution
  const maxDeg = Math.max(...degreeSeries);
  const degCounts = new Map<number, number>();
  for (const d of degreeSeries) {
    degCounts.set(d, (degCounts.get(d) || 0) + 1);
  }
  const degreeDistribution = Array.from(degCounts.entries())
    .map(([degree, count]) => ({
      degree,
      count: count / n,
      logCount: Math.log(count / n + 1e-20),
    }))
    .sort((a, b) => a.degree - b.degree);

  // Exponential fit: P(k) ~ exp(-lambda * k)
  const kVals = degreeDistribution.filter((d) => d.count > 0).map((d) => d.degree);
  const logP = degreeDistribution.filter((d) => d.count > 0).map((d) => d.logCount);
  const lambda = kVals.length > 2 ? -linearSlope(kVals, logP) : 0;
  const theoreticalLambda = Math.log(3 / 2);
  const isNonlinear = Math.abs(lambda - theoreticalLambda) > 0.1;

  // Clustering coefficient (local)
  let totalCC = 0;
  let countCC = 0;
  for (let i = 0; i < n; i++) {
    const neighbors = adjacency[i];
    const k = neighbors.length;
    if (k < 2) continue;
    let triangles = 0;
    const nSet = new Set(neighbors);
    for (let a = 0; a < neighbors.length; a++) {
      for (let b = a + 1; b < neighbors.length; b++) {
        if (nSet.has(neighbors[b]) && adjacency[neighbors[a]].includes(neighbors[b])) {
          // check if neighbors[a] and neighbors[b] are connected
          // Since adjacency stores full lists, check inclusion
        }
        // More efficient: check adjacency directly
        if (adjacency[neighbors[a]].includes(neighbors[b])) {
          triangles++;
        }
      }
    }
    totalCC += (2 * triangles) / (k * (k - 1));
    countCC++;
  }
  const clusteringCoeff = countCC > 0 ? totalCC / countCC : 0;

  return {
    degreeSeries,
    degreeDistribution,
    meanDegree,
    lambda,
    theoreticalLambda,
    isNonlinear,
    clusteringCoeff,
  };
}

function linearSlope(x: number[], y: number[]): number {
  const n = x.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i]; sxy += x[i] * y[i]; sxx += x[i] * x[i];
  }
  const denom = n * sxx - sx * sx;
  return denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
}
