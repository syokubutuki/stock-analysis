// 日中足(intraday bars)分析の共通基盤。
// 取引所ローカル時刻の算出、日次グルーピング、時間帯ビン格子、
// 1バーのボラ推定など、複数の日中足分析ライブラリが共有する関数をまとめる。
// highlow-timing.ts は独自の私的コピーを持つが、新規ライブラリ群はここを起点にする。

export interface IntradayBar {
  ts: number; // UNIX秒(UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ───────────────────────── ローカル時刻 ─────────────────────────
// Yahoo は UTC秒(ts) と取引所の gmtoffset を返す。ローカル時刻 = ts + gmtoffset。

export function localSecondsOfDay(ts: number, gmtoffset: number): number {
  return (((ts + gmtoffset) % 86400) + 86400) % 86400;
}
export function localDay(ts: number, gmtoffset: number): number {
  return Math.floor((ts + gmtoffset) / 86400);
}
export function localMinute(ts: number, gmtoffset: number): number {
  return Math.floor(localSecondsOfDay(ts, gmtoffset) / 60);
}
export function localDateStr(ts: number, gmtoffset: number): string {
  const d = new Date((ts + gmtoffset) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
export function minuteToLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = Math.round(minute % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ───────────────────────── 日次グルーピング ─────────────────────────

export interface DayData {
  date: string; // YYYY-MM-DD（取引所ローカル）
  weekday: number; // 0=日..6=土
  open: number;
  close: number;
  high: number;
  low: number;
  prevClose: number; // 前営業日終値（無ければ NaN）
  gap: number; // (open - prevClose) / prevClose（無ければ NaN）
  bars: IntradayBar[]; // 時刻昇順
}

// バー列を営業日ごとにまとめ、前日終値・ギャップを連結して返す（日付昇順）。
// null/欠損や出来高ゼロのバーは呼び出し側で除外済みを想定するが、null OHLC はここでも弾く。
export function groupByDay(bars: IntradayBar[], gmtoffset: number): DayData[] {
  const byDay = new Map<number, IntradayBar[]>();
  for (const b of bars) {
    if (b == null || b.open == null || b.high == null || b.low == null || b.close == null) continue;
    const d = localDay(b.ts, gmtoffset);
    const arr = byDay.get(d);
    if (arr) arr.push(b);
    else byDay.set(d, [b]);
  }

  const days: DayData[] = [];
  for (const [, dayBars] of byDay) {
    if (dayBars.length === 0) continue;
    dayBars.sort((a, b) => a.ts - b.ts);
    let hi = -Infinity, lo = Infinity;
    for (const b of dayBars) {
      if (b.high > hi) hi = b.high;
      if (b.low < lo) lo = b.low;
    }
    const date = localDateStr(dayBars[0].ts, gmtoffset);
    days.push({
      date,
      weekday: new Date(`${date}T00:00:00Z`).getUTCDay(),
      open: dayBars[0].open,
      close: dayBars[dayBars.length - 1].close,
      high: hi,
      low: lo,
      prevClose: NaN,
      gap: NaN,
      bars: dayBars,
    });
  }

  days.sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < days.length; i++) {
    const pc = days[i - 1].close;
    days[i].prevClose = pc;
    days[i].gap = pc > 0 ? (days[i].open - pc) / pc : NaN;
  }
  return days;
}

// ───────────────────────── 時間帯ビン格子 ─────────────────────────

export interface TimingBin {
  startMinute: number; // ローカル0時からの分
  label: string; // "HH:MM"
}
export interface BinGrid {
  binStart: number;
  binMinutes: number;
  bins: TimingBin[];
  sessionStart: number; // 観測された最早バーの分
  sessionEnd: number; // 観測された最遅バーの分
}

// データ実測のセッション範囲から時間帯ビンを構築（取引所非依存）。
export function buildBinGrid(bars: IntradayBar[], gmtoffset: number, binMinutes: number): BinGrid | null {
  let sessionStart = Infinity, sessionEnd = -Infinity;
  for (const b of bars) {
    const m = localMinute(b.ts, gmtoffset);
    if (m < sessionStart) sessionStart = m;
    if (m > sessionEnd) sessionEnd = m;
  }
  if (!isFinite(sessionStart)) return null;
  const binStart = Math.floor(sessionStart / binMinutes) * binMinutes;
  const bins: TimingBin[] = [];
  for (let m = binStart; m <= sessionEnd; m += binMinutes) {
    bins.push({ startMinute: m, label: minuteToLabel(m) });
  }
  return { binStart, binMinutes, bins, sessionStart, sessionEnd };
}

export function binIndexOfMinute(minute: number, grid: BinGrid): number {
  const idx = Math.floor((minute - grid.binStart) / grid.binMinutes);
  return Math.max(0, Math.min(grid.bins.length - 1, idx));
}

// ───────────────────────── ボラ・数値補助 ─────────────────────────

// Garman-Klass の1バー版分散推定（O,H,L,C から）。負になり得るので0でクランプ。
export function garmanKlassVar(o: number, h: number, l: number, c: number): number {
  if (o <= 0 || h <= 0 || l <= 0 || c <= 0) return 0;
  const hl = Math.log(h / l);
  const co = Math.log(c / o);
  const v = 0.5 * hl * hl - (2 * Math.log(2) - 1) * co * co;
  return v > 0 ? v : 0;
}

export function logReturn(from: number, to: number): number {
  if (from <= 0 || to <= 0) return 0;
  return Math.log(to / from);
}

export function meanOf(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
export function sumOf(a: number[]): number {
  return a.reduce((s, v) => s + v, 0);
}
export function medianOf(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
export function stdOf(a: number[]): number {
  if (a.length < 2) return 0;
  const m = meanOf(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
