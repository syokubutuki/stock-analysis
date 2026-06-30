// 休場コンテキスト（連休・祝日）で曜日の値動きを区別する分析エンジン。
//
// 動機: 単純に getDay() で曜日を分けるだけでは、前後の市場開閉に値動きが歪む。
//   - 月曜は常に週末の3日ギャップを跨ぐが、月曜が祝日だと火曜が「実質月曜」(前4日ギャップ)になる。
//   - 金曜は常に週末前だが、金曜が祝日だと木曜が「実質金曜」(週末回避の手仕舞い売り)になる。
// そこで曜日ラベルではなく「その立会日の前後ギャップ日数が、その曜日の“正常ギャップ”を超過しているか」
// を第一級の分類軸にする。月曜の週末ギャップ(=3日)は正常なので超過0、祝日で延びた分だけが超過として浮く。
//
// 正常ギャップの定義（暦日）: 月曜の前ギャップ=3, 金曜の後ギャップ=3, それ以外=1。
//   超過前 excessPrev = gapPrev − normalPrev(dow)   (>0 なら連休明け)
//   超過後 excessNext = gapNext − normalNext(dow)   (>0 なら連休前)
//
// これにより、火曜が月曜祝日明けなら excessPrev=3>0、木曜が金曜祝日前なら excessNext=3>0 と
// 自動検出され、通常日と区別して可視化・検定できる。

import { PricePoint } from "./types";
import { mean, median, std, quantileSorted, benjaminiHochberg } from "./stats-significance";

export type GapContext = "normal" | "postBreak" | "preBreak" | "sandwiched";

export const CONTEXT_ORDER: GapContext[] = ["normal", "postBreak", "preBreak", "sandwiched"];

export const CONTEXT_META: Record<GapContext, { label: string; short: string; color: string }> = {
  normal: { label: "通常日", short: "通常", color: "#9ca3af" },
  postBreak: { label: "連休明け", short: "明け", color: "#dc2626" },
  preBreak: { label: "連休前", short: "前", color: "#2563eb" },
  sandwiched: { label: "連休はさみ(孤立立会)", short: "孤立", color: "#7c3aed" },
};

export type Metric = "gap" | "intraday" | "fullday";
export const METRICS: { value: Metric; label: string; desc: string }[] = [
  { value: "gap", label: "夜間ギャップ", desc: "(始値−前日終値)/前日終値。休場中に開いた窓そのもの。" },
  { value: "intraday", label: "日中", desc: "(終値−始値)/始値。寄り後のザラ場値動き。" },
  { value: "fullday", label: "当日(前日比)", desc: "(終値−前日終値)/前日終値。" },
];

export const WD_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const DAY_MS = 86400000;

function normalPrev(dow: number): number {
  return dow === 1 ? 3 : 1; // 月曜の前は週末ぶんの3日が正常
}
function normalNext(dow: number): number {
  return dow === 5 ? 3 : 1; // 金曜の後は週末ぶんの3日が正常
}

export interface GapDay {
  i: number;
  date: string;
  dow: number; // 1=月..5=金
  gapPrev: number; // 前立会日からの暦日数
  gapNext: number; // 翌立会日までの暦日数
  excessPrev: number;
  excessNext: number;
  context: GapContext;
  gap: number; // 夜間
  intraday: number; // 日中
  fullday: number; // 当日(前日比)
}

function classify(excessPrev: number, excessNext: number): GapContext {
  const pre = excessNext > 0;
  const post = excessPrev > 0;
  if (pre && post) return "sandwiched";
  if (post) return "postBreak";
  if (pre) return "preBreak";
  return "normal";
}

export function metricOf(d: GapDay, m: Metric): number {
  return m === "gap" ? d.gap : m === "intraday" ? d.intraday : d.fullday;
}

// 全立会日を休場コンテキスト付きで構築する。i は prices 上の添字。
export function buildGapDays(prices: PricePoint[]): GapDay[] {
  const t = prices.map((p) => new Date(p.time).getTime());
  const out: GapDay[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prevC = prices[i - 1].close, o = prices[i].open, c = prices[i].close;
    if (!(prevC > 0) || !(o > 0) || !(c > 0)) continue;
    const dow = new Date(prices[i].time).getDay();
    if (dow < 1 || dow > 5) continue;
    const gapPrev = Math.round((t[i] - t[i - 1]) / DAY_MS);
    const gapNext = i < prices.length - 1 ? Math.round((t[i + 1] - t[i]) / DAY_MS) : normalNext(dow);
    const excessPrev = gapPrev - normalPrev(dow);
    const excessNext = gapNext - normalNext(dow);
    out.push({
      i,
      date: prices[i].time,
      dow,
      gapPrev,
      gapNext,
      excessPrev: Math.max(0, excessPrev),
      excessNext: Math.max(0, excessNext),
      context: classify(excessPrev, excessNext),
      gap: (o - prevC) / prevC,
      intraday: (c - o) / o,
      fullday: (c - prevC) / prevC,
    });
  }
  return out;
}

// ============================================================
// 乱数・順列検定（自己完結）
// ============================================================
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// 2標本の平均差に対する順列検定（両側）。小さい側だけを部分シャッフルして O(iters·min(n)) で評価。
// 系列相関は無視するため厳密ではないが、リターン分布の非正規性に頑健で、t検定の補助に十分。
function permTestDiff(a: number[], b: number[], iters = 2000, seed = 0x9e3779b9): number {
  const na = a.length, nb = b.length, N = na + nb;
  if (na < 3 || nb < 3) return 1;
  const pool = a.concat(b);
  const total = pool.reduce((s, v) => s + v, 0);
  const obs = Math.abs(mean(a) - mean(b));
  const rng = mulberry32(seed);
  const idx = Array.from({ length: N }, (_, i) => i);
  const k = Math.min(na, nb);
  let ge = 0;
  for (let it = 0; it < iters; it++) {
    let sumK = 0;
    for (let j = 0; j < k; j++) {
      const r = j + Math.floor(rng() * (N - j));
      const tmp = idx[j]; idx[j] = idx[r]; idx[r] = tmp;
      sumK += pool[idx[j]];
    }
    const diff = Math.abs(sumK / k - (total - sumK) / (N - k));
    if (diff >= obs - 1e-15) ge++;
  }
  return (ge + 1) / (iters + 1);
}

function bootCI(data: number[], B = 600, seed = 0x1234567): { lo: number; hi: number; stable: number } {
  const n = data.length;
  if (n < 3) { const m = mean(data); return { lo: m, hi: m, stable: 0.5 }; }
  const rng = mulberry32(seed);
  const L = Math.max(1, Math.round(Math.cbrt(n)));
  const nBlocks = Math.ceil(n / L);
  const sign = mean(data) >= 0 ? 1 : -1;
  const samples: number[] = [];
  let same = 0;
  for (let b = 0; b < B; b++) {
    let sum = 0, cnt = 0;
    for (let blk = 0; blk < nBlocks && cnt < n; blk++) {
      const start = Math.floor(rng() * n);
      for (let j = 0; j < L && cnt < n; j++) { sum += data[(start + j) % n]; cnt++; }
    }
    const m = sum / cnt;
    samples.push(m);
    if ((m >= 0 ? 1 : -1) === sign) same++;
  }
  samples.sort((x, y) => x - y);
  return { lo: quantileSorted(samples, 0.025), hi: quantileSorted(samples, 0.975), stable: same / B };
}

// ============================================================
// ビュー1: 曜日 × 休場コンテキストのストリップ（色分け散布）
// ============================================================
export interface StripResult {
  metric: Metric;
  days: GapDay[]; // 描画はコンポーネント側で context フィルタ
  maxAbs: number; // 縦軸スケール（|値|の97.5%点）。外れ値はこの端にクランプ表示
  cellMean: Map<string, { mean: number; n: number }>; // key = `${dow}|${context}`
}

export function weekdayStrip(days: GapDay[], metric: Metric): StripResult {
  const cell = new Map<string, number[]>();
  const abs: number[] = [];
  for (const d of days) {
    const v = metricOf(d, metric);
    abs.push(Math.abs(v));
    const key = `${d.dow}|${d.context}`;
    const arr = cell.get(key) ?? [];
    arr.push(v);
    cell.set(key, arr);
  }
  abs.sort((a, b) => a - b);
  const maxAbs = Math.max(1e-9, quantileSorted(abs, 0.975));
  const cellMean = new Map<string, { mean: number; n: number }>();
  for (const [k, arr] of cell) cellMean.set(k, { mean: mean(arr), n: arr.length });
  return { metric, days, maxAbs, cellMean };
}

// ============================================================
// ビュー2: 休場コンテキスト別の統計検定（通常日ベースラインとの差）
// ============================================================
export interface ContextStat {
  context: GapContext;
  n: number;
  mean: number;
  median: number;
  win: number;
  ciLo: number;
  ciHi: number;
  stable: number;
  diffVsNormal: number;
  pVsNormal: number; // FDR補正済み順列p値
  significant: boolean;
}

export interface MatrixCell {
  dow: number;
  context: GapContext;
  n: number;
  mean: number;
  diff: number; // 同曜日の通常日との差
  p: number;
  significant: boolean;
}

export interface GapSummary {
  metric: Metric;
  baselineMean: number;
  baselineN: number;
  baselineWin: number;
  contexts: ContextStat[]; // postBreak, preBreak, sandwiched
  matrix: MatrixCell[];
  maxAbsMatrix: number;
  today: GapDay | null;
}

export function gapSummary(days: GapDay[], metric: Metric): GapSummary {
  const val = (d: GapDay) => metricOf(d, metric);
  const byCtx = new Map<GapContext, number[]>();
  const byDowCtx = new Map<string, number[]>();
  for (const d of days) {
    const v = val(d);
    (byCtx.get(d.context) ?? byCtx.set(d.context, []).get(d.context)!).push(v);
    const k = `${d.dow}|${d.context}`;
    (byDowCtx.get(k) ?? byDowCtx.set(k, []).get(k)!).push(v);
  }
  const normal = byCtx.get("normal") ?? [];
  const baselineMean = mean(normal);

  // コンテキスト全体（通常との差）
  const targets: GapContext[] = ["postBreak", "preBreak", "sandwiched"];
  const rawP: number[] = [];
  const partial: { context: GapContext; arr: number[] }[] = [];
  for (const ctx of targets) {
    const arr = byCtx.get(ctx) ?? [];
    if (arr.length < 5) continue;
    partial.push({ context: ctx, arr });
    rawP.push(permTestDiff(arr, normal));
  }
  const adjP = benjaminiHochberg(rawP);
  const contexts: ContextStat[] = partial.map((p, k) => {
    const ci = bootCI(p.arr);
    return {
      context: p.context,
      n: p.arr.length,
      mean: mean(p.arr),
      median: median(p.arr),
      win: p.arr.filter((x) => x > 0).length / p.arr.length,
      ciLo: ci.lo,
      ciHi: ci.hi,
      stable: ci.stable,
      diffVsNormal: mean(p.arr) - baselineMean,
      pVsNormal: adjP[k],
      significant: adjP[k] < 0.05,
    };
  });

  // 曜日×コンテキスト行列（各曜日の通常日との差を検定）
  const mRawP: number[] = [];
  const mPartial: { dow: number; context: GapContext; arr: number[]; base: number[] }[] = [];
  for (let dow = 1; dow <= 5; dow++) {
    const base = byDowCtx.get(`${dow}|normal`) ?? [];
    for (const ctx of targets) {
      const arr = byDowCtx.get(`${dow}|${ctx}`) ?? [];
      if (arr.length < 5 || base.length < 5) continue;
      mPartial.push({ dow, context: ctx, arr, base });
      mRawP.push(permTestDiff(arr, base, 1500));
    }
  }
  const mAdjP = benjaminiHochberg(mRawP);
  let maxAbsMatrix = 1e-9;
  const matrix: MatrixCell[] = mPartial.map((p, k) => {
    const m = mean(p.arr);
    const diff = m - mean(p.base);
    maxAbsMatrix = Math.max(maxAbsMatrix, Math.abs(m));
    return { dow: p.dow, context: p.context, n: p.arr.length, mean: m, diff, p: mAdjP[k], significant: mAdjP[k] < 0.05 };
  });

  const today = days.length ? days[days.length - 1] : null;

  return {
    metric,
    baselineMean,
    baselineN: normal.length,
    baselineWin: normal.length ? normal.filter((x) => x > 0).length / normal.length : 0,
    contexts,
    matrix,
    maxAbsMatrix,
    today,
  };
}
