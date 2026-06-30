// 週内クロック（Week Clock）の計算ロジック。
// 「月曜の始値」を原点(=0)に固定し、その週の価格を原点比の対数リターンに正規化したうえで、
// 各曜日（さらに日中足では各時間帯）における“累積OHLC”——
//   open  = 常に月曜始値(=0)
//   close = その時点の終値（原点比）
//   high  = 週初からその時点までの高値の走査最大（原点比）
//   low   = 週初からその時点までの安値の走査最小（原点比）
// ——を多数の週で重ね合わせ、典型的な週内の「形」を捉える純粋関数群。
//
// リターンはすべて対数リターン（小数）。表示側で ×100 して % にする。
import { PricePoint } from "./types";
import {
  IntradayBar,
  localDay,
  buildBinGrid,
  binIndexOfMinute,
  localMinute,
} from "./intraday-core";

// 原点の取り方: monday=月曜始値（月曜が無い週は除外）, firstday=その週の最初の営業日の始値
export type AnchorMode = "monday" | "firstday";

const WD_NAMES: Record<number, string> = { 1: "月", 2: "火", 3: "水", 4: "木", 5: "金" };

// ─────────────────────────── 数値補助 ───────────────────────────

function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
}
function ln(from: number, to: number): number {
  return Math.log(to / from);
}

// ISO風の「月曜始まり」週キー。dow(月=1..日=7)を求め、その週の月曜の通し日数を返す。
function isoDow(jsDow: number): number {
  return ((jsDow + 6) % 7) + 1; // 0(日)→7, 1(月)→1 .. 6(土)→6
}

// ─────────────────────────── 日足: 週内クロック ───────────────────────────

export interface DaySlotStat {
  dow: number; // 1..5
  label: string; // 月..金
  n: number; // この曜日に寄与した週数
  meanClose: number;
  medianClose: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  meanHigh: number; // 週初からの累積高値（走査最大）の平均
  meanLow: number; // 週初からの累積安値（走査最小）の平均
  upRate: number; // cumClose>0 の週の割合（その時点で週初比プラスの確率）
}

export interface WeekClockDaily {
  slots: DaySlotStat[];
  nWeeks: number;
  anchorMode: AnchorMode;
}

interface DayRec {
  t: number;
  dow: number; // 1..5
  open: number;
  high: number;
  low: number;
  close: number;
}

function groupDailyByWeek(prices: PricePoint[]): DayRec[][] {
  const byWeek = new Map<number, DayRec[]>();
  for (const p of prices) {
    if (p.open == null || p.high == null || p.low == null || p.close == null) continue;
    const d = new Date(p.time);
    const dow = isoDow(d.getDay());
    if (dow > 5) continue; // 週末は無視（通常データに無いが念のため）
    const dayNum = Math.floor(d.getTime() / 86400000);
    const mondayNum = dayNum - (dow - 1); // その週の月曜の通し日数
    const arr = byWeek.get(mondayNum);
    const rec: DayRec = { t: d.getTime(), dow, open: p.open, high: p.high, low: p.low, close: p.close };
    if (arr) arr.push(rec);
    else byWeek.set(mondayNum, [rec]);
  }
  const weeks = [...byWeek.values()];
  for (const w of weeks) w.sort((a, b) => a.t - b.t);
  return weeks;
}

export function computeWeekClockDaily(prices: PricePoint[], anchorMode: AnchorMode): WeekClockDaily {
  const weeks = groupDailyByWeek(prices);
  // 曜日スロットごとの値を貯める
  const close: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  const high: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  const low: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  let nWeeks = 0;

  for (const wk of weeks) {
    if (wk.length === 0) continue;
    let anchor: number;
    if (anchorMode === "monday") {
      const mon = wk.find((d) => d.dow === 1);
      if (!mon || mon.open <= 0) continue; // 月曜が無い週は除外
      anchor = mon.open;
    } else {
      if (wk[0].open <= 0) continue;
      anchor = wk[0].open;
    }
    nWeeks++;
    let runHigh = -Infinity;
    let runLow = Infinity;
    for (let k = 0; k < wk.length; k++) {
      const d = wk[k];
      if (d.high > runHigh) runHigh = d.high;
      if (d.low < runLow) runLow = d.low;
      if (d.close <= 0) continue;
      // monday: 暦の曜日でスロット集計（祝日は欠番）。firstday: 各週の営業日序数(1..5)で整列。
      const slot = anchorMode === "monday" ? d.dow : k + 1;
      if (slot < 1 || slot > 5) continue;
      close[slot].push(ln(anchor, d.close));
      high[slot].push(ln(anchor, runHigh));
      low[slot].push(ln(anchor, runLow));
    }
  }

  const slots: DaySlotStat[] = [];
  for (let dow = 1; dow <= 5; dow++) {
    const label = anchorMode === "monday" ? WD_NAMES[dow] : `${dow}日目`;
    const c = [...close[dow]].sort((a, b) => a - b);
    if (c.length === 0) {
      slots.push({
        dow, label, n: 0,
        meanClose: NaN, medianClose: NaN, p10: NaN, p25: NaN, p75: NaN, p90: NaN,
        meanHigh: NaN, meanLow: NaN, upRate: NaN,
      });
      continue;
    }
    slots.push({
      dow,
      label,
      n: c.length,
      meanClose: mean(close[dow]),
      medianClose: quantile(c, 0.5),
      p10: quantile(c, 0.1),
      p25: quantile(c, 0.25),
      p75: quantile(c, 0.75),
      p90: quantile(c, 0.9),
      meanHigh: mean(high[dow]),
      meanLow: mean(low[dow]),
      upRate: close[dow].filter((v) => v > 0).length / close[dow].length,
    });
  }
  return { slots, nWeeks, anchorMode };
}

// ─────────────────────────── 日中足: 週内クロック ───────────────────────────

export interface IntradayClockPoint {
  weekday: number; // monday: 曜日1..5 / firstday: 営業日序数1..5
  minute: number; // ローカル0時からの分
  label: string; // "火 10:30" または "1日目 10:30"
  isWeekdayStart: boolean; // 各曜日(序数)の先頭スロット（区切り描画用）
  n: number;
  meanClose: number;
  medianClose: number;
  p25: number;
  p75: number;
  meanHigh: number;
  meanLow: number;
}

export interface WeekClockIntraday {
  points: IntradayClockPoint[];
  nWeeks: number;
  binMinutes: number;
  weekdays: number[];
  anchorMode: AnchorMode;
}

function minuteLabel(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function computeWeekClockIntraday(
  bars: IntradayBar[],
  gmtoffset: number,
  binMinutes: number,
  anchorMode: AnchorMode
): WeekClockIntraday | null {
  const grid = buildBinGrid(bars, gmtoffset, binMinutes);
  if (!grid) return null;

  // 週グルーピング: localDay → その週の月曜の通し日数
  const byWeek = new Map<number, IntradayBar[]>();
  for (const b of bars) {
    if (b == null || b.open == null || b.high == null || b.low == null || b.close == null) continue;
    const ld = localDay(b.ts, gmtoffset);
    const jsDow = (((ld % 7) + 7 + 4) % 7); // 1970-01-01(epoch)=木曜=4 → 0(日)..6(土)
    const dow = isoDow(jsDow);
    if (dow > 5) continue;
    const mondayNum = ld - (dow - 1);
    const arr = byWeek.get(mondayNum);
    if (arr) arr.push(b);
    else byWeek.set(mondayNum, [b]);
  }

  // スロット = (曜日, 時間帯ビン) の昇順。曜日は1..5固定、ビンはグリッド準拠。
  const nBins = grid.bins.length;
  const weekdaysPresent = new Set<number>();
  // 蓄積配列: slotKey = dow*1000 + binIndex
  const close = new Map<number, number[]>();
  const high = new Map<number, number[]>();
  const low = new Map<number, number[]>();
  const push = (m: Map<number, number[]>, key: number, v: number) => {
    const a = m.get(key);
    if (a) a.push(v);
    else m.set(key, [v]);
  };

  let nWeeks = 0;
  for (const wk of byWeek.values()) {
    if (wk.length === 0) continue;
    wk.sort((a, b) => a.ts - b.ts);
    // 原点
    let anchor: number;
    if (anchorMode === "monday") {
      const mon = wk.find((b) => {
        const ld = localDay(b.ts, gmtoffset);
        return isoDow((((ld % 7) + 7 + 4) % 7)) === 1;
      });
      if (!mon || mon.open <= 0) continue;
      anchor = mon.open;
    } else {
      if (wk[0].open <= 0) continue;
      anchor = wk[0].open;
    }
    nWeeks++;
    // firstday: その週に出現する営業日を昇順で 1..5 の序数に割り当てる（祝日週も「1日目」で整列）。
    const dayOrdinal = new Map<number, number>();
    if (anchorMode === "firstday") {
      let ord = 0;
      for (const b of wk) {
        const ld = localDay(b.ts, gmtoffset);
        if (!dayOrdinal.has(ld)) dayOrdinal.set(ld, ++ord);
      }
    }
    let runHigh = -Infinity;
    let runLow = Infinity;
    for (const b of wk) {
      if (b.high > runHigh) runHigh = b.high;
      if (b.low < runLow) runLow = b.low;
      const ld = localDay(b.ts, gmtoffset);
      const dow = isoDow((((ld % 7) + 7 + 4) % 7));
      if (dow > 5) continue;
      const slot = anchorMode === "monday" ? dow : (dayOrdinal.get(ld) as number);
      if (slot < 1 || slot > 5) continue;
      weekdaysPresent.add(slot);
      const bi = binIndexOfMinute(localMinute(b.ts, gmtoffset), grid);
      const key = slot * 1000 + bi;
      if (b.close > 0) push(close, key, ln(anchor, b.close));
      push(high, key, ln(anchor, runHigh));
      push(low, key, ln(anchor, runLow));
    }
  }

  const weekdays = [...weekdaysPresent].sort((a, b) => a - b);
  const points: IntradayClockPoint[] = [];
  for (const slot of weekdays) {
    const prefix = anchorMode === "monday" ? WD_NAMES[slot] : `${slot}日目`;
    for (let bi = 0; bi < nBins; bi++) {
      const key = slot * 1000 + bi;
      const c = close.get(key);
      if (!c || c.length === 0) continue;
      const cs = [...c].sort((a, b) => a - b);
      points.push({
        weekday: slot,
        minute: grid.bins[bi].startMinute,
        label: `${prefix} ${minuteLabel(grid.bins[bi].startMinute)}`,
        isWeekdayStart: bi === 0 || !close.has(slot * 1000 + (bi - 1)),
        n: c.length,
        meanClose: mean(c),
        medianClose: quantile(cs, 0.5),
        p25: quantile(cs, 0.25),
        p75: quantile(cs, 0.75),
        meanHigh: mean(high.get(key) ?? []),
        meanLow: mean(low.get(key) ?? []),
      });
    }
  }
  // 各曜日の先頭を区切りとして再マーク（最初に出現する点）
  const seen = new Set<number>();
  for (const p of points) {
    if (!seen.has(p.weekday)) {
      p.isWeekdayStart = true;
      seen.add(p.weekday);
    } else {
      p.isWeekdayStart = false;
    }
  }

  return { points, nWeeks, binMinutes, weekdays, anchorMode };
}
