import "server-only";

import type { PricePoint, StockData } from "./types";
import { isFundCode, yahooSymbolFromTicker } from "./instrument-resolver";
import {
  parseYahooFundPage,
  yahooFundHistoryToPrice,
  type YahooFundHistoryItem,
  type YahooFundHistoryResponse,
} from "./yahoo-fund-history";

export const STOCK_RANGES = [
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "2y",
  "3y",
  "5y",
  "10y",
] as const;

export type StockRange = (typeof STOCK_RANGES)[number];

const STOCK_RANGE_SET = new Set<string>(STOCK_RANGES);

export class StockSourceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "StockSourceError";
  }
}

export function parseStockRange(range: string | null): StockRange {
  return range && STOCK_RANGE_SET.has(range) ? (range as StockRange) : "1y";
}

export function normalizeStockTicker(ticker: string): string | null {
  return yahooSymbolFromTicker(ticker);
}

async function fetchFundData(ticker: string, range: StockRange): Promise<StockData> {
  const now = new Date();
  const toDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const rangeMonths: Record<StockRange, number> = {
    "1mo": 1, "3mo": 3, "6mo": 6, "1y": 12, "2y": 24, "3y": 36, "5y": 60, "10y": 120,
  };
  const fromDateObj = new Date(now);
  fromDateObj.setMonth(fromDateObj.getMonth() - rangeMonths[range]);
  const fromDate = `${fromDateObj.getFullYear()}${String(fromDateObj.getMonth() + 1).padStart(2, "0")}${String(fromDateObj.getDate()).padStart(2, "0")}`;
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };
  const pageUrl = `https://finance.yahoo.co.jp/quote/${encodeURIComponent(ticker)}/history`;
  const pageRes = await fetch(pageUrl, { headers, cache: "no-store" });
  if (!pageRes.ok) throw new StockSourceError(`Failed to fetch data for ${ticker}`, pageRes.status);
  const html = await pageRes.text();
  const pageData = parseYahooFundPage(html);
  if (!pageData) throw new StockSourceError("Failed to get fund authentication token", 502);
  const fundName = pageData.name ?? ticker;

  const getSetCookie = (pageRes.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookies = getSetCookie?.call(pageRes.headers)
    ?? [pageRes.headers.get("set-cookie") ?? ""];
  const cookie = setCookies
    .flatMap((value) => value.split(/,(?=\s*[^;,=\s]+=)/))
    .map((value) => value.split(";", 1)[0].trim())
    .filter(Boolean)
    .join("; ");
  if (!cookie) throw new StockSourceError("Failed to establish fund data session", 502);

  const bffHeaders = {
    ...headers,
    Accept: "application/json",
    Cookie: cookie,
    Referer: pageUrl,
    "x-jwt-token": pageData.jwtToken,
  };
  const fetchHistoryPage = async (page: number): Promise<YahooFundHistoryResponse> => {
    const params = new URLSearchParams({
      code: ticker,
      fromDate,
      toDate,
      timeFrameId: "d",
      page: String(page),
    });
    const apiUrl = `https://finance.yahoo.co.jp/bff-quote/v1/ajax/funds/history?${params}`;
    const response = await fetch(apiUrl, { headers: bffHeaders, cache: "no-store" });
    if (!response.ok) throw new StockSourceError(`Failed to fetch data for ${ticker}`, response.status);
    const data = await response.json() as YahooFundHistoryResponse;
    if (!data.isSuccess || !data.response) {
      throw new StockSourceError(data.message || "Fund data source error", 502);
    }
    return data;
  };

  const first = await fetchHistoryPage(1);
  const firstItems = first.response?.historyTable?.items ?? [];
  const totalPage = first.response?.paging?.totalPage ?? 1;
  if (totalPage < 1 || totalPage > 200) {
    throw new StockSourceError("Unexpected fund history page count", 502);
  }

  const allHistories: YahooFundHistoryItem[] = [...firstItems];
  const concurrency = 4;
  for (let start = 2; start <= totalPage; start += concurrency) {
    const pages = Array.from(
      { length: Math.min(concurrency, totalPage - start + 1) },
      (_, index) => start + index,
    );
    const responses = await Promise.all(pages.map(fetchHistoryPage));
    for (const response of responses) {
      allHistories.push(...(response.response?.historyTable?.items ?? []));
    }
  }
  const prices = allHistories
    .map(yahooFundHistoryToPrice)
    .filter((price): price is PricePoint => price !== null)
    .sort((a, b) => a.time.localeCompare(b.time));
  return { ticker, name: fundName, currency: "JPY", prices };
}

async function fetchChartData(ticker: string, range: StockRange): Promise<StockData> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=1d`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" });
  if (!response.ok) throw new StockSourceError(`Failed to fetch data for ${ticker}`, response.status);
  const data = await response.json();
  const result = data.chart?.result?.[0];
  if (!result) throw new StockSourceError(`No data found for ${ticker}`, 404);
  const meta = result.meta;
  const timestamps: number[] = result.timestamp || [];
  const quote = result.indicators?.quote?.[0];
  const adjClose = result.indicators?.adjclose?.[0]?.adjclose;
  if (!quote || timestamps.length === 0) throw new StockSourceError(`No price data for ${ticker}`, 404);
  const prices = timestamps
    .map((timestamp: number, index: number): PricePoint | null => {
      const rawClose = quote.close[index];
      const close = adjClose ? adjClose[index] : rawClose;
      if (close == null || rawClose == null) return null;
      const adjustment = adjClose && rawClose !== 0 ? close / rawClose : 1;
      const date = new Date(timestamp * 1000);
      const time = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      return {
        time,
        open: (quote.open[index] ?? rawClose) * adjustment,
        high: (quote.high[index] ?? rawClose) * adjustment,
        low: (quote.low[index] ?? rawClose) * adjustment,
        close,
        volume: quote.volume[index] || 0,
      };
    })
    .filter((price): price is PricePoint => price !== null);
  return { ticker, name: meta.shortName || meta.symbol || ticker, currency: meta.currency || "JPY", prices };
}

export async function fetchStockSource(ticker: string, range: StockRange): Promise<StockData> {
  console.info(`[stock-source] fetch ${ticker} range=${range}`);
  return isFundCode(ticker) ? fetchFundData(ticker, range) : fetchChartData(ticker, range);
}
