// OHLCをフル活用したボラティリティ推定量の比較。
// 終値間（close-to-close）法は1日1点しか使わず分散が大きい。高値・安値・始値を使う
// Parkinson / Garman-Klass / Rogers-Satchell / Yang-Zhang はより効率的（同じσを少ない分散で推定）。
// Yang-Zhang は窓（オーバーナイトギャップ）も取り込むため日足では最も推奨される。

import { PricePoint } from "./types";

export interface VolEstimates {
  close: number; // 終値間 σ
  parkinson: number;
  gk: number; // Garman-Klass
  rs: number; // Rogers-Satchell
  yangZhang: number;
}

export interface VolSeriesPoint {
  time: string;
  est: VolEstimates;
}

const TRADING_DAYS = 252;
const LN2 = Math.log(2);

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function variance(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1);
}

// 1本ぶんの各種「分散寄与」。窓 window 本を平均して年率σにする。
interface BarTerms {
  cc: number; // (ln C_t/C_{t-1})^2   終値間
  park: number; // (ln H/L)^2
  gk: number; // 0.5(ln H/L)^2 - (2ln2-1)(ln C/O)^2
  rs: number; // ln(H/C)ln(H/O)+ln(L/C)ln(L/O)
  on: number; // overnight (ln O_t/C_{t-1}) — 平均からの偏差用に生値
  oc: number; // open-close (ln C_t/O_t)
}

function barTerms(prices: PricePoint[]): (BarTerms | null)[] {
  return prices.map((p, i) => {
    const { open: O, high: H, low: L, close: C } = p;
    if (!(O > 0 && H > 0 && L > 0 && C > 0)) return null;
    const prevC = i > 0 ? prices[i - 1].close : NaN;
    const lnHL = Math.log(H / L);
    const lnCO = Math.log(C / O);
    const cc = i > 0 && prevC > 0 ? Math.log(C / prevC) ** 2 : NaN;
    return {
      cc,
      park: lnHL ** 2,
      gk: 0.5 * lnHL ** 2 - (2 * LN2 - 1) * lnCO ** 2,
      rs: Math.log(H / C) * Math.log(H / O) + Math.log(L / C) * Math.log(L / O),
      on: i > 0 && prevC > 0 ? Math.log(O / prevC) : NaN,
      oc: lnCO,
    };
  });
}

// 窓内推定（年率σ%）。
function estimateWindow(terms: (BarTerms | null)[], s: number, e: number): VolEstimates | null {
  const seg = terms.slice(s, e + 1).filter((t): t is BarTerms => t !== null);
  if (seg.length < 5) return null;
  const n = seg.length;

  const cc = seg.map((t) => t.cc).filter((v) => !isNaN(v));
  const closeVar = variance(cc); // 終値間（平均回りの分散）
  const parkVar = mean(seg.map((t) => t.park)) / (4 * LN2);
  const gkVar = mean(seg.map((t) => t.gk));
  const rsVar = mean(seg.map((t) => t.rs));

  // Yang-Zhang
  const onVals = seg.map((t) => t.on).filter((v) => !isNaN(v));
  const ocVals = seg.map((t) => t.oc);
  const sigmaOn = variance(onVals);
  const sigmaOc = variance(ocVals);
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  const yzVar = sigmaOn + k * sigmaOc + (1 - k) * rsVar;

  const ann = (v: number) => Math.sqrt(Math.max(0, v) * TRADING_DAYS);
  return {
    close: ann(closeVar),
    parkinson: ann(parkVar),
    gk: ann(gkVar),
    rs: ann(rsVar),
    yangZhang: ann(yzVar),
  };
}

// ローリング年率σ系列。
export function rollingOHLCVol(prices: PricePoint[], window: number): VolSeriesPoint[] {
  const terms = barTerms(prices);
  const out: VolSeriesPoint[] = [];
  for (let i = window; i < prices.length; i++) {
    const est = estimateWindow(terms, i - window + 1, i);
    if (est) out.push({ time: prices[i].time, est });
  }
  return out;
}

// 全期間での各推定量と、終値間法に対する「分散削減率」（= 1 - Var_est/Var_close、σ²換算近似）。
export interface EfficiencyResult {
  whole: VolEstimates;
  // close法のσ²を1とした時の各推定量のσ²比（小さいほど効率的）
  varRatio: Record<keyof VolEstimates, number>;
}

export function wholePeriodVol(prices: PricePoint[]): EfficiencyResult | null {
  const terms = barTerms(prices);
  const whole = estimateWindow(terms, 0, prices.length - 1);
  if (!whole) return null;
  const closeVar = whole.close ** 2 || 1e-12;
  const varRatio: Record<keyof VolEstimates, number> = {
    close: 1,
    parkinson: whole.parkinson ** 2 / closeVar,
    gk: whole.gk ** 2 / closeVar,
    rs: whole.rs ** 2 / closeVar,
    yangZhang: whole.yangZhang ** 2 / closeVar,
  };
  return { whole, varRatio };
}
