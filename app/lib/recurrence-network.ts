// Recurrence Network — リカレンスプロットの隣接行列をグラフとして解析

export interface RecurrenceNetworkResult {
  degreeDistribution: { degree: number; prob: number }[];
  clusteringCoeff: number;
  transitivity: number;
  avgPathLength: number;
  degreeSeries: number[];     // 各時点の次数
  localClustering: number[];  // 各時点の局所クラスタリング係数
  communityLabels: number[];  // 簡易コミュニティ検出
  numCommunities: number;
}

export function computeRecurrenceNetwork(
  values: number[],
  embeddingDim: number = 3,
  tau: number = 1,
  recurrenceRate: number = 0.05
): RecurrenceNetworkResult {
  const n = values.length;
  const nEmb = n - (embeddingDim - 1) * tau;
  if (nEmb < 20) {
    return emptyResult(n);
  }

  // Takens embedding
  const embedded: number[][] = [];
  for (let i = 0; i < nEmb; i++) {
    const vec: number[] = [];
    for (let d = 0; d < embeddingDim; d++) vec.push(values[i + d * tau]);
    embedded.push(vec);
  }

  // Compute distances, find threshold for desired recurrence rate
  const maxSample = Math.min(nEmb, 250);
  const step = Math.max(1, Math.floor(nEmb / maxSample));
  const indices = Array.from({ length: nEmb }, (_, i) => i).filter((i) => i % step === 0);
  const np = indices.length;

  const allDists: number[] = [];
  for (let ii = 0; ii < np; ii++) {
    for (let jj = ii + 1; jj < np; jj++) {
      const i = indices[ii], j = indices[jj];
      let d = 0;
      for (let k = 0; k < embeddingDim; k++) d += (embedded[i][k] - embedded[j][k]) ** 2;
      allDists.push(Math.sqrt(d));
    }
  }
  allDists.sort((a, b) => a - b);
  const threshold = allDists[Math.floor(allDists.length * recurrenceRate)] || allDists[allDists.length - 1];

  // Build adjacency (sampled)
  const adjacency: Set<number>[] = Array.from({ length: np }, () => new Set());
  for (let ii = 0; ii < np; ii++) {
    for (let jj = ii + 1; jj < np; jj++) {
      const i = indices[ii], j = indices[jj];
      let d = 0;
      for (let k = 0; k < embeddingDim; k++) d += (embedded[i][k] - embedded[j][k]) ** 2;
      if (Math.sqrt(d) < threshold) {
        adjacency[ii].add(jj);
        adjacency[jj].add(ii);
      }
    }
  }

  // Degree series
  const degreeSeries = adjacency.map((s) => s.size);
  const maxDeg = Math.max(...degreeSeries, 1);

  // Degree distribution
  const degCounts = new Map<number, number>();
  for (const d of degreeSeries) degCounts.set(d, (degCounts.get(d) || 0) + 1);
  const degreeDistribution = Array.from(degCounts.entries())
    .map(([degree, count]) => ({ degree, prob: count / np }))
    .sort((a, b) => a.degree - b.degree);

  // Local clustering coefficient
  const localClustering: number[] = [];
  let totalCC = 0;
  for (let i = 0; i < np; i++) {
    const neighbors = Array.from(adjacency[i]);
    const k = neighbors.length;
    if (k < 2) { localClustering.push(0); continue; }
    let triangles = 0;
    for (let a = 0; a < neighbors.length; a++) {
      for (let b = a + 1; b < neighbors.length; b++) {
        if (adjacency[neighbors[a]].has(neighbors[b])) triangles++;
      }
    }
    const cc = (2 * triangles) / (k * (k - 1));
    localClustering.push(cc);
    totalCC += cc;
  }
  const clusteringCoeff = totalCC / np;

  // Transitivity (global)
  let totalTriangles = 0, totalTriples = 0;
  for (let i = 0; i < np; i++) {
    const k = degreeSeries[i];
    totalTriples += k * (k - 1) / 2;
    const neighbors = Array.from(adjacency[i]);
    for (let a = 0; a < neighbors.length; a++) {
      for (let b = a + 1; b < neighbors.length; b++) {
        if (adjacency[neighbors[a]].has(neighbors[b])) totalTriangles++;
      }
    }
  }
  const transitivity = totalTriples > 0 ? totalTriangles / totalTriples : 0;

  // Average path length (BFS, sampled)
  const sampleSize = Math.min(np, 30);
  let totalPath = 0, pathCount = 0;
  for (let start = 0; start < sampleSize; start++) {
    const dist = bfs(adjacency, start, np);
    for (const d of dist) {
      if (d > 0 && d < Infinity) { totalPath += d; pathCount++; }
    }
  }
  const avgPathLength = pathCount > 0 ? totalPath / pathCount : 0;

  // Simple community detection (label propagation)
  const communityLabels = labelPropagation(adjacency, np);
  const numCommunities = new Set(communityLabels).size;

  // Map back to full time series
  const fullDegree = new Array(n).fill(0);
  const fullClustering = new Array(n).fill(0);
  const fullCommunity = new Array(n).fill(0);
  for (let ii = 0; ii < np; ii++) {
    const origIdx = indices[ii];
    fullDegree[origIdx] = degreeSeries[ii];
    fullClustering[origIdx] = localClustering[ii];
    fullCommunity[origIdx] = communityLabels[ii];
  }

  return {
    degreeDistribution,
    clusteringCoeff,
    transitivity,
    avgPathLength,
    degreeSeries: fullDegree,
    localClustering: fullClustering,
    communityLabels: fullCommunity,
    numCommunities,
  };
}

function bfs(adj: Set<number>[], start: number, n: number): number[] {
  const dist = new Array(n).fill(Infinity);
  dist[start] = 0;
  const queue = [start];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    for (const v of adj[u]) {
      if (dist[v] === Infinity) {
        dist[v] = dist[u] + 1;
        queue.push(v);
      }
    }
  }
  return dist;
}

function labelPropagation(adj: Set<number>[], n: number): number[] {
  const labels = Array.from({ length: n }, (_, i) => i);
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const neighbors = Array.from(adj[i]);
      if (neighbors.length === 0) continue;
      const counts = new Map<number, number>();
      for (const nb of neighbors) {
        counts.set(labels[nb], (counts.get(labels[nb]) || 0) + 1);
      }
      let maxLabel = labels[i], maxCount = 0;
      for (const [label, count] of counts) {
        if (count > maxCount) { maxCount = count; maxLabel = label; }
      }
      if (maxLabel !== labels[i]) { labels[i] = maxLabel; changed = true; }
    }
    if (!changed) break;
  }
  // Renumber labels to 0, 1, 2, ...
  const labelMap = new Map<number, number>();
  let nextId = 0;
  return labels.map((l) => {
    if (!labelMap.has(l)) labelMap.set(l, nextId++);
    return labelMap.get(l)!;
  });
}

function emptyResult(n: number): RecurrenceNetworkResult {
  return {
    degreeDistribution: [],
    clusteringCoeff: 0,
    transitivity: 0,
    avgPathLength: 0,
    degreeSeries: new Array(n).fill(0),
    localClustering: new Array(n).fill(0),
    communityLabels: new Array(n).fill(0),
    numCommunities: 0,
  };
}
