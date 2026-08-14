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
 * 1年の日足終値から、銘柄ページに掲載する実測サマリーを計算する。
 * ボラティリティは日次対数リターンの標本標準偏差を √252 倍する。
 */
export function buildTickerPageSummary(prices: PricePoint[]): TickerPageSummary | null {
  const valid = prices.filter(
    (price) => Number.isFinite(price.close) && price.close > 0,
  );
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
