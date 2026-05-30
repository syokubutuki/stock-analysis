import { PricePoint } from "./types";

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

function logReturns(prices: PricePoint[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    r.push(Math.log(prices[i].close / prices[i - 1].close));
  }
  return r;
}

function acf1(arr: number[]): number {
  if (arr.length < 3) return 0;
  const m = mean(arr);
  let num = 0;
  let den = 0;
  for (let i = 0; i < arr.length; i++) den += (arr[i] - m) ** 2;
  if (den === 0) return 0;
  for (let i = 1; i < arr.length; i++) {
    num += (arr[i] - m) * (arr[i - 1] - m);
  }
  return num / den;
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
  // Fill initial entries with NaN
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

function ema(arr: number[], period: number): number[] {
  const result: number[] = [];
  if (arr.length === 0) return result;
  const k = 2 / (period + 1);
  result.push(arr[0]);
  for (let i = 1; i < arr.length; i++) {
    result.push(arr[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

// ─── A. Rolling Prediction Accuracy (#10) ───────────────────────────

export interface PredictionAccuracyResult {
  dates: string[];
  acfDirectionAccuracy: number[];
  meanReversionAccuracy: number[];
  momentumAccuracy: number[];
}

export function computePredictionAccuracy(prices: PricePoint[]): PredictionAccuracyResult {
  const empty: PredictionAccuracyResult = {
    dates: [], acfDirectionAccuracy: [], meanReversionAccuracy: [], momentumAccuracy: [],
  };
  if (prices.length < 62) return empty;

  const ret = logReturns(prices);
  // ret[i] corresponds to prices[i+1]
  const dates: string[] = [];
  const acfAcc: number[] = [];
  const mrAcc: number[] = [];
  const momAcc: number[] = [];

  const window = 60;

  for (let i = window; i < ret.length; i++) {
    const windowReturns = ret.slice(i - window, i);
    dates.push(prices[i + 1].time);

    // ACF direction accuracy
    {
      let hits = 0;
      let total = 0;
      for (let j = 1; j < windowReturns.length; j++) {
        const subArr = windowReturns.slice(0, j);
        const a = acf1(subArr);
        const prevDir = windowReturns[j - 1] >= 0 ? 1 : -1;
        const predictedDir = a >= 0 ? prevDir : -prevDir;
        const actualDir = windowReturns[j] >= 0 ? 1 : -1;
        if (predictedDir === actualDir) hits++;
        total++;
      }
      acfAcc.push(total > 0 ? hits / total : 0.5);
    }

    // Mean reversion accuracy
    {
      const sigma = stddev(windowReturns);
      let hits = 0;
      let total = 0;
      for (let j = 0; j < windowReturns.length - 1; j++) {
        if (Math.abs(windowReturns[j]) > sigma) {
          const predictedDir = windowReturns[j] >= 0 ? -1 : 1;
          const actualDir = windowReturns[j + 1] >= 0 ? 1 : -1;
          if (predictedDir === actualDir) hits++;
          total++;
        }
      }
      mrAcc.push(total > 0 ? hits / total : 0.5);
    }

    // Momentum accuracy (5-day trend)
    {
      let hits = 0;
      let total = 0;
      for (let j = 5; j < windowReturns.length; j++) {
        let trendSum = 0;
        for (let k = j - 5; k < j; k++) trendSum += windowReturns[k];
        const predictedDir = trendSum >= 0 ? 1 : -1;
        const actualDir = windowReturns[j] >= 0 ? 1 : -1;
        if (predictedDir === actualDir) hits++;
        total++;
      }
      momAcc.push(total > 0 ? hits / total : 0.5);
    }
  }

  return { dates, acfDirectionAccuracy: acfAcc, meanReversionAccuracy: mrAcc, momentumAccuracy: momAcc };
}

// ─── B. Information Ratio Dashboard (#11) ───────────────────────────

export interface InfoRatioItem {
  indicator: string;
  mi: number;
  correlation: number;
  rank: number;
}

function discretize(arr: number[], nBins: number): number[] {
  const sorted = [...arr].sort((a, b) => a - b);
  const result: number[] = new Array(arr.length);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (max === min) {
    result.fill(0);
    return result;
  }
  for (let i = 0; i < arr.length; i++) {
    let bin = Math.floor(((arr[i] - min) / (max - min)) * nBins);
    if (bin >= nBins) bin = nBins - 1;
    result[i] = bin;
  }
  return result;
}

function mutualInformation(x: number[], y: number[], nBins: number): number {
  const n = x.length;
  if (n === 0) return 0;
  const dx = discretize(x, nBins);
  const dy = discretize(y, nBins);
  const joint: number[][] = Array.from({ length: nBins }, () => new Array(nBins).fill(0));
  const px: number[] = new Array(nBins).fill(0);
  const py: number[] = new Array(nBins).fill(0);
  for (let i = 0; i < n; i++) {
    joint[dx[i]][dy[i]]++;
    px[dx[i]]++;
    py[dy[i]]++;
  }
  let mi = 0;
  for (let i = 0; i < nBins; i++) {
    for (let j = 0; j < nBins; j++) {
      if (joint[i][j] === 0) continue;
      const pxy = joint[i][j] / n;
      const pxi = px[i] / n;
      const pyj = py[j] / n;
      mi += pxy * Math.log(pxy / (pxi * pyj));
    }
  }
  return Math.max(0, mi);
}

export function computeInfoRatio(prices: PricePoint[]): InfoRatioItem[] {
  if (prices.length < 30) return [];

  const closes = prices.map(p => p.close);
  const ret = logReturns(prices);
  const nextRet = ret.slice(1); // next-day return aligned with indicators at t

  // Build indicators aligned to ret[0..ret.length-2] (so we have next-day return)
  const n = ret.length - 1; // number of paired observations
  if (n < 10) return [];

  // 1. Previous return
  const prevReturn = ret.slice(0, n);

  // 2. |Previous return|
  const absPrevReturn = prevReturn.map(Math.abs);

  // 3. Volume change
  const volChange: number[] = [];
  for (let i = 1; i < prices.length - 1; i++) {
    const prev = prices[i - 1].volume;
    volChange.push(prev > 0 ? prices[i].volume / prev - 1 : 0);
  }
  const volChangeAligned = volChange.slice(0, n);

  // 4. 5-day momentum
  const mom5: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < 4) { mom5.push(0); continue; }
    let s = 0;
    for (let j = i - 4; j <= i; j++) s += ret[j];
    mom5.push(s);
  }

  // 5. 20-day rolling volatility
  const vol20: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < 19) { vol20.push(0); continue; }
    vol20.push(stddev(ret.slice(i - 19, i + 1)));
  }

  // 6. RSI(14)
  const rsiAll = computeRSI(closes, 14);
  // rsiAll[i] corresponds to closes[i], we need indices [1..n] to align with ret[0..n-1]
  const rsi14: number[] = [];
  for (let i = 0; i < n; i++) {
    const val = rsiAll[i + 1];
    rsi14.push(isNaN(val) ? 50 : val);
  }

  // 7. Close position (C-L)/(H-L)
  const closePos: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = prices[i + 1]; // aligned with ret[i]
    const range = p.high - p.low;
    closePos.push(range > 0 ? (p.close - p.low) / range : 0.5);
  }

  // 8. Gap size
  const gapSize: number[] = [];
  for (let i = 0; i < n; i++) {
    const prevClose = prices[i].close;
    gapSize.push(prevClose > 0 ? (prices[i + 1].open - prevClose) / prevClose : 0);
  }

  // Filter out initial zeros for fair comparison — use valid indices where all indicators are meaningful
  const startIdx = 19; // after vol20 becomes valid
  if (startIdx >= n) return [];
  const validNext = nextRet.slice(startIdx);
  const indicators: { name: string; values: number[] }[] = [
    { name: "Previous Return", values: prevReturn.slice(startIdx) },
    { name: "|Previous Return|", values: absPrevReturn.slice(startIdx) },
    { name: "Volume Change", values: volChangeAligned.slice(startIdx) },
    { name: "5-day Momentum", values: mom5.slice(startIdx) },
    { name: "20-day Volatility", values: vol20.slice(startIdx) },
    { name: "RSI(14)", values: rsi14.slice(startIdx) },
    { name: "Close Position", values: closePos.slice(startIdx) },
    { name: "Gap Size", values: gapSize.slice(startIdx) },
  ];

  const results: InfoRatioItem[] = indicators.map(ind => ({
    indicator: ind.name,
    mi: mutualInformation(ind.values, validNext, 10),
    correlation: pearsonCorrelation(ind.values, validNext),
    rank: 0,
  }));

  results.sort((a, b) => b.mi - a.mi);
  results.forEach((r, i) => (r.rank = i + 1));

  return results;
}

// ─── C. Simple Backtest (#12) ───────────────────────────────────────

export interface BacktestResult {
  strategy: string;
  dates: string[];
  cumReturns: number[];
  totalReturn: number;
  annualReturn: number;
  annualVol: number;
  sharpe: number;
  maxDrawdown: number;
  winRate: number;
  nTrades: number;
}

function computeMACD(closes: number[]): { macd: number[]; signal: number[]; histogram: number[] } {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(ema12[i] - ema26[i]);
  }
  const signalLine = ema(macdLine, 9);
  const histogram: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    histogram.push(macdLine[i] - signalLine[i]);
  }
  return { macd: macdLine, signal: signalLine, histogram };
}

function buildBacktestResult(
  strategy: string,
  dates: string[],
  dailyReturns: number[],
  positions: number[], // 1 = in, 0 = flat
): BacktestResult {
  const n = dates.length;
  const cumReturns: number[] = [];
  let cumSum = 0;
  const activeReturns: number[] = [];

  for (let i = 0; i < n; i++) {
    const r = positions[i] * dailyReturns[i];
    cumSum += r;
    cumReturns.push(cumSum);
    if (positions[i] !== 0) activeReturns.push(r);
  }

  const totalReturn = cumSum;
  const tradingDays = 252;
  const years = n / tradingDays;
  const annualReturn = years > 0 ? totalReturn / years : 0;
  const annualVol = stddev(activeReturns.length > 0 ? activeReturns : [0]) * Math.sqrt(tradingDays);
  const sharpe = annualVol > 0 ? annualReturn / annualVol : 0;

  // Max drawdown from cumulative returns
  let peak = 0;
  let maxDD = 0;
  for (let i = 0; i < cumReturns.length; i++) {
    if (cumReturns[i] > peak) peak = cumReturns[i];
    const dd = peak - cumReturns[i];
    if (dd > maxDD) maxDD = dd;
  }

  // Count trades and win rate
  let nTrades = 0;
  let wins = 0;
  let inTrade = false;
  let tradeReturn = 0;
  for (let i = 0; i < n; i++) {
    if (positions[i] !== 0 && !inTrade) {
      inTrade = true;
      tradeReturn = 0;
    }
    if (inTrade) {
      tradeReturn += positions[i] * dailyReturns[i];
    }
    if (inTrade && (positions[i] === 0 || i === n - 1)) {
      nTrades++;
      if (tradeReturn > 0) wins++;
      inTrade = false;
      tradeReturn = 0;
    }
  }

  return {
    strategy,
    dates,
    cumReturns,
    totalReturn,
    annualReturn,
    annualVol,
    sharpe,
    maxDrawdown: maxDD,
    winRate: nTrades > 0 ? wins / nTrades : 0,
    nTrades,
  };
}

export function computeBacktest(prices: PricePoint[]): BacktestResult[] {
  if (prices.length < 30) return [];

  const closes = prices.map(p => p.close);
  const ret = logReturns(prices);
  const dates = prices.slice(1).map(p => p.time);
  const n = ret.length;

  // 1. Buy & Hold
  const bhPositions = new Array(n).fill(1);
  const buyHold = buildBacktestResult("Buy & Hold", dates, ret, bhPositions);

  // 2. RSI Mean Reversion
  const rsiValues = computeRSI(closes, 14);
  const rsiPositions = new Array(n).fill(0);
  {
    let holdDays = 0;
    let flatDays = 0;
    let inPosition = 0; // 1 = long, -1 = forced flat, 0 = neutral
    for (let i = 0; i < n; i++) {
      const rsi = rsiValues[i + 1]; // RSI at close of prices[i+1], signal for next day
      if (holdDays > 0) {
        rsiPositions[i] = 1;
        holdDays--;
        continue;
      }
      if (flatDays > 0) {
        rsiPositions[i] = 0;
        flatDays--;
        continue;
      }
      // Use RSI from the previous close to decide position today
      const prevRsi = rsiValues[i]; // RSI at prices[i] (close before ret[i])
      if (!isNaN(prevRsi) && prevRsi < 30) {
        rsiPositions[i] = 1;
        holdDays = 4; // hold for 5 days total (this day + 4 more)
      } else if (!isNaN(prevRsi) && prevRsi > 70) {
        rsiPositions[i] = 0;
        flatDays = 4;
      } else {
        rsiPositions[i] = inPosition === 1 ? 1 : 0;
      }
    }
  }
  const rsiResult = buildBacktestResult("RSI Mean Reversion", dates, ret, rsiPositions);

  // 3. MACD Momentum
  const { histogram } = computeMACD(closes);
  const macdPositions = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    // Use MACD histogram at prices[i] to decide position for ret[i]
    macdPositions[i] = histogram[i] > 0 ? 1 : 0;
  }
  const macdResult = buildBacktestResult("MACD Momentum", dates, ret, macdPositions);

  // 4. Volatility Breakout
  const volBreakPositions = new Array(n).fill(0);
  {
    let prevPos = 0;
    for (let i = 0; i < n; i++) {
      if (i < 20) {
        volBreakPositions[i] = 0;
        continue;
      }
      const window = ret.slice(i - 20, i);
      const sigma = stddev(window);
      const threshold = 1.5 * sigma;
      if (ret[i - 1] > threshold) {
        prevPos = 1;
      } else if (ret[i - 1] < -threshold) {
        prevPos = 0;
      }
      volBreakPositions[i] = prevPos;
    }
  }
  const volBreakResult = buildBacktestResult("Volatility Breakout", dates, ret, volBreakPositions);

  return [buyHold, rsiResult, macdResult, volBreakResult];
}
