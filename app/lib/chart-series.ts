import { PricePoint } from "./types";
import { computeTrendSeries } from "./trend-analysis";
import { computeRSI, computeMACD, computeBollinger } from "./technical-indicators";
import { computeIchimoku } from "./ichimoku";
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
import { fitHMM, kalmanFilter } from "./regime";

// ---- Types ----

export interface TimeValue {
  time: string;
  value: number;
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
  { id: "ichimoku", label: "一目均衡表" },
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
];

// ---- Helpers ----

const tv = (time: string, value: number): TimeValue => ({ time, value });
const green = "rgba(38,166,154,0.6)";
const red = "rgba(239,83,80,0.6)";
const upDown = (v: number) => (v >= 0 ? green : red);

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
    color: "#6366f1",
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

  // ====== 一目均衡表 ======
  {
    id: "ichi_tenkan",
    label: "転換線",
    group: "ichimoku",
    color: "#3b82f6",
    scaleId: "price",
    type: "line",
    compute: (p) => {
      const { current } = computeIchimoku(p);
      return current.filter((x) => x.tenkan !== null).map((x) => tv(x.time, x.tenkan!));
    },
  },
  {
    id: "ichi_kijun",
    label: "基準線",
    group: "ichimoku",
    color: "#ef4444",
    scaleId: "price",
    type: "line",
    compute: (p) => {
      const { current } = computeIchimoku(p);
      return current.filter((x) => x.kijun !== null).map((x) => tv(x.time, x.kijun!));
    },
  },
  {
    id: "ichi_senkouA",
    label: "先行スパン1",
    group: "ichimoku",
    color: "rgba(34,197,94,0.5)",
    scaleId: "price",
    type: "line",
    compute: (p) => {
      const { current, leading } = computeIchimoku(p);
      const data = current
        .filter((x) => x.senkouA !== null)
        .map((x) => tv(x.time, x.senkouA!));
      for (const l of leading) data.push(tv(l.time, l.senkouA));
      return data;
    },
  },
  {
    id: "ichi_senkouB",
    label: "先行スパン2",
    group: "ichimoku",
    color: "rgba(239,68,68,0.5)",
    scaleId: "price",
    type: "line",
    compute: (p) => {
      const { current, leading } = computeIchimoku(p);
      const data = current
        .filter((x) => x.senkouB !== null)
        .map((x) => tv(x.time, x.senkouB!));
      for (const l of leading) data.push(tv(l.time, l.senkouB));
      return data;
    },
  },
  {
    id: "ichi_chikou",
    label: "遅行スパン",
    group: "ichimoku",
    color: "#a855f7",
    scaleId: "price",
    type: "line",
    lineStyle: 2,
    compute: (p) => {
      const { current } = computeIchimoku(p);
      return current.filter((x) => x.chikou !== null).map((x) => tv(x.time, x.chikou!));
    },
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
    colorFn: upDown,
    compute: (p) => {
      const bars = analyzeVolume(p);
      return bars.map((b) => tv(b.time, b.volume));
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
    scaleId: "tda",
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
    scaleId: "tda",
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
    scaleId: "tda",
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
];

export const DEFAULT_ENABLED = new Set(["candle"]);
