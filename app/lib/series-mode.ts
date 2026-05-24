import { PricePoint } from "./types";

export type SeriesMode =
  | "close"
  | "diff"
  | "logReturn"
  | "open"
  | "overnightReturn"
  | "intradayReturn";

export const SERIES_MODE_LABELS: Record<SeriesMode, string> = {
  close: "原系列 (終値)",
  diff: "差分系列",
  logReturn: "対数リターン",
  open: "原系列 (始値)",
  overnightReturn: "夜間リターン",
  intradayReturn: "日中リターン",
};

export function extractSeries(
  prices: PricePoint[],
  mode: SeriesMode
): { values: number[]; times: string[] } {
  const closes = prices.map((p) => p.close);
  const opens = prices.map((p) => p.open);
  const times = prices.map((p) => p.time);

  switch (mode) {
    case "close":
      return { values: closes, times };
    case "diff":
      return {
        values: closes.slice(1).map((c, i) => c - closes[i]),
        times: times.slice(1),
      };
    case "logReturn":
      return {
        values: closes.slice(1).map((c, i) =>
          closes[i] > 0 && c > 0 ? Math.log(c / closes[i]) : 0
        ),
        times: times.slice(1),
      };
    case "open":
      return { values: opens, times };
    case "overnightReturn":
      // 夜間リターン: ln(open[t] / close[t-1])
      return {
        values: opens.slice(1).map((o, i) =>
          closes[i] > 0 && o > 0 ? Math.log(o / closes[i]) : 0
        ),
        times: times.slice(1),
      };
    case "intradayReturn":
      // 日中リターン: ln(close[t] / open[t])
      return {
        values: closes.map((c, i) =>
          opens[i] > 0 && c > 0 ? Math.log(c / opens[i]) : 0
        ),
        times,
      };
  }
}
