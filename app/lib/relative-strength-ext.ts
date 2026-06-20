// 11.2/11.3/11.4 相対力の拡張。
// アップ/ダウン・キャプチャ比、共和分ペア(Engle-Granger)、ローリング相関・β・リードラグ。

import { PricePoint } from "./types";
import { alignSeries } from "./benchmark";
import { adfTest } from "./unit-root";

function rets(p: PricePoint[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < p.length; i++) r.push(p[i - 1].close > 0 ? p[i].close / p[i - 1].close - 1 : 0);
  return r;
}
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function corr(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = mean(xs.slice(0, n)), my = mean(ys.slice(0, n));
  let c = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { c += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
  return vx > 0 && vy > 0 ? c / Math.sqrt(vx * vy) : 0;
}

// ---- 11.2 アップ/ダウン・キャプチャ ----
export interface CaptureResult {
  upCapture: number; downCapture: number; captureRatio: number; nUp: number; nDown: number;
}
export function upDownCapture(stock: PricePoint[], bench: PricePoint[]): CaptureResult | null {
  const { stock: s, bench: b } = alignSeries(stock, bench);
  if (s.length < 30) return null;
  const rs = rets(s), rb = rets(b);
  const upS: number[] = [], upB: number[] = [], dnS: number[] = [], dnB: number[] = [];
  for (let i = 0; i < rs.length; i++) {
    if (rb[i] > 0) { upS.push(rs[i]); upB.push(rb[i]); }
    else if (rb[i] < 0) { dnS.push(rs[i]); dnB.push(rb[i]); }
  }
  const upCapture = mean(upB) !== 0 ? mean(upS) / mean(upB) : 0;
  const downCapture = mean(dnB) !== 0 ? mean(dnS) / mean(dnB) : 0;
  return { upCapture, downCapture, captureRatio: downCapture !== 0 ? upCapture / downCapture : 0, nUp: upS.length, nDown: dnS.length };
}

// ---- 11.3 共和分ペア (Engle-Granger) ----
export interface CointResult {
  beta: number; alpha: number;
  adfStat: number; adfCrit: number; cointegrated: boolean;
  halfLife: number; currentZ: number;
  spread: { time: string; z: number }[];
}
export function cointegration(stock: PricePoint[], bench: PricePoint[]): CointResult | null {
  const { stock: s, bench: b } = alignSeries(stock, bench);
  if (s.length < 60) return null;
  const ys = s.map((p) => Math.log(p.close));
  const xs = b.map((p) => Math.log(p.close));
  const n = ys.length;
  const mx = mean(xs), my = mean(ys);
  let cov = 0, vx = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; }
  const beta = vx > 0 ? cov / vx : 0;
  const alpha = my - beta * mx;
  const spread = ys.map((y, i) => y - alpha - beta * xs[i]);

  const adf = adfTest(spread);
  const crit5 = adf.criticalValues["5%"];
  // 半減期: Δs_t = λ s_{t-1} の OLS、halfLife=-ln2/ln(1+λ)
  let num = 0, den = 0;
  const ms = mean(spread);
  for (let i = 1; i < n; i++) { const lag = spread[i - 1] - ms; num += lag * (spread[i] - spread[i - 1]); den += lag * lag; }
  const lambda = den > 0 ? num / den : 0;
  const halfLife = lambda < 0 && lambda > -2 ? -Math.log(2) / Math.log(1 + lambda) : NaN;
  const sd = Math.sqrt(mean(spread.map((v) => (v - ms) ** 2))) || 1;
  const zSeries = spread.map((v, i) => ({ time: s[i].time, z: (v - ms) / sd }));

  return {
    beta, alpha,
    adfStat: adf.testStat, adfCrit: crit5,
    cointegrated: adf.testStat < crit5,
    halfLife, currentZ: zSeries[n - 1].z, spread: zSeries,
  };
}

// ---- 11.4 ローリング相関・β・リードラグ ----
export interface RollingRSPoint { time: string; corr: number; beta: number; }
export interface LeadLag { lag: number; corr: number; }
export interface RollingRSResult {
  series: RollingRSPoint[];
  leadLag: LeadLag[];
  peakLag: number; // 正=ベンチが先行
}
export function rollingCorrBeta(stock: PricePoint[], bench: PricePoint[], window = 63): RollingRSResult | null {
  const { stock: s, bench: b } = alignSeries(stock, bench);
  if (s.length < window + 5) return null;
  const rs = rets(s), rb = rets(b);
  const series: RollingRSPoint[] = [];
  for (let end = window; end <= rs.length; end++) {
    const xs = rs.slice(end - window, end), xb = rb.slice(end - window, end);
    const mb = mean(xb), ms = mean(xs);
    let cov = 0, vb = 0;
    for (let i = 0; i < window; i++) { cov += (xs[i] - ms) * (xb[i] - mb); vb += (xb[i] - mb) ** 2; }
    series.push({ time: s[end].time, corr: corr(xs, xb), beta: vb > 0 ? cov / vb : 0 });
  }
  // リードラグ: corr(stock_t, bench_{t-lag})
  const leadLag: LeadLag[] = [];
  for (let lag = -10; lag <= 10; lag++) {
    const a: number[] = [], c: number[] = [];
    for (let i = 0; i < rs.length; i++) {
      const j = i - lag;
      if (j >= 0 && j < rb.length) { a.push(rs[i]); c.push(rb[j]); }
    }
    leadLag.push({ lag, corr: corr(a, c) });
  }
  const peak = leadLag.reduce((best, x) => (Math.abs(x.corr) > Math.abs(best.corr) ? x : best), leadLag[0]);
  return { series, leadLag, peakLag: peak.lag };
}
