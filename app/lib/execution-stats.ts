// 13.2/13.3 執行統計。ストップ方式の比較とトレード期待値・R倍数分布。
// 当日引けでロングし、各ストップ方式で手仕舞った場合の期待値を総当たりで評価する。

import { PricePoint } from "./types";

function computeATR(prices: PricePoint[], period = 14): number[] {
  const n = prices.length;
  const tr: number[] = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(prices[i].high - prices[i].low, Math.abs(prices[i].high - prices[i - 1].close), Math.abs(prices[i].low - prices[i - 1].close));
  }
  const atr: number[] = new Array(n).fill(NaN);
  let sum = 0, cnt = 0;
  for (let i = 1; i < n; i++) {
    if (isNaN(tr[i])) continue;
    if (cnt < period) { sum += tr[i]; cnt++; if (cnt === period) atr[i] = sum / period; }
    else atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

export type StopMethod = "fixed" | "atr" | "chandelier" | "trailing";
export interface StopStat { method: StopMethod; label: string; expReturn: number; winRate: number; avgHold: number; n: number; }

const FIXED_PCT = 0.05, ATR_MULT = 2, CHAND_MULT = 3, TRAIL_PCT = 0.08;

export function stopComparison(prices: PricePoint[], maxHold = 20): StopStat[] {
  const n = prices.length;
  const atr = computeATR(prices);
  const methods: StopMethod[] = ["fixed", "atr", "chandelier", "trailing"];
  const labels: Record<StopMethod, string> = { fixed: "固定%(-5%)", atr: "ATR(-2ATR)", chandelier: "シャンデリア(-3ATR)", trailing: "トレーリング%(-8%)" };

  return methods.map((m) => {
    const rets: number[] = [], holds: number[] = [];
    for (let i = 200; i < n - maxHold; i++) {
      const e = prices[i].close;
      if (!(e > 0) || isNaN(atr[i])) continue;
      let exitRet = (prices[i + maxHold].close - e) / e, held = maxHold;
      let hh = prices[i].high;
      for (let k = 1; k <= maxHold; k++) {
        const bar = prices[i + k];
        hh = Math.max(hh, bar.high);
        let stop: number;
        if (m === "fixed") stop = e * (1 - FIXED_PCT);
        else if (m === "atr") stop = e - ATR_MULT * atr[i];
        else if (m === "chandelier") stop = hh - CHAND_MULT * atr[i];
        else stop = hh * (1 - TRAIL_PCT);
        if (bar.low <= stop) { exitRet = (stop - e) / e; held = k; break; }
      }
      rets.push(exitRet); holds.push(held);
    }
    return { method: m, label: labels[m], expReturn: mean(rets), winRate: rets.length ? rets.filter((r) => r > 0).length / rets.length : 0, avgHold: mean(holds), n: rets.length };
  });
}

// 13.3 R倍数分布（ATRストップ基準, risk=ATR_MULT*ATR）
export interface RMultipleResult {
  rs: number[];
  expectancyR: number; winRate: number;
  avgWinR: number; avgLossR: number; n: number;
  meanCostR: number; // 1トレードあたりのコスト（R単位）。costRT=0 なら 0
}

// costRT: 往復コスト（比率）。R 単位では建値 P と リスク幅 risk=ATR_MULT·ATR の比で効く:
//   コストの金額 = costRT · P  →  R 単位では costRT · P / risk
// リスク幅は ATR に比例するので、低ボラ銘柄・低ボラ局面ほどコストの R 換算が重くなる。
// これが「R 倍数はコストに対して一様でない」理由であり、平均を引くだけでは足りない。
export function rMultiples(prices: PricePoint[], maxHold = 20, costRT = 0): RMultipleResult | null {
  const n = prices.length;
  const atr = computeATR(prices);
  const rs: number[] = [];
  const costRs: number[] = [];
  for (let i = 200; i < n - maxHold; i++) {
    const e = prices[i].close;
    if (!(e > 0) || isNaN(atr[i]) || atr[i] <= 0) continue;
    const risk = ATR_MULT * atr[i];
    const stop = e - risk;
    let pnl = prices[i + maxHold].close - e;
    for (let k = 1; k <= maxHold; k++) {
      if (prices[i + k].low <= stop) { pnl = stop - e; break; }
    }
    // 往復コストは建値に比例する金額なので、R 換算してから引く
    const costR = costRT > 0 ? (costRT * e) / risk : 0;
    costRs.push(costR);
    rs.push(pnl / risk - costR);
  }
  if (rs.length < 10) return null;
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
  return {
    rs, expectancyR: mean(rs), winRate: wins.length / rs.length,
    avgWinR: mean(wins), avgLossR: mean(losses), n: rs.length,
    meanCostR: costRs.length ? mean(costRs) : 0,
  };
}
