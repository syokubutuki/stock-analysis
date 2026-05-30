// Volume-Price Dynamics: Volume-Return Joint, Volume Leading, Volume-Weighted Technical

import { PricePoint } from "./types";

// ========== Helpers ==========

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function stddev(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
}

function skewness(v: number[]): number {
  if (v.length < 3) return 0;
  const m = mean(v);
  const s = stddev(v);
  if (s === 0) return 0;
  return (v.reduce((a, x) => a + ((x - m) / s) ** 3, 0)) / v.length;
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const va = a[i] - ma;
    const vb = b[i] - mb;
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

// ========== A. Volume-Return Joint Analysis ==========

export interface VolumeReturnBucket {
  label: string;
  volumeRange: [number, number];
  returns: number[];
  mean: number;
  std: number;
  skew: number;
  n: number;
}

export interface VolumeReturnResult {
  buckets: VolumeReturnBucket[];
  surgeReturns: { threshold: number; meanReturn: number; winRate: number; n: number };
  declineReturns: { threshold: number; meanReturn: number; winRate: number; n: number };
}

export function computeVolumeReturn(prices: PricePoint[]): VolumeReturnResult {
  const empty: VolumeReturnResult = {
    buckets: [],
    surgeReturns: { threshold: 2.0, meanReturn: 0, winRate: 0, n: 0 },
    declineReturns: { threshold: 0.5, meanReturn: 0, winRate: 0, n: 0 },
  };
  if (prices.length < 25) return empty;

  // Compute 20-day MA of volume and relative volume
  const volumes = prices.map(p => p.volume);
  const closes = prices.map(p => p.close);
  const n = prices.length;

  const relVol: number[] = new Array(n).fill(NaN);
  for (let i = 19; i < n; i++) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) sum += volumes[j];
    const ma = sum / 20;
    relVol[i] = ma > 0 ? volumes[i] / ma : NaN;
  }

  // Log returns
  const logReturns: number[] = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      logReturns[i] = Math.log(closes[i] / closes[i - 1]);
    }
  }

  // Collect paired data (relVol[i], logReturns[i]) where both valid
  const paired: { rv: number; lr: number }[] = [];
  for (let i = 20; i < n; i++) {
    if (!isNaN(relVol[i]) && !isNaN(logReturns[i])) {
      paired.push({ rv: relVol[i], lr: logReturns[i] });
    }
  }

  if (paired.length < 4) return empty;

  // Sort by relative volume for quartiles
  const sorted = [...paired].sort((a, b) => a.rv - b.rv);
  const qSize = Math.floor(sorted.length / 4);
  const labels = ["Q1(低)", "Q2", "Q3", "Q4(高)"];

  const buckets: VolumeReturnBucket[] = [];
  for (let q = 0; q < 4; q++) {
    const start = q * qSize;
    const end = q === 3 ? sorted.length : (q + 1) * qSize;
    const slice = sorted.slice(start, end);
    const rets = slice.map(s => s.lr);
    const rvs = slice.map(s => s.rv);
    buckets.push({
      label: labels[q],
      volumeRange: [Math.min(...rvs), Math.max(...rvs)],
      returns: rets,
      mean: mean(rets),
      std: stddev(rets),
      skew: skewness(rets),
      n: rets.length,
    });
  }

  // Surge: relVol > 2.0
  const surgeRets = paired.filter(p => p.rv > 2.0).map(p => p.lr);
  const surgeReturns = {
    threshold: 2.0,
    meanReturn: mean(surgeRets),
    winRate: surgeRets.length > 0 ? surgeRets.filter(r => r > 0).length / surgeRets.length : 0,
    n: surgeRets.length,
  };

  // Decline: relVol < 0.5
  const decRets = paired.filter(p => p.rv < 0.5).map(p => p.lr);
  const declineReturns = {
    threshold: 0.5,
    meanReturn: mean(decRets),
    winRate: decRets.length > 0 ? decRets.filter(r => r > 0).length / decRets.length : 0,
    n: decRets.length,
  };

  return { buckets, surgeReturns, declineReturns };
}

// ========== B. Volume Leading Analysis ==========

export interface VolumeLeadResult {
  crossCorrelations: { lag: number; correlation: number }[];
  volumeChangePrediction: {
    volUp: { meanReturn: number; winRate: number; n: number };
    volDown: { meanReturn: number; winRate: number; n: number };
  };
  volumeACF: number[];
}

export function computeVolumeLead(prices: PricePoint[]): VolumeLeadResult {
  const empty: VolumeLeadResult = {
    crossCorrelations: [],
    volumeChangePrediction: {
      volUp: { meanReturn: 0, winRate: 0, n: 0 },
      volDown: { meanReturn: 0, winRate: 0, n: 0 },
    },
    volumeACF: [],
  };

  if (prices.length < 25) return empty;

  const closes = prices.map(p => p.close);
  const volumes = prices.map(p => p.volume);
  const n = prices.length;

  // Volume changes (pct)
  const volChanges: number[] = [NaN];
  for (let i = 1; i < n; i++) {
    volChanges.push(volumes[i - 1] > 0 ? (volumes[i] - volumes[i - 1]) / volumes[i - 1] : NaN);
  }

  // Log returns
  const logReturns: number[] = [NaN];
  for (let i = 1; i < n; i++) {
    logReturns.push(closes[i] > 0 && closes[i - 1] > 0 ? Math.log(closes[i] / closes[i - 1]) : NaN);
  }

  // Cross-correlogram: lag -10 to +10
  // At lag k: corr(volChanges[t], returns[t+k])
  const crossCorrelations: { lag: number; correlation: number }[] = [];
  for (let lag = -10; lag <= 10; lag++) {
    const a: number[] = [];
    const b: number[] = [];
    for (let t = 1; t < n; t++) {
      const tB = t + lag;
      if (tB >= 1 && tB < n && !isNaN(volChanges[t]) && !isNaN(logReturns[tB])) {
        a.push(volChanges[t]);
        b.push(logReturns[tB]);
      }
    }
    crossCorrelations.push({ lag, correlation: correlation(a, b) });
  }

  // Conditional: volume increases >50% => next day return
  const volUpRets: number[] = [];
  const volDownRets: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (isNaN(volChanges[i]) || isNaN(logReturns[i + 1])) continue;
    if (volChanges[i] > 0.5) {
      volUpRets.push(logReturns[i + 1]);
    } else if (volChanges[i] < -0.5) {
      volDownRets.push(logReturns[i + 1]);
    }
  }

  const volumeChangePrediction = {
    volUp: {
      meanReturn: mean(volUpRets),
      winRate: volUpRets.length > 0 ? volUpRets.filter(r => r > 0).length / volUpRets.length : 0,
      n: volUpRets.length,
    },
    volDown: {
      meanReturn: mean(volDownRets),
      winRate: volDownRets.length > 0 ? volDownRets.filter(r => r > 0).length / volDownRets.length : 0,
      n: volDownRets.length,
    },
  };

  // Volume changes ACF (lags 1-10)
  const validVolChanges = volChanges.filter(v => !isNaN(v));
  const volumeACF: number[] = [];
  const mVC = mean(validVolChanges);
  let varVC = 0;
  for (const v of validVolChanges) varVC += (v - mVC) ** 2;

  for (let lag = 1; lag <= 10; lag++) {
    if (validVolChanges.length <= lag) { volumeACF.push(0); continue; }
    let cov = 0;
    for (let i = 0; i < validVolChanges.length - lag; i++) {
      cov += (validVolChanges[i] - mVC) * (validVolChanges[i + lag] - mVC);
    }
    volumeACF.push(varVC > 0 ? cov / varVC : 0);
  }

  return { crossCorrelations, volumeChangePrediction, volumeACF };
}

// ========== C. Volume-Weighted Technical ==========

export interface VWTechnicalResult {
  dates: string[];
  rsi: number[];
  vwRsi: number[];
  macd: number[];
  vwMacd: number[];
  divergence: { date: string; type: "rsi" | "macd"; standard: number; vw: number; diff: number }[];
}

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

function computeRSI(closes: number[], period: number): number[] {
  const rsi: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return rsi;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function computeVWRSI(closes: number[], volumes: number[], period: number): number[] {
  const rsi: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return rsi;

  let avgGain = 0;
  let avgLoss = 0;
  let totalVol = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    const vol = volumes[i];
    totalVol += vol;
    if (diff > 0) avgGain += diff * vol;
    else avgLoss -= diff * vol;
  }
  if (totalVol > 0) { avgGain /= totalVol; avgLoss /= totalVol; }

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const vol = volumes[i];
    const gain = diff > 0 ? diff * vol : 0;
    const loss = diff < 0 ? -diff * vol : 0;
    // Smooth with volume weight
    const smoothVol = (totalVol / period);
    const w = smoothVol > 0 ? vol / smoothVol : 1;
    const alpha = w / (period - 1 + w);
    avgGain = avgGain * (1 - alpha) + (gain / (vol || 1)) * alpha;
    avgLoss = avgLoss * (1 - alpha) + (loss / (vol || 1)) * alpha;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

export function computeVWTechnical(prices: PricePoint[]): VWTechnicalResult {
  const empty: VWTechnicalResult = { dates: [], rsi: [], vwRsi: [], macd: [], vwMacd: [], divergence: [] };
  if (prices.length < 30) return empty;

  const closes = prices.map(p => p.close);
  const volumes = prices.map(p => p.volume);
  const dates = prices.map(p => p.time);
  const n = prices.length;

  // Standard RSI(14) and VW RSI(14)
  const rsi = computeRSI(closes, 14);
  const vwRsi = computeVWRSI(closes, volumes, 14);

  // Standard MACD: EMA12 - EMA26
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd: number[] = [];
  for (let i = 0; i < n; i++) {
    macd.push(i >= 25 ? ema12[i] - ema26[i] : NaN);
  }

  // Volume-weighted close for VW MACD
  // VW close = cumulative VWAP-like: use volume-weighted EMA
  const vwClose: number[] = [];
  // Approximate: weight each close by its volume in the EMA update
  if (n > 0) {
    vwClose.push(closes[0]);
    for (let i = 1; i < n; i++) {
      // EMA-like but with volume influence on the smoothing factor
      const avgVol = volumes.slice(Math.max(0, i - 19), i + 1).reduce((a, b) => a + b, 0) /
                     Math.min(20, i + 1);
      const volRatio = avgVol > 0 ? volumes[i] / avgVol : 1;
      // Higher volume = more weight on current price
      const baseAlpha = 0.1;
      const alpha = Math.min(0.5, baseAlpha * volRatio);
      vwClose.push(closes[i] * alpha + vwClose[i - 1] * (1 - alpha));
    }
  }

  const vwEma12 = ema(vwClose, 12);
  const vwEma26 = ema(vwClose, 26);
  const vwMacd: number[] = [];
  for (let i = 0; i < n; i++) {
    vwMacd.push(i >= 25 ? vwEma12[i] - vwEma26[i] : NaN);
  }

  // Find divergence points
  const divergence: VWTechnicalResult["divergence"] = [];
  for (let i = 0; i < n; i++) {
    // RSI divergence
    if (!isNaN(rsi[i]) && !isNaN(vwRsi[i])) {
      const rsiDiff = Math.abs(rsi[i] - vwRsi[i]);
      if (rsiDiff > 10) {
        divergence.push({
          date: dates[i],
          type: "rsi",
          standard: rsi[i],
          vw: vwRsi[i],
          diff: rsi[i] - vwRsi[i],
        });
      }
    }
    // MACD divergence
    if (!isNaN(macd[i]) && !isNaN(vwMacd[i])) {
      const close = closes[i];
      const macdNorm = close > 0 ? macd[i] / close : 0;
      const vwMacdNorm = close > 0 ? vwMacd[i] / close : 0;
      if (Math.abs(macdNorm - vwMacdNorm) > 0.005) {
        divergence.push({
          date: dates[i],
          type: "macd",
          standard: macd[i],
          vw: vwMacd[i],
          diff: macd[i] - vwMacd[i],
        });
      }
    }
  }

  return {
    dates,
    rsi: rsi.map(v => isNaN(v) ? 0 : v),
    vwRsi: vwRsi.map(v => isNaN(v) ? 0 : v),
    macd: macd.map(v => isNaN(v) ? 0 : v),
    vwMacd: vwMacd.map(v => isNaN(v) ? 0 : v),
    divergence,
  };
}
