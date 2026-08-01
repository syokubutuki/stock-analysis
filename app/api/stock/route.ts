import { NextRequest, NextResponse } from "next/server";
import { getStockData } from "@/app/lib/stock-data.server";
import {
  normalizeStockTicker,
  parseStockRange,
  StockSourceError,
} from "@/app/lib/stock-source.server";

const SUCCESS_CACHE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Vercel-CDN-Cache-Control":
    "public, s-maxage=3600, stale-while-revalidate=25200",
};

export async function GET(request: NextRequest) {
  const tickerParam = request.nextUrl.searchParams.get("ticker");
  if (!tickerParam) {
    return NextResponse.json({ error: "ticker is required" }, { status: 400 });
  }

  const ticker = normalizeStockTicker(tickerParam);
  if (!ticker) {
    return NextResponse.json({ error: "ticker is invalid" }, { status: 400 });
  }
  const range = parseStockRange(request.nextUrl.searchParams.get("range"));

  try {
    const data = await getStockData(ticker, range);
    return NextResponse.json(data, {
      headers: {
        ...SUCCESS_CACHE_HEADERS,
        "Vercel-Cache-Tag": `stock-prices,stock:${ticker}`,
      },
    });
  } catch (error) {
    if (error instanceof StockSourceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Stock API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch stock data" },
      { status: 500 },
    );
  }
}
