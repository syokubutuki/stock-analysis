// 曜日トレード・シミュレータの計算ロジック
// 任意の曜日 × 注文タイミング(始値/終値)で売買した場合の累積リターンを算出し、
// バイ&ホールドと比較するための純粋関数群。
import { PricePoint } from "./types";

export type Timing = "open" | "close";
export type Side = "long" | "short";

export interface TradeSpec {
  entryDow: number; // 1=月 .. 5=金 (Date.getDay() と同じ)
  entryTiming: Timing;
  exitDow: number;
  exitTiming: Timing;
  side: Side;
}

interface DayPt {
  t: number; // 時刻(ms)
  dow: number;
  open: number;
  close: number;
}

function toDayPts(prices: PricePoint[]): DayPt[] {
  return prices.map((p) => {
    const d = new Date(p.time);
    return { t: d.getTime(), dow: d.getDay(), open: p.open, close: p.close };
  });
}

export interface Trade {
  entryIdx: number;
  exitIdx: number;
  entryT: number;
  exitT: number;
  ret: number; // side適用後の符号付きリターン
}

// イベント順序(ordinal): 各営業日に対し始値=2*i, 終値=2*i+1。
// これにより「同日内で始値→終値」「翌週まで持ち越し」を一貫して判定する。
export function runStrategyTrades(prices: PricePoint[], spec: TradeSpec): Trade[] {
  const pts = toDayPts(prices);
  const n = pts.length;
  const trades: Trade[] = [];
  let i = 0;
  while (i < n) {
    if (pts[i].dow !== spec.entryDow) {
      i++;
      continue;
    }
    const entryOrd = 2 * i + (spec.entryTiming === "open" ? 0 : 1);
    const entryPrice = spec.entryTiming === "open" ? pts[i].open : pts[i].close;
    let exitIdx = -1;
    let exitPrice = 0;
    for (let j = i; j < n; j++) {
      if (pts[j].dow !== spec.exitDow) continue;
      const exitOrd = 2 * j + (spec.exitTiming === "open" ? 0 : 1);
      if (exitOrd > entryOrd) {
        exitIdx = j;
        exitPrice = spec.exitTiming === "open" ? pts[j].open : pts[j].close;
        break;
      }
    }
    if (exitIdx < 0) break; // これ以上トレード成立せず
    if (entryPrice > 0 && exitPrice > 0) {
      const rLong = exitPrice / entryPrice - 1;
      const ret = spec.side === "long" ? rLong : -rLong;
      trades.push({ entryIdx: i, exitIdx, entryT: pts[i].t, exitT: pts[exitIdx].t, ret });
    }
    i = exitIdx + 1; // ポジション解消後の翌日から次のエントリーを探索
  }
  return trades;
}

export interface EquityPoint {
  t: number;
  v: number;
}

export interface StrategyResult {
  trades: Trade[];
  equity: EquityPoint[]; // v = 累積リターン(0始まり)
  totalReturn: number;
  nTrades: number;
  winRate: number;
  avgTrade: number;
  stdTrade: number;
  sharpe: number; // トレード単位Sharpeを年率化
  maxDD: number; // 負の値
  exposure: number; // 市場滞在率(0..1)
  annualized: number;
}

export function computeStrategy(prices: PricePoint[], spec: TradeSpec, compound: boolean): StrategyResult {
  const trades = runStrategyTrades(prices, spec);
  const equity: EquityPoint[] = [];
  let cum = 1;
  let sum = 0;
  if (trades.length > 0) equity.push({ t: trades[0].entryT, v: 0 });
  for (const tr of trades) {
    if (compound) {
      cum *= 1 + tr.ret;
      equity.push({ t: tr.exitT, v: cum - 1 });
    } else {
      sum += tr.ret;
      equity.push({ t: tr.exitT, v: sum });
    }
  }
  const rets = trades.map((t) => t.ret);
  const total = equity.length ? equity[equity.length - 1].v : 0;
  const nTrades = trades.length;
  const wins = rets.filter((r) => r > 0).length;
  const avg = rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : 0;
  const variance = rets.length > 1 ? rets.reduce((s, v) => s + (v - avg) ** 2, 0) / (rets.length - 1) : 0;
  const sd = Math.sqrt(variance);

  const totalDays = prices.length;
  const years = totalDays / 252 || 1;
  const tradesPerYear = nTrades / years;
  const sharpe = sd > 0 ? (avg / sd) * Math.sqrt(tradesPerYear) : 0;

  let held = 0;
  for (const tr of trades) held += tr.exitIdx - tr.entryIdx + 1;
  const exposure = totalDays ? Math.min(1, held / totalDays) : 0;

  let peak = -Infinity;
  let maxDD = 0;
  for (const e of equity) {
    const w = 1 + e.v; // 富(wealth)に換算してDDを測る
    peak = Math.max(peak, w);
    const dd = (w - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  const annualized = compound ? Math.pow(1 + total, 1 / years) - 1 : total / years;
  return {
    trades,
    equity,
    totalReturn: total,
    nTrades,
    winRate: nTrades ? wins / nTrades : 0,
    avgTrade: avg,
    stdTrade: sd,
    sharpe,
    maxDD,
    exposure,
    annualized,
  };
}

export function buyHoldEquity(prices: PricePoint[], compound: boolean): EquityPoint[] {
  if (prices.length < 1) return [];
  const out: EquityPoint[] = [];
  const c0 = prices[0].close || 1;
  let sum = 0;
  for (let i = 0; i < prices.length; i++) {
    const t = new Date(prices[i].time).getTime();
    if (compound) {
      out.push({ t, v: prices[i].close / c0 - 1 });
    } else {
      if (i > 0) sum += (prices[i].close - prices[i - 1].close) / (prices[i - 1].close || 1);
      out.push({ t, v: sum });
    }
  }
  return out;
}

export interface BHMetrics {
  totalReturn: number;
  annualized: number;
  maxDD: number;
  sharpe: number;
}

export function buyHoldMetrics(prices: PricePoint[], compound: boolean): BHMetrics {
  const eq = buyHoldEquity(prices, compound);
  const total = eq.length ? eq[eq.length - 1].v : 0;
  const years = prices.length / 252 || 1;
  const annualized = compound ? Math.pow(1 + total, 1 / years) - 1 : total / years;
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) rets.push((prices[i].close - prices[i - 1].close) / (prices[i - 1].close || 1));
  const avg = rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, v) => s + (v - avg) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = sd > 0 ? (avg / sd) * Math.sqrt(252) : 0;
  let peak = -Infinity;
  let maxDD = 0;
  for (const e of eq) {
    const w = 1 + e.v;
    peak = Math.max(peak, w);
    const dd = (w - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return { totalReturn: total, annualized, maxDD, sharpe };
}

export type MatrixMetric = "total" | "sharpe" | "winRate";

// 全25通り(エントリー曜日 × エグジット曜日)の指標グリッド。row=エントリー, col=エグジット (0=月..4=金)
export function weekdayMatrix(
  prices: PricePoint[],
  entryTiming: Timing,
  exitTiming: Timing,
  side: Side,
  compound: boolean,
  metric: MatrixMetric,
): (number | null)[][] {
  const grid: (number | null)[][] = [];
  for (let e = 1; e <= 5; e++) {
    const row: (number | null)[] = [];
    for (let x = 1; x <= 5; x++) {
      const res = computeStrategy(prices, { entryDow: e, entryTiming, exitDow: x, exitTiming, side }, compound);
      if (res.nTrades < 3) {
        row.push(null);
        continue;
      }
      row.push(metric === "total" ? res.totalReturn : metric === "sharpe" ? res.sharpe : res.winRate);
    }
    grid.push(row);
  }
  return grid;
}
