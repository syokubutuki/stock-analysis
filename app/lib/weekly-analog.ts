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
// 形状距離: euclid=等速比較(時間のズレに弱い) / dtw=動的時間伸縮(ズレを吸収)
export type DistMetric = "euclid" | "dtw";
// 窓の取り方: trailing=直近L営業日 / week=今週(週境界にアライン。月曜起点で今日まで)
export type WindowAlign = "trailing" | "week";

export interface AnalogWindow {
  endIndex: number;
  startTime: string;
  endTime: string;
  lead: number[]; // 長さ L。窓末=今日=0% とする終値の累積リターン(lead[L-1]=0)
  leadHigh: number[]; // 各日の高値(窓末終値比)。日中レンジの上端
  leadLow: number[]; // 各日の安値(窓末終値比)。日中レンジの下端
  forward: number[]; // 長さ H+1。終値の累積リターン forward[0]=0
  fwdHigh: number[]; // 各時点までの高値到達(running max, MFE)。利確余地
  fwdLow: number[]; // 各時点までの安値到達(running min, MAE)。含み損の深さ
  forwardReturn: number; // H日後の終値累積リターン
  mfe: number; // H日以内の最大高値到達
  mae: number; // H日以内の最大安値到達(通常負)
  usBin: number | null; // 窓起点(週初め)の前夜米国ビン
  distance: number; // 今週リードイン形状への z化ユークリッド距離
}

export interface WeeklyAnalogResult {
  mode: AnalogMode;
  L: number; // 実際に使ったリードイン日数(align="week" では今週の経過日数)
  H: number;
  align: WindowAlign;
  metric: DistMetric;
  query: AnalogWindow; // 今週(フォワードは未確定なので forward は空)
  queryUsBin: number | null;
  selBin: number; // usbin モードで表示中のビン
  binMetaObj: BinMeta;
  binCounts: number[]; // 各ビンに属する過去窓数
  selected: AnalogWindow[];
  leadMedian: number[]; leadP25: number[]; leadP75: number[];
  fwdMedian: number[]; fwdP25: number[]; fwdP75: number[];
  fwdHighMedian: number[]; fwdLowMedian: number[]; // 高値/安値到達の中央値パス(MFE/MAE)
  upCount: number; downCount: number;
  medianFinal: number; meanFinal: number;
  medianMfe: number; medianMae: number; // H日以内の高値/安値到達の中央値
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

// 窓末(end)を 0% とする終値累積リターン列(長さ L)＋各日の高値/安値(窓末終値比)。close 不正なら null。
function buildLead(prices: PricePoint[], end: number, L: number):
  { lead: number[]; leadHigh: number[]; leadLow: number[] } | null {
  const start = end - L + 1;
  if (start < 0) return null;
  const baseC = prices[end].close;
  if (!(baseC > 0)) return null;
  const lead: number[] = [], leadHigh: number[] = [], leadLow: number[] = [];
  for (let i = start; i <= end; i++) {
    const c = prices[i].close, h = prices[i].high, lo = prices[i].low;
    if (!(c > 0)) return null;
    lead.push(c / baseC - 1);
    leadHigh.push((h > 0 ? h : c) / baseC - 1);
    leadLow.push((lo > 0 ? lo : c) / baseC - 1);
  }
  return { lead, leadHigh, leadLow };
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

// DTW(動的時間伸縮)距離。等速比較のユークリッドと違い、時間軸の伸び縮み(山が1日早い/遅い等)を
// 吸収して「形」を突き合わせる。Sakoe-Chiba バンドで warping 幅を制限し、退化と計算量を抑える。
//   D[i][j] = (a_i - b_j)^2 + min(D[i-1][j], D[i][j-1], D[i-1][j-1])
// 累積コストの平方根を返す(全候補が同じ窓長なので順位付けに使える)。
function dtw(a: number[], b: number[], band: number): number {
  const n = a.length, m = b.length;
  const w = Math.max(band, Math.abs(n - m));
  let prev = new Array<number>(m + 1).fill(Infinity);
  let cur = new Array<number>(m + 1).fill(Infinity);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    const jS = Math.max(1, i - w), jE = Math.min(m, i + w);
    for (let j = jS; j <= jE; j++) {
      const cost = (a[i - 1] - b[j - 1]) ** 2;
      cur[j] = cost + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    const t = prev; prev = cur; cur = t;
  }
  const d = prev[m];
  return isFinite(d) ? Math.sqrt(d) : Infinity;
}

// 形状距離(z化済みの2波形)。dtw のバンドは窓長の約1/4(最低1)。
function shapeDist(a: number[], b: number[], metric: DistMetric): number {
  if (metric === "dtw") return dtw(a, b, Math.max(1, Math.round(a.length * 0.25)));
  return euclid(a, b);
}

// ───────────────────────── 週境界(月曜起点)のグルーピング ─────────────────────────

// その日が属する週の月曜日(YYYY-MM-DD)。曜日は UTC 基準で扱い、TZ による揺れを避ける。
function weekKey(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  const dow = d.getUTCDay(); // 0=日..6=土
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow)); // その週の月曜へ
  return d.toISOString().slice(0, 10);
}

// 立会日インデックスを週(月曜起点)ごとにまとめる。各配列は昇順・連続インデックス。
function groupWeeks(prices: PricePoint[]): Map<string, number[]> {
  const g = new Map<string, number[]>();
  for (let i = 0; i < prices.length; i++) {
    const k = weekKey(prices[i].time);
    const a = g.get(k);
    if (a) a.push(i); else g.set(k, [i]);
  }
  return g;
}

// 窓末(end)を 0% とするフォワード終値パス＋高値/安値の到達(running max/min = MFE/MAE)。
function buildForward(prices: PricePoint[], end: number, H: number):
  { forward: number[]; fwdHigh: number[]; fwdLow: number[] } | null {
  const baseC = prices[end].close;
  if (!(baseC > 0)) return null;
  const forward: number[] = [], fwdHigh: number[] = [], fwdLow: number[] = [];
  let runH = -Infinity, runL = Infinity;
  for (let m = 0; m <= H; m++) {
    const p = prices[end + m];
    if (!p || !(p.close > 0)) return null;
    forward.push(p.close / baseC - 1);
    const h = (p.high > 0 ? p.high : p.close) / baseC - 1;
    const lo = (p.low > 0 ? p.low : p.close) / baseC - 1;
    runH = Math.max(runH, h); runL = Math.min(runL, lo);
    fwdHigh.push(runH); fwdLow.push(runL);
  }
  return { forward, fwdHigh, fwdLow };
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
  L: number; // リードイン日数(align="week" では今週の経過日数で上書きされる)
  H: number; // フォワード日数
  K: number; // similar モードの近傍数
  mode: AnalogMode;
  usMode: UsMode;
  scheme: BinScheme;
  selBinOverride?: number | null; // usbin モードで見るビン(null=今週の起点ビン)
  metric?: DistMetric; // 形状距離(既定 euclid)
  align?: WindowAlign; // 窓の取り方(既定 trailing)
}

export function computeWeeklyAnalog(params: WeeklyAnalogParams): WeeklyAnalogResult | null {
  const { prices, us, H, K, mode, usMode, scheme } = params;
  const metric = params.metric ?? "euclid";
  const align = params.align ?? "trailing";
  const n = prices.length;
  if (n < params.L + H + 20) return null;

  const { bins: usBinByIdx, meta } = alignUsBins(prices, us, usMode, scheme);

  // 窓長 L と候補窓末の集合を、窓の取り方に応じて決める。
  //  trailing: 直近L営業日。候補は全ての位置。
  //  week:     今週(月曜起点)の経過日数を L とし、候補は「過去の各週の先頭L日」に限定。
  //            → 曜日位置が今週と揃い、窓起点=週初め(前夜米国ビンの基準)も厳密に一致する。
  const weeks = align === "week" ? groupWeeks(prices) : null;
  let L = params.L;
  let weekEnds: number[] | null = null;
  if (weeks) {
    const curKey = weekKey(prices[n - 1].time);
    const cur = weeks.get(curKey);
    if (!cur || cur.length < 1) return null;
    L = cur.length; // 今週の経過立会日数(月〜今日)
    weekEnds = [];
    for (const [k, idxs] of weeks) {
      if (k === curKey) continue;
      if (idxs.length < L) continue;
      weekEnds.push(idxs[L - 1]); // その週の先頭L日目 = 今週と同じ曜日位置
    }
  }
  if (n < L + H + 20) return null;

  // 今週(クエリ): 窓末 = 最新。フォワードは未確定なので lead のみ(HL含む)。
  const qEnd = n - 1;
  const qLead = buildLead(prices, qEnd, L);
  if (!qLead) return null;
  const qStart = qEnd - L + 1;
  const qZ = zShape(qLead.lead);
  const queryUsBin = usBinByIdx[qStart];
  const query: AnalogWindow = {
    endIndex: qEnd, startTime: prices[qStart].time, endTime: prices[qEnd].time,
    lead: qLead.lead, leadHigh: qLead.leadHigh, leadLow: qLead.leadLow,
    forward: [], fwdHigh: [], fwdLow: [], forwardReturn: NaN, mfe: NaN, mae: NaN,
    usBin: queryUsBin, distance: 0,
  };

  // 候補窓: フォワード余地あり(j+H<=n-1)かつ 今週リードインと重ならない(窓末 < 今週窓の起点)
  const jMax = Math.min(n - 1 - H, qStart - 1);
  const ends: number[] = [];
  if (weekEnds) {
    for (const j of weekEnds) if (j >= L - 1 && j <= jMax) ends.push(j);
  } else {
    for (let j = L - 1; j <= jMax; j++) ends.push(j);
  }

  const cands: AnalogWindow[] = [];
  const binCounts = new Array(meta.count).fill(0);
  for (const j of ends) {
    const ld = buildLead(prices, j, L);
    if (!ld) continue;
    const fw = buildForward(prices, j, H);
    if (!fw) continue;
    const wStart = j - L + 1;
    const usBin = usBinByIdx[wStart];
    if (usBin !== null) binCounts[usBin]++;
    cands.push({
      endIndex: j, startTime: prices[wStart].time, endTime: prices[j].time,
      lead: ld.lead, leadHigh: ld.leadHigh, leadLow: ld.leadLow,
      forward: fw.forward, fwdHigh: fw.fwdHigh, fwdLow: fw.fwdLow,
      forwardReturn: fw.forward[H], mfe: fw.fwdHigh[H], mae: fw.fwdLow[H], usBin,
      distance: shapeDist(qZ, zShape(ld.lead), metric),
    });
  }
  // 週境界アラインは候補が「週数」に減る(≒1/5)ため、最小要件を緩める。
  if (cands.length < (weekEnds ? 3 : 5)) return null;

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
  const fwdHigh = aggPaths(selected.map((s) => s.fwdHigh), H + 1);
  const fwdLow = aggPaths(selected.map((s) => s.fwdLow), H + 1);
  const finals = selected.map((s) => s.forwardReturn).filter((v) => isFinite(v));
  const upCount = finals.filter((v) => v > 0).length;
  const meanFinal = finals.reduce((s, v) => s + v, 0) / (finals.length || 1);

  return {
    mode, L, H, align, metric, query, queryUsBin, selBin, binMetaObj: meta, binCounts,
    selected,
    leadMedian: lead.med, leadP25: lead.p25, leadP75: lead.p75,
    fwdMedian: fwd.med, fwdP25: fwd.p25, fwdP75: fwd.p75,
    fwdHighMedian: fwdHigh.med, fwdLowMedian: fwdLow.med,
    upCount, downCount: finals.length - upCount,
    medianFinal: fwd.med[H], meanFinal,
    medianMfe: fwdHigh.med[H], medianMae: fwdLow.med[H],
    totalCandidates: cands.length,
  };
}
