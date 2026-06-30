// 「今この瞬間」のトレード判断に特化した条件付き先行きリターン・エンジン（曜日非依存）。
//
// 取得した最新データ（本日の始値など）の値動き状況を、前日の始値・終値と比べたリターンとして数値化し、
// 「その数値が過去全履歴のリターン分布のどのビンに該当するか」を特定する。そのうえで、過去に同じビンへ
// 入った日の『その後どう動いたか（先行きリターン）』の分布・期待値・勝率・信頼区間・有意性を集計する。
//
// weekday-conditional.ts が「曜日でフィルタしてからビン分割」するのに対し、本モジュールは曜日を一切問わず、
// 純粋に「今日の値動きの異常度（分位）」だけを条件にする。これにより標本が5倍使え、10分位など細かいビンや
// 裾の異常値まで統計が持つ。曜日固有の癖は weekday-conditional.ts 側で見る（役割分担）。
//
// 先読みバイアスの排除:
//  - 状態シグナルが「寄付きで確定するもの（夜間ギャップ/前日始値比）」なら建ては本日寄付き、
//    「引けで確定するもの（日中/当日リターン）」なら建ては本日引け。確定前の情報では建てない。

import { PricePoint } from "./types";
import {
  mean,
  median,
  std,
  tTest,
  benjaminiHochberg,
  blockBootstrapCI,
  quantileSorted,
} from "./stats-significance";

export type DayState = "gapClose" | "gapOpen" | "intraday" | "fullday";
export type BinScheme = "sign" | "tercile" | "quintile" | "decile";
export type EntryTiming = "open" | "close";

export const DAY_STATES: {
  value: DayState;
  label: string;
  short: string;
  desc: string;
  entry: EntryTiming;
}[] = [
  { value: "gapClose", label: "夜間ギャップ（前日終値比）", short: "夜間ギャップ", desc: "(本日始値−前日終値)/前日終値。寄付き時点で確定する“窓”。建ては寄付き。", entry: "open" },
  { value: "gapOpen", label: "前日始値比", short: "前日始値比", desc: "(本日始値−前日始値)/前日始値。前日の寄りと今日の寄りの差。寄付き時点で確定。建ては寄付き。", entry: "open" },
  { value: "intraday", label: "日中リターン", short: "日中", desc: "(本日終値−本日始値)/本日始値。寄りからの当日値動き。引け時点で確定。建ては引け。", entry: "close" },
  { value: "fullday", label: "当日リターン（前日終値比）", short: "当日", desc: "(本日終値−前日終値)/前日終値。前日比トータル。引け時点で確定。建ては引け。", entry: "close" },
];

export const SCHEMES: { value: BinScheme; label: string }[] = [
  { value: "sign", label: "上下(2)" },
  { value: "tercile", label: "3分位" },
  { value: "quintile", label: "5分位" },
  { value: "decile", label: "10分位" },
];

// 先行きホライズン（営業日）。0=本日引け（寄付き建てのときのみ）。
export const HORIZONS = [0, 1, 2, 3, 5, 10];

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

export function entryLabel(entry: EntryTiming): string {
  return entry === "open" ? "本日寄付き" : "本日引け";
}

export function horizonLabel(h: number): string {
  if (h === 0) return "本日引け";
  if (h === 1) return "翌日引け";
  return `${h}営業日先 引け`;
}

// ============================================================
// 状態値の算出
// ============================================================
function stateValue(prices: PricePoint[], i: number, state: DayState): number | null {
  if (i < 1) return null;
  const o = prices[i].open, c = prices[i].close;
  const po = prices[i - 1].open, pc = prices[i - 1].close;
  if (!(o > 0) || !(c > 0) || !(po > 0) || !(pc > 0)) return null;
  switch (state) {
    case "gapClose": return (o - pc) / pc;
    case "gapOpen": return (o - po) / po;
    case "intraday": return (c - o) / o;
    case "fullday": return (c - pc) / pc;
  }
}

// 建値（寄付き建て=始値 / 引け建て=終値）
function entryPrice(prices: PricePoint[], i: number, entry: EntryTiming): number {
  return entry === "open" ? prices[i].open : prices[i].close;
}

// 先行きリターン。entry で建て、h 営業日先の終値で手仕舞い。
function fwdReturn(prices: PricePoint[], i: number, h: number, entry: EntryTiming): { r: number; exitIdx: number } | null {
  if (entry === "close" && h === 0) return null; // 引け建て当日引け＝ゼロ
  const ep = entryPrice(prices, i, entry);
  const exitIdx = i + h;
  if (exitIdx >= prices.length) return null;
  const xp = prices[exitIdx].close;
  if (!(ep > 0) || !(xp > 0)) return null;
  return { r: xp / ep - 1, exitIdx };
}

// ============================================================
// ビン分割（全履歴の状態値から分位境界を作る）
// ============================================================
interface Bins {
  order: string[];
  edges: number[]; // 内部境界（length = k-1）
  idxOf: (v: number) => number;
}

function makeBins(vals: number[], scheme: BinScheme): Bins {
  if (scheme === "sign") {
    return { order: ["下落 (<0)", "上昇 (≥0)"], edges: [0], idxOf: (v) => (v >= 0 ? 1 : 0) };
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const q = (p: number) => quantileSorted(sorted, p);
  const ps =
    scheme === "tercile" ? [1 / 3, 2 / 3] :
    scheme === "quintile" ? [0.2, 0.4, 0.6, 0.8] :
    [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const edges = ps.map(q);
  const k = edges.length + 1;
  const idxOf = (v: number) => {
    const idx = edges.findIndex((e) => v < e);
    return idx === -1 ? k - 1 : idx;
  };
  const order: string[] = [];
  for (let b = 0; b < k; b++) {
    const lo = b === 0 ? null : edges[b - 1];
    const hi = b === k - 1 ? null : edges[b];
    let name: string;
    if (scheme === "tercile") name = ["下位⅓", "中位⅓", "上位⅓"][b];
    else if (scheme === "quintile") name = ["最下位", "下位", "中位", "上位", "最上位"][b];
    else name = `第${b + 1}/10`;
    const range = lo === null ? `≤${fmtPct(hi!)}` : hi === null ? `≥${fmtPct(lo)}` : `${fmtPct(lo)}〜${fmtPct(hi)}`;
    order.push(`${name} (${range})`);
  }
  return { order, edges, idxOf };
}

// ============================================================
// 出力型
// ============================================================
export interface Occurrence {
  date: string;
  stateVal: number;
  fwd: number;
  exitDate: string;
}

export interface TodayBin {
  idx: number;
  label: string;
  rangeLo: number | null; // ビンの値域（状態値）。nullは±∞側
  rangeHi: number | null;
  n: number;
  meanFwd: number;
  medianFwd: number;
  winRate: number;
  stdFwd: number;
  ciLow: number;
  ciHigh: number;
  p: number;
  significant: boolean;
  forwards: number[];
  occurrences: Occurrence[];
  action: "long" | "short" | "none";
}

export interface TodayBinResult {
  bins: TodayBin[];
  edges: number[];
  allStateVals: { date: string; v: number }[]; // 全履歴の状態値（分布オーバーレイ用）
  scatter: { v: number; fwd: number }[]; // 状態値×先行きの全点（散布図用）
  todayValue: number | null;
  todayDate: string | null;
  todayBinIdx: number | null;
  todayPercentile: number | null; // 0..1（今日の状態値の累積順位）
  todayHasForward: boolean; // 今日の建玉が exit まで到達済みか（=過去化しているか）
  stateLabel: string;
  entry: EntryTiming;
  horizonLabel: string;
  baselineMean: number;
  baselineWin: number;
  totalN: number;
}

function decideAction(meanFwd: number, winRate: number, significant: boolean): "long" | "short" | "none" {
  if (!significant) return "none";
  if (meanFwd > 0 && winRate >= 0.5) return "long";
  if (meanFwd < 0 && winRate <= 0.5) return "short";
  return "none";
}

export function todayBin(
  prices: PricePoint[],
  state: DayState,
  scheme: BinScheme,
  horizon: number,
  boot = 500,
): TodayBinResult | null {
  if (prices.length < 60) return null;
  const entry: EntryTiming = DAY_STATES.find((s) => s.value === state)!.entry;
  const hEff = entry === "close" && horizon === 0 ? 1 : horizon; // 引け建て×本日引けは不可→翌日に丸める

  // 全履歴の状態値
  const allStateVals: { date: string; v: number }[] = [];
  for (let i = 1; i < prices.length; i++) {
    const v = stateValue(prices, i, state);
    if (v !== null) allStateVals.push({ date: prices[i].time, v });
  }
  if (allStateVals.length < 30) return null;

  const bins = makeBins(allStateVals.map((s) => s.v), scheme);
  const k = bins.edges.length + 1;

  interface Acc { rets: number[]; occ: Occurrence[]; }
  const accs: Acc[] = Array.from({ length: k }, () => ({ rets: [], occ: [] }));
  const scatter: { v: number; fwd: number }[] = [];
  const allRets: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    const v = stateValue(prices, i, state);
    if (v === null) continue;
    const fr = fwdReturn(prices, i, hEff, entry);
    if (!fr) continue;
    const bi = bins.idxOf(v);
    accs[bi].rets.push(fr.r);
    accs[bi].occ.push({ date: prices[i].time, stateVal: v, fwd: fr.r, exitDate: prices[fr.exitIdx].time });
    scatter.push({ v, fwd: fr.r });
    allRets.push(fr.r);
  }

  // 有意性（ビン横断でFDR補正）
  const present = accs.map((a, idx) => ({ idx, a })).filter((x) => x.a.rets.length >= 3);
  const pRaw = present.map((x) => { const t = tTest(x.a.rets); return t ? t.p : 1; });
  const pAdj = benjaminiHochberg(pRaw);
  const pByIdx = new Map(present.map((x, k2) => [x.idx, pAdj[k2]]));

  // ビン値域（境界）
  const rangeOf = (b: number): { lo: number | null; hi: number | null } => ({
    lo: b === 0 ? null : bins.edges[b - 1],
    hi: b === k - 1 ? null : bins.edges[b],
  });

  const outBins: TodayBin[] = accs.map((acc, idx) => {
    const m = mean(acc.rets);
    const ci = acc.rets.length >= 5 ? blockBootstrapCI(acc.rets, boot) : null;
    const winRate = acc.rets.length ? acc.rets.filter((x) => x > 0).length / acc.rets.length : 0;
    const p = pByIdx.get(idx) ?? 1;
    const significant = p < 0.05 && acc.rets.length >= 10;
    const { lo, hi } = rangeOf(idx);
    return {
      idx,
      label: bins.order[idx],
      rangeLo: lo,
      rangeHi: hi,
      n: acc.rets.length,
      meanFwd: m,
      medianFwd: median(acc.rets),
      winRate,
      stdFwd: std(acc.rets),
      ciLow: ci ? ci.lo : m,
      ciHigh: ci ? ci.hi : m,
      p,
      significant,
      forwards: acc.rets,
      occurrences: acc.occ,
      action: decideAction(m, winRate, significant),
    };
  });

  // 今日（直近の状態値が確定している最終日）
  let todayValue: number | null = null;
  let todayDate: string | null = null;
  let todayBinIdx: number | null = null;
  let todayPercentile: number | null = null;
  let todayHasForward = false;
  for (let i = prices.length - 1; i >= 1; i--) {
    const v = stateValue(prices, i, state);
    if (v === null) continue;
    todayValue = v;
    todayDate = prices[i].time;
    todayBinIdx = bins.idxOf(v);
    const below = allStateVals.filter((s) => s.v <= v).length;
    todayPercentile = below / allStateVals.length;
    todayHasForward = fwdReturn(prices, i, hEff, entry) !== null;
    break;
  }

  return {
    bins: outBins,
    edges: bins.edges,
    allStateVals,
    scatter,
    todayValue,
    todayDate,
    todayBinIdx,
    todayPercentile,
    todayHasForward,
    stateLabel: DAY_STATES.find((s) => s.value === state)!.label,
    entry,
    horizonLabel: horizonLabel(hEff),
    baselineMean: mean(allRets),
    baselineWin: allRets.length ? allRets.filter((x) => x > 0).length / allRets.length : 0,
    totalN: allRets.length,
  };
}
