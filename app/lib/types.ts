import type { PriceSanityReport } from "./price-sanity";

export interface PricePoint {
  time: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StockData {
  ticker: string;
  name: string;
  prices: PricePoint[];
  currency: string;
  /**
   * 取得時に検出した価格スケール破損の記録（app/lib/price-sanity.ts）。
   * prices は既に修復済み。UI で「黙って書き換えた」ことを開示するために使う。
   */
  dataQuality?: PriceSanityReport;
}
