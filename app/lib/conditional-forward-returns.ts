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
  | "rsi2" | "downStreak" | "pctFromHigh";

export const STATE_AXES: { value: StateAxis; label: string }[] = [
  { value: "rsi", label: "RSI(14)帯" },
  { value: "vol", label: "ボラレジーム" },
  { value: "maDist", label: "200日線乖離" },
  { value: "trend", label: "トレンド状態" },
];

// 5.1 短期リバーサル用の状態軸
export const REVERSAL_AXES: { value: StateAxis; label: string }[] = [
  { value: "rsi2", label: "RSI(2)帯" },
  { value: "downStreak", label: "連続下落日数" },
  { value: "pctFromHigh", label: "直近高値からの下落" },
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
