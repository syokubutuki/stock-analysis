import { PricePoint } from "./types";

export interface RiskMetricsResult {
  // Returns
  totalReturn: number;
  annualizedReturn: number;
  // Volatility
  dailyVol: number;
  annualizedVol: number;
  // Risk-adjusted
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  // VaR / CVaR
  var95: number;
  var99: number;
  cvar95: number;
  cvar99: number;
  // Other
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  bestDay: number;
  worstDay: number;
  // Higher moments
  skewness: number;
  kurtosis: number;
}

export function computeRiskMetrics(
  prices: PricePoint[],
  riskFreeRate: number = 0.0 // annual risk-free rate
): RiskMetricsResult {
  const n = prices.length;
  if (n < 3) {
    return emptyResult();
  }

  // Log returns
  const returns: number[] = [];
  for (let i = 1; i < n; i++) {
    if (prices[i].close > 0 && prices[i - 1].close > 0) {
      returns.push(Math.log(prices[i].close / prices[i - 1].close));
    }
  }

  if (returns.length < 2) return emptyResult();

  const m = returns.length;
  const totalReturn = (prices[n - 1].close / prices[0].close) - 1;
  const years = n / 252;
  const annualizedReturn = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : 0;

  // Mean and volatility
  const meanReturn = returns.reduce((a, b) => a + b, 0) / m;
  const variance = returns.reduce((a, v) => a + (v - meanReturn) ** 2, 0) / (m - 1);
  const dailyVol = Math.sqrt(variance);
  const annualizedVol = dailyVol * Math.sqrt(252);

  // Sharpe ratio
  const dailyRf = riskFreeRate / 252;
  const excessMean = meanReturn - dailyRf;
  const sharpeRatio = dailyVol > 0 ? (excessMean / dailyVol) * Math.sqrt(252) : 0;

  // Sortino ratio (downside deviation)
  const negReturns = returns.filter((r) => r < dailyRf);
  const downsideVariance = negReturns.length > 0
    ? negReturns.reduce((a, r) => a + (r - dailyRf) ** 2, 0) / m
    : 0;
  const downsideDev = Math.sqrt(downsideVariance);
  const sortinoRatio = downsideDev > 0 ? (excessMean / downsideDev) * Math.sqrt(252) : 0;

  // Max drawdown
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const p of prices) {
    if (p.close > peak) peak = p.close;
    const dd = (p.close - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // Calmar ratio
  const calmarRatio = Math.abs(maxDrawdown) > 0
    ? annualizedReturn / Math.abs(maxDrawdown)
    : 0;

  // VaR and CVaR (Historical simulation)
  const sorted = [...returns].sort((a, b) => a - b);
  const var95 = sorted[Math.floor(m * 0.05)];
  const var99 = sorted[Math.floor(m * 0.01)];

  const cvar95Slice = sorted.slice(0, Math.max(1, Math.floor(m * 0.05)));
  const cvar95 = cvar95Slice.reduce((a, b) => a + b, 0) / cvar95Slice.length;

  const cvar99Slice = sorted.slice(0, Math.max(1, Math.floor(m * 0.01)));
  const cvar99 = cvar99Slice.reduce((a, b) => a + b, 0) / cvar99Slice.length;

  // Win/Loss stats
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0);
  const winRate = wins.length / m;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  const totalWin = wins.reduce((a, b) => a + b, 0);
  const totalLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : 0;

  const bestDay = Math.max(...returns);
  const worstDay = Math.min(...returns);

  // Higher moments
  const std = dailyVol;
  const skewness = std > 0
    ? returns.reduce((a, v) => a + ((v - meanReturn) / std) ** 3, 0) / m
    : 0;
  const kurtosis = std > 0
    ? returns.reduce((a, v) => a + ((v - meanReturn) / std) ** 4, 0) / m - 3
    : 0;

  return {
    totalReturn, annualizedReturn,
    dailyVol, annualizedVol,
    sharpeRatio, sortinoRatio, calmarRatio,
    var95, var99, cvar95, cvar99,
    maxDrawdown, winRate, profitFactor,
    avgWin, avgLoss, bestDay, worstDay,
    skewness, kurtosis,
  };
}

// Rolling risk metrics
export interface RollingRiskPoint {
  time: string;
  sharpe: number;
  sortino: number;
  vol: number;
  var95: number;
}

export function rollingRiskMetrics(
  prices: PricePoint[],
  window: number = 60
): RollingRiskPoint[] {
  const result: RollingRiskPoint[] = [];

  for (let i = window; i < prices.length; i++) {
    const slice = prices.slice(i - window, i + 1);
    const metrics = computeRiskMetrics(slice);
    result.push({
      time: prices[i].time,
      sharpe: metrics.sharpeRatio,
      sortino: metrics.sortinoRatio,
      vol: metrics.annualizedVol,
      var95: metrics.var95,
    });
  }

  return result;
}

function emptyResult(): RiskMetricsResult {
  return {
    totalReturn: 0, annualizedReturn: 0,
    dailyVol: 0, annualizedVol: 0,
    sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0,
    var95: 0, var99: 0, cvar95: 0, cvar99: 0,
    maxDrawdown: 0, winRate: 0, profitFactor: 0,
    avgWin: 0, avgLoss: 0, bestDay: 0, worstDay: 0,
    skewness: 0, kurtosis: 0,
  };
}
