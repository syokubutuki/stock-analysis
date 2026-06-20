// 12.1 ヒストリカル・アナログ（類似局面検索）。
// 直近 L 日の値動き波形に似た過去の窓を距離で探し、その“後” M 日がどう動いたかを集める。
// 「過去の似た形のあと、こう散らばった」を中央値パスと分位帯で提示する。

import { PricePoint } from "./types";

export interface Neighbor {
  endIndex: number;
  endTime: string;
  distance: number;
  futurePath: number[]; // 長さ M+1。窓末を0として以降の累積リターン
  futureReturn: number; // M日後の累積リターン
}

export interface AnalogResult {
  queryShape: number[]; // 正規化した直近窓（参考表示用、長さL）
  neighbors: Neighbor[];
  medianPath: number[]; // 長さ M+1
  p25: number[];
  p75: number[];
  upCount: number;
  downCount: number;
  medianFinal: number;
}

// 窓を「初日比の対数リターン列」に正規化（水準・スケール差を吸収）。
function normalizedWindow(prices: PricePoint[], end: number, L: number): number[] | null {
  const start = end - L + 1;
  if (start < 0) return null;
  const base = prices[start].close;
  if (!(base > 0)) return null;
  const out: number[] = [];
  for (let i = start; i <= end; i++) {
    if (!(prices[i].close > 0)) return null;
    out.push(Math.log(prices[i].close / base));
  }
  // zスコア化で形状のみ比較
  const m = out.reduce((s, v) => s + v, 0) / out.length;
  const sd = Math.sqrt(out.reduce((s, v) => s + (v - m) ** 2, 0) / out.length) || 1;
  return out.map((v) => (v - m) / sd);
}

function dist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function findAnalogs(prices: PricePoint[], L: number, M: number, K: number): AnalogResult | null {
  const n = prices.length;
  if (n < L + M + 10) return null;
  const queryEnd = n - 1;
  const query = normalizedWindow(prices, queryEnd, L);
  if (!query) return null;

  // 候補: 末尾 j（j+M が存在し、直近窓と重ならない）
  const cands: { j: number; d: number }[] = [];
  for (let j = L - 1; j <= n - 1 - M; j++) {
    if (j > queryEnd - L) break; // 直近窓と重複する領域を除外
    const w = normalizedWindow(prices, j, L);
    if (!w) continue;
    cands.push({ j, d: dist(query, w) });
  }
  if (cands.length < K) return null;
  cands.sort((a, b) => a.d - b.d);
  const top = cands.slice(0, K);

  const neighbors: Neighbor[] = top.map(({ j, d }) => {
    const baseC = prices[j].close;
    const futurePath: number[] = [];
    for (let m = 0; m <= M; m++) futurePath.push(prices[j + m].close / baseC - 1);
    return {
      endIndex: j,
      endTime: prices[j].time,
      distance: d,
      futurePath,
      futureReturn: futurePath[M],
    };
  });

  // 各ステップの中央値・分位
  const medianPath: number[] = [];
  const p25: number[] = [];
  const p75: number[] = [];
  for (let m = 0; m <= M; m++) {
    const col = neighbors.map((nb) => nb.futurePath[m]).sort((a, b) => a - b);
    medianPath.push(quantile(col, 0.5));
    p25.push(quantile(col, 0.25));
    p75.push(quantile(col, 0.75));
  }
  const finals = neighbors.map((nb) => nb.futureReturn);
  return {
    queryShape: query,
    neighbors,
    medianPath,
    p25,
    p75,
    upCount: finals.filter((v) => v > 0).length,
    downCount: finals.filter((v) => v <= 0).length,
    medianFinal: medianPath[M],
  };
}
