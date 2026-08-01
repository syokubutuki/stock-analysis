import { canonicalTickerFromYahooSymbol } from "./instrument-resolver";
import { getUniverse } from "./universes";

export type InstrumentType = "jp-stock" | "us-stock" | "etf" | "fund" | "index";
export interface Instrument {
  ticker: string;
  yahooSymbol: string;
  name: string;
  nameEn?: string;
  aliases: string[];
  type: InstrumentType;
  market: string;
  currency: string;
  priceSupported: boolean;
  major: boolean;
}

const ALIASES: Record<string, string[]> = {
  "7203": ["トヨタ", "TOYOTA"], "6758": ["ソニー", "SONY"],
  "9984": ["ソフトバンク", "ソフトバンクグループ", "SBG"],
  "9434": ["ソフトバンク", "ソフトバンク株式会社"],
  "8306": ["三菱UFJ", "MUFG"], "9432": ["NTT"],
  "7267": ["ホンダ", "HONDA"], "2914": ["JT"],
};

const majorJpStocks: Instrument[] = (getUniverse("major100")?.tickers ?? []).map((row) => {
  const ticker = canonicalTickerFromYahooSymbol(row.ticker) ?? row.ticker;
  return {
    ticker, yahooSymbol: row.ticker, name: row.name, aliases: ALIASES[ticker] ?? [],
    type: "jp-stock", market: "東証", currency: "JPY", priceSupported: true, major: true,
  };
});

type Extra = [string, string, InstrumentType, string, string[], string?];
const extras: Extra[] = [
  ["^N225", "日経平均株価", "index", "日本", ["日経平均", "日経225", "NIKKEI", "NIKKEI225"], "Nikkei 225"],
  ["^TPX", "TOPIX", "index", "日本", ["東証株価指数", "トピックス"]],
  ["^GSPC", "S&P 500", "index", "米国", ["S&P500", "SP500", "エスアンドピー500"]],
  ["^DJI", "ダウ平均株価", "index", "米国", ["NYダウ", "ダウ", "DOW"]],
  ["^IXIC", "NASDAQ総合指数", "index", "米国", ["ナスダック", "NASDAQ"]],
  ["AAPL", "アップル", "us-stock", "NASDAQ", ["APPLE"], "Apple Inc."],
  ["MSFT", "マイクロソフト", "us-stock", "NASDAQ", ["MICROSOFT"], "Microsoft Corporation"],
  ["NVDA", "エヌビディア", "us-stock", "NASDAQ", ["NVIDIA"], "NVIDIA Corporation"],
  ["AMZN", "アマゾン", "us-stock", "NASDAQ", ["AMAZON"]],
  ["GOOGL", "アルファベット", "us-stock", "NASDAQ", ["GOOGLE", "グーグル"]],
  ["META", "メタ・プラットフォームズ", "us-stock", "NASDAQ", ["FACEBOOK", "フェイスブック"]],
  ["TSLA", "テスラ", "us-stock", "NASDAQ", ["TESLA"]],
  ["SPY", "SPDR S&P 500 ETF", "etf", "NYSE Arca", ["S&P500 ETF"]],
  ["QQQ", "Invesco QQQ Trust", "etf", "NASDAQ", ["NASDAQ100 ETF", "ナスダック100 ETF"]],
  ["GLD", "SPDR Gold Shares", "etf", "NYSE Arca", ["ゴールド", "金", "GOLD"]],
  ["0331418A", "eMAXIS Slim 全世界株式（オール・カントリー）", "fund", "投資信託", ["オルカン", "全世界株式", "Emaxis Slim オールカントリー"]],
];

const otherInstruments: Instrument[] = extras.map(([ticker, name, type, market, aliases, nameEn]) => ({
  ticker, yahooSymbol: ticker, name, nameEn, aliases, type, market,
  currency: market === "日本" || market === "投資信託" ? "JPY" : "USD",
  priceSupported: type !== "fund", major: true,
}));

export const INSTRUMENTS: readonly Instrument[] = [...majorJpStocks, ...otherInstruments];
const byTicker = new Map(INSTRUMENTS.map((item) => [item.ticker, item]));
const bySymbol = new Map(INSTRUMENTS.map((item) => [item.yahooSymbol, item]));

export function getInstrumentByTicker(value: string): Instrument | undefined {
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  return byTicker.get(normalized) ?? bySymbol.get(normalized);
}
