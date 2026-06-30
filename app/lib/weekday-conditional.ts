// 曜日 × 値動きビン 条件付き分析エンジン。
// 「エントリー曜日（例:月）の引け時点で確定した値動きシグネチャ（夜間ギャップ=前日Close比の当日Openリターン、
// 日中リターン等）でその日をビンに分け、ビンごとに『その後どう動くか』の曜日別フォワードパスと、
// 指定 exit までの条件付き期待値（平均/勝率/CI/有意性）を集計する」。
//
// インタラクティブ探索のため、各ビン/セルは個別発生日（occurrences）まで保持し、
// クリック深掘り（分布ヒストグラム・発生日一覧）に使えるようにする。
//
// 設計上の注意:
//  - 先読みバイアス回避: シグネチャは「エントリー曜日の引けで確定する情報のみ」。建ては必ずエントリー曜日の引け。
//  - 同週判定: 取引日列では平日の曜日番号(月1..金5)が週内で単調増加し、週末をまたぐと減少する。
//    これで「同じ週の指定曜日引け」を祝日にも頑健に特定する。

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

export type Signature = "gap" | "intraday" | "fullday" | "excessIntraday";
export type BinScheme = "sign" | "tercile" | "quintile";
export type Exit =
  | { kind: "weekday"; dow: number }
  | { kind: "ndays"; n: number }
  | { kind: "nextweek"; dow: number };

export const SIGNATURES: { value: Signature; label: string; desc: string }[] = [
  { value: "intraday", label: "日中リターン", desc: "(終値−始値)/始値。寄りからの当日値動き。" },
  { value: "gap", label: "夜間ギャップ", desc: "(始値−前日終値)/前日終値。前日Close比の当日Openリターン（窓）。" },
  { value: "fullday", label: "当日リターン", desc: "(終値−前日終値)/前日終値。前日比。" },
  { value: "excessIntraday", label: "超過日中リターン", desc: "日中リターン − 全日平均日中リターン。平均以上に上げた日か。" },
];

export const WD_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

// ============================================================
// 共通: 基礎レコード
// ============================================================
interface BaseRec {
  i: number;
  dow: number; // 1=月..5=金
  gap: number;
  intraday: number;
  fullday: number;
}

function buildBaseRecs(prices: PricePoint[]): { recs: BaseRec[]; meanIntraday: number } {
  const ids: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    const o = prices[i].open, c = prices[i].close;
    if (o > 0 && c > 0) ids.push((c - o) / o);
  }
  const meanIntraday = mean(ids);
  const recs: BaseRec[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prevC = prices[i - 1].close, o = prices[i].open, c = prices[i].close;
    if (!(prevC > 0) || !(o > 0) || !(c > 0)) continue;
    recs.push({
      i,
      dow: new Date(prices[i].time).getDay(),
      gap: (o - prevC) / prevC,
      intraday: (c - o) / o,
      fullday: (c - prevC) / prevC,
    });
  }
  return { recs, meanIntraday };
}

function sigOf(r: BaseRec, sig: Signature, meanIntraday: number): number {
  if (sig === "gap") return r.gap;
  if (sig === "fullday") return r.fullday;
  if (sig === "excessIntraday") return r.intraday - meanIntraday;
  return r.intraday;
}

interface Bins {
  order: string[];
  assign: (v: number) => string;
  idxOf: (v: number) => number;
}

function makeBins(vals: number[], scheme: BinScheme): Bins {
  if (scheme === "sign") {
    const order = ["下落 (<0)", "上昇 (≥0)"];
    const idxOf = (v: number) => (v >= 0 ? 1 : 0);
    return { order, assign: (v) => order[idxOf(v)], idxOf };
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const q = (p: number) => quantileSorted(sorted, p);
  if (scheme === "tercile") {
    const e1 = q(1 / 3), e2 = q(2 / 3);
    const order = [`下位⅓ (≤${fmtPct(e1)})`, `中位⅓ (${fmtPct(e1)}〜${fmtPct(e2)})`, `上位⅓ (≥${fmtPct(e2)})`];
    const idxOf = (v: number) => (v < e1 ? 0 : v < e2 ? 1 : 2);
    return { order, assign: (v) => order[idxOf(v)], idxOf };
  }
  const e = [q(0.2), q(0.4), q(0.6), q(0.8)];
  const order = [
    `最下位 (≤${fmtPct(e[0])})`,
    `下位 (${fmtPct(e[0])}〜${fmtPct(e[1])})`,
    `中位 (${fmtPct(e[1])}〜${fmtPct(e[2])})`,
    `上位 (${fmtPct(e[2])}〜${fmtPct(e[3])})`,
    `最上位 (≥${fmtPct(e[3])})`,
  ];
  const idxOf = (v: number) => (v < e[0] ? 0 : v < e[1] ? 1 : v < e[2] ? 2 : v < e[3] ? 3 : 4);
  return { order, assign: (v) => order[idxOf(v)], idxOf };
}

// マトリクス俯瞰用の汎用ランクラベル（値域を含まない）
export function rankLabels(scheme: BinScheme): string[] {
  if (scheme === "sign") return ["下落", "上昇"];
  if (scheme === "tercile") return ["下位⅓", "中位⅓", "上位⅓"];
  return ["最下位", "下位", "中位", "上位", "最上位"];
}

function sameWeekExitIdx(dows: number[], i: number, target: number): number {
  let prev = dows[i];
  for (let j = i + 1; j < dows.length; j++) {
    if (dows[j] <= prev) break;
    if (dows[j] === target) return j;
    prev = dows[j];
  }
  return -1;
}

// 「翌週」の指定曜日引けを特定する。取引日列では平日の曜日番号が週内で単調増加し、
// 週末をまたぐと減少する。最初の境界を越えた“次の週”の中から target 曜日を探す。
// その週に target 曜日が無い（祝日休場）場合は -1（その回は集計から除外）。
function nextWeekExitIdx(dows: number[], i: number, target: number): number {
  let prev = dows[i];
  let crossed = false;
  for (let j = i + 1; j < dows.length; j++) {
    if (dows[j] <= prev) {
      if (crossed) return -1; // 翌々週に到達 = 翌週は target 休場
      crossed = true;
    }
    if (crossed && dows[j] === target) return j;
    prev = dows[j];
  }
  return -1;
}

function fwdReturn(closes: number[], dows: number[], i: number, exit: Exit): { r: number; exitIdx: number } | null {
  let j: number;
  if (exit.kind === "ndays") {
    j = i + exit.n;
    if (j >= closes.length) return null;
  } else if (exit.kind === "nextweek") {
    j = nextWeekExitIdx(dows, i, exit.dow);
    if (j < 0) return null;
  } else {
    j = sameWeekExitIdx(dows, i, exit.dow);
    if (j < 0) return null;
  }
  if (!(closes[i] > 0) || !(closes[j] > 0)) return null;
  return { r: closes[j] / closes[i] - 1, exitIdx: j };
}

export function exitLabelOf(exit: Exit): string {
  if (exit.kind === "ndays") return `${exit.n}営業日先 引け`;
  if (exit.kind === "nextweek") return `翌週 ${WD_LABELS[exit.dow]}曜 引け`;
  return `同週 ${WD_LABELS[exit.dow]}曜 引け`;
}

// 週跨ぎパス用スロット（week:0=エントリー週, 1=翌週）
export interface PathSlot {
  week: number;
  dow: number;
  label: string;
}
function slotLabel(week: number, dow: number): string {
  return (week === 1 ? "翌" : "") + WD_LABELS[dow];
}

// 個別発生日（ドリルダウン用）
export interface Occurrence {
  date: string; // エントリー日
  sigVal: number; // 主シグネチャ値（ピボットでは x 値）
  yVal?: number; // ピボットの y 値
  fwd: number; // フォワードリターン
  exitDate: string;
}

// ============================================================
// 1D: エントリー曜日 × シグネチャビン
// ============================================================
export interface PathPoint {
  week: number; // 0=エントリー週, 1=翌週
  dow: number;
  label: string;
  meanCum: number;
  lo: number;
  hi: number;
  n: number;
}

export interface WeekdayBin {
  label: string;
  rank: number; // scheme order 内のインデックス
  n: number;
  meanFwd: number;
  medianFwd: number;
  winRate: number;
  stdFwd: number;
  ciLow: number;
  ciHigh: number;
  p: number;
  significant: boolean;
  byYear: { year: number; meanFwd: number; n: number }[];
  path: PathPoint[];
  occurrences: Occurrence[];
  action: "long" | "short" | "none";
}

export interface WeekdayCondResult {
  bins: WeekdayBin[];
  order: string[];
  entryDow: number;
  exitLabel: string;
  pathSlots: PathSlot[];
  nowBinLabel: string | null;
  nowDate: string | null;
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

export function weekdayConditional(
  prices: PricePoint[],
  entryDow: number,
  sig: Signature,
  scheme: BinScheme,
  exit: Exit,
  boot = 500,
): WeekdayCondResult | null {
  const { recs, meanIntraday } = buildBaseRecs(prices);
  const dows = prices.map((p) => new Date(p.time).getDay());
  const closes = prices.map((p) => p.close);

  const subset = recs.filter((r) => r.dow === entryDow);
  if (subset.length < 10) return null;

  const bins = makeBins(subset.map((r) => sigOf(r, sig, meanIntraday)), scheme);

  interface Acc {
    rets: number[];
    years: number[];
    pathByKey: Map<number, number[]>; // key = week*10 + dow
    occ: Occurrence[];
  }
  const accs = new Map<string, Acc>();
  for (const label of bins.order) accs.set(label, { rets: [], years: [], pathByKey: new Map(), occ: [] });

  // 累積パスを追う週数。翌週exitのときだけ週末をまたいで翌週まで延長する。
  const maxWeek = exit.kind === "nextweek" ? 1 : 0;

  const allRets: number[] = [];
  for (const r of subset) {
    const sv = sigOf(r, sig, meanIntraday);
    const acc = accs.get(bins.assign(sv))!;

    let prevDow = dows[r.i];
    let wk = 0;
    for (let j = r.i + 1; j < closes.length; j++) {
      if (dows[j] <= prevDow) {
        wk++;
        if (wk > maxWeek) break;
      }
      if (closes[r.i] > 0 && closes[j] > 0) {
        const cum = closes[j] / closes[r.i] - 1;
        const key = wk * 10 + dows[j];
        const arr = acc.pathByKey.get(key) ?? [];
        arr.push(cum);
        acc.pathByKey.set(key, arr);
      }
      prevDow = dows[j];
    }

    const fr = fwdReturn(closes, dows, r.i, exit);
    if (fr) {
      acc.rets.push(fr.r);
      acc.years.push(new Date(prices[fr.exitIdx].time).getFullYear());
      acc.occ.push({ date: prices[r.i].time, sigVal: sv, fwd: fr.r, exitDate: prices[fr.exitIdx].time });
      allRets.push(fr.r);
    }
  }

  // パスのスロット順（エントリー週: entryDow→金、翌週exitなら続けて 翌月→翌exitDow）
  const pathSlots: PathSlot[] = [{ week: 0, dow: entryDow, label: slotLabel(0, entryDow) }];
  for (let d = entryDow + 1; d <= 5; d++) pathSlots.push({ week: 0, dow: d, label: slotLabel(0, d) });
  if (exit.kind === "nextweek") {
    for (let d = 1; d <= exit.dow; d++) pathSlots.push({ week: 1, dow: d, label: slotLabel(1, d) });
  }

  const present = bins.order.filter((o) => (accs.get(o)?.rets.length ?? 0) >= 3);
  const pRaw = present.map((o) => {
    const t = tTest(accs.get(o)!.rets);
    return t ? t.p : 1;
  });
  const pAdj = benjaminiHochberg(pRaw);

  const outBins: WeekdayBin[] = present.map((label, k) => {
    const acc = accs.get(label)!;
    const m = mean(acc.rets);
    const ci = blockBootstrapCI(acc.rets, boot);
    const winRate = acc.rets.filter((x) => x > 0).length / acc.rets.length;
    const significant = pAdj[k] < 0.05;

    const byYearMap = new Map<number, number[]>();
    acc.years.forEach((y, idx) => {
      const arr = byYearMap.get(y) ?? [];
      arr.push(acc.rets[idx]);
      byYearMap.set(y, arr);
    });
    const byYear = [...byYearMap.entries()].sort((a, b) => a[0] - b[0]).map(([year, arr]) => ({ year, meanFwd: mean(arr), n: arr.length }));

    const path: PathPoint[] = [];
    for (const s of pathSlots) {
      if (s.week === 0 && s.dow === entryDow) {
        path.push({ week: 0, dow: entryDow, label: s.label, meanCum: 0, lo: 0, hi: 0, n: acc.rets.length });
        continue;
      }
      const arr = acc.pathByKey.get(s.week * 10 + s.dow);
      if (!arr || arr.length < 3) continue;
      const mc = mean(arr);
      const se = std(arr) / Math.sqrt(arr.length);
      path.push({ week: s.week, dow: s.dow, label: s.label, meanCum: mc, lo: mc - 1.96 * se, hi: mc + 1.96 * se, n: arr.length });
    }

    return {
      label,
      rank: bins.order.indexOf(label),
      n: acc.rets.length,
      meanFwd: m,
      medianFwd: median(acc.rets),
      winRate,
      stdFwd: std(acc.rets),
      ciLow: ci ? ci.lo : m,
      ciHigh: ci ? ci.hi : m,
      p: pAdj[k],
      significant,
      byYear,
      path,
      occurrences: acc.occ,
      action: decideAction(m, winRate, significant),
    };
  });

  let nowBinLabel: string | null = null;
  let nowDate: string | null = null;
  if (subset.length > 0) {
    const last = subset[subset.length - 1];
    nowBinLabel = bins.assign(sigOf(last, sig, meanIntraday));
    nowDate = prices[last.i].time;
  }

  return {
    bins: outBins,
    order: present,
    entryDow,
    exitLabel: exitLabelOf(exit),
    pathSlots,
    nowBinLabel,
    nowDate,
    baselineMean: mean(allRets),
    baselineWin: allRets.length ? allRets.filter((x) => x > 0).length / allRets.length : 0,
    totalN: allRets.length,
  };
}

// ============================================================
// 2D: 自由ピボット（X軸シグネチャ × Y軸シグネチャ）
// ============================================================
export interface PivotCell {
  xi: number;
  yi: number;
  n: number;
  meanFwd: number;
  medianFwd: number;
  winRate: number;
  ciLow: number;
  ciHigh: number;
  significant: boolean;
  p: number;
  occurrences: Occurrence[];
}
export interface WeekdayPivotResult {
  cells: PivotCell[];
  xOrder: string[];
  yOrder: string[];
  xLabel: string;
  yLabel: string;
  entryDow: number;
  exitLabel: string;
  nowXi: number | null;
  nowYi: number | null;
  maxAbs: number;
  baselineMean: number;
}

export function weekdayPivot(
  prices: PricePoint[],
  entryDow: number,
  xSig: Signature,
  ySig: Signature,
  scheme: BinScheme,
  exit: Exit,
): WeekdayPivotResult | null {
  const { recs, meanIntraday } = buildBaseRecs(prices);
  const dows = prices.map((p) => new Date(p.time).getDay());
  const closes = prices.map((p) => p.close);

  const subset = recs.filter((r) => r.dow === entryDow);
  if (subset.length < 12) return null;

  const xBins = makeBins(subset.map((r) => sigOf(r, xSig, meanIntraday)), scheme);
  const yBins = makeBins(subset.map((r) => sigOf(r, ySig, meanIntraday)), scheme);

  const cellMap = new Map<string, { rets: number[]; occ: Occurrence[] }>();
  const allRets: number[] = [];
  for (const r of subset) {
    const fr = fwdReturn(closes, dows, r.i, exit);
    if (!fr) continue;
    const xv = sigOf(r, xSig, meanIntraday), yv = sigOf(r, ySig, meanIntraday);
    const xi = xBins.idxOf(xv), yi = yBins.idxOf(yv);
    const key = `${xi}|${yi}`;
    const c = cellMap.get(key) ?? { rets: [], occ: [] };
    c.rets.push(fr.r);
    c.occ.push({ date: prices[r.i].time, sigVal: xv, yVal: yv, fwd: fr.r, exitDate: prices[fr.exitIdx].time });
    cellMap.set(key, c);
    allRets.push(fr.r);
  }

  const keys = [...cellMap.keys()].filter((k) => cellMap.get(k)!.rets.length >= 3);
  const pRaw = keys.map((k) => {
    const t = tTest(cellMap.get(k)!.rets);
    return t ? t.p : 1;
  });
  const pAdj = benjaminiHochberg(pRaw);
  const pMap = new Map(keys.map((k, idx) => [k, pAdj[idx]]));

  const cells: PivotCell[] = [];
  let maxAbs = 1e-9;
  for (let xi = 0; xi < xBins.order.length; xi++) {
    for (let yi = 0; yi < yBins.order.length; yi++) {
      const c = cellMap.get(`${xi}|${yi}`);
      if (!c || c.rets.length === 0) continue;
      const m = mean(c.rets);
      maxAbs = Math.max(maxAbs, Math.abs(m));
      const p = pMap.get(`${xi}|${yi}`) ?? 1;
      const ci = blockBootstrapCI(c.rets, 300);
      cells.push({
        xi,
        yi,
        n: c.rets.length,
        meanFwd: m,
        medianFwd: median(c.rets),
        winRate: c.rets.filter((x) => x > 0).length / c.rets.length,
        ciLow: ci ? ci.lo : m,
        ciHigh: ci ? ci.hi : m,
        significant: p < 0.05 && c.rets.length >= 10,
        p,
        occurrences: c.occ,
      });
    }
  }

  let nowXi: number | null = null, nowYi: number | null = null;
  if (subset.length > 0) {
    const last = subset[subset.length - 1];
    nowXi = xBins.idxOf(sigOf(last, xSig, meanIntraday));
    nowYi = yBins.idxOf(sigOf(last, ySig, meanIntraday));
  }

  const sigLabel = (s: Signature) => SIGNATURES.find((x) => x.value === s)?.label ?? "";
  return {
    cells,
    xOrder: xBins.order,
    yOrder: yBins.order,
    xLabel: sigLabel(xSig),
    yLabel: sigLabel(ySig),
    entryDow,
    exitLabel: exitLabelOf(exit),
    nowXi,
    nowYi,
    maxAbs,
    baselineMean: mean(allRets),
  };
}

// ============================================================
// 全曜日マトリクス俯瞰（月〜金 × ビンランク）
// ============================================================
export interface MatrixCell {
  dow: number;
  binIdx: number;
  n: number;
  meanFwd: number;
  winRate: number;
  significant: boolean;
  p: number;
}
export interface WeekdayMatrixResult {
  cells: MatrixCell[];
  binLabels: string[];
  dows: number[];
  exitLabel: string;
  maxAbs: number;
  nowByDow: Record<number, number>; // dow -> binIdx
}

export function weekdayMatrixAll(
  prices: PricePoint[],
  sig: Signature,
  scheme: BinScheme,
  exit: Exit,
): WeekdayMatrixResult | null {
  const { recs, meanIntraday } = buildBaseRecs(prices);
  const dows = prices.map((p) => new Date(p.time).getDay());
  const closes = prices.map((p) => p.close);
  const labels = rankLabels(scheme);
  const k = labels.length;

  const cellRets = new Map<string, number[]>();
  const nowByDow: Record<number, number> = {};
  let any = false;

  for (let d = 1; d <= 5; d++) {
    const subset = recs.filter((r) => r.dow === d);
    if (subset.length < 10) continue;
    const bins = makeBins(subset.map((r) => sigOf(r, sig, meanIntraday)), scheme);
    for (const r of subset) {
      const fr = fwdReturn(closes, dows, r.i, exit);
      if (!fr) continue;
      const bi = bins.idxOf(sigOf(r, sig, meanIntraday));
      const key = `${d}|${bi}`;
      const arr = cellRets.get(key) ?? [];
      arr.push(fr.r);
      cellRets.set(key, arr);
      any = true;
    }
    const last = subset[subset.length - 1];
    nowByDow[d] = bins.idxOf(sigOf(last, sig, meanIntraday));
  }
  if (!any) return null;

  const keys = [...cellRets.keys()].filter((kk) => cellRets.get(kk)!.length >= 3);
  const pRaw = keys.map((kk) => {
    const t = tTest(cellRets.get(kk)!);
    return t ? t.p : 1;
  });
  const pAdj = benjaminiHochberg(pRaw);
  const pMap = new Map(keys.map((kk, idx) => [kk, pAdj[idx]]));

  const cells: MatrixCell[] = [];
  let maxAbs = 1e-9;
  for (let d = 1; d <= 5; d++) {
    for (let bi = 0; bi < k; bi++) {
      const arr = cellRets.get(`${d}|${bi}`);
      if (!arr || arr.length === 0) continue;
      const m = mean(arr);
      maxAbs = Math.max(maxAbs, Math.abs(m));
      const p = pMap.get(`${d}|${bi}`) ?? 1;
      cells.push({
        dow: d,
        binIdx: bi,
        n: arr.length,
        meanFwd: m,
        winRate: arr.filter((x) => x > 0).length / arr.length,
        significant: p < 0.05 && arr.length >= 10,
        p,
      });
    }
  }

  return { cells, binLabels: labels, dows: [1, 2, 3, 4, 5], exitLabel: exitLabelOf(exit), maxAbs, nowByDow };
}
