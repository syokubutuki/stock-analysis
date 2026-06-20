// 当日内の経路・状態分析。
//   B1: 日内トレンド/レンジ判定（Kaufman効率比・分散比）とレジーム別の翌日成績
//   B2: 寄り→現在の経路類似マッチング（DTW近傍）と引けリターン分布
//   B3: 前場→後場の予測関係（2セッション分割・回帰）

import { IntradayBar, groupByDay, logReturn, localMinute, DayData, stdOf, meanOf } from "./intraday-core";

// ───────────────────────── B1: トレンド/レンジ ─────────────────────────

export type RegimeLabel = "up" | "down" | "range";
export interface RegimeDay {
  date: string;
  er: number;       // Kaufman効率比 0..1
  vr: number;       // 分散比 VR(q)
  closePos: number; // (close-low)/(high-low)
  dayRetPct: number;
  label: RegimeLabel;
  nextRetPct: number; // 翌日 close→close（無ければ NaN）
}
export interface RegimeBucket {
  label: RegimeLabel;
  count: number;
  nextMeanPct: number;
  nextWin: number;
}
export interface RegimeResult {
  nDays: number;
  erThreshold: number;
  days: RegimeDay[];
  buckets: RegimeBucket[];
}

function efficiencyRatio(closes: number[]): number {
  if (closes.length < 2) return 0;
  const net = Math.abs(closes[closes.length - 1] - closes[0]);
  let sum = 0;
  for (let i = 1; i < closes.length; i++) sum += Math.abs(closes[i] - closes[i - 1]);
  return sum > 0 ? net / sum : 0;
}

// 分散比 VR(q) = Var(q期間リターン) / (q·Var(1期間リターン))
function varianceRatio(rets: number[], q: number): number {
  if (rets.length < q + 2) return 1;
  const v1 = stdOf(rets) ** 2;
  if (v1 <= 0) return 1;
  const qRets: number[] = [];
  for (let i = 0; i + q <= rets.length; i++) {
    let s = 0;
    for (let j = 0; j < q; j++) s += rets[i + j];
    qRets.push(s);
  }
  const vq = stdOf(qRets) ** 2;
  return vq / (q * v1);
}

export function computeRegime(
  bars: IntradayBar[], gmtoffset: number, erThreshold = 0.4
): RegimeResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length === 0) return null;

  const out: RegimeDay[] = days.map((day) => {
    const closes = day.bars.map((b) => b.close);
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) rets.push(logReturn(closes[i - 1], closes[i]));
    const er = efficiencyRatio(closes);
    const vr = varianceRatio(rets, 4);
    const range = day.high - day.low;
    const closePos = range > 0 ? (day.close - day.low) / range : 0.5;
    const dayRet = day.open > 0 ? (day.close - day.open) / day.open : 0;
    let label: RegimeLabel = "range";
    if (er >= erThreshold) label = dayRet >= 0 ? "up" : "down";
    return {
      date: day.date, er, vr, closePos,
      dayRetPct: dayRet * 100, label, nextRetPct: NaN,
    };
  });

  for (let i = 0; i < days.length - 1; i++) {
    const c = days[i].close, nc = days[i + 1].close;
    out[i].nextRetPct = c > 0 ? ((nc - c) / c) * 100 : NaN;
  }

  const labels: RegimeLabel[] = ["up", "down", "range"];
  const buckets: RegimeBucket[] = labels.map((lb) => {
    const rows = out.filter((d) => d.label === lb && !isNaN(d.nextRetPct));
    const nexts = rows.map((d) => d.nextRetPct);
    return {
      label: lb,
      count: out.filter((d) => d.label === lb).length,
      nextMeanPct: meanOf(nexts),
      nextWin: nexts.length ? nexts.filter((v) => v > 0).length / nexts.length : 0,
    };
  });

  return { nDays: days.length, erThreshold, days: out, buckets };
}

// ───────────────────────── B2: 経路アナログ (DTW) ─────────────────────────

export interface AnalogNeighbor {
  date: string;
  distance: number;
  fullPath: number[]; // 始値比%の全日経路
  closeRetPct: number;
}
export interface AnalogResult {
  queryDate: string;
  cutoffBars: number;
  queryPath: number[]; // 始値比%（cutoffまで）
  maxLen: number;
  neighbors: AnalogNeighbor[];
  meanClosePct: number;
  winRate: number;
  q25: number;
  q75: number;
  n: number;
}

function normPath(day: DayData): number[] {
  const o = day.open;
  if (o <= 0) return day.bars.map(() => 0);
  return day.bars.map((b) => ((b.close - o) / o) * 100);
}

// DTW距離（1次元、ウィンドウ無し）。短い系列(数十点)前提。
function dtw(a: number[], b: number[]): number {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return Infinity;
  const INF = Infinity;
  let prev = new Array(m + 1).fill(INF);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(INF);
    for (let j = 1; j <= m; j++) {
      const cost = Math.abs(a[i - 1] - b[j - 1]);
      cur[j] = cost + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    prev = cur;
  }
  return prev[m] / (n + m);
}

export function computeAnalog(
  bars: IntradayBar[], gmtoffset: number, cutoffFrac = 0.5, K = 8
): AnalogResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length < K + 2) return null;

  const paths = days.map(normPath);
  const maxLen = Math.max(...paths.map((p) => p.length));
  const query = days[days.length - 1];
  const qFull = paths[paths.length - 1];
  const cutoff = Math.max(2, Math.floor(qFull.length * cutoffFrac));
  const qPrefix = qFull.slice(0, cutoff);

  const cands: AnalogNeighbor[] = [];
  for (let i = 0; i < days.length - 1; i++) {
    const p = paths[i];
    if (p.length < cutoff) continue;
    const prefix = p.slice(0, cutoff);
    const d = dtw(qPrefix, prefix);
    cands.push({
      date: days[i].date,
      distance: d,
      fullPath: p,
      closeRetPct: p.length ? p[p.length - 1] : 0,
    });
  }
  cands.sort((a, b) => a.distance - b.distance);
  const neighbors = cands.slice(0, K);

  const closeRets = neighbors.map((nb) => nb.closeRetPct).sort((a, b) => a - b);
  const q = (arr: number[], p: number) => {
    if (!arr.length) return 0;
    const pos = (arr.length - 1) * p;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? arr[lo] : arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
  };

  return {
    queryDate: query.date,
    cutoffBars: cutoff,
    queryPath: qPrefix,
    maxLen,
    neighbors,
    meanClosePct: meanOf(neighbors.map((nb) => nb.closeRetPct)),
    winRate: neighbors.length ? neighbors.filter((nb) => nb.closeRetPct > 0).length / neighbors.length : 0,
    q25: q(closeRets, 0.25),
    q75: q(closeRets, 0.75),
    n: neighbors.length,
  };
}

// ───────────────────────── B3: 前場 → 後場 ─────────────────────────

export interface SessionPoint { amPct: number; pmPct: number; }
export interface SessionBucket { label: string; n: number; pmMeanPct: number; pmWin: number; }
export interface SessionResult {
  nDays: number;
  hasTwoSessions: boolean;
  points: SessionPoint[];
  alpha: number; beta: number; r2: number; corr: number;
  buckets: SessionBucket[];
}

// 1日のバーを前場/後場に分割。バー時刻の最大ギャップ(昼休み)で割る。
// ギャップが小さければ単一セッションとみなしバー数の半分で午前/午後に分ける。
function splitSession(day: DayData, gmtoffset: number, binMinutes: number): { am: IntradayBar[]; pm: IntradayBar[]; two: boolean } {
  const bs = day.bars;
  let gapIdx = -1, gapSize = 0;
  for (let i = 1; i < bs.length; i++) {
    const g = localMinute(bs[i].ts, gmtoffset) - localMinute(bs[i - 1].ts, gmtoffset);
    if (g > gapSize) { gapSize = g; gapIdx = i; }
  }
  if (gapIdx > 0 && gapSize >= binMinutes * 2.5) {
    return { am: bs.slice(0, gapIdx), pm: bs.slice(gapIdx), two: true };
  }
  const mid = Math.floor(bs.length / 2);
  return { am: bs.slice(0, mid), pm: bs.slice(mid), two: false };
}

export function computeSessionSplit(
  bars: IntradayBar[], gmtoffset: number, binMinutes = 5
): SessionResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length === 0) return null;

  let twoCount = 0;
  const points: SessionPoint[] = [];
  for (const day of days) {
    const { am, pm, two } = splitSession(day, gmtoffset, binMinutes);
    if (am.length < 2 || pm.length < 2) continue;
    if (two) twoCount++;
    const amOpen = am[0].open, amClose = am[am.length - 1].close;
    const pmOpen = pm[0].open, pmClose = pm[pm.length - 1].close;
    if (amOpen <= 0 || pmOpen <= 0) continue;
    points.push({
      amPct: ((amClose - amOpen) / amOpen) * 100,
      pmPct: ((pmClose - pmOpen) / pmOpen) * 100,
    });
  }
  if (points.length < 5) return null;

  // 単回帰 pm = a + b·am
  const xs = points.map((p) => p.amPct), ys = points.map((p) => p.pmPct);
  const mx = meanOf(xs), my = meanOf(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const beta = sxx > 0 ? sxy / sxx : 0;
  const alpha = my - beta * mx;
  const corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  const r2 = corr * corr;

  // AM分位バケット（3分割）
  const sorted = [...points].sort((a, b) => a.amPct - b.amPct);
  const third = Math.floor(sorted.length / 3) || 1;
  const groups: [string, SessionPoint[]][] = [
    ["前場安(下位1/3)", sorted.slice(0, third)],
    ["前場中(中位)", sorted.slice(third, 2 * third)],
    ["前場高(上位1/3)", sorted.slice(2 * third)],
  ];
  const buckets: SessionBucket[] = groups.map(([label, g]) => {
    const pm = g.map((p) => p.pmPct);
    return {
      label, n: g.length,
      pmMeanPct: meanOf(pm),
      pmWin: pm.length ? pm.filter((v) => v > 0).length / pm.length : 0,
    };
  });

  return {
    nDays: days.length,
    hasTwoSessions: twoCount > days.length / 2,
    points, alpha, beta, r2, corr, buckets,
  };
}
