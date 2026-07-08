// デリバティブ分析の共通土台。
// 一般化 Black-Scholes（任意 K/T/r/q、call/put）、Greeks（配当利回り q 込み）、
// インプライドVol逆算、cost-of-carry フォワード価格、実現Volの年率化をまとめる。
//
// kelly-bs.ts の blackScholesATM は S=K・T=30日・r=0 固定で流用できないため、
// normalCdf/normalPdf を含め一般化版をここに実装する。

const TRADING_DAYS = 252;

export type OptionType = "call" | "put";

// --- 標準正規 CDF / PDF ---
// Abramowitz & Stegun 7.1.26（kelly-bs.ts と同じ近似）。
export function normalCdf(x: number): number {
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * z);
  const y =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export interface BSInput {
  S: number; // 原資産価格
  K: number; // 行使価格（ストライク）
  T: number; // 満期までの年数
  r: number; // 無リスク金利（年率、連続複利）
  q: number; // 配当利回り（年率、連続複利）
  sigma: number; // ボラティリティ（年率）
  type: OptionType;
}

export interface BSPrice {
  price: number;
  d1: number;
  d2: number;
}

// 一般化 Black-Scholes-Merton（配当利回り q 込み）。
//   d1 = [ln(S/K) + (r - q + σ²/2)T] / (σ√T)
//   d2 = d1 - σ√T
//   call = S·e^{-qT}·N(d1) - K·e^{-rT}·N(d2)
//   put  = K·e^{-rT}·N(-d2) - S·e^{-qT}·N(-d1)
export function bsPrice(inp: BSInput): BSPrice {
  const { S, K, T, r, q, sigma, type } = inp;
  // 満期到達 or σ→0 の縮退時は本質的価値（割引済み）で返す。
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    const fwd = S * Math.exp(-q * Math.max(T, 0)) - K * Math.exp(-r * Math.max(T, 0));
    const intrinsic = type === "call" ? Math.max(fwd, 0) : Math.max(-fwd, 0);
    return { price: intrinsic, d1: 0, d2: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const df = Math.exp(-r * T);
  const dfq = Math.exp(-q * T);
  const price =
    type === "call"
      ? S * dfq * normalCdf(d1) - K * df * normalCdf(d2)
      : K * df * normalCdf(-d2) - S * dfq * normalCdf(-d1);
  return { price, d1, d2 };
}

export interface Greeks {
  delta: number; // ∂V/∂S
  gamma: number; // ∂²V/∂S²
  vega: number; // ∂V/∂σ （1%volあたり = vega/100）
  theta: number; // ∂V/∂t （1日あたり = theta/365）
  rho: number; // ∂V/∂r （1%あたり = rho/100）
}

// Greeks（配当利回り q 込み）。vega/theta/rho は「生の」偏微分値を返し、
// 1%・1日換算は呼び出し側で行う（表示側で /100, /365 する）。
export function bsGreeks(inp: BSInput): Greeks {
  const { S, K, T, r, q, sigma, type } = inp;
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    // 縮退時: デルタは本質的価値の傾き、他は0。
    const itm = type === "call" ? S > K : S < K;
    const delta = itm ? (type === "call" ? 1 : -1) : 0;
    return { delta, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const { d1, d2 } = bsPrice(inp);
  const dfq = Math.exp(-q * T);
  const df = Math.exp(-r * T);
  const nd1 = normalPdf(d1);

  const delta =
    type === "call" ? dfq * normalCdf(d1) : dfq * (normalCdf(d1) - 1);
  const gamma = (dfq * nd1) / (S * sigma * sqrtT);
  const vega = S * dfq * nd1 * sqrtT; // 生値（σ+1.00 あたり）
  // theta（年率、生値）
  const term1 = -(S * dfq * nd1 * sigma) / (2 * sqrtT);
  const theta =
    type === "call"
      ? term1 - r * K * df * normalCdf(d2) + q * S * dfq * normalCdf(d1)
      : term1 + r * K * df * normalCdf(-d2) - q * S * dfq * normalCdf(-d1);
  const rho =
    type === "call"
      ? K * T * df * normalCdf(d2)
      : -K * T * df * normalCdf(-d2);

  return { delta, gamma, vega, theta, rho };
}

// 価格からインプライドVolを逆算。Newton法（vegaで更新）→ 収束しなければ二分法。
export function impliedVolFromPrice(
  targetPrice: number,
  inp: Omit<BSInput, "sigma">
): number | null {
  const { S, K, T, r, q, type } = inp;
  if (T <= 0 || S <= 0 || K <= 0 || targetPrice <= 0) return null;
  // 裁定境界チェック（下限）。
  const df = Math.exp(-r * T);
  const dfq = Math.exp(-q * T);
  const lowerBound =
    type === "call"
      ? Math.max(0, S * dfq - K * df)
      : Math.max(0, K * df - S * dfq);
  if (targetPrice < lowerBound - 1e-8) return null;

  // Newton
  let sigma = 0.3;
  for (let i = 0; i < 50; i++) {
    const price = bsPrice({ S, K, T, r, q, sigma, type }).price;
    const vega = bsGreeks({ S, K, T, r, q, sigma, type }).vega;
    const diff = price - targetPrice;
    if (Math.abs(diff) < 1e-6) return sigma;
    if (vega < 1e-8) break;
    const step = diff / vega;
    sigma -= step;
    if (sigma <= 0 || sigma > 5 || !isFinite(sigma)) break;
  }
  // 二分法フォールバック
  let lo = 1e-4,
    hi = 5;
  let plo = bsPrice({ S, K, T, r, q, sigma: lo, type }).price - targetPrice;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const pm = bsPrice({ S, K, T, r, q, sigma: mid, type }).price - targetPrice;
    if (Math.abs(pm) < 1e-6) return mid;
    if (plo * pm < 0) {
      hi = mid;
    } else {
      lo = mid;
      plo = pm;
    }
  }
  const mid = (lo + hi) / 2;
  return mid > 1e-3 && mid < 5 ? mid : null;
}

// プット・コール・パリティ残差: (C - P) - (S·e^{-qT} - K·e^{-rT})。理論上0。
export function putCallParityResidual(
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma: number
): { call: number; put: number; lhs: number; rhs: number; residual: number } {
  const call = bsPrice({ S, K, T, r, q, sigma, type: "call" }).price;
  const put = bsPrice({ S, K, T, r, q, sigma, type: "put" }).price;
  const lhs = call - put;
  const rhs = S * Math.exp(-q * T) - K * Math.exp(-r * T);
  return { call, put, lhs, rhs, residual: lhs - rhs };
}

// cost-of-carry フォワード/先物価格: F = S·e^{(r-q)T}。
export function forwardPrice(S: number, r: number, q: number, T: number): number {
  return S * Math.exp((r - q) * T);
}

// 対数リターン列（終値ベース）。
export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1],
      b = closes[i];
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

// 日次対数リターンから年率化した実現Vol（√252）。
export function annualizedRealizedVol(returns: number[]): number {
  const n = returns.length;
  if (n < 2) return 0;
  const m = returns.reduce((s, v) => s + v, 0) / n;
  const v = returns.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1);
  return Math.sqrt(v * TRADING_DAYS);
}
