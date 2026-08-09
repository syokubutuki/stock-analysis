import type { PricePoint } from "./types";

export interface YahooFundHistoryItem {
  date: string;
  price: string;
  priceChange: string;
  netAssetsBalance: string;
}

export interface YahooFundHistoryResponse {
  isSuccess: boolean;
  message?: string;
  response?: {
    historyTable?: {
      items?: YahooFundHistoryItem[];
      hasNext?: boolean;
    };
    paging?: {
      hasNext?: boolean;
      page?: number;
      size?: number;
      totalPage?: number;
      totalSize?: number;
    };
  };
}

export interface YahooFundPageData {
  jwtToken: string;
  name: string | null;
}

/**
 * Yahoo!ファイナンスのNext.js RSCペイロードに埋め込まれた値を読む。
 * 外部ページの構造に依存するため、取得処理から分離しfixtureで形を固定する。
 */
export function parseYahooFundPage(html: string): YahooFundPageData | null {
  const jwtToken = html.match(/\\\"jwtToken\\\":\\\"([^\"\\]+)\\\"/)?.[1]
    ?? html.match(/"jwtToken":"([^"]+)"/)?.[1];
  if (!jwtToken) return null;

  const escapedName = html.match(
    /\\\"priceBoard\\\":\{\\\"code\\\":\\\"[^\"\\]+\\\",\\\"name\\\":\\\"([^\"\\]+)\\\"/,
  )?.[1];
  const titleName = html.match(/<title[^>]*>([^<]+?)【[^<]+】/)?.[1];

  return {
    jwtToken,
    name: escapedName ?? titleName ?? null,
  };
}

export function yahooFundHistoryToPrice(item: YahooFundHistoryItem): PricePoint | null {
  const match = item.date.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) return null;
  const close = Number(item.price.replace(/,/g, ""));
  if (!Number.isFinite(close)) return null;
  const time = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return { time, open: close, high: close, low: close, close, volume: 0 };
}
