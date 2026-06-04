// Kelly基準 / Black-Scholes パラメータ / Variance Swap Rate

export interface KellyResult {
  kellyFraction: number;     // 最適投資比率
  halfKelly: number;          // 半ケリー（実務推奨）
  expectedGrowth: number;     // 最適比率でのg = μf - σ²f²/2
  mu: number;                 // 年率期待リターン
  sigma: number;              // 年率ボラティリティ
  interpretation: string;
}

export interface BSParams {
  impliedVol: number;         // ヒストリカルvolをIV代用
  d1: number;
  d2: number;
  callDelta: number;
  putDelta: number;
  callPrice: number;
  putPrice: number;
  gamma: number;
  vega: number;
  theta: number;
  interpretation: string;
}

export interface VarianceSwapResult {
  realizedVar: number;         // 実現分散（年率）
  impliedVar: number;          // GARCHベースの期待分散
  varianceRiskPremium: number; // implied - realized
  rollingVRP: { time: string; vrp: number }[];
  interpretation: string;
}

export interface FinanceTheoryResult {
  kelly: KellyResult;
  bs: BSParams;
  varianceSwap: VarianceSwapResult;
}

// --- Kelly Criterion ---
// f* = μ/σ² (continuous case)
// f* = p/a - q/b (discrete case, p=win prob, a=loss, b=gain)
export function kellyOptimal(returns: number[]): KellyResult {
  const n = returns.length;
  if (n < 50) return emptyKelly();

  // Annualize
  let mu = 0;
  for (const r of returns) mu += r;
  mu = (mu / n) * 252;

  let s2 = 0;
  const dailyMu = mu / 252;
  for (const r of returns) s2 += (r - dailyMu) ** 2;
  s2 = (s2 / (n - 1)) * 252;
  const sigma = Math.sqrt(s2);

  // Continuous Kelly: f* = (μ - r_f) / σ²
  // Assume r_f = 0 for simplicity
  const kellyFraction = s2 > 0 ? mu / s2 : 0;
  const halfKelly = kellyFraction / 2;

  // Expected growth rate at optimal: g = μf* - σ²f*²/2 = μ²/(2σ²)
  const expectedGrowth = s2 > 0 ? (mu * mu) / (2 * s2) : 0;

  const interpretation = kellyFraction > 0
    ? `Kelly最適比率: ${(kellyFraction * 100).toFixed(1)}%。実務では半ケリー(${(halfKelly * 100).toFixed(1)}%)が推奨。` +
      (kellyFraction > 2 ? " 100%超はレバレッジを意味し、リスクが高い。" : "")
    : `Kelly比率が負。この銘柄は期待リターンが負で、ロングは推奨されない。`;

  return { kellyFraction, halfKelly, expectedGrowth, mu, sigma, interpretation };
}

// --- Black-Scholes パラメータ（ATMオプション理論価格） ---
// S: 現在価格, K: ATM行使価格 (=S), T: 30日, r: 0%, σ: ヒストリカルvol
export function blackScholesATM(currentPrice: number, historicalVol: number): BSParams {
  const S = currentPrice;
  const K = currentPrice; // ATM
  const T = 30 / 365;     // 30日
  const r = 0;             // risk-free rate
  const sigma = historicalVol;

  if (S <= 0 || sigma <= 0) return emptyBS();

  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  const Nd1 = normalCDF(d1);
  const Nd2 = normalCDF(d2);
  const nd1 = normalPDF(d1);

  const callPrice = S * Nd1 - K * Math.exp(-r * T) * Nd2;
  const putPrice = K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);

  const gamma = nd1 / (S * sigma * Math.sqrt(T));
  const vega = S * nd1 * Math.sqrt(T) / 100; // per 1% vol change
  const theta = -(S * nd1 * sigma) / (2 * Math.sqrt(T)) / 365; // per day

  const interpretation =
    `ATMオプション理論価格（30日満期）: コール=${callPrice.toFixed(2)}, プット=${putPrice.toFixed(2)}。` +
    `デルタ: コール=${Nd1.toFixed(3)}, プット=${(Nd1 - 1).toFixed(3)}。` +
    `日次シータ=${theta.toFixed(3)}（タイムディケイ/日）。`;

  return {
    impliedVol: sigma,
    d1, d2,
    callDelta: Nd1,
    putDelta: Nd1 - 1,
    callPrice, putPrice,
    gamma, vega, theta,
    interpretation,
  };
}

// --- Variance Swap Rate ---
// VRP = E[σ²] - Realized σ² (正なら保険プレミアムが存在)
export function varianceSwapAnalysis(
  returns: number[],
  times: string[],
  window: number = 20
): VarianceSwapResult {
  const n = returns.length;
  if (n < 60) return emptyVS();

  // Realized variance (annualized)
  let sumR2 = 0;
  for (const r of returns) sumR2 += r * r;
  const realizedVar = (sumR2 / n) * 252;

  // GARCH(1,1) implied variance (simple estimation)
  const variance = sumR2 / n;
  let alpha = 0.1, beta = 0.85;
  const omega = variance * (1 - alpha - beta);

  // Forward-looking expected variance from GARCH
  let s2 = variance;
  for (let t = 0; t < n; t++) {
    s2 = omega + alpha * returns[t] * returns[t] + beta * s2;
  }
  const impliedVar = s2 * 252; // next-period annualized

  const varianceRiskPremium = impliedVar - realizedVar;

  // Rolling VRP
  const rollingVRP: { time: string; vrp: number }[] = [];
  for (let i = window * 2; i < n; i++) {
    // Realized var (past window)
    let pastRV = 0;
    for (let j = i - window; j < i; j++) pastRV += returns[j] ** 2;
    pastRV = (pastRV / window) * 252;

    // GARCH implied (using conditional var at i)
    let sv = variance;
    for (let j = 0; j < i; j++) {
      sv = omega + alpha * returns[j] ** 2 + beta * sv;
    }
    const fwdVar = sv * 252;

    rollingVRP.push({
      time: times[i],
      vrp: (fwdVar - pastRV) * 10000, // in bps²
    });
  }

  const interpretation =
    `VRP = ${(varianceRiskPremium * 10000).toFixed(1)} bps²。` +
    (varianceRiskPremium > 0
      ? "正のVRP → ボラティリティ売り（ショートストラドル等）にプレミアムが存在。"
      : "負のVRP → ボラティリティが予想以上に実現。ボラ売りは損失リスク。");

  return { realizedVar, impliedVar, varianceRiskPremium, rollingVRP, interpretation };
}

// --- 総合 ---
export function financeTheoryAnalysis(
  returns: number[],
  currentPrice: number,
  times: string[]
): FinanceTheoryResult {
  const kelly = kellyOptimal(returns);
  const bs = blackScholesATM(currentPrice, kelly.sigma);
  const varianceSwap = varianceSwapAnalysis(returns, times);

  return { kelly, bs, varianceSwap };
}

// --- Helpers ---
function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function emptyKelly(): KellyResult {
  return { kellyFraction: 0, halfKelly: 0, expectedGrowth: 0, mu: 0, sigma: 0, interpretation: "データ不足" };
}

function emptyBS(): BSParams {
  return {
    impliedVol: 0, d1: 0, d2: 0, callDelta: 0.5, putDelta: -0.5,
    callPrice: 0, putPrice: 0, gamma: 0, vega: 0, theta: 0, interpretation: "データ不足",
  };
}

function emptyVS(): VarianceSwapResult {
  return { realizedVar: 0, impliedVar: 0, varianceRiskPremium: 0, rollingVRP: [], interpretation: "データ不足" };
}
