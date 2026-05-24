import { PricePoint } from "./types";

export interface DrawdownPoint {
  time: string;
  price: number;
  peak: number;
  drawdown: number;    // (price - peak) / peak, always <= 0
  drawdownAbs: number; // peak - price
}

export interface DrawdownPeriod {
  peakTime: string;
  peakPrice: number;
  troughTime: string;
  troughPrice: number;
  drawdown: number;     // max drawdown in this period (negative)
  duration: number;     // days from peak to trough
  recoveryTime: string | null; // when price recovered to peak
  recoveryDays: number | null;
}

export interface DrawdownStats {
  maxDrawdown: number;
  avgDrawdown: number;
  currentDrawdown: number;
  maxDrawdownDuration: number;     // days
  avgDrawdownDuration: number;
  timeInDrawdown: number;          // ratio of days in drawdown
  maxRecoveryDays: number | null;
  calmarRatio: number;             // annualized return / |max drawdown|
}

export function computeDrawdownSeries(prices: PricePoint[]): DrawdownPoint[] {
  const result: DrawdownPoint[] = [];
  let peak = -Infinity;

  for (const p of prices) {
    if (p.close > peak) peak = p.close;
    const dd = peak > 0 ? (p.close - peak) / peak : 0;
    result.push({
      time: p.time,
      price: p.close,
      peak,
      drawdown: dd,
      drawdownAbs: peak - p.close,
    });
  }
  return result;
}

export function detectDrawdownPeriods(
  prices: PricePoint[],
  ddSeries: DrawdownPoint[],
  minDrawdown: number = -0.03 // 3% minimum to count as a period
): DrawdownPeriod[] {
  const periods: DrawdownPeriod[] = [];
  let inDrawdown = false;
  let peakIdx = 0;
  let troughIdx = 0;
  let minDD = 0;

  for (let i = 0; i < ddSeries.length; i++) {
    const dd = ddSeries[i].drawdown;

    if (!inDrawdown) {
      if (dd < minDrawdown) {
        inDrawdown = true;
        // Find the peak (the last day where drawdown was 0)
        peakIdx = i;
        for (let j = i; j >= 0; j--) {
          if (ddSeries[j].drawdown === 0) {
            peakIdx = j;
            break;
          }
        }
        troughIdx = i;
        minDD = dd;
      }
    } else {
      if (dd < minDD) {
        minDD = dd;
        troughIdx = i;
      }
      // Recovery: drawdown returns to 0
      if (dd >= 0 || i === ddSeries.length - 1) {
        const recoveryIdx = dd >= 0 ? i : null;
        periods.push({
          peakTime: prices[peakIdx].time,
          peakPrice: prices[peakIdx].close,
          troughTime: prices[troughIdx].time,
          troughPrice: prices[troughIdx].close,
          drawdown: minDD,
          duration: troughIdx - peakIdx,
          recoveryTime: recoveryIdx !== null ? prices[recoveryIdx].time : null,
          recoveryDays: recoveryIdx !== null ? recoveryIdx - peakIdx : null,
        });
        inDrawdown = false;
        minDD = 0;
      }
    }
  }

  // Sort by drawdown severity
  periods.sort((a, b) => a.drawdown - b.drawdown);
  return periods;
}

export function computeDrawdownStats(
  prices: PricePoint[],
  ddSeries: DrawdownPoint[],
  periods: DrawdownPeriod[]
): DrawdownStats {
  if (ddSeries.length === 0) {
    return {
      maxDrawdown: 0, avgDrawdown: 0, currentDrawdown: 0,
      maxDrawdownDuration: 0, avgDrawdownDuration: 0,
      timeInDrawdown: 0, maxRecoveryDays: null, calmarRatio: 0,
    };
  }

  const maxDrawdown = Math.min(...ddSeries.map((d) => d.drawdown));
  const avgDrawdown = ddSeries.reduce((a, d) => a + d.drawdown, 0) / ddSeries.length;
  const currentDrawdown = ddSeries[ddSeries.length - 1].drawdown;
  const daysInDrawdown = ddSeries.filter((d) => d.drawdown < -0.001).length;
  const timeInDrawdown = daysInDrawdown / ddSeries.length;

  const durations = periods.map((p) => p.duration);
  const maxDrawdownDuration = durations.length > 0 ? Math.max(...durations) : 0;
  const avgDrawdownDuration = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : 0;

  const recoveries = periods
    .map((p) => p.recoveryDays)
    .filter((d): d is number => d !== null);
  const maxRecoveryDays = recoveries.length > 0 ? Math.max(...recoveries) : null;

  // Calmar ratio: annualized return / |max drawdown|
  const totalReturn = prices.length >= 2
    ? (prices[prices.length - 1].close / prices[0].close) - 1
    : 0;
  const years = prices.length / 252;
  const annualizedReturn = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : 0;
  const calmarRatio = Math.abs(maxDrawdown) > 0
    ? annualizedReturn / Math.abs(maxDrawdown)
    : 0;

  return {
    maxDrawdown, avgDrawdown, currentDrawdown,
    maxDrawdownDuration, avgDrawdownDuration,
    timeInDrawdown, maxRecoveryDays, calmarRatio,
  };
}
