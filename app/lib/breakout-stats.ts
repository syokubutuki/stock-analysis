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

// ブレイク後 horizon 日だけ建てる戦略の建玉ベクトル q_t ∈ {0,1} を作る。
// 上抜け(side="up")なら買い持ち、下抜け(side="down")なら売り持ち（q=−1）。
// シグナルが重なった場合は積み増さず、保有期間だけ延長する（ピラミッディングなし）。
//
// これを StrategyVsBenchmark の positions モードに渡すと、往復回数が実測できるので
// 「ブレイク戦略は往復が多い」という定性的な注記を、コスト実額として出せる。
// 先読み回避: ブレイク判定は i 日の高安で確定するが、約定は i 日の引けとみなし、
// 損益に効くのは i+1 日以降の終値変化とする（q は i 日に立てて i+1 から効く）。
export function donchianPositions(
  prices: PricePoint[],
  lookback: number,
  horizon: number,
  side: "up" | "down"
): number[] {
  const n = prices.length;
  const q = new Array(n).fill(0);
  if (n === 0 || lookback < 1 || horizon < 1) return q;
  const target = side === "up" ? 1 : -1;

  for (let i = lookback; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - lookback; j < i; j++) {
      hh = Math.max(hh, prices[j].high);
      ll = Math.min(ll, prices[j].low);
    }
    const broke = side === "up" ? prices[i].high > hh : prices[i].low < ll;
    if (!broke) continue;
    // i 日の引けで建て、以降 horizon 日保有（重複は延長として上書き）
    for (let k = i; k < Math.min(n, i + horizon); k++) q[k] = target;
  }
  return q;
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
