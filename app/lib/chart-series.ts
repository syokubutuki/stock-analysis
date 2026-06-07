import { PricePoint } from "./types";
import { computeTrendSeries } from "./trend-analysis";
import { computeRSI, computeMACD, computeBollinger } from "./technical-indicators";
import { computeStochastics } from "./stochastics";
import { computeADX } from "./adx";
import { computeATR, computeKeltnerChannel } from "./atr";
import { computeOBV, computeVWAP } from "./obv-vwap";
import { computeDiffSeries, computeDiffSeriesPercent } from "./diff-series";
import {
  logReturns,
  rankTransform,
  volNormalizedReturns,
  cumulativeLogReturns,
} from "./transforms";
import { analyzeVolume } from "./volume-analysis";
import { computeGapSeries, computeCumulativeReturns } from "./gap-analysis";
import { computeDrawdownSeries } from "./drawdown";
import { ewmaVolatility } from "./volatility";
import { fitGarch } from "./garch";
import { computeRangeVolatility } from "./range-volatility";
import { rollingRiskMetrics } from "./risk-metrics";
import { computeCandleMetrics, rollingCandleStats } from "./candle-structure";
import { computeIntradayRange, rollingRange } from "./intraday-range";
import { computeMFEMAE } from "./mfe-mae";
import {
  rollingLyapunov,
  rollingRQA,
  simplexProjection,
  phaseSpaceDensity,
  rollingTDA,
} from "./attractor-investment";
import { fitHMM, kalmanFilter, kalmanFilter2State, adaptiveKalmanFilter, kalmanFilter3State, kalmanSmoother } from "./regime";
import { computeSSA } from "./ssa";
import { rollingEntropy } from "./entropy";
import {
  rollingRenyi,
  rollingTsallis,
  rollingApEn,
  rollingWeightedPE,
  rollingConditionalEntropy,
} from "./entropy-extended";
import {
  rollingCEPlane,
  rollingAIS,
  rollingPredictability,
  rollingInfoRatio,
} from "./complexity";
import { rollingHalfLife } from "./mean-reversion";
import { unitRootTest } from "./unit-root";
import { computeBOCPD } from "./bocpd";
import { detectStructuralBreaks } from "./structural-break";
import { fitGJR, fitEGARCH } from "./gjr-egarch";
import { rollSpread, amihudIlliquidity } from "./microstructure";
import { anchoringAnalysis } from "./behavioral";
import { fitAR } from "./arima";
import { fitSarima, SarimaFit } from "./sarima";
import { computeVisibilityGraph } from "./visibility-graph";
import { computeRecurrenceNetwork } from "./recurrence-network";
import { rollingSpectralEntropy } from "./hilbert-huang-spectrum";

// ---- Types ----

export interface TimeValue {
  time: string;
  value: number;
  color?: string; // per-point color override (used by histogram)
}

export interface TimeOHLC {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SeriesGroup {
  id: string;
  label: string;
}

export interface SeriesDef {
  id: string;
  label: string;
  group: string;
  color: string;
  scaleId: string;
  type: "line" | "histogram" | "candlestick";
  lineWidth?: number;
  lineStyle?: number; // 0=solid, 2=dashed, 3=dotted
  compute: (prices: PricePoint[]) => TimeValue[];
  // For candlestick only
  computeOHLC?: (prices: PricePoint[]) => TimeOHLC[];
  // For histogram color function
  colorFn?: (value: number) => string;
}

// ---- Groups ----

export const GROUPS: SeriesGroup[] = [
  { id: "price", label: "価格" },
  { id: "sma", label: "移動平均" },
  { id: "band", label: "バンド" },
  { id: "volume", label: "出来高" },
  { id: "oscillator", label: "オシレーター" },
  { id: "macd", label: "MACD" },
  { id: "diff", label: "差分" },
  { id: "return", label: "リターン" },
  { id: "transform", label: "変換" },
  { id: "volatility", label: "ボラティリティ" },
  { id: "gap", label: "ギャップ" },
  { id: "risk", label: "リスク" },
  { id: "candle_m", label: "ローソク足構造" },
  { id: "range", label: "日中レンジ" },
  { id: "nonlinear", label: "非線形" },
  { id: "tda", label: "TDA" },
  { id: "regime", label: "レジーム" },
  { id: "decomp", label: "SSA分解" },
  { id: "entropy", label: "エントロピー" },
  { id: "complexity", label: "複雑性" },
  { id: "meanrev", label: "平均回帰" },
  { id: "break", label: "構造変化" },
  { id: "micro", label: "マイクロ構造" },
  { id: "behavioral", label: "行動ファイナンス" },
  { id: "arima", label: "ARIMA" },
  { id: "network", label: "ネットワーク" },
];

// ---- Helpers ----

const tv = (time: string, value: number): TimeValue => ({ time, value });
const green = "rgba(38,166,154,0.6)";
const red = "rgba(239,83,80,0.6)";
const upDown = (v: number) => (v >= 0 ? green : red);

// 純粋MA(q)モデルを次数 1..4 でBIC最小により自動選択（移動平均過程用）
function bestMaFit(series: number[]): SarimaFit | null {
  let best: SarimaFit | null = null;
  for (let q = 1; q <= 4; q++) {
    const fit = fitSarima(series, { p: 0, d: 0, q, P: 0, D: 0, Q: 0, s: 0 });
    if (!fit.ok) continue;
    if (!best || fit.bic < best.bic) best = fit;
  }
  return best;
}

// ---- Series Catalog ----

export const SERIES: SeriesDef[] = [
  // ====== 価格 ======
  {
    id: "candle",
    label: "ローソク足",
    group: "price",
    color: "#26a69a",
    scaleId: "price",
    type: "candlestick",
    compute: () => [],
    computeOHLC: (p) =>
      p.map((x) => ({
        time: x.time,
        open: x.open,
        high: x.high,
        low: x.low,
        close: x.close,
      })),
  },
  {
    id: "close",
    label: "Close",
    group: "price",
    color: "#1f2937",
    scaleId: "price",
    type: "line",
    compute: (p) => p.map((x) => tv(x.time, x.close)),
  },
  {
    id: "open",
    label: "Open",
    group: "price",
    color: "#d97706",
    scaleId: "price",
    type: "line",
    compute: (p) => p.map((x) => tv(x.time, x.open)),
  },
  {
    id: "high",
    label: "High",
    group: "price",
    color: "#dc2626",
    scaleId: "price",
    type: "line",
    compute: (p) => p.map((x) => tv(x.time, x.high)),
  },
  {
    id: "low",
    label: "Low",
    group: "price",
    color: "#2563eb",
    scaleId: "price",
    type: "line",
    compute: (p) => p.map((x) => tv(x.time, x.low)),
  },
  {
    id: "vwap",
    label: "VWAP",
    group: "price",
    color: "#059669",
    scaleId: "price",
    type: "line",
    compute: (p) => computeVWAP(p).map((x) => tv(x.time, x.vwap)),
  },

  // ====== 移動平均 ======
  {
    id: "sma5",
    label: "SMA5",
    group: "sma",
    color: "#f59e0b",
    scaleId: "price",
    type: "line",
    compute: (p) =>
      computeTrendSeries(p)
        .filter((x) => x.sma5 !== null)
        .map((x) => tv(x.time, x.sma5!)),
  },
  {
    id: "sma25",
    label: "SMA25",
    group: "sma",
    color: "#06b6d4",
    scaleId: "price",
    type: "line",
    compute: (p) =>
      computeTrendSeries(p)
        .filter((x) => x.sma25 !== null)
        .map((x) => tv(x.time, x.sma25!)),
  },
  {
    id: "sma75",
    label: "SMA75",
    group: "sma",
    color: "#a855f7",
    scaleId: "price",
    type: "line",
    compute: (p) =>
      computeTrendSeries(p)
        .filter((x) => x.sma75 !== null)
        .map((x) => tv(x.time, x.sma75!)),
  },

  // ====== バンド ======
  {
    id: "bb_upper",
    label: "BB上限",
    group: "band",
    color: "#94a3b8",
    scaleId: "price",
    type: "line",
    lineStyle: 2,
    compute: (p) => computeBollinger(p).map((x) => tv(x.time, x.upper)),
  },
  {
    id: "bb_middle",
    label: "BB中央",
    group: "band",
    color: "#64748b",
    scaleId: "price",
    type: "line",
    compute: (p) => computeBollinger(p).map((x) => tv(x.time, x.middle)),
  },
  {
    id: "bb_lower",
    label: "BB下限",
    group: "band",
    color: "#94a3b8",
    scaleId: "price",
    type: "line",
    lineStyle: 2,
    compute: (p) => computeBollinger(p).map((x) => tv(x.time, x.lower)),
  },
  {
    id: "kelt_upper",
    label: "ケルトナー上限",
    group: "band",
    color: "#d97706",
    scaleId: "price",
    type: "line",
    lineStyle: 3,
    compute: (p) => computeKeltnerChannel(p).map((x) => tv(x.time, x.upper)),
  },
  {
    id: "kelt_middle",
    label: "ケルトナーEMA",
    group: "band",
    color: "#b45309",
    scaleId: "price",
    type: "line",
    compute: (p) => computeKeltnerChannel(p).map((x) => tv(x.time, x.middle)),
  },
  {
    id: "kelt_lower",
    label: "ケルトナー下限",
    group: "band",
    color: "#d97706",
    scaleId: "price",
    type: "line",
    lineStyle: 3,
    compute: (p) => computeKeltnerChannel(p).map((x) => tv(x.time, x.lower)),
  },

  // ====== 出来高 ======
  {
    id: "volume",
    label: "出来高",
    group: "volume",
    color: "#9ca3af",
    scaleId: "volume",
    type: "histogram",
    compute: (p) => {
      const bars = analyzeVolume(p);
      return bars.map((b) => ({
        time: b.time,
        value: b.volume,
        color: b.type === "down" ? red : green,
      }));
    },
  },
  {
    id: "vol_ma",
    label: "出来高MA20",
    group: "volume",
    color: "#ff9800",
    scaleId: "volume",
    type: "line",
    compute: (p) => analyzeVolume(p).map((b) => tv(b.time, b.avgVolume)),
  },
  {
    id: "obv",
    label: "OBV",
    group: "volume",
    color: "#2196f3",
    scaleId: "obv",
    type: "line",
    compute: (p) => computeOBV(p).map((x) => tv(x.time, x.obv)),
  },
  {
    id: "obv_ma",
    label: "OBV MA20",
    group: "volume",
    color: "#90caf9",
    scaleId: "obv",
    type: "line",
    lineStyle: 2,
    compute: (p) => computeOBV(p).map((x) => tv(x.time, x.obvMA)),
  },

  // ====== オシレーター ======
  {
    id: "rsi",
    label: "RSI(14)",
    group: "oscillator",
    color: "#8b5cf6",
    scaleId: "osc",
    type: "line",
    compute: (p) => computeRSI(p).map((x) => tv(x.time, x.value)),
  },
  {
    id: "stoch_k",
    label: "%K(14)",
    group: "oscillator",
    color: "#3b82f6",
    scaleId: "osc",
    type: "line",
    compute: (p) => computeStochastics(p).map((x) => tv(x.time, x.slowK)),
  },
  {
    id: "stoch_d",
    label: "%D(14)",
    group: "oscillator",
    color: "#ef4444",
    scaleId: "osc",
    type: "line",
    lineStyle: 2,
    compute: (p) => computeStochastics(p).map((x) => tv(x.time, x.slowD)),
  },
  {
    id: "adx",
    label: "ADX(14)",
    group: "oscillator",
    color: "#1f2937",
    scaleId: "osc",
    type: "line",
    lineWidth: 2,
    compute: (p) => computeADX(p).map((x) => tv(x.time, x.adx)),
  },
  {
    id: "plus_di",
    label: "+DI(14)",
    group: "oscillator",
    color: "#22c55e",
    scaleId: "osc",
    type: "line",
    compute: (p) => computeADX(p).map((x) => tv(x.time, x.plusDI)),
  },
  {
    id: "minus_di",
    label: "-DI(14)",
    group: "oscillator",
    color: "#ef4444",
    scaleId: "osc",
    type: "line",
    compute: (p) => computeADX(p).map((x) => tv(x.time, x.minusDI)),
  },
  {
    id: "bb_pctb",
    label: "%B",
    group: "oscillator",
    color: "#64748b",
    scaleId: "ratio",
    type: "line",
    compute: (p) => computeBollinger(p).map((x) => tv(x.time, x.percentB)),
  },
  {
    id: "bb_bw",
    label: "BB帯幅",
    group: "oscillator",
    color: "#475569",
    scaleId: "bw",
    type: "line",
    compute: (p) => computeBollinger(p).map((x) => tv(x.time, x.bandwidth)),
  },

  // ====== MACD ======
  {
    id: "macd_line",
    label: "MACD",
    group: "macd",
    color: "#3b82f6",
    scaleId: "macd",
    type: "line",
    compute: (p) => computeMACD(p).map((x) => tv(x.time, x.macd)),
  },
  {
    id: "macd_signal",
    label: "Signal",
    group: "macd",
    color: "#ef4444",
    scaleId: "macd",
    type: "line",
    compute: (p) => computeMACD(p).map((x) => tv(x.time, x.signal)),
  },
  {
    id: "macd_hist",
    label: "Histogram",
    group: "macd",
    color: "#9ca3af",
    scaleId: "macd",
    type: "histogram",
    colorFn: upDown,
    compute: (p) => computeMACD(p).map((x) => tv(x.time, x.histogram)),
  },

  // ====== 差分 ======
  {
    id: "diff1",
    label: "1日差分",
    group: "diff",
    color: "#26a69a",
    scaleId: "diff",
    type: "histogram",
    colorFn: upDown,
    compute: (p) => computeDiffSeries(p, 1).map((x) => tv(x.time, x.value)),
  },
  {
    id: "diff2",
    label: "2日差分",
    group: "diff",
    color: "#4285f4",
    scaleId: "diff",
    type: "histogram",
    colorFn: upDown,
    compute: (p) => computeDiffSeries(p, 2).map((x) => tv(x.time, x.value)),
  },
  {
    id: "diff3",
    label: "3日差分",
    group: "diff",
    color: "#9c27b0",
    scaleId: "diff",
    type: "histogram",
    colorFn: upDown,
    compute: (p) => computeDiffSeries(p, 3).map((x) => tv(x.time, x.value)),
  },
  {
    id: "diff1_pct",
    label: "1日変化率",
    group: "diff",
    color: "#26a69a",
    scaleId: "diff_pct",
    type: "line",
    compute: (p) => computeDiffSeriesPercent(p, 1).map((x) => tv(x.time, x.value)),
  },

  // ====== リターン ======
  {
    id: "log_return",
    label: "対数リターン",
    group: "return",
    color: "#6366f1",
    scaleId: "ret",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      const lr = logReturns(c);
      return lr.map((v, i) => tv(p[i + 1].time, v));
    },
  },
  {
    id: "cum_log_return",
    label: "累積ログリターン",
    group: "return",
    color: "#1f2937",
    scaleId: "cum_ret",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      const clr = cumulativeLogReturns(c);
      return clr.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "overnight_ret",
    label: "夜間リターン",
    group: "return",
    color: "#3b82f6",
    scaleId: "ret",
    type: "histogram",
    colorFn: upDown,
    compute: (p) => {
      const gaps = computeGapSeries(p);
      return gaps.map((g) => tv(g.time, g.overnightReturn));
    },
  },
  {
    id: "intraday_ret",
    label: "日中リターン",
    group: "return",
    color: "#f59e0b",
    scaleId: "ret",
    type: "histogram",
    colorFn: upDown,
    compute: (p) => {
      const gaps = computeGapSeries(p);
      return gaps.map((g) => tv(g.time, g.intradayReturn));
    },
  },

  // ====== 変換 ======
  {
    id: "rank",
    label: "順位変換(Close)",
    group: "transform",
    color: "#0ea5e9",
    scaleId: "ratio",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = rankTransform(c);
      return r.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "vol_norm",
    label: "ボラ正規化リターン",
    group: "transform",
    color: "#7c3aed",
    scaleId: "vnorm",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      const vn = volNormalizedReturns(c);
      return vn.map((v, i) => tv(p[i + 1].time, v));
    },
  },

  // ====== ボラティリティ ======
  {
    id: "ewma_vol",
    label: "EWMA Vol",
    group: "volatility",
    color: "#ef4444",
    scaleId: "vol",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      const lr = logReturns(c);
      const times = p.slice(1).map((x) => x.time);
      const ev = ewmaVolatility(lr, times);
      return ev.map((x) => tv(x.time, x.ewma));
    },
  },
  {
    id: "realized_vol",
    label: "実現Vol(20d)",
    group: "volatility",
    color: "#3b82f6",
    scaleId: "vol",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      const lr = logReturns(c);
      const times = p.slice(1).map((x) => x.time);
      const ev = ewmaVolatility(lr, times);
      return ev.map((x) => tv(x.time, x.realized));
    },
  },
  {
    id: "atr",
    label: "ATR(14)",
    group: "volatility",
    color: "#f97316",
    scaleId: "atr",
    type: "line",
    compute: (p) => computeATR(p).map((x) => tv(x.time, x.atr)),
  },
  {
    id: "atr_pct",
    label: "ATR%(14)",
    group: "volatility",
    color: "#fb923c",
    scaleId: "vol",
    type: "line",
    compute: (p) => computeATR(p).map((x) => tv(x.time, x.atrPercent)),
  },
  {
    id: "garch_vol",
    label: "GARCH Vol",
    group: "volatility",
    color: "#dc2626",
    scaleId: "vol",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      const lr = logReturns(c);
      if (lr.length < 30) return [];
      const g = fitGarch(lr);
      return g.conditionalVol.map((v, i) => tv(p[i + 1].time, v));
    },
  },
  {
    id: "rv_parkinson",
    label: "Parkinson Vol",
    group: "volatility",
    color: "#0891b2",
    scaleId: "vol",
    type: "line",
    compute: (p) => computeRangeVolatility(p).map((x) => tv(x.time, x.parkinson)),
  },
  {
    id: "rv_garman",
    label: "Garman-Klass Vol",
    group: "volatility",
    color: "#0e7490",
    scaleId: "vol",
    type: "line",
    compute: (p) => computeRangeVolatility(p).map((x) => tv(x.time, x.garmanKlass)),
  },
  {
    id: "rv_yang",
    label: "Yang-Zhang Vol",
    group: "volatility",
    color: "#155e75",
    scaleId: "vol",
    type: "line",
    compute: (p) => computeRangeVolatility(p).map((x) => tv(x.time, x.yangZhang)),
  },
  {
    id: "gjr_vol",
    label: "GJR-GARCH Vol",
    group: "volatility",
    color: "#be123c",
    scaleId: "vol",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      if (lr.length < 30) return [];
      const g = fitGJR(lr);
      return g.conditionalVol.map((v, i) => tv(p[i + 1].time, v));
    },
  },
  {
    id: "egarch_vol",
    label: "EGARCH Vol",
    group: "volatility",
    color: "#9f1239",
    scaleId: "vol",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      if (lr.length < 30) return [];
      const g = fitEGARCH(lr);
      return g.conditionalVol.map((v, i) => tv(p[i + 1].time, v));
    },
  },

  // ====== ギャップ ======
  {
    id: "cum_overnight",
    label: "累積夜間リターン",
    group: "gap",
    color: "#3b82f6",
    scaleId: "cum_gap",
    type: "line",
    compute: (p) => {
      const gaps = computeGapSeries(p);
      const cum = computeCumulativeReturns(gaps);
      return cum.map((c) => tv(c.time, c.overnight * 100));
    },
  },
  {
    id: "cum_intraday",
    label: "累積日中リターン",
    group: "gap",
    color: "#f59e0b",
    scaleId: "cum_gap",
    type: "line",
    compute: (p) => {
      const gaps = computeGapSeries(p);
      const cum = computeCumulativeReturns(gaps);
      return cum.map((c) => tv(c.time, c.intraday * 100));
    },
  },
  {
    id: "cum_total",
    label: "累積全体リターン",
    group: "gap",
    color: "#6b7280",
    scaleId: "cum_gap",
    type: "line",
    compute: (p) => {
      const gaps = computeGapSeries(p);
      const cum = computeCumulativeReturns(gaps);
      return cum.map((c) => tv(c.time, c.total * 100));
    },
  },

  // ====== リスク ======
  {
    id: "drawdown",
    label: "ドローダウン",
    group: "risk",
    color: "#dc2626",
    scaleId: "dd",
    type: "line",
    compute: (p) => computeDrawdownSeries(p).map((x) => tv(x.time, x.drawdown * 100)),
  },
  {
    id: "peak",
    label: "ピーク価格",
    group: "risk",
    color: "#9ca3af",
    scaleId: "price",
    type: "line",
    lineStyle: 2,
    compute: (p) => computeDrawdownSeries(p).map((x) => tv(x.time, x.peak)),
  },
  {
    id: "roll_sharpe",
    label: "Sharpe(60d)",
    group: "risk",
    color: "#22c55e",
    scaleId: "risk_ratio",
    type: "line",
    compute: (p) => rollingRiskMetrics(p).map((x) => tv(x.time, x.sharpe)),
  },
  {
    id: "roll_sortino",
    label: "Sortino(60d)",
    group: "risk",
    color: "#3b82f6",
    scaleId: "risk_ratio",
    type: "line",
    compute: (p) => rollingRiskMetrics(p).map((x) => tv(x.time, x.sortino)),
  },
  {
    id: "roll_vol",
    label: "年率Vol(60d)",
    group: "risk",
    color: "#f97316",
    scaleId: "vol",
    type: "line",
    compute: (p) => rollingRiskMetrics(p).map((x) => tv(x.time, x.vol)),
  },
  {
    id: "roll_var95",
    label: "VaR95(60d)",
    group: "risk",
    color: "#dc2626",
    scaleId: "ret",
    type: "line",
    compute: (p) => rollingRiskMetrics(p).map((x) => tv(x.time, x.var95)),
  },
  {
    id: "mfe",
    label: "MFE",
    group: "risk",
    color: "#22c55e",
    scaleId: "mfe",
    type: "line",
    compute: (p) => computeMFEMAE(p).map((x) => tv(x.time, x.mfe * 100)),
  },
  {
    id: "mae",
    label: "MAE",
    group: "risk",
    color: "#dc2626",
    scaleId: "mfe",
    type: "line",
    compute: (p) => computeMFEMAE(p).map((x) => tv(x.time, x.mae * 100)),
  },

  // ====== ローソク足構造 ======
  {
    id: "body_ratio",
    label: "実体比率",
    group: "candle_m",
    color: "#6366f1",
    scaleId: "ratio",
    type: "line",
    compute: (p) => computeCandleMetrics(p).map((x) => tv(x.time, x.bodyRatio)),
  },
  {
    id: "upper_shadow",
    label: "上ヒゲ比率",
    group: "candle_m",
    color: "#dc2626",
    scaleId: "ratio",
    type: "line",
    compute: (p) => computeCandleMetrics(p).map((x) => tv(x.time, x.upperShadowRatio)),
  },
  {
    id: "lower_shadow",
    label: "下ヒゲ比率",
    group: "candle_m",
    color: "#2563eb",
    scaleId: "ratio",
    type: "line",
    compute: (p) => computeCandleMetrics(p).map((x) => tv(x.time, x.lowerShadowRatio)),
  },
  {
    id: "close_pos",
    label: "終値位置",
    group: "candle_m",
    color: "#0ea5e9",
    scaleId: "ratio",
    type: "line",
    compute: (p) => computeCandleMetrics(p).map((x) => tv(x.time, x.closePosition)),
  },
  {
    id: "body_ratio_ma",
    label: "実体比率MA20",
    group: "candle_m",
    color: "#818cf8",
    scaleId: "ratio",
    type: "line",
    compute: (p) => {
      const m = computeCandleMetrics(p);
      return rollingCandleStats(m).map((x) => tv(x.time, x.bodyRatioMA));
    },
  },
  {
    id: "close_pos_ma",
    label: "終値位置MA20",
    group: "candle_m",
    color: "#38bdf8",
    scaleId: "ratio",
    type: "line",
    compute: (p) => {
      const m = computeCandleMetrics(p);
      return rollingCandleStats(m).map((x) => tv(x.time, x.closePositionMA));
    },
  },

  // ====== 日中レンジ ======
  {
    id: "norm_range",
    label: "正規化レンジ",
    group: "range",
    color: "#f97316",
    scaleId: "nrange",
    type: "line",
    compute: (p) => computeIntradayRange(p).map((x) => tv(x.time, x.normalizedRange * 100)),
  },
  {
    id: "range_ma",
    label: "レンジMA20",
    group: "range",
    color: "#ea580c",
    scaleId: "nrange",
    type: "line",
    compute: (p) => {
      const ir = computeIntradayRange(p);
      return rollingRange(ir).map((x) => tv(x.time, x.rangeMA * 100));
    },
  },

  // ====== 非線形 ======
  {
    id: "lyapunov",
    label: "局所Lyapunov",
    group: "nonlinear",
    color: "#dc2626",
    scaleId: "lyap",
    type: "line",
    compute: (p) => {
      const vals = p.map((x) => x.close);
      const times = p.map((x) => x.time);
      if (vals.length < 150) return [];
      const r = rollingLyapunov(vals, times);
      return r.times.map((t, i) => tv(t, r.exponents[i]));
    },
  },
  {
    id: "phase_density",
    label: "位相空間密度",
    group: "nonlinear",
    color: "#7c3aed",
    scaleId: "density",
    type: "line",
    compute: (p) => {
      const vals = p.map((x) => x.close);
      const times = p.map((x) => x.time);
      if (vals.length < 50) return [];
      const r = phaseSpaceDensity(vals, times);
      return r.times.map((t, i) => tv(t, r.density[i]));
    },
  },
  {
    id: "phase_novelty",
    label: "位相空間新規性",
    group: "nonlinear",
    color: "#a855f7",
    scaleId: "density",
    type: "line",
    compute: (p) => {
      const vals = p.map((x) => x.close);
      const times = p.map((x) => x.time);
      if (vals.length < 50) return [];
      const r = phaseSpaceDensity(vals, times);
      return r.times.map((t, i) => tv(t, r.novelty[i]));
    },
  },
  {
    id: "rqa_det",
    label: "RQA DET",
    group: "nonlinear",
    color: "#0891b2",
    scaleId: "rqa",
    type: "line",
    compute: (p) => {
      const vals = p.map((x) => x.close);
      const times = p.map((x) => x.time);
      if (vals.length < 150) return [];
      const r = rollingRQA(vals, times);
      return r.data.map((x) => tv(x.time, x.det));
    },
  },
  {
    id: "rqa_lam",
    label: "RQA LAM",
    group: "nonlinear",
    color: "#06b6d4",
    scaleId: "rqa",
    type: "line",
    compute: (p) => {
      const vals = p.map((x) => x.close);
      const times = p.map((x) => x.time);
      if (vals.length < 150) return [];
      const r = rollingRQA(vals, times);
      return r.data.map((x) => tv(x.time, x.lam));
    },
  },
  {
    id: "rqa_rr",
    label: "RQA再帰率",
    group: "nonlinear",
    color: "#14b8a6",
    scaleId: "rqa",
    type: "line",
    compute: (p) => {
      const vals = p.map((x) => x.close);
      const times = p.map((x) => x.time);
      if (vals.length < 150) return [];
      const r = rollingRQA(vals, times);
      return r.data.map((x) => tv(x.time, x.recurrenceRate));
    },
  },
  {
    id: "simplex_pred",
    label: "Simplex予測",
    group: "nonlinear",
    color: "#f43f5e",
    scaleId: "price",
    type: "line",
    lineStyle: 2,
    compute: (p) => {
      const vals = p.map((x) => x.close);
      const times = p.map((x) => x.time);
      if (vals.length < 80) return [];
      const r = simplexProjection(vals, times);
      return r.actualTimes.map((t, i) => tv(t, r.predicted[i]));
    },
  },

  // ====== TDA ======
  {
    id: "tda_beta0",
    label: "Betti-0",
    group: "tda",
    color: "#3b82f6",
    scaleId: "tda_b0",
    type: "line",
    compute: (p) => {
      const vals = p.map((x) => x.close);
      const times = p.map((x) => x.time);
      if (vals.length < 180) return [];
      const r = rollingTDA(vals, times);
      return r.data.map((x) => tv(x.time, x.beta0));
    },
  },
  {
    id: "tda_beta1",
    label: "Betti-1",
    group: "tda",
    color: "#ef4444",
    scaleId: "tda_b1",
    type: "line",
    compute: (p) => {
      const vals = p.map((x) => x.close);
      const times = p.map((x) => x.time);
      if (vals.length < 180) return [];
      const r = rollingTDA(vals, times);
      return r.data.map((x) => tv(x.time, x.beta1));
    },
  },
  {
    id: "tda_persist",
    label: "Total Persistence",
    group: "tda",
    color: "#a855f7",
    scaleId: "tda_persist",
    type: "line",
    compute: (p) => {
      const vals = p.map((x) => x.close);
      const times = p.map((x) => x.time);
      if (vals.length < 180) return [];
      const r = rollingTDA(vals, times);
      return r.data.map((x) => tv(x.time, x.totalPersistence));
    },
  },

  // ====== レジーム ======
  {
    id: "hmm_state",
    label: "HMM状態",
    group: "regime",
    color: "#f59e0b",
    scaleId: "state",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      const lr = logReturns(c);
      if (lr.length < 30) return [];
      const r = fitHMM(lr);
      return r.states.map((s, i) => tv(p[i + 1].time, s));
    },
  },
  {
    id: "kalman",
    label: "カルマンフィルタ",
    group: "regime",
    color: "#0ea5e9",
    scaleId: "price",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanFilter(c);
      return r.filteredState.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "kalman_upper",
    label: "カルマン上限",
    group: "regime",
    color: "#7dd3fc",
    scaleId: "price",
    type: "line",
    lineStyle: 2,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanFilter(c);
      return r.upperBand.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "kalman_lower",
    label: "カルマン下限",
    group: "regime",
    color: "#7dd3fc",
    scaleId: "price",
    type: "line",
    lineStyle: 2,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanFilter(c);
      return r.lowerBand.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "kalman_innov",
    label: "カルマン予測誤差",
    group: "regime",
    color: "#f97316",
    scaleId: "kalman_innov",
    type: "histogram",
    colorFn: upDown,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanFilter(c);
      return r.innovation.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "kalman_gain",
    label: "カルマンゲイン",
    group: "regime",
    color: "#8b5cf6",
    scaleId: "kalman_gain",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanFilter(c);
      return r.filterGain.map((v, i) => tv(p[i].time, v));
    },
  },

  // ====== 2状態カルマン ======
  {
    id: "kalman2_price",
    label: "カルマン2状態",
    group: "regime",
    color: "#059669",
    scaleId: "price",
    type: "line",
    lineWidth: 2,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanFilter2State(c);
      return r.filteredPrice.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "kalman2_upper",
    label: "カルマン2状態上限",
    group: "regime",
    color: "#6ee7b7",
    scaleId: "price",
    type: "line",
    lineStyle: 2,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanFilter2State(c);
      return r.upperBand.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "kalman2_lower",
    label: "カルマン2状態下限",
    group: "regime",
    color: "#6ee7b7",
    scaleId: "price",
    type: "line",
    lineStyle: 2,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanFilter2State(c);
      return r.lowerBand.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "kalman2_velocity",
    label: "トレンド速度",
    group: "regime",
    color: "#10b981",
    scaleId: "kalman_vel",
    type: "histogram",
    colorFn: upDown,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanFilter2State(c);
      return r.filteredVelocity.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "kalman2_innov",
    label: "2状態予測誤差",
    group: "regime",
    color: "#f43f5e",
    scaleId: "kalman_innov",
    type: "histogram",
    colorFn: upDown,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanFilter2State(c);
      return r.innovation.map((v, i) => tv(p[i].time, v));
    },
  },

  // ====== 適応型カルマン ======
  {
    id: "akalman",
    label: "適応型カルマン",
    group: "regime",
    color: "#d946ef",
    scaleId: "price",
    type: "line",
    lineWidth: 2,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = adaptiveKalmanFilter(c);
      return r.filteredState.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "akalman_upper",
    label: "適応型カルマン上限",
    group: "regime",
    color: "#e879f9",
    scaleId: "price",
    type: "line",
    lineStyle: 2,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = adaptiveKalmanFilter(c);
      return r.upperBand.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "akalman_lower",
    label: "適応型カルマン下限",
    group: "regime",
    color: "#e879f9",
    scaleId: "price",
    type: "line",
    lineStyle: 2,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = adaptiveKalmanFilter(c);
      return r.lowerBand.map((v, i) => tv(p[i].time, v));
    },
  },
  // ====== 3状態カルマン ======
  {
    id: "kalman3_price",
    label: "カルマン3状態",
    group: "regime",
    color: "#0d9488",
    scaleId: "price",
    type: "line",
    lineWidth: 2,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanFilter3State(c);
      return r.filteredPrice.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "kalman3_velocity",
    label: "3状態速度",
    group: "regime",
    color: "#14b8a6",
    scaleId: "kalman_vel",
    type: "histogram",
    colorFn: upDown,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanFilter3State(c);
      return r.filteredVelocity.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "kalman3_accel",
    label: "加速度",
    group: "regime",
    color: "#f97316",
    scaleId: "kalman_accel",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanFilter3State(c);
      return r.filteredAcceleration.map((v, i) => tv(p[i].time, v));
    },
  },

  // ====== カルマンスムーザー ======
  {
    id: "smoother_price",
    label: "スムーザー",
    group: "regime",
    color: "#dc2626",
    scaleId: "price",
    type: "line",
    lineWidth: 2,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanSmoother(c);
      return r.smoothedPrice.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "smoother_upper",
    label: "スムーザー上限",
    group: "regime",
    color: "#fca5a5",
    scaleId: "price",
    type: "line",
    lineStyle: 2,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanSmoother(c);
      return r.smoothedUpperBand.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "smoother_lower",
    label: "スムーザー下限",
    group: "regime",
    color: "#fca5a5",
    scaleId: "price",
    type: "line",
    lineStyle: 2,
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanSmoother(c);
      return r.smoothedLowerBand.map((v, i) => tv(p[i].time, v));
    },
  },
  {
    id: "smoother_velocity",
    label: "平滑化速度",
    group: "regime",
    color: "#b91c1c",
    scaleId: "kalman_vel",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      const r = kalmanSmoother(c);
      return r.smoothedVelocity.map((v, i) => tv(p[i].time, v));
    },
  },

  // ====== SSA分解 ======
  {
    id: "ssa_trend",
    label: "SSAトレンド",
    group: "decomp",
    color: "#2563eb",
    scaleId: "price",
    type: "line",
    lineWidth: 2,
    compute: (p) => {
      const recent = p.slice(-1000);
      const c = recent.map((x) => x.close);
      if (c.length < 60) return [];
      const r = computeSSA(c);
      if (r.trend.length !== c.length) return [];
      return r.trend.map((v, i) => tv(recent[i].time, v));
    },
  },
  {
    id: "ssa_periodic",
    label: "SSA周期成分",
    group: "decomp",
    color: "#7c3aed",
    scaleId: "ssa_osc",
    type: "line",
    compute: (p) => {
      const recent = p.slice(-1000);
      const c = recent.map((x) => x.close);
      if (c.length < 60) return [];
      const r = computeSSA(c);
      if (r.periodic.length !== c.length) return [];
      return r.periodic.map((v, i) => tv(recent[i].time, v));
    },
  },
  {
    id: "ssa_noise",
    label: "SSAノイズ",
    group: "decomp",
    color: "#9ca3af",
    scaleId: "ssa_osc",
    type: "line",
    compute: (p) => {
      const recent = p.slice(-1000);
      const c = recent.map((x) => x.close);
      if (c.length < 60) return [];
      const r = computeSSA(c);
      if (r.noise.length !== c.length) return [];
      return r.noise.map((v, i) => tv(recent[i].time, v));
    },
  },

  // ====== エントロピー ======
  {
    id: "ent_shannon",
    label: "Shannonエントロピー",
    group: "entropy",
    color: "#2563eb",
    scaleId: "ent_sh",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 60) return [];
      return rollingEntropy(lr, times).map((x) => tv(x.time, x.shannon));
    },
  },
  {
    id: "ent_perm",
    label: "順列エントロピー",
    group: "entropy",
    color: "#0891b2",
    scaleId: "ent_pe",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 60) return [];
      return rollingEntropy(lr, times).map((x) => tv(x.time, x.permutation));
    },
  },
  {
    id: "ent_renyi",
    label: "Rényiエントロピー",
    group: "entropy",
    color: "#7c3aed",
    scaleId: "ent_re",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 60) return [];
      return rollingRenyi(lr, times).map((x) => tv(x.time, x.value));
    },
  },
  {
    id: "ent_tsallis",
    label: "Tsallisエントロピー",
    group: "entropy",
    color: "#db2777",
    scaleId: "ent_ts",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 60) return [];
      return rollingTsallis(lr, times).map((x) => tv(x.time, x.value));
    },
  },
  {
    id: "ent_apen",
    label: "近似エントロピー",
    group: "entropy",
    color: "#ea580c",
    scaleId: "ent_ap",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 60) return [];
      return rollingApEn(lr, times).map((x) => tv(x.time, x.value));
    },
  },
  {
    id: "ent_wpe",
    label: "重み付順列エントロピー",
    group: "entropy",
    color: "#16a34a",
    scaleId: "ent_wpe",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 60) return [];
      return rollingWeightedPE(lr, times).map((x) => tv(x.time, x.value));
    },
  },
  {
    id: "ent_cond",
    label: "条件付エントロピー",
    group: "entropy",
    color: "#0d9488",
    scaleId: "ent_cond",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 62) return [];
      // 1期ラグの条件付エントロピー H(r_t | r_{t-1})
      const x = lr.slice(1);
      const y = lr.slice(0, -1);
      return rollingConditionalEntropy(x, y, times.slice(1)).map((d) =>
        tv(d.time, d.value)
      );
    },
  },
  {
    id: "spectral_entropy",
    label: "スペクトルエントロピー",
    group: "entropy",
    color: "#9333ea",
    scaleId: "ent_spec",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      if (c.length < 80) return [];
      const r = rollingSpectralEntropy(c);
      return r.indices.map((idx, k) => tv(p[idx].time, r.entropy[k]));
    },
  },

  // ====== 複雑性 ======
  {
    id: "ce_pe",
    label: "複雑性-順列エントロピー",
    group: "complexity",
    color: "#2563eb",
    scaleId: "ce_pe",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 60) return [];
      return rollingCEPlane(lr, times).map((x) => tv(x.time, x.pe));
    },
  },
  {
    id: "ce_sc",
    label: "統計的複雑性",
    group: "complexity",
    color: "#dc2626",
    scaleId: "ce_sc",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 60) return [];
      return rollingCEPlane(lr, times).map((x) => tv(x.time, x.sc));
    },
  },
  {
    id: "ais",
    label: "能動情報蓄積",
    group: "complexity",
    color: "#7c3aed",
    scaleId: "ais",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 60) return [];
      return rollingAIS(lr, times).map((x) => tv(x.time, x.value));
    },
  },
  {
    id: "predictability",
    label: "予測可能性指数",
    group: "complexity",
    color: "#16a34a",
    scaleId: "predict",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 60) return [];
      return rollingPredictability(lr, times).map((x) => tv(x.time, x.value));
    },
  },
  {
    id: "info_ratio",
    label: "情報比(スケール)",
    group: "complexity",
    color: "#ea580c",
    scaleId: "inforatio",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 120) return [];
      return rollingInfoRatio(lr, times).map((x) => tv(x.time, x.value));
    },
  },

  // ====== 平均回帰 ======
  {
    id: "half_life",
    label: "平均回帰半減期",
    group: "meanrev",
    color: "#0891b2",
    scaleId: "halflife",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      const times = p.map((x) => x.time);
      if (c.length < 61) return [];
      return rollingHalfLife(c, times).map((x) => tv(x.time, x.halfLife));
    },
  },

  // ====== 構造変化 ======
  {
    id: "rolling_adf",
    label: "ローリングADF統計量",
    group: "break",
    color: "#2563eb",
    scaleId: "adf",
    type: "line",
    compute: (p) => {
      const c = p.map((x) => x.close);
      const times = p.map((x) => x.time);
      if (c.length < 253) return [];
      return unitRootTest(c, times).rollingADF.map((x) => tv(x.time, x.stat));
    },
  },
  {
    id: "bocpd_prob",
    label: "変化点確率(BOCPD)",
    group: "break",
    color: "#dc2626",
    scaleId: "prob",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 30) return [];
      const r = computeBOCPD(lr, times);
      return r.changeProbability.map((v, i) => tv(times[i], v));
    },
  },
  {
    id: "cusum",
    label: "CUSUM",
    group: "break",
    color: "#7c3aed",
    scaleId: "cusum",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 60) return [];
      return detectStructuralBreaks(lr, times).cusum.map((x) =>
        tv(x.time, x.value)
      );
    },
  },

  // ====== マイクロ構造 ======
  {
    id: "roll_spread",
    label: "Rollスプレッド(bps)",
    group: "micro",
    color: "#0891b2",
    scaleId: "spread",
    type: "line",
    compute: (p) => rollSpread(p).rollingSpread.map((x) => tv(x.time, x.spread)),
  },
  {
    id: "amihud",
    label: "Amihud非流動性",
    group: "micro",
    color: "#ea580c",
    scaleId: "amihud",
    type: "line",
    compute: (p) =>
      amihudIlliquidity(p).rollingAmihud.map((x) => tv(x.time, x.amihud)),
  },

  // ====== 行動ファイナンス ======
  {
    id: "anchoring_ratio",
    label: "アンカリング比率(52週高値)",
    group: "behavioral",
    color: "#db2777",
    scaleId: "anchor",
    type: "line",
    compute: (p) =>
      anchoringAnalysis(p).rollingRatio.map((x) => tv(x.time, x.ratio)),
  },

  // ====== ARIMA(自己回帰AR・移動平均MA・差分Iを個別に) ======
  // --- 自己回帰過程 AR(p)（対数リターン基準、次数はBIC自動選択）---
  {
    id: "ar_process_fitted",
    label: "自己回帰AR 当てはめ値(対数R)",
    group: "arima",
    color: "#2563eb",
    scaleId: "arima_lr",
    type: "line",
    lineStyle: 2,
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 30) return [];
      const ar = fitAR(lr);
      const out: TimeValue[] = [];
      // 当てはめ値 = 実測値 − 残差（1期先予測）
      for (let t = ar.order; t < lr.length; t++) {
        out.push(tv(times[t], lr[t] - ar.residuals[t]));
      }
      return out;
    },
  },
  {
    id: "ar_process_resid",
    label: "自己回帰AR 残差(対数R)",
    group: "arima",
    color: "#60a5fa",
    scaleId: "arima_lr",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 30) return [];
      const ar = fitAR(lr);
      const out: TimeValue[] = [];
      for (let t = ar.order; t < lr.length; t++) {
        out.push(tv(times[t], ar.residuals[t]));
      }
      return out;
    },
  },
  // --- 移動平均過程 MA(q)（対数リターン基準、次数はBIC自動選択）---
  {
    id: "ma_process_fitted",
    label: "移動平均MA 当てはめ値(対数R)",
    group: "arima",
    color: "#dc2626",
    scaleId: "arima_lr",
    type: "line",
    lineStyle: 2,
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 50) return [];
      const fit = bestMaFit(lr);
      if (!fit) return [];
      const out: TimeValue[] = [];
      for (let i = 0; i < fit.fitted.length && i < times.length; i++) {
        if (!Number.isNaN(fit.fitted[i])) out.push(tv(times[i], fit.fitted[i]));
      }
      return out;
    },
  },
  {
    id: "ma_process_resid",
    label: "移動平均MA 残差(対数R)",
    group: "arima",
    color: "#f87171",
    scaleId: "arima_lr",
    type: "line",
    compute: (p) => {
      const lr = logReturns(p.map((x) => x.close));
      const times = p.slice(1).map((x) => x.time);
      if (lr.length < 50) return [];
      const fit = bestMaFit(lr);
      if (!fit) return [];
      const out: TimeValue[] = [];
      for (let i = 0; i < fit.residuals.length && i < times.length; i++) {
        if (!Number.isNaN(fit.residuals[i])) out.push(tv(times[i], fit.residuals[i]));
      }
      return out;
    },
  },
  // --- 差分過程 I (1階差分 Δclose) ---
  {
    id: "diff_process",
    label: "差分過程(1階差分 Δclose)",
    group: "arima",
    color: "#059669",
    scaleId: "arima_diff",
    type: "line",
    compute: (p) => {
      const out: TimeValue[] = [];
      for (let i = 1; i < p.length; i++) {
        out.push(tv(p[i].time, p[i].close - p[i - 1].close));
      }
      return out;
    },
  },

  // ====== ネットワーク ======
  {
    id: "vg_degree",
    label: "可視グラフ次数",
    group: "network",
    color: "#7c3aed",
    scaleId: "vg_deg",
    type: "line",
    compute: (p) => {
      const recent = p.slice(-750);
      const c = recent.map((x) => x.close);
      const times = recent.map((x) => x.time);
      if (c.length < 30) return [];
      return computeVisibilityGraph(c, times).degreeSeries.map((x) =>
        tv(x.time, x.degree)
      );
    },
  },
  {
    id: "rn_degree",
    label: "再帰NW次数",
    group: "network",
    color: "#0891b2",
    scaleId: "rn_deg",
    type: "line",
    compute: (p) => {
      const recent = p.slice(-500);
      const c = recent.map((x) => x.close);
      if (c.length < 30) return [];
      const r = computeRecurrenceNetwork(c);
      return r.degreeSeries.map((v, i) => tv(recent[i].time, v));
    },
  },
  {
    id: "rn_clustering",
    label: "再帰NWクラスタ係数",
    group: "network",
    color: "#16a34a",
    scaleId: "rn_clust",
    type: "line",
    compute: (p) => {
      const recent = p.slice(-500);
      const c = recent.map((x) => x.close);
      if (c.length < 30) return [];
      const r = computeRecurrenceNetwork(c);
      return r.localClustering.map((v, i) => tv(recent[i].time, v));
    },
  },
];

export const DEFAULT_ENABLED = new Set(["candle", "volume"]);
