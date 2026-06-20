// 1.5 髭非対称・圧力指標の時系列。
// (上ヒゲ − 下ヒゲ)/レンジ をローリング平均し、買い圧/売り圧の推移を可視化する。
// 上ヒゲ優勢=高値を売られる(売り圧)、下ヒゲ優勢=安値を買われる(買い圧)。

import { PricePoint } from "./types";

export interface WickPressurePoint {
  time: string;
  asym: number; // 単日 (lowerWick - upperWick)/range  +で買い圧
  rollAsym: number; // ローリング平均
  clvRoll: number; // CLV のローリング（引けの強さ）
}

export function computeWickPressure(prices: PricePoint[], window = 10): WickPressurePoint[] {
  const n = prices.length;
  const asym: number[] = new Array(n).fill(0);
  const clv: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const { open: o, high: h, low: l, close: c } = prices[i];
    const range = h - l;
    if (range > 0) {
      const upper = h - Math.max(o, c);
      const lower = Math.min(o, c) - l;
      asym[i] = (lower - upper) / range; // +買い圧 / -売り圧
      clv[i] = (2 * c - h - l) / range;
    }
  }
  const out: WickPressurePoint[] = [];
  for (let i = 0; i < n; i++) {
    if (i < window - 1) continue;
    let sa = 0, sc = 0;
    for (let j = i - window + 1; j <= i; j++) { sa += asym[j]; sc += clv[j]; }
    out.push({ time: prices[i].time, asym: asym[i], rollAsym: sa / window, clvRoll: sc / window });
  }
  return out;
}
