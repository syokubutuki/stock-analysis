// 「状態 → 先行きリターン」の共通エンジン。
// 任意の状態関数 stateOf(i) で各日をバケットに割り当て、N日先のフォワードリターンを
// バケット別に集計する。平均・中央値・勝率・分散に加え、t検定 + Benjamini-Hochberg FDR で
// 有意性を、年次の符号一致で持続性を評価する。提案 9.1/5.1/1.1/4.x/6.x/10.x の土台。
//
// 設計上の注意:
//  - 先読みバイアス回避: 状態は「i 日終値時点で確定する情報のみ」で構成すること。
//  - フォワードリターン r = (exit[i+N] - entry[i]) / entry[i]。entry は当日終値 or 翌日始値。

import { PricePoint } from "./types";
import { mean, median, std, tTest, benjaminiHochberg, blockBootstrapCI } from "./stats-significance";

export interface ForwardStats {
  label: string;
  n: number;
  meanFwd: number;
  medianFwd: number;
  winRate: number;
  stdFwd: number;
  ciLow: number;
  ciHigh: number;
  p: number; // FDR補正後
  significant: boolean; // pAdj < 0.05
  byYear: { year: number; meanFwd: number; n: number }[];
}

export interface ForwardResult {
  buckets: ForwardStats[]; // order に従う
  order: string[];
  horizon: number;
  nowLabel: string | null; // 最新足が属するバケット
  baselineMean: number; // 全標本のフォワード平均(比較基準)
  baselineWin: number;
  totalN: number;
}

export interface ForwardOptions {
  entry?: "close" | "open"; // close: 当日終値で建て、open: 翌日始値で建て
  boot?: number;
}

// ============================================================
// 状態軸ビルダ
// ============================================================
export type StateAxis =
  | "rsi" | "vol" | "maDist" | "trend"
  | "rsi2" | "downStreak" | "pctFromHigh"
  | "candleRun"
  | "tsMom" | "dist52w" | "maAlign" | "momCrash"
  | "bbPercentB" | "prevRet"
  | "monthPhase" | "season" | "sqWeek" | "preHoliday";

export const STATE_AXES: { value: StateAxis; label: string }[] = [
  { value: "rsi", label: "RSI(14)帯" },
  { value: "vol", label: "ボラレジーム" },
  { value: "maDist", label: "200日線乖離" },
  { value: "trend", label: "トレンド状態" },
];

// 5.1/5.2/5.3 短期リバーサル用の状態軸
export const REVERSAL_AXES: { value: StateAxis; label: string }[] = [
  { value: "rsi2", label: "RSI(2)帯" },
  { value: "downStreak", label: "連続下落日数" },
  { value: "pctFromHigh", label: "直近高値からの下落" },
  { value: "bbPercentB", label: "ボリンジャー%b" },
  { value: "prevRet", label: "前日リターン分位" },
];

// 1.4 連続ローソク
export const CANDLE_RUN_AXES: { value: StateAxis; label: string }[] = [
  { value: "candleRun", label: "陽連/陰連の長さ" },
];

// 4.1/4.2/4.4/4.5 トレンド・モメンタム
export const TREND_AXES: { value: StateAxis; label: string }[] = [
  { value: "tsMom", label: "12-1ヶ月モメンタム" },
  { value: "dist52w", label: "52週高値からの距離" },
  { value: "maAlign", label: "移動平均配列" },
  { value: "momCrash", label: "モメンタム×ボラ(過熱)" },
];

// 10.1/10.4/10.2/10.3 カレンダー効果
export const CALENDAR_AXES: { value: StateAxis; label: string }[] = [
  { value: "monthPhase", label: "月末/月初(ターン)" },
  { value: "season", label: "季節(Sell in May)" },
  { value: "sqWeek", label: "SQ週" },
  { value: "preHoliday", label: "連休前後" },
];

export interface StateFn {
  stateOf: (i: number) => string | null;
  order: string[];
}

// --- 各種指標を価格 index に揃えて返す（未確定は NaN） ---
function wilderRSI(prices: PricePoint[], period: number): number[] {
  const n = prices.length;
  const out = new Array(n).fill(NaN);
  if (n < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i].close - prices[i - 1].close;
    avgGain += diff > 0 ? diff : 0;
    avgLoss += diff < 0 ? -diff : 0;
  }
  avgGain /= period; avgLoss /= period;
  out[period] = avgLoss > 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 100;
  for (let i = period + 1; i < n; i++) {
    const diff = prices[i].close - prices[i - 1].close;
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    out[i] = avgLoss > 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 100;
  }
  return out;
}

function trailingSMA(prices: PricePoint[], period: number): number[] {
  const n = prices.length;
  const out = new Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += prices[i].close;
    if (i >= period) sum -= prices[i - period].close;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// 直近 period 日の終値の標準偏差（ボリンジャーバンド用）
function trailingStd(prices: PricePoint[], period: number): number[] {
  const n = prices.length;
  const out = new Array(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += prices[j].close;
    const m = sum / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (prices[j].close - m) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

// 直近 window 日の対数リターン標準偏差（年率化しない素の日次σ）
function rollingRealizedVol(prices: PricePoint[], window: number): number[] {
  const n = prices.length;
  const lr = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    if (prices[i].close > 0 && prices[i - 1].close > 0) lr[i] = Math.log(prices[i].close / prices[i - 1].close);
  }
  const out = new Array(n).fill(NaN);
  for (let i = window; i < n; i++) {
    const seg: number[] = [];
    for (let j = i - window + 1; j <= i; j++) if (!isNaN(lr[j])) seg.push(lr[j]);
    if (seg.length >= window / 2) out[i] = std(seg);
  }
  return out;
}

// Kaufman効率比: |C[i]-C[i-w]| / Σ|ΔC|。トレンド純度(0=ノイズ,1=純トレンド)。
function efficiencyRatio(prices: PricePoint[], window: number): number[] {
  const n = prices.length;
  const out = new Array(n).fill(NaN);
  for (let i = window; i < n; i++) {
    const change = Math.abs(prices[i].close - prices[i - window].close);
    let vol = 0;
    for (let j = i - window + 1; j <= i; j++) vol += Math.abs(prices[j].close - prices[j - 1].close);
    out[i] = vol > 0 ? change / vol : 0;
  }
  return out;
}

// サンプルの3分位境界（NaN除外）
function terciles(vals: number[]): [number, number] {
  const v = vals.filter((x) => !isNaN(x)).sort((a, b) => a - b);
  if (v.length < 3) return [NaN, NaN];
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return [q(1 / 3), q(2 / 3)];
}

export function buildStateFn(prices: PricePoint[], axis: StateAxis): StateFn {
  if (axis === "rsi") {
    const rsi = wilderRSI(prices, 14);
    const order = ["売られ過ぎ(<30)", "やや弱(30-50)", "やや強(50-70)", "買われ過ぎ(>70)"];
    return {
      order,
      stateOf: (i) => {
        const r = rsi[i];
        if (isNaN(r)) return null;
        if (r < 30) return order[0];
        if (r < 50) return order[1];
        if (r < 70) return order[2];
        return order[3];
      },
    };
  }
  if (axis === "vol") {
    const rv = rollingRealizedVol(prices, 20);
    const [t1, t2] = terciles(rv);
    const order = ["低ボラ", "中ボラ", "高ボラ"];
    return {
      order,
      stateOf: (i) => {
        const v = rv[i];
        if (isNaN(v) || isNaN(t1)) return null;
        if (v < t1) return order[0];
        if (v < t2) return order[1];
        return order[2];
      },
    };
  }
  if (axis === "maDist") {
    const sma = trailingSMA(prices, 200);
    const order = ["大きく下(<-10%)", "やや下(-10〜0%)", "やや上(0〜+10%)", "大きく上(>+10%)"];
    return {
      order,
      stateOf: (i) => {
        const m = sma[i];
        if (isNaN(m) || m <= 0) return null;
        const d = (prices[i].close - m) / m;
        if (d < -0.1) return order[0];
        if (d < 0) return order[1];
        if (d < 0.1) return order[2];
        return order[3];
      },
    };
  }
  if (axis === "rsi2") {
    const rsi = wilderRSI(prices, 2);
    const order = ["極端売られ(<10)", "売られ(10-30)", "中立(30-70)", "買われ(70-90)", "極端買われ(>90)"];
    return {
      order,
      stateOf: (i) => {
        const r = rsi[i];
        if (isNaN(r)) return null;
        if (r < 10) return order[0];
        if (r < 30) return order[1];
        if (r < 70) return order[2];
        if (r < 90) return order[3];
        return order[4];
      },
    };
  }
  if (axis === "downStreak") {
    const order = ["4日以上連続安", "3日連続安", "2日連続安", "1日下落", "上昇/横ばい"];
    const streak = new Array(prices.length).fill(0);
    for (let i = 1; i < prices.length; i++) {
      streak[i] = prices[i].close < prices[i - 1].close ? streak[i - 1] + 1 : 0;
    }
    return {
      order,
      stateOf: (i) => {
        if (i < 1) return null;
        const s = streak[i];
        if (s >= 4) return order[0];
        if (s === 3) return order[1];
        if (s === 2) return order[2];
        if (s === 1) return order[3];
        return order[4];
      },
    };
  }
  if (axis === "pctFromHigh") {
    const order = ["大きく下(>-15%)", "やや下(-15〜-7%)", "小幅下(-7〜-2%)", "高値圏(0〜-2%)"];
    const win = 252;
    const rollMax = new Array(prices.length).fill(NaN);
    for (let i = 0; i < prices.length; i++) {
      let m = -Infinity;
      for (let j = Math.max(0, i - win + 1); j <= i; j++) m = Math.max(m, prices[j].close);
      if (i >= win - 1) rollMax[i] = m;
    }
    return {
      order,
      stateOf: (i) => {
        const m = rollMax[i];
        if (isNaN(m) || m <= 0) return null;
        const d = (prices[i].close - m) / m; // ≤0
        if (d <= -0.15) return order[0];
        if (d <= -0.07) return order[1];
        if (d <= -0.02) return order[2];
        return order[3];
      },
    };
  }
  if (axis === "candleRun") {
    const order = ["陰3連以上", "陰2連", "直近陰線", "直近陽線", "陽2連", "陽3連以上"];
    const bull = prices.map((p) => p.close > p.open);
    const streak = new Array(prices.length).fill(0); // 符号付き連続数
    for (let i = 0; i < prices.length; i++) {
      if (i === 0) { streak[i] = bull[i] ? 1 : -1; continue; }
      const dir = bull[i] ? 1 : -1;
      const prevDir = streak[i - 1] > 0 ? 1 : -1;
      streak[i] = dir === prevDir ? streak[i - 1] + dir : dir;
    }
    return {
      order,
      stateOf: (i) => {
        const s = streak[i];
        if (s <= -3) return order[0];
        if (s === -2) return order[1];
        if (s === -1) return order[2];
        if (s === 1) return order[3];
        if (s === 2) return order[4];
        return order[5];
      },
    };
  }
  if (axis === "tsMom") {
    const order = ["強い下降(<-10%)", "弱い下降(-10〜0%)", "弱い上昇(0〜+10%)", "強い上昇(>+10%)"];
    return {
      order,
      stateOf: (i) => {
        if (i < 252) return null;
        const m = prices[i - 21].close / prices[i - 252].close - 1; // 12-1ヶ月
        if (m < -0.1) return order[0];
        if (m < 0) return order[1];
        if (m < 0.1) return order[2];
        return order[3];
      },
    };
  }
  if (axis === "dist52w") {
    const order = ["高値圏(0〜-2%)", "やや下(-2〜-10%)", "中位(-10〜-25%)", "安値圏(<-25%)"];
    const win = 252;
    const rollMax = new Array(prices.length).fill(NaN);
    for (let i = 0; i < prices.length; i++) {
      let m = -Infinity;
      for (let j = Math.max(0, i - win + 1); j <= i; j++) m = Math.max(m, prices[j].high);
      if (i >= win - 1) rollMax[i] = m;
    }
    return {
      order,
      stateOf: (i) => {
        const m = rollMax[i];
        if (isNaN(m) || m <= 0) return null;
        const d = (prices[i].close - m) / m;
        if (d >= -0.02) return order[0];
        if (d >= -0.1) return order[1];
        if (d >= -0.25) return order[2];
        return order[3];
      },
    };
  }
  if (axis === "maAlign") {
    const order = ["完全弱気配列", "混在", "完全強気配列"];
    const s5 = trailingSMA(prices, 5), s25 = trailingSMA(prices, 25), s75 = trailingSMA(prices, 75);
    return {
      order,
      stateOf: (i) => {
        const a = s5[i], b = s25[i], c = s75[i];
        if (isNaN(a) || isNaN(b) || isNaN(c)) return null;
        if (a > b && b > c) return order[2];
        if (a < b && b < c) return order[0];
        return order[1];
      },
    };
  }
  if (axis === "momCrash") {
    const order = ["下落局面", "低ボラ上昇", "高ボラ上昇(過熱)"];
    const rv = rollingRealizedVol(prices, 20);
    const [, t2] = terciles(rv);
    return {
      order,
      stateOf: (i) => {
        if (i < 252 || isNaN(rv[i]) || isNaN(t2)) return null;
        const m = prices[i - 21].close / prices[i - 252].close - 1;
        if (m <= 0) return order[0];
        return rv[i] >= t2 ? order[2] : order[1];
      },
    };
  }
  if (axis === "bbPercentB") {
    const order = ["下限割れ(<0)", "下部(0-0.2)", "中央(0.2-0.8)", "上部(0.8-1)", "上限超え(>1)"];
    const sma = trailingSMA(prices, 20);
    const sd = trailingStd(prices, 20);
    return {
      order,
      stateOf: (i) => {
        if (isNaN(sma[i]) || isNaN(sd[i]) || sd[i] === 0) return null;
        const upper = sma[i] + 2 * sd[i], lower = sma[i] - 2 * sd[i];
        const pb = (prices[i].close - lower) / (upper - lower);
        if (pb < 0) return order[0];
        if (pb < 0.2) return order[1];
        if (pb < 0.8) return order[2];
        if (pb <= 1) return order[3];
        return order[4];
      },
    };
  }
  if (axis === "prevRet") {
    const order = ["前日下位(大幅安)", "前日中位", "前日上位(大幅高)"];
    const rets: number[] = [];
    for (let i = 1; i < prices.length; i++) if (prices[i - 1].close > 0) rets.push(prices[i].close / prices[i - 1].close - 1);
    const [t1, t2] = terciles(rets);
    return {
      order,
      stateOf: (i) => {
        if (i < 1 || prices[i - 1].close <= 0 || isNaN(t1)) return null;
        const r = prices[i].close / prices[i - 1].close - 1;
        if (r < t1) return order[0];
        if (r < t2) return order[1];
        return order[2];
      },
    };
  }
  if (axis === "monthPhase") {
    const order = ["月初(最初3営業日)", "月中", "月末(最後3営業日)"];
    const n2 = prices.length;
    const month = prices.map((p) => { const d = new Date(p.time); return d.getFullYear() * 12 + d.getMonth(); });
    const fromStart = new Array(n2).fill(99);
    const toEnd = new Array(n2).fill(99);
    let cnt = 0;
    for (let i = 0; i < n2; i++) { cnt = i > 0 && month[i] === month[i - 1] ? cnt + 1 : 0; fromStart[i] = cnt; }
    let cnt2 = 0;
    for (let i = n2 - 1; i >= 0; i--) { cnt2 = i < n2 - 1 && month[i] === month[i + 1] ? cnt2 + 1 : 0; toEnd[i] = cnt2; }
    return {
      order,
      stateOf: (i) => {
        if (toEnd[i] <= 2) return order[2];
        if (fromStart[i] <= 2) return order[0];
        return order[1];
      },
    };
  }
  if (axis === "season") {
    const order = ["5-10月(Sell in May)", "11-4月(Halloween)"];
    return {
      order,
      stateOf: (i) => {
        const m = new Date(prices[i].time).getMonth(); // 0..11
        return m >= 4 && m <= 9 ? order[0] : order[1];
      },
    };
  }
  if (axis === "sqWeek") {
    const order = ["通常週", "SQ週(第2金曜週)"];
    return {
      order,
      stateOf: (i) => {
        const dom = new Date(prices[i].time).getDate();
        return dom >= 8 && dom <= 14 ? order[1] : order[0];
      },
    };
  }
  if (axis === "preHoliday") {
    const order = ["連休明け", "通常日", "連休前"];
    const dayMs = 86400000;
    const t = prices.map((p) => new Date(p.time).getTime());
    return {
      order,
      stateOf: (i) => {
        const gapNext = i < prices.length - 1 ? (t[i + 1] - t[i]) / dayMs : 1;
        const gapPrev = i > 0 ? (t[i] - t[i - 1]) / dayMs : 1;
        if (gapNext >= 3) return order[2]; // 翌営業日まで3日以上＝連休前
        if (gapPrev >= 3) return order[0]; // 前営業日から3日以上＝連休明け
        return order[1];
      },
    };
  }
  // trend
  const er = efficiencyRatio(prices, 20);
  const order = ["強い下降", "弱トレンド(レンジ)", "強い上昇"];
  return {
    order,
    stateOf: (i) => {
      const e = er[i];
      if (isNaN(e) || i < 20) return null;
      if (e < 0.3) return order[1];
      const up = prices[i].close >= prices[i - 20].close;
      return up ? order[2] : order[0];
    },
  };
}

// ============================================================
// 9.2 2変数コンディショニング
// ============================================================
export interface TwoFactorCell {
  xLabel: string; yLabel: string; n: number; meanFwd: number; winRate: number;
}
export interface TwoFactorResult {
  cells: TwoFactorCell[];
  xOrder: string[]; yOrder: string[];
  nowX: string | null; nowY: string | null;
  maxAbs: number;
}

export function twoFactorForward(
  prices: PricePoint[],
  sx: StateFn,
  sy: StateFn,
  horizon: number
): TwoFactorResult {
  const n = prices.length;
  const map = new Map<string, number[]>();
  for (let i = 0; i <= n - horizon - 1; i++) {
    const lx = sx.stateOf(i), ly = sy.stateOf(i);
    if (lx === null || ly === null) continue;
    const entryPx = prices[i].close, exitPx = prices[i + horizon].close;
    if (!(entryPx > 0) || !(exitPx > 0)) continue;
    const r = (exitPx - entryPx) / entryPx;
    const key = `${lx}||${ly}`;
    const arr = map.get(key) ?? [];
    arr.push(r);
    map.set(key, arr);
  }
  const cells: TwoFactorCell[] = [];
  let maxAbs = 1e-9;
  for (const xLabel of sx.order) for (const yLabel of sy.order) {
    const arr = map.get(`${xLabel}||${yLabel}`);
    if (!arr || arr.length === 0) continue;
    const m = mean(arr);
    maxAbs = Math.max(maxAbs, Math.abs(m));
    cells.push({ xLabel, yLabel, n: arr.length, meanFwd: m, winRate: arr.filter((r) => r > 0).length / arr.length });
  }
  const lastLabel = (s: StateFn) => {
    for (let i = n - 1; i >= 0; i--) { const l = s.stateOf(i); if (l !== null) return l; }
    return null;
  };
  return { cells, xOrder: sx.order, yOrder: sy.order, nowX: lastLabel(sx), nowY: lastLabel(sy), maxAbs };
}

// ============================================================
// 状態軸 × フォワードリターンビン（任意ビン）
// 「ある状態のとき、その先N日リターンがどの帯に偏るか」を行=状態・列=リターンビンで集計。
// 単なる平均より分布の形（裾の厚さ・偏り）が見える。ビンは固定幅 or 等頻度分位を選べる。
// ============================================================
export type BinMode = "step" | "quantile";
export interface BinConfig {
  mode: BinMode;
  stepPct?: number;   // step: ビン幅(%)。例 1 → 1%刻み
  maxAbsPct?: number; // step: 中央から±この範囲まで等幅。外側は「以下/以上」のまとめビン
  bins?: number;      // quantile: 等頻度分割数
}

export interface ReturnBinRow {
  label: string;
  n: number;
  counts: number[]; // 各ビンの度数
  freqs: number[];  // counts / n（行内で正規化＝その状態の中での割合）
  meanFwd: number;
  winRate: number;
  isBaseline?: boolean;
}

export interface ReturnBinResult {
  binLabels: string[];
  binEdges: number[];     // 長さ binLabels.length + 1（端は ±Infinity）
  binSigns: number[];     // 各ビンの代表符号（色付け用 -1/0/+1）
  rows: ReturnBinRow[];   // present な状態 + 末尾に baseline（全標本）
  nowLabel: string | null;
  horizon: number;
  totalN: number;
  maxFreq: number;        // 色スケール用（行正規化頻度の最大）
}

function fmtEdgePct(v: number): string {
  const x = v * 100;
  const s = Math.abs(x % 1) < 1e-9 ? x.toFixed(0) : x.toFixed(1);
  return `${x >= 0 ? "+" : ""}${s}%`;
}

export function stateByReturnBin(
  prices: PricePoint[],
  state: StateFn,
  horizon: number,
  bin: BinConfig,
  opts: ForwardOptions = {}
): ReturnBinResult {
  const entry = opts.entry ?? "close";
  const n = prices.length;
  const lastUsable = entry === "close" ? n - horizon - 1 : n - horizon - 2;

  const samples: { label: string; r: number }[] = [];
  const allRets: number[] = [];
  for (let i = 0; i <= lastUsable; i++) {
    const label = state.stateOf(i);
    if (label === null) continue;
    let entryPx: number, exitPx: number;
    if (entry === "close") {
      entryPx = prices[i].close;
      exitPx = prices[i + horizon].close;
    } else {
      entryPx = prices[i + 1].open;
      exitPx = prices[i + 1 + horizon].open;
    }
    if (!(entryPx > 0) || !(exitPx > 0)) continue;
    const r = (exitPx - entryPx) / entryPx;
    samples.push({ label, r });
    allRets.push(r);
  }

  // --- ビン境界の構築 ---
  let edges: number[];
  if (bin.mode === "quantile") {
    const k = Math.max(2, Math.min(12, Math.round(bin.bins ?? 5)));
    const sorted = [...allRets].sort((a, b) => a - b);
    edges = [-Infinity];
    for (let j = 1; j < k; j++) {
      const idx = Math.min(sorted.length - 1, Math.floor((j / k) * sorted.length));
      edges.push(sorted.length ? sorted[idx] : 0);
    }
    edges.push(Infinity);
  } else {
    const step = Math.max(0.0005, (bin.stepPct ?? 1) / 100);
    const maxAbs = Math.max(step, (bin.maxAbsPct ?? 5) / 100);
    const startK = Math.max(1, Math.round(maxAbs / step));
    edges = [-Infinity];
    for (let k = -startK; k <= startK; k++) edges.push(Math.round(k * step * 1e8) / 1e8);
    edges.push(Infinity);
  }

  const binCount = edges.length - 1;
  const binLabels: string[] = [];
  const binSigns: number[] = [];
  for (let j = 0; j < binCount; j++) {
    const lo = edges[j], hi = edges[j + 1];
    if (lo === -Infinity) { binLabels.push(`< ${fmtEdgePct(hi)}`); binSigns.push(-1); }
    else if (hi === Infinity) { binLabels.push(`≥ ${fmtEdgePct(lo)}`); binSigns.push(1); }
    else {
      binLabels.push(`${fmtEdgePct(lo)}〜${fmtEdgePct(hi)}`);
      const mid = (lo + hi) / 2;
      binSigns.push(mid > 1e-9 ? 1 : mid < -1e-9 ? -1 : 0);
    }
  }

  const binOf = (r: number): number => {
    for (let j = 0; j < binCount; j++) if (r >= edges[j] && r < edges[j + 1]) return j;
    return binCount - 1;
  };

  // --- 状態別に集計 ---
  const grouped = new Map<string, { counts: number[]; rets: number[] }>();
  for (const s of samples) {
    let g = grouped.get(s.label);
    if (!g) { g = { counts: new Array(binCount).fill(0), rets: [] }; grouped.set(s.label, g); }
    g.counts[binOf(s.r)]++;
    g.rets.push(s.r);
  }

  const present = state.order.filter((o) => grouped.has(o));
  let maxFreq = 1e-9;
  const rows: ReturnBinRow[] = present.map((label) => {
    const g = grouped.get(label)!;
    const nn = g.rets.length;
    const freqs = g.counts.map((c) => (nn > 0 ? c / nn : 0));
    maxFreq = Math.max(maxFreq, ...freqs);
    return {
      label,
      n: nn,
      counts: g.counts,
      freqs,
      meanFwd: mean(g.rets),
      winRate: nn > 0 ? g.rets.filter((r) => r > 0).length / nn : 0,
    };
  });

  // baseline（全標本）行
  const baseCounts = new Array(binCount).fill(0);
  for (const s of samples) baseCounts[binOf(s.r)]++;
  const baseFreqs = baseCounts.map((c) => (allRets.length ? c / allRets.length : 0));
  rows.push({
    label: "全体（基準）",
    n: allRets.length,
    counts: baseCounts,
    freqs: baseFreqs,
    meanFwd: mean(allRets),
    winRate: allRets.length ? allRets.filter((r) => r > 0).length / allRets.length : 0,
    isBaseline: true,
  });

  let nowLabel: string | null = null;
  for (let i = n - 1; i >= 0; i--) {
    const l = state.stateOf(i);
    if (l !== null) { nowLabel = l; break; }
  }

  return { binLabels, binEdges: edges, binSigns, rows, nowLabel, horizon, totalN: allRets.length, maxFreq };
}

// ============================================================
// 集計本体
// ============================================================
export function conditionalForwardReturns(
  prices: PricePoint[],
  state: StateFn,
  horizon: number,
  opts: ForwardOptions = {}
): ForwardResult {
  const entry = opts.entry ?? "close";
  const boot = opts.boot ?? 600;
  const n = prices.length;

  // entry/exit index の決定。close: entry=C[i], exit=C[i+N]。open: entry=O[i+1], exit=O[i+1+N]。
  const grouped = new Map<string, { rets: number[]; years: number[] }>();
  const allRets: number[] = [];

  const lastUsable = entry === "close" ? n - horizon - 1 : n - horizon - 2;
  for (let i = 0; i <= lastUsable; i++) {
    const label = state.stateOf(i);
    if (label === null) continue;
    let entryPx: number, exitPx: number, exitTime: string;
    if (entry === "close") {
      entryPx = prices[i].close;
      exitPx = prices[i + horizon].close;
      exitTime = prices[i + horizon].time;
    } else {
      entryPx = prices[i + 1].open;
      exitPx = prices[i + 1 + horizon].open;
      exitTime = prices[i + 1 + horizon].time;
    }
    if (!(entryPx > 0) || !(exitPx > 0)) continue;
    const r = (exitPx - entryPx) / entryPx;
    let g = grouped.get(label);
    if (!g) { g = { rets: [], years: [] }; grouped.set(label, g); }
    g.rets.push(r);
    g.years.push(new Date(exitTime).getFullYear());
    allRets.push(r);
  }

  // t検定 → FDR
  const present = state.order.filter((o) => grouped.has(o));
  const pRaw = present.map((o) => {
    const t = tTest(grouped.get(o)!.rets);
    return t ? t.p : 1;
  });
  const pAdj = benjaminiHochberg(pRaw);

  const buckets: ForwardStats[] = present.map((label, k) => {
    const g = grouped.get(label)!;
    const ci = blockBootstrapCI(g.rets, boot);
    const m = mean(g.rets);
    // 年次
    const byYearMap = new Map<number, number[]>();
    g.years.forEach((y, idx) => {
      const arr = byYearMap.get(y) ?? [];
      arr.push(g.rets[idx]);
      byYearMap.set(y, arr);
    });
    const byYear = [...byYearMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, arr]) => ({ year, meanFwd: mean(arr), n: arr.length }));
    return {
      label,
      n: g.rets.length,
      meanFwd: m,
      medianFwd: median(g.rets),
      winRate: g.rets.filter((r) => r > 0).length / g.rets.length,
      stdFwd: std(g.rets),
      ciLow: ci ? ci.lo : m,
      ciHigh: ci ? ci.hi : m,
      p: pAdj[k],
      significant: pAdj[k] < 0.05,
      byYear,
    };
  });

  // 今日（最新の確定状態）
  let nowLabel: string | null = null;
  for (let i = n - 1; i >= 0; i--) {
    const l = state.stateOf(i);
    if (l !== null) { nowLabel = l; break; }
  }

  return {
    buckets,
    order: present,
    horizon,
    nowLabel,
    baselineMean: mean(allRets),
    baselineWin: allRets.length ? allRets.filter((r) => r > 0).length / allRets.length : 0,
    totalN: allRets.length,
  };
}
