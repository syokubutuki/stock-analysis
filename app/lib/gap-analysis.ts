import { PricePoint } from "./types";

export interface GapPoint {
  time: string;
  overnightReturn: number; // ln(open[t] / close[t-1])
  intradayReturn: number;  // ln(close[t] / open[t])
  totalReturn: number;     // ln(close[t] / close[t-1])
  gapSize: number;         // open[t] - close[t-1] (absolute)
}

export interface GapStats {
  count: number;
  overnightMean: number;
  overnightStd: number;
  intradayMean: number;
  intradayStd: number;
  totalMean: number;
  totalStd: number;
  overnightContribution: number; // 夜間リターンが全体に占める割合
  intradayContribution: number;
  correlation: number; // 夜間リターンと日中リターンの相関
  gapUpCount: number;  // ギャップアップ日数
  gapDownCount: number;
  gapFillRate: number; // ギャップが埋まった割合
  openHighRate: number; // open ≈ high の割合 (寄付き天井)
  openLowRate: number;  // open ≈ low の割合 (寄付き底)
}

export function computeGapSeries(prices: PricePoint[]): GapPoint[] {
  const result: GapPoint[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prevClose = prices[i - 1].close;
    const open = prices[i].open;
    const close = prices[i].close;
    if (prevClose <= 0 || open <= 0 || close <= 0) continue;

    result.push({
      time: prices[i].time,
      overnightReturn: Math.log(open / prevClose),
      intradayReturn: Math.log(close / open),
      totalReturn: Math.log(close / prevClose),
      gapSize: open - prevClose,
    });
  }
  return result;
}

export function computeGapStats(
  prices: PricePoint[],
  gaps: GapPoint[]
): GapStats {
  const n = gaps.length;
  if (n === 0) {
    return {
      count: 0, overnightMean: 0, overnightStd: 0,
      intradayMean: 0, intradayStd: 0, totalMean: 0, totalStd: 0,
      overnightContribution: 0, intradayContribution: 0, correlation: 0,
      gapUpCount: 0, gapDownCount: 0, gapFillRate: 0,
      openHighRate: 0, openLowRate: 0,
    };
  }

  const overnight = gaps.map((g) => g.overnightReturn);
  const intraday = gaps.map((g) => g.intradayReturn);
  const total = gaps.map((g) => g.totalReturn);

  const overnightMean = mean(overnight);
  const intradayMean = mean(intraday);
  const totalMean = mean(total);
  const overnightStd = std(overnight);
  const intradayStd = std(intraday);
  const totalStd = std(total);

  // 累積リターンでの寄与率
  const cumOvernight = overnight.reduce((a, b) => a + b, 0);
  const cumTotal = total.reduce((a, b) => a + b, 0);
  const overnightContribution =
    Math.abs(cumTotal) > 1e-10 ? cumOvernight / cumTotal : 0;
  const intradayContribution = 1 - overnightContribution;

  // 夜間 vs 日中の相関
  const correlation = corr(overnight, intraday);

  // ギャップアップ/ダウン
  const gapUpCount = gaps.filter((g) => g.gapSize > 0).length;
  const gapDownCount = gaps.filter((g) => g.gapSize < 0).length;

  // ギャップフィル率: ギャップアップ後に安値がprevCloseまで下がった / ギャップダウン後に高値がprevCloseまで上がった
  let fillCount = 0;
  let gapCount = 0;
  for (let i = 1; i < prices.length; i++) {
    const prevClose = prices[i - 1].close;
    const open = prices[i].open;
    const gap = open - prevClose;
    if (Math.abs(gap) < 1e-10) continue;
    gapCount++;
    if (gap > 0 && prices[i].low <= prevClose) fillCount++;
    if (gap < 0 && prices[i].high >= prevClose) fillCount++;
  }
  const gapFillRate = gapCount > 0 ? fillCount / gapCount : 0;

  // 寄付き天井/底 (open が high/low の1%以内)
  let openHighCount = 0;
  let openLowCount = 0;
  for (let i = 1; i < prices.length; i++) {
    const range = prices[i].high - prices[i].low;
    if (range <= 0) continue;
    if ((prices[i].high - prices[i].open) / range < 0.05) openHighCount++;
    if ((prices[i].open - prices[i].low) / range < 0.05) openLowCount++;
  }
  const dataCount = prices.length - 1;
  const openHighRate = dataCount > 0 ? openHighCount / dataCount : 0;
  const openLowRate = dataCount > 0 ? openLowCount / dataCount : 0;

  return {
    count: n, overnightMean, overnightStd, intradayMean, intradayStd,
    totalMean, totalStd, overnightContribution, intradayContribution,
    correlation, gapUpCount, gapDownCount, gapFillRate,
    openHighRate, openLowRate,
  };
}

// 累積リターン系列
export interface CumulativeReturn {
  time: string;
  overnight: number;
  intraday: number;
  total: number;
}

export function computeCumulativeReturns(gaps: GapPoint[]): CumulativeReturn[] {
  const result: CumulativeReturn[] = [];
  let cumOvernight = 0;
  let cumIntraday = 0;
  let cumTotal = 0;
  for (const g of gaps) {
    cumOvernight += g.overnightReturn;
    cumIntraday += g.intradayReturn;
    cumTotal += g.totalReturn;
    result.push({
      time: g.time,
      overnight: cumOvernight,
      intraday: cumIntraday,
      total: cumTotal,
    });
  }
  return result;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
  const m = mean(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / values.length);
}

function corr(x: number[], y: number[]): number {
  const n = x.length;
  const mx = mean(x);
  const my = mean(y);
  let cov = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    sx += (x[i] - mx) ** 2;
    sy += (y[i] - my) ** 2;
  }
  const denom = Math.sqrt(sx * sy);
  return denom > 1e-10 ? cov / denom : 0;
}
