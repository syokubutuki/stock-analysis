import { PricePoint } from "./types";

// --- EMA ---
function ema(values: number[], period: number): number[] {
  const result: number[] = [];
  if (values.length === 0) return result;
  const k = 2 / (period + 1);
  result.push(values[0]);
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

// --- RSI (Relative Strength Index) ---
export interface RSIPoint {
  time: string;
  value: number;
}

export function computeRSI(prices: PricePoint[], period: number = 14): RSIPoint[] {
  const closes = prices.map((p) => p.close);
  if (closes.length < period + 1) return [];

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  // Wilder's smoothing (exponential)
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const result: RSIPoint[] = [];
  // First RSI value at index period (0-based from gains, = period+1 from prices)
  const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
  result.push({
    time: prices[period].time,
    value: 100 - 100 / (1 + rs),
  });

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
    result.push({
      time: prices[i + 1].time,
      value: 100 - 100 / (1 + rs),
    });
  }

  return result;
}

// --- MACD ---
export interface MACDPoint {
  time: string;
  macd: number;
  signal: number;
  histogram: number;
}

export function computeMACD(
  prices: PricePoint[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): MACDPoint[] {
  const closes = prices.map((p) => p.close);
  if (closes.length < slowPeriod + signalPeriod) return [];

  const fastEMA = ema(closes, fastPeriod);
  const slowEMA = ema(closes, slowPeriod);

  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(fastEMA[i] - slowEMA[i]);
  }

  const signalLine = ema(macdLine, signalPeriod);

  const result: MACDPoint[] = [];
  // Skip initial unstable period
  const start = slowPeriod - 1;
  for (let i = start; i < closes.length; i++) {
    result.push({
      time: prices[i].time,
      macd: macdLine[i],
      signal: signalLine[i],
      histogram: macdLine[i] - signalLine[i],
    });
  }

  return result;
}

// --- Bollinger Bands ---
export interface BollingerPoint {
  time: string;
  middle: number;
  upper: number;
  lower: number;
  bandwidth: number; // (upper - lower) / middle
  percentB: number;  // (close - lower) / (upper - lower)
  close: number;
}

export function computeBollinger(
  prices: PricePoint[],
  period: number = 20,
  multiplier: number = 2
): BollingerPoint[] {
  const result: BollingerPoint[] = [];
  for (let i = period - 1; i < prices.length; i++) {
    const slice = prices.slice(i - period + 1, i + 1);
    const closes = slice.map((p) => p.close);
    const mean = closes.reduce((a, b) => a + b, 0) / period;
    const variance = closes.reduce((a, v) => a + (v - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    const upper = mean + multiplier * std;
    const lower = mean - multiplier * std;
    const bandwidth = mean > 0 ? (upper - lower) / mean : 0;
    const range = upper - lower;
    const percentB = range > 0 ? (prices[i].close - lower) / range : 0.5;

    result.push({
      time: prices[i].time,
      middle: mean,
      upper,
      lower,
      bandwidth,
      percentB,
      close: prices[i].close,
    });
  }
  return result;
}

// --- Signal detection ---
export interface TechnicalSignal {
  type: "buy" | "sell" | "info";
  indicator: string;
  message: string;
  time: string;
}

export function detectSignals(
  prices: PricePoint[],
  rsi: RSIPoint[],
  macd: MACDPoint[],
  bollinger: BollingerPoint[]
): TechnicalSignal[] {
  const signals: TechnicalSignal[] = [];

  // RSI signals (latest)
  if (rsi.length >= 2) {
    const last = rsi[rsi.length - 1];
    const prev = rsi[rsi.length - 2];
    if (last.value < 30 && prev.value >= 30) {
      signals.push({ type: "buy", indicator: "RSI", message: `RSI が 30 を下回った (${last.value.toFixed(1)}) → 売られすぎ`, time: last.time });
    }
    if (last.value > 70 && prev.value <= 70) {
      signals.push({ type: "sell", indicator: "RSI", message: `RSI が 70 を上回った (${last.value.toFixed(1)}) → 買われすぎ`, time: last.time });
    }
    if (last.value <= 30) {
      signals.push({ type: "info", indicator: "RSI", message: `RSI 売られすぎ圏 (${last.value.toFixed(1)})`, time: last.time });
    } else if (last.value >= 70) {
      signals.push({ type: "info", indicator: "RSI", message: `RSI 買われすぎ圏 (${last.value.toFixed(1)})`, time: last.time });
    }
  }

  // MACD crossover signals
  if (macd.length >= 2) {
    const last = macd[macd.length - 1];
    const prev = macd[macd.length - 2];
    if (prev.macd <= prev.signal && last.macd > last.signal) {
      signals.push({ type: "buy", indicator: "MACD", message: "MACD がシグナル線を上抜け (ゴールデンクロス)", time: last.time });
    }
    if (prev.macd >= prev.signal && last.macd < last.signal) {
      signals.push({ type: "sell", indicator: "MACD", message: "MACD がシグナル線を下抜け (デッドクロス)", time: last.time });
    }
  }

  // Bollinger signals
  if (bollinger.length >= 1) {
    const last = bollinger[bollinger.length - 1];
    if (last.percentB > 1) {
      signals.push({ type: "sell", indicator: "BB", message: `株価がバンド上限を突破 (%B: ${(last.percentB * 100).toFixed(1)}%)`, time: last.time });
    } else if (last.percentB < 0) {
      signals.push({ type: "buy", indicator: "BB", message: `株価がバンド下限を突破 (%B: ${(last.percentB * 100).toFixed(1)}%)`, time: last.time });
    }
    if (last.bandwidth < 0.05) {
      signals.push({ type: "info", indicator: "BB", message: `バンド幅収縮中 (Squeeze) → ブレイクアウト警戒`, time: last.time });
    }
  }

  return signals;
}
