import "server-only";

import type { PricePoint, StockData } from "./types";
import { isFundCode, yahooSymbolFromTicker } from "./instrument-resolver";

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
  const pageRes = await fetch(`https://finance.yahoo.co.jp/quote/${encodeURIComponent(ticker)}/history`, { headers, cache: "no-store" });
  if (!pageRes.ok) throw new StockSourceError(`Failed to fetch data for ${ticker}`, pageRes.status);
  const html = await pageRes.text();
  const jwtMatch = html.match(/"jwtToken":"([^"]+)"/);
  if (!jwtMatch) throw new StockSourceError("Failed to get fund authentication token", 502);
  const nameMatch = html.match(/"mainFundPriceBoard":\{[^}]*"name"\s*:\s*"([^"]+)"/);
  const fundName = nameMatch ? nameMatch[1] : ticker;
  const bffHeaders = { ...headers, "jwt-token": jwtMatch[1], Referer: `https://finance.yahoo.co.jp/quote/${ticker}/history` };
  type HistoryItem = { date: string; price: string; priceChange: string; netAssetsBalance: string };
  let allHistories: HistoryItem[] = [];
  let page = 1;
  const size = 100;
  while (true) {
    const apiUrl = `https://finance.yahoo.co.jp/bff-pc/v1/main/fund/price/history/${encodeURIComponent(ticker)}?fromDate=${fromDate}&toDate=${toDate}&page=${page}&size=${size}&timeFrame=daily`;
    const response = await fetch(apiUrl, { headers: bffHeaders, cache: "no-store" });
    if (!response.ok) throw new StockSourceError(`Failed to fetch data for ${ticker}`, response.status);
    const data = await response.json();
    if (data.error) throw new StockSourceError(data.error[0]?.message || "Fund data source error", 502);
    const histories: HistoryItem[] = data.histories || [];
    allHistories = allHistories.concat(histories);
    if (!data.paging?.hasNext) break;
    page++;
    if (page > 50) break;
  }
  const prices = allHistories
    .map((history): PricePoint | null => {
      const match = history.date.match(/(\d{4})\u5e74(\d{1,2})\u6708(\d{1,2})\u65e5/);
      if (!match) return null;
      const close = Number(history.price.replace(/,/g, ""));
      if (!Number.isFinite(close)) return null;
      const time = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
      return { time, open: close, high: close, low: close, close, volume: 0 };
    })
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
