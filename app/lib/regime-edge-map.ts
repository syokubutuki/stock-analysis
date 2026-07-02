// B. レジーム別エッジマップ。
// 共通シグナルカタログ(edge-signals)の各シグナルが、市場のどの局面(レジーム)でだけ
// 有効かを一望する。エッジ × レジームの格子で平均日次エッジ・シャープ・有意性を集計し、
// 「今の局面で有効なエッジ」を現在レジーム列で強調する。
//
// レジームは全て i 日終値時点で確定する因果的分類(HMMのみ全標本フィット=記述的)。

import { PricePoint } from "./types";
import { mean, std, tTest, benjaminiHochberg } from "./stats-significance";
import { buildSignalCatalog, type EdgeSignal } from "./edge-signals";
import { fitHMM } from "./regime";

export type RegimeScheme = "vol" | "trend" | "drawdown" | "hmm";

export const REGIME_SCHEMES: { value: RegimeScheme; label: string }[] = [
  { value: "vol", label: "ボラ局面(3分位)" },
  { value: "trend", label: "トレンド局面(200日線)" },
  { value: "drawdown", label: "ドローダウン局面" },
  { value: "hmm", label: "HMM 3状態" },
];

interface RegimeClassifier {
  order: string[];
  regimeOf: (i: number) => string | null;
}

const TRADING_DAYS = 252;

function sma(prices: PricePoint[], period: number): number[] {
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

function rollingRealizedVol(prices: PricePoint[], window: number): number[] {
  const n = prices.length;
  const lr = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) if (prices[i].close > 0 && prices[i - 1].close > 0) lr[i] = Math.log(prices[i].close / prices[i - 1].close);
  const out = new Array(n).fill(NaN);
  for (let i = window; i < n; i++) {
    const seg: number[] = [];
    for (let j = i - window + 1; j <= i; j++) if (!isNaN(lr[j])) seg.push(lr[j]);
    if (seg.length >= window / 2) out[i] = std(seg);
  }
  return out;
}

function tercileThresholds(vals: number[]): [number, number] {
  const v = vals.filter((x) => isFinite(x)).sort((a, b) => a - b);
  if (v.length < 3) return [NaN, NaN];
  return [v[Math.floor(v.length / 3)], v[Math.floor((2 * v.length) / 3)]];
}

function buildClassifier(prices: PricePoint[], scheme: RegimeScheme): RegimeClassifier {
  const n = prices.length;
  if (scheme === "vol") {
    const rv = rollingRealizedVol(prices, 20);
    const [t1, t2] = tercileThresholds(rv);
    const order = ["低ボラ", "中ボラ", "高ボラ"];
    return {
      order,
      regimeOf: (i) => {
        const v = rv[i];
        if (isNaN(v)) return null;
        return v < t1 ? order[0] : v < t2 ? order[1] : order[2];
      },
    };
  }
  if (scheme === "trend") {
    const s200 = sma(prices, 200);
    const order = ["上昇", "レンジ", "下降"];
    return {
      order,
      regimeOf: (i) => {
        if (isNaN(s200[i]) || s200[i] <= 0) return null;
        const d = (prices[i].close - s200[i]) / s200[i];
        return d > 0.03 ? order[0] : d < -0.03 ? order[2] : order[1];
      },
    };
  }
  if (scheme === "drawdown") {
    const order = ["平時", "調整", "暴落"];
    const peak = new Array(n).fill(0);
    let p = -Infinity;
    for (let i = 0; i < n; i++) { p = Math.max(p, prices[i].close); peak[i] = p; }
    return {
      order,
      regimeOf: (i) => {
        if (!(peak[i] > 0)) return null;
        const dd = prices[i].close / peak[i] - 1;
        return dd > -0.05 ? order[0] : dd > -0.15 ? order[1] : order[2];
      },
    };
  }
  // hmm: 全標本フィット(記述的)。返り値のstateを平均リターン順に 弱気/中立/強気 へ写像。
  const rets: number[] = [];
  for (let i = 1; i < n; i++) rets.push(prices[i - 1].close > 0 ? prices[i].close / prices[i - 1].close - 1 : 0);
  const order = ["弱気", "中立", "強気"];
  let stateName: (s: number) => string = () => "中立";
  let states: number[] = [];
  try {
    const hmm = fitHMM(rets, 3);
    states = hmm.states;
    const rank = hmm.stateMeans
      .map((m, idx) => ({ m, idx }))
      .sort((a, b) => a.m - b.m)
      .map((x) => x.idx);
    const nameByState = new Map<number, string>();
    nameByState.set(rank[0], order[0]);
    nameByState.set(rank[1], order[1]);
    nameByState.set(rank[2], order[2]);
    stateName = (s) => nameByState.get(s) ?? "中立";
  } catch {
    // フィット失敗時は全て中立
  }
  return {
    order,
    // rets[i-1] が price index i の当日リターン → states[i-1]
    regimeOf: (i) => (i >= 1 && i - 1 < states.length ? stateName(states[i - 1]) : null),
  };
}

export interface RegimeEdgeCell {
  n: number;
  meanRet: number;      // 平均日次エッジ(建玉調整後・コスト無し)
  winRate: number;
  sharpe: number;       // 年率シャープ
  annualized: number;
  p: number;
  pAdj: number;
}

export interface RegimeEdgeRow {
  edge: EdgeSignal;
  overall: RegimeEdgeCell | null;          // 全局面
  byRegime: (RegimeEdgeCell | null)[];     // regimeOrder に対応
}

export interface RegimeEdgeMap {
  regimeOrder: string[];
  regimeCounts: number[];   // 各レジームの日数
  nowRegime: string | null;
  rows: RegimeEdgeRow[];
  scheme: RegimeScheme;
}

function cellStats(rets: number[]): Omit<RegimeEdgeCell, "pAdj"> | null {
  if (rets.length < 5) return null;
  const m = mean(rets);
  const s = std(rets);
  const tt = tTest(rets);
  return {
    n: rets.length,
    meanRet: m,
    winRate: rets.filter((r) => r > 0).length / rets.length,
    sharpe: s > 0 ? (m / s) * Math.sqrt(TRADING_DAYS) : 0,
    annualized: m * TRADING_DAYS,
    p: tt ? tt.p : 1,
  };
}

export function buildRegimeEdgeMap(prices: PricePoint[], scheme: RegimeScheme): RegimeEdgeMap {
  const n = prices.length;
  const cls = buildClassifier(prices, scheme);
  const signals = buildSignalCatalog(prices);

  // レジーム日数
  const regimeCounts = cls.order.map(() => 0);
  for (let i = 0; i < n; i++) {
    const r = cls.regimeOf(i);
    if (r === null) continue;
    const idx = cls.order.indexOf(r);
    if (idx >= 0) regimeCounts[idx]++;
  }

  // 各シグナル×レジームの活性日リターンを収集
  interface Raw { overall: number[]; byRegime: number[][]; }
  const raws: Raw[] = signals.map(() => ({ overall: [], byRegime: cls.order.map(() => []) }));

  for (let i = 0; i < n - 1; i++) {
    const c0 = prices[i].close, c1 = prices[i + 1].close;
    if (!(c0 > 0) || !(c1 > 0)) continue;
    const nextRet = c1 / c0 - 1;
    const reg = cls.regimeOf(i);
    const regIdx = reg === null ? -1 : cls.order.indexOf(reg);
    for (let s = 0; s < signals.length; s++) {
      const pos = signals[s].positionOf(i);
      if (pos === 0) continue;
      const dayRet = pos * nextRet;
      raws[s].overall.push(dayRet);
      if (regIdx >= 0) raws[s].byRegime[regIdx].push(dayRet);
    }
  }

  // FDR は「レジーム別セル」全体を母数に補正(overall列は補正対象外の参考値)
  const flatP: number[] = [];
  const cellCache: (Omit<RegimeEdgeCell, "pAdj"> | null)[][] = raws.map((raw) =>
    raw.byRegime.map((arr) => {
      const st = cellStats(arr);
      if (st) flatP.push(st.p);
      return st;
    }),
  );
  const flatAdj = benjaminiHochberg(flatP);

  let padjCursor = 0;
  const rows: RegimeEdgeRow[] = signals.map((edge, s) => {
    const overallSt = cellStats(raws[s].overall);
    const byRegime = cellCache[s].map((st) => {
      if (!st) return null;
      const cell: RegimeEdgeCell = { ...st, pAdj: flatAdj[padjCursor++] };
      return cell;
    });
    return {
      edge,
      overall: overallSt ? { ...overallSt, pAdj: overallSt.p } : null,
      byRegime,
    };
  });

  let nowRegime: string | null = null;
  for (let i = n - 1; i >= 0; i--) { const r = cls.regimeOf(i); if (r !== null) { nowRegime = r; break; } }

  return { regimeOrder: cls.order, regimeCounts, nowRegime, rows, scheme };
}
