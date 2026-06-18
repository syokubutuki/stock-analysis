// 戦略ラボ — 閾値判定 + 戦略シミュレーション(純粋・軽量)
// feature-series.ts の生の特徴量に閾値束を当ててシグナルを導出し、
// 3モード × 3出口ルールで損益曲線を作る。スライダー操作のたびに瞬時に再計算する。

import { FeaturePoint } from "./feature-series";
import { SignalThresholds } from "./signal-digest";

export type StrategyMode = "stepAside" | "full" | "single";
export type ExitRule = "model" | "fixed" | "atr";

export const MODE_LABEL: Record<StrategyMode, string> = {
  stepAside: "常時ロング・悪化で退避",
  full: "シグナルで売買(完全戦略)",
  single: "1トレード追跡",
};
export const EXIT_LABEL: Record<ExitRule, string> = {
  model: "悪化シグナル",
  fixed: "固定 −X%",
  atr: "トレーリングATR",
};

export interface StratParams {
  fixedStopPct: number; // 0.05 = −5%
  atrK: number;
}
export const DEFAULT_STRAT_PARAMS: StratParams = { fixedStopPct: 0.05, atrK: 2.5 };

export interface Flags {
  direction: "up" | "down" | "flat";
  deterioration: boolean;
  exhaustion: boolean;
  pullbackUp: boolean;
  entryTurn: boolean;
}

export function deriveFlags(f: FeaturePoint, th: SignalThresholds): Flags {
  const direction =
    f.regimeScore >= th.dirUp ? "up" : f.regimeScore <= th.dirDown ? "down" : "flat";
  const volSpike = f.volHist > 0 && f.volGarch > th.volSpikeRatio * f.volHist;
  const changePoint = f.changePointProb >= th.changePointProb;
  return {
    direction,
    deterioration: direction === "down" || changePoint,
    exhaustion: f.hurst < th.hurstMeanRevert || f.meanRevZ > th.zExtreme || volSpike,
    pullbackUp: direction === "up" && f.meanRevZ < th.zOversold && !volSpike,
    entryTurn: direction !== "down" && changePoint && f.meanRevZ < th.zOversold,
  };
}

export interface Marker {
  index: number;
  kind: "entry" | "exit";
  rule?: ExitRule;
  price: number;
}

export interface StratStat {
  totalReturnPct: number;
  maxDDPct: number;
  nTrades: number;
  winRate: number;
  exposure: number; // 投資していた日の割合
}

export interface RuleResult {
  equity: number[];
  markers: Marker[];
  stat: StratStat;
}

function exitTriggered(
  rule: ExitRule,
  i: number,
  flags: Flags[],
  closes: number[],
  entryPrice: number,
  peak: number,
  features: FeaturePoint[],
  p: StratParams
): boolean {
  if (rule === "model") return flags[i].deterioration;
  if (rule === "fixed") return closes[i] <= entryPrice * (1 - p.fixedStopPct);
  return features[i].atr > 0 && closes[i] <= peak - p.atrK * features[i].atr;
}

function maxDrawdown(equity: number[]): number {
  let peak = equity[0] ?? 1;
  let mdd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (e - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd * 100;
}

// 連続運用(モードA/B)を1出口ルールで回す。
function runContinuous(
  features: FeaturePoint[],
  flags: Flags[],
  closes: number[],
  p: StratParams,
  mode: "stepAside" | "full",
  rule: ExitRule
): RuleResult {
  const n = features.length;
  const equity = new Array(n).fill(1);
  const markers: Marker[] = [];
  const trades: number[] = [];
  let eq = 1;
  let invested = mode === "stepAside";
  let entryPrice = invested ? closes[0] : 0;
  let peak = entryPrice;
  let investedDays = invested ? 1 : 0;
  if (invested) markers.push({ index: 0, kind: "entry", price: closes[0] });

  for (let i = 1; i < n; i++) {
    if (invested) {
      eq *= closes[i] / closes[i - 1];
      if (closes[i] > peak) peak = closes[i];
      investedDays++;
    }
    equity[i] = eq;

    if (invested) {
      if (exitTriggered(rule, i, flags, closes, entryPrice, peak, features, p)) {
        invested = false;
        trades.push(closes[i] / entryPrice - 1);
        markers.push({ index: i, kind: "exit", rule, price: closes[i] });
      }
    } else {
      const enter =
        mode === "stepAside"
          ? !flags[i].deterioration && flags[i].direction !== "down"
          : flags[i].entryTurn || flags[i].pullbackUp;
      if (enter) {
        invested = true;
        entryPrice = closes[i];
        peak = closes[i];
        markers.push({ index: i, kind: "entry", price: closes[i] });
      }
    }
  }
  // 期末に建玉が残っていればトレードとして計上
  if (invested && entryPrice > 0) trades.push(closes[n - 1] / entryPrice - 1);

  const wins = trades.filter((t) => t > 0).length;
  const stat: StratStat = {
    totalReturnPct: (eq - 1) * 100,
    maxDDPct: maxDrawdown(equity),
    nTrades: trades.length,
    winRate: trades.length ? wins / trades.length : 0,
    exposure: n > 0 ? investedDays / n : 0,
  };
  return { equity, markers, stat };
}

export interface SingleTradeResult {
  rule: ExitRule;
  exitIndex: number;
  daysHeld: number;
  retPct: number;
}

function runSingle(
  features: FeaturePoint[],
  flags: Flags[],
  closes: number[],
  p: StratParams,
  entryIndex: number,
  rule: ExitRule
): SingleTradeResult {
  const n = features.length;
  const entryPrice = closes[entryIndex];
  let peak = entryPrice;
  for (let i = entryIndex + 1; i < n; i++) {
    if (closes[i] > peak) peak = closes[i];
    if (exitTriggered(rule, i, flags, closes, entryPrice, peak, features, p)) {
      return { rule, exitIndex: i, daysHeld: i - entryIndex, retPct: (closes[i] / entryPrice - 1) * 100 };
    }
  }
  return { rule, exitIndex: n - 1, daysHeld: n - 1 - entryIndex, retPct: (closes[n - 1] / entryPrice - 1) * 100 };
}

export interface SimResult {
  flags: Flags[];
  hold: number[]; // バイ&ホールド損益曲線(正規化)
  byRule: Record<ExitRule, RuleResult>; // モードA/B
  single?: {
    entryIndex: number;
    holdToEndPct: number;
    results: SingleTradeResult[];
  };
}

export function simulateAll(
  features: FeaturePoint[],
  th: SignalThresholds,
  p: StratParams,
  mode: StrategyMode,
  entryIndex: number
): SimResult {
  const n = features.length;
  const closes = features.map((f) => f.close);
  const flags = features.map((f) => deriveFlags(f, th));
  const hold = closes.map((c) => (closes[0] > 0 ? c / closes[0] : 1));

  const rules: ExitRule[] = ["model", "fixed", "atr"];

  if (mode === "single") {
    const e = Math.min(Math.max(entryIndex, 0), n - 2);
    return {
      flags,
      hold,
      byRule: {
        model: { equity: hold, markers: [], stat: emptyStat() },
        fixed: { equity: hold, markers: [], stat: emptyStat() },
        atr: { equity: hold, markers: [], stat: emptyStat() },
      },
      single: {
        entryIndex: e,
        holdToEndPct: closes[e] > 0 ? (closes[n - 1] / closes[e] - 1) * 100 : 0,
        results: rules.map((r) => runSingle(features, flags, closes, p, e, r)),
      },
    };
  }

  const byRule = {} as Record<ExitRule, RuleResult>;
  for (const r of rules) {
    byRule[r] = runContinuous(features, flags, closes, p, mode, r);
  }
  return { flags, hold, byRule };
}

function emptyStat(): StratStat {
  return { totalReturnPct: 0, maxDDPct: 0, nTrades: 0, winRate: 0, exposure: 0 };
}
