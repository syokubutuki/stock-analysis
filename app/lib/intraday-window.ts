// 任意の連続時刻ウィンドウ [startMinute, endMinute] のリターンを曜日別に集計する。
// 各営業日について、ウィンドウ開始以降の最初のバーの始値で建て、ウィンドウ終了
// 以前の最後のバーの終値で手仕舞いしたとみなし、その対数リターンを曜日にバケットする。
// 寄り後30分／引け前30分などのエッジを、曜日と掛け合わせて検証するための基盤。

import {
  IntradayBar,
  buildBinGrid,
  groupByDay,
  localMinute,
  minuteToLabel,
} from "./intraday-core";
import { tTest, benjaminiHochberg } from "./stats-significance";

export interface WeekdayWindowStat {
  weekday: number; // 0=日..6=土
  n: number;
  mean: number;    // 平均対数リターン
  median: number;
  win: number;     // 勝率
  std: number;
  p: number;       // FDR補正後
  signif: boolean;
}

export interface WindowOption {
  minute: number;
  label: string; // "HH:MM"
}

export interface WindowWeekdayResult {
  startMinute: number;
  endMinute: number;
  windowOptions: WindowOption[]; // 選択可能な時刻（ビン境界）
  rows: WeekdayWindowStat[];     // 実在する曜日のみ
  all: WeekdayWindowStat;        // 全曜日まとめ
  totalDays: number;
}

const WD_ORDER = [1, 2, 3, 4, 5, 0, 6]; // 月..金, 日, 土

function stat(weekday: number, rets: number[], p: number, minN: number): WeekdayWindowStat {
  const n = rets.length;
  const mean = n ? rets.reduce((a, v) => a + v, 0) / n : 0;
  const sorted = [...rets].sort((a, b) => a - b);
  const median = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : 0;
  const win = n ? rets.filter((r) => r > 0).length / n : 0;
  const variance = n > 1 ? rets.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1) : 0;
  return { weekday, n, mean, median, win, std: Math.sqrt(variance), p, signif: p < 0.05 && n >= minN };
}

// ウィンドウ内の各日リターン = log(最後のバー終値 / 最初のバー始値)
function dayWindowReturn(bars: IntradayBar[], gmtoffset: number, startMin: number, endMin: number): number | null {
  let entry: number | null = null;
  let exit: number | null = null;
  for (const b of bars) {
    const m = localMinute(b.ts, gmtoffset);
    if (m < startMin || m > endMin) continue;
    if (entry === null && b.open > 0) entry = b.open;
    if (b.close > 0) exit = b.close;
  }
  if (entry === null || exit === null || entry <= 0 || exit <= 0) return null;
  return Math.log(exit / entry);
}

export function computeWindowWeekday(
  bars: IntradayBar[],
  gmtoffset: number,
  startMinute: number,
  endMinute: number,
  binMinutes = 30,
  minN = 8
): WindowWeekdayResult | null {
  const grid = buildBinGrid(bars, gmtoffset, binMinutes);
  if (!grid) return null;
  const windowOptions: WindowOption[] = grid.bins.map((b) => ({ minute: b.startMinute, label: b.label }));
  // セッション終端も終了候補に加える
  const lastEnd = grid.sessionEnd;
  if (windowOptions.length === 0 || windowOptions[windowOptions.length - 1].minute < lastEnd) {
    windowOptions.push({ minute: lastEnd, label: minuteToLabel(lastEnd) });
  }

  const days = groupByDay(bars, gmtoffset);
  if (days.length === 0) return null;

  const start = Math.min(startMinute, endMinute);
  const end = Math.max(startMinute, endMinute);

  const byWd = new Map<number, number[]>();
  const allRets: number[] = [];
  for (const d of days) {
    const r = dayWindowReturn(d.bars, gmtoffset, start, end);
    if (r === null) continue;
    const arr = byWd.get(d.weekday) ?? [];
    arr.push(r);
    byWd.set(d.weekday, arr);
    allRets.push(r);
  }

  const presentWd = WD_ORDER.filter((w) => byWd.has(w));
  // FDR は曜日行に対して
  const rawP = presentWd.map((w) => tTest(byWd.get(w)!)?.p ?? 1);
  const adjP = benjaminiHochberg(rawP);

  const rows = presentWd.map((w, i) => stat(w, byWd.get(w)!, adjP[i], minN));
  const allT = tTest(allRets);
  const all = stat(-1, allRets, allT?.p ?? 1, minN);

  return {
    startMinute: start,
    endMinute: end,
    windowOptions,
    rows,
    all,
    totalDays: days.length,
  };
}
