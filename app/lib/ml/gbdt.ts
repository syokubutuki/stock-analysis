/** Gradient Boosted Decision Trees (純TypeScript実装) */

function sigmoid(x: number): number {
  if (x > 30) return 1;
  if (x < -30) return 0;
  return 1 / (1 + Math.exp(-x));
}

// ── 回帰決定木 (CART) ──────────────────────────────

interface TreeNode {
  feature: number;
  threshold: number;
  left: TreeNode | null;
  right: TreeNode | null;
  value: number;
}

class DecisionTree {
  private root: TreeNode | null = null;
  readonly gains = new Map<number, number>();

  constructor(
    private maxDepth: number,
    private minSamplesLeaf: number,
  ) {}

  fit(X: number[][], y: number[]): void {
    this.gains.clear();
    const indices = Array.from({ length: y.length }, (_, i) => i);
    this.root = this.build(X, y, indices, 0);
  }

  predict(x: number[]): number {
    let n = this.root!;
    while (n.left !== null) {
      n = x[n.feature] <= n.threshold ? n.left : n.right!;
    }
    return n.value;
  }

  private build(
    X: number[][],
    y: number[],
    idx: number[],
    depth: number,
  ): TreeNode {
    const n = idx.length;
    let totalSum = 0;
    let totalSumSq = 0;
    for (const i of idx) {
      totalSum += y[i];
      totalSumSq += y[i] * y[i];
    }
    const mean = totalSum / n;
    const leaf: TreeNode = { feature: -1, threshold: 0, left: null, right: null, value: mean };

    if (depth >= this.maxDepth || n < 2 * this.minSamplesLeaf) return leaf;

    const totalVar = totalSumSq / n - (totalSum / n) ** 2;
    if (totalVar < 1e-12) return leaf;

    let bestGain = 0;
    let bestFeature = -1;
    let bestThreshold = 0;

    const nFeatures = X[0].length;
    for (let f = 0; f < nFeatures; f++) {
      const sorted = [...idx].sort((a, b) => X[a][f] - X[b][f]);
      let leftSum = 0;
      let leftSumSq = 0;

      for (let k = 0; k < sorted.length - 1; k++) {
        const si = sorted[k];
        leftSum += y[si];
        leftSumSq += y[si] * y[si];
        const leftN = k + 1;

        if (leftN < this.minSamplesLeaf || n - leftN < this.minSamplesLeaf) continue;
        if (X[sorted[k]][f] === X[sorted[k + 1]][f]) continue;

        const rightSum = totalSum - leftSum;
        const rightSumSq = totalSumSq - leftSumSq;
        const rightN = n - leftN;

        const leftVar = leftSumSq / leftN - (leftSum / leftN) ** 2;
        const rightVar = rightSumSq / rightN - (rightSum / rightN) ** 2;
        const gain = totalVar - (leftN / n) * leftVar - (rightN / n) * rightVar;

        if (gain > bestGain) {
          bestGain = gain;
          bestFeature = f;
          bestThreshold = (X[sorted[k]][f] + X[sorted[k + 1]][f]) / 2;
        }
      }
    }

    if (bestFeature === -1) return leaf;

    this.gains.set(bestFeature, (this.gains.get(bestFeature) || 0) + bestGain * n);

    const leftIdx: number[] = [];
    const rightIdx: number[] = [];
    for (const i of idx) {
      if (X[i][bestFeature] <= bestThreshold) leftIdx.push(i);
      else rightIdx.push(i);
    }

    return {
      feature: bestFeature,
      threshold: bestThreshold,
      left: this.build(X, y, leftIdx, depth + 1),
      right: this.build(X, y, rightIdx, depth + 1),
      value: mean,
    };
  }
}

// ── GBDT (二値分類) ────────────────────────────────

export interface GBDTParams {
  nEstimators: number;
  learningRate: number;
  maxDepth: number;
  minSamplesLeaf: number;
}

export const DEFAULT_GBDT_PARAMS: GBDTParams = {
  nEstimators: 30,
  learningRate: 0.1,
  maxDepth: 3,
  minSamplesLeaf: 5,
};

export class GBDT {
  private trees: DecisionTree[] = [];
  private initScore = 0;
  private nFeatures = 0;
  private featureGains: number[] = [];

  constructor(private params: GBDTParams = DEFAULT_GBDT_PARAMS) {}

  fit(X: number[][], y: number[]): void {
    const n = y.length;
    this.nFeatures = X[0].length;
    this.featureGains = new Array(this.nFeatures).fill(0);
    this.trees = [];

    const posCount = y.reduce((a, b) => a + b, 0);
    const negCount = n - posCount;
    this.initScore = Math.log((posCount + 1e-10) / (negCount + 1e-10));

    const F = new Float64Array(n).fill(this.initScore);

    for (let m = 0; m < this.params.nEstimators; m++) {
      const residuals = new Array<number>(n);
      for (let i = 0; i < n; i++) {
        residuals[i] = y[i] - sigmoid(F[i]);
      }

      const tree = new DecisionTree(this.params.maxDepth, this.params.minSamplesLeaf);
      tree.fit(X, residuals);

      for (let i = 0; i < n; i++) {
        F[i] += this.params.learningRate * tree.predict(X[i]);
      }

      for (const [f, g] of tree.gains) {
        this.featureGains[f] += g;
      }

      this.trees.push(tree);
    }
  }

  predictProba(x: number[]): number {
    let score = this.initScore;
    for (const tree of this.trees) {
      score += this.params.learningRate * tree.predict(x);
    }
    return sigmoid(score);
  }

  featureImportance(): number[] {
    const total = this.featureGains.reduce((a, b) => a + b, 0);
    if (total === 0) return this.featureGains.map(() => 0);
    return this.featureGains.map((g) => g / total);
  }
}
