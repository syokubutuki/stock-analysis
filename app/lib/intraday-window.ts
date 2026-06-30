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

// ── 分位ビン × 時間軸位置 ───────────────────────────────────────────
// 単一曜日の窓リターンを「曜日内クインタイル」でビン分けし、各日が原系列の
// いつ(暦日)に位置するかをひも付ける。ビンの時間的偏り(集中/分散)を検証する。

export interface DayWindowReturn {
  date: string; // YYYY-MM-DD（取引所ローカル）
  ms: number;   // 暦日のUTCミリ秒（X軸配置用）
  r: number;    // 窓リターン（対数）
  bin: number;  // 0=最下位..(numBins-1)=最上位、曜日内ランクで割当
}

export interface ReturnBin {
  bin: number;
  loR: number;      // ビン内リターン下限
  hiR: number;      // ビン内リターン上限
  n: number;
  meanR: number;
  // 時間的位置の要約
  firstDate: string;
  lastDate: string;
  centroidMs: number; // 平均日付(ms)
  spanDays: number;   // lastDate - firstDate（暦日）
  dispersion: number; // 日付ばらつき(標準偏差)を全期間幅で正規化 0=集中..1付近=分散
}

export interface WindowBinTimingResult {
  weekday: number;
  startMinute: number;
  endMinute: number;
  numBins: number;
  days: DayWindowReturn[];                       // 当該曜日、日付昇順、bin割当済
  bins: ReturnBin[];
  seriesDates: { ms: number; close: number }[];  // 全営業日の終値（背景ライン用、日付昇順）
  msMin: number;
  msMax: number;
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

function dateToMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

const DAY_MS = 86400000;

// 単一曜日の窓リターンを曜日内クインタイル（ランクベースで均等）に分け、
// 各日を暦日にひも付けて返す。背景の原系列終値ラインも併せて返す。
export function computeWindowBinTiming(
  bars: IntradayBar[],
  gmtoffset: number,
  startMinute: number,
  endMinute: number,
  weekday: number,
  binMinutes = 30,
  numBins = 5
): WindowBinTimingResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length === 0) return null;

  const start = Math.min(startMinute, endMinute);
  const end = Math.max(startMinute, endMinute);

  // 背景ライン用：全営業日の終値（日付昇順）
  const seriesDates = days.map((d) => ({ ms: dateToMs(d.date), close: d.close }));
  const msMin = seriesDates.length ? seriesDates[0].ms : 0;
  const msMax = seriesDates.length ? seriesDates[seriesDates.length - 1].ms : 0;

  // 当該曜日の窓リターン
  const wdDays: { date: string; ms: number; r: number }[] = [];
  for (const d of days) {
    if (d.weekday !== weekday) continue;
    const r = dayWindowReturn(d.bars, gmtoffset, start, end);
    if (r === null) continue;
    wdDays.push({ date: d.date, ms: dateToMs(d.date), r });
  }
  if (wdDays.length === 0) {
    return { weekday, startMinute: start, endMinute: end, numBins, days: [], bins: [], seriesDates, msMin, msMax };
  }

  // ランクベースのクインタイル割当（同値があってもほぼ均等）
  const order = [...wdDays.keys()].sort((a, b) => wdDays[a].r - wdDays[b].r);
  const binOf = new Array<number>(wdDays.length).fill(0);
  order.forEach((origIdx, rank) => {
    binOf[origIdx] = Math.min(numBins - 1, Math.floor((rank * numBins) / wdDays.length));
  });

  const daysOut: DayWindowReturn[] = wdDays
    .map((d, i) => ({ date: d.date, ms: d.ms, r: d.r, bin: binOf[i] }))
    .sort((a, b) => a.ms - b.ms);

  // ビンごとの集計（時間的位置を含む）
  const bins: ReturnBin[] = [];
  for (let b = 0; b < numBins; b++) {
    const members = daysOut.filter((d) => d.bin === b);
    if (members.length === 0) {
      bins.push({ bin: b, loR: 0, hiR: 0, n: 0, meanR: 0, firstDate: "", lastDate: "", centroidMs: 0, spanDays: 0, dispersion: 0 });
      continue;
    }
    const rs = members.map((m) => m.r);
    const mss = members.map((m) => m.ms);
    const meanMs = mss.reduce((s, v) => s + v, 0) / mss.length;
    const varMs = mss.length > 1 ? mss.reduce((s, v) => s + (v - meanMs) ** 2, 0) / mss.length : 0;
    const totalSpan = Math.max(1, msMax - msMin);
    bins.push({
      bin: b,
      loR: Math.min(...rs),
      hiR: Math.max(...rs),
      n: members.length,
      meanR: rs.reduce((s, v) => s + v, 0) / rs.length,
      firstDate: members[0].date,
      lastDate: members[members.length - 1].date,
      centroidMs: meanMs,
      spanDays: Math.round((mss[mss.length - 1] - mss[0]) / DAY_MS),
      dispersion: Math.sqrt(varMs) / totalSpan,
    });
  }

  return { weekday, startMinute: start, endMinute: end, numBins, days: daysOut, bins, seriesDates, msMin, msMax };
}
