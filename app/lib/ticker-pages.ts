import type { Instrument } from "./instruments";
import { getInstrumentByTicker } from "./instruments";
import type { PricePoint } from "./types";
import { getUniverse } from "./universes";

export interface TickerPageSummary {
  asOf: string;
  startDate: string;
  currentPrice: number;
  periodReturn: number;
  annualizedVolatility: number;
  maxDrawdown: number;
  observationCount: number;
}

const majorUniverse = getUniverse("major100")?.tickers ?? [];
const PRICE_UNAVAILABLE_TICKERS = new Set(["9613"]);

/** `/t/[ticker]` で公開する主要銘柄。実取得で404になる上場廃止銘柄は除外する。 */
export const TICKER_PAGE_INSTRUMENTS: readonly Instrument[] = majorUniverse
  .flatMap(({ ticker }) => {
    const instrument = getInstrumentByTicker(ticker);
    return instrument && !PRICE_UNAVAILABLE_TICKERS.has(instrument.ticker)
      ? [instrument]
      : [];
  });

const tickerPageInstrumentMap = new Map<string, Instrument>();
for (const instrument of TICKER_PAGE_INSTRUMENTS) {
  tickerPageInstrumentMap.set(instrument.ticker, instrument);
  tickerPageInstrumentMap.set(instrument.yahooSymbol, instrument);
}

export function getTickerPageInstrument(value: string): Instrument | undefined {
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  return tickerPageInstrumentMap.get(normalized);
}

/**
 * `YYYY-MM-DD` の1年前を、同じ書式の文字列として返す。
 *
 * `Date` を経由しないのはタイムゾーンで日がずれるのを避けるため。うるう日の
 * `2024-02-29` は `2023-02-29`（実在しない日）になるが、**窓の境界としては正しく働く**。
 * ISO日付は辞書順が時系列順なので、`2023-02-28 < 2023-02-29 < 2023-03-01` の
 * 比較結果は実在の有無に依らない。
 */
function oneYearBefore(isoDate: string): string {
  const [year, rest] = [isoDate.slice(0, 4), isoDate.slice(4)];
  return `${Number(year) - 1}${rest}`;
}

/**
 * 日足終値から、銘柄ページに掲載する直近1年の実測サマリーを計算する。
 * ボラティリティは日次対数リターンの標本標準偏差を √252 倍する。
 *
 * **10年の系列を渡してよい**（というより渡すことを想定している）。
 * 銘柄ページが `range=1y` で取ると、アプリ本体・`/api/stock` が使う `10y` と
 * 別のキャッシュキーになり、誰も温めない専用エントリになってしまうため
 * （`stock-data.server.ts` の `cacheKey()` は range を含む）。
 * 取得は `10y` に寄せ、期間の切り出しはここで行う。
 */
export function buildTickerPageSummary(prices: PricePoint[]): TickerPageSummary | null {
  const usable = prices.filter(
    (price) => Number.isFinite(price.close) && price.close > 0,
  );
  if (usable.length < 2) return null;

  const cutoff = oneYearBefore(usable[usable.length - 1].time);
  const valid = usable.filter((price) => price.time >= cutoff);
  // 上場から1年未満の銘柄は窓に2点そろわない。呼び出し側が「取得できなかった」扱いにする。
  if (valid.length < 2) return null;

  const first = valid[0];
  const last = valid[valid.length - 1];
  const returns: number[] = [];
  let peak = first.close;
  let maxDrawdown = 0;

  for (let i = 1; i < valid.length; i += 1) {
    const previous = valid[i - 1].close;
    const current = valid[i].close;
    returns.push(Math.log(current / previous));
    peak = Math.max(peak, current);
    maxDrawdown = Math.min(maxDrawdown, current / peak - 1);
  }

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      (returns.length - 1)
    : 0;

  return {
    asOf: last.time,
    startDate: first.time,
    currentPrice: last.close,
    periodReturn: last.close / first.close - 1,
    annualizedVolatility: Math.sqrt(variance) * Math.sqrt(252),
    maxDrawdown,
    observationCount: valid.length,
  };
}
