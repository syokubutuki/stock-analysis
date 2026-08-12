import "server-only";

import { getCache } from "@vercel/functions";
import {
  repairPriceGlitches,
  SANITIZER_VERSION,
  type PriceSanityReport,
} from "./price-sanity";
import { fetchStockSource, type StockRange } from "./stock-source.server";
import type { PricePoint, StockData } from "./types";

const STOCK_CACHE_SCHEMA_VERSION = 1;
const STOCK_CACHE_FRESH_MS = 8 * 60 * 60 * 1000;
const STOCK_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const PRICE_SIGNIFICANT_DIGITS = 8;

interface StockCacheEntry {
  data: StockData;
  fetchedAt: number;
}

const inFlight = new Map<string, Promise<StockData>>();

/** 修復判定後の配信用価格だけを、価格水準によらない有効桁数で縮める。 */
function roundPricePayload(prices: PricePoint[]): PricePoint[] {
  return prices.map((price) => ({
    ...price,
    open: Number(price.open.toPrecision(PRICE_SIGNIFICANT_DIGITS)),
    high: Number(price.high.toPrecision(PRICE_SIGNIFICANT_DIGITS)),
    low: Number(price.low.toPrecision(PRICE_SIGNIFICANT_DIGITS)),
    close: Number(price.close.toPrecision(PRICE_SIGNIFICANT_DIGITS)),
  }));
}

function logSanity(ticker: string, report: PriceSanityReport): void {
  for (const glitch of report.repaired) {
    console.warn(
      `[price-sanity] ${ticker}: repaired ${glitch.from}..${glitch.to} (${glitch.days}d) factor=${glitch.factor}`,
    );
  }
  if (report.suspects.length > 0) {
    console.warn(
      `[price-sanity] ${ticker}: ${report.suspects.length} unrepaired jump(s) >35%: ` +
        report.suspects
          .map((suspect) => `${suspect.time}:${suspect.logReturn.toFixed(2)}`)
          .join(","),
    );
  }
}

function cacheKey(ticker: string, range: StockRange): string {
  return `v${STOCK_CACHE_SCHEMA_VERSION}:s${SANITIZER_VERSION}:${ticker}:${range}`;
}

function isStockCacheEntry(value: unknown): value is StockCacheEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StockCacheEntry>;
  return (
    typeof candidate.fetchedAt === "number" &&
    !!candidate.data &&
    Array.isArray(candidate.data.prices)
  );
}

async function fetchAndRepair(ticker: string, range: StockRange): Promise<StockData> {
  const data = await fetchStockSource(ticker, range);
  const fixed = repairPriceGlitches(data.prices);
  logSanity(ticker, fixed.report);
  return {
    ...data,
    prices: roundPricePayload(fixed.prices),
    dataQuality: fixed.report,
  };
}

async function readRuntimeCache(key: string): Promise<StockCacheEntry | null> {
  try {
    const value = await getCache({ namespace: "stock-prices" }).get(key);
    return isStockCacheEntry(value) ? value : null;
  } catch (error) {
    console.warn("[stock-cache] read failed; fetching from source", error);
    return null;
  }
}

async function refreshStockData(
  key: string,
  ticker: string,
  range: StockRange,
  stale: StockData | null,
): Promise<StockData> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const refresh = (async () => {
    try {
      const data = await fetchAndRepair(ticker, range);
      try {
        await getCache({ namespace: "stock-prices" }).set(
          key,
          { data, fetchedAt: Date.now() } satisfies StockCacheEntry,
          {
            ttl: STOCK_CACHE_TTL_SECONDS,
            tags: ["stock-prices", `stock:${ticker}`],
            name: "stock-price-history",
          },
        );
      } catch (error) {
        console.warn("[stock-cache] write failed; returning fresh data", error);
      }
      return data;
    } catch (error) {
      if (stale) {
        console.warn(`[stock-cache] refresh failed; serving stale ${ticker} ${range}`, error);
        return stale;
      }
      throw error;
    }
  })();

  inFlight.set(key, refresh);
  try {
    return await refresh;
  } finally {
    inFlight.delete(key);
  }
}

/** Shared repaired-price entry point for Route Handlers and Server Components. */
export async function getStockData(ticker: string, range: StockRange): Promise<StockData> {
  const key = cacheKey(ticker, range);
  const cached = await readRuntimeCache(key);
  if (cached && Date.now() - cached.fetchedAt <= STOCK_CACHE_FRESH_MS) {
    return cached.data;
  }
  return refreshStockData(key, ticker, range, cached?.data ?? null);
}
