// Cornish-Fisher修正VaR / オメガレシオ / ボラティリティコーン

export interface CornishFisherVaR {
  normalVaR95: number;
  normalVaR99: number;
  cfVaR95: number;
  cfVaR99: number;
  historicalVaR95: number;
  historicalVaR99: number;
  skewness: number;
  excessKurtosis: number;
  interpretation: string;
}

export interface OmegaRatioResult {
  omega: number;          // Ω(0)
  curve: { threshold: number; omega: number }[];
  breakeven: number;      // Ω=1となるリターン水準
  interpretation: string;
}

export interface VolConeResult {
  windows: number[];
  percentiles: { p10: number; p25: number; p50: number; p75: number; p90: number }[];
  currentVol: number[];
  currentPercentile: number[];
  interpretation: string;
}

// --- Cornish-Fisher VaR ---
export function computeCornishFisherVaR(returns: number[]): CornishFisherVaR {
  const n = returns.length;
  if (n < 30) return emptyCFVaR();

  let mu = 0;
  for (const r of returns) mu += r;
  mu /= n;

  let m2 = 0, m3 = 0, m4 = 0;
  for (const r of returns) {
    const d = r - mu;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;

  const sigma = Math.sqrt(m2);
  const S = sigma > 0 ? m3 / (sigma ** 3) : 0; // skewness
  const K = sigma > 0 ? m4 / (sigma ** 4) - 3 : 0; // excess kurtosis

  // Normal VaR
  const z95 = -1.645;
  const z99 = -2.326;
  const normalVaR95 = -(mu + z95 * sigma);
  const normalVaR99 = -(mu + z99 * sigma);

  // Cornish-Fisher expansion
  const zCF95 = cornishFisherQuantile(z95, S, K);
  const zCF99 = cornishFisherQuantile(z99, S, K);
  const cfVaR95 = -(mu + zCF95 * sigma);
  const cfVaR99 = -(mu + zCF99 * sigma);

  // Historical VaR
  const sorted = returns.slice().sort((a, b) => a - b);
  const historicalVaR95 = -sorted[Math.floor(n * 0.05)];
  const historicalVaR99 = -sorted[Math.floor(n * 0.01)];

  const diff95 = ((cfVaR95 - normalVaR95) / normalVaR95 * 100).toFixed(1);
  const interpretation =
    `CF修正VaR(95%)=${(cfVaR95 * 100).toFixed(2)}%は正規VaR(${(normalVaR95 * 100).toFixed(2)}%)より${diff95}%${cfVaR95 > normalVaR95 ? "大きい" : "小さい"}。` +
    (Math.abs(K) > 1 ? `超過尖度${K.toFixed(2)}が大きく、正規VaRはリスクを過小評価。` : "");

  return {
    normalVaR95, normalVaR99, cfVaR95, cfVaR99,
    historicalVaR95, historicalVaR99, skewness: S, excessKurtosis: K,
    interpretation,
  };
}

function cornishFisherQuantile(z: number, S: number, K: number): number {
  return z
    + (z * z - 1) * S / 6
    + (z * z * z - 3 * z) * K / 24
    - (2 * z * z * z - 5 * z) * S * S / 36;
}

// --- Omega Ratio ---
// Ω(τ) = ∫_τ^∞ [1-F(r)]dr / ∫_{-∞}^τ F(r)dr
export function computeOmegaRatio(returns: number[]): OmegaRatioResult {
  const n = returns.length;
  if (n < 30) return emptyOmega();

  const sorted = returns.slice().sort((a, b) => a - b);

  // Compute Ω for different thresholds
  const minR = sorted[0];
  const maxR = sorted[n - 1];
  const steps = 50;
  const curve: { threshold: number; omega: number }[] = [];
  let breakeven = 0;

  for (let i = 0; i <= steps; i++) {
    const tau = minR + (maxR - minR) * i / steps;
    const omega = omegaAtThreshold(sorted, tau);
    curve.push({ threshold: tau, omega: Math.min(omega, 100) });

    if (i > 0 && curve[i - 1].omega >= 1 && omega < 1) {
      // Linear interpolation for breakeven
      const t0 = curve[i - 1].threshold;
      const o0 = curve[i - 1].omega;
      const t1 = tau;
      const o1 = omega;
      breakeven = t0 + (1 - o0) / (o1 - o0) * (t1 - t0);
    }
  }

  const omega0 = omegaAtThreshold(sorted, 0);

  const interpretation = omega0 > 1
    ? `Ω(0)=${omega0.toFixed(3)} > 1。リターンの確率加重合計がプラスで、投資妙味があります。`
    : `Ω(0)=${omega0.toFixed(3)} < 1。マイナスリターンの影響が大きく、リスク対比のリターンが不十分。`;

  return { omega: omega0, curve, breakeven, interpretation };
}

function omegaAtThreshold(sorted: number[], tau: number): number {
  const n = sorted.length;
  let gain = 0, loss = 0;
  for (const r of sorted) {
    if (r > tau) gain += r - tau;
    else loss += tau - r;
  }
  return loss > 0 ? gain / loss : gain > 0 ? 100 : 1;
}

// --- Volatility Cone ---
export function computeVolCone(returns: number[]): VolConeResult {
  const n = returns.length;
  if (n < 252) return emptyVolCone();

  const windows = [5, 10, 20, 40, 60, 120, 252];
  const percentiles: { p10: number; p25: number; p50: number; p75: number; p90: number }[] = [];
  const currentVol: number[] = [];
  const currentPercentile: number[] = [];

  for (const w of windows) {
    if (w > n - 1) continue;

    // Compute all rolling volatilities for this window
    const vols: number[] = [];
    for (let i = w; i <= n; i++) {
      const slice = returns.slice(i - w, i);
      let mu = 0;
      for (const v of slice) mu += v;
      mu /= w;
      let s2 = 0;
      for (const v of slice) s2 += (v - mu) ** 2;
      s2 /= w - 1;
      vols.push(Math.sqrt(s2 * 252)); // annualize
    }

    vols.sort((a, b) => a - b);
    const m = vols.length;
    percentiles.push({
      p10: vols[Math.floor(m * 0.1)],
      p25: vols[Math.floor(m * 0.25)],
      p50: vols[Math.floor(m * 0.5)],
      p75: vols[Math.floor(m * 0.75)],
      p90: vols[Math.floor(m * 0.9)],
    });

    const current = vols[m - 1]; // most recent
    currentVol.push(current);

    // Where does current vol sit?
    let rank = 0;
    for (const v of vols) if (v <= current) rank++;
    currentPercentile.push(rank / m * 100);
  }

  const validWindows = windows.filter(w => w <= n - 1);

  const avgPctile = currentPercentile.length > 0
    ? currentPercentile.reduce((s, v) => s + v, 0) / currentPercentile.length
    : 50;

  const interpretation = avgPctile > 75
    ? `現在のボラティリティは歴史的に高水準（平均${avgPctile.toFixed(0)}パーセンタイル）。ボラティリティ売り戦略の検討余地。`
    : avgPctile < 25
      ? `現在のボラティリティは歴史的に低水準（平均${avgPctile.toFixed(0)}パーセンタイル）。ボラティリティ買い戦略の検討余地。`
      : `現在のボラティリティは歴史的平均水準（${avgPctile.toFixed(0)}パーセンタイル）。`;

  return { windows: validWindows, percentiles, currentVol, currentPercentile, interpretation };
}

// --- Rolling Beta / CAPM (自己ベータ: 市場=自分自身のリターン、参考指標) ---
export interface RollingBetaResult {
  rollingBeta: { time: string; beta: number; alpha: number; r2: number }[];
  fullBeta: number;
  fullAlpha: number;
  fullR2: number;
  interpretation: string;
}

export function computeRollingBeta(
  returns: number[],
  marketReturns: number[],
  times: string[],
  window: number = 60
): RollingBetaResult {
  const n = Math.min(returns.length, marketReturns.length);
  if (n < window + 10) return emptyBeta();

  const rollingBeta: { time: string; beta: number; alpha: number; r2: number }[] = [];

  for (let i = window; i < n; i++) {
    const rSlice = returns.slice(i - window, i);
    const mSlice = marketReturns.slice(i - window, i);
    const { beta, alpha, r2 } = regress(rSlice, mSlice);
    rollingBeta.push({ time: times[i], beta, alpha, r2 });
  }

  const { beta: fullBeta, alpha: fullAlpha, r2: fullR2 } = regress(
    returns.slice(0, n),
    marketReturns.slice(0, n)
  );

  const interpretation = `β=${fullBeta.toFixed(3)}（市場感応度）、α=${(fullAlpha * 252 * 100).toFixed(2)}%/年（超過リターン）、R²=${fullR2.toFixed(3)}`;

  return { rollingBeta, fullBeta, fullAlpha, fullR2, interpretation };
}

function regress(y: number[], x: number[]): { beta: number; alpha: number; r2: number } {
  const n = y.length;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i]; sxy += x[i] * y[i]; sx2 += x[i] * x[i]; sy2 += y[i] * y[i];
  }
  const denom = n * sx2 - sx * sx;
  if (Math.abs(denom) < 1e-15) return { beta: 1, alpha: 0, r2: 0 };
  const beta = (n * sxy - sx * sy) / denom;
  const alpha = (sy - beta * sx) / n;
  const ssTot = sy2 - sy * sy / n;
  let ssRes = 0;
  for (let i = 0; i < n; i++) ssRes += (y[i] - alpha - beta * x[i]) ** 2;
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { beta, alpha, r2 };
}

// --- Empty results ---
function emptyCFVaR(): CornishFisherVaR {
  return {
    normalVaR95: 0, normalVaR99: 0, cfVaR95: 0, cfVaR99: 0,
    historicalVaR95: 0, historicalVaR99: 0, skewness: 0, excessKurtosis: 0,
    interpretation: "データ不足",
  };
}

function emptyOmega(): OmegaRatioResult {
  return { omega: 1, curve: [], breakeven: 0, interpretation: "データ不足" };
}

function emptyVolCone(): VolConeResult {
  return { windows: [], percentiles: [], currentVol: [], currentPercentile: [], interpretation: "データ不足" };
}

function emptyBeta(): RollingBetaResult {
  return { rollingBeta: [], fullBeta: 1, fullAlpha: 0, fullR2: 0, interpretation: "データ不足" };
}
