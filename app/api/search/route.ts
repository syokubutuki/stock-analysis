import { getCache } from "@vercel/functions";
import { NextRequest, NextResponse } from "next/server";
import {
  hasSufficientLocalResults,
  normalizeSearchText,
  searchLocalInstruments,
} from "@/app/lib/instrument-search";
import { canonicalTickerFromYahooSymbol } from "@/app/lib/instrument-resolver";
import type { Instrument, InstrumentType } from "@/app/lib/instruments";

interface YahooQuote {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchDisp?: string;
  exchange?: string;
  quoteType?: string;
}

interface InstrumentSuggestion {
  ticker: string;
  symbol: string;
  name: string;
  type: InstrumentType;
  market: string;
  currency?: string;
  priceSupported: boolean;
  source: "catalog" | "yahoo";
}

interface YahooSearchResult {
  quotes: InstrumentSuggestion[];
  degraded: boolean;
}

interface MemoryEntry extends YahooSearchResult {
  expiresAt: number;
}

const ALLOWED_TYPES = new Set(["EQUITY", "ETF", "MUTUALFUND", "INDEX"]);
const MAX_QUERY_LENGTH = 80;
const MAX_RESULTS = 10;
const SUCCESS_TTL_SECONDS = 60 * 60;
const DEGRADED_TTL_SECONDS = 10 * 60;
const memoryCache = new Map<string, MemoryEntry>();
const inFlight = new Map<string, Promise<YahooSearchResult>>();

function fromCatalog(instrument: Instrument): InstrumentSuggestion {
  return {
    ticker: instrument.ticker,
    symbol: instrument.yahooSymbol,
    name: instrument.name,
    type: instrument.type,
    market: instrument.market,
    currency: instrument.currency,
    priceSupported: instrument.priceSupported,
    source: "catalog",
  };
}

function yahooType(quoteType: string | undefined, symbol: string): InstrumentType {
  if (quoteType === "ETF") return "etf";
  if (quoteType === "MUTUALFUND") return "fund";
  if (quoteType === "INDEX") return "index";
  return symbol.endsWith(".T") ? "jp-stock" : "us-stock";
}

function isYahooSearchResult(value: unknown): value is YahooSearchResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<YahooSearchResult>;
  return Array.isArray(candidate.quotes) && typeof candidate.degraded === "boolean";
}

async function fetchYahoo(query: string): Promise<YahooSearchResult> {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}` +
    `&quotesCount=${MAX_RESULTS}&newsCount=0&lang=ja-JP&region=JP`;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cache: "no-store",
    });
    if (!response.ok) return { quotes: [], degraded: true };
    const data = await response.json();
    const raw: YahooQuote[] = data.quotes ?? [];
    const quotes = raw.flatMap((quote): InstrumentSuggestion[] => {
      if (!quote.symbol || (quote.quoteType && !ALLOWED_TYPES.has(quote.quoteType))) return [];
      const symbol = quote.symbol.toUpperCase();
      const ticker = canonicalTickerFromYahooSymbol(symbol);
      if (!ticker) return [];
      const type = yahooType(quote.quoteType, symbol);
      return [{
        ticker,
        symbol,
        name: quote.longname || quote.shortname || symbol,
        type,
        market: quote.exchDisp || quote.exchange || "その他",
        currency: symbol.endsWith(".T") || type === "fund" ? "JPY" : undefined,
        priceSupported: true,
        source: "yahoo",
      }];
    });
    return { quotes, degraded: false };
  } catch (error) {
    console.warn("[instrument-search] Yahoo fallback failed", error);
    return { quotes: [], degraded: true };
  }
}

async function searchYahooCached(query: string): Promise<YahooSearchResult> {
  const key = `v1:${encodeURIComponent(normalizeSearchText(query))}`;
  const memory = memoryCache.get(key);
  if (memory && memory.expiresAt > Date.now()) return memory;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = (async () => {
    try {
      const cached = await getCache({ namespace: "instrument-search" }).get(key);
      if (isYahooSearchResult(cached)) return cached;
    } catch (error) {
      console.warn("[instrument-search] cache read failed", error);
    }

    const result = await fetchYahoo(query);
    const ttl = result.degraded || result.quotes.length === 0
      ? DEGRADED_TTL_SECONDS
      : SUCCESS_TTL_SECONDS;
    memoryCache.set(key, { ...result, expiresAt: Date.now() + ttl * 1000 });
    if (memoryCache.size > 100) memoryCache.delete(memoryCache.keys().next().value ?? key);
    try {
      await getCache({ namespace: "instrument-search" }).set(key, result, {
        ttl,
        tags: ["instrument-search"],
        name: "instrument-search-fallback",
      });
    } catch (error) {
      console.warn("[instrument-search] cache write failed", error);
    }
    return result;
  })();

  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    inFlight.delete(key);
  }
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ quotes: [], degraded: false });
  if (q.length > MAX_QUERY_LENGTH) {
    return NextResponse.json({ error: "検索語が長すぎます" }, { status: 400 });
  }

  const localResults = searchLocalInstruments(q, MAX_RESULTS);
  const local = localResults.map((result) => fromCatalog(result.instrument));
  if (q.length < 2 || hasSufficientLocalResults(localResults)) {
    return NextResponse.json({ quotes: local, degraded: false });
  }

  const yahoo = await searchYahooCached(q);
  const merged = [...local, ...yahoo.quotes].filter((item, index, rows) =>
    rows.findIndex((candidate) => candidate.symbol === item.symbol) === index,
  ).slice(0, MAX_RESULTS);
  return NextResponse.json({ quotes: merged, degraded: yahoo.degraded });
}
