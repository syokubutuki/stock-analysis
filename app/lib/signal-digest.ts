// シグナル蒸留層 (方向A)
// 1銘柄の PricePoint[] を、時間軸(デイトレ/スイング/ポジション)ごとの
// 少数のスカラー指標へ蒸留する。既存の分析libを合成するだけの純粋関数。
// ダッシュボード(/portfolio)が各銘柄の行を描くための「データソース」。
//
// 設計メモ: 時間軸が「分析する価格窓の長さ」も決める。これにより
//   ・シグナルが時間軸に対して意味を持つ(短期窓=短期判断)
//   ・重い計算(BOCPD は O(n^2))のコストが窓長で自然に頭打ちになる
// 重み付けは等重み・ルールベース(まず動かす方針)。閾値は本ファイル先頭の
// 定数に集約しており、実運用しながら調整する前提。

import { PricePoint } from "./types";
import { classifyMarketState, MarketRegime } from "./regime";
import { computeDFA } from "./fractal";
import { computeForecastRange } from "./forecast-range";
import { computeRiskMetrics } from "./risk-metrics";
import { computeBOCPD } from "./bocpd";

// ---- 時間軸 ----

export type Horizon = "daytrade" | "swing" | "position";

export interface HorizonConfig {
  label: string;
  window: number; // 分析に使う直近の価格本数
  zWindow: number; // 平均回帰zスコアの移動平均窓
  cpLookback: number; // 「直近の変化点」とみなす日数
  regimeWindow: number; // レジーム分類のボラ推定窓
}

export const HORIZON_CONFIG: Record<Horizon, HorizonConfig> = {
  daytrade: { label: "デイトレ", window: 60, zWindow: 5, cpLookback: 3, regimeWindow: 20 },
  swing: { label: "スイング", window: 252, zWindow: 20, cpLookback: 10, regimeWindow: 60 },
  position: { label: "ポジション", window: 756, zWindow: 60, cpLookback: 30, regimeWindow: 120 },
};

export const HORIZONS: Horizon[] = ["daytrade", "swing", "position"];

// ---- 判定の閾値(等重み・ルールベース。調整はここで) ----

const HURST_MEAN_REVERT = 0.45; // これ未満で「トレンド持続力が弱い/平均回帰寄り」
const Z_EXTREME = 2.0; // 平均回帰zスコアの「行きすぎ」閾値
const Z_OVERSOLD = -1.5; // 押し目とみなすz
const VOL_SPIKE_RATIO = 1.3; // GARCH予測σ / 標本σ がこれ以上で「ボラ急拡大」
const CHANGEPOINT_PROB = 0.3; // BOCPD 変化確率がこれ以上で警戒
const DIR_UP = 20; // レジーム総合スコアがこれ以上で「上方向」
const DIR_DOWN = -20; // これ以下で「下方向」

// 戦略ラボで可変化するための閾値束。デフォルトは上の定数と一致。
// 生の特徴量系列に対してこの束を当ててシグナル事象を導出する(strategy-sim.ts)。
export interface SignalThresholds {
  hurstMeanRevert: number;
  zExtreme: number;
  zOversold: number;
  volSpikeRatio: number;
  changePointProb: number;
  dirUp: number;
  dirDown: number;
}

export const DEFAULT_THRESHOLDS: SignalThresholds = {
  hurstMeanRevert: HURST_MEAN_REVERT,
  zExtreme: Z_EXTREME,
  zOversold: Z_OVERSOLD,
  volSpikeRatio: VOL_SPIKE_RATIO,
  changePointProb: CHANGEPOINT_PROB,
  dirUp: DIR_UP,
  dirDown: DIR_DOWN,
};

// ---- 蒸留結果 ----

export type Direction = "up" | "down" | "flat";

export interface SignalDigest {
  ticker: string;
  name: string;
  asOf: string; // データ最終日 (YYYY-MM-DD)
  close: number;
  bars: number; // 実際に分析した本数
  ok: boolean; // データ不足でないか
  // トレンド/レジーム
  regime: MarketRegime;
  regimeScore: number; // -100..100
  direction: Direction;
  highVol: boolean;
  // 効率性
  hurst: number; // <0.5 平均回帰 / >0.5 トレンド持続
  // 平均回帰
  meanRevZ: number; // 移動平均からの乖離z
  // ボラ・予測
  volForecastPct: number; // GARCH 1日先予測σ(%)
  volSpike: boolean;
  upProb: number; // 1日後にプラスとなる確率(0-1)
  // リスク
  drawdownPct: number; // 窓内ピークからの現在ドローダウン(負値, %)
  cvar95Pct: number; // 期待ショートフォール95%(負値, %)
  // 変化点
  changePoint: boolean; // 直近に変化点を検知したか
  changePointProb: number; // 直近の変化確率(0-1)
}

function logReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  }
  return r;
}

function emptyDigest(ticker: string, name: string, prices: PricePoint[]): SignalDigest {
  const last = prices[prices.length - 1];
  return {
    ticker,
    name,
    asOf: last?.time ?? "",
    close: last?.close ?? 0,
    bars: prices.length,
    ok: false,
    regime: "low_volatility",
    regimeScore: 0,
    direction: "flat",
    highVol: false,
    hurst: 0.5,
    meanRevZ: 0,
    volForecastPct: 0,
    volSpike: false,
    upProb: 0.5,
    drawdownPct: 0,
    cvar95Pct: 0,
    changePoint: false,
    changePointProb: 0,
  };
}

export function computeDigest(
  prices: PricePoint[],
  ticker: string,
  name: string,
  horizon: Horizon
): SignalDigest {
  const cfg = HORIZON_CONFIG[horizon];
  const w = prices.length > cfg.window ? prices.slice(prices.length - cfg.window) : prices;
  if (w.length < 40) return emptyDigest(ticker, name, prices);

  const closes = w.map((p) => p.close);
  const times = w.map((p) => p.time);
  const rets = logReturns(closes);
  const last = w[w.length - 1];

  // レジーム(価格水準にカルマン)
  const ms = classifyMarketState(closes, cfg.regimeWindow);
  const regime = ms.regimes[ms.regimes.length - 1] ?? "low_volatility";
  const regimeScore = ms.overallScore;
  const direction: Direction =
    regimeScore >= DIR_UP ? "up" : regimeScore <= DIR_DOWN ? "down" : "flat";
  const highVol = regime === "high_volatility";

  // 効率性(対数リターンの DFA Hurst)
  const hurst = rets.length >= 20 ? computeDFA(rets).hurstExponent : 0.5;

  // 平均回帰z(直近 zWindow 終値の移動平均からの乖離)
  const zw = Math.min(cfg.zWindow, closes.length);
  const zSlice = closes.slice(closes.length - zw);
  const zMean = zSlice.reduce((a, b) => a + b, 0) / zw;
  const zStd =
    Math.sqrt(zSlice.reduce((a, v) => a + (v - zMean) ** 2, 0) / zw) || 1e-9;
  const meanRevZ = (last.close - zMean) / zStd;

  // ボラ予測(GARCH)・上昇確率
  const fc = computeForecastRange(w, [1, 2, 3]);
  const volForecastPct = fc.ok ? fc.dailyVolGarch * 100 : 0;
  const volSpike = fc.ok && fc.dailyVolHist > 0 && fc.dailyVolGarch > VOL_SPIKE_RATIO * fc.dailyVolHist;
  const upProb = fc.ok && fc.horizons.length > 0 ? fc.horizons[0].upProb : 0.5;

  // リスク
  const rm = computeRiskMetrics(w);
  const cvar95Pct = rm.cvar95 * 100;

  // 窓内ピークからの現在ドローダウン
  let peak = closes[0];
  for (const c of closes) if (c > peak) peak = c;
  const drawdownPct = peak > 0 ? ((last.close - peak) / peak) * 100 : 0;

  // 変化点(BOCPD on returns)
  let changePoint = false;
  let changePointProb = 0;
  if (rets.length >= 30) {
    const bo = computeBOCPD(rets, times.slice(1));
    changePointProb =
      bo.changeProbability.length > 0
        ? bo.changeProbability[bo.changeProbability.length - 1]
        : 0;
    changePoint =
      changePointProb >= CHANGEPOINT_PROB ||
      bo.changePoints.some((cp) => cp.index >= rets.length - cfg.cpLookback);
  }

  return {
    ticker,
    name,
    asOf: last.time,
    close: last.close,
    bars: w.length,
    ok: true,
    regime,
    regimeScore,
    direction,
    highVol,
    hurst,
    meanRevZ,
    volForecastPct,
    volSpike,
    upProb,
    drawdownPct,
    cvar95Pct,
    changePoint,
    changePointProb,
  };
}

// =====================================================================
// 判断レンズ: 蒸留結果 + 建玉情報 → バッジ + 根拠
// =====================================================================

export interface Position {
  shares: number;
  cost: number;
  target?: number;
  stop?: number;
}

export type HeldBadge = "stop" | "takeProfit" | "addOn" | "hold";
export type TargetBadge = "entry" | "wait" | "drop";

export const HELD_BADGE_META: Record<
  HeldBadge,
  { label: string; color: string; priority: number }
> = {
  stop: { label: "損切り警告", color: "red", priority: 0 },
  takeProfit: { label: "利確検討", color: "amber", priority: 1 },
  addOn: { label: "増し玉候補", color: "green", priority: 2 },
  hold: { label: "継続", color: "gray", priority: 3 },
};

export const TARGET_BADGE_META: Record<
  TargetBadge,
  { label: string; color: string; priority: number }
> = {
  entry: { label: "エントリー好機", color: "green", priority: 0 },
  wait: { label: "待ち", color: "amber", priority: 1 },
  drop: { label: "対象外", color: "gray", priority: 2 },
};

export interface HeldEval {
  badge: HeldBadge;
  reasons: string[];
  pnlPct: number | null;
  health: number; // ソート用(高いほど健全。低い=要対応)
}

export interface TargetEval {
  badge: TargetBadge;
  reasons: string[];
  distanceToEntryPct: number | null; // エントリー価格までの距離(%)
  appeal: number; // ソート用(高いほど妙味)
}

export function evaluateHeld(d: SignalDigest, pos?: Position): HeldEval {
  const reasons: string[] = [];
  const pnlPct =
    pos && pos.cost > 0 ? ((d.close - pos.cost) / pos.cost) * 100 : null;
  const inProfit = pnlPct === null || pnlPct > 0;

  // 1. 損切り警告(最優先)
  const stopHit = !!(pos?.stop && d.close <= pos.stop);
  if (d.direction === "down") reasons.push("レジームが下方向");
  if (d.changePoint) reasons.push(`変化点検知(p=${d.changePointProb.toFixed(2)})`);
  if (stopHit) reasons.push(`ストップ価格${pos!.stop}を下回る`);
  if (d.direction === "down" || d.changePoint || stopHit) {
    return { badge: "stop", reasons, pnlPct, health: -100 + d.regimeScore };
  }

  // 2. 利確検討
  const tpReasons: string[] = [];
  if (d.hurst < HURST_MEAN_REVERT) tpReasons.push(`Hurst低下(${d.hurst.toFixed(2)})`);
  if (d.meanRevZ > Z_EXTREME) tpReasons.push(`買われすぎ(z=${d.meanRevZ.toFixed(1)})`);
  if (pos?.target && d.close >= pos.target) tpReasons.push(`ターゲット${pos.target}到達`);
  if (d.volSpike) tpReasons.push("ボラ急拡大");
  if (inProfit && tpReasons.length > 0) {
    return { badge: "takeProfit", reasons: tpReasons, pnlPct, health: -30 + d.regimeScore };
  }

  // 3. 増し玉候補
  if (d.direction === "up" && d.meanRevZ < Z_OVERSOLD && !d.volSpike && inProfit) {
    return {
      badge: "addOn",
      reasons: [`上昇トレンド内の押し目(z=${d.meanRevZ.toFixed(1)})`],
      pnlPct,
      health: 40 + d.regimeScore / 2,
    };
  }

  // 4. 継続
  return {
    badge: "hold",
    reasons: ["明確なシグナルなし"],
    pnlPct,
    health: 30 + d.regimeScore / 2,
  };
}

export function evaluateTarget(d: SignalDigest, pos?: Position): TargetEval {
  const reasons: string[] = [];
  // エントリー指値(target を「狙いの買い価格」として流用)
  const entryPrice = pos?.target;
  const distanceToEntryPct =
    entryPrice && entryPrice > 0 ? ((d.close - entryPrice) / entryPrice) * 100 : null;

  // 対象外: 下方トレンド継続 or ボラ過大
  if (d.direction === "down" && !d.changePoint) reasons.push("下方トレンド継続");
  if (d.highVol) reasons.push("ボラ過大");
  if ((d.direction === "down" && !d.changePoint) || d.highVol) {
    return { badge: "drop", reasons, distanceToEntryPct, appeal: -100 };
  }

  // エントリー好機
  const entryReasons: string[] = [];
  const turningUp = d.direction !== "down" && d.changePoint; // 下落終息/転換
  if (entryPrice && d.close <= entryPrice) entryReasons.push(`指値${entryPrice}に到達`);
  if (turningUp) entryReasons.push("下落終息/転換の兆し");
  if (d.meanRevZ < Z_OVERSOLD && !d.volSpike) entryReasons.push(`売られすぎ反発(z=${d.meanRevZ.toFixed(1)})`);
  if (entryReasons.length > 0) {
    return {
      badge: "entry",
      reasons: entryReasons,
      distanceToEntryPct,
      appeal: 60 - d.meanRevZ * 10,
    };
  }

  // 待ち
  reasons.push(
    distanceToEntryPct !== null
      ? `指値まで ${distanceToEntryPct >= 0 ? "+" : ""}${distanceToEntryPct.toFixed(1)}%`
      : "条件未達"
  );
  return { badge: "wait", reasons, distanceToEntryPct, appeal: 0 };
}

// =====================================================================
// シグナル事象(建玉ゲートを外した「純粋なシグナル」)
// 実績化(バックテスト)とライブ判定で同じ閾値を共有し、ロジックのズレを防ぐ。
// バッジ(evaluateHeld/Target)はこれに建玉条件を足したもの。
// =====================================================================

export type SignalEvent = "deterioration" | "exhaustion" | "pullbackUp" | "entryTurn";

export const SIGNAL_EVENT_META: Record<SignalEvent, { label: string; color: string }> = {
  deterioration: { label: "悪化(損切り警告)", color: "red" },
  exhaustion: { label: "過熱(利確検討)", color: "amber" },
  pullbackUp: { label: "押し目(増し玉)", color: "green" },
  entryTurn: { label: "転換(エントリー)", color: "green" },
};

export const SIGNAL_EVENTS: SignalEvent[] = ["deterioration", "exhaustion", "pullbackUp", "entryTurn"];

// digest から現在アクティブなシグナル事象を返す(複数同時に成立しうる)。
export function classifySignalEvent(d: SignalDigest): SignalEvent[] {
  if (!d.ok) return [];
  const ev: SignalEvent[] = [];
  // 悪化: 下方反転 or 変化点(= 損切り警告のシグナル部分)
  if (d.direction === "down" || d.changePoint) ev.push("deterioration");
  // 過熱: Hurst低下 or 買われすぎ or ボラ急拡大(= 利確検討のシグナル部分)
  if (d.hurst < HURST_MEAN_REVERT || d.meanRevZ > Z_EXTREME || d.volSpike) ev.push("exhaustion");
  // 押し目: 上昇トレンド内の売られすぎ(= 増し玉のシグナル部分)
  if (d.direction === "up" && d.meanRevZ < Z_OVERSOLD && !d.volSpike) ev.push("pullbackUp");
  // 転換: 下落終息+売られすぎ反発(= エントリー好機のシグナル部分)
  if (d.direction !== "down" && d.changePoint && d.meanRevZ < Z_OVERSOLD) ev.push("entryTurn");
  return ev;
}
