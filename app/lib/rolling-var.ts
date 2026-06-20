// 7.3 ローリング VaR/CVaR（historical / EVT / Cornish-Fisher）。
// 時変のテールリスクを監視する。VaRは「損失がこの水準を超える確率は5%」という値。

import { PricePoint } from "./types";

export interface VaRPoint {
  time: string;
  hist95: number; // ヒストリカルVaR95（正の損失率）
  cvar95: number; // 条件付きVaR（VaR超過時の平均損失）
  cf95: number; // Cornish-Fisher VaR95（歪度・尖度調整）
  evt99: number; // EVT(GPD) VaR99
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

function cornishFisherVaR(rets: number[], z: number): number {
  const m = mean(rets);
  const sd = Math.sqrt(mean(rets.map((r) => (r - m) ** 2)));
  if (sd === 0) return 0;
  const s = mean(rets.map((r) => ((r - m) / sd) ** 3));
  const k = mean(rets.map((r) => ((r - m) / sd) ** 4));
  const zcf = z + (z * z - 1) / 6 * s + (z ** 3 - 3 * z) / 24 * (k - 3) - (2 * z ** 3 - 5 * z) / 36 * s * s;
  return -(m + zcf * sd);
}

// POT-GPD（積率法）でEVT VaR。losses=正の損失。
function evtVaR(rets: number[], p: number): number {
  const losses = rets.map((r) => -r).filter((x) => x > 0).sort((a, b) => a - b);
  if (losses.length < 20) return 0;
  const u = quantile(losses, 0.9); // 閾値
  const exc = losses.filter((x) => x > u).map((x) => x - u);
  const Nu = exc.length;
  if (Nu < 10) return 0;
  const m = mean(exc);
  const v = mean(exc.map((x) => (x - m) ** 2));
  if (v <= 0) return u;
  const xi = 0.5 * (1 - (m * m) / v);
  const beta = 0.5 * m * ((m * m) / v + 1);
  if (beta <= 0) return u;
  const n = losses.length;
  if (Math.abs(xi) < 1e-6) return u + beta * Math.log((n / Nu) / (1 - p));
  return u + (beta / xi) * (Math.pow((n / Nu) * (1 - p), -xi) - 1);
}

export function rollingVaR(prices: PricePoint[], window = 250): VaRPoint[] {
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    rets.push(prices[i - 1].close > 0 ? prices[i].close / prices[i - 1].close - 1 : 0);
  }
  const out: VaRPoint[] = [];
  for (let end = window; end <= rets.length; end++) {
    const seg = rets.slice(end - window, end);
    const sorted = [...seg].sort((a, b) => a - b);
    const var95 = -quantile(sorted, 0.05);
    const tail = sorted.filter((x) => x <= -var95);
    const cvar95 = tail.length ? -mean(tail) : var95;
    out.push({
      time: prices[end].time,
      hist95: var95,
      cvar95,
      cf95: cornishFisherVaR(seg, -1.645),
      evt99: evtVaR(seg, 0.99),
    });
  }
  return out;
}
