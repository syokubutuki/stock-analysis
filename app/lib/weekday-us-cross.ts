// 曜日 × 前夜米国ビン 交互作用の「ウォッチリスト横断」集計。
//
// 単一銘柄版(WeekdayUsPathChart)を全銘柄に一斉適用し、選んだ前夜米国ビンの翌日だけに絞って
// 曜日別の日内特性を多面的に(日中/前日比/ギャップ/上値到達/下値到達/レンジ/終値位置/勝率/
// ボラ/シャープ/高安時刻/日内パス形状)スカラー化し、銘柄×曜日のヒートマップで俯瞰する。
// 末尾に全銘柄をプールした「横断平均」行(日付クラスタ頑健SE)を置き、固有 vs 共通を切り分ける。
//
// 対象期間はローリング可能(最新起点で窓長可変、または窓長固定で位置スライド)。前夜米国ビンの
// 境界は「窓内・全銘柄共通」に取り、銘柄横断で同じ地合いを比較する。

import {
  DayData, BinGrid, localMinute, minuteToLabel,
} from "./intraday-core";
import {
  UsReturn, AlignedDay, BinScheme, BinMeta, binMeta, binEdges, binOfValue, alignJpUs, dayCumPath,
  studentTwoSidedP,
} from "./us-spillover-core";
import { clusterStat } from "./intraday-basket";
import { mean, std, median, tTest } from "./stats-significance";

export type UsMode = "ret" | "intra";

export const CROSS_WD_ORDER = [1, 2, 3, 4, 5];
export const CROSS_WD_LABELS: Record<number, string> = {
  1: "月", 2: "火", 3: "水", 4: "木", 5: "金",
};

export interface CrossStock {
  ticker: string;
  name?: string;
  days: DayData[];
  gmtoffset: number;
}

export function usValueOf(u: UsReturn, mode: UsMode): number {
  return mode === "intra" ? u.intra : u.ret;
}

// 対象期間(JP立会日の日付範囲, 両端含む)。null は全期間。
export interface DateWindow {
  start: string; // YYYY-MM-DD
  end: string;
}

function inWindow(date: string, w: DateWindow | null): boolean {
  return !w || (date >= w.start && date <= w.end);
}

// ───────────────────────── 1立会日の日内特徴量 ─────────────────────────

export interface DayFeatures {
  date: string;
  weekday: number;
  intraday: number; // ln(引/寄)  日中リターン
  full: number | null; // ln(引/前日引)  前日比(オーバーナイト込み)
  gap: number | null; // ln(寄/前日引)  オーバーナイト
  mfe: number; // ln(高値/寄)  上値到達(最大順行)
  mae: number; // ln(安値/寄)  下値到達(最大逆行, 通常負)
  range: number; // ln(高値/安値)  日中レンジ
  clv: number; // (引-安)/(高-安)  終値の日中レンジ内位置 0..1
  winUp: number; // 引>寄 なら1
  highMin: number; // その日の高値を付けた時刻(分)
  lowMin: number; // その日の安値を付けた時刻(分)
  path: number[]; // 寄り基準の累積対数リターン(時間格子, 長さG)
}

// 1立会日を日内特徴量に変換。O/H/L/C が壊れていれば null。
export function computeDayFeatures(day: DayData, grid: BinGrid, gmtoffset: number): DayFeatures | null {
  const o = day.open, h = day.high, l = day.low, c = day.close;
  if (!(o > 0) || !(h > 0) || !(l > 0) || !(c > 0)) return null;
  const p = day.prevClose;
  // 高値・安値を付けた時刻(最初に到達したバー)
  let highMin = localMinute(day.bars[0]?.ts ?? 0, gmtoffset);
  let lowMin = highMin;
  let hi = -Infinity, lo = Infinity;
  for (const b of day.bars) {
    if (b.high > hi) { hi = b.high; highMin = localMinute(b.ts, gmtoffset); }
    if (b.low < lo) { lo = b.low; lowMin = localMinute(b.ts, gmtoffset); }
  }
  return {
    date: day.date,
    weekday: day.weekday,
    intraday: Math.log(c / o),
    full: p > 0 ? Math.log(c / p) : null,
    gap: p > 0 ? Math.log(o / p) : null,
    mfe: Math.log(h / o),
    mae: Math.log(l / o),
    range: Math.log(h / l),
    clv: h > l ? (c - l) / (h - l) : 0.5,
    winUp: c > o ? 1 : 0,
    highMin, lowMin,
    path: dayCumPath(day, grid, gmtoffset),
  };
}

// ───────────────────────── セル集計(銘柄×曜日, または横断プール) ─────────────────────────

export interface CellStats {
  n: number;
  // 平均リターン系(発散配色)
  intraday: number; intradayP: number;
  full: number; fullP: number; nFull: number; volFull: number;
  gap: number; gapP: number; nGap: number; volGap: number;
  mfe: number;
  mae: number;
  sharpe: number; // 日中平均/日中σ
  // 大きさ系(逐次配色)
  range: number;
  vol: number; // 日中リターンの標準偏差
  // 割合系(0.5中心の発散)
  clv: number;
  winRate: number;
  // 時刻系
  peakIdx: number; // 平均パスの最大時間ビン(利確目安)
  troughIdx: number; // 平均パスの最小時間ビン(損失/仕込み目安)
  highMin: number; // 高値時刻の中央値(分)
  lowMin: number; // 安値時刻の中央値(分)
  // 形状
  path: number[]; // 平均累積パス(長さG)
  band: number[]; // 各時間ビンの標準偏差(±帯)
}

function meanP(arr: (number | null)[]): { m: number; p: number; n: number; sd: number } {
  const v = arr.filter((x): x is number => x !== null && isFinite(x));
  if (v.length === 0) return { m: 0, p: 1, n: 0, sd: 0 };
  const t = tTest(v);
  return { m: mean(v), p: t ? t.p : 1, n: v.length, sd: std(v) };
}

export function aggregateCell(feats: DayFeatures[], G: number): CellStats | null {
  const n = feats.length;
  if (n < 1) return null;
  const intra = meanP(feats.map((f) => f.intraday));
  const full = meanP(feats.map((f) => f.full));
  const gap = meanP(feats.map((f) => f.gap));
  const intradayVals = feats.map((f) => f.intraday);
  const vol = std(intradayVals);
  // 平均パスと帯
  const path = new Array(G).fill(0);
  const band = new Array(G).fill(0);
  for (let g = 0; g < G; g++) {
    const col = feats.map((f) => f.path[g] ?? 0);
    path[g] = mean(col);
    band[g] = std(col);
  }
  let peakIdx = 0, troughIdx = 0;
  for (let g = 1; g < G; g++) {
    if (path[g] > path[peakIdx]) peakIdx = g;
    if (path[g] < path[troughIdx]) troughIdx = g;
  }
  return {
    n,
    intraday: intra.m, intradayP: intra.p,
    full: full.m, fullP: full.p, nFull: full.n, volFull: full.sd,
    gap: gap.m, gapP: gap.p, nGap: gap.n, volGap: gap.sd,
    mfe: mean(feats.map((f) => f.mfe)),
    mae: mean(feats.map((f) => f.mae)),
    sharpe: vol > 0 ? intra.m / vol : 0,
    range: mean(feats.map((f) => f.range)),
    vol,
    clv: mean(feats.map((f) => f.clv)),
    winRate: mean(feats.map((f) => f.winUp)),
    peakIdx, troughIdx,
    highMin: median(feats.map((f) => f.highMin)),
    lowMin: median(feats.map((f) => f.lowMin)),
    path, band,
  };
}

// ───────────────────────── 前処理(整合・日付軸) ─────────────────────────

export interface AlignedStock {
  ticker: string;
  name?: string;
  gmtoffset: number;
  aligned: AlignedDay[];
}

export interface CrossPrep {
  stocks: AlignedStock[];
  dateAxis: string[]; // 全銘柄の立会日の和集合(昇順・重複排除)。ローリング窓の軸。
  latest: { date: string; value: number } | null;
  lastPairedUsDate: string | null;
}

export function prepCross(stocks: CrossStock[], us: UsReturn[], mode: UsMode): CrossPrep | null {
  const aligned: AlignedStock[] = stocks.map((s) => ({
    ticker: s.ticker, name: s.name, gmtoffset: s.gmtoffset,
    aligned: alignJpUs(s.days, us),
  }));
  const dateSet = new Set<string>();
  let lastPairedUsDate: string | null = null;
  for (const st of aligned) {
    for (const a of st.aligned) {
      dateSet.add(a.jp.date);
      if (!lastPairedUsDate || a.us.date > lastPairedUsDate) lastPairedUsDate = a.us.date;
    }
  }
  const dateAxis = Array.from(dateSet).sort();
  if (dateAxis.length < 8) return null;

  let latest: { date: string; value: number } | null = null;
  for (let i = us.length - 1; i >= 0; i--) {
    const v = usValueOf(us[i], mode);
    if (isFinite(v) && v !== 0) { latest = { date: us[i].date, value: v }; break; }
  }
  return { stocks: aligned, dateAxis, latest, lastPairedUsDate };
}

// ───────────────────────── ビン化(窓内・全銘柄共通の境界) ─────────────────────────

export interface CrossBinInfo {
  bin: number;
  label: string;
  color: string;
  nUsDays: number;
  rangeLo: number | null;
  rangeHi: number | null;
}

export interface CrossBinning {
  edges: number[];
  meta: BinMeta;
  binInfos: CrossBinInfo[];
  todayBin: number;
  todayUnpaired: boolean;
}

// 窓内の前夜米国リターン(日付デデュープ)からビン境界を作る。
export function computeCrossBinning(
  prep: CrossPrep, scheme: BinScheme, mode: UsMode, window: DateWindow | null
): CrossBinning | null {
  const byDate = new Map<string, number>();
  for (const st of prep.stocks) {
    for (const a of st.aligned) {
      if (!inWindow(a.jp.date, window)) continue;
      const v = usValueOf(a.us, mode);
      if (!isFinite(v) || v === 0) continue;
      byDate.set(a.us.date, v);
    }
  }
  const usVals = Array.from(byDate.values());
  if (usVals.length < 6) return null;

  const meta = binMeta(scheme);
  const edges = binEdges(usVals, scheme);
  const binOf = (v: number) => binOfValue(v, scheme, edges);
  const counts = new Array(meta.count).fill(0);
  for (const v of usVals) counts[binOf(v)]++;
  const binInfos: CrossBinInfo[] = meta.labels.map((label, b) => ({
    bin: b, label, color: meta.colors[b], nUsDays: counts[b],
    rangeLo: b === 0 ? null : edges[b - 1],
    rangeHi: b === meta.count - 1 ? null : edges[b],
  }));
  const todayBin = prep.latest ? binOf(prep.latest.value) : Math.floor(meta.count / 2);
  const todayUnpaired = !!(prep.latest && prep.lastPairedUsDate && prep.latest.date > prep.lastPairedUsDate);
  return { edges, meta, binInfos, todayBin, todayUnpaired };
}

// ───────────────────────── 選択ビン × 窓 での横断マトリクス ─────────────────────────

export interface CrossRow {
  ticker: string;
  name?: string;
  cells: (CellStats | null)[]; // CROSS_WD_ORDER 順
  nTotal: number;
}

export interface ConsensusCell extends CellStats {
  nDays: number; // 独立営業日数
  nEff: number; // 実効標本数(日中リターン基準)
  intradayCrP: number; // 日中リターンのクラスタ頑健p
}

export interface CrossResult {
  rows: CrossRow[];
  consensus: (ConsensusCell | null)[]; // CROSS_WD_ORDER 順
  nStocks: number;
  timeLabels: string[];
  grid: BinGrid;
  selBin: number;
}

export function computeCrossRows(
  prep: CrossPrep, grid: BinGrid, scheme: BinScheme, mode: UsMode,
  edges: number[], selBin: number, window: DateWindow | null
): CrossResult {
  const G = grid.bins.length;
  const timeLabels = grid.bins.map((x) => x.label);
  const selected = (a: AlignedDay) =>
    inWindow(a.jp.date, window) && binOfValue(usValueOf(a.us, mode), scheme, edges) === selBin;

  // 曜日→プール用の全銘柄特徴量(横断コンセンサス算出用)
  const pooledByWd = new Map<number, DayFeatures[]>();
  for (const wd of CROSS_WD_ORDER) pooledByWd.set(wd, []);

  const rows: CrossRow[] = [];
  let nStocks = 0;
  for (const st of prep.stocks) {
    const feats: DayFeatures[] = [];
    for (const a of st.aligned) {
      if (!selected(a) || !CROSS_WD_ORDER.includes(a.jp.weekday)) continue;
      const f = computeDayFeatures(a.jp, grid, st.gmtoffset);
      if (f) { feats.push(f); pooledByWd.get(a.jp.weekday)!.push(f); }
    }
    if (feats.length > 0) nStocks++;
    const cells: (CellStats | null)[] = CROSS_WD_ORDER.map((wd) =>
      aggregateCell(feats.filter((f) => f.weekday === wd), G)
    );
    rows.push({
      ticker: st.ticker, name: st.name, cells,
      nTotal: feats.length,
    });
  }

  const consensus: (ConsensusCell | null)[] = CROSS_WD_ORDER.map((wd) => {
    const feats = pooledByWd.get(wd)!;
    const base = aggregateCell(feats, G);
    if (!base) return null;
    // 日中リターンを日付クラスタで頑健化(同一営業日の横断相関を吸収)
    const cs = clusterStat(feats.map((f) => f.intraday), feats.map((f) => f.date));
    const nDays = cs ? cs.nDays : 0;
    const nEff = cs ? cs.nEff : 0;
    const intradayCrP = cs && cs.se > 0
      ? studentTwoSidedP(base.intraday / cs.se, Math.max(1, nDays - 1))
      : 1;
    return { ...base, nDays, nEff, intradayCrP };
  });

  return { rows, consensus, nStocks, timeLabels, grid, selBin };
}

// ───────────────────────── 行(銘柄)のスカラー化と配分ウェイト ─────────────────────────
//
// ヒートマップは(銘柄×曜日)の2次元だが、「どの銘柄に建てるか」を決めるには行を1つの数に
// 潰す必要がある。潰し方(曜日スコープ)と、そこから相対配分を作る手順をここに集約する。

// 曜日をまたぐ集計の取り方。数値 = CROSS_WD_ORDER の曜日単独。
export type WdScope = number | "best" | "mean" | "sum";
// 並び順。"abs" は符号を問わず効果の強い順(絶対値降順)。
export type SortDir = "desc" | "asc" | "abs";
// 期待値・分散をどのリターン定義で測るか。
export type MuBasis = "intraday" | "full" | "gap";

export const WD_SCOPE_LABELS: Record<string, string> = {
  sum: "週合計", mean: "平均", best: "最良曜日",
};

export function wdScopeLabel(scope: WdScope): string {
  return typeof scope === "number" ? CROSS_WD_LABELS[scope] : WD_SCOPE_LABELS[scope] ?? String(scope);
}

// 1セル(銘柄×曜日)の日内パス振幅 = 平均累積パスの山谷幅(最大−最小)。値動きの形の大きさ。
export function cellAmplitude(c: CellStats): number {
  if (!c.path || c.path.length === 0) return 0;
  let lo = Infinity, hi = -Infinity;
  for (const v of c.path) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return hi > lo ? hi - lo : 0;
}

// 基準別の平均・σ・標本数。full/gap は前日終値が要るぶん n が1日ぶん少なくなりうる。
export function cellMu(c: CellStats, basis: MuBasis): number {
  return basis === "full" ? c.full : basis === "gap" ? c.gap : c.intraday;
}
export function cellVol(c: CellStats, basis: MuBasis): number {
  return basis === "full" ? c.volFull : basis === "gap" ? c.volGap : c.vol;
}
export function cellCount(c: CellStats, basis: MuBasis): number {
  return basis === "full" ? c.nFull : basis === "gap" ? c.nGap : c.n;
}

// スコープに含まれるセル(空セルは除外)。
function scopeCells(r: CrossRow, scope: WdScope): CellStats[] {
  if (typeof scope === "number") {
    const i = CROSS_WD_ORDER.indexOf(scope);
    const c = i >= 0 ? r.cells[i] : null;
    return c && c.n >= 1 ? [c] : [];
  }
  return r.cells.filter((c): c is CellStats => !!c && c.n >= 1);
}

// 行を1スカラーへ。該当セルが無ければ NaN(呼び出し側で常に最下部へ落とす)。
//  additive=false の指標(σ・割合・時刻など)では "sum" は意味を成さないので平均へ落とす。
export function rowScalar(
  r: CrossRow,
  get: (c: CellStats) => number,
  scope: WdScope,
  dir: SortDir = "desc",
  additive = true
): number {
  const vals = scopeCells(r, scope).map(get).filter((v) => isFinite(v));
  if (vals.length === 0) return NaN;
  if (typeof scope === "number") return vals[0];
  const sum = vals.reduce((a, b) => a + b, 0);
  if (scope === "sum") return additive ? sum : sum / vals.length;
  if (scope === "mean") return sum / vals.length;
  // "best" = 並び方向にとって最も有利な曜日1つ
  if (dir === "abs") return vals.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
  return dir === "asc" ? Math.min(...vals) : Math.max(...vals);
}

// 配分の材料。μ・分散・標準誤差をスコープ整合的に合成する。
//  sum : μ=Σμ_d, σ²=Σσ_d², se=√(Σse_d²)  … 週内の5トレードを積み上げた量(日は独立とみなす)
//  mean: μ,σ²,se をトレード1回あたりに割り戻したもの
//  単一/best: その曜日のセルそのもの
export interface RowMuVar {
  mu: number;
  var: number; // σ²
  sd: number; // σ
  se: number; // 平均の標準誤差
  n: number; // 標本(立会日)数
  k: number; // 有効曜日数
  wd: number | null; // "best"/単一曜日のとき、採用した曜日
}

export function rowMuVar(r: CrossRow, scope: WdScope, basis: MuBasis, dir: SortDir = "desc"): RowMuVar | null {
  const idx: number[] = [];
  const cells: CellStats[] = [];
  r.cells.forEach((c, i) => {
    if (!c || cellCount(c, basis) < 1) return;
    if (typeof scope === "number" && CROSS_WD_ORDER[i] !== scope) return;
    if (!isFinite(cellMu(c, basis))) return;
    cells.push(c); idx.push(i);
  });
  if (cells.length === 0) return null;

  const one = (c: CellStats, i: number): RowMuVar => {
    const sd = cellVol(c, basis);
    const n = cellCount(c, basis);
    return { mu: cellMu(c, basis), var: sd * sd, sd, se: n > 0 ? sd / Math.sqrt(n) : NaN, n, k: 1, wd: CROSS_WD_ORDER[i] };
  };

  if (typeof scope === "number") return one(cells[0], idx[0]);
  if (scope === "best") {
    let bi = 0;
    for (let i = 1; i < cells.length; i++) {
      const a = cellMu(cells[bi], basis), b = cellMu(cells[i], basis);
      const better = dir === "abs" ? Math.abs(b) > Math.abs(a) : dir === "asc" ? b < a : b > a;
      if (better) bi = i;
    }
    return one(cells[bi], idx[bi]);
  }

  let mu = 0, varSum = 0, seSq = 0, n = 0;
  for (const c of cells) {
    const sd = cellVol(c, basis);
    const cn = cellCount(c, basis);
    mu += cellMu(c, basis);
    varSum += sd * sd;
    seSq += cn > 0 ? (sd * sd) / cn : 0;
    n += cn;
  }
  const k = cells.length;
  if (scope === "mean") {
    return { mu: mu / k, var: varSum / k, sd: Math.sqrt(varSum / k), se: Math.sqrt(seSq) / k, n, k, wd: null };
  }
  return { mu, var: varSum, sd: Math.sqrt(varSum), se: Math.sqrt(seSq), n, k, wd: null };
}

// ── 配分ウェイト(相関を無視したケリー近似) ──
// 対数効用 max_q E[ln(1+qr)] ≈ qμ − q²σ²/2 を q で解くと q* = μ/σ²。
// これを銘柄ごとに出し、正の分だけを合計1に正規化して「予算のうち何%を割くか」にする。
// 相関はここでは一切見ていない(＝分散効果を過大評価する上限値)。
export interface AllocOpts {
  haircut: boolean; // μ から1標準誤差を差し引いた保守値を使う
  minN: number; // これ未満の標本数の銘柄は配分から除外
}
export const DEFAULT_ALLOC: AllocOpts = { haircut: true, minN: 5 };

export interface AllocRow extends RowMuVar {
  ticker: string;
  muAdj: number; // 保守値 μ̃
  kelly: number; // max(0, μ̃/σ²)
  weight: number; // kelly を全銘柄で正規化した相対配分(0..1)
  excluded: boolean; // n 不足で配分対象外
}

export function allocWeights(
  rows: CrossRow[], scope: WdScope, basis: MuBasis, opts: AllocOpts = DEFAULT_ALLOC, dir: SortDir = "desc"
): Map<string, AllocRow> {
  const out = new Map<string, AllocRow>();
  let total = 0;
  for (const r of rows) {
    const mv = rowMuVar(r, scope, basis, dir);
    if (!mv) continue;
    const excluded = mv.n < opts.minN || !(mv.var > 0);
    const se = isFinite(mv.se) ? mv.se : 0;
    const muAdj = opts.haircut ? Math.sign(mv.mu) * Math.max(0, Math.abs(mv.mu) - se) : mv.mu;
    const kelly = excluded ? 0 : Math.max(0, muAdj / mv.var);
    total += kelly;
    out.set(r.ticker, { ...mv, ticker: r.ticker, muAdj, kelly, weight: 0, excluded });
  }
  if (total > 0) for (const a of out.values()) a.weight = a.kelly / total;
  return out;
}

export { minuteToLabel };
