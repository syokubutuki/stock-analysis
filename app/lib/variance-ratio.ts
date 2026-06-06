// Variance Ratio Test (Lo-MacKinlay 1988)
// VR(q) = Var(r(q)) / [q * Var(r(1))]
// H0: VR = 1 (ランダムウォーク)

export interface VarianceRatioPoint {
  q: number;
  vr: number;
  zStat: number;
  pValue: number;
  significant: boolean;
}

export interface VarianceRatioResult {
  points: VarianceRatioPoint[];
  isRandomWalk: boolean;
  interpretation: string;
}

/** 標準正規CDF近似 (Abramowitz-Stegun) */
function normCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

export function computeVarianceRatio(returns: number[]): VarianceRatioResult {
  const n = returns.length;
  const empty: VarianceRatioResult = {
    points: [],
    isRandomWalk: true,
    interpretation: "データが不足しています。",
  };
  if (n < 100) return empty;

  // 1期間リターンの分散
  let mu = 0;
  for (const r of returns) mu += r;
  mu /= n;

  let sigma2 = 0;
  for (const r of returns) sigma2 += (r - mu) ** 2;
  sigma2 /= (n - 1);

  if (sigma2 < 1e-16) return empty;

  const qs = [2, 4, 8, 16, 32].filter((q) => q < n / 3);
  const points: VarianceRatioPoint[] = [];

  for (const q of qs) {
    // q期間の重複リターン
    let varQ = 0;
    const nq = n - q + 1;
    const overlapping: number[] = [];
    for (let i = 0; i <= n - q; i++) {
      let sumR = 0;
      for (let j = i; j < i + q; j++) sumR += returns[j];
      overlapping.push(sumR);
    }

    let muQ = 0;
    for (const r of overlapping) muQ += r;
    muQ /= overlapping.length;

    for (const r of overlapping) varQ += (r - muQ) ** 2;
    varQ /= (nq - 1);

    const vr = varQ / (q * sigma2);

    // Heteroskedasticity-robust Z-statistic (Lo-MacKinlay)
    let theta = 0;
    for (let j = 1; j < q; j++) {
      const weight = 2 * (q - j) / q;
      // delta(j): 4次モーメント補正
      let num = 0;
      for (let t = j; t < n; t++) {
        num += (returns[t] - mu) ** 2 * (returns[t - j] - mu) ** 2;
      }
      const deltaJ = (n * num) / (sigma2 * (n - 1) * sigma2 * (n - 1)) - 1;
      // 安全策: deltaJが負の場合の補正は不要（理論上非負だが数値誤差対策）
      theta += weight * weight * Math.max(0, deltaJ);
    }

    const se = Math.sqrt(theta);
    const zStat = se > 1e-12 ? (vr - 1) / se : 0;
    const pValue = 2 * (1 - normCDF(Math.abs(zStat)));
    const significant = pValue < 0.05;

    points.push({ q, vr, zStat, pValue, significant });
  }

  const isRandomWalk = points.every((p) => !p.significant);

  // 解釈
  const sigPoints = points.filter((p) => p.significant);
  let interpretation = "";
  if (isRandomWalk) {
    interpretation =
      "全てのqでVR(q)は1と有意に異ならず、ランダムウォーク仮説を棄却できません。リターンに予測可能な自己相関パターンは検出されませんでした。";
  } else {
    const vrAbove = sigPoints.filter((p) => p.vr > 1);
    const vrBelow = sigPoints.filter((p) => p.vr < 1);
    if (vrAbove.length > 0 && vrBelow.length === 0) {
      interpretation = `q=${vrAbove.map((p) => p.q).join(",")}でVR>1が有意（正の自己相関）。モメンタム/トレンド追従戦略が有効な可能性があります。`;
    } else if (vrBelow.length > 0 && vrAbove.length === 0) {
      interpretation = `q=${vrBelow.map((p) => p.q).join(",")}でVR<1が有意（負の自己相関）。平均回帰/逆張り戦略が有効な可能性があります。`;
    } else {
      interpretation = `短期と長期で異なるパターン: 短期ではVR${vrAbove.length > 0 ? ">1(モメンタム)" : "<1(平均回帰)"}、長期では逆のパターンが見られます。`;
    }
  }

  return { points, isRandomWalk, interpretation };
}
