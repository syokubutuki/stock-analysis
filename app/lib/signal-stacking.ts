// D. シグナル合成。
// 共通カタログのシグナルを束ねて、単独より良いポートフォリオになるかを測る。
// 相関の低いエッジを組み合わせるとシャープが上がる(分散効果)。3方式:
//   equal      … 等加重(建玉を平均)
//   invvar     … 逆分散加重(ボラの低いシグナルを厚く)
//   agreement  … k-of-n 合意時のみフル建て(多数決フィルタ)
//
// 先読みバイアス回避: 各シグナルは i 日終値で確定、リターンは翌足で実現。

import { PricePoint } from "./types";
import { mean, std } from "./stats-significance";
import { buildSignalCatalog, type EdgeSignal } from "./edge-signals";

const TRADING_DAYS = 252;

export type StackScheme = "equal" | "invvar" | "agreement";

export const STACK_SCHEMES: { value: StackScheme; label: string }[] = [
  { value: "equal", label: "等加重" },
  { value: "invvar", label: "逆分散加重" },
  { value: "agreement", label: "k-of-n 合意" },
];

// 連続建玉に対応したコスト付きリターン列
function comboReturns(prices: PricePoint[], posOf: (i: number) => number, costBps: number) {
  const n = prices.length;
  const cost = costBps / 1e4;
  const rets: number[] = [];
  const dates: string[] = [];
  const equity: number[] = [1];
  let prev = 0, nonZero = 0;
  for (let i = 0; i < n - 1; i++) {
    const c0 = prices[i].close, c1 = prices[i + 1].close;
    if (!(c0 > 0) || !(c1 > 0)) { prev = posOf(i); continue; }
    const nextRet = c1 / c0 - 1;
    const pos = posOf(i);
    const r = pos * nextRet - cost * Math.abs(pos - prev);
    rets.push(r);
    dates.push(prices[i + 1].time);
    equity.push(equity[equity.length - 1] * (1 + r));
    if (Math.abs(pos) > 1e-9) nonZero++;
    prev = pos;
  }
  return { rets, dates, equity, exposure: rets.length ? nonZero / rets.length : 0 };
}

function sharpeAnn(rets: number[]): number {
  const s = std(rets);
  return s > 0 ? (mean(rets) / s) * Math.sqrt(TRADING_DAYS) : 0;
}
function maxDrawdown(equity: number[]): number {
  let peak = -Infinity, mdd = 0;
  for (const v of equity) { peak = Math.max(peak, v); if (peak > 0) mdd = Math.min(mdd, v / peak - 1); }
  return mdd;
}
function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a), mb = mean(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

export interface StackPerSignal {
  id: string; label: string;
  sharpe: number;        // 年率(単独)
  annReturn: number;
  weight: number;        // 合成での加重
  looDelta: number;      // このシグナルを外すと合成シャープがどれだけ下がるか(正=貢献)
}

export interface StackResult {
  ids: string[];
  labels: string[];
  scheme: StackScheme;
  corr: number[][];
  perSignal: StackPerSignal[];
  combinedEquity: { date: string; value: number }[];
  combinedSharpe: number;
  combinedAnnReturn: number;
  combinedMaxDD: number;
  combinedExposure: number;
  bestSingleSharpe: number;
  equalSharpe: number;         // 参照: 等加重のシャープ
  diversification: number;     // 分散化比率
  agreeK: number;
}

export interface StackOptions {
  ids: string[];
  scheme?: StackScheme;
  agreeK?: number;
  costBps?: number;
}

// 指定方式の合成建玉関数を返す
function makePosOf(signals: EdgeSignal[], weights: number[], scheme: StackScheme, agreeK: number): (i: number) => number {
  if (scheme === "agreement") {
    return (i) => {
      let pos = 0, neg = 0;
      for (const s of signals) { const p = s.positionOf(i); if (p > 0) pos++; else if (p < 0) neg++; }
      if (pos >= agreeK && pos >= neg) return 1;
      if (neg >= agreeK && neg > pos) return -1;
      return 0;
    };
  }
  return (i) => {
    let acc = 0;
    for (let s = 0; s < signals.length; s++) acc += weights[s] * signals[s].positionOf(i);
    return acc;
  };
}

export function stackSignals(prices: PricePoint[], opts: StackOptions): StackResult | null {
  const scheme: StackScheme = opts.scheme ?? "equal";
  const costBps = opts.costBps ?? 5;
  const catalog = buildSignalCatalog(prices);
  const signals = opts.ids.map((id) => catalog.find((s) => s.id === id)).filter((s): s is EdgeSignal => !!s);
  if (signals.length < 1) return null;
  const agreeK = Math.max(1, Math.min(signals.length, opts.agreeK ?? Math.ceil(signals.length / 2)));

  // 各シグナルの単独net rets(相関・単独指標用)
  const singleRets = signals.map((s) => comboReturns(prices, (i) => s.positionOf(i), costBps).rets);
  const vars = singleRets.map((r) => Math.max(1e-10, std(r) ** 2));

  // 加重
  let weights: number[];
  if (scheme === "invvar") {
    const inv = vars.map((v) => 1 / v);
    const sum = inv.reduce((a, b) => a + b, 0);
    weights = inv.map((w) => w / sum);
  } else {
    weights = signals.map(() => 1 / signals.length); // equal / agreement(表示用)
  }

  // 相関行列
  const corr = signals.map((_, a) => signals.map((_, b) => (a === b ? 1 : correlation(singleRets[a], singleRets[b]))));

  // 合成
  const posOf = makePosOf(signals, weights, scheme, agreeK);
  const combo = comboReturns(prices, posOf, costBps);
  const combinedSharpe = sharpeAnn(combo.rets);

  // 参照: 等加重
  const equalPos = makePosOf(signals, signals.map(() => 1 / signals.length), "equal", agreeK);
  const equalCombo = comboReturns(prices, equalPos, costBps);
  const equalSharpe = sharpeAnn(equalCombo.rets);

  // 分散化比率 = Σ wσ / σ_portfolio(合成に用いた加重で)
  const wForDiv = scheme === "agreement" ? signals.map(() => 1 / signals.length) : weights;
  const weightedVolSum = signals.reduce((acc, _, s) => acc + wForDiv[s] * std(singleRets[s]), 0);
  const portVol = std(combo.rets);
  const diversification = portVol > 0 ? weightedVolSum / portVol : 1;

  // Leave-One-Out 貢献
  const perSignal: StackPerSignal[] = signals.map((s, idx) => {
    const rest = signals.filter((_, j) => j !== idx);
    let looSharpe = 0;
    if (rest.length >= 1) {
      let w2: number[];
      if (scheme === "invvar") {
        const inv = rest.map((r2) => 1 / Math.max(1e-10, std(comboReturns(prices, (i) => r2.positionOf(i), costBps).rets) ** 2));
        const sum = inv.reduce((a, b) => a + b, 0);
        w2 = inv.map((w) => w / sum);
      } else w2 = rest.map(() => 1 / rest.length);
      const k2 = Math.max(1, Math.min(rest.length, agreeK));
      const looCombo = comboReturns(prices, makePosOf(rest, w2, scheme, k2), costBps);
      looSharpe = sharpeAnn(looCombo.rets);
    }
    return {
      id: s.id, label: s.label,
      sharpe: sharpeAnn(singleRets[idx]),
      annReturn: mean(singleRets[idx]) * TRADING_DAYS,
      weight: weights[idx],
      looDelta: combinedSharpe - looSharpe,
    };
  });

  const bestSingleSharpe = Math.max(...perSignal.map((p) => p.sharpe));

  return {
    ids: signals.map((s) => s.id),
    labels: signals.map((s) => s.label),
    scheme,
    corr,
    perSignal,
    combinedEquity: combo.dates.map((d, i) => ({ date: d, value: combo.equity[i + 1] })),
    combinedSharpe,
    combinedAnnReturn: mean(combo.rets) * TRADING_DAYS,
    combinedMaxDD: maxDrawdown(combo.equity),
    combinedExposure: combo.exposure,
    bestSingleSharpe,
    equalSharpe,
    diversification,
    agreeK,
  };
}
