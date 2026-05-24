import { PricePoint } from "./types";

export interface RangeVolPoint {
  time: string;
  parkinson: number;
  garmanKlass: number;
  rogersSatchell: number;
  yangZhang: number;
  closeToClose: number;
}

// Parkinson (1980): σ² = (1/4n·ln2) Σ (ln(H/L))²
function parkinsonVariance(prices: PricePoint[], start: number, end: number): number {
  let sum = 0;
  let count = 0;
  for (let i = start; i <= end; i++) {
    if (prices[i].high <= 0 || prices[i].low <= 0) continue;
    const x = Math.log(prices[i].high / prices[i].low);
    sum += x * x;
    count++;
  }
  if (count === 0) return 0;
  return sum / (4 * count * Math.LN2);
}

// Garman-Klass (1980): σ² = (1/n) Σ [0.5(ln(H/L))² - (2ln2-1)(ln(C/O))²]
function garmanKlassVariance(prices: PricePoint[], start: number, end: number): number {
  let sum = 0;
  let count = 0;
  for (let i = start; i <= end; i++) {
    if (prices[i].high <= 0 || prices[i].low <= 0 || prices[i].open <= 0 || prices[i].close <= 0) continue;
    const hl = Math.log(prices[i].high / prices[i].low);
    const co = Math.log(prices[i].close / prices[i].open);
    sum += 0.5 * hl * hl - (2 * Math.LN2 - 1) * co * co;
    count++;
  }
  if (count === 0) return 0;
  return sum / count;
}

// Rogers-Satchell (1991): drift-independent
// σ² = (1/n) Σ [ln(H/C)·ln(H/O) + ln(L/C)·ln(L/O)]
function rogersSatchellVariance(prices: PricePoint[], start: number, end: number): number {
  let sum = 0;
  let count = 0;
  for (let i = start; i <= end; i++) {
    const { open, high, low, close } = prices[i];
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
    sum +=
      Math.log(high / close) * Math.log(high / open) +
      Math.log(low / close) * Math.log(low / open);
    count++;
  }
  if (count === 0) return 0;
  return sum / count;
}

// Yang-Zhang (2000): overnight + open-to-close + Rogers-Satchell
function yangZhangVariance(prices: PricePoint[], start: number, end: number): number {
  const n = end - start + 1;
  if (n < 2) return 0;

  // Overnight variance: σ²_o = (1/(n-1)) Σ (o_i - ō)² where o_i = ln(Open_i / Close_{i-1})
  const overnights: number[] = [];
  for (let i = Math.max(start, 1); i <= end; i++) {
    if (prices[i].open <= 0 || prices[i - 1].close <= 0) continue;
    overnights.push(Math.log(prices[i].open / prices[i - 1].close));
  }
  const oMean = overnights.length > 0 ? overnights.reduce((a, b) => a + b, 0) / overnights.length : 0;
  const sigmaO = overnights.length > 1
    ? overnights.reduce((a, v) => a + (v - oMean) ** 2, 0) / (overnights.length - 1)
    : 0;

  // Close-to-close variance: σ²_c = (1/(n-1)) Σ (c_i - c̄)² where c_i = ln(Close_i / Open_i)
  const closes: number[] = [];
  for (let i = start; i <= end; i++) {
    if (prices[i].close <= 0 || prices[i].open <= 0) continue;
    closes.push(Math.log(prices[i].close / prices[i].open));
  }
  const cMean = closes.length > 0 ? closes.reduce((a, b) => a + b, 0) / closes.length : 0;
  const sigmaC = closes.length > 1
    ? closes.reduce((a, v) => a + (v - cMean) ** 2, 0) / (closes.length - 1)
    : 0;

  const sigmaRS = rogersSatchellVariance(prices, start, end);

  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  return sigmaO + k * sigmaC + (1 - k) * sigmaRS;
}

// Close-to-close variance
function closeToCloseVariance(prices: PricePoint[], start: number, end: number): number {
  const returns: number[] = [];
  for (let i = Math.max(start, 1); i <= end; i++) {
    if (prices[i].close <= 0 || prices[i - 1].close <= 0) continue;
    returns.push(Math.log(prices[i].close / prices[i - 1].close));
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  return returns.reduce((a, v) => a + (v - mean) ** 2, 0) / (returns.length - 1);
}

export function computeRangeVolatility(
  prices: PricePoint[],
  window: number = 20
): RangeVolPoint[] {
  const result: RangeVolPoint[] = [];
  for (let i = window; i < prices.length; i++) {
    const start = i - window + 1;
    result.push({
      time: prices[i].time,
      parkinson: Math.sqrt(parkinsonVariance(prices, start, i) * 252),
      garmanKlass: Math.sqrt(Math.max(0, garmanKlassVariance(prices, start, i)) * 252),
      rogersSatchell: Math.sqrt(Math.max(0, rogersSatchellVariance(prices, start, i)) * 252),
      yangZhang: Math.sqrt(Math.max(0, yangZhangVariance(prices, start, i)) * 252),
      closeToClose: Math.sqrt(closeToCloseVariance(prices, start, i) * 252),
    });
  }
  return result;
}

export interface VolEstimatorComparison {
  name: string;
  current: number;
  mean: number;
  efficiency: string;
}

export function compareEstimators(points: RangeVolPoint[]): VolEstimatorComparison[] {
  if (points.length === 0) return [];
  const last = points[points.length - 1];
  const avg = (key: keyof Omit<RangeVolPoint, "time">) =>
    points.reduce((a, p) => a + p[key], 0) / points.length;

  return [
    { name: "Close-to-Close", current: last.closeToClose, mean: avg("closeToClose"), efficiency: "1x (基準)" },
    { name: "Parkinson", current: last.parkinson, mean: avg("parkinson"), efficiency: "~5x" },
    { name: "Garman-Klass", current: last.garmanKlass, mean: avg("garmanKlass"), efficiency: "~7x" },
    { name: "Rogers-Satchell", current: last.rogersSatchell, mean: avg("rogersSatchell"), efficiency: "~8x (ドリフト非依存)" },
    { name: "Yang-Zhang", current: last.yangZhang, mean: avg("yangZhang"), efficiency: "~14x (夜間考慮)" },
  ];
}
