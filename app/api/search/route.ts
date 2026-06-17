import { NextRequest, NextResponse } from "next/server";

// Yahoo! Finance の銘柄検索（オートコンプリート）をプロキシする。
// 社名（「トヨタ」「ソフトバンク」）・コード（「9984」）・米国ティッカー（「AAPL」）の
// いずれでも候補を返す。東証銘柄は ".T" サフィックスを取り除いた 4桁コードに正規化し、
// /api/stock がそのまま解釈できる ticker を渡す。

interface YahooQuote {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchDisp?: string;
  exchange?: string;
  quoteType?: string;
}

interface Suggestion {
  symbol: string;
  ticker: string;
  name: string;
  exchange: string;
}

const ALLOWED_TYPES = new Set(["EQUITY", "ETF", "MUTUALFUND", "INDEX"]);

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 1) {
    return NextResponse.json({ quotes: [] });
  }

  try {
    const url =
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}` +
      `&quotesCount=10&newsCount=0&lang=ja-JP&region=JP`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) {
      return NextResponse.json({ quotes: [] });
    }

    const data = await res.json();
    const raw: YahooQuote[] = data.quotes ?? [];
    const quotes: Suggestion[] = raw
      .filter((x) => x.symbol && (!x.quoteType || ALLOWED_TYPES.has(x.quoteType)))
      .map((x) => {
        const symbol = x.symbol as string;
        const isTokyo = symbol.endsWith(".T");
        return {
          symbol,
          ticker: isTokyo ? symbol.slice(0, -2) : symbol,
          name: x.longname || x.shortname || symbol,
          exchange: x.exchDisp || x.exchange || "",
        };
      });

    return NextResponse.json({ quotes });
  } catch {
    // 検索失敗時は静かに空を返す（手入力でのコード分析は引き続き可能）
    return NextResponse.json({ quotes: [] });
  }
}
