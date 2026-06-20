// 13.1 保有期間別 MFE/MAE → 最適 TP/SL。
// 各エントリー後の値動き経路から、利確(TP)・損切り(SL)の格子ごとの期待値を評価し、
// どこに置けば期待リターンが最大かを見つける。MFE/MAEの分布も併せて出す。

import { PricePoint } from "./types";

export interface TpSlCell {
  tp: number; // ATR倍 or %（unit依存）
  sl: number;
  expReturn: number; // 1トレード平均リターン
  winRate: number;
  expR: number; // 期待R倍数（平均リターン / sl幅）
}

export interface MfeMaePoint {
  hold: number; // 保有日数
  meanMFE: number; // 平均最大含み益
  meanMAE: number; // 平均最大含み損（正値）
}

export interface TpSlResult {
  cells: TpSlCell[];
  tpLevels: number[];
  slLevels: number[];
  best: TpSlCell | null;
  mfeMae: MfeMaePoint[];
  unit: "pct" | "atr";
  nEntries: number;
}

function computeATR(prices: PricePoint[], period = 14): number[] {
  const n = prices.length;
  const tr: number[] = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      prices[i].high - prices[i].low,
      Math.abs(prices[i].high - prices[i - 1].close),
      Math.abs(prices[i].low - prices[i - 1].close)
    );
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

export interface TpSlOptions {
  unit?: "pct" | "atr";
  maxHold?: number;
  entryStep?: number; // エントリーを間引く（計算量削減）
  costPerTrade?: number; // 1トレード(往復)あたりの取引コスト（割合）。各トレードのリターンから控除。
}

export function optimizeTpSl(prices: PricePoint[], opts: TpSlOptions = {}): TpSlResult {
  const unit = opts.unit ?? "atr";
  const maxHold = opts.maxHold ?? 20;
  const step = opts.entryStep ?? 1;
  const cost = opts.costPerTrade ?? 0;
  const n = prices.length;

  const tpLevels = unit === "atr" ? [0.5, 1, 1.5, 2, 2.5, 3, 4, 5] : [0.01, 0.02, 0.03, 0.05, 0.07, 0.1, 0.15, 0.2];
  const slLevels = unit === "atr" ? [0.5, 1, 1.5, 2, 2.5, 3, 4, 5] : [0.01, 0.02, 0.03, 0.05, 0.07, 0.1, 0.15, 0.2];

  const atr = unit === "atr" ? computeATR(prices) : [];

  // エントリー集合
  const entries: number[] = [];
  for (let i = 200; i < n - maxHold; i += step) {
    if (prices[i].close > 0 && (unit === "pct" || !isNaN(atr[i]))) entries.push(i);
  }

  // MFE/MAE（保有日数別、ロング想定: 寄り=当日終値建て）
  const mfeMae: MfeMaePoint[] = [];
  for (let h = 1; h <= maxHold; h++) {
    let sMFE = 0, sMAE = 0, c = 0;
    for (const i of entries) {
      const e = prices[i].close;
      let hi = -Infinity, lo = Infinity;
      for (let k = 1; k <= h; k++) {
        hi = Math.max(hi, prices[i + k].high);
        lo = Math.min(lo, prices[i + k].low);
      }
      sMFE += (hi - e) / e;
      sMAE += (e - lo) / e;
      c++;
    }
    if (c > 0) mfeMae.push({ hold: h, meanMFE: sMFE / c, meanMAE: sMAE / c });
  }

  // TP×SL グリッド
  const cells: TpSlCell[] = [];
  for (const tp of tpLevels) {
    for (const sl of slLevels) {
      let sumRet = 0, wins = 0, c = 0;
      for (const i of entries) {
        const e = prices[i].close;
        const tpPx = unit === "atr" ? e + tp * atr[i] : e * (1 + tp);
        const slPx = unit === "atr" ? e - sl * atr[i] : e * (1 - sl);
        let ret = (prices[Math.min(i + maxHold, n - 1)].close - e) / e; // デフォルト=満了引け
        for (let k = 1; k <= maxHold; k++) {
          const bar = prices[i + k];
          const hitSL = bar.low <= slPx;
          const hitTP = bar.high >= tpPx;
          if (hitSL && hitTP) { ret = (slPx - e) / e; break; } // 同日両ヒットはSL優先（保守的）
          if (hitSL) { ret = (slPx - e) / e; break; }
          if (hitTP) { ret = (tpPx - e) / e; break; }
        }
        ret -= cost; // 取引コスト（往復）控除
        sumRet += ret;
        if (ret > 0) wins++;
        c++;
      }
      const expReturn = c ? sumRet / c : 0;
      const slFrac = unit === "atr" ? (sl * (atr[entries[0]] ?? 0)) / (prices[entries[0]]?.close ?? 1) : sl;
      cells.push({
        tp, sl,
        expReturn,
        winRate: c ? wins / c : 0,
        expR: slFrac > 0 ? expReturn / slFrac : 0,
      });
    }
  }
  const best = cells.reduce<TpSlCell | null>((b, c) => (!b || c.expReturn > b.expReturn ? c : b), null);

  return { cells, tpLevels, slLevels, best, mfeMae, unit, nEntries: entries.length };
}
