"use client";

// 米国指数(等)の日足を /api/stock から取得するフック。ticker 単位でモジュールキャッシュし、
// 複数のスピルオーバー分析コンポーネントが同じ指数を要求しても再フェッチしない。
// useIntraday と同じ設計。前夜米国の整合には日次終値のみあれば足りる(range=10y)。

import { useEffect, useState } from "react";
import { PricePoint } from "../lib/types";

const cache = new Map<string, PricePoint[]>();

export function useUsDaily(ticker: string) {
  const [prices, setPrices] = useState<PricePoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticker) return;
    const cached = cache.get(ticker);
    if (cached) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPrices(cached); setError(null); setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true); setError(null); setPrices(null);
    fetch(`/api/stock?ticker=${encodeURIComponent(ticker)}&range=10y`)
      .then(async (r) => {
        const json = await r.json();
        if (cancelled) return;
        if (!r.ok || !json.prices) { setError(json.error || "米国指数の取得に失敗しました"); return; }
        cache.set(ticker, json.prices);
        setPrices(json.prices);
      })
      .catch(() => { if (!cancelled) setError("ネットワークエラー"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticker]);

  return { prices, loading, error };
}

// スピルオーバー分析で共通利用する米国ドライバのプリセット。
export const US_DRIVERS = [
  { ticker: "^GSPC", label: "S&P500", note: "米国株全体" },
  { ticker: "^IXIC", label: "NASDAQ", note: "ハイテク寄り" },
  { ticker: "^SOX", label: "SOX(半導体)", note: "半導体・値がさ" },
  { ticker: "^DJI", label: "NYダウ", note: "大型景気敏感" },
] as const;
