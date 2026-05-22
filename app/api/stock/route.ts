import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker");
  if (!ticker) {
    return NextResponse.json({ error: "ticker is required" }, { status: 400 });
  }

  // 4桁数字なら東証銘柄として .T を付与
  const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker;

  try {
    const range = request.nextUrl.searchParams.get("range") || "1y";
    const validRanges = ["1mo", "3mo", "6mo", "1y", "2y", "3y", "5y"];
    const safeRange = validRanges.includes(range) ? range : "1y";
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${safeRange}&interval=1d`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Failed to fetch data for ${ticker}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) {
      return NextResponse.json(
        { error: `No data found for ${ticker}` },
        { status: 404 }
      );
    }

    const meta = result.meta;
    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0];
    const adjClose = result.indicators?.adjclose?.[0]?.adjclose;

    if (!quote || timestamps.length === 0) {
      return NextResponse.json(
        { error: `No price data for ${ticker}` },
        { status: 404 }
      );
    }

    const prices = timestamps
      .map((ts: number, i: number) => {
        const close = adjClose ? adjClose[i] : quote.close[i];
        if (close == null || quote.open[i] == null) return null;
        const date = new Date(ts * 1000);
        const time = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        return {
          time,
          open: quote.open[i],
          high: quote.high[i],
          low: quote.low[i],
          close,
          volume: quote.volume[i] || 0,
        };
      })
      .filter(Boolean);

    return NextResponse.json({
      ticker: symbol,
      name: meta.shortName || meta.symbol || symbol,
      currency: meta.currency || "JPY",
      prices,
    });
  } catch (e) {
    console.error("Stock API error:", e);
    return NextResponse.json(
      { error: "Failed to fetch stock data" },
      { status: 500 }
    );
  }
}
