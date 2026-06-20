// 1.2 / 6.2 レンジ収縮 → ブレイク。
// ボラの収縮（NR7/inside day/BB幅・ATRの低下）が放れ（ブレイク）に先行するか検証する。
// 各トリガー日の「翌日以降の値幅（=放れの大きさ）」と「方向の追随率」を集計する。

import { PricePoint } from "./types";

export type TriggerType = "NR7" | "WR7" | "inside" | "outside" | "squeeze";

export interface TriggerMarker {
  time: string;
  type: TriggerType;
}

export interface TriggerStat {
  type: TriggerType;
  label: string;
  n: number;
  meanAbsNext: number; // トリガー翌日の|リターン|平均（放れの大きさ）
  upRate: number; // 翌日終値がトリガー日終値より上だった割合
  baselineAbs: number; // 全日の|翌日リターン|平均（比較基準）
}

export interface SqueezeGauge {
  bbPctile: number; // 現在のBB幅の過去内パーセンタイル(0..1)。低いほどスクイーズ
  atrPctile: number;
  isSqueeze: boolean; // どちらかが20%未満
}

export interface RangeContractionResult {
  markers: TriggerMarker[]; // 直近のトリガー（描画用、最大数制限）
  stats: TriggerStat[];
  gauge: SqueezeGauge | null;
}

const LABELS: Record<TriggerType, string> = {
  NR7: "NR7(7日内最小レンジ)",
  WR7: "WR7(7日内最大レンジ)",
  inside: "inside day(内包)",
  outside: "outside day(包み)",
  squeeze: "BB幅スクイーズ(下位20%)",
};

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
function pctileRank(sortedAsc: number[], v: number): number {
  if (sortedAsc.length === 0) return 0.5;
  let lo = 0, hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo / sortedAsc.length;
}

export function analyzeRangeContraction(prices: PricePoint[], maxMarkers = 60): RangeContractionResult {
  const n = prices.length;
  const empty: RangeContractionResult = { markers: [], stats: [], gauge: null };
  if (n < 30) return empty;

  const range = prices.map((p) => p.high - p.low);
  // BB幅 = 4σ(20)/SMA20、ATR(14)
  const closes = prices.map((p) => p.close);
  const bbWidth: number[] = new Array(n).fill(NaN);
  for (let i = 19; i < n; i++) {
    const seg = closes.slice(i - 19, i + 1);
    const m = mean(seg);
    if (m > 0) bbWidth[i] = (4 * std(seg)) / m;
  }
  const tr: number[] = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      prices[i].high - prices[i].low,
      Math.abs(prices[i].high - prices[i - 1].close),
      Math.abs(prices[i].low - prices[i - 1].close)
    );
  }
  const atr: number[] = new Array(n).fill(NaN);
  for (let i = 14; i < n; i++) atr[i] = mean(tr.slice(i - 13, i + 1).filter((v) => !isNaN(v)));

  // 全日の|翌日リターン|（基準）
  const absNextAll: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    if (prices[i].close > 0) absNextAll.push(Math.abs((prices[i + 1].close - prices[i].close) / prices[i].close));
  }
  const baselineAbs = mean(absNextAll);

  // トリガー判定
  const flags: Record<TriggerType, number[]> = { NR7: [], WR7: [], inside: [], outside: [], squeeze: [] };
  const markers: TriggerMarker[] = [];
  const bbSorted = bbWidth.filter((v) => !isNaN(v)).slice().sort((a, b) => a - b);
  const bbThresh = bbSorted.length ? bbSorted[Math.floor(bbSorted.length * 0.2)] : NaN;

  for (let i = 6; i < n - 1; i++) {
    const isNR7 = range[i] === Math.min(...range.slice(i - 6, i + 1));
    const isWR7 = range[i] === Math.max(...range.slice(i - 6, i + 1));
    const isInside = prices[i].high < prices[i - 1].high && prices[i].low > prices[i - 1].low;
    const isOutside = prices[i].high > prices[i - 1].high && prices[i].low < prices[i - 1].low;
    const isSqueeze = !isNaN(bbWidth[i]) && !isNaN(bbThresh) && bbWidth[i] <= bbThresh;
    const add = (t: TriggerType, cond: boolean) => {
      if (!cond) return;
      flags[t].push(i);
    };
    add("NR7", isNR7);
    add("WR7", isWR7);
    add("inside", isInside);
    add("outside", isOutside);
    add("squeeze", isSqueeze);
    // マーカー（NR7/inside/squeeze を主に）
    if (isNR7) markers.push({ time: prices[i].time, type: "NR7" });
    else if (isInside) markers.push({ time: prices[i].time, type: "inside" });
    else if (isSqueeze) markers.push({ time: prices[i].time, type: "squeeze" });
  }

  const stats: TriggerStat[] = (Object.keys(flags) as TriggerType[]).map((t) => {
    const idxs = flags[t];
    const absNext: number[] = [];
    let up = 0;
    for (const i of idxs) {
      if (prices[i].close > 0) {
        absNext.push(Math.abs((prices[i + 1].close - prices[i].close) / prices[i].close));
        if (prices[i + 1].close > prices[i].close) up++;
      }
    }
    return {
      type: t,
      label: LABELS[t],
      n: idxs.length,
      meanAbsNext: mean(absNext),
      upRate: idxs.length ? up / idxs.length : 0,
      baselineAbs,
    };
  });

  // 現在のスクイーズ・ゲージ
  let gauge: SqueezeGauge | null = null;
  const lastBB = bbWidth[n - 1];
  const lastATR = atr[n - 1];
  if (!isNaN(lastBB) && !isNaN(lastATR)) {
    const atrSorted = atr.filter((v) => !isNaN(v)).slice().sort((a, b) => a - b);
    const bbP = pctileRank(bbSorted, lastBB);
    const atrP = pctileRank(atrSorted, lastATR);
    gauge = { bbPctile: bbP, atrPctile: atrP, isSqueeze: bbP < 0.2 || atrP < 0.2 };
  }

  return { markers: markers.slice(-maxMarkers), stats, gauge };
}
