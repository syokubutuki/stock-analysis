"use client";

import { useState, useCallback, useMemo } from "react";
import { StockData, PricePoint } from "../lib/types";

export type PeriodKey = "1m" | "3m" | "6m" | "1y" | "2y" | "3y" | "5y" | "10y";

const PERIOD_DAYS: Record<PeriodKey, number> = {
  "1m": 21,
  "3m": 63,
  "6m": 126,
  "1y": 252,
  "2y": 504,
  "3y": 756,
  "5y": 1260,
  "10y": 2520,
};

export function useAnalysisData() {
  const [data, setData] = useState<StockData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodKey>("6m");

  const fetchStock = useCallback(async (ticker: string) => {
    if (!ticker.trim()) return;
    setLoading(true);
    setError(null);
    // NOTE: あえて setData(null) しない。取得中に data を空にすると分析コンテンツ
    // 全体がアンマウントされ、ページ高さがヘッダーだけに潰れてブラウザがスクロール
    // 位置を最上部に戻してしまう（＝再検索のたびに見ていた分析から引き剥がされる）。
    // 旧データを表示したまま成功時にだけ差し替えれば、ページが潰れないのでスクロール
    // 位置が保たれ、ブラウザ標準のスクロールアンカリングも効いて表示中パネルに留まる。

    try {
      const res = await fetch(
        `/api/stock?ticker=${encodeURIComponent(ticker.trim())}&range=10y`
      );
      const json = await res.json();
      if (!res.ok) {
        // 取得失敗時も旧データは残す（画面を潰さずエラーバナーだけ出す）。
        setError(json.error || "Failed to fetch");
        return;
      }
      setData(json);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  const allPrices: PricePoint[] = useMemo(() => {
    return data?.prices ?? [];
  }, [data]);

  const filteredPrices: PricePoint[] = useMemo(() => {
    if (!data?.prices) return [];
    const maxDays = PERIOD_DAYS[period];
    const prices = data.prices;
    if (prices.length <= maxDays) return prices;
    return prices.slice(prices.length - maxDays);
  }, [data, period]);

  return { data, allPrices, filteredPrices, loading, error, fetchStock, period, setPeriod };
}
