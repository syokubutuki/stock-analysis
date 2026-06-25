// 日足シグナル × 最適約定時刻。
//
// フル日足履歴で定義したシグナル(buildStateFn の状態バケット)が「前日終値で確定」した翌営業日に、
// 当日内のどの時刻に建て(エントリー)・どの時刻に手仕舞う(エグジット)のが最適かを、
// シグナル翌日の分足から求める。エントリー×エグジットのビン格子で1取引リターンを集計し、
// 非シグナル日のベースラインと比較・ブロックブートCI・成行(寄成→引成)比改善を出す。
//
// 先読み排除: シグナルは i 日終値で確定 → 約定は i+1 日(翌日)。
// データ制約: 分足は 5m≈60日 / 60m≈2年。シグナル翌日 ∩ 分足窓 のみ格子に寄与するため n は薄い。
//             既定は 60m 推奨。nSignalTotal(日足全期間) と nWithIntraday(格子採用数) を併示する。

import { PricePoint } from "./types";
import {
  IntradayBar, DayData, groupByDay, buildBinGrid, binIndexOfMinute, localMinute,
} from "./intraday-core";
import { mean, blockBootstrapCI } from "./stats-significance";
import { Side } from "./execution-timing";
import { StateFn } from "./conditional-forward-returns";

type AnchorKind = "open0" | "elapsed" | "close";
interface Anchor { id: string; label: string; kind: AnchorKind; t: number } // t=寄りからの経過分(closeは∞)

const ENTRY_ANCHORS: Anchor[] = [
  { id: "e0", label: "寄成", kind: "open0", t: 0 },
  { id: "e15", label: "寄+15分", kind: "elapsed", t: 15 },
  { id: "e30", label: "寄+30分", kind: "elapsed", t: 30 },
  { id: "e60", label: "寄+60分", kind: "elapsed", t: 60 },
  { id: "e120", label: "寄+120分", kind: "elapsed", t: 120 },
];
const EXIT_ANCHORS: Anchor[] = [
  { id: "x60", label: "寄+60分", kind: "elapsed", t: 60 },
  { id: "x120", label: "寄+120分", kind: "elapsed", t: 120 },
  { id: "x180", label: "寄+180分", kind: "elapsed", t: 180 },
  { id: "xC", label: "引成", kind: "close", t: Infinity },
];

export interface ExecCell {
  ei: number; xi: number;
  n: number;
  meanPct: number;
  winRate: number;
  ciLoPct: number; ciHiPct: number; hasCI: boolean;
  baseMeanPct: number; baseN: number; // 非シグナル日ベースライン
  significant: boolean; // CIが0をまたがない(方向考慮で正)
  isNaive: boolean; // 寄成→引成
}

export interface SignalExecResult {
  side: Side;
  intervalMin: number;
  entryLabels: string[];
  exitLabels: string[];
  cells: ExecCell[]; // 有効セルのみ(exit時刻>entry時刻)
  best: ExecCell | null;
  naive: ExecCell | null; // 寄成→引成(シグナル日)
  improvePct: number | null; // best.mean − naive.mean
  nSignalTotal: number; // 日足全期間のシグナル翌日数
  nWithIntraday: number; // うち分足窓に入り格子に使えた数
  // 翌日経路(寄り比%)
  binLabels: string[];
  avgPathPct: number[];
  paths: number[][];
}

function intervalMinutes(interval: string): number {
  const m = /^(\d+)\s*m$/.exec(interval);
  return m ? parseInt(m[1], 10) : 5;
}

function resolveAnchor(day: DayData, a: Anchor, gmtoffset: number): { idx: number; price: number } | null {
  const bs = day.bars;
  const last = bs.length - 1;
  if (last < 0) return null;
  if (a.kind === "open0") return bs[0].open > 0 ? { idx: 0, price: bs[0].open } : null;
  if (a.kind === "close") return bs[last].close > 0 ? { idx: last, price: bs[last].close } : null;
  const open = localMinute(bs[0].ts, gmtoffset);
  let idx = 0;
  for (let i = 0; i < bs.length; i++) {
    const el = localMinute(bs[i].ts, gmtoffset) - open;
    if (el <= a.t) idx = i; else break;
  }
  return bs[idx].close > 0 ? { idx, price: bs[idx].close } : null;
}

export function computeSignalExecution(
  prices: PricePoint[],
  bars: IntradayBar[],
  gmtoffset: number,
  interval: string,
  state: StateFn,
  bucketLabel: string,
  side: Side,
  opts: { minN?: number } = {}
): SignalExecResult | null {
  const minN = opts.minN ?? 10;
  const intervalMin = intervalMinutes(interval);

  // 1. シグナル翌日の日付集合(先読み排除: stateOf(s)===bucket → 翌日 s+1 をエントリー対象)
  const signalEntryDates = new Set<string>();
  let nSignalTotal = 0;
  for (let s = 0; s < prices.length - 1; s++) {
    if (state.stateOf(s) === bucketLabel) {
      nSignalTotal++;
      signalEntryDates.add(prices[s + 1].time.slice(0, 10));
    }
  }
  if (nSignalTotal < 3) return null;

  const days = groupByDay(bars, gmtoffset);
  if (days.length < 10) return null;

  // 2. 有効セル(exit時刻 > entry時刻)
  const cellDefs: { ei: number; xi: number }[] = [];
  ENTRY_ANCHORS.forEach((e, ei) => EXIT_ANCHORS.forEach((x, xi) => {
    if (x.t > e.t) cellDefs.push({ ei, xi });
  }));

  const sigRet = new Map<string, number[]>();
  const baseRet = new Map<string, number[]>();
  for (const c of cellDefs) { sigRet.set(`${c.ei}-${c.xi}`, []); baseRet.set(`${c.ei}-${c.xi}`, []); }

  // 3. 全日中足の日を走査し、シグナル日/非シグナル日に振り分けて格子集計
  let nWithIntraday = 0;
  const sgn = side === "buy" ? 1 : -1;
  for (const day of days) {
    if (day.bars.length < 2) continue;
    const isSignal = signalEntryDates.has(day.date);
    if (isSignal) nWithIntraday++;
    const target = isSignal ? sigRet : baseRet;

    const eRes = ENTRY_ANCHORS.map((a) => resolveAnchor(day, a, gmtoffset));
    const xRes = EXIT_ANCHORS.map((a) => resolveAnchor(day, a, gmtoffset));
    for (const c of cellDefs) {
      const er = eRes[c.ei], xr = xRes[c.xi];
      if (!er || !xr || er.idx >= xr.idx) continue;
      const r = sgn * (xr.price - er.price) / er.price;
      target.get(`${c.ei}-${c.xi}`)!.push(r);
    }
  }
  if (nWithIntraday < 3) return null;

  // 4. セル統計
  const naiveEi = 0; // 寄成
  const naiveXi = EXIT_ANCHORS.length - 1; // 引成
  const cells: ExecCell[] = cellDefs.map((c) => {
    const arr = sigRet.get(`${c.ei}-${c.xi}`)!;
    const base = baseRet.get(`${c.ei}-${c.xi}`)!;
    const m = mean(arr);
    const ci = arr.length >= minN ? blockBootstrapCI(arr, 500) : null;
    const significant = !!ci && ci.lo > 0; // 方向考慮済みなので正側のみ
    return {
      ei: c.ei, xi: c.xi,
      n: arr.length,
      meanPct: m * 100,
      winRate: arr.length ? arr.filter((v) => v > 0).length / arr.length : 0,
      ciLoPct: ci ? ci.lo * 100 : 0,
      ciHiPct: ci ? ci.hi * 100 : 0,
      hasCI: !!ci,
      baseMeanPct: mean(base) * 100,
      baseN: base.length,
      significant,
      isNaive: c.ei === naiveEi && c.xi === naiveXi,
    };
  });

  const naive = cells.find((c) => c.isNaive) ?? null;
  const best = cells
    .filter((c) => c.n >= minN && c.meanPct > 0 && c.significant)
    .sort((a, b) => b.meanPct - a.meanPct)[0] ?? null;
  const improvePct = best && naive ? best.meanPct - naive.meanPct : null;

  // 5. シグナル翌日経路(寄り比%) — スパゲッティ用
  const grid = buildBinGrid(bars, gmtoffset, intervalMin);
  const binLabels: string[] = [];
  const avgPathPct: number[] = [];
  const paths: number[][] = [];
  if (grid) {
    const nBins = grid.bins.length;
    const acc = new Array(nBins).fill(0);
    const cnt = new Array(nBins).fill(0);
    for (const day of days) {
      if (!signalEntryDates.has(day.date) || day.open <= 0 || day.bars.length < 2) continue;
      const lastInBin = new Array(nBins).fill(NaN);
      for (const b of day.bars) lastInBin[binIndexOfMinute(localMinute(b.ts, gmtoffset), grid)] = b.close;
      const path: number[] = [];
      let prev = day.open;
      for (let i = 0; i < nBins; i++) {
        const px = isNaN(lastInBin[i]) ? prev : lastInBin[i];
        prev = px;
        const v = ((px - day.open) / day.open) * 100;
        path.push(v); acc[i] += v; cnt[i]++;
      }
      if (paths.length < 40) paths.push(path);
    }
    for (let i = 0; i < nBins; i++) { binLabels.push(grid.bins[i].label); avgPathPct.push(cnt[i] ? acc[i] / cnt[i] : 0); }
  }

  return {
    side, intervalMin,
    entryLabels: ENTRY_ANCHORS.map((a) => a.label),
    exitLabels: EXIT_ANCHORS.map((a) => a.label),
    cells, best, naive, improvePct,
    nSignalTotal, nWithIntraday,
    binLabels, avgPathPct, paths,
  };
}

export { ENTRY_ANCHORS, EXIT_ANCHORS };
