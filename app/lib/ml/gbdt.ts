/** Gradient Boosted Decision Trees (純TypeScript実装 / XGBoost型) */

function sigmoid(x: number): number {
  if (x > 30) return 1;
  if (x < -30) return 0;
  return 1 / (1 + Math.exp(-x));
}

// ── 決定的PRNG (mulberry32) ────────────────────────
// シード付きの軽量擬似乱数。再現性を確保するために自前実装する。

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 回帰決定木 (CART / XGBoost型 勾配・ヘシアン分割) ─

interface TreeNode {
  feature: number;
  threshold: number;
  left: TreeNode | null;
  right: TreeNode | null;
  value: number; // ニュートン葉値 w* = -ΣG / (ΣH + λ)
}

class DecisionTree {
  private root: TreeNode | null = null;
  readonly gains = new Map<number, number>();

  constructor(
    private maxDepth: number,
    private minSamplesLeaf: number,
    private lambda: number,
    private gamma: number,
    private minChildWeight: number,
    // 列サブサンプリングで使用する特徴インデックスの集合
    private featureSubset: number[],
  ) {}

  // 勾配 g・ヘシアン h を与えて木を学習する
  fit(X: number[][], g: number[], h: number[]): void {
    this.gains.clear();
    const indices = Array.from({ length: g.length }, (_, i) => i);
    this.root = this.build(X, g, h, indices, 0);
  }

  predict(x: number[]): number {
    let n = this.root!;
    while (n.left !== null) {
      n = x[n.feature] <= n.threshold ? n.left : n.right!;
    }
    return n.value;
  }

  // 葉の重み (ニュートン葉値): w* = -ΣG / (ΣH + λ)
  private leafValue(sumG: number, sumH: number): number {
    return -sumG / (sumH + this.lambda);
  }

  private build(
    X: number[][],
    g: number[],
    h: number[],
    idx: number[],
    depth: number,
  ): TreeNode {
    const n = idx.length;
    let totalG = 0;
    let totalH = 0;
    for (const i of idx) {
      totalG += g[i];
      totalH += h[i];
    }
    const value = this.leafValue(totalG, totalH);
    const leaf: TreeNode = { feature: -1, threshold: 0, left: null, right: null, value };

    if (depth >= this.maxDepth || n < 2 * this.minSamplesLeaf) return leaf;

    // 分割前のスコア項 G²/(H+λ)
    const parentScore = (totalG * totalG) / (totalH + this.lambda);

    let bestGain = 0;
    let bestFeature = -1;
    let bestThreshold = 0;

    for (const f of this.featureSubset) {
      const sorted = [...idx].sort((a, b) => X[a][f] - X[b][f]);
      let leftG = 0;
      let leftH = 0;

      for (let k = 0; k < sorted.length - 1; k++) {
        const si = sorted[k];
        leftG += g[si];
        leftH += h[si];
        const leftN = k + 1;
        const rightN = n - leftN;

        if (leftN < this.minSamplesLeaf || rightN < this.minSamplesLeaf) continue;
        if (X[sorted[k]][f] === X[sorted[k + 1]][f]) continue;

        const rightG = totalG - leftG;
        const rightH = totalH - leftH;

        // min_child_weight: 子ノードの ΣH がしきい値未満の分割は不可
        if (leftH < this.minChildWeight || rightH < this.minChildWeight) continue;

        // XGBoost型ゲイン:
        // gain = 0.5 * [ GL²/(HL+λ) + GR²/(HR+λ) − G²/(H+λ) ] − γ
        const gain =
          0.5 *
            ((leftG * leftG) / (leftH + this.lambda) +
              (rightG * rightG) / (rightH + this.lambda) -
              parentScore) -
          this.gamma;

        if (gain > bestGain) {
          bestGain = gain;
          bestFeature = f;
          bestThreshold = (X[sorted[k]][f] + X[sorted[k + 1]][f]) / 2;
        }
      }
    }

    // gain <= 0 (実質 γ 以下) の分割は採用しない
    if (bestFeature === -1) return leaf;

    // 特徴量重要度: γ を除く改善量 × ノードサンプル数 を累積
    const improve = bestGain + this.gamma;
    this.gains.set(bestFeature, (this.gains.get(bestFeature) || 0) + improve * n);

    const leftIdx: number[] = [];
    const rightIdx: number[] = [];
    for (const i of idx) {
      if (X[i][bestFeature] <= bestThreshold) leftIdx.push(i);
      else rightIdx.push(i);
    }

    return {
      feature: bestFeature,
      threshold: bestThreshold,
      left: this.build(X, g, h, leftIdx, depth + 1),
      right: this.build(X, g, h, rightIdx, depth + 1),
      value,
    };
  }
}

// ── GBDT (二値分類 / XGBoost型) ────────────────────

export interface GBDTParams {
  nEstimators: number;
  learningRate: number;
  maxDepth: number;
  minSamplesLeaf: number;
  lambda: number; // L2正則化 (葉値・ゲインの分母)
  gamma: number; // 最小分割ゲイン (これ以下の改善では分割しない)
  minChildWeight: number; // 子ノードに必要な最小 ΣH
  subsample: number; // 行サブサンプリング比率 (0<sub≤1)
  colsample: number; // 列サブサンプリング比率 (0<col≤1)
  scalePosWeight: number; // 正例(y=1)の重み (クラス不均衡対応)
  seed: number; // PRNGシード
}

export const DEFAULT_GBDT_PARAMS: GBDTParams = {
  nEstimators: 30,
  learningRate: 0.1,
  maxDepth: 3,
  minSamplesLeaf: 5,
  lambda: 1.0,
  gamma: 0,
  minChildWeight: 1.0,
  subsample: 0.8,
  colsample: 0.8,
  scalePosWeight: 1,
  seed: 42,
};

export class GBDT {
  private trees: DecisionTree[] = [];
  private initScore = 0;
  private nFeatures = 0;
  private featureGains: number[] = [];
  private params: GBDTParams;

  constructor(params: GBDTParams = DEFAULT_GBDT_PARAMS) {
    // 新フィールドが欠けても DEFAULT で補う (後方互換)
    this.params = { ...DEFAULT_GBDT_PARAMS, ...params };
  }

  fit(X: number[][], y: number[]): void {
    const n = y.length;
    this.nFeatures = X[0].length;
    this.featureGains = new Array(this.nFeatures).fill(0);
    this.trees = [];

    const posCount = y.reduce((a, b) => a + b, 0);
    const negCount = n - posCount;
    // prior log-odds で初期化
    this.initScore = Math.log((posCount + 1e-10) / (negCount + 1e-10));

    const F = new Float64Array(n).fill(this.initScore);
    const rng = mulberry32(this.params.seed);

    const spw = this.params.scalePosWeight;
    const sub = Math.min(1, Math.max(0, this.params.subsample));
    const col = Math.min(1, Math.max(0, this.params.colsample));

    // 列サブサンプル数 (最低1)
    const nColSample = Math.max(1, Math.round(this.nFeatures * col));

    for (let m = 0; m < this.params.nEstimators; m++) {
      // ロジスティック損失の勾配 g_i = p_i - y_i, ヘシアン h_i = p_i(1-p_i)
      // 正例(y=1)には scale_pos_weight を掛けて不均衡に対応する
      const g = new Array<number>(n);
      const h = new Array<number>(n);
      for (let i = 0; i < n; i++) {
        const p = sigmoid(F[i]);
        const w = y[i] === 1 ? spw : 1;
        g[i] = w * (p - y[i]);
        h[i] = w * p * (1 - p);
      }

      // 行サブサンプリング (木ごとに決定的にサンプル)
      let rowSubset: number[];
      if (sub >= 1) {
        rowSubset = Array.from({ length: n }, (_, i) => i);
      } else {
        rowSubset = [];
        for (let i = 0; i < n; i++) {
          if (rng() < sub) rowSubset.push(i);
        }
        // 空集合を避ける
        if (rowSubset.length < 2 * this.params.minSamplesLeaf) {
          rowSubset = Array.from({ length: n }, (_, i) => i);
        }
      }

      // 列サブサンプリング (木ごとに使う特徴集合を制限)
      const featureSubset = this.sampleFeatures(nColSample, rng);

      // サブサンプルした行だけを抜き出して木を学習
      const subX = rowSubset.map((i) => X[i]);
      const subG = rowSubset.map((i) => g[i]);
      const subH = rowSubset.map((i) => h[i]);

      const tree = new DecisionTree(
        this.params.maxDepth,
        this.params.minSamplesLeaf,
        this.params.lambda,
        this.params.gamma,
        this.params.minChildWeight,
        featureSubset,
      );
      tree.fit(subX, subG, subH);

      // F += lr * 葉値 (全サンプルに適用)
      for (let i = 0; i < n; i++) {
        F[i] += this.params.learningRate * tree.predict(X[i]);
      }

      for (const [f, gain] of tree.gains) {
        this.featureGains[f] += gain;
      }

      this.trees.push(tree);
    }
  }

  // 列サブサンプリング: nFeatures から nSample 個を非復元で選ぶ (決定的)
  private sampleFeatures(nSample: number, rng: () => number): number[] {
    const all = Array.from({ length: this.nFeatures }, (_, i) => i);
    if (nSample >= this.nFeatures) return all;
    // Fisher–Yates で先頭 nSample 個を選ぶ
    for (let i = 0; i < nSample; i++) {
      const j = i + Math.floor(rng() * (this.nFeatures - i));
      const tmp = all[i];
      all[i] = all[j];
      all[j] = tmp;
    }
    return all.slice(0, nSample).sort((a, b) => a - b);
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
