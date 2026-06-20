// 8.1 オーバーナイト vs 日中のリターン分解。
// 日次リターンを「夜間（前日終値→当日始値＝持ち越し区間）」と「日中（当日始値→当日終値）」に分け、
// それぞれを毎日複利で積み上げたエクイティと、リスク寄与を比較する。
// 多くの株価指数で“夜間にリターンが集中する”オーバーナイト・ドリフト異常が知られる。

import { PricePoint } from "./types";

export interface DecompPoint {
  time: string;
  overnight: number; // 累積エクイティ（初期=1）
  intraday: number;
  buyhold: number;
}

export interface DecompStats {
  cumOvernight: number; // 最終累積（−1して総リターン）
  cumIntraday: number;
  cumBuyhold: number;
  sharpeOvernight: number; // 年率
  sharpeIntraday: number;
  winOvernight: number;
  winIntraday: number;
  volShareOvernight: number; // 夜間分散 / (夜間+日中)分散
}

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function variance(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1);
}

// dailyCost: 夜間/日中それぞれ1日1往復として控除する取引コスト（割合, フルスプレッド）。
export function decomposeEquity(
  prices: PricePoint[],
  dailyCost = 0
): { series: DecompPoint[]; stats: DecompStats } {
  const onR: number[] = [];
  const idR: number[] = [];
  const series: DecompPoint[] = [];
  let eqOn = 1, eqId = 1, eqBh = 1;
  // 初日は基準
  if (prices.length > 0) {
    series.push({ time: prices[0].time, overnight: 1, intraday: 1, buyhold: 1 });
  }
  for (let i = 1; i < prices.length; i++) {
    const prevC = prices[i - 1].close;
    const o = prices[i].open;
    const c = prices[i].close;
    if (!(prevC > 0) || !(o > 0) || !(c > 0)) {
      series.push({ time: prices[i].time, overnight: eqOn, intraday: eqId, buyhold: eqBh });
      continue;
    }
    const on = (o - prevC) / prevC - dailyCost; // 夜間（コスト控除後）
    const id = (c - o) / o - dailyCost; // 日中（コスト控除後）
    onR.push(on);
    idR.push(id);
    eqOn *= 1 + on;
    eqId *= 1 + id;
    eqBh *= c / prevC;
    series.push({ time: prices[i].time, overnight: eqOn, intraday: eqId, buyhold: eqBh });
  }

  const vOn = variance(onR);
  const vId = variance(idR);
  const sharpe = (arr: number[]) => {
    const sd = Math.sqrt(variance(arr));
    return sd > 0 ? (mean(arr) / sd) * Math.sqrt(252) : 0;
  };
  const stats: DecompStats = {
    cumOvernight: eqOn,
    cumIntraday: eqId,
    cumBuyhold: eqBh,
    sharpeOvernight: sharpe(onR),
    sharpeIntraday: sharpe(idR),
    winOvernight: onR.length ? onR.filter((r) => r > 0).length / onR.length : 0,
    winIntraday: idR.length ? idR.filter((r) => r > 0).length / idR.length : 0,
    volShareOvernight: vOn + vId > 0 ? vOn / (vOn + vId) : 0,
  };
  return { series, stats };
}
