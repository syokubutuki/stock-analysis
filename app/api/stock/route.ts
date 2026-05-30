import { NextRequest, NextResponse } from "next/server";

const isFundCode = (ticker: string) => /^\d{7,8}$/.test(ticker);

async function fetchFundData(ticker: string, range: string) {
  const now = new Date();
  const toDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;

  const rangeMonths: Record<string, number> = {
    "1mo": 1, "3mo": 3, "6mo": 6, "1y": 12, "2y": 24, "3y": 36, "5y": 60, "10y": 120,
  };
  const months = rangeMonths[range] || 12;
  const fromDateObj = new Date(now);
  fromDateObj.setMonth(fromDateObj.getMonth() - months);
  const fromDate = `${fromDateObj.getFullYear()}${String(fromDateObj.getMonth() + 1).padStart(2, "0")}${String(fromDateObj.getDate()).padStart(2, "0")}`;

  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };

  // Step 1: Get JWT token and fund name from the HTML page
  const pageRes = await fetch(
    `https://finance.yahoo.co.jp/quote/${encodeURIComponent(ticker)}/history`,
    { headers }
  );
  if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
  const html = await pageRes.text();

  const jwtMatch = html.match(/"jwtToken":"([^"]+)"/);
  if (!jwtMatch) throw new Error("Failed to get JWT token");
  const jwt = jwtMatch[1];

  const nameMatch = html.match(/"mainFundPriceBoard":\{[^}]*"name"\s*:\s*"([^"]+)"/);
  const fundName = nameMatch ? nameMatch[1] : ticker;

  // Step 2: Fetch history data from BFF API
  const bffHeaders = {
    ...headers,
    "jwt-token": jwt,
    "Referer": `https://finance.yahoo.co.jp/quote/${ticker}/history`,
  };

  type HistoryItem = { date: string; price: string; priceChange: string; netAssetsBalance: string };
  let allHistories: HistoryItem[] = [];
  let page = 1;
  const size = 100;

  while (true) {
    const apiUrl = `https://finance.yahoo.co.jp/bff-pc/v1/main/fund/price/history/${encodeURIComponent(ticker)}?fromDate=${fromDate}&toDate=${toDate}&page=${page}&size=${size}&timeFrame=daily`;
    const res = await fetch(apiUrl, { headers: bffHeaders });
    if (!res.ok) throw new Error(`BFF API error: HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error[0]?.message || "BFF API error");

    const histories: HistoryItem[] = data.histories || [];
    allHistories = allHistories.concat(histories);

    if (!data.paging?.hasNext) break;
    page++;
    if (page > 50) break; // safety limit
  }

  const parseDate = (dateStr: string): string | null => {
    const m = dateStr.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!m) return null;
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  };

  const prices = allHistories
    .map((h) => {
      const time = parseDate(h.date);
      if (!time) return null;
      const close = Number(h.price.replace(/,/g, ""));
      if (isNaN(close)) return null;
      return { time, open: close, high: close, low: close, close, volume: 0 };
    })
    .filter(Boolean)
    .sort((a, b) => a!.time.localeCompare(b!.time));

  return { ticker, name: fundName, currency: "JPY", prices };
}

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker");
  if (!ticker) {
    return NextResponse.json({ error: "ticker is required" }, { status: 400 });
  }

  const range = request.nextUrl.searchParams.get("range") || "1y";
  const validRanges = ["1mo", "3mo", "6mo", "1y", "2y", "3y", "5y", "10y"];
  const safeRange = validRanges.includes(range) ? range : "1y";

  try {
    // 7〜8桁数字は投資信託 → Yahoo!ファイナンス日本版から取得
    if (isFundCode(ticker)) {
      const data = await fetchFundData(ticker, safeRange);
      return NextResponse.json(data);
    }

    // 4桁数字なら東証銘柄として .T を付与
    const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker;

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
        const rawClose = quote.close[i];
        const close = adjClose ? adjClose[i] : rawClose;
        if (close == null || rawClose == null) return null;
        const adj = adjClose && rawClose !== 0 ? close / rawClose : 1;
        const date = new Date(ts * 1000);
        const time = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        return {
          time,
          open: (quote.open[i] ?? rawClose) * adj,
          high: (quote.high[i] ?? rawClose) * adj,
          low: (quote.low[i] ?? rawClose) * adj,
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
