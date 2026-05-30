import { NextRequest, NextResponse } from "next/server";

const isFundCode = (ticker: string) => /^\d{7,8}$/.test(ticker);

async function fetchFundData(ticker: string, range: string) {
  const now = new Date();
  const to = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;

  const rangeMonths: Record<string, number> = {
    "1mo": 1, "3mo": 3, "6mo": 6, "1y": 12, "2y": 24, "3y": 36, "5y": 60, "10y": 120,
  };
  const months = rangeMonths[range] || 12;
  const fromDate = new Date(now);
  fromDate.setMonth(fromDate.getMonth() - months);
  const from = `${fromDate.getFullYear()}${String(fromDate.getMonth() + 1).padStart(2, "0")}${String(fromDate.getDate()).padStart(2, "0")}`;

  const baseUrl = `https://finance.yahoo.co.jp/quote/${encodeURIComponent(ticker)}/history?from=${from}&to=${to}&timeFrame=d`;
  const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

  // Fetch first page to get total pages and fund name
  const firstRes = await fetch(baseUrl, { headers });
  if (!firstRes.ok) throw new Error(`HTTP ${firstRes.status}`);
  const firstHtml = await firstRes.text();

  const stateMatch = firstHtml.match(/"mainFundHistory":\s*(\{.*?"isError"\s*:\s*(?:true|false)\s*\})/);
  if (!stateMatch) throw new Error("No fund history data found");

  const historyState = JSON.parse(stateMatch[1]);
  const totalPages = historyState.paging?.totalPage || 1;

  const nameMatch = firstHtml.match(/"mainFundPriceBoard":\s*\{.*?"name"\s*:\s*"([^"]+)"/);
  const fundName = nameMatch ? nameMatch[1] : ticker;

  type HistoryItem = { date: string; price: string; priceChange: string; netAssetsBalance: string };
  let allHistories: HistoryItem[] = historyState.histories || [];

  // Fetch remaining pages in parallel (max 5 concurrent)
  if (totalPages > 1) {
    const pageNumbers = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const chunkSize = 5;
    for (let i = 0; i < pageNumbers.length; i += chunkSize) {
      const chunk = pageNumbers.slice(i, i + chunkSize);
      const results = await Promise.all(
        chunk.map(async (page) => {
          const res = await fetch(`${baseUrl}&page=${page}`, { headers });
          if (!res.ok) return [];
          const html = await res.text();
          const m = html.match(/"mainFundHistory":\s*(\{.*?"isError"\s*:\s*(?:true|false)\s*\})/);
          if (!m) return [];
          const state = JSON.parse(m[1]);
          return (state.histories || []) as HistoryItem[];
        })
      );
      allHistories = allHistories.concat(results.flat());
    }
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
        const close = adjClose ? adjClose[i] : quote.close[i];
        if (close == null) return null;
        const date = new Date(ts * 1000);
        const time = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        return {
          time,
          open: quote.open[i] ?? close,
          high: quote.high[i] ?? close,
          low: quote.low[i] ?? close,
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
