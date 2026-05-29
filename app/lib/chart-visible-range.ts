import type { IChartApi, Time } from "lightweight-charts";
import type { PricePoint } from "./types";
import type { PeriodKey } from "../hooks/useAnalysisData";

const PERIOD_DAYS: Record<PeriodKey, number> = {
  "1m": 21,
  "3m": 63,
  "6m": 126,
  "1y": 252,
  "2y": 504,
  "3y": 756,
  "5y": 1260,
  "10y": 2520,
};

export function setInitialVisibleRange(
  chart: IChartApi,
  prices: PricePoint[],
  period: PeriodKey
) {
  if (prices.length === 0) return;

  const maxDays = PERIOD_DAYS[period];
  if (prices.length <= maxDays) {
    chart.timeScale().fitContent();
    return;
  }

  const fromIndex = prices.length - maxDays;
  const from = prices[fromIndex].time as Time;
  const to = prices[prices.length - 1].time as Time;
  chart.timeScale().setVisibleRange({ from, to });
}
