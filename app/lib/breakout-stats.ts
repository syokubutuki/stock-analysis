// 6.1/6.3 ブレイクアウト統計。
// ドンチャン・チャネル（N日高値/安値）ブレイク後の追随率・期待値と、
// 前日高値/安値ブレイク後に引けも維持した割合（日足版のだまし率把握）を集計する。

import { PricePoint } from "./types";

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

export interface DonchianStat {
  lookback: number;
  upN: number;
  upFwd: number; // 上抜け後N日先平均リターン
  upHold: number; // 上抜け日に引けも上回った割合
  downN: number;
  downFwd: number; // 下抜け後（符号は下落で正に調整）
  downHold: number;
}

export interface PriorHLStat {
  brokeHighN: number;
  highHoldRate: number; // 前日高値ブレイク日に引けも上回った割合
  highFwd: number;
  brokeLowN: number;
  lowHoldRate: number;
  lowFwd: number;
}

export interface BreakoutResult {
  donchian: DonchianStat[];
  priorHL: PriorHLStat;
  horizon: number;
}

export function computeBreakoutStats(prices: PricePoint[], horizon = 10): BreakoutResult {
  const n = prices.length;
  const lookbacks = [20, 55];
  const donchian: DonchianStat[] = lookbacks.map((lb) => {
    const upFwd: number[] = [], downFwd: number[] = [];
    let upHold = 0, upN = 0, downHold = 0, downN = 0;
    for (let i = lb; i < n - horizon; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - lb; j < i; j++) { hh = Math.max(hh, prices[j].high); ll = Math.min(ll, prices[j].low); }
      const fwd = (prices[i + horizon].close - prices[i].close) / prices[i].close;
      if (prices[i].high > hh) { // 日中で上抜け
        upN++;
        if (prices[i].close > hh) upHold++;
        upFwd.push(fwd);
      }
      if (prices[i].low < ll) {
        downN++;
        if (prices[i].close < ll) downHold++;
        downFwd.push(-fwd); // 下落で正
      }
    }
    return {
      lookback: lb,
      upN, upFwd: mean(upFwd), upHold: upN ? upHold / upN : 0,
      downN, downFwd: mean(downFwd), downHold: downN ? downHold / downN : 0,
    };
  });

  // 前日高安ブレイク
  const highFwd: number[] = [], lowFwd: number[] = [];
  let brokeHighN = 0, highHold = 0, brokeLowN = 0, lowHold = 0;
  for (let i = 1; i < n - horizon; i++) {
    const fwd = (prices[i + horizon].close - prices[i].close) / prices[i].close;
    if (prices[i].high > prices[i - 1].high) {
      brokeHighN++;
      if (prices[i].close > prices[i - 1].high) highHold++;
      highFwd.push(fwd);
    }
    if (prices[i].low < prices[i - 1].low) {
      brokeLowN++;
      if (prices[i].close < prices[i - 1].low) lowHold++;
      lowFwd.push(-fwd);
    }
  }

  return {
    donchian,
    priorHL: {
      brokeHighN, highHoldRate: brokeHighN ? highHold / brokeHighN : 0, highFwd: mean(highFwd),
      brokeLowN, lowHoldRate: brokeLowN ? lowHold / brokeLowN : 0, lowFwd: mean(lowFwd),
    },
    horizon,
  };
}
