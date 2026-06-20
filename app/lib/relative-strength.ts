// 11.1 相対力（レシオ）と RSモメンタム。
// 銘柄とベンチマーク（指数等）の比率を取り、市場をアウトパフォームしているかを見る。
// RSライン（比率）が右肩上がり＝相対的に強い。新高値は先行性のサイン。

import { PricePoint } from "./types";
import { alignSeries } from "./benchmark";

export interface RSPoint {
  time: string;
  ratio: number; // 比率を100基準に正規化
  momentum: number; // RSラインの window 日変化率(%)
  newHigh: boolean; // RSライン過去最高値更新
}

export interface RSResult {
  points: RSPoint[];
  relPerf: number; // 期間の対ベンチ相対パフォーマンス（最終比率/初期比率 −1）
  stockTotal: number;
  benchTotal: number;
  latestMomentum: number;
}

export function computeRelativeStrength(
  stock: PricePoint[],
  bench: PricePoint[],
  window = 63
): RSResult | null {
  const { stock: s, bench: b } = alignSeries(stock, bench);
  if (s.length < window + 2) return null;
  const base = s[0].close / b[0].close;
  if (!(base > 0)) return null;

  const points: RSPoint[] = [];
  let runMax = -Infinity;
  const rawRatios: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const raw = s[i].close / b[i].close;
    rawRatios.push(raw);
    const ratio = (raw / base) * 100;
    const prev = i >= window ? rawRatios[i - window] : NaN;
    const momentum = !isNaN(prev) && prev > 0 ? (raw / prev - 1) * 100 : 0;
    const newHigh = raw > runMax;
    runMax = Math.max(runMax, raw);
    points.push({ time: s[i].time, ratio, momentum, newHigh: newHigh && i > window });
  }

  const stockTotal = s[s.length - 1].close / s[0].close - 1;
  const benchTotal = b[b.length - 1].close / b[0].close - 1;
  return {
    points,
    relPerf: rawRatios[rawRatios.length - 1] / base - 1,
    stockTotal,
    benchTotal,
    latestMomentum: points[points.length - 1].momentum,
  };
}
