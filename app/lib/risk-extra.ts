// 7.1/7.2/7.4 リスク拡充。
// ドローダウン・エピソード（深さ・継続・回復日数）、リスク調整指標の拡充、下方リスク分解。

import { PricePoint } from "./types";

function simpleReturns(prices: PricePoint[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1].close > 0) r.push(prices[i].close / prices[i - 1].close - 1);
  }
  return r;
}
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---- 7.1 ドローダウン・エピソード ----
export interface DDEpisode { depth: number; duration: number; recovery: number; recovered: boolean; }

export function drawdownEpisodes(prices: PricePoint[]): DDEpisode[] {
  const eps: DDEpisode[] = [];
  let peak = prices[0]?.close ?? 0;
  let peakIdx = 0, troughIdx = 0, troughVal = peak;
  let inDD = false;
  for (let i = 1; i < prices.length; i++) {
    const c = prices[i].close;
    if (c >= peak) {
      if (inDD) {
        eps.push({
          depth: (troughVal - peak) / peak,
          duration: troughIdx - peakIdx,
          recovery: i - troughIdx,
          recovered: true,
        });
        inDD = false;
      }
      peak = c; peakIdx = i; troughVal = c; troughIdx = i;
    } else {
      if (!inDD) { inDD = true; troughVal = c; troughIdx = i; }
      else if (c < troughVal) { troughVal = c; troughIdx = i; }
    }
  }
  if (inDD) eps.push({ depth: (troughVal - peak) / peak, duration: troughIdx - peakIdx, recovery: prices.length - 1 - troughIdx, recovered: false });
  return eps;
}

// ---- 7.2 リスク調整指標 ----
export interface RiskRatios {
  sortino: number; calmar: number; sterling: number; omega: number;
  ulcer: number; painRatio: number; tailRatio: number; rachev: number;
  annReturn: number; maxDD: number;
}

export function riskRatios(prices: PricePoint[]): RiskRatios | null {
  const r = simpleReturns(prices);
  if (r.length < 30) return null;
  const ann = Math.sqrt(252);
  const mu = mean(r);
  const annReturn = mu * 252;
  const downside = r.filter((x) => x < 0);
  const dd = Math.sqrt(mean(downside.map((x) => x * x)));
  const sortino = dd > 0 ? (mu / dd) * ann : 0;

  // ドローダウン系列
  let peak = -Infinity; const ddSeries: number[] = [];
  let eq = 1;
  const eqs: number[] = [];
  for (const x of r) { eq *= 1 + x; eqs.push(eq); peak = Math.max(peak, eq); ddSeries.push((eq - peak) / peak); }
  const maxDD = Math.abs(Math.min(...ddSeries));
  const calmar = maxDD > 0 ? annReturn / maxDD : 0;

  // Sterling: 上位N大DDの平均
  const eps = drawdownEpisodes(prices).map((e) => Math.abs(e.depth)).sort((a, b) => b - a);
  const topDD = eps.slice(0, 5);
  const avgDD = topDD.length ? mean(topDD) : maxDD;
  const sterling = avgDD > 0 ? annReturn / avgDD : 0;

  // Omega(τ=0)
  const gains = r.filter((x) => x > 0).reduce((s, x) => s + x, 0);
  const losses = -r.filter((x) => x < 0).reduce((s, x) => s + x, 0);
  const omega = losses > 0 ? gains / losses : 0;

  // Ulcer / Pain
  const ulcer = Math.sqrt(mean(ddSeries.map((d) => d * d)));
  const painIndex = mean(ddSeries.map((d) => Math.abs(d)));
  const painRatio = painIndex > 0 ? annReturn / painIndex : 0;

  // Tail ratio
  const sorted = [...r].sort((a, b) => a - b);
  const q95 = quantile(sorted, 0.95), q05 = quantile(sorted, 0.05);
  const tailRatio = q05 !== 0 ? Math.abs(q95) / Math.abs(q05) : 0;

  // Rachev: 上位5%平均 / 下位5%平均（絶対値）
  const tail = Math.max(1, Math.floor(r.length * 0.05));
  const lowMean = Math.abs(mean(sorted.slice(0, tail)));
  const highMean = Math.abs(mean(sorted.slice(-tail)));
  const rachev = lowMean > 0 ? highMean / lowMean : 0;

  return { sortino, calmar, sterling, omega, ulcer, painRatio, tailRatio, rachev, annReturn, maxDD };
}

// ---- 7.4 下方リスク分解 ----
export interface DownsideDecomp {
  semiDev: number; // 半偏差(年率)
  lossDayShare: number; // 損失日数の割合
  lossContribution: number; // 負リターン合計 / 全|リターン|合計
  worstStreak: number; // 最長連敗
  streakHist: { len: number; count: number }[];
}

export function downsideDecomp(prices: PricePoint[]): DownsideDecomp | null {
  const r = simpleReturns(prices);
  if (r.length < 30) return null;
  const downside = r.filter((x) => x < 0);
  const semiDev = Math.sqrt(mean(downside.map((x) => x * x))) * Math.sqrt(252);
  const lossDayShare = downside.length / r.length;
  const negSum = -downside.reduce((s, x) => s + x, 0);
  const absSum = r.reduce((s, x) => s + Math.abs(x), 0);
  const lossContribution = absSum > 0 ? negSum / absSum : 0;

  const streaks: number[] = [];
  let cur = 0;
  for (const x of r) {
    if (x < 0) cur++;
    else { if (cur > 0) streaks.push(cur); cur = 0; }
  }
  if (cur > 0) streaks.push(cur);
  const worstStreak = streaks.length ? Math.max(...streaks) : 0;
  const histMap = new Map<number, number>();
  for (const s of streaks) histMap.set(s, (histMap.get(s) ?? 0) + 1);
  const streakHist = [...histMap.entries()].sort((a, b) => a[0] - b[0]).map(([len, count]) => ({ len, count }));

  return { semiDev, lossDayShare, lossContribution, worstStreak, streakHist };
}
