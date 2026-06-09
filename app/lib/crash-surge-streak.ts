// 連続暴落・暴騰ラン分析ライブラリ
// 前日終値比で下落/上昇が連続する区間を1つの「ラン」として抽出し、
//  - 連続日数の時系列分布 / ヒストグラム
//  - ラン累積率（暴落率・暴騰率）の分布
//  - ラン進行に伴う累積率の平均推移
//  - ラン終了後 N 日の値動き（Closeベース・Openベースを併記）
// を計算する。

import { PricePoint } from "./types";

export type StreakDirection = "down" | "up";

// ========== ヘルパー ==========

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
function stddev(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
}
function median(v: number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function winRate(v: number[]): number {
  if (v.length === 0) return 0;
  return v.filter((x) => x > 0).length / v.length;
}

// ========== ラン抽出 ==========

export interface Run {
  startIndex: number; // ラン最初の「動いた日」のインデックス
  endIndex: number; // ラン最後の「動いた日」のインデックス
  length: number; // 連続日数
  cumReturn: number; // close_end / close_{start-1} - 1 （区間の累積リターン）
  startDate: string;
  endDate: string;
}

// 前日終値比のリターン列を作り、同符号が連続する区間をランとして返す
export function detectRuns(prices: PricePoint[], dir: StreakDirection): Run[] {
  const runs: Run[] = [];
  const n = prices.length;
  if (n < 2) return runs;

  let i = 1;
  while (i < n) {
    const r = prices[i].close / prices[i - 1].close - 1;
    const isMatch = dir === "down" ? r < 0 : r > 0;
    if (!isMatch) {
      i++;
      continue;
    }
    // ラン開始: 動いた日 i から、同符号が続く限り進める
    const start = i;
    let end = i;
    let j = i + 1;
    while (j < n) {
      const rj = prices[j].close / prices[j - 1].close - 1;
      const matchJ = dir === "down" ? rj < 0 : rj > 0;
      if (!matchJ) break;
      end = j;
      j++;
    }
    const base = prices[start - 1].close; // ラン直前の終値
    const cumReturn = base > 0 ? prices[end].close / base - 1 : 0;
    runs.push({
      startIndex: start,
      endIndex: end,
      length: end - start + 1,
      cumReturn,
      startDate: prices[start].time,
      endDate: prices[end].time,
    });
    i = j;
  }
  return runs;
}

// ========== 各種集計 ==========

export interface LengthBin {
  length: number;
  count: number;
}

export interface RateBin {
  low: number; // 累積率の下端
  high: number;
  downCount: number;
  upCount: number;
}

export interface PathPoint {
  day: number; // ラン内 1..maxLen
  meanCum: number; // 平均累積率
  medianCum: number;
  n: number; // この日まで到達したラン数
}

export interface ForwardPoint {
  day: number; // ラン終了日からの経過営業日 0..N
  closeMean: number;
  closeMedian: number;
  closeStd: number;
  closeWin: number;
  nClose: number;
  openMean: number;
  openMedian: number;
  openStd: number;
  openWin: number;
  nOpen: number;
}

export interface StreakAnalysis {
  downRuns: Run[]; // 閾値を満たす下落ラン（暴落）
  upRuns: Run[]; // 閾値を満たす上昇ラン（暴騰）
  allDownCount: number; // 閾値前の全下落ラン数
  allUpCount: number;
  downLenHist: LengthBin[];
  upLenHist: LengthBin[];
  maxLength: number;
  rateBins: RateBin[];
  downPath: PathPoint[];
  upPath: PathPoint[];
  downForward: ForwardPoint[];
  upForward: ForwardPoint[];
  threshold: number;
  horizon: number;
  // サマリ
  downMeanLen: number;
  upMeanLen: number;
  downMeanRate: number;
  upMeanRate: number;
  downMaxRate: number; // 最大の暴落（最小cumReturn）
  upMaxRate: number; // 最大の暴騰
}

// ラン内累積率の平均推移
function computePath(prices: PricePoint[], runs: Run[]): PathPoint[] {
  if (runs.length === 0) return [];
  const maxLen = Math.max(...runs.map((r) => r.length));
  const path: PathPoint[] = [];
  for (let k = 1; k <= maxLen; k++) {
    const vals: number[] = [];
    for (const run of runs) {
      if (run.length < k) continue;
      const base = prices[run.startIndex - 1].close;
      const idx = run.startIndex - 1 + k; // k日進んだ終値
      if (base > 0 && idx < prices.length) {
        vals.push(prices[idx].close / base - 1);
      }
    }
    if (vals.length > 0) {
      path.push({ day: k, meanCum: mean(vals), medianCum: median(vals), n: vals.length });
    }
  }
  return path;
}

// ラン終了後 N 日の値動き（Close: 終了日終値起点 / Open: 翌日始値起点）
function computeForward(
  prices: PricePoint[],
  runs: Run[],
  horizon: number
): ForwardPoint[] {
  const n = prices.length;
  const out: ForwardPoint[] = [];
  for (let d = 0; d <= horizon; d++) {
    const closeVals: number[] = [];
    const openVals: number[] = [];
    for (const run of runs) {
      const e = run.endIndex;
      // Close: 起点 = 終了日終値 close_e、d日後 = close_{e+d}
      const baseClose = prices[e].close;
      if (baseClose > 0 && e + d < n) {
        closeVals.push(prices[e + d].close / baseClose - 1);
      }
      // Open: 起点 = 翌営業日始値 open_{e+1}、d日後 = open_{e+d}（d>=1）
      if (d >= 1 && e + 1 < n) {
        const baseOpen = prices[e + 1].open;
        if (baseOpen > 0 && e + d < n) {
          openVals.push(prices[e + d].open / baseOpen - 1);
        }
      }
    }
    out.push({
      day: d,
      closeMean: mean(closeVals),
      closeMedian: median(closeVals),
      closeStd: stddev(closeVals),
      closeWin: winRate(closeVals),
      nClose: closeVals.length,
      openMean: d >= 1 ? mean(openVals) : 0,
      openMedian: d >= 1 ? median(openVals) : 0,
      openStd: d >= 1 ? stddev(openVals) : 0,
      openWin: d >= 1 ? winRate(openVals) : 0,
      nOpen: openVals.length,
    });
  }
  return out;
}

function lengthHist(runs: Run[], maxLen: number): LengthBin[] {
  const bins: LengthBin[] = [];
  for (let k = 1; k <= maxLen; k++) {
    bins.push({ length: k, count: runs.filter((r) => r.length === k).length });
  }
  return bins;
}

// メイン: threshold = ランを暴落/暴騰イベントとみなす累積率の絶対値（例 0.03 = 3%）
export function analyzeStreaks(
  prices: PricePoint[],
  threshold: number,
  horizon: number
): StreakAnalysis | null {
  if (prices.length < 30) return null;

  const allDown = detectRuns(prices, "down");
  const allUp = detectRuns(prices, "up");

  const downRuns = allDown.filter((r) => Math.abs(r.cumReturn) >= threshold);
  const upRuns = allUp.filter((r) => r.cumReturn >= threshold);

  const maxLength = Math.max(
    1,
    ...downRuns.map((r) => r.length),
    ...upRuns.map((r) => r.length)
  );

  // 率分布の共通ビン（0を中心に対称）
  const allRates = [
    ...downRuns.map((r) => r.cumReturn),
    ...upRuns.map((r) => r.cumReturn),
  ];
  const rateBins: RateBin[] = [];
  if (allRates.length > 0) {
    const maxAbs = Math.max(threshold, ...allRates.map((r) => Math.abs(r)));
    const nBins = 31; // 奇数: 中央ビンが0をまたぐ
    const binW = (2 * maxAbs) / nBins;
    for (let b = 0; b < nBins; b++) {
      const low = -maxAbs + b * binW;
      const high = low + binW;
      rateBins.push({
        low,
        high,
        downCount: downRuns.filter((r) => r.cumReturn >= low && r.cumReturn < high).length,
        upCount: upRuns.filter((r) => r.cumReturn >= low && r.cumReturn < high).length,
      });
    }
  }

  const downCum = downRuns.map((r) => r.cumReturn);
  const upCum = upRuns.map((r) => r.cumReturn);

  return {
    downRuns,
    upRuns,
    allDownCount: allDown.length,
    allUpCount: allUp.length,
    downLenHist: lengthHist(downRuns, maxLength),
    upLenHist: lengthHist(upRuns, maxLength),
    maxLength,
    rateBins,
    downPath: computePath(prices, downRuns),
    upPath: computePath(prices, upRuns),
    downForward: computeForward(prices, downRuns, horizon),
    upForward: computeForward(prices, upRuns, horizon),
    threshold,
    horizon,
    downMeanLen: mean(downRuns.map((r) => r.length)),
    upMeanLen: mean(upRuns.map((r) => r.length)),
    downMeanRate: mean(downCum),
    upMeanRate: mean(upCum),
    downMaxRate: downCum.length ? Math.min(...downCum) : 0,
    upMaxRate: upCum.length ? Math.max(...upCum) : 0,
  };
}
