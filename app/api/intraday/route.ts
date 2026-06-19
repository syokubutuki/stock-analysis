import { NextRequest, NextResponse } from "next/server";

// 東証コード判定（/api/stock と同じ規則）。
// data.ticker は既に "7203.T" のように解決済みで渡ってくる想定だが、
// 生コード（"7203" / "285A"）が来ても .T を付けられるよう保険として残す。
const isTseCode = (ticker: string) => /^\d[0-9A-Za-z]\d[0-9A-Za-z]$/.test(ticker);

// interval ごとに Yahoo が返せる過去期間の上限。細かい足ほど短い。
const INTERVAL_RANGE: Record<string, string> = {
  "1m": "7d",
  "5m": "60d",
  "15m": "60d",
  "30m": "60d",
  "60m": "730d",
};

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker");
  if (!ticker) {
    return NextResponse.json({ error: "ticker is required" }, { status: 400 });
  }

  const intervalParam = request.nextUrl.searchParams.get("interval") || "5m";
  const interval = INTERVAL_RANGE[intervalParam] ? intervalParam : "5m";
  // range はクライアント指定を許すが、interval の上限を超えないようにする。
  const requestedRange = request.nextUrl.searchParams.get("range");
  const maxRange = INTERVAL_RANGE[interval];
  const range = requestedRange || maxRange;

  // 既に ".T" 等のサフィックスが付いていれば触らない。生の東証コードのみ .T を付ける。
  const symbol = isTseCode(ticker) ? `${ticker.toUpperCase()}.T` : ticker;

  try {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=${interval}&range=${range}&includePrePost=false`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Failed to fetch intraday data for ${ticker}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) {
      return NextResponse.json(
        { error: `No intraday data for ${ticker}` },
        { status: 404 }
      );
    }

    const meta = result.meta;
    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0];
    if (!quote || timestamps.length === 0) {
      return NextResponse.json(
        { error: `No intraday price data for ${ticker}（投資信託や一部銘柄は日中足に非対応です）` },
        { status: 404 }
      );
    }

    const bars = timestamps
      .map((ts: number, i: number) => {
        const open = quote.open[i];
        const high = quote.high[i];
        const low = quote.low[i];
        const close = quote.close[i];
        if (open == null || high == null || low == null || close == null) return null;
        return { ts, open, high, low, close, volume: quote.volume[i] || 0 };
      })
      .filter(Boolean);

    return NextResponse.json({
      symbol,
      name: meta.shortName || meta.symbol || symbol,
      interval,
      range,
      // 取引所ローカル時刻 = (ts + gmtoffset) で算出するためクライアントへ渡す
      gmtoffset: meta.gmtoffset ?? 0,
      timezone: meta.exchangeTimezoneName || meta.timezone || "",
      currency: meta.currency || "",
      bars,
    });
  } catch (e) {
    console.error("Intraday API error:", e);
    return NextResponse.json(
      { error: "Failed to fetch intraday data" },
      { status: 500 }
    );
  }
}
