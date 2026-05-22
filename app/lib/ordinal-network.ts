// Ordinal Pattern Transition Network

export interface OrdinalNode {
  pattern: string;
  count: number;
  frequency: number;
}

export interface OrdinalEdge {
  from: string;
  to: string;
  weight: number; // 遷移確率
  count: number;
}

export interface OrdinalNetworkData {
  nodes: OrdinalNode[];
  edges: OrdinalEdge[];
  transitionEntropy: number;
  selfTransitionRate: number;
  numForbiddenPatterns: number;
  totalPatterns: number; // order! が最大
}

// 順序パターンを文字列化
function getOrdinalPattern(values: number[]): string {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  return indexed.map((item) => item.i).join("");
}

// Ordinal Pattern Transition Network の構築
export function buildOrdinalNetwork(
  values: number[],
  order: number = 3,
  delay: number = 1
): OrdinalNetworkData {
  const n = values.length;
  const patterns: string[] = [];

  // 全パターンを抽出
  for (let i = 0; i <= n - (order - 1) * delay - 1; i++) {
    const indices: number[] = [];
    for (let j = 0; j < order; j++) {
      indices.push(i + j * delay);
    }
    const subseq = indices.map((idx) => values[idx]);
    patterns.push(getOrdinalPattern(subseq));
  }

  // ノード(パターン)のカウント
  const patternCounts = new Map<string, number>();
  for (const p of patterns) {
    patternCounts.set(p, (patternCounts.get(p) || 0) + 1);
  }

  // エッジ(遷移)のカウント
  const transitionCounts = new Map<string, number>();
  for (let i = 0; i < patterns.length - 1; i++) {
    const key = `${patterns[i]}->${patterns[i + 1]}`;
    transitionCounts.set(key, (transitionCounts.get(key) || 0) + 1);
  }

  const totalPatterns = patterns.length;

  // ノード
  const nodes: OrdinalNode[] = Array.from(patternCounts.entries()).map(
    ([pattern, count]) => ({
      pattern,
      count,
      frequency: count / totalPatterns,
    })
  );
  nodes.sort((a, b) => b.count - a.count);

  // エッジ (遷移確率)
  const edges: OrdinalEdge[] = [];
  for (const [key, count] of transitionCounts.entries()) {
    const [from, to] = key.split("->");
    const fromCount = patternCounts.get(from) || 1;
    edges.push({
      from,
      to,
      weight: count / fromCount,
      count,
    });
  }
  edges.sort((a, b) => b.count - a.count);

  // 遷移エントロピー
  let transitionEntropy = 0;
  const totalTransitions = patterns.length - 1;
  if (totalTransitions > 0) {
    for (const count of transitionCounts.values()) {
      const p = count / totalTransitions;
      if (p > 0) transitionEntropy -= p * Math.log2(p);
    }
  }

  // 自己遷移率
  let selfCount = 0;
  for (let i = 0; i < patterns.length - 1; i++) {
    if (patterns[i] === patterns[i + 1]) selfCount++;
  }
  const selfTransitionRate =
    totalTransitions > 0 ? selfCount / totalTransitions : 0;

  // 禁止パターン数 (order!から出現パターン数を引く)
  let factorial = 1;
  for (let i = 2; i <= order; i++) factorial *= i;
  const numForbiddenPatterns = factorial - patternCounts.size;

  return {
    nodes,
    edges,
    transitionEntropy,
    selfTransitionRate,
    numForbiddenPatterns,
    totalPatterns: factorial,
  };
}
