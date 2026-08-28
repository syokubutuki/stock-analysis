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

/**
 * BFF から RSC へ退避してよい上流障害だけを判定する。
 * 404など入力に対する確定応答や、StockSourceError ではない実装例外まで握りつぶすと、
 * 不要な再取得と障害の見逃しになるため再送出する。
 */
function shouldFallbackFromFundBff(error: unknown): error is StockSourceError {
  if (!(error instanceof StockSourceError)) return false;
  return (
    error.status === 401 ||
    error.status === 403 ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    error.status >= 500
  );
}

export function parseStockRange(range: string | null): StockRange {
  return range && STOCK_RANGE_SET.has(range) ? (range as StockRange) : "1y";
}

export function normalizeStockTicker(ticker: string): string | null {
  return yahooSymbolFromTicker(ticker);
}

/**
 * 投信名は `<title>` から取ることがあり、そこはHTMLエスケープされている。
 * 解かないと「eMAXIS Slim米国株式(S&amp;P500)」がそのまま画面に出る（03311187 で再現）。
 * JSON由来の名前（priceBoard.name）は元からエスケープされていないので、通しても素通りする。
 */
function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  // 実体参照は入れ子で書かれることがある（&amp;lt; → &lt; → <）。&amp; を先に解くと
  // 二重に解けてしまうため、1回の走査で置換し、繰り返さない。
  return value.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g,
    (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      // 範囲外のコードポイントで fromCodePoint が例外を投げると価格取得ごと落ちる。
      // 名前の整形のために取得を失敗させる価値はないので、解けないものは原文のまま返す。
      const codePoint = dec !== undefined ? Number(dec)
        : hex !== undefined ? Number.parseInt(hex, 16)
        : null;
      if (codePoint !== null) {
        return codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match;
      }
      return name !== undefined && name.toLowerCase() in named
        ? named[name.toLowerCase()]
        : match;
    },
  );
}

interface YahooFundRscPage {
  isSuccess: boolean;
  message?: string;
  response?: YahooFundHistoryResponse["response"];
}

/**
 * Yahoo!ファイナンスの投信履歴ページに埋め込まれたRSCのinitialDataを読む暫定経路。
 * 履歴ページの内部構造に依存するため、通常のBFF経路とは分離し、形は
 * app/lib/fixtures/yahoo-fund-history-rsc.json に固定している。
 *
 * Yahoo!全体でJWTが廃止されたという意味ではない。履歴ページの配信版によって
 * 旧HTML -> JWT -> BFFの手順が成立しない場合だけ、この経路へ退避する。
 */
function parseYahooFundRscPage(source: string): YahooFundRscPage | null {
  const chunks = Array.from(
    source.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)\s*<\/script>/g),
    (match) => {
      try {
        return JSON.parse(match[1]) as string;
      } catch {
        return "";
      }
    },
  );
  const payload = chunks.length > 0 ? chunks.join("") : source;
  const keyIndex = payload.indexOf('"initialData":');
  if (keyIndex < 0) return null;
  const start = payload.indexOf("{", keyIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < payload.length; index += 1) {
    const character = payload[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const data = JSON.parse(payload.slice(start, index + 1)) as YahooFundRscPage;
          return typeof data.isSuccess === "boolean" ? data : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function fundHistoryUrl(
  pageUrl: string,
  fromDate: string,
  toDate: string,
  page: number,
): string {
  const params = new URLSearchParams({ fromDate, toDate, timeFrameId: "d", page: String(page) });
  return `${pageUrl}?${params}`;
}

async function fetchFundDataFromRsc(
  ticker: string,
  fundName: string,
  pageUrl: string,
  fromDate: string,
  toDate: string,
  headers: Record<string, string>,
): Promise<StockData> {
  const fetchPage = async (page: number): Promise<YahooFundRscPage> => {
    const response = await fetch(fundHistoryUrl(pageUrl, fromDate, toDate, page), {
      headers: { ...headers, Accept: "text/x-component", RSC: "1" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new StockSourceError(`Failed to fetch data for ${ticker}`, response.status);
    }
    const data = parseYahooFundRscPage(await response.text());
    if (!data?.isSuccess || !data.response) {
      throw new StockSourceError(data?.message || "Fund RSC data source error", 502);
    }
    return data;
  };

  const first = await fetchPage(1);
  const totalPage = first.response?.paging?.totalPage ?? 1;
  if (totalPage < 1 || totalPage > 200) {
    throw new StockSourceError("Unexpected fund history page count", 502);
  }

  const allHistories: YahooFundHistoryItem[] = [
    ...(first.response?.historyTable?.items ?? []),
  ];
  // RSCはBFFより応答が大きい。暫定経路では同時取得数を抑えて配信元への負荷を限定する。
  const concurrency = 2;
  for (let start = 2; start <= totalPage; start += concurrency) {
    const pages = Array.from(
      { length: Math.min(concurrency, totalPage - start + 1) },
      (_, index) => start + index,
    );
    const responses = await Promise.all(pages.map(fetchPage));
    for (const response of responses) {
      allHistories.push(...(response.response?.historyTable?.items ?? []));
    }
  }

  const prices = allHistories
    .map(yahooFundHistoryToPrice)
    .filter((price): price is PricePoint => price !== null)
    .sort((a, b) => a.time.localeCompare(b.time));
  if (prices.length === 0) throw new StockSourceError(`No price data for ${ticker}`, 404);
  return { ticker, name: fundName, currency: "JPY", prices };
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
  const titleName = html.match(/<title[^>]*>([^<]+?)【[^<]+】/)?.[1] ?? null;
  // JWT経路・RSC経路の両方がこの1本の名前を使うので、解くのはここ1箇所でよい。
  const fundName = decodeHtmlEntities(pageData?.name ?? titleName ?? ticker);
  if (!pageData) {
    console.warn(
      `[stock-source] fund JWT unavailable; falling back to RSC ticker=${ticker} range=${range}`,
    );
    return fetchFundDataFromRsc(ticker, fundName, pageUrl, fromDate, toDate, headers);
  }

  try {
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
      let response: Response;
      try {
        response = await fetch(apiUrl, { headers: bffHeaders, cache: "no-store" });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new StockSourceError(`Fund BFF network error for ${ticker}`, 502);
      }
      if (!response.ok) throw new StockSourceError(`Failed to fetch data for ${ticker}`, response.status);
      let data: YahooFundHistoryResponse;
      try {
        data = await response.json() as YahooFundHistoryResponse;
      } catch {
        throw new StockSourceError("Fund BFF returned invalid JSON", 502);
      }
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
    if (prices.length === 0) throw new StockSourceError(`No price data for ${ticker}`, 404);
    return { ticker, name: fundName, currency: "JPY", prices };
  } catch (error) {
    if (!shouldFallbackFromFundBff(error)) throw error;
    console.warn(
      `[stock-source] fund BFF failed; falling back to RSC ticker=${ticker} range=${range}`,
      error,
    );
    return fetchFundDataFromRsc(ticker, fundName, pageUrl, fromDate, toDate, headers);
  }
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
