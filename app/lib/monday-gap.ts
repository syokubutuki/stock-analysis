// 「月曜は下げて始まる」を条件付き現象として解剖する計算エンジン。
//
// 週初め(既定=月曜)の寄りのギャップ・寄り後追随・当日騰落・窓埋めを「目的変数」とし、
// 前週末(直前の金曜/木曜)の値動き経路・前夜の米国動向・トレンド/ボラ/需給・カレンダー文脈を
// 「説明変数」として、どの経路のときギャップが顕著か/機能しないかを層別・回帰・交互作用で定量化する。
//
// 設計上の注意:
//  - 先読みバイアス回避: 説明変数は「月曜の寄り前に確定している情報のみ」(直前の金曜引け・前夜米国)。
//    目的変数だけが月曜当日の O/H/L/C を使う。
//  - 「金曜/木曜」は暦の曜日ではなく位置で取る(prices[i-1]=直前の立会=前週末の最終日)。祝日に頑健。
//  - 前夜米国は「月曜の日付より暦日が厳密に小さい最新の米国立会日」= 金曜夜の米国セッション。
//  - リターンはすべて対数リターン(ギャップ+日中=当日 が加法になる)。

import { PricePoint } from "./types";
import { mean, median, std, tTest, benjaminiHochberg, quantileSorted } from "./stats-significance";
import {
  computeUsReturns, UsReturn, ols, bootMeanCI, bootBetaCI, pearson, studentTwoSidedP, Regression,
} from "./us-spillover-core";

// ───────────────────────── レコード ─────────────────────────

export interface MondayRec {
  i: number;
  date: string;
  year: number;
  // 目的変数(月曜当日の結果)
  gap: number;       // ln(月O / 前金C)  夜間ギャップ(窓)
  intra: number;     // ln(月C / 月O)    寄り後追随(日中)
  full: number;      // ln(月C / 前金C)  当日騰落
  gapFilled: number; // 窓埋め達成 0/1
  // 説明変数(前週末=直前の金曜・木曜の経路。すべて寄り前に確定)
  friRet: number;    // 金曜リターン ln(金C/木C)
  friIntra: number;  // 金曜日中 ln(金C/金O) …引けの勢い
  friClv: number;    // 金曜引けの位置 (C-L)/(H-L) 0..1
  friRange: number;  // 金曜レンジ ln(金H/金L)
  friGap: number;    // 金曜自身のギャップ ln(金O/木C)
  thuRet: number;    // 木曜リターン ln(木C/水C)
  twoDayRet: number; // 木金2日 ln(金C/水C)
  weekRet: number;   // 前5立会リターン ln(金C/5日前C)
  maDist: number;    // 25日線乖離 (金C-SMA25)/SMA25
  vol20: number;     // 実現ボラ 直近20日 日次σ
  rsi14: number;     // 金曜終値のRSI(14)
  relVol: number;    // 金曜出来高 / 20日平均出来高
  usRet: number | null;   // 前夜米国 前日比 ln(C/前C)
  usIntra: number | null; // 前夜米国 日中 ln(C/O)
  // カレンダー文脈
  gapDaysPrev: number; // 直前立会からの暦日数(3=通常の金→月。>3で連休明け)
  monthPhase: number;  // 0=月初(最初3営業日) 1=月中 2=月末(最後3営業日)
}

// ───────────────────────── 指標ヘルパ(自己完結) ─────────────────────────

function wilderRSI(closes: number[], period = 14): number[] {
  const n = closes.length;
  const out = new Array(n).fill(NaN);
  if (n < period + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    g += d > 0 ? d : 0; l += d < 0 ? -d : 0;
  }
  g /= period; l /= period;
  out[period] = l > 0 ? 100 - 100 / (1 + g / l) : 100;
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (period - 1) + (d > 0 ? d : 0)) / period;
    l = (l * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = l > 0 ? 100 - 100 / (1 + g / l) : 100;
  }
  return out;
}

function trailingSMA(closes: number[], p: number): number[] {
  const n = closes.length, out = new Array(n).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += closes[i];
    if (i >= p) s -= closes[i - p];
    if (i >= p - 1) out[i] = s / p;
  }
  return out;
}

function rollingVol(closes: number[], w: number): number[] {
  const n = closes.length;
  const lr = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) if (closes[i] > 0 && closes[i - 1] > 0) lr[i] = Math.log(closes[i] / closes[i - 1]);
  const out = new Array(n).fill(NaN);
  for (let i = w; i < n; i++) {
    const seg: number[] = [];
    for (let j = i - w + 1; j <= i; j++) if (!isNaN(lr[j])) seg.push(lr[j]);
    if (seg.length >= w / 2) out[i] = std(seg);
  }
  return out;
}

function rollingAvg(vals: number[], w: number): number[] {
  const n = vals.length, out = new Array(n).fill(NaN);
  let s = 0, cnt = 0;
  const q: number[] = [];
  for (let i = 0; i < n; i++) {
    q.push(vals[i]); s += vals[i]; cnt++;
    if (q.length > w) { s -= q.shift()!; cnt--; }
    if (i >= w - 1) out[i] = cnt > 0 ? s / cnt : NaN;
  }
  return out;
}

// 各立会日の月内フェーズ(0=月初 / 1=月中 / 2=月末)
function monthPhases(prices: PricePoint[]): number[] {
  const n = prices.length;
  const month = prices.map((p) => { const d = new Date(p.time); return d.getFullYear() * 12 + d.getMonth(); });
  const fromStart = new Array(n).fill(0), toEnd = new Array(n).fill(0);
  let c = 0;
  for (let i = 0; i < n; i++) { c = i > 0 && month[i] === month[i - 1] ? c + 1 : 0; fromStart[i] = c; }
  let c2 = 0;
  for (let i = n - 1; i >= 0; i--) { c2 = i < n - 1 && month[i] === month[i + 1] ? c2 + 1 : 0; toEnd[i] = c2; }
  return prices.map((_, i) => (toEnd[i] <= 2 ? 2 : fromStart[i] <= 2 ? 0 : 1));
}

// ───────────────────────── レコード生成 ─────────────────────────

// 各JP立会日に「その寄り前で最後に確定した米国立会日(日付が厳密に小さい最新)」を割り当てる。
function usBeforeFactory(us: UsReturn[]) {
  const sorted = [...us].sort((a, b) => a.date.localeCompare(b.date));
  return (date: string): UsReturn | null => {
    let lo = 0, hi = sorted.length; // 最初の sorted[k].date >= date を二分探索
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m].date < date) lo = m + 1; else hi = m; }
    return lo - 1 >= 0 ? sorted[lo - 1] : null;
  };
}

export interface BuildResult {
  recs: MondayRec[];
  targetDow: number;
  hasUs: boolean;
}

// jp: 対象銘柄の日足(昇順)。us: 前夜米国指数の日足(無ければ null)。targetDow: 週初め曜日(既定1=月)。
export function buildMondayRecords(jp: PricePoint[], us: PricePoint[] | null, targetDow = 1): BuildResult {
  const n = jp.length;
  const closes = jp.map((p) => p.close);
  const vols = jp.map((p) => p.volume || 0);
  const rsi = wilderRSI(closes, 14);
  const sma25 = trailingSMA(closes, 25);
  const vol20 = rollingVol(closes, 20);
  const avgVol20 = rollingAvg(vols, 20);
  const phase = monthPhases(jp);
  const usReturns = us ? computeUsReturns(us) : [];
  const usBefore = usBeforeFactory(usReturns);
  const hasUs = usReturns.length > 20;

  const recs: MondayRec[] = [];
  for (let i = 6; i < n; i++) {
    if (new Date(jp[i].time).getDay() !== targetDow) continue;
    const mon = jp[i], fri = jp[i - 1], thu = jp[i - 2], wed = jp[i - 3];
    const c5 = closes[i - 6];
    if (!(mon.open > 0) || !(mon.close > 0) || !(fri.close > 0) || !(fri.open > 0)) continue;
    if (!(thu.close > 0) || !(wed.close > 0) || !(c5 > 0)) continue;
    if (!(sma25[i - 1] > 0) || isNaN(vol20[i - 1]) || isNaN(rsi[i - 1])) continue;

    const gap = Math.log(mon.open / fri.close);
    const friClv = fri.high > fri.low ? (fri.close - fri.low) / (fri.high - fri.low) : 0.5;
    const u = usBefore(mon.time);
    const relVol = avgVol20[i - 1] > 0 ? vols[i - 1] / avgVol20[i - 1] : NaN;
    const gapFilled = gap < 0 ? (mon.high >= fri.close ? 1 : 0) : gap > 0 ? (mon.low <= fri.close ? 1 : 0) : 1;

    recs.push({
      i, date: mon.time, year: new Date(mon.time).getFullYear(),
      gap, intra: Math.log(mon.close / mon.open), full: Math.log(mon.close / fri.close), gapFilled,
      friRet: Math.log(fri.close / thu.close),
      friIntra: Math.log(fri.close / fri.open),
      friClv,
      friRange: fri.high > 0 && fri.low > 0 ? Math.log(fri.high / fri.low) : 0,
      friGap: Math.log(fri.open / thu.close),
      thuRet: Math.log(thu.close / wed.close),
      twoDayRet: Math.log(fri.close / wed.close),
      weekRet: Math.log(fri.close / c5),
      maDist: (fri.close - sma25[i - 1]) / sma25[i - 1],
      vol20: vol20[i - 1],
      rsi14: rsi[i - 1],
      relVol: isFinite(relVol) ? relVol : 1,
      usRet: u ? u.ret : null,
      usIntra: u ? u.intra : null,
      gapDaysPrev: (new Date(mon.time).getTime() - new Date(fri.time).getTime()) / 86400000,
      monthPhase: phase[i],
    });
  }
  return { recs, targetDow, hasUs };
}

// 最新の「金曜相当(直近立会)」の説明変数スナップショット。来週月曜の寄り前判断に使う。
export interface LatestSnapshot {
  values: Record<string, number | null>;
  friDate: string | null;
  usDate: string | null;
}
export function latestConditioners(jp: PricePoint[], us: PricePoint[] | null): LatestSnapshot {
  const n = jp.length;
  const closes = jp.map((p) => p.close);
  const vols = jp.map((p) => p.volume || 0);
  const rsi = wilderRSI(closes, 14);
  const sma25 = trailingSMA(closes, 25);
  const vol20 = rollingVol(closes, 20);
  const avgVol20 = rollingAvg(vols, 20);
  const usReturns = us ? computeUsReturns(us) : [];
  const empty: LatestSnapshot = { values: {}, friDate: null, usDate: null };
  if (n < 7) return empty;
  const fri = jp[n - 1], thu = jp[n - 2], wed = jp[n - 3], c5 = closes[n - 6];
  if (!(fri.close > 0) || !(thu.close > 0) || !(wed.close > 0) || !(sma25[n - 1] > 0)) return empty;
  const u = usReturns.length ? usReturns[usReturns.length - 1] : null;
  const relVol = avgVol20[n - 1] > 0 ? vols[n - 1] / avgVol20[n - 1] : 1;
  const values: Record<string, number | null> = {
    friRet: Math.log(fri.close / thu.close),
    friIntra: Math.log(fri.close / fri.open),
    friClv: fri.high > fri.low ? (fri.close - fri.low) / (fri.high - fri.low) : 0.5,
    friRange: fri.high > 0 && fri.low > 0 ? Math.log(fri.high / fri.low) : 0,
    friGap: Math.log(fri.open / thu.close),
    thuRet: Math.log(thu.close / wed.close),
    twoDayRet: Math.log(fri.close / wed.close),
    weekRet: Math.log(fri.close / c5),
    maDist: (fri.close - sma25[n - 1]) / sma25[n - 1],
    vol20: vol20[n - 1],
    rsi14: rsi[n - 1],
    relVol: isFinite(relVol) ? relVol : 1,
    usRet: u ? u.ret : null,
    usIntra: u ? u.intra : null,
  };
  return { values, friDate: fri.time, usDate: u ? u.date : null };
}

// ───────────────────────── 変数レジストリ ─────────────────────────

export interface CondDef {
  key: string; label: string; unit: string; needsUs?: boolean;
  get: (r: MondayRec) => number | null; desc: string;
}
// %表示する対数リターン系(true)か、素の値(RSI/CLV/レンジ倍率など)か
export const PCT_KEYS = new Set(["friRet", "friIntra", "friRange", "friGap", "thuRet", "twoDayRet", "weekRet", "maDist", "vol20", "usRet", "usIntra"]);

export const CONDITIONERS: CondDef[] = [
  { key: "friIntra", label: "金曜 引けの勢い(日中)", unit: "%", get: (r) => r.friIntra, desc: "ln(金C/金O)。金曜ザラ場で買われて引けたか売られて引けたか。" },
  { key: "friClv", label: "金曜 引けの位置(CLV)", unit: "", get: (r) => r.friClv, desc: "(金C−金L)/(金H−金L)。1に近いほど高値圏で引け(強い引け)。" },
  { key: "friRet", label: "金曜リターン(前日比)", unit: "%", get: (r) => r.friRet, desc: "ln(金C/木C)。前週末の勢い。" },
  { key: "thuRet", label: "木曜リターン", unit: "%", get: (r) => r.thuRet, desc: "ln(木C/水C)。金曜の一つ手前の勢い。" },
  { key: "twoDayRet", label: "木金 2日ベクトル", unit: "%", get: (r) => r.twoDayRet, desc: "ln(金C/水C)。木→金の合成モメンタム。" },
  { key: "friGap", label: "金曜自身のギャップ", unit: "%", get: (r) => r.friGap, desc: "ln(金O/木C)。ギャップの連続性を見る。" },
  { key: "friRange", label: "金曜レンジ(高安幅)", unit: "%", get: (r) => r.friRange, desc: "ln(金H/金L)。ボラ膨張の予兆。" },
  { key: "weekRet", label: "前週5日リターン", unit: "%", get: (r) => r.weekRet, desc: "ln(金C/5日前C)。週全体のトレンド。" },
  { key: "maDist", label: "25日線乖離", unit: "%", get: (r) => r.maDist, desc: "(金C−SMA25)/SMA25。トレンド上の位置(過熱/出遅れ)。" },
  { key: "vol20", label: "実現ボラ(20日σ)", unit: "%", get: (r) => r.vol20, desc: "直近20日の日次対数リターン標準偏差。地合いの荒さ。" },
  { key: "rsi14", label: "RSI(14)", unit: "pt", get: (r) => r.rsi14, desc: "金曜終値のRSI。買われ過ぎ/売られ過ぎ。" },
  { key: "relVol", label: "金曜 相対出来高", unit: "×", get: (r) => r.relVol, desc: "金曜出来高/20日平均。投げ(capitulation)か閑散か。" },
  { key: "usRet", label: "前夜米国(前日比)", unit: "%", needsUs: true, get: (r) => r.usRet, desc: "ln(米C/前米C)。金曜夜の米国セッション(月曜寄りの主ドライバ)。" },
  { key: "usIntra", label: "前夜米国(日中)", unit: "%", needsUs: true, get: (r) => r.usIntra, desc: "ln(米C/米O)。米国正規セッション内の値動き。" },
];

export interface TargetDef {
  key: string; label: string; unit: string; kind: "return" | "rate";
  get: (r: MondayRec) => number; desc: string;
}
export const TARGETS: TargetDef[] = [
  { key: "gap", label: "月曜ギャップ(寄り)", unit: "%", kind: "return", get: (r) => r.gap, desc: "ln(月O/前金C)。休場中に開いた窓=下寄り/上寄りの大きさと符号。" },
  { key: "intra", label: "月曜 寄り後追随(日中)", unit: "%", kind: "return", get: (r) => r.intra, desc: "ln(月C/月O)。下げて寄った後さらに下げるか買い戻されるか。" },
  { key: "full", label: "月曜 当日(前週金比)", unit: "%", kind: "return", get: (r) => r.full, desc: "ln(月C/前金C)=ギャップ+日中。週明けの最終的な騰落。" },
  { key: "gapFilled", label: "窓埋め達成(0/1)", unit: "", kind: "rate", get: (r) => r.gapFilled, desc: "月曜のザラ場で前金曜終値に到達したか。下寄りが埋まる癖の有無。" },
];

export function condDef(key: string): CondDef | undefined { return CONDITIONERS.find((c) => c.key === key); }
export function targetDef(key: string): TargetDef | undefined { return TARGETS.find((t) => t.key === key); }

// ───────────────────────── ビン化(等頻度分位) ─────────────────────────

export function schemeLabels(k: number): string[] {
  if (k === 2) return ["下位½", "上位½"];
  if (k === 3) return ["下位⅓", "中位⅓", "上位⅓"];
  return ["最下位", "下位", "中位", "上位", "最上位"];
}
const SCHEME_COLORS: Record<number, string[]> = {
  2: ["#dc2626", "#16a34a"],
  3: ["#dc2626", "#9ca3af", "#16a34a"],
  5: ["#dc2626", "#fb923c", "#9ca3af", "#4ade80", "#16a34a"],
};
export function schemeColors(k: number): string[] { return SCHEME_COLORS[k] ?? SCHEME_COLORS[3]; }

// k等頻度分位の内部境界(長さ k-1)
export function makeEdges(vals: number[], k: number): number[] {
  const s = [...vals].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let j = 1; j < k; j++) edges.push(quantileSorted(s, j / k));
  return edges;
}
export function binOf(v: number, edges: number[]): number {
  let b = 0;
  for (const e of edges) if (v >= e) b++;
  return b;
}

// ───────────────────────── 単変数 条件別集計 ─────────────────────────

export interface BinStat {
  idx: number; label: string; color: string; n: number;
  mean: number; median: number; negRate: number; posRate: number;
  ciLo: number; ciHi: number; p: number; pAdj: number; significant: boolean;
  rangeLo: number | null; rangeHi: number | null;
}
export interface CondResult {
  bins: BinStat[]; k: number; targetKind: "return" | "rate";
  baselineMean: number; baselineNeg: number; baselinePos: number; totalN: number;
  nowBin: number | null; nowValue: number | null;
  corr: number; corrP: number;
  condKey: string; targetKey: string;
}

export function conditionalByBin(
  recs: MondayRec[], condKey: string, targetKey: string, k: number, nowValue: number | null
): CondResult | null {
  const cd = condDef(condKey), td = targetDef(targetKey);
  if (!cd || !td) return null;
  const rows = recs
    .map((r) => ({ x: cd.get(r), y: td.get(r) }))
    .filter((o): o is { x: number; y: number } => o.x !== null && isFinite(o.x) && isFinite(o.y));
  if (rows.length < k * 4) return null;

  const xs = rows.map((o) => o.x);
  const edges = makeEdges(xs, k);
  const labels = schemeLabels(k), colors = schemeColors(k);
  const groups: number[][] = Array.from({ length: k }, () => []);
  for (const o of rows) groups[binOf(o.x, edges)].push(o.y);

  const present = groups.map((g, idx) => ({ g, idx })).filter((o) => o.g.length >= 3);
  const pRaw = present.map((o) => { const t = tTest(o.g); return t ? t.p : 1; });
  const pAdj = benjaminiHochberg(pRaw);

  const bins: BinStat[] = present.map((o, kk) => {
    const g = o.g, m = mean(g);
    const ci = bootMeanCI(g, 500, 0x51a7 + o.idx);
    return {
      idx: o.idx, label: labels[o.idx], color: colors[o.idx], n: g.length,
      mean: m, median: median(g),
      negRate: g.filter((v) => v < 0).length / g.length,
      posRate: g.filter((v) => v > 0).length / g.length,
      ciLo: ci.lo, ciHi: ci.hi, p: pAdj[kk], pAdj: pAdj[kk], significant: pAdj[kk] < 0.05 && g.length >= 20,
      rangeLo: o.idx === 0 ? null : edges[o.idx - 1],
      rangeHi: o.idx === k - 1 ? null : edges[o.idx],
    };
  });

  const allY = rows.map((o) => o.y);
  const r = pearson(xs, allY);
  const nn = rows.length;
  const corrP = Math.abs(r) < 1 ? studentTwoSidedP(r * Math.sqrt((nn - 2) / (1 - r * r)), nn - 2) : 0;

  return {
    bins, k, targetKind: td.kind,
    baselineMean: mean(allY),
    baselineNeg: allY.filter((v) => v < 0).length / nn,
    baselinePos: allY.filter((v) => v > 0).length / nn,
    totalN: nn,
    nowBin: nowValue !== null && isFinite(nowValue) ? binOf(nowValue, edges) : null,
    nowValue,
    corr: r, corrP, condKey, targetKey,
  };
}

// ───────────────────────── 2次元ヒートマップ(交互作用) ─────────────────────────

export interface HeatCell {
  xi: number; yi: number; n: number; mean: number; negRate: number; posRate: number;
  p: number; significant: boolean;
}
export interface HeatResult {
  cells: HeatCell[]; k: number; targetKind: "return" | "rate";
  xLabels: string[]; yLabels: string[]; xKey: string; yKey: string; targetKey: string;
  maxAbs: number; nowXi: number | null; nowYi: number | null; baselineMean: number;
}

export function heatmap2D(
  recs: MondayRec[], xKey: string, yKey: string, targetKey: string, k: number,
  nowX: number | null, nowY: number | null
): HeatResult | null {
  const xd = condDef(xKey), yd = condDef(yKey), td = targetDef(targetKey);
  if (!xd || !yd || !td) return null;
  const rows = recs
    .map((r) => ({ x: xd.get(r), y: yd.get(r), t: td.get(r) }))
    .filter((o): o is { x: number; y: number; t: number } => o.x !== null && o.y !== null && isFinite(o.x) && isFinite(o.y) && isFinite(o.t));
  if (rows.length < k * k * 3) return null;

  const xEdges = makeEdges(rows.map((o) => o.x), k);
  const yEdges = makeEdges(rows.map((o) => o.y), k);
  const cellMap = new Map<string, number[]>();
  for (const o of rows) {
    const key = `${binOf(o.x, xEdges)}|${binOf(o.y, yEdges)}`;
    const a = cellMap.get(key) ?? []; a.push(o.t); cellMap.set(key, a);
  }
  const keys = [...cellMap.keys()].filter((kk) => cellMap.get(kk)!.length >= 3);
  const pRaw = keys.map((kk) => { const t = tTest(cellMap.get(kk)!); return t ? t.p : 1; });
  const pAdj = benjaminiHochberg(pRaw);
  const pMap = new Map(keys.map((kk, idx) => [kk, pAdj[idx]]));

  const cells: HeatCell[] = [];
  let maxAbs = 1e-9;
  for (let xi = 0; xi < k; xi++) for (let yi = 0; yi < k; yi++) {
    const a = cellMap.get(`${xi}|${yi}`);
    if (!a || a.length === 0) continue;
    const m = mean(a);
    const center = td.kind === "rate" ? m - 0.5 : m; // rateは0.5中心で色付け
    maxAbs = Math.max(maxAbs, Math.abs(center));
    const p = pMap.get(`${xi}|${yi}`) ?? 1;
    cells.push({
      xi, yi, n: a.length, mean: m,
      negRate: a.filter((v) => v < 0).length / a.length,
      posRate: a.filter((v) => v > 0).length / a.length,
      p, significant: p < 0.05 && a.length >= 15,
    });
  }
  return {
    cells, k, targetKind: td.kind,
    xLabels: schemeLabels(k), yLabels: schemeLabels(k), xKey, yKey, targetKey,
    maxAbs, baselineMean: mean(rows.map((o) => o.t)),
    nowXi: nowX !== null && isFinite(nowX) ? binOf(nowX, xEdges) : null,
    nowYi: nowY !== null && isFinite(nowY) ? binOf(nowY, yEdges) : null,
  };
}

// ───────────────────────── 散布図 + 回帰 ─────────────────────────

export interface ScatterResult {
  points: { x: number; y: number; us: number | null }[];
  reg: Regression | null;
  betaCI: { lo: number; hi: number; stable: number };
  xKey: string; targetKey: string; nowX: number | null;
}
export function scatterData(recs: MondayRec[], xKey: string, targetKey: string, nowX: number | null): ScatterResult | null {
  const xd = condDef(xKey), td = targetDef(targetKey);
  if (!xd || !td) return null;
  const rows = recs
    .map((r) => ({ x: xd.get(r), y: td.get(r), us: r.usRet }))
    .filter((o): o is { x: number; y: number; us: number | null } => o.x !== null && isFinite(o.x) && isFinite(o.y));
  if (rows.length < 10) return null;
  const xs = rows.map((o) => o.x), ys = rows.map((o) => o.y);
  return {
    points: rows, reg: ols(xs, ys), betaCI: bootBetaCI(xs, ys),
    xKey, targetKey, nowX: nowX !== null && isFinite(nowX) ? nowX : null,
  };
}

// ───────────────────────── 木金ベクトル場(quiver) ─────────────────────────

export interface QuiverResult {
  points: { thu: number; fri: number; t: number }[];
  axisMax: number; tMax: number; targetKey: string;
}
export function quiverData(recs: MondayRec[], targetKey: string): QuiverResult | null {
  const td = targetDef(targetKey);
  if (!td) return null;
  const points = recs
    .map((r) => ({ thu: r.thuRet, fri: r.friRet, t: td.get(r) }))
    .filter((o) => isFinite(o.thu) && isFinite(o.fri) && isFinite(o.t));
  if (points.length < 10) return null;
  const axisMax = Math.max(...points.map((p) => Math.max(Math.abs(p.thu), Math.abs(p.fri)))) || 0.01;
  const tMax = Math.max(...points.map((p) => Math.abs(p.t))) || 0.01;
  return { points, axisMax, tMax, targetKey };
}

// ───────────────────────── ドライバー寄与ランキング ─────────────────────────

export interface DriverRow {
  key: string; label: string; unit: string; needsUs: boolean;
  n: number; corr: number; p: number; pAdj: number; significant: boolean;
  partialCorr: number | null; // 前夜米国(usRet)を統制した偏相関
}

// 前夜米国を統制した x と y の偏相関 r(x,y | z)
function partial(xy: { x: number; y: number; z: number }[]): number | null {
  if (xy.length < 8) return null;
  const rxy = pearson(xy.map((o) => o.x), xy.map((o) => o.y));
  const rxz = pearson(xy.map((o) => o.x), xy.map((o) => o.z));
  const ryz = pearson(xy.map((o) => o.y), xy.map((o) => o.z));
  const den = Math.sqrt((1 - rxz * rxz) * (1 - ryz * ryz));
  return den > 1e-9 ? (rxy - rxz * ryz) / den : null;
}

export function driverRanking(recs: MondayRec[], targetKey: string, hasUs: boolean): DriverRow[] {
  const td = targetDef(targetKey);
  if (!td) return [];
  // カレンダー文脈も擬似ドライバとして加える(0/1/2の数値相関)
  const extra: CondDef[] = [
    { key: "longWeekend", label: "連休明け(0/1)", unit: "", get: (r) => (r.gapDaysPrev > 3 ? 1 : 0), desc: "" },
    { key: "monthPhase", label: "月内フェーズ(0月初/2月末)", unit: "", get: (r) => r.monthPhase, desc: "" },
  ];
  const defs = [...CONDITIONERS, ...extra].filter((c) => hasUs || !c.needsUs);

  const rowsBase = defs.map((cd) => {
    const rows = recs
      .map((r) => ({ x: cd.get(r), y: td.get(r), z: r.usRet }))
      .filter((o): o is { x: number; y: number; z: number | null } => o.x !== null && isFinite(o.x) && isFinite(o.y));
    const xs = rows.map((o) => o.x), ys = rows.map((o) => o.y);
    const r = xs.length >= 8 ? pearson(xs, ys) : 0;
    const nn = xs.length;
    const p = nn > 3 && Math.abs(r) < 1 ? studentTwoSidedP(r * Math.sqrt((nn - 2) / (1 - r * r)), nn - 2) : 1;
    const pc = hasUs && cd.key !== "usRet" && cd.key !== "usIntra"
      ? partial(rows.filter((o) => o.z !== null).map((o) => ({ x: o.x, y: o.y, z: o.z as number })))
      : null;
    return { cd, n: nn, corr: r, p, partialCorr: pc };
  });

  const pAdj = benjaminiHochberg(rowsBase.map((o) => o.p));
  const out: DriverRow[] = rowsBase.map((o, idx) => ({
    key: o.cd.key, label: o.cd.label, unit: o.cd.unit, needsUs: !!o.cd.needsUs,
    n: o.n, corr: o.corr, p: o.p, pAdj: pAdj[idx],
    significant: pAdj[idx] < 0.05 && o.n >= 20, partialCorr: o.partialCorr,
  }));
  return out.sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr));
}

// ───────────────────────── 表示整形 ─────────────────────────

export function fmtCondValue(key: string, v: number | null): string {
  if (v === null || !isFinite(v)) return "—";
  if (key === "rsi14") return v.toFixed(0);
  if (key === "relVol") return `${v.toFixed(2)}×`;
  if (key === "friClv") return v.toFixed(2);
  if (PCT_KEYS.has(key)) return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
  return v.toFixed(3);
}
