// 追加テクニカル指標: SAR, CCI, Williams %R

import { PricePoint } from "./types";

export interface SARPoint {
  time: string;
  value: number;
  trend: "up" | "down";
}

export interface SARResult {
  points: SARPoint[];
  currentTrend: "up" | "down";
  interpretation: string;
}

export interface CCIPoint {
  time: string;
  value: number;
}

export interface CCIResult {
  values: CCIPoint[];
  current: number;
  interpretation: string;
}

export interface WilliamsRPoint {
  time: string;
  value: number;
}

export interface WilliamsRResult {
  values: WilliamsRPoint[];
  current: number;
  interpretation: string;
}

export interface ExtraTechnicalResult {
  sar: SARResult;
  cci: CCIResult;
  williamsR: WilliamsRResult;
}

// --- Parabolic SAR ---
export function parabolicSAR(prices: PricePoint[], afStep: number = 0.02, afMax: number = 0.2): SARResult {
  const n = prices.length;
  if (n < 10) return emptySAR();

  const points: SARPoint[] = [];
  let trend: "up" | "down" = prices[1].close > prices[0].close ? "up" : "down";
  let af = afStep;
  let ep = trend === "up" ? prices[0].high : prices[0].low;
  let sar = trend === "up" ? prices[0].low : prices[0].high;

  for (let i = 1; i < n; i++) {
    const prevSar = sar;

    // Update SAR
    sar = prevSar + af * (ep - prevSar);

    // Check for trend reversal
    if (trend === "up") {
      sar = Math.min(sar, prices[i - 1].low);
      if (i >= 2) sar = Math.min(sar, prices[i - 2].low);

      if (prices[i].low < sar) {
        trend = "down";
        sar = ep;
        ep = prices[i].low;
        af = afStep;
      } else {
        if (prices[i].high > ep) {
          ep = prices[i].high;
          af = Math.min(af + afStep, afMax);
        }
      }
    } else {
      sar = Math.max(sar, prices[i - 1].high);
      if (i >= 2) sar = Math.max(sar, prices[i - 2].high);

      if (prices[i].high > sar) {
        trend = "up";
        sar = ep;
        ep = prices[i].high;
        af = afStep;
      } else {
        if (prices[i].low < ep) {
          ep = prices[i].low;
          af = Math.min(af + afStep, afMax);
        }
      }
    }

    points.push({ time: prices[i].time, value: sar, trend });
  }

  const currentTrend = points.length > 0 ? points[points.length - 1].trend : "up";
  const interpretation = currentTrend === "up"
    ? `パラボリックSAR: 上昇トレンド中。SARが価格の下に位置。`
    : `パラボリックSAR: 下降トレンド中。SARが価格の上に位置。`;

  return { points, currentTrend, interpretation };
}

// --- CCI (Commodity Channel Index) ---
// CCI = (TP - SMA(TP, n)) / (0.015 × MAD)
// TP = (H + L + C) / 3
export function cci(prices: PricePoint[], period: number = 20): CCIResult {
  const n = prices.length;
  if (n < period + 5) return emptyCCI();

  const tp = prices.map(p => (p.high + p.low + p.close) / 3);
  const values: CCIPoint[] = [];

  for (let i = period - 1; i < n; i++) {
    const slice = tp.slice(i - period + 1, i + 1);
    const sma = slice.reduce((s, v) => s + v, 0) / period;

    // Mean Absolute Deviation
    let mad = 0;
    for (const v of slice) mad += Math.abs(v - sma);
    mad /= period;

    const cciVal = mad > 0 ? (tp[i] - sma) / (0.015 * mad) : 0;
    values.push({ time: prices[i].time, value: cciVal });
  }

  const current = values.length > 0 ? values[values.length - 1].value : 0;
  const interpretation = current > 100
    ? `CCI=${current.toFixed(1)}。買われすぎゾーン（>100）。反転下落の可能性。`
    : current < -100
      ? `CCI=${current.toFixed(1)}。売られすぎゾーン（<-100）。反転上昇の可能性。`
      : `CCI=${current.toFixed(1)}。中立ゾーン。`;

  return { values, current, interpretation };
}

// --- Williams %R ---
// %R = (HH - Close) / (HH - LL) × (-100)
export function williamsR(prices: PricePoint[], period: number = 14): WilliamsRResult {
  const n = prices.length;
  if (n < period + 5) return emptyWR();

  const values: WilliamsRPoint[] = [];

  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (prices[j].high > hh) hh = prices[j].high;
      if (prices[j].low < ll) ll = prices[j].low;
    }

    const range = hh - ll;
    const wr = range > 0 ? ((hh - prices[i].close) / range) * -100 : -50;
    values.push({ time: prices[i].time, value: wr });
  }

  const current = values.length > 0 ? values[values.length - 1].value : -50;
  const interpretation = current > -20
    ? `%R=${current.toFixed(1)}。買われすぎゾーン（> -20）。`
    : current < -80
      ? `%R=${current.toFixed(1)}。売られすぎゾーン（< -80）。`
      : `%R=${current.toFixed(1)}。中立。`;

  return { values, current, interpretation };
}

// --- 統合 ---
export function extraTechnical(prices: PricePoint[]): ExtraTechnicalResult {
  return {
    sar: parabolicSAR(prices),
    cci: cci(prices),
    williamsR: williamsR(prices),
  };
}

function emptySAR(): SARResult {
  return { points: [], currentTrend: "up", interpretation: "データ不足" };
}
function emptyCCI(): CCIResult {
  return { values: [], current: 0, interpretation: "データ不足" };
}
function emptyWR(): WilliamsRResult {
  return { values: [], current: -50, interpretation: "データ不足" };
}
