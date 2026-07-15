// 今週の値動きの軌跡を、過去の類似局面(似た形)または前夜米国ビンで絞った過去局面と
// 突き合わせるアナログ分析(日足)。
//
// 中核の考え方: すべての窓を「窓末(=今日, t=0)を 0% とする累積リターン」に再基準化する。
// こうすると t=0 で全系列が 0 に収束し、
//   - 左側(t<0, リードイン): どんな経路で今日に至ったか  → 今週と過去の「形」を比較
//   - 右側(t>0, フォワード):  その後どう動いたか          → 中央値パス＋分位帯で先読み
// が 1 枚の連続した図で読める。今週(クエリ)はフォワードが未確定なのでリードインのみ描く。
//
// 2 つの選択モード:
//   similar: 今週のリードイン形状に最も近い過去 K 窓(z化ユークリッド距離)
//   usbin:   窓の起点(週初め)の前夜米国が指定ビンだった過去窓すべて
//
// 米国ビンは JP 日足の各日に「その寄り前で最後に確定した米国立会日(暦日が厳密に小さい最新)」の
// リターンを対応付けて層別する(us-spillover-core と同じ時差ロジックの日足版)。

import { PricePoint } from "./types";
import {
  UsReturn, BinScheme, BinMeta, binMeta, binEdges, binOfValue,
} from "./us-spillover-core";
import { quantileSorted } from "./stats-significance";

export type AnalogMode = "similar" | "usbin";
export type UsMode = "ret" | "intra";

export interface AnalogWindow {
  endIndex: number;
  startTime: string;
  endTime: string;
  lead: number[]; // 長さ L。窓末=0% とする累積リターン(lead[L-1]=0)
  forward: number[]; // 長さ H+1。forward[0]=0
  forwardReturn: number; // H日後の累積リターン
  usBin: number | null; // 窓起点(週初め)の前夜米国ビン
  distance: number; // 今週リードイン形状への z化ユークリッド距離
}

export interface WeeklyAnalogResult {
  mode: AnalogMode;
  L: number;
  H: number;
  query: AnalogWindow; // 今週(フォワードは未確定なので forward は空)
  queryUsBin: number | null;
  selBin: number; // usbin モードで表示中のビン
  binMetaObj: BinMeta;
  binCounts: number[]; // 各ビンに属する過去窓数
  selected: AnalogWindow[];
  leadMedian: number[]; leadP25: number[]; leadP75: number[];
  fwdMedian: number[]; fwdP25: number[]; fwdP75: number[];
  upCount: number; downCount: number;
  medianFinal: number; meanFinal: number;
  totalCandidates: number;
}

// ───────────────────────── 米国ビンを JP 日足インデックスへ対応付け ─────────────────────────

interface UsBinAlign {
  bins: (number | null)[]; // prices と同じ長さ。各 JP 日の「前夜米国」ビン
  meta: BinMeta;
}

function alignUsBins(
  prices: PricePoint[], us: UsReturn[], usMode: UsMode, scheme: BinScheme
): UsBinAlign {
  const usSorted = [...us].sort((a, b) => a.date.localeCompare(b.date));
  const raw: (number | null)[] = [];
  let j = 0;
  for (const p of prices) {
    while (j < usSorted.length && usSorted[j].date < p.time) j++;
    const idx = j - 1; // 「p.time より暦日が厳密に小さい最新」の米国立会日
    if (idx < 0) { raw.push(null); continue; }
    const v = usMode === "intra" ? usSorted[idx].intra : usSorted[idx].ret;
    raw.push(isFinite(v) ? v : null);
  }
  const present = raw.filter((v): v is number => v !== null);
  const meta = binMeta(scheme);
  const edges = present.length >= 6 ? binEdges(present, scheme) : [];
  const bins = raw.map((v) => (v === null || edges.length === 0 ? null : binOfValue(v, scheme, edges)));
  return { bins, meta };
}

// ───────────────────────── 窓の正規化・距離 ─────────────────────────

// 窓末(end)を 0% とする累積リターン列(長さ L)。close 不正なら null。
function leadPath(prices: PricePoint[], end: number, L: number): number[] | null {
  const start = end - L + 1;
  if (start < 0) return null;
  const baseC = prices[end].close;
  if (!(baseC > 0)) return null;
  const out: number[] = [];
  for (let i = start; i <= end; i++) {
    const c = prices[i].close;
    if (!(c > 0)) return null;
    out.push(c / baseC - 1);
  }
  return out;
}

// z化(形状のみ比較。水準・スケール差を吸収)。
function zShape(lead: number[]): number[] {
  const m = lead.reduce((s, v) => s + v, 0) / lead.length;
  const sd = Math.sqrt(lead.reduce((s, v) => s + (v - m) ** 2, 0) / lead.length) || 1;
  return lead.map((v) => (v - m) / sd);
}

function euclid(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

function forwardPath(prices: PricePoint[], end: number, H: number): number[] | null {
  const baseC = prices[end].close;
  if (!(baseC > 0)) return null;
  const out: number[] = [];
  for (let m = 0; m <= H; m++) {
    const c = prices[end + m]?.close;
    if (!(c > 0)) return null;
    out.push(c / baseC - 1);
  }
  return out;
}

function aggPaths(paths: number[][], len: number): { med: number[]; p25: number[]; p75: number[] } {
  const med: number[] = [], p25: number[] = [], p75: number[] = [];
  for (let i = 0; i < len; i++) {
    const col = paths.map((p) => p[i]).filter((v) => isFinite(v)).sort((a, b) => a - b);
    med.push(quantileSorted(col, 0.5));
    p25.push(quantileSorted(col, 0.25));
    p75.push(quantileSorted(col, 0.75));
  }
  return { med, p25, p75 };
}

// ───────────────────────── 本体 ─────────────────────────

export interface WeeklyAnalogParams {
  prices: PricePoint[];
  us: UsReturn[];
  L: number; // リードイン日数(今週=5)
  H: number; // フォワード日数
  K: number; // similar モードの近傍数
  mode: AnalogMode;
  usMode: UsMode;
  scheme: BinScheme;
  selBinOverride?: number | null; // usbin モードで見るビン(null=今週の起点ビン)
}

export function computeWeeklyAnalog(params: WeeklyAnalogParams): WeeklyAnalogResult | null {
  const { prices, us, L, H, K, mode, usMode, scheme } = params;
  const n = prices.length;
  if (n < L + H + 20) return null;

  const { bins: usBinByIdx, meta } = alignUsBins(prices, us, usMode, scheme);

  // 今週(クエリ): 窓末 = 最新
  const qEnd = n - 1;
  const qLead = leadPath(prices, qEnd, L);
  if (!qLead) return null;
  const qStart = qEnd - L + 1;
  const qZ = zShape(qLead);
  const queryUsBin = usBinByIdx[qStart];
  const query: AnalogWindow = {
    endIndex: qEnd, startTime: prices[qStart].time, endTime: prices[qEnd].time,
    lead: qLead, forward: [], forwardReturn: NaN, usBin: queryUsBin, distance: 0,
  };

  // 候補窓: フォワード余地あり(j+H<=n-1)かつ 今週リードインと重ならない(窓末 < 今週窓の起点)
  const jMax = Math.min(n - 1 - H, qStart - 1);
  const cands: AnalogWindow[] = [];
  const binCounts = new Array(meta.count).fill(0);
  for (let j = L - 1; j <= jMax; j++) {
    const lead = leadPath(prices, j, L);
    if (!lead) continue;
    const fwd = forwardPath(prices, j, H);
    if (!fwd) continue;
    const wStart = j - L + 1;
    const usBin = usBinByIdx[wStart];
    if (usBin !== null) binCounts[usBin]++;
    cands.push({
      endIndex: j, startTime: prices[wStart].time, endTime: prices[j].time,
      lead, forward: fwd, forwardReturn: fwd[H], usBin,
      distance: euclid(qZ, zShape(lead)),
    });
  }
  if (cands.length < 5) return null;

  // 表示ビン(usbin モード): 明示指定 > 今週の起点ビン > 標本最多ビン
  let selBin = params.selBinOverride ?? queryUsBin ?? binCounts.indexOf(Math.max(...binCounts));
  if (selBin < 0 || selBin >= meta.count) selBin = 0;

  // 選抜
  let selected: AnalogWindow[];
  if (mode === "usbin") {
    selected = cands.filter((c) => c.usBin === selBin).sort((a, b) => a.distance - b.distance);
  } else {
    selected = [...cands].sort((a, b) => a.distance - b.distance).slice(0, Math.min(K, cands.length));
  }
  if (selected.length < 2) return null;

  const lead = aggPaths(selected.map((s) => s.lead), L);
  const fwd = aggPaths(selected.map((s) => s.forward), H + 1);
  const finals = selected.map((s) => s.forwardReturn).filter((v) => isFinite(v));
  const upCount = finals.filter((v) => v > 0).length;
  const meanFinal = finals.reduce((s, v) => s + v, 0) / (finals.length || 1);

  return {
    mode, L, H, query, queryUsBin, selBin, binMetaObj: meta, binCounts,
    selected,
    leadMedian: lead.med, leadP25: lead.p25, leadP75: lead.p75,
    fwdMedian: fwd.med, fwdP25: fwd.p25, fwdP75: fwd.p75,
    upCount, downCount: finals.length - upCount,
    medianFinal: fwd.med[H], meanFinal,
    totalCandidates: cands.length,
  };
}
