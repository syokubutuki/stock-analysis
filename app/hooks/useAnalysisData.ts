"use client";

import { useState, useCallback, useMemo } from "react";
import { StockData, PricePoint } from "../lib/types";

export type PeriodKey = "1m" | "3m" | "6m" | "1y" | "2y" | "3y";

const PERIOD_DAYS: Record<PeriodKey, number> = {
  "1m": 21,
  "3m": 63,
  "6m": 126,
  "1y": 252,
  "2y": 504,
  "3y": 756,
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
    setData(null);

    try {
      const res = await fetch(
        `/api/stock?ticker=${encodeURIComponent(ticker.trim())}&range=3y`
      );
      const json = await res.json();
      if (!res.ok) {
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

  const filteredPrices: PricePoint[] = useMemo(() => {
    if (!data?.prices) return [];
    const maxDays = PERIOD_DAYS[period];
    const prices = data.prices;
    if (prices.length <= maxDays) return prices;
    return prices.slice(prices.length - maxDays);
  }, [data, period]);

  return { data, filteredPrices, loading, error, fetchStock, period, setPeriod };
}
