// D3: 日足シグナル発生『翌日』の日中の動き。日足の状態（RSI過熱・大陽線・ギャップ）が
// 出た翌営業日の日中経路を集計し、最適なエントリー時刻・エントリールールを比較する。
// 日足は日中足から日次OHLCを再構成して算出（追加フェッチ不要）。

import {
  IntradayBar, groupByDay, buildBinGrid, binIndexOfMinute, localMinute, meanOf, DayData,
} from "./intraday-core";

export type SignalKey = "rsiOversold" | "rsiOverbought" | "bigBull" | "gapUp";

export const SIGNAL_LABELS: Record<SignalKey, string> = {
  rsiOversold: "RSI(14)<30（売られ過ぎ）",
  rsiOverbought: "RSI(14)>70（買われ過ぎ）",
  bigBull: "前日が大陽線",
  gapUp: "前日にギャップアップ",
};

export interface SignalEntryRule { label: string; meanRetPct: number; winRate: number; n: number; }
export interface SignalIntradayResult {
  signal: SignalKey;
  nSignals: number;
  binLabels: string[];
  avgPathPct: number[]; // 翌日 始値比% 平均プロファイル
  paths: number[][];    // 個別翌日の正規化経路（spaghetti用）
  entryRules: SignalEntryRule[];
  bestEntryLabel: string;
}

function rsi(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch >= 0 ? ch : 0, l = ch < 0 ? -ch : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

// 経過elapsed分の時点に最も近いバーの終値を返す
function priceAfter(day: DayData, gmtoffset: number, elapsedMin: number): number | null {
  const start = localMinute(day.bars[0].ts, gmtoffset);
  for (const b of day.bars) {
    if (localMinute(b.ts, gmtoffset) - start >= elapsedMin) return b.close;
  }
  return null;
}

export function computeSignalIntraday(
  bars: IntradayBar[], gmtoffset: number, signal: SignalKey, binMinutes = 30
): SignalIntradayResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length < 20) return null;

  const closes = days.map((d) => d.close);
  const rsiArr = rsi(closes, 14);

  // シグナル発生日 i を判定 → 翌日 i+1 を対象に
  const signalDays: number[] = [];
  for (let i = 1; i < days.length - 1; i++) {
    const d = days[i];
    const dayRet = d.open > 0 ? (d.close - d.open) / d.open : 0;
    let hit = false;
    if (signal === "rsiOversold") hit = rsiArr[i] < 30;
    else if (signal === "rsiOverbought") hit = rsiArr[i] > 70;
    else if (signal === "bigBull") hit = dayRet > 0.02;
    else if (signal === "gapUp") hit = !isNaN(d.gap) && d.gap > 0.005;
    if (hit) signalDays.push(i + 1);
  }
  if (signalDays.length < 3) return null;

  const grid = buildBinGrid(bars, gmtoffset, binMinutes);
  if (!grid) return null;
  const nBins = grid.bins.length;

  // 各シグナル翌日の正規化経路（ビン終値ベース）
  const paths: number[][] = [];
  const binAcc = new Array(nBins).fill(0);
  const binCnt = new Array(nBins).fill(0);
  const openToClose: number[] = [], after30: number[] = [], after60: number[] = [];

  for (const di of signalDays) {
    const day = days[di];
    const o = day.open;
    if (o <= 0 || day.bars.length < 3) continue;
    // ビンごとの最終終値で経路化
    const lastInBin = new Array(nBins).fill(NaN);
    for (const b of day.bars) {
      const idx = binIndexOfMinute(localMinute(b.ts, gmtoffset), grid);
      lastInBin[idx] = b.close;
    }
    const path: number[] = [];
    let prev = o;
    for (let i = 0; i < nBins; i++) {
      const px = isNaN(lastInBin[i]) ? prev : lastInBin[i];
      prev = px;
      const v = ((px - o) / o) * 100;
      path.push(v);
      binAcc[i] += v; binCnt[i] += 1;
    }
    paths.push(path);

    const closeP = day.close;
    openToClose.push(((closeP - o) / o) * 100);
    const p30 = priceAfter(day, gmtoffset, 30);
    if (p30 && p30 > 0) after30.push(((closeP - p30) / p30) * 100);
    const p60 = priceAfter(day, gmtoffset, 60);
    if (p60 && p60 > 0) after60.push(((closeP - p60) / p60) * 100);
  }

  const avgPathPct = binAcc.map((s, i) => (binCnt[i] ? s / binCnt[i] : 0));

  const ruleOf = (label: string, arr: number[]): SignalEntryRule => ({
    label,
    meanRetPct: meanOf(arr),
    winRate: arr.length ? arr.filter((v) => v > 0).length / arr.length : 0,
    n: arr.length,
  });
  const entryRules = [
    ruleOf("寄り成り→引け", openToClose),
    ruleOf("寄り30分後→引け", after30),
    ruleOf("寄り60分後→引け", after60),
  ];
  const best = entryRules.reduce((a, b) => (b.meanRetPct > a.meanRetPct ? b : a), entryRules[0]);

  return {
    signal,
    nSignals: paths.length,
    binLabels: grid.bins.map((b) => b.label),
    avgPathPct,
    paths,
    entryRules,
    bestEntryLabel: best.label,
  };
}
