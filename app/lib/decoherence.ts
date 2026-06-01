/**
 * Decoherence Detection: 市場パターン崩壊の検出
 * トレンドやレンジなどの市場パターンの「信頼度」をリアルタイム推定し、
 * パターン崩壊（デコヒーレンス）を検知する
 */
import { PricePoint } from "./types";

export interface DecoherencePoint {
  time: string;
  /** パターン信頼度 (0-1) */
  coherence: number;
  /** 自己相関の安定性 */
  acfStability: number;
  /** ボラティリティレジーム安定性 */
  volStability: number;
  /** トレンド安定性 */
  trendStability: number;
  /** デコヒーレンスイベント検出 */
  isBreakdown: boolean;
}

export interface DecoherenceResult {
  data: DecoherencePoint[];
  /** デコヒーレンスイベント発生回数 */
  breakdownCount: number;
  /** 平均コヒーレンス */
  meanCoherence: number;
  /** 現在のコヒーレンス */
  currentCoherence: number;
}

export function computeDecoherence(
  prices: PricePoint[],
  window: number = 60,
  shortWindow: number = 10
): DecoherenceResult {
  const empty: DecoherenceResult = {
    data: [],
    breakdownCount: 0,
    meanCoherence: 0,
    currentCoherence: 0,
  };

  if (prices.length < window + shortWindow) return empty;

  const closes = prices.map((p) => p.close);
  const n = closes.length;

  // 対数リターン
  const lr: number[] = [];
  for (let i = 1; i < n; i++) lr.push(Math.log(closes[i] / closes[i - 1]));

  const data: DecoherencePoint[] = [];

  for (let i = window; i < lr.length; i++) {
    const longWindow = lr.slice(i - window, i);
    const shortWin = lr.slice(i - shortWindow, i);

    // 1. 自己相関安定性: lag-1 ACFの安定度
    const acfLong = lag1ACF(longWindow);
    const acfShort = lag1ACF(shortWin);
    const acfStability = 1 - Math.min(1, Math.abs(acfLong - acfShort) * 3);

    // 2. ボラティリティ安定性: 短期volと長期volの比の安定度
    const volLong = stddev(longWindow);
    const volShort = stddev(shortWin);
    const volRatio = volLong > 0 ? volShort / volLong : 1;
    const volStability = 1 - Math.min(1, Math.abs(volRatio - 1) * 2);

    // 3. トレンド安定性: 短期と長期のトレンド方向の一致度
    const trendLong = mean(longWindow);
    const trendShort = mean(shortWin);
    const trendSign = trendLong * trendShort >= 0 ? 1 : 0;
    const trendMag = volLong > 0 ? Math.min(1, Math.abs(trendShort - trendLong) / volLong) : 0;
    const trendStability = trendSign * (1 - trendMag);

    // 総合コヒーレンス（3指標の重み付き平均）
    const coherence = 0.3 * acfStability + 0.4 * volStability + 0.3 * trendStability;

    // デコヒーレンスイベント: コヒーレンスが急落
    const isBreakdown =
      coherence < 0.3 &&
      data.length > 0 &&
      data[data.length - 1].coherence > 0.5;

    data.push({
      time: prices[i + 1].time,
      coherence,
      acfStability,
      volStability,
      trendStability,
      isBreakdown,
    });
  }

  const breakdownCount = data.filter((d) => d.isBreakdown).length;
  const meanCoherence =
    data.length > 0 ? data.reduce((s, d) => s + d.coherence, 0) / data.length : 0;
  const currentCoherence = data.length > 0 ? data[data.length - 1].coherence : 0;

  return { data, breakdownCount, meanCoherence, currentCoherence };
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) ** 2;
  return Math.sqrt(s / (arr.length - 1));
}

function lag1ACF(arr: number[]): number {
  if (arr.length < 3) return 0;
  const m = mean(arr);
  let num = 0, den = 0;
  for (let i = 1; i < arr.length; i++) {
    num += (arr[i] - m) * (arr[i - 1] - m);
  }
  for (let i = 0; i < arr.length; i++) {
    den += (arr[i] - m) ** 2;
  }
  return den > 0 ? num / den : 0;
}
