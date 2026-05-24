import { PricePoint } from "./types";

export type SeriesMode = "close" | "diff" | "logReturn";

export const SERIES_MODE_LABELS: Record<SeriesMode, string> = {
  close: "原系列 (終値)",
  diff: "差分系列",
  logReturn: "対数リターン",
};

export function extractSeries(
  prices: PricePoint[],
  mode: SeriesMode
): { values: number[]; times: string[] } {
  const closes = prices.map((p) => p.close);
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
  }
}
