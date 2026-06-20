// 5.4 分散比(Variance Ratio)のローリングと有意性。
// VR(q)=Var(q期間リターン)/(q·Var(1期間リターン))。ランダムウォークなら≈1、
// >1でトレンド(正の自己相関)、<1で平均回帰。ローリングで局面の切替を監視する。

import { PricePoint } from "./types";

export interface VRPoint {
  time: string;
  vr: number;
  z: number; // 標準化（ランダムウォーク帰無に対する）
  upper: number; // 95%帯上限(≈1+1.96σ)
  lower: number;
}

function logReturns(prices: PricePoint[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    r.push(prices[i].close > 0 && prices[i - 1].close > 0 ? Math.log(prices[i].close / prices[i - 1].close) : 0);
  }
  return r;
}

// Lo-MacKinlay 不均一分散頑健でない簡易版VR + 漸近分散。
function vrAt(rets: number[], q: number): { vr: number; z: number; se: number } | null {
  const n = rets.length;
  if (n < q * 2) return null;
  const mu = rets.reduce((s, v) => s + v, 0) / n;
  let var1 = 0;
  for (const r of rets) var1 += (r - mu) ** 2;
  var1 /= n - 1;
  if (var1 === 0) return null;
  // q期間和の分散
  const m = q * (n - q + 1) * (1 - q / n);
  let varq = 0;
  for (let i = 0; i <= n - q; i++) {
    let s = 0;
    for (let j = 0; j < q; j++) s += rets[i + j];
    varq += (s - q * mu) ** 2;
  }
  varq /= m;
  const vr = varq / var1;
  // 漸近分散（同分散仮定）: 2(2q-1)(q-1)/(3qN)
  const asyVar = (2 * (2 * q - 1) * (q - 1)) / (3 * q * n);
  const se = Math.sqrt(asyVar);
  const z = se > 0 ? (vr - 1) / se : 0;
  return { vr, z, se };
}

export function rollingVarianceRatio(prices: PricePoint[], q = 5, window = 126): VRPoint[] {
  const rets = logReturns(prices);
  const out: VRPoint[] = [];
  for (let end = window; end <= rets.length; end++) {
    const seg = rets.slice(end - window, end);
    const res = vrAt(seg, q);
    if (!res) continue;
    out.push({
      time: prices[end].time, // retsはprices[1..]なので end は prices index に対応
      vr: res.vr,
      z: res.z,
      upper: 1 + 1.96 * res.se,
      lower: 1 - 1.96 * res.se,
    });
  }
  return out;
}
