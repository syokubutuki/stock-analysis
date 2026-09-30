import { PricePoint } from "./types";
import { logReturns } from "./transforms";

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

/**
 * 系列の単位。**この情報が無かったことが FU47 の根である。**
 *
 * `extractSeries` の戻り値は 6 モードで単位が違うのに、型は `number[]` で同じである。
 * 受け取る側はそれを見分けられないので、リターンだと決め打って `×100` して `%` を付け、
 * `close`（水準）が流れてきたときに「平均 1931819.394%」のような表示になっていた。
 * 症状は投信 `0331418A` で見つかったが、**既定モードが `close` なので銘柄を選ばない**
 * （`7203.T` でも「平均 179740.3866%」が出ていた）。
 *
 * - `level`     … `close` / `open`。円などの価格そのもの。差を取るまで比率にならない
 * - `difference`… `diff`。1日あたりの価格差（円）。比率ではない
 * - `ratio`     … 対数リターン系。無次元なので `×100` して `%` にしてよい
 */
export type SeriesUnit = "level" | "difference" | "ratio";

export const SERIES_MODE_UNITS: Record<SeriesMode, SeriesUnit> = {
  close: "level",
  open: "level",
  diff: "difference",
  logReturn: "ratio",
  overnightReturn: "ratio",
  intradayReturn: "ratio",
};

/** 水準系列か。`%` で見せる前に対数リターンへ直す必要があるかの判定に使う */
export function isLevelSeries(mode: SeriesMode): boolean {
  return SERIES_MODE_UNITS[mode] === "level";
}

/**
 * `extractRatioSeries()` の表示倍率と単位。
 *
 * 水準は同関数内で比率へ変換済みなので `%`、もともと比率のモードも `%`。
 * `diff` だけは価格差を意図的に素通しするため、100倍せず円で表示する。
 */
export function ratioSeriesDisplayUnit(mode: SeriesMode): "%" | "円" {
  return SERIES_MODE_UNITS[mode] === "difference" ? "円" : "%";
}

export function scaleRatioSeriesValue(value: number, mode: SeriesMode): number {
  return SERIES_MODE_UNITS[mode] === "difference" ? value : value * 100;
}

export function formatRatioSeriesValue(
  value: number,
  mode: SeriesMode,
  fractionDigits: number,
): string {
  return `${scaleRatioSeriesValue(value, mode).toFixed(fractionDigits)}${ratioSeriesDisplayUnit(mode)}`;
}

/**
 * 比率（対数リターン）として扱える系列を返す。
 *
 * 水準（`close` / `open`）のときだけ `logReturns()` を通し、時刻を 1 本落とす。
 * 比率系列と差分系列はそのまま返す。
 *
 * **リターンの分布・ボラティリティ・VaR・レジームのように「比率であること」を
 * 前提にした分析は、`extractSeries` ではなくこちらを使うこと。**
 * この 3 行は本関数を作る前、14 個のコンポーネントに同じ水準判定として
 * 手書きで複製されていた（`TransformCharts` ほか）。複製を写し忘れた側が FU47 である。
 *
 * `diff` を比率に直していないのは、既存の 14 件がそう書かれていたからである。
 * 差分系列を `%` で見せている箇所の是正は別件として残す。
 */
export function extractRatioSeries(
  prices: PricePoint[],
  mode: SeriesMode
): { values: number[]; times: string[] } {
  const { values, times } = extractSeries(prices, mode);
  if (!isLevelSeries(mode)) return { values, times };
  return { values: logReturns(values), times: times.slice(1) };
}

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
