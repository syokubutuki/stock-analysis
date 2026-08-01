const FUND_CODE_PATTERN = /^[0-9][0-9A-Z]{6,7}$/;
const TSE_CODE_PATTERN = /^\d[0-9A-Z]\d[0-9A-Z]$/;
const YAHOO_SYMBOL_PATTERN = /^[A-Z0-9.^=-]+$/;

/** URL・検索・価格取得で共有する、銘柄コードの表記正規化。 */
export function normalizeInstrumentCode(value: string): string | null {
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  if (!normalized || normalized.length > 32 || !YAHOO_SYMBOL_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

export function canonicalTickerFromYahooSymbol(symbol: string): string | null {
  const normalized = normalizeInstrumentCode(symbol);
  if (!normalized) return null;
  return normalized.endsWith(".T") ? normalized.slice(0, -2) : normalized;
}

export function yahooSymbolFromTicker(ticker: string): string | null {
  const normalized = normalizeInstrumentCode(ticker);
  if (!normalized) return null;
  if (normalized.endsWith(".T")) return normalized;
  if (FUND_CODE_PATTERN.test(normalized)) return normalized;
  return TSE_CODE_PATTERN.test(normalized) ? `${normalized}.T` : normalized;
}

export function isFundCode(value: string): boolean {
  const normalized = normalizeInstrumentCode(value);
  return normalized !== null && FUND_CODE_PATTERN.test(normalized);
}
