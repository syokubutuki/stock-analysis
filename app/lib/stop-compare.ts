// 判定の実績化 — フェーズ2: 損切り警告 vs 機械ストップの出口ルール比較
//
// 「悪化シグナルでの手仕舞い」が、単純な機械ストップより早く・浅く出られるか
// (=損切りの遅れを改善できるか)を中立な実験フレームで比較する。
//
// 実験フレーム:
//  - 中立エントリー: 各銘柄で K 日ごとに建玉(close)。最大保有 maxHold 日。
//  - 出口ルール3種を同一エントリーに適用:
//      A. モデル(悪化シグナルが点灯した日の close で手仕舞い)
//      B. 固定 −X%(取得来。close ≤ entry×(1−X))
//      C. トレーリングATR(close ≤ ピーク − k×ATR)
//  - 指標: 実現損益分布 / 損失確率 / 手仕舞い時のピークからの戻し幅 / 保有日数、
//          さらにモデル vs ATRストップのリードタイム(何日早く出たか・戻し幅の差)。
//
// 悪化シグナル(deterioration)はポイントインタイムの digest から日次で判定する。

import { PricePoint } from "./types";
import { Horizon, computeDigest, classifySignalEvent } from "./signal-digest";

export type ExitRule = "model" | "fixed" | "atr";

export const EXIT_RULE_LABEL: Record<ExitRule, string> = {
  model: "モデル(悪化シグナル)",
  fixed: "固定 −5%",
  atr: "トレーリングATR(2.5σ)",
};

export interface StopParams {
  K: number; // エントリー間隔(日)
  maxHold: number; // 最大保有(日)
  fixedStopPct: number; // 固定ストップ(0.05 = −5%)
  atrK: number; // ATR倍率
  atrPeriod: number; // ATR期間
  lookback: number; // バックテスト対象の直近日数
}

export const DEFAULT_STOP_PARAMS: StopParams = {
  K: 5,
  maxHold: 15,
  fixedStopPct: 0.05,
  atrK: 2.5,
  atrPeriod: 14,
  lookback: 504,
};

export interface ExitRuleStat {
  rule: ExitRule;
  n: number;
  medianRet: number; // 実現リターン中央値(%)
  meanRet: number;
  pLoss: number; // 損失トレード割合
  medianLoss: number; // 損失トレードの中央値(%)
  worst: number; // 最悪(%)
  medianGiveBack: number; // 手仕舞い時のピークからの戻し幅 中央値(%、負)
  medianHold: number; // 保有日数 中央値
}

export interface StopCompareResult {
  ok: boolean;
  rules: ExitRuleStat[];
  nTrades: number;
  nStocks: number;
  // モデル vs ATR(悪化シグナルが点灯したトレードのみ)
  warnTrades: number;
  leadDaysVsAtr: number; // ATRより何日早く出たか(正=早い)中央値
  giveBackDiffVsAtr: number; // 戻し幅の差(モデル−ATR)中央値、負=浅く出られた
  params: StopParams;
  from: string;
  to: string;
}

// Wilder ATR
function computeATR(prices: PricePoint[], period: number): number[] {
  const n = prices.length;
  const atr = new Array(n).fill(0);
  if (n < 2) return atr;
  let prevClose = prices[0].close;
  let sum = 0;
  let prev = 0;
  for (let i = 1; i < n; i++) {
    const h = prices[i].high;
    const l = prices[i].low;
    const tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
    prevClose = prices[i].close;
    if (i <= period) {
      sum += tr;
      prev = sum / i;
    } else {
      prev = (prev * (period - 1) + tr) / period;
    }
    atr[i] = prev;
  }
  return atr;
}

interface TradeExit {
  rule: ExitRule;
  ret: number;
  giveBack: number;
  holdDays: number;
  triggered: boolean; // ストップ/シグナルで手仕舞い(false=最大保有で時間切れ)
}

// 1エントリーを3ルールで手仕舞いシミュレーション。
function simulateEntry(
  closes: number[],
  atr: number[],
  det: boolean[],
  e: number,
  p: StopParams
): Record<ExitRule, TradeExit> {
  const entry = closes[e];
  const lastT = Math.min(e + p.maxHold, closes.length - 1);
  const out: Record<ExitRule, TradeExit> = {
    model: { rule: "model", ret: 0, giveBack: 0, holdDays: 0, triggered: false },
    fixed: { rule: "fixed", ret: 0, giveBack: 0, holdDays: 0, triggered: false },
    atr: { rule: "atr", ret: 0, giveBack: 0, holdDays: 0, triggered: false },
  };
  const done: Record<ExitRule, boolean> = { model: false, fixed: false, atr: false };
  let peak = entry;

  const record = (rule: ExitRule, t: number, peakAtExit: number) => {
    const price = closes[t];
    out[rule] = {
      rule,
      ret: (price / entry - 1) * 100,
      giveBack: (price / peakAtExit - 1) * 100,
      holdDays: t - e,
      triggered: true, // ルール発火による手仕舞い
    };
    done[rule] = true;
  };

  for (let t = e + 1; t <= lastT; t++) {
    const c = closes[t];
    if (c > peak) peak = c;
    if (!done.model && det[t]) record("model", t, peak);
    if (!done.fixed && c <= entry * (1 - p.fixedStopPct)) record("fixed", t, peak);
    if (!done.atr && atr[t] > 0 && c <= peak - p.atrK * atr[t]) record("atr", t, peak);
  }
  // 未トリガーは最大保有日で時間切れ手仕舞い
  for (const rule of ["model", "fixed", "atr"] as ExitRule[]) {
    if (!done[rule]) {
      const price = closes[lastT];
      out[rule] = {
        rule,
        ret: (price / entry - 1) * 100,
        giveBack: (price / peak - 1) * 100,
        holdDays: lastT - e,
        triggered: false,
      };
    }
  }
  return out;
}

export interface StockTrades {
  byRule: Record<ExitRule, TradeExit[]>;
  // モデルが悪化シグナルで手仕舞いしたエントリーの、モデルとATRのペア
  warnPairs: { leadDays: number; giveBackDiff: number }[];
}

// 1銘柄を中立エントリーで歩いてトレードを集める。
export function backtestStockStops(
  prices: PricePoint[],
  ticker: string,
  name: string,
  horizon: Horizon,
  p: StopParams = DEFAULT_STOP_PARAMS
): StockTrades {
  const empty: StockTrades = {
    byRule: { model: [], fixed: [], atr: [] },
    warnPairs: [],
  };
  const len = prices.length;
  if (len < 100) return empty;

  const closes = prices.map((x) => x.close);
  const atr = computeATR(prices, p.atrPeriod);

  // 悪化シグナルを日次でポイントインタイム判定
  const startEval = Math.max(60, len - p.lookback);
  const det = new Array(len).fill(false);
  for (let t = startEval; t < len; t++) {
    const digest = computeDigest(prices.slice(0, t + 1), ticker, name, horizon);
    if (digest.ok) det[t] = classifySignalEvent(digest).includes("deterioration");
  }

  const trades: StockTrades = {
    byRule: { model: [], fixed: [], atr: [] },
    warnPairs: [],
  };
  for (let e = startEval; e < len - 1; e += p.K) {
    const ex = simulateEntry(closes, atr, det, e, p);
    trades.byRule.model.push(ex.model);
    trades.byRule.fixed.push(ex.fixed);
    trades.byRule.atr.push(ex.atr);
    // モデルが悪化シグナルで手仕舞いしたケースを ATR と比較
    if (ex.model.triggered) {
      trades.warnPairs.push({
        leadDays: ex.atr.holdDays - ex.model.holdDays, // 正=モデルが早い
        giveBackDiff: ex.model.giveBack - ex.atr.giveBack, // giveBackは≤0。正=モデルが浅く出た(高値近く)
      });
    }
  }
  return trades;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) / 2;
  return s.length % 2 ? s[Math.floor(i)] : (s[i - 0.5] + s[i + 0.5]) / 2;
}

function statFor(rule: ExitRule, trades: TradeExit[]): ExitRuleStat {
  const rets = trades.map((t) => t.ret);
  const losses = rets.filter((r) => r < 0);
  return {
    rule,
    n: trades.length,
    medianRet: median(rets),
    meanRet: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0,
    pLoss: rets.length ? losses.length / rets.length : 0,
    medianLoss: median(losses),
    worst: rets.length ? Math.min(...rets) : 0,
    medianGiveBack: median(trades.map((t) => t.giveBack)),
    medianHold: median(trades.map((t) => t.holdDays)),
  };
}

export function aggregateStops(
  pooled: StockTrades[],
  nStocks: number,
  p: StopParams,
  from: string,
  to: string
): StopCompareResult {
  const all: Record<ExitRule, TradeExit[]> = { model: [], fixed: [], atr: [] };
  const warn: { leadDays: number; giveBackDiff: number }[] = [];
  for (const s of pooled) {
    all.model.push(...s.byRule.model);
    all.fixed.push(...s.byRule.fixed);
    all.atr.push(...s.byRule.atr);
    warn.push(...s.warnPairs);
  }
  const nTrades = all.model.length;
  return {
    ok: nTrades > 0,
    rules: (["model", "fixed", "atr"] as ExitRule[]).map((r) => statFor(r, all[r])),
    nTrades,
    nStocks,
    warnTrades: warn.length,
    leadDaysVsAtr: median(warn.map((w) => w.leadDays)),
    giveBackDiffVsAtr: median(warn.map((w) => w.giveBackDiff)),
    params: p,
    from,
    to,
  };
}
