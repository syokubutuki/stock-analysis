// Topological Data Analysis (Persistent Homology) + Fisher-Rao Distance

// ---- Persistent Homology (Vietoris-Rips, 0th & 1st) ----

export interface PersistencePoint {
  birth: number;
  death: number;
  dimension: number;
  persistence: number; // death - birth
}

export interface TDAResult {
  diagram: PersistencePoint[];
  bettiCurve0: number[];  // β₀(ε) at sampled thresholds
  bettiCurve1: number[];  // β₁(ε) at sampled thresholds
  thresholds: number[];
  totalPersistence0: number;
  totalPersistence1: number;
  maxPersistence: number;
  interpretation: string;
}

export function computePersistentHomology(
  values: number[],
  embeddingDim: number = 3,
  tau: number = 1,
  maxPoints: number = 150
): TDAResult {
  const n = values.length;
  const nEmb = n - (embeddingDim - 1) * tau;
  if (nEmb < 20) return emptyTDA();

  // Takens embedding
  const step = Math.max(1, Math.floor(nEmb / maxPoints));
  const points: number[][] = [];
  for (let i = 0; i < nEmb; i += step) {
    const vec: number[] = [];
    for (let d = 0; d < embeddingDim; d++) vec.push(values[i + d * tau]);
    points.push(vec);
  }
  const np = points.length;

  // Distance matrix
  const dist: number[][] = Array.from({ length: np }, () => new Array(np).fill(0));
  let maxDist = 0;
  for (let i = 0; i < np; i++) {
    for (let j = i + 1; j < np; j++) {
      let d = 0;
      for (let k = 0; k < embeddingDim; k++) d += (points[i][k] - points[j][k]) ** 2;
      d = Math.sqrt(d);
      dist[i][j] = d;
      dist[j][i] = d;
      if (d > maxDist) maxDist = d;
    }
  }

  // Sorted edges
  const edges: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i < np; i++) {
    for (let j = i + 1; j < np; j++) {
      edges.push({ i, j, d: dist[i][j] });
    }
  }
  edges.sort((a, b) => a.d - b.d);

  // 0-dimensional persistence via Union-Find
  const parent = Array.from({ length: np }, (_, i) => i);
  const rank = new Array(np).fill(0);
  const birthTime = new Array(np).fill(0);

  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }

  const diagram: PersistencePoint[] = [];
  const nThresholds = 50;
  const thresholds = Array.from({ length: nThresholds }, (_, i) => (i / (nThresholds - 1)) * maxDist);
  const bettiCurve0: number[] = [];
  const bettiCurve1: number[] = [];

  let edgeIdx = 0;
  let components = np;

  // Track triangles for 1-dim
  const adjacency: Set<number>[] = Array.from({ length: np }, () => new Set());
  let numTriangles = 0;
  let numEdges = 0;

  for (let ti = 0; ti < nThresholds; ti++) {
    const eps = thresholds[ti];
    while (edgeIdx < edges.length && edges[edgeIdx].d <= eps) {
      const e = edges[edgeIdx];
      const ri = find(e.i);
      const rj = find(e.j);

      // Count new triangles before adding edge
      for (const k of adjacency[e.i]) {
        if (adjacency[e.j].has(k)) numTriangles++;
      }

      adjacency[e.i].add(e.j);
      adjacency[e.j].add(e.i);
      numEdges++;

      if (ri !== rj) {
        // Merge — smaller component dies
        const dying = rank[ri] < rank[rj] ? ri : rj;
        const surviving = dying === ri ? rj : ri;
        if (rank[ri] === rank[rj]) rank[surviving]++;
        parent[dying] = surviving;
        components--;

        if (e.d > 0) {
          diagram.push({
            birth: 0,
            death: e.d,
            dimension: 0,
            persistence: e.d,
          });
        }
      }
      edgeIdx++;
    }

    bettiCurve0.push(components);
    // Euler characteristic: β₀ - β₁ = V - E + T (approx)
    // β₁ ≈ E - V + β₀ (for simplicial complex, lower bound)
    const b1 = Math.max(0, numEdges - np + components);
    bettiCurve1.push(b1);
  }

  // Surviving component (the last one) has infinite death — record as maxDist
  diagram.push({ birth: 0, death: maxDist, dimension: 0, persistence: maxDist });

  // 1-dimensional features (approximate from Betti curve changes)
  for (let i = 1; i < bettiCurve1.length; i++) {
    if (bettiCurve1[i] > bettiCurve1[i - 1]) {
      // New loop born
      diagram.push({
        birth: thresholds[i],
        death: thresholds[Math.min(i + Math.floor(nThresholds * 0.2), nThresholds - 1)],
        dimension: 1,
        persistence: thresholds[Math.min(i + Math.floor(nThresholds * 0.2), nThresholds - 1)] - thresholds[i],
      });
    }
  }

  const dim0 = diagram.filter((p) => p.dimension === 0);
  const dim1 = diagram.filter((p) => p.dimension === 1);
  const totalPersistence0 = dim0.reduce((a, p) => a + p.persistence, 0);
  const totalPersistence1 = dim1.reduce((a, p) => a + p.persistence, 0);
  const maxPersistence = Math.max(...diagram.map((p) => p.persistence), 0);

  let interpretation: string;
  if (dim1.length > 5 && totalPersistence1 > totalPersistence0 * 0.1) {
    interpretation = "明確なループ構造あり — 周期的パターンが位相的に確認される";
  } else if (dim0.length > 3 && dim0.some((p) => p.persistence > maxDist * 0.3)) {
    interpretation = "クラスター構造あり — 離散的なレジームの存在を示唆";
  } else {
    interpretation = "顕著な位相的構造なし — ノイズ支配的な時系列";
  }

  return { diagram, bettiCurve0, bettiCurve1, thresholds, totalPersistence0, totalPersistence1, maxPersistence, interpretation };
}

function emptyTDA(): TDAResult {
  return {
    diagram: [], bettiCurve0: [], bettiCurve1: [], thresholds: [],
    totalPersistence0: 0, totalPersistence1: 0, maxPersistence: 0,
    interpretation: "データ不足",
  };
}

// ---- Fisher-Rao Distance ----

export interface FisherRaoResult {
  distances: number[];  // rolling distance between consecutive windows
  times: number[];      // center of each pair
  meanDistance: number;
  maxDistance: number;
  changePoints: number[]; // indices where distance spikes
}

export function fisherRaoDistance(
  values: number[],
  windowSize: number = 60,
  bins: number = 20
): FisherRaoResult {
  const n = values.length;
  const distances: number[] = [];
  const times: number[] = [];

  for (let t = windowSize; t + windowSize <= n; t++) {
    const w1 = values.slice(t - windowSize, t);
    const w2 = values.slice(t, t + windowSize);
    const d = hellingerDistance(w1, w2, bins);
    // Fisher-Rao distance = 2 * arccos(1 - H²/2) ≈ H for small H
    const frDist = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - d * d / 2)));
    distances.push(frDist);
    times.push(t);
  }

  const meanDistance = distances.length > 0
    ? distances.reduce((a, b) => a + b, 0) / distances.length : 0;
  const maxDistance = distances.length > 0 ? Math.max(...distances) : 0;

  // Detect spikes (> mean + 2σ)
  const std = Math.sqrt(
    distances.reduce((a, v) => a + (v - meanDistance) ** 2, 0) / (distances.length || 1)
  );
  const changePoints = times.filter((_, i) => distances[i] > meanDistance + 2 * std);

  return { distances, times, meanDistance, maxDistance, changePoints };
}

function hellingerDistance(x: number[], y: number[], bins: number): number {
  const xMin = Math.min(...x, ...y);
  const xMax = Math.max(...x, ...y);
  const range = xMax - xMin || 1;

  const histX = new Array(bins).fill(0);
  const histY = new Array(bins).fill(0);

  for (const v of x) {
    const b = Math.min(Math.floor(((v - xMin) / range) * bins), bins - 1);
    histX[b]++;
  }
  for (const v of y) {
    const b = Math.min(Math.floor(((v - xMin) / range) * bins), bins - 1);
    histY[b]++;
  }

  // Normalize to probability
  const nx = x.length, ny = y.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) {
    const px = histX[i] / nx;
    const py = histY[i] / ny;
    sum += (Math.sqrt(px) - Math.sqrt(py)) ** 2;
  }

  return Math.sqrt(sum / 2);
}
