// 戦略ラボ用の「生の特徴量系列」
// 過去日ごとにポイントインタイムで digest を再計算し、閾値判定前の生の数値を記録する。
// これは重い(GARCH/BOCPD/カルマン)ので Worker で1回だけ計算。
// 以降の閾値判定・戦略シミュレーション(strategy-sim.ts)はこの系列に対して
// メインスレッドで瞬時に行い、スライダーのインタラクティブ更新を可能にする。

import { PricePoint } from "./types";
import { Horizon, computeDigest } from "./signal-digest";

export interface FeaturePoint {
  time: string;
  close: number;
  regimeScore: number;
  highVol: boolean;
  hurst: number;
  meanRevZ: number;
  volGarch: number; // GARCH予測σ(%)
  volHist: number; // 標本σ(%) — volSpike 判定の分母(volForecastPct を保持し、比は別途)
  changePointProb: number;
  drawdownPct: number;
  atr: number; // Wilder ATR(14) — トレーリングストップ用
}

// Wilder ATR
function computeATR(prices: PricePoint[], period = 14): number[] {
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

// digest は volForecastPct(GARCH予測σ%)は持つが標本σは持たないため、
// volSpike を後から閾値可変で判定できるよう、標本σ(直近の対数リターン標準偏差)も記録する。
function recentHistVolPct(closes: number[], t: number, win = 20): number {
  const start = Math.max(1, t - win + 1);
  const rets: number[] = [];
  for (let i = start; i <= t; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 2) return 0;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, x) => a + (x - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * 100;
}

export function computeFeatureSeries(
  prices: PricePoint[],
  horizon: Horizon,
  opts: { lookback?: number } = {}
): FeaturePoint[] {
  const lookback = opts.lookback ?? 504;
  const len = prices.length;
  if (len < 80) return [];
  const closes = prices.map((p) => p.close);
  const atr = computeATR(prices, 14);
  const startEval = Math.max(60, len - lookback);
  const out: FeaturePoint[] = [];
  for (let t = startEval; t < len; t++) {
    const digest = computeDigest(prices.slice(0, t + 1), "", "", horizon);
    if (!digest.ok) continue;
    out.push({
      time: prices[t].time,
      close: closes[t],
      regimeScore: digest.regimeScore,
      highVol: digest.highVol,
      hurst: digest.hurst,
      meanRevZ: digest.meanRevZ,
      volGarch: digest.volForecastPct,
      volHist: recentHistVolPct(closes, t),
      changePointProb: digest.changePointProb,
      drawdownPct: digest.drawdownPct,
      atr: atr[t],
    });
  }
  return out;
}
