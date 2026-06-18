// 判定の実績化 — フェーズ1: 条件付き前方リターンのバックテスト
//
// 過去の各日 t を「その日までのデータだけ」で再現し(ポイントインタイム)、
// シグナル事象を判定 → その後 1/3/5/10/15 日の前方リターンを記録する。
// ウォッチリスト横断でプールし、事象ごとの前方リターン分布と
// 無条件ベースレートを比較できるようにする。
//
// 先読み防止: computeDigest が使う部品(カルマン順方向・GARCH・BOCPDオンライン・
// 末尾窓のHurst/z)はすべて因果的なので、prices.slice(0, t+1) に対して計算すれば
// 過去再現は忠実(全標本を使う structural-break は digest に含まれない)。

import { PricePoint } from "./types";
import {
  Horizon,
  SignalEvent,
  SIGNAL_EVENTS,
  computeDigest,
  classifySignalEvent,
} from "./signal-digest";

export const EVAL_HORIZONS = [1, 3, 5, 10, 15];

export interface ForwardObs {
  events: SignalEvent[];
  fwd: Record<number, number>; // horizon(日) -> 前方リターン(%)
}

export interface EventStat {
  horizon: number;
  n: number;
  median: number;
  p25: number;
  p75: number;
  mean: number;
  pDown: number; // リターン<0 の割合
}

export interface BacktestResult {
  ok: boolean;
  evalHorizons: number[];
  baseRate: EventStat[]; // 無条件(全評価日)
  byEvent: Record<SignalEvent, EventStat[]>;
  nStocks: number;
  totalEvals: number;
  from: string;
  to: string;
}

// 1銘柄を歩いて前方リターン観測を集める。
export function backtestStock(
  prices: PricePoint[],
  ticker: string,
  name: string,
  horizon: Horizon,
  opts: { evalHorizons?: number[]; step?: number; lookback?: number } = {}
): ForwardObs[] {
  const evalHorizons = opts.evalHorizons ?? EVAL_HORIZONS;
  const step = opts.step ?? 3;
  const lookback = opts.lookback ?? 756;
  const maxH = Math.max(...evalHorizons);
  const len = prices.length;
  const obs: ForwardObs[] = [];
  if (len < 80) return obs;

  const startT = Math.max(60, len - lookback);
  const endT = len - 1 - maxH;
  const closes = prices.map((p) => p.close);

  for (let t = startT; t <= endT; t += step) {
    const digest = computeDigest(prices.slice(0, t + 1), ticker, name, horizon);
    if (!digest.ok) continue;
    const events = classifySignalEvent(digest);
    const fwd: Record<number, number> = {};
    for (const h of evalHorizons) {
      const c0 = closes[t];
      const c1 = closes[t + h];
      if (c0 > 0 && c1 != null) fwd[h] = (c1 / c0 - 1) * 100;
    }
    obs.push({ events, fwd });
  }
  return obs;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function statsFor(values: number[], horizon: number): EventStat {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = n > 0 ? sorted.reduce((a, b) => a + b, 0) / n : 0;
  const pDown = n > 0 ? sorted.filter((v) => v < 0).length / n : 0;
  return {
    horizon,
    n,
    median: percentile(sorted, 0.5),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    mean,
    pDown,
  };
}

// プールした観測を事象×ホライズンで集計。
export function aggregate(
  obs: ForwardObs[],
  evalHorizons: number[] = EVAL_HORIZONS
): { baseRate: EventStat[]; byEvent: Record<SignalEvent, EventStat[]> } {
  const baseRate = evalHorizons.map((h) =>
    statsFor(
      obs.filter((o) => o.fwd[h] != null).map((o) => o.fwd[h]),
      h
    )
  );
  const byEvent = {} as Record<SignalEvent, EventStat[]>;
  for (const ev of SIGNAL_EVENTS) {
    byEvent[ev] = evalHorizons.map((h) =>
      statsFor(
        obs.filter((o) => o.events.includes(ev) && o.fwd[h] != null).map((o) => o.fwd[h]),
        h
      )
    );
  }
  return { baseRate, byEvent };
}
