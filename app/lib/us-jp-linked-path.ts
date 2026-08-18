// 前夜米国の「日中経路」→ 当日日本の「日中経路」を1本に繋いで見る。
//
// 既存のスピルオーバー分析は前夜の米国を必ず1つのスカラー(終値の騰落率)に潰している。
// だが同じ +2% でも、寄りから一本調子で上げた日と、下げていて引け際30分で急伸した日では、
// 日本が寄り付く時点で残っている「勢い」がまるで違う。日本の寄り付き前に確定しているのは
// 数字1つではなく、米国セッションの経路そのものである。
//
// このモジュールは米国指数の日中足も取得し、
//   ・米国セッションの経路(寄り基準の累積対数リターン)
//   ・その形の特徴量(終盤の勢い・日中最大/最小・経路効率・逆行幅)
// を作って層別し、当日の日本の日内パスと連結して描く。さらに
//   「終値の1点」で説明できる分を除いてなお、経路の形に説明力が残っているか
// を増分F検定で確かめる(=形で条件付ける価値があるのか)。
//
// 連結の作法: 米国区間は「米国の寄り=0」、日本区間は「日本の前日終値=0」を基準にする。
// 別々の資産なので水準を跨いで足し算はできない。境界で基準を張り替え、同じ縦軸(対数リターン)
// の上に隣り合わせで描く。日本側は ギャップ → 日中 が加法で繋がる。

import { DayData, BinGrid } from "./intraday-core";
import { dayCumPath, assignBins, binEdges, binMeta, binOfValue, BinScheme, mulberry32 } from "./us-spillover-core";
import { PathGroup, PathStat, PairDiff, buildPathStats, pairwiseEndDiffs } from "./intraday-path-core";
import { zShape } from "./weekly-analog";
import { mean, studentTwoSidedP, fSurvival } from "./stats-significance";
import { CHART_COLORS } from "./chart-colors";

// ───────────────────────── 米国セッションの経路と形の特徴量 ─────────────────────────

export interface UsSessionPath {
  date: string; // 米国立会日
  path: number[]; // 米国の時間格子上の累積対数リターン ln(P_t / 米国寄り)
  ret: number; // ln(C / 前日C) 前日終値比(既存のビン分析が使ってきたスカラー)
  intra: number; // ln(C / O) 米国セッション内の騰落
  finish: number; // 終盤1/3の伸び ln(C / P_{2/3})
  pathMax: number; // セッション中の最大到達(寄り基準)
  pathMin: number; // 同 最小到達
  efficiency: number; // |終値| / Σ|バーごとの変化| 経路効率(1に近いほど一本調子)
  adverse: number; // 終値の方向に対する最大逆行(絶対値)
  peakIdx: number;
  troughIdx: number;
}

function argMax(a: number[]): number { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i; return k; }
function argMin(a: number[]): number { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] < a[k]) k = i; return k; }

// 米国日中足の各立会日から、経路と形の特徴量を作る。
export function buildUsSessionPaths(usDays: DayData[], grid: BinGrid, gmtoffset: number): UsSessionPath[] {
  const G = grid.bins.length;
  const out: UsSessionPath[] = [];
  for (const d of usDays) {
    if (!(d.open > 0) || !(d.close > 0)) continue;
    const path = dayCumPath(d, grid, gmtoffset);
    const end = path[G - 1];
    const twoThird = Math.max(0, Math.floor((2 * G) / 3) - 1);
    let absSum = 0;
    for (let g = 0; g < G; g++) absSum += Math.abs(path[g] - (g === 0 ? 0 : path[g - 1]));
    // 終値の方向に対する最大逆行: 上げた日なら最大の押し、下げた日なら最大の戻し。
    const adverse = end >= 0 ? Math.max(0, -Math.min(...path)) : Math.max(0, Math.max(...path));
    out.push({
      date: d.date,
      path,
      ret: d.prevClose > 0 ? Math.log(d.close / d.prevClose) : end,
      intra: end,
      finish: end - path[twoThird],
      pathMax: Math.max(...path),
      pathMin: Math.min(...path),
      efficiency: absSum > 0 ? Math.abs(end) / absSum : 0,
      adverse,
      peakIdx: argMax(path),
      troughIdx: argMin(path),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ───────────────────────── JP立会日 × 前夜米国セッション の整合 ─────────────────────────

export interface LinkedDay {
  jp: DayData;
  us: UsSessionPath; // その寄り前で最後に確定した米国セッション
  gap: number; // JP 夜間ギャップ ln(open/prevClose)
  intra: number; // JP 日中 ln(close/open)
  full: number; // JP 当日 ln(close/prevClose)
}

// 日付が厳密に小さい最新の米国立会日を対応付ける(us-spillover-core.alignJpUs と同じ時差ロジック)。
export function linkJpUs(jpDays: DayData[], usPaths: UsSessionPath[]): LinkedDay[] {
  const us = [...usPaths].sort((a, b) => a.date.localeCompare(b.date));
  const jp = [...jpDays].sort((a, b) => a.date.localeCompare(b.date));
  const out: LinkedDay[] = [];
  let j = 0;
  for (const d of jp) {
    while (j < us.length && us[j].date < d.date) j++;
    const idx = j - 1;
    if (idx < 0) continue;
    const pc = d.prevClose, o = d.open, c = d.close;
    if (!(pc > 0) || !(o > 0) || !(c > 0)) continue;
    const gap = Math.log(o / pc), intra = Math.log(c / o);
    out.push({ jp: d, us: us[idx], gap, intra, full: gap + intra });
  }
  return out;
}

// ───────────────────────── 層別 ─────────────────────────

export type LinkGroupMode = "close" | "finish" | "shape";
export const LINK_GROUP_MODES: { value: LinkGroupMode; label: string; note: string }[] = [
  { value: "close", label: "終値ビン（従来）", note: "前夜米国の前日終値比だけで層別。経路を1点に潰した既存の見方" },
  { value: "finish", label: "引け際の勢い", note: "米国セッション終盤1/3のリターンで層別。同じ終値でも「引け際に伸びた/失速した」を分ける" },
  { value: "shape", label: "経路の形（クラスタ）", note: "米国の経路をz化してk-meansで3類型に分け、形そのもので層別する" },
];

export interface LinkGroup {
  key: string;
  label: string;
  color: string;
  idxs: number[]; // rows のインデックス
  usMean: number[]; // その群の米国平均経路
  desc: string; // 群の特徴(終値・終盤の平均)
}

const SHAPE_COLORS = ["#dc2626", CHART_COLORS.neutral, "#16a34a"];

// k-means(k=3)でz化した米国経路をクラスタリングする。初期値は「終盤の勢い」の分位で決め、
// 乱数依存を最小化する(同じデータなら同じ層別になるようにする)。
function kmeansShapes(paths: number[][], k: number): number[] {
  const n = paths.length, G = paths[0].length;
  if (n < k * 3) return new Array(n).fill(0);
  const z = paths.map(zShape);
  // 初期центroid: 終端値の分位で3点を選ぶ
  const order = z.map((p, i) => ({ i, v: p[G - 1] })).sort((a, b) => a.v - b.v);
  const cents: number[][] = [];
  for (let c = 0; c < k; c++) {
    const pick = order[Math.min(n - 1, Math.floor(((c + 0.5) * n) / k))].i;
    cents.push([...z[pick]]);
  }
  const assign = new Array(n).fill(0);
  const rng = mulberry32(0x515ce5);
  for (let iter = 0; iter < 25; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        let d = 0;
        for (let g = 0; g < G; g++) d += (z[i][g] - cents[c][g]) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    for (let c = 0; c < k; c++) {
      const members = z.filter((_, i) => assign[i] === c);
      if (members.length === 0) { // 空クラスタは無作為な1点で再初期化
        cents[c] = [...z[Math.floor(rng() * n)]];
        continue;
      }
      for (let g = 0; g < G; g++) cents[c][g] = mean(members.map((m) => m[g]));
    }
    if (!moved) break;
  }
  // 群の並びを「終端の平均」で昇順に振り直す(色と意味を安定させる)
  const endMeans = Array.from({ length: k }, (_, c) => {
    const m = paths.filter((_, i) => assign[i] === c);
    return m.length ? mean(m.map((p) => p[G - 1])) : 0;
  });
  const rank = endMeans.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v).map((o) => o.i);
  const remap = new Array(k).fill(0);
  rank.forEach((orig, newIdx) => { remap[orig] = newIdx; });
  return assign.map((c) => remap[c]);
}

// 群の形を日本語で言い表す(終端の符号 × 終盤の伸びの符号)。
function shapeLabel(endMean: number, finishMean: number): string {
  const up = endMean >= 0;
  const late = finishMean >= 0;
  if (up && late) return "上げて引け強";
  if (up && !late) return "上げたが失速";
  if (!up && late) return "下げたが引け戻し";
  return "下げて引け弱";
}

export interface GroupingResult {
  groups: LinkGroup[];
  edges: number[]; // close/finish のビン境界(shape では空)
  todayGroup: number | null; // まだ日本が寄っていない最新の米国セッションが属する群
  todayUs: UsSessionPath | null;
}

export function buildLinkGroups(
  rows: LinkedDay[], mode: LinkGroupMode, scheme: BinScheme,
  latestUs: UsSessionPath | null, usG: number
): GroupingResult | null {
  if (rows.length < 10) return null;

  if (mode === "shape") {
    const assign = kmeansShapes(rows.map((r) => r.us.path), 3);
    const groups: LinkGroup[] = [0, 1, 2].map((c) => {
      const idxs = rows.map((_, i) => i).filter((i) => assign[i] === c);
      const usMean = new Array(usG).fill(0);
      for (let g = 0; g < usG; g++) usMean[g] = idxs.length ? mean(idxs.map((i) => rows[i].us.path[g])) : 0;
      const endM = idxs.length ? mean(idxs.map((i) => rows[i].us.intra)) : 0;
      const finM = idxs.length ? mean(idxs.map((i) => rows[i].us.finish)) : 0;
      return {
        key: `shape${c}`,
        label: shapeLabel(endM, finM),
        color: SHAPE_COLORS[c],
        idxs,
        usMean,
        desc: `米国 日中${(endM * 100).toFixed(2)}%／終盤${(finM * 100).toFixed(2)}%`,
      };
    });
    // 今夜の米国をどの群に入れるか: 平均経路(z化)への最近傍
    let todayGroup: number | null = null;
    if (latestUs) {
      const zt = zShape(latestUs.path);
      let best = -1, bestD = Infinity;
      groups.forEach((g, c) => {
        if (g.idxs.length === 0) return;
        const zc = zShape(g.usMean);
        let d = 0;
        for (let i = 0; i < usG; i++) d += (zt[i] - zc[i]) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      });
      todayGroup = best >= 0 ? best : null;
    }
    return { groups, edges: [], todayGroup, todayUs: latestUs };
  }

  // close / finish: 指定スキームの分位ビン
  const vals = rows.map((r) => (mode === "close" ? r.us.ret : r.us.finish));
  const binIdx = assignBins(vals, scheme);
  const edges = binEdges(vals, scheme);
  const meta = binMeta(scheme);
  const groups: LinkGroup[] = meta.labels.map((lab, b) => {
    const idxs = rows.map((_, i) => i).filter((i) => binIdx[i] === b);
    const usMean = new Array(usG).fill(0);
    for (let g = 0; g < usG; g++) usMean[g] = idxs.length ? mean(idxs.map((i) => rows[i].us.path[g])) : 0;
    const endM = idxs.length ? mean(idxs.map((i) => rows[i].us.intra)) : 0;
    const finM = idxs.length ? mean(idxs.map((i) => rows[i].us.finish)) : 0;
    return {
      key: `${mode}${b}`,
      label: mode === "close" ? lab : `終盤${labelOfFinishBin(b, meta.count)}`,
      color: meta.colors[b],
      idxs,
      usMean,
      desc: `米国 日中${(endM * 100).toFixed(2)}%／終盤${(finM * 100).toFixed(2)}%`,
    };
  });
  const todayGroup = latestUs
    ? binOfValue(mode === "close" ? latestUs.ret : latestUs.finish, scheme, edges)
    : null;
  return { groups, edges, todayGroup, todayUs: latestUs };
}

function labelOfFinishBin(b: number, count: number): string {
  if (count === 2) return b === 0 ? "失速" : "伸び";
  if (count === 3) return ["失速", "中立", "伸び"][b];
  return ["大失速", "失速", "中立", "伸び", "大伸び"][b];
}

// ───────────────────────── JP側の日内パス統計 ─────────────────────────

export interface LinkedResult {
  usLabels: string[];
  jpLabels: string[];
  groups: LinkGroup[];
  jpStats: PathStat[]; // groups と同順のJP日内パス統計
  pairDiffs: PairDiff[];
  maxAbsUs: number;
  maxAbsJp: number;
  gapMeans: number[]; // groups と同順のJP夜間ギャップ平均
  todayGroup: number | null;
  todayUs: UsSessionPath | null;
  n: number;
}

export function computeLinkedPaths(
  rows: LinkedDay[], grouping: GroupingResult,
  usGrid: BinGrid, jpGrid: BinGrid, jpGmtoffset: number
): LinkedResult {
  const jpG = jpGrid.bins.length;
  const pathGroups: PathGroup[] = grouping.groups.map((g) => ({
    key: g.key, label: g.label, color: g.color,
    paths: g.idxs.map((i) => dayCumPath(rows[i].jp, jpGrid, jpGmtoffset)),
    dates: g.idxs.map((i) => rows[i].jp.date),
  }));
  const { stats, maxAbs } = buildPathStats(pathGroups, jpG);
  let maxAbsUs = 1e-6;
  for (const g of grouping.groups) for (const v of g.usMean) maxAbsUs = Math.max(maxAbsUs, Math.abs(v));

  return {
    usLabels: usGrid.bins.map((b) => b.label),
    jpLabels: jpGrid.bins.map((b) => b.label),
    groups: grouping.groups,
    jpStats: stats,
    pairDiffs: pairwiseEndDiffs(stats),
    maxAbsUs,
    maxAbsJp: maxAbs,
    gapMeans: grouping.groups.map((g) => (g.idxs.length ? mean(g.idxs.map((i) => rows[i].gap)) : 0)),
    todayGroup: grouping.todayGroup,
    todayUs: grouping.todayUs,
    n: rows.length,
  };
}

// ───────────────────────── 増分F検定(終値の1点 vs 経路の形) ─────────────────────────

export type LinkTarget = "gap" | "intra" | "full";
export const LINK_TARGETS: { value: LinkTarget; label: string; note: string }[] = [
  { value: "gap", label: "夜間ギャップ", note: "ln(当日始値/前日終値)。寄り付きの時点で米国をどう織り込んだか" },
  { value: "intra", label: "当日日中", note: "ln(当日終値/当日始値)。寄り後に米国の“漏れ出し”が続くか" },
  { value: "full", label: "当日全体", note: "ln(当日終値/前日終値)＝ギャップ＋日中" },
];

export interface CoefRow { name: string; beta: number; t: number; p: number; }

export interface IncrementalTest {
  n: number;
  r2Base: number; // 終値の1点(前日終値比・日中騰落)だけの決定係数
  r2Full: number; // + 経路の形(終盤の勢い・日中最大・日中最小)
  dR2: number;
  f: number; // 増分F統計量
  p: number; // その両側p値
  q: number; // 追加した説明変数の数
  coefs: CoefRow[];
}

// ガウス消去法による最小二乗(切片は呼び出し側でXに1列目として入れる)。
function olsMulti(X: number[][], y: number[]): { beta: number[]; sse: number; sst: number; se: number[] } | null {
  const n = X.length, p = X[0].length;
  if (n <= p + 1) return null;
  // 正規方程式 XᵀX β = Xᵀy
  const A: number[][] = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let r = 0; r < n; r++) s += X[r][i] * X[r][j];
      A[i][j] = s;
    }
    let s = 0;
    for (let r = 0; r < n; r++) s += X[r][i] * y[r];
    A[i][p] = s;
  }
  // 前進消去 + 後退代入。XᵀX の逆行列も同時に得るため拡大行列を別途持つ。
  const inv: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (i === j ? 1 : 0))
  );
  const M = A.map((row) => [...row]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    [inv[c], inv[piv]] = [inv[piv], inv[c]];
    const d = M[c][c];
    for (let j = 0; j <= p; j++) M[c][j] /= d;
    for (let j = 0; j < p; j++) inv[c][j] /= d;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let j = 0; j <= p; j++) M[r][j] -= f * M[c][j];
      for (let j = 0; j < p; j++) inv[r][j] -= f * inv[c][j];
    }
  }
  const beta = M.map((row) => row[p]);
  const my = mean(y);
  let sse = 0, sst = 0;
  for (let r = 0; r < n; r++) {
    let pred = 0;
    for (let j = 0; j < p; j++) pred += X[r][j] * beta[j];
    sse += (y[r] - pred) ** 2;
    sst += (y[r] - my) ** 2;
  }
  const sigma2 = sse / (n - p);
  const se = inv.map((row, i) => Math.sqrt(Math.max(0, sigma2 * row[i])));
  return { beta, sse, sst, se };
}

// 「終値の1点」で説明できる分を除いて、なお経路の形に説明力が残っているか。
//   基準モデル: y = a + b1·(前日終値比) + b2·(米国日中騰落)          … 終点の情報だけ
//   完全モデル: + b3·(終盤の勢い) + b4·(日中最大) + b5·(日中最小)     … 経路の形
// 増分F = ((SSE_base − SSE_full)/q) / (SSE_full/(n−p_full))
export function incrementalShapeTest(rows: LinkedDay[], target: LinkTarget): IncrementalTest | null {
  const n = rows.length;
  if (n < 40) return null;
  const y = rows.map((r) => (target === "gap" ? r.gap : target === "intra" ? r.intra : r.full));
  const base = rows.map((r) => [1, r.us.ret, r.us.intra]);
  const full = rows.map((r) => [1, r.us.ret, r.us.intra, r.us.finish, r.us.pathMax, r.us.pathMin]);
  const rb = olsMulti(base, y), rf = olsMulti(full, y);
  if (!rb || !rf) return null;
  const q = full[0].length - base[0].length;
  const dfFull = n - full[0].length;
  const f = ((rb.sse - rf.sse) / q) / (rf.sse / dfFull);
  const names = ["切片", "前夜米国(前日終値比)", "前夜米国(日中)", "終盤1/3の勢い", "米国日中の最大", "米国日中の最小"];
  const coefs: CoefRow[] = rf.beta.map((b, i) => {
    const t = rf.se[i] > 0 ? b / rf.se[i] : 0;
    return { name: names[i], beta: b, t, p: studentTwoSidedP(t, dfFull) };
  });
  return {
    n,
    r2Base: rb.sst > 0 ? 1 - rb.sse / rb.sst : 0,
    r2Full: rf.sst > 0 ? 1 - rf.sse / rf.sst : 0,
    dR2: rb.sst > 0 ? (rb.sse - rf.sse) / rb.sst : 0,
    f,
    p: fSurvival(f, q, dfFull),
    q,
    coefs,
  };
}
