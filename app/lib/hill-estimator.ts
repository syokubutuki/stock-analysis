// Hill (1975) テール指数推定量
// テール分布: P(X > x) ~ x^{-α}, α = Hill推定量

export interface HillResult {
  alpha: number;           // テール指数 (右テール)
  alphaLeft: number;       // テール指数 (左テール)
  threshold: number;       // 閾値 (k番目の順序統計量)
  k: number;               // 使用したテール観測数
  hillPlot: { k: number; alpha: number }[];  // k vs α のプロット
  interpretation: string;
}

// --- Hill推定量 ---
// α̂ = [1/k Σ_{i=1}^{k} (ln X_{(n-i+1)} - ln X_{(n-k)})]^{-1}
export function hillEstimator(values: number[], side: "right" | "left" = "right"): HillResult {
  const n = values.length;
  if (n < 50) return emptyHill();

  // For left tail, negate the values
  const data = side === "left"
    ? values.filter(v => v < 0).map(v => -v)
    : values.filter(v => v > 0);

  if (data.length < 30) return emptyHill();

  const sorted = data.slice().sort((a, b) => b - a); // descending
  const m = sorted.length;

  // Hill plot: compute α for each k
  const hillPlot: { k: number; alpha: number }[] = [];
  const minK = 5;
  const maxK = Math.min(Math.floor(m * 0.3), m - 1);

  for (let k = minK; k <= maxK; k++) {
    const lnThreshold = Math.log(sorted[k]);
    let sumLog = 0;
    for (let i = 0; i < k; i++) {
      sumLog += Math.log(sorted[i]) - lnThreshold;
    }
    const gamma = sumLog / k; // 1/α
    const alpha = gamma > 0 ? 1 / gamma : Infinity;
    hillPlot.push({ k, alpha });
  }

  // Optimal k selection (Danielsson et al. 2001 - simplified)
  // Use the plateau region of the Hill plot
  const optimalK = findOptimalK(hillPlot);
  const alphaEst = hillPlot.find(h => h.k === optimalK)?.alpha ?? 3;

  const threshold = sorted[optimalK];

  return {
    alpha: side === "right" ? alphaEst : 0,
    alphaLeft: side === "left" ? alphaEst : 0,
    threshold,
    k: optimalK,
    hillPlot,
    interpretation: "",
  };
}

// --- 両側テール推定 ---
export function hillBothTails(returns: number[]): HillResult {
  const right = hillEstimator(returns, "right");
  const left = hillEstimator(returns, "left");

  const alpha = right.alpha;
  const alphaLeft = left.alpha;

  const interpretation =
    `右テール指数α=${alpha.toFixed(2)}, 左テール指数α=${alphaLeft.toFixed(2)}。` +
    (alpha < 3
      ? `右テールが非常に厚い（分散が無限大の可能性）。極端な上昇が理論以上に頻繁。`
      : alpha < 5
        ? `右テールが厚い。正規分布よりも極端な上昇が多い。`
        : `右テールは比較的薄い。`) +
    (alphaLeft < 3
      ? ` 左テールも非常に厚い。暴落リスクが高い。`
      : alphaLeft < 5
        ? ` 左テールは中程度。`
        : ` 左テールは薄い。`);

  return {
    alpha,
    alphaLeft,
    threshold: right.threshold,
    k: right.k,
    hillPlot: right.hillPlot,
    interpretation,
  };
}

// k選択: Hill plotの安定領域を見つける
function findOptimalK(hillPlot: { k: number; alpha: number }[]): number {
  if (hillPlot.length < 5) return hillPlot[0]?.k ?? 10;

  // Moving average smoothing to find stable region
  const window = Math.max(3, Math.floor(hillPlot.length * 0.1));
  let minVariance = Infinity;
  let bestK = hillPlot[Math.floor(hillPlot.length / 4)].k;

  for (let i = window; i < hillPlot.length - window; i++) {
    const slice = hillPlot.slice(i - window, i + window + 1);
    const mean = slice.reduce((s, h) => s + h.alpha, 0) / slice.length;
    let variance = 0;
    for (const h of slice) variance += (h.alpha - mean) ** 2;
    variance /= slice.length;

    if (variance < minVariance && mean > 0 && isFinite(mean)) {
      minVariance = variance;
      bestK = hillPlot[i].k;
    }
  }

  return bestK;
}

function emptyHill(): HillResult {
  return { alpha: 3, alphaLeft: 3, threshold: 0, k: 0, hillPlot: [], interpretation: "データ不足" };
}
