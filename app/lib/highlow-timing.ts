// 日中足から「各営業日の高値・安値がどの時間帯で付いたか」を集計する。
//
// 日足 OHLC には時刻情報が無いため、この分析には実際の日中足(intraday bars)が
// 必須。/api/intraday から取得したバー列と、取引所の gmtoffset を渡すことで、
// 各日の高値/安値を付けたバーの「取引所ローカル時刻(=分)」を特定し、
// 30分刻みなどの時間帯ビンに集計する。

export interface IntradayBar {
  ts: number; // UNIX秒(UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TimingBin {
  startMinute: number; // ビン開始の「ローカル午前0時からの分」
  label: string; // "HH:MM"
}

export interface HighLowTimingResult {
  bins: TimingBin[];
  highCounts: number[]; // 各ビンで高値が付いた日数
  lowCounts: number[]; // 各ビンで安値が付いた日数
  nDays: number; // 対象営業日数
  binMinutes: number;
  // 寄り(最初のビン)・引け(最後のビン)で付いた割合
  highOpenShare: number;
  highCloseShare: number;
  lowOpenShare: number;
  lowCloseShare: number;
  // 高値/安値時刻の中央値(分)。U字/逆U字や前後関係の判断に使う
  highMedianMinute: number;
  lowMedianMinute: number;
  // 同一バー内で高値と安値が同時に付いた(髭の大きい)日の数。誠実な注記用
  sameBarDays: number;
  sessionStartMinute: number;
  sessionEndMinute: number;
}

// ローカル時刻(秒)に変換。負の剰余を避ける。
function localSecondsOfDay(ts: number, gmtoffset: number): number {
  const s = ((ts + gmtoffset) % 86400 + 86400) % 86400;
  return s;
}

function localDay(ts: number, gmtoffset: number): number {
  return Math.floor((ts + gmtoffset) / 86400);
}

function minuteLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function computeHighLowTiming(
  bars: IntradayBar[],
  gmtoffset: number,
  binMinutes = 30
): HighLowTimingResult {
  const empty: HighLowTimingResult = {
    bins: [], highCounts: [], lowCounts: [], nDays: 0, binMinutes,
    highOpenShare: 0, highCloseShare: 0, lowOpenShare: 0, lowCloseShare: 0,
    highMedianMinute: 0, lowMedianMinute: 0, sameBarDays: 0,
    sessionStartMinute: 0, sessionEndMinute: 0,
  };
  if (bars.length === 0) return empty;

  // 1) 日ごとにバーをまとめる
  const byDay = new Map<number, IntradayBar[]>();
  for (const b of bars) {
    const d = localDay(b.ts, gmtoffset);
    const arr = byDay.get(d);
    if (arr) arr.push(b);
    else byDay.set(d, [b]);
  }

  // セッションの実観測レンジ(分)。JP/USを問わず自動追従させる。
  let sessionStart = Infinity;
  let sessionEnd = -Infinity;
  for (const b of bars) {
    const m = Math.floor(localSecondsOfDay(b.ts, gmtoffset) / 60);
    if (m < sessionStart) sessionStart = m;
    if (m > sessionEnd) sessionEnd = m;
  }

  const highMinutes: number[] = [];
  const lowMinutes: number[] = [];
  let sameBarDays = 0;

  for (const dayBars of byDay.values()) {
    if (dayBars.length === 0) continue;
    // 時系列順にして「最初に到達したバー」を採用(最初のタッチが意思決定上重要)
    dayBars.sort((a, b) => a.ts - b.ts);

    let hi = -Infinity, lo = Infinity;
    let hiBar: IntradayBar | null = null;
    let loBar: IntradayBar | null = null;
    for (const b of dayBars) {
      if (b.high > hi) { hi = b.high; hiBar = b; }
      if (b.low < lo) { lo = b.low; loBar = b; }
    }
    if (!hiBar || !loBar) continue;

    highMinutes.push(Math.floor(localSecondsOfDay(hiBar.ts, gmtoffset) / 60));
    lowMinutes.push(Math.floor(localSecondsOfDay(loBar.ts, gmtoffset) / 60));
    if (hiBar.ts === loBar.ts) sameBarDays++;
  }

  const nDays = highMinutes.length;
  if (nDays === 0 || !isFinite(sessionStart)) return empty;

  // 2) 時間帯ビンを構築(セッション開始を binMinutes 単位に丸めた所から)
  const binStart = Math.floor(sessionStart / binMinutes) * binMinutes;
  const bins: TimingBin[] = [];
  for (let m = binStart; m <= sessionEnd; m += binMinutes) {
    bins.push({ startMinute: m, label: minuteLabel(m) });
  }
  const nBins = bins.length;

  const binIndex = (minute: number): number => {
    const idx = Math.floor((minute - binStart) / binMinutes);
    return Math.max(0, Math.min(nBins - 1, idx));
  };

  const highCounts = new Array(nBins).fill(0);
  const lowCounts = new Array(nBins).fill(0);
  for (const m of highMinutes) highCounts[binIndex(m)]++;
  for (const m of lowMinutes) lowCounts[binIndex(m)]++;

  return {
    bins,
    highCounts,
    lowCounts,
    nDays,
    binMinutes,
    highOpenShare: highCounts[0] / nDays,
    highCloseShare: highCounts[nBins - 1] / nDays,
    lowOpenShare: lowCounts[0] / nDays,
    lowCloseShare: lowCounts[nBins - 1] / nDays,
    highMedianMinute: median(highMinutes),
    lowMedianMinute: median(lowMinutes),
    sameBarDays,
    sessionStartMinute: sessionStart,
    sessionEndMinute: sessionEnd,
  };
}
