// 2.4 ボラのレバレッジ効果（OHLC版）。
// 「下落日の翌日はボラが拡大しやすい」という非対称性を、当日リターンの大小別に
// 翌日のレンジ由来ボラ（Garman-Klass年率σ）を集計して可視化する。

import { PricePoint } from "./types";

const LN2 = Math.log(2);
const TRADING_DAYS = 252;

function gkVolAnn(p: PricePoint): number {
  const { open: O, high: H, low: L, close: C } = p;
  if (!(O > 0 && H > 0 && L > 0 && C > 0)) return NaN;
  const v = Math.max(0, 0.5 * Math.log(H / L) ** 2 - (2 * LN2 - 1) * Math.log(C / O) ** 2);
  return Math.sqrt(v * TRADING_DAYS);
}

export interface LeverageBucket {
  label: string;
  n: number;
  nextVol: number; // 翌日の平均GK年率ボラ
}

export interface LeverageResult {
  buckets: LeverageBucket[];
  corr: number; // corr(当日リターン, 翌日ボラ) 負ほど強いレバレッジ効果
  baselineVol: number;
}

const BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: "大幅安(<-2%)", lo: -Infinity, hi: -0.02 },
  { label: "下落(-2〜-0.5%)", lo: -0.02, hi: -0.005 },
  { label: "小動き(±0.5%)", lo: -0.005, hi: 0.005 },
  { label: "上昇(0.5〜2%)", lo: 0.005, hi: 0.02 },
  { label: "大幅高(>2%)", lo: 0.02, hi: Infinity },
];

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

export function computeVolLeverage(prices: PricePoint[]): LeverageResult | null {
  const n = prices.length;
  if (n < 30) return null;
  const rets: number[] = [];
  const nextVols: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (!(prices[i - 1].close > 0)) continue;
    const r = prices[i].close / prices[i - 1].close - 1;
    const nv = gkVolAnn(prices[i + 1]);
    if (isNaN(nv)) continue;
    rets.push(r);
    nextVols.push(nv);
  }
  const baselineVol = mean(nextVols);
  const buckets: LeverageBucket[] = BUCKETS.map((b) => {
    const vols: number[] = [];
    for (let k = 0; k < rets.length; k++) if (rets[k] >= b.lo && rets[k] < b.hi) vols.push(nextVols[k]);
    return { label: b.label, n: vols.length, nextVol: mean(vols) };
  });
  // Pearson相関
  const mr = mean(rets), mv = mean(nextVols);
  let cov = 0, vr = 0, vv = 0;
  for (let k = 0; k < rets.length; k++) {
    cov += (rets[k] - mr) * (nextVols[k] - mv);
    vr += (rets[k] - mr) ** 2;
    vv += (nextVols[k] - mv) ** 2;
  }
  const corr = vr > 0 && vv > 0 ? cov / Math.sqrt(vr * vv) : 0;
  return { buckets, corr, baselineVol };
}
