// 日中足から「各営業日の高値・安値がどの時間帯で付いたか」と、その背後の
// 構造(高安の順序＝方向、前日/ギャップとの条件付け、到達確率、典型日中形状、
// オープニングレンジ・前日水準のブレイク追随)を抽出する。
//
// 日足 OHLC には時刻情報が無いため、これらの分析には実際の日中足(intraday bars)が
// 必須。/api/intraday から取得したバー列と取引所の gmtoffset を渡して使う。

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

// ───────────────────────── 共通ユーティリティ ─────────────────────────

function localSecondsOfDay(ts: number, gmtoffset: number): number {
  return ((ts + gmtoffset) % 86400 + 86400) % 86400;
}
function localDay(ts: number, gmtoffset: number): number {
  return Math.floor((ts + gmtoffset) / 86400);
}
function localMinute(ts: number, gmtoffset: number): number {
  return Math.floor(localSecondsOfDay(ts, gmtoffset) / 60);
}
function localDateStr(ts: number, gmtoffset: number): string {
  const d = new Date((ts + gmtoffset) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
export function minuteToLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = Math.round(minute % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

// ───────────────────────── 日次レコード抽出 ─────────────────────────

export interface DayRecord {
  date: string;
  weekday: number; // 0=日 .. 6=土（取引所ローカル日付ベース）
  open: number;
  close: number;
  high: number;
  low: number;
  tH: number; // 高値を付けた最初のバーのローカル分
  tL: number; // 安値を付けた最初のバーのローカル分
  highFirst: boolean; // tH < tL（高値が先）
  sameBar: boolean; // 高安が同一バー
  closePos: number; // (close-low)/(high-low) 終値のレンジ内位置 0=安値 1=高値
  dayRet: number; // (close-open)/open 当日寄り→引けリターン
  volAtHigh: number;
  volAtLow: number;
  bars: IntradayBar[]; // 時系列ソート済み（平均形状・OR計算用）
  // 横断（前後日）で埋めるフィールド
  prevClose: number; // 前日終値（無ければ NaN）
  gap: number; // (open-prevClose)/prevClose
  nextRet: number; // 翌日 close→close リターン（無ければ NaN）
  trendUp: boolean; // close > 移動平均
  prevHigh: number;
  prevLow: number;
}

function extractDayRecords(bars: IntradayBar[], gmtoffset: number): DayRecord[] {
  const byDay = new Map<number, IntradayBar[]>();
  for (const b of bars) {
    const d = localDay(b.ts, gmtoffset);
    const arr = byDay.get(d);
    if (arr) arr.push(b);
    else byDay.set(d, [b]);
  }

  const recs: DayRecord[] = [];
  for (const [, dayBars] of byDay) {
    if (dayBars.length === 0) continue;
    dayBars.sort((a, b) => a.ts - b.ts);

    let hi = -Infinity, lo = Infinity;
    let hiBar: IntradayBar | null = null, loBar: IntradayBar | null = null;
    for (const b of dayBars) {
      if (b.high > hi) { hi = b.high; hiBar = b; }
      if (b.low < lo) { lo = b.low; loBar = b; }
    }
    if (!hiBar || !loBar) continue;

    const open = dayBars[0].open;
    const close = dayBars[dayBars.length - 1].close;
    const range = hi - lo;
    const tH = localMinute(hiBar.ts, gmtoffset);
    const tL = localMinute(loBar.ts, gmtoffset);

    const date = localDateStr(dayBars[0].ts, gmtoffset);
    recs.push({
      date,
      weekday: new Date(`${date}T00:00:00Z`).getUTCDay(),
      open, close, high: hi, low: lo,
      tH, tL,
      highFirst: tH < tL,
      sameBar: hiBar.ts === loBar.ts,
      closePos: range > 0 ? (close - lo) / range : 0.5,
      dayRet: open > 0 ? (close - open) / open : 0,
      volAtHigh: hiBar.volume,
      volAtLow: loBar.volume,
      bars: dayBars,
      prevClose: NaN, gap: NaN, nextRet: NaN, trendUp: false,
      prevHigh: NaN, prevLow: NaN,
    });
  }

  recs.sort((a, b) => a.date.localeCompare(b.date));

  // 横断フィールドを埋める
  const W = 20; // トレンド判定の移動平均窓
  for (let i = 0; i < recs.length; i++) {
    if (i > 0) {
      recs[i].prevClose = recs[i - 1].close;
      recs[i].prevHigh = recs[i - 1].high;
      recs[i].prevLow = recs[i - 1].low;
      recs[i].gap = recs[i - 1].close > 0
        ? (recs[i].open - recs[i - 1].close) / recs[i - 1].close : NaN;
    }
    if (i < recs.length - 1) {
      recs[i].nextRet = recs[i].close > 0
        ? (recs[i + 1].close - recs[i].close) / recs[i].close : NaN;
    }
    if (i >= W - 1) {
      let s = 0;
      for (let k = i - W + 1; k <= i; k++) s += recs[k].close;
      recs[i].trendUp = recs[i].close > s / W;
    }
  }

  return recs;
}

// ───────────────────────── 時間帯ビン共通 ─────────────────────────

interface BinGrid {
  binStart: number;
  binMinutes: number;
  bins: TimingBin[];
  sessionStart: number;
  sessionEnd: number;
}

function buildBinGrid(bars: IntradayBar[], gmtoffset: number, binMinutes: number): BinGrid | null {
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

function binIndexOf(minute: number, grid: BinGrid): number {
  const idx = Math.floor((minute - grid.binStart) / grid.binMinutes);
  return Math.max(0, Math.min(grid.bins.length - 1, idx));
}

function histogram(minutes: number[], grid: BinGrid): number[] {
  const counts = new Array(grid.bins.length).fill(0);
  for (const m of minutes) counts[binIndexOf(m, grid)]++;
  return counts;
}

// ───────────────────────── 統合分析 ─────────────────────────

export interface PathArchetype {
  key: string;
  label: string;
  desc: string;
  count: number;
  share: number;
  avgDayRet: number; // 当日 寄り→引け
  avgNextRet: number; // 翌日 close→close
  winRateNext: number; // 翌日プラス率
}

export interface ProfilePoint {
  startMinute: number;
  label: string;
  count: number;
  meanPct: number; // (price-open)/open の平均(%)
  sdPct: number;
  meanUpPct: number; // 引け陽線日のみ平均
  meanDownPct: number; // 引け陰線日のみ平均
}

export interface BreakoutStats {
  orMinutes: number;
  // 当日高安が OR 時間内に確定した割合
  highInOrShare: number;
  lowInOrShare: number;
  // OR 上抜け→引けも OR 高値超で終えた割合(追随)。OR 下抜けも同様
  upBreakDays: number;
  upFollowThrough: number;
  downBreakDays: number;
  downFollowThrough: number;
  // 前日高値タッチ日のうち、引けも前日高値超で終えた割合(ブレイク成功)
  prevHighTouchShare: number;
  prevHighHoldShare: number;
  prevLowTouchShare: number;
  prevLowHoldShare: number;
}

export interface IntradayAnalysis {
  records: DayRecord[];
  gmtoffset: number;
  nDays: number;
  binMinutes: number;
  bins: TimingBin[];
  sessionStartMinute: number;
  sessionEndMinute: number;
  // ① 時間帯分布
  highCounts: number[];
  lowCounts: number[];
  highMedianMinute: number;
  lowMedianMinute: number;
  highOpenShare: number;
  highCloseShare: number;
  lowOpenShare: number;
  lowCloseShare: number;
  sameBarDays: number;
  // ② 到達確率(累積=ハザード)
  highCdf: number[]; // bins と同長。「その時刻までに高値が出ている確率」
  lowCdf: number[];
  // ③ 日中パス類型
  highFirstShare: number;
  paths: PathArchetype[];
  // ④ 平均日中プロファイル
  profile: ProfilePoint[];
  // ⑤ ブレイク
  breakout: BreakoutStats;
  // 内部(条件付け用)
  _grid: BinGrid;
}

export function analyzeIntraday(
  bars: IntradayBar[],
  gmtoffset: number,
  binMinutes = 30,
  orMinutes = 30
): IntradayAnalysis | null {
  if (bars.length === 0) return null;
  const grid = buildBinGrid(bars, gmtoffset, binMinutes);
  if (!grid) return null;
  const records = extractDayRecords(bars, gmtoffset);
  const nDays = records.length;
  if (nDays === 0) return null;

  const highMinutes = records.map((r) => r.tH);
  const lowMinutes = records.map((r) => r.tL);
  const highCounts = histogram(highMinutes, grid);
  const lowCounts = histogram(lowMinutes, grid);
  const nBins = grid.bins.length;

  // 累積(到達確率)
  const highCdf: number[] = [];
  const lowCdf: number[] = [];
  let hc = 0, lc = 0;
  for (let i = 0; i < nBins; i++) {
    hc += highCounts[i]; lc += lowCounts[i];
    highCdf.push(hc / nDays);
    lowCdf.push(lc / nDays);
  }

  // ③ パス類型: 高安順序 × 引け方向
  const archetypes = classifyPaths(records);
  const highFirstShare = records.filter((r) => r.highFirst).length / nDays;

  // ④ 平均日中プロファイル
  const profile = computeProfile(records, grid, gmtoffset);

  // ⑤ ブレイク
  const breakout = computeBreakout(records, gmtoffset, grid, orMinutes);

  const sameBarDays = records.filter((r) => r.sameBar).length;

  return {
    records, gmtoffset, nDays, binMinutes, bins: grid.bins,
    sessionStartMinute: grid.sessionStart,
    sessionEndMinute: grid.sessionEnd,
    highCounts, lowCounts,
    highMedianMinute: median(highMinutes),
    lowMedianMinute: median(lowMinutes),
    highOpenShare: highCounts[0] / nDays,
    highCloseShare: highCounts[nBins - 1] / nDays,
    lowOpenShare: lowCounts[0] / nDays,
    lowCloseShare: lowCounts[nBins - 1] / nDays,
    sameBarDays,
    highCdf, lowCdf,
    highFirstShare,
    paths: archetypes,
    profile,
    breakout,
    _grid: grid,
  };
}

// ③ パス類型分類
function classifyPaths(records: DayRecord[]): PathArchetype[] {
  const defs: { key: string; label: string; desc: string; test: (r: DayRecord) => boolean }[] = [
    { key: "lf_up", label: "朝安→切り返し(陽)", desc: "安値が先・引け陽線。押し目を吸収する強い形", test: (r) => !r.highFirst && r.dayRet > 0 },
    { key: "hf_down", label: "寄り天→失速(陰)", desc: "高値が先・引け陰線。配分・戻り売りの弱い形", test: (r) => r.highFirst && r.dayRet < 0 },
    { key: "hf_up", label: "高値先行だが陽線", desc: "一度上げて押すも引けは陽線。押し目買い優勢", test: (r) => r.highFirst && r.dayRet >= 0 },
    { key: "lf_down", label: "安値先行だが陰線", desc: "一度下げ戻し切れず引け安。戻り弱い", test: (r) => !r.highFirst && r.dayRet <= 0 },
  ];
  const n = records.length;
  return defs.map((d) => {
    const matched = records.filter(d.test);
    const withNext = matched.filter((r) => !isNaN(r.nextRet));
    return {
      key: d.key, label: d.label, desc: d.desc,
      count: matched.length,
      share: n ? matched.length / n : 0,
      avgDayRet: mean(matched.map((r) => r.dayRet)),
      avgNextRet: mean(withNext.map((r) => r.nextRet)),
      winRateNext: withNext.length ? withNext.filter((r) => r.nextRet > 0).length / withNext.length : 0,
    };
  });
}

// 1日の「始値比 (price-open)/open(%)」を時間帯ビン列に変換する。
// 各ビンはそのビン内最後のバー終値を代表値にし、欠損ビン(昼休み等)は前方補完する。
function dayBinnedPct(r: DayRecord, grid: BinGrid, gmtoffset: number): number[] {
  const n = grid.bins.length;
  const lastClose = new Array(n).fill(NaN);
  for (const b of r.bars) {
    lastClose[binIndexOf(localMinute(b.ts, gmtoffset), grid)] = b.close;
  }
  const out = new Array(n).fill(0);
  let carry = r.open;
  for (let i = 0; i < n; i++) {
    if (!isNaN(lastClose[i])) carry = lastClose[i];
    out[i] = r.open > 0 ? ((carry - r.open) / r.open) * 100 : 0;
  }
  return out;
}

// ④ 平均日中プロファイル: 時間帯ビンごとに (price-open)/open の平均(%)。
function computeProfile(records: DayRecord[], grid: BinGrid, gmtoffset: number): ProfilePoint[] {
  const n = grid.bins.length;
  const vals: number[][] = Array.from({ length: n }, () => []);
  const valsUp: number[][] = Array.from({ length: n }, () => []);
  const valsDn: number[][] = Array.from({ length: n }, () => []);

  for (const r of records) {
    if (r.open <= 0) continue;
    const path = dayBinnedPct(r, grid, gmtoffset);
    for (let i = 0; i < n; i++) {
      vals[i].push(path[i]);
      if (r.dayRet > 0) valsUp[i].push(path[i]);
      else if (r.dayRet < 0) valsDn[i].push(path[i]);
    }
  }

  return grid.bins.map((bin, i) => {
    const m = mean(vals[i]);
    const sd = vals[i].length
      ? Math.sqrt(mean(vals[i].map((v) => (v - m) ** 2)))
      : 0;
    return {
      startMinute: bin.startMinute,
      label: bin.label,
      count: vals[i].length,
      meanPct: m,
      sdPct: sd,
      meanUpPct: mean(valsUp[i]),
      meanDownPct: mean(valsDn[i]),
    };
  });
}

// ⑤ ブレイク統計
function computeBreakout(records: DayRecord[], gmtoffset: number, grid: BinGrid, orMinutes: number): BreakoutStats {
  const orEnd = grid.sessionStart + orMinutes;
  let highInOr = 0, lowInOr = 0;
  let upBreak = 0, upFollow = 0, downBreak = 0, downFollow = 0;
  let prevHighTouch = 0, prevHighHold = 0, prevLowTouch = 0, prevLowHold = 0;
  let prevCount = 0;

  for (const r of records) {
    if (r.tH < orEnd) highInOr++;
    if (r.tL < orEnd) lowInOr++;

    // オープニングレンジ
    let orHigh = -Infinity, orLow = Infinity;
    let postHigh = -Infinity, postLow = Infinity;
    for (const b of r.bars) {
      const m = localMinute(b.ts, gmtoffset);
      if (m < orEnd) {
        if (b.high > orHigh) orHigh = b.high;
        if (b.low < orLow) orLow = b.low;
      } else {
        if (b.high > postHigh) postHigh = b.high;
        if (b.low < postLow) postLow = b.low;
      }
    }
    if (isFinite(orHigh) && isFinite(postHigh) && postHigh > orHigh) {
      upBreak++;
      if (r.close > orHigh) upFollow++;
    }
    if (isFinite(orLow) && isFinite(postLow) && postLow < orLow) {
      downBreak++;
      if (r.close < orLow) downFollow++;
    }

    // 前日水準
    if (!isNaN(r.prevHigh)) {
      prevCount++;
      if (r.high >= r.prevHigh) { prevHighTouch++; if (r.close >= r.prevHigh) prevHighHold++; }
      if (r.low <= r.prevLow) { prevLowTouch++; if (r.close <= r.prevLow) prevLowHold++; }
    }
  }

  const n = records.length;
  return {
    orMinutes,
    highInOrShare: n ? highInOr / n : 0,
    lowInOrShare: n ? lowInOr / n : 0,
    upBreakDays: upBreak,
    upFollowThrough: upBreak ? upFollow / upBreak : 0,
    downBreakDays: downBreak,
    downFollowThrough: downBreak ? downFollow / downBreak : 0,
    prevHighTouchShare: prevCount ? prevHighTouch / prevCount : 0,
    prevHighHoldShare: prevHighTouch ? prevHighHold / prevHighTouch : 0,
    prevLowTouchShare: prevCount ? prevLowTouch / prevCount : 0,
    prevLowHoldShare: prevLowTouch ? prevLowHold / prevLowTouch : 0,
  };
}

// ───────────────────── ② 条件付き時間帯分布 ─────────────────────

export interface ConditionalTiming {
  label: string;
  trueLabel: string;
  falseLabel: string;
  nTrue: number;
  nFalse: number;
  highCountsTrue: number[];
  highCountsFalse: number[];
  lowCountsTrue: number[];
  lowCountsFalse: number[];
  highOpenShareTrue: number; // 高値が寄りビンに付いた割合(条件成立群)
  highOpenShareFalse: number;
}

export type ConditionKey = "gapUp" | "prevUp" | "trendUp";

export function conditionalTiming(
  analysis: IntradayAnalysis,
  key: ConditionKey
): ConditionalTiming {
  const grid = analysis._grid;
  const defs: Record<ConditionKey, { label: string; t: string; f: string; pred: (r: DayRecord) => boolean | null }> = {
    gapUp: { label: "ギャップ方向", t: "ギャップアップ日", f: "ギャップダウン日", pred: (r) => isNaN(r.gap) ? null : r.gap > 0 },
    // prevUp は前後関係が必要なため下で predFn を個別に組む（この pred は未使用）
    prevUp: { label: "前日の方向", t: "前日陽線の翌日", f: "前日陰線の翌日", pred: () => null },
    trendUp: { label: "トレンド(20日線)", t: "上昇トレンド日", f: "下降トレンド日", pred: (r) => r.trendUp },
  };

  // prevUp は前日リターン符号で判定（prevClose と prevPrevClose が必要なので records 走査）
  let predFn: (r: DayRecord, idx: number, recs: DayRecord[]) => boolean | null;
  if (key === "prevUp") {
    predFn = (_r, idx, recs) => {
      if (idx < 1) return null;
      const prev = recs[idx - 1];
      if (isNaN(prev.prevClose)) return null;
      return prev.close > prev.prevClose; // 前日が陽(close>その前日close)
    };
  } else {
    const p = defs[key].pred;
    predFn = (r) => p(r);
  }

  const trueHigh: number[] = [], falseHigh: number[] = [], trueLow: number[] = [], falseLow: number[] = [];
  analysis.records.forEach((r, idx) => {
    const v = predFn(r, idx, analysis.records);
    if (v === null) return;
    if (v) { trueHigh.push(r.tH); trueLow.push(r.tL); }
    else { falseHigh.push(r.tH); falseLow.push(r.tL); }
  });

  const hCt = histogram(trueHigh, grid);
  const hCf = histogram(falseHigh, grid);
  const lCt = histogram(trueLow, grid);
  const lCf = histogram(falseLow, grid);

  return {
    label: defs[key].label,
    trueLabel: defs[key].t,
    falseLabel: defs[key].f,
    nTrue: trueHigh.length,
    nFalse: falseHigh.length,
    highCountsTrue: hCt,
    highCountsFalse: hCf,
    lowCountsTrue: lCt,
    lowCountsFalse: lCf,
    highOpenShareTrue: trueHigh.length ? hCt[0] / trueHigh.length : 0,
    highOpenShareFalse: falseHigh.length ? hCf[0] / falseHigh.length : 0,
  };
}

// ───────────────── 曜日別 日中軌跡オーバーレイ ─────────────────

export interface DayPath {
  date: string;
  weekday: number;
  values: number[]; // 始値比(%) 時間帯ビン列
  endPct: number; // 引けの始値比(=その日の寄り→引け%)
}

export interface WeekdayMean {
  weekday: number;
  mean: number[];
  count: number;
  endMean: number; // 引けの平均始値比(%)
}

export interface WeekdayOverlay {
  bins: TimingBin[];
  paths: DayPath[];
  weekdayMean: WeekdayMean[]; // 月(1)〜金(5)
}

export function computeDayPaths(analysis: IntradayAnalysis): WeekdayOverlay {
  const grid = analysis._grid;
  const n = grid.bins.length;
  const paths: DayPath[] = analysis.records.map((r) => {
    const values = dayBinnedPct(r, grid, analysis.gmtoffset);
    return { date: r.date, weekday: r.weekday, values, endPct: values[n - 1] };
  });

  const weekdayMean: WeekdayMean[] = [1, 2, 3, 4, 5].map((wd) => {
    const ps = paths.filter((p) => p.weekday === wd);
    const m = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      m[i] = ps.length ? ps.reduce((s, p) => s + p.values[i], 0) / ps.length : 0;
    }
    return { weekday: wd, mean: m, count: ps.length, endMean: m[n - 1] };
  });

  return { bins: grid.bins, paths, weekdayMean };
}

// ───────────── 時間帯別 出来高・ボラティリティ プロファイル ─────────────

export interface ActivityPoint {
  startMinute: number;
  label: string;
  meanVolume: number; // 1日のそのビンの平均出来高
  volumeShare: number; // 1日出来高に占める割合
  meanRangePct: number; // バーの平均値幅 (high-low)/price (%)
}

export function computeActivityProfile(a: IntradayAnalysis): ActivityPoint[] {
  const grid = a._grid;
  const n = grid.bins.length;
  const dayVol: number[][] = Array.from({ length: n }, () => []);
  const barRange: number[][] = Array.from({ length: n }, () => []);

  for (const r of a.records) {
    const v = new Array(n).fill(0);
    const has = new Array(n).fill(false);
    for (const b of r.bars) {
      const idx = binIndexOf(localMinute(b.ts, a.gmtoffset), grid);
      v[idx] += b.volume;
      has[idx] = true;
      const base = b.open > 0 ? b.open : b.close;
      if (base > 0) barRange[idx].push(((b.high - b.low) / base) * 100);
    }
    for (let i = 0; i < n; i++) if (has[i]) dayVol[i].push(v[i]);
  }

  const meanVol = dayVol.map((arr) => mean(arr));
  const totalVol = meanVol.reduce((s, v) => s + v, 0) || 1;
  return grid.bins.map((bin, i) => ({
    startMinute: bin.startMinute,
    label: bin.label,
    meanVolume: meanVol[i],
    volumeShare: meanVol[i] / totalVol,
    meanRangePct: mean(barRange[i]),
  }));
}

// ───────────── 曜日 × 時刻 の 高値/安値 出現確率 ─────────────

export interface WeekdayHLProb {
  weekday: number;
  count: number;
  highProb: number[]; // bins と同長。その曜日で高値がそのビンに付く確率
  lowProb: number[];
  highPeakMinute: number;
  lowPeakMinute: number;
}

export function computeWeekdayHLProb(a: IntradayAnalysis): WeekdayHLProb[] {
  const grid = a._grid;
  return [1, 2, 3, 4, 5].map((wd) => {
    const recs = a.records.filter((r) => r.weekday === wd);
    const count = recs.length;
    const hCounts = histogram(recs.map((r) => r.tH), grid);
    const lCounts = histogram(recs.map((r) => r.tL), grid);
    const highProb = hCounts.map((c) => (count ? c / count : 0));
    const lowProb = lCounts.map((c) => (count ? c / count : 0));
    const argmax = (arr: number[]) => arr.reduce((bi, v, i, a2) => (v > a2[bi] ? i : bi), 0);
    return {
      weekday: wd, count, highProb, lowProb,
      highPeakMinute: count ? grid.bins[argmax(hCounts)].startMinute : 0,
      lowPeakMinute: count ? grid.bins[argmax(lCounts)].startMinute : 0,
    };
  });
}

// ───────────────────── 旧API（後方互換） ─────────────────────

export interface HighLowTimingResult {
  bins: TimingBin[];
  highCounts: number[];
  lowCounts: number[];
  nDays: number;
  binMinutes: number;
  highOpenShare: number;
  highCloseShare: number;
  lowOpenShare: number;
  lowCloseShare: number;
  highMedianMinute: number;
  lowMedianMinute: number;
  sameBarDays: number;
  sessionStartMinute: number;
  sessionEndMinute: number;
}

export function computeHighLowTiming(
  bars: IntradayBar[],
  gmtoffset: number,
  binMinutes = 30
): HighLowTimingResult {
  const a = analyzeIntraday(bars, gmtoffset, binMinutes);
  if (!a) {
    return {
      bins: [], highCounts: [], lowCounts: [], nDays: 0, binMinutes,
      highOpenShare: 0, highCloseShare: 0, lowOpenShare: 0, lowCloseShare: 0,
      highMedianMinute: 0, lowMedianMinute: 0, sameBarDays: 0,
      sessionStartMinute: 0, sessionEndMinute: 0,
    };
  }
  return {
    bins: a.bins, highCounts: a.highCounts, lowCounts: a.lowCounts,
    nDays: a.nDays, binMinutes: a.binMinutes,
    highOpenShare: a.highOpenShare, highCloseShare: a.highCloseShare,
    lowOpenShare: a.lowOpenShare, lowCloseShare: a.lowCloseShare,
    highMedianMinute: a.highMedianMinute, lowMedianMinute: a.lowMedianMinute,
    sameBarDays: a.sameBarDays,
    sessionStartMinute: a.sessionStartMinute, sessionEndMinute: a.sessionEndMinute,
  };
}
