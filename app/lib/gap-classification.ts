// 1.3 窓の分類と窓埋め統計。
// 窓（オーバーナイトギャップ）を common/breakaway/runaway/exhaustion に分類し、
// 各タイプの窓埋め率と、窓埋め(fade) vs 継続(go) のN日先成績を集計する。

import { PricePoint } from "./types";

export type GapType = "common" | "breakaway" | "runaway" | "exhaustion";

export interface GapTypeStat {
  type: GapType;
  label: string;
  n: number;
  fillRate: number; // 当日中に前日終値まで埋めた割合
  goFwd: number; // 埋めなかった(継続)場合のN日先平均
  fadeFwd: number; // 埋めた(逆行)場合のN日先平均
  meanGap: number; // 平均窓サイズ(絶対値%)
}

export interface GapClassResult {
  stats: GapTypeStat[];
  horizon: number;
  totalGaps: number;
}

const LABELS: Record<GapType, string> = {
  common: "コモン窓(小・レンジ内)",
  breakaway: "ブレイクアウェイ窓(放れ)",
  runaway: "ランナウェイ窓(継続)",
  exhaustion: "イグゾースチョン窓(過熱)",
};

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

export function classifyGaps(prices: PricePoint[], horizon: number, minGap = 0.005): GapClassResult {
  const n = prices.length;
  const sma50 = new Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += prices[i].close;
    if (i >= 50) sum -= prices[i - 50].close;
    if (i >= 49) sma50[i] = sum / 50;
  }

  const groups: Record<GapType, { fills: boolean[]; goFwd: number[]; fadeFwd: number[]; gaps: number[] }> = {
    common: { fills: [], goFwd: [], fadeFwd: [], gaps: [] },
    breakaway: { fills: [], goFwd: [], fadeFwd: [], gaps: [] },
    runaway: { fills: [], goFwd: [], fadeFwd: [], gaps: [] },
    exhaustion: { fills: [], goFwd: [], fadeFwd: [], gaps: [] },
  };
  let total = 0;

  for (let i = 21; i < n - horizon; i++) {
    const prevC = prices[i - 1].close;
    if (!(prevC > 0)) continue;
    const gap = (prices[i].open - prevC) / prevC;
    if (Math.abs(gap) < minGap) continue;
    total++;
    const dir = Math.sign(gap);

    // 直近20日レンジと事前トレンド
    let hi = -Infinity, lo = Infinity;
    for (let j = i - 20; j < i; j++) { hi = Math.max(hi, prices[j].high); lo = Math.min(lo, prices[j].low); }
    const run20 = prices[i - 1].close / prices[i - 21].close - 1; // 窓前の勢い
    const trendUp = !isNaN(sma50[i - 1]) && prices[i - 1].close > sma50[i - 1];

    let type: GapType;
    if (Math.abs(gap) < 0.01) {
      type = "common";
    } else if ((dir > 0 && prices[i].open > hi) || (dir < 0 && prices[i].open < lo)) {
      // レンジを抜けた = ブレイクアウェイ
      type = "breakaway";
    } else if (dir === Math.sign(run20) && Math.abs(run20) > 0.15 && dir === (trendUp ? 1 : -1)) {
      // 長い勢いの末の同方向窓 = 過熱(イグゾースチョン)
      type = "exhaustion";
    } else if (dir === Math.sign(run20)) {
      type = "runaway";
    } else {
      type = "common";
    }

    // 窓埋め判定（当日中に前日終値到達）
    const filled = dir > 0 ? prices[i].low <= prevC : prices[i].high >= prevC;
    const fwd = (prices[i + horizon].close - prices[i].close) / prices[i].close;
    // 方向調整: 上窓は上昇で「継続成功」。下窓は下落で継続成功 → 符号をdirに合わせる
    const dirFwd = dir > 0 ? fwd : -fwd;
    const g = groups[type];
    g.fills.push(filled);
    g.gaps.push(Math.abs(gap));
    if (filled) g.fadeFwd.push(dirFwd);
    else g.goFwd.push(dirFwd);
  }

  const stats: GapTypeStat[] = (Object.keys(groups) as GapType[]).map((t) => {
    const g = groups[t];
    return {
      type: t,
      label: LABELS[t],
      n: g.fills.length,
      fillRate: g.fills.length ? g.fills.filter(Boolean).length / g.fills.length : 0,
      goFwd: mean(g.goFwd),
      fadeFwd: mean(g.fadeFwd),
      meanGap: mean(g.gaps),
    };
  });

  return { stats, horizon, totalGaps: total };
}
