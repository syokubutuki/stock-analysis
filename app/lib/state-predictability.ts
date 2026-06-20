// 9.3 状態別の予測可能性。
// 各状態バケットで「短期モメンタムがどれだけ先行きを当てるか」を、方向的中率と
// 情報係数(IC=予測子と実現リターンの相関)で測る。どの局面で予測が効くかを見る。

import { PricePoint } from "./types";
import { buildStateFn, StateAxis } from "./conditional-forward-returns";

export interface PredictabilityRow {
  label: string;
  n: number;
  hitRate: number; // sign(過去5日)==sign(先5日) の割合
  ic: number; // Pearson corr(過去5日リターン, 先5日リターン)
}

function corr(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
}

export function statePredictability(prices: PricePoint[], axis: StateAxis, lookback = 5, horizon = 5): PredictabilityRow[] {
  const st = buildStateFn(prices, axis);
  const n = prices.length;
  const groups = new Map<string, { pred: number[]; fwd: number[] }>();
  for (let i = lookback; i < n - horizon; i++) {
    const label = st.stateOf(i);
    if (label === null) continue;
    if (!(prices[i - lookback].close > 0) || !(prices[i].close > 0)) continue;
    const pred = prices[i].close / prices[i - lookback].close - 1;
    const fwd = prices[i + horizon].close / prices[i].close - 1;
    const g = groups.get(label) ?? { pred: [], fwd: [] };
    g.pred.push(pred); g.fwd.push(fwd);
    groups.set(label, g);
  }
  const rows: PredictabilityRow[] = [];
  for (const label of st.order) {
    const g = groups.get(label);
    if (!g || g.pred.length < 5) continue;
    let hit = 0;
    for (let k = 0; k < g.pred.length; k++) if (Math.sign(g.pred[k]) === Math.sign(g.fwd[k])) hit++;
    rows.push({ label, n: g.pred.length, hitRate: hit / g.pred.length, ic: corr(g.pred, g.fwd) });
  }
  return rows;
}
