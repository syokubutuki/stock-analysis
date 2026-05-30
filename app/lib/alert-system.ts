import { PricePoint } from "./types";

// ─── Interfaces ─────────────────────────────────────────────────────

export interface AlertItem {
  type: "volatility" | "distribution" | "regime" | "entropy" | "volume";
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  value: string;
  date?: string;
}

// ─── Helper functions ───────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += (arr[i] - m) ** 2;
  return Math.sqrt(s / (arr.length - 1));
}

function kurtosis(arr: number[]): number {
  if (arr.length < 4) return 0;
  const m = mean(arr);
  const n = arr.length;
  let m2 = 0, m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = arr[i] - m;
    m2 += d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m4 /= n;
  return m2 > 0 ? m4 / (m2 * m2) : 0;
}

function logReturns(prices: PricePoint[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    r.push(Math.log(prices[i].close / prices[i - 1].close));
  }
  return r;
}

function computeRSI(closes: number[], period: number): number[] {
  const rsi: number[] = [];
  if (closes.length < period + 1) return rsi;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += -diff;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = 0; i < period; i++) rsi.push(NaN);
  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

// ─── Main function ──────────────────────────────────────────────────

export function computeAlerts(prices: PricePoint[]): AlertItem[] {
  const alerts: AlertItem[] = [];

  if (prices.length < 10) return alerts;

  const ret = logReturns(prices);
  const n = ret.length;
  const lastDate = prices[prices.length - 1].time;

  // ── 1. Volatility spike: 5-day vol > 2x 60-day vol ──
  if (n >= 60) {
    const vol5 = stddev(ret.slice(-5));
    const vol60 = stddev(ret.slice(-60));
    if (vol60 > 0 && vol5 > 2 * vol60) {
      alerts.push({
        type: "volatility",
        severity: "critical",
        title: "Volatility Spike",
        description: `5-day volatility (${(vol5 * 100).toFixed(2)}%) is more than 2x the 60-day volatility (${(vol60 * 100).toFixed(2)}%).`,
        value: `${(vol5 / vol60).toFixed(2)}x`,
        date: lastDate,
      });
    }
  }

  // ── 2. Volatility compression: 5-day vol < 0.5x 60-day vol ──
  if (n >= 60) {
    const vol5 = stddev(ret.slice(-5));
    const vol60 = stddev(ret.slice(-60));
    if (vol60 > 0 && vol5 < 0.5 * vol60) {
      alerts.push({
        type: "volatility",
        severity: "warning",
        title: "Volatility Compression",
        description: `5-day volatility (${(vol5 * 100).toFixed(2)}%) is less than half the 60-day volatility (${(vol60 * 100).toFixed(2)}%). Potential breakout ahead.`,
        value: `${(vol5 / vol60).toFixed(2)}x`,
        date: lastDate,
      });
    }
  }

  // ── 3. Distribution shift: rolling 20-day kurtosis > 5 ──
  if (n >= 20) {
    const recent20 = ret.slice(-20);
    const kurt = kurtosis(recent20);
    if (kurt > 5) {
      alerts.push({
        type: "distribution",
        severity: "warning",
        title: "Distribution Shift",
        description: `Rolling 20-day kurtosis is ${kurt.toFixed(2)}, indicating fat tails are emerging in the return distribution.`,
        value: kurt.toFixed(2),
        date: lastDate,
      });
    }
  }

  // ── 4. Extreme return: last return > 3σ ──
  if (n >= 20) {
    const lastReturn = ret[n - 1];
    const sigma = stddev(ret.slice(-60 > 0 ? Math.max(0, n - 60) : 0));
    if (sigma > 0 && Math.abs(lastReturn) > 3 * sigma) {
      alerts.push({
        type: "distribution",
        severity: "critical",
        title: "Extreme Return",
        description: `Last return of ${(lastReturn * 100).toFixed(2)}% exceeds 3 standard deviations (${(3 * sigma * 100).toFixed(2)}%).`,
        value: `${(lastReturn / sigma).toFixed(2)}σ`,
        date: lastDate,
      });
    }
  }

  // ── 5. Volume anomaly: last volume > 3x 20-day avg ──
  if (prices.length >= 21) {
    const lastVolume = prices[prices.length - 1].volume;
    const recentVolumes: number[] = [];
    for (let i = prices.length - 21; i < prices.length - 1; i++) {
      recentVolumes.push(prices[i].volume);
    }
    const avgVol = mean(recentVolumes);
    if (avgVol > 0 && lastVolume > 3 * avgVol) {
      alerts.push({
        type: "volume",
        severity: "warning",
        title: "Volume Anomaly",
        description: `Last volume (${lastVolume.toLocaleString()}) is more than 3x the 20-day average (${Math.round(avgVol).toLocaleString()}).`,
        value: `${(lastVolume / avgVol).toFixed(2)}x`,
        date: lastDate,
      });
    }
  }

  // ── 6. Drawdown alert ──
  {
    const closes = prices.map(p => p.close);
    let peak = closes[0];
    let currentDD = 0;
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > peak) peak = closes[i];
      const dd = (peak - closes[i]) / peak;
      currentDD = dd;
    }
    if (currentDD > 0.2) {
      alerts.push({
        type: "regime",
        severity: "critical",
        title: "Severe Drawdown",
        description: `Current drawdown from peak is ${(currentDD * 100).toFixed(1)}%, exceeding 20%.`,
        value: `${(currentDD * 100).toFixed(1)}%`,
        date: lastDate,
      });
    } else if (currentDD > 0.1) {
      alerts.push({
        type: "regime",
        severity: "warning",
        title: "Drawdown Alert",
        description: `Current drawdown from peak is ${(currentDD * 100).toFixed(1)}%, exceeding 10%.`,
        value: `${(currentDD * 100).toFixed(1)}%`,
        date: lastDate,
      });
    }
  }

  // ── 7. Trend exhaustion: RSI(14) > 80 or < 20 ──
  {
    const closes = prices.map(p => p.close);
    const rsi = computeRSI(closes, 14);
    if (rsi.length > 0) {
      const lastRSI = rsi[rsi.length - 1];
      if (!isNaN(lastRSI)) {
        if (lastRSI > 80) {
          alerts.push({
            type: "regime",
            severity: "warning",
            title: "Trend Exhaustion (Overbought)",
            description: `RSI(14) is ${lastRSI.toFixed(1)}, indicating overbought conditions and potential reversal.`,
            value: lastRSI.toFixed(1),
            date: lastDate,
          });
        } else if (lastRSI < 20) {
          alerts.push({
            type: "regime",
            severity: "warning",
            title: "Trend Exhaustion (Oversold)",
            description: `RSI(14) is ${lastRSI.toFixed(1)}, indicating oversold conditions and potential reversal.`,
            value: lastRSI.toFixed(1),
            date: lastDate,
          });
        }
      }
    }
  }

  // ── 8. Volatility regime change: 5-day vol crossed above/below 20-day vol in last 5 days ──
  if (n >= 25) {
    // Check for crossover in the last 5 days
    let crossDetected = false;
    let crossDirection = "";
    for (let i = n - 5; i < n; i++) {
      if (i < 20) continue;
      const vol5_prev = stddev(ret.slice(i - 5, i));
      const vol20_prev = stddev(ret.slice(i - 20, i));
      const vol5_curr = stddev(ret.slice(i - 4, i + 1));
      const vol20_curr = stddev(ret.slice(i - 19, i + 1));

      const prevAbove = vol5_prev > vol20_prev;
      const currAbove = vol5_curr > vol20_curr;

      if (!prevAbove && currAbove) {
        crossDetected = true;
        crossDirection = "above";
        break;
      } else if (prevAbove && !currAbove) {
        crossDetected = true;
        crossDirection = "below";
        break;
      }
    }

    if (crossDetected) {
      alerts.push({
        type: "volatility",
        severity: "info",
        title: "Volatility Regime Change",
        description: `5-day volatility crossed ${crossDirection} 20-day volatility in the last 5 trading days, indicating a potential regime shift.`,
        value: crossDirection,
        date: lastDate,
      });
    }
  }

  return alerts;
}
