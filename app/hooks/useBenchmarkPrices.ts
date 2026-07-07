"use client";

import { useEffect, useState } from "react";
import { PricePoint, StockData } from "../lib/types";

// 指数(ベンチマーク)価格の取得フック。/api/stock から10年分を取得する。
// 複数コンポーネントが同一指数を使うため、モジュール内キャッシュで再取得を避ける。

export interface BenchmarkPrices {
  prices: PricePoint[] | null;
  name: string;
  loading: boolean;
  error: string | null;
}

interface CacheEntry {
  prices: PricePoint[];
  name: string;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

async function fetchBench(ticker: string): Promise<CacheEntry> {
  const cached = cache.get(ticker);
  if (cached) return cached;
  const existing = inflight.get(ticker);
  if (existing) return existing;
  const p = (async () => {
    const res = await fetch(`/api/stock?ticker=${encodeURIComponent(ticker)}&range=10y`);
    const json = (await res.json()) as StockData & { error?: string };
    if (!res.ok) throw new Error(json.error || "取得失敗");
    const entry: CacheEntry = { prices: json.prices ?? [], name: json.name ?? ticker };
    cache.set(ticker, entry);
    return entry;
  })();
  inflight.set(ticker, p);
  try {
    return await p;
  } finally {
    inflight.delete(ticker);
  }
}

interface ResolvedEntry {
  ticker: string;
  prices: PricePoint[] | null;
  name: string;
  error: string | null;
}

export function useBenchmarkPrices(ticker: string): BenchmarkPrices {
  // 解決済みデータは ticker 付きで保持し、setState は非同期(fetch解決時)だけで行う。
  const [entry, setEntry] = useState<ResolvedEntry>(() => {
    const c = cache.get(ticker);
    return { ticker, prices: c?.prices ?? null, name: c?.name ?? ticker, error: null };
  });

  useEffect(() => {
    let cancelled = false;
    fetchBench(ticker)
      .then((e) => {
        if (!cancelled) setEntry({ ticker, prices: e.prices, name: e.name, error: null });
      })
      .catch((err) => {
        if (!cancelled) setEntry({ ticker, prices: null, name: ticker, error: String(err?.message || err) });
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  // 現在の ticker に対する値を render 中に導出(loading も派生。effect内 setState を避ける)。
  const cached = cache.get(ticker);
  const resolved = entry.ticker === ticker;
  const prices = resolved ? entry.prices : cached?.prices ?? null;
  const name = resolved ? entry.name : cached?.name ?? ticker;
  const error = resolved ? entry.error : null;
  const loading = prices === null && error === null;
  return { prices, name, loading, error };
}

// 主要ベンチマーク指数のプリセット。/api/stock(Yahoo Finance)で取得可能なシンボル。
export const BENCHMARK_PRESETS: { ticker: string; label: string; region: "JP" | "US" }[] = [
  { ticker: "^N225", label: "日経225", region: "JP" },
  { ticker: "1306.T", label: "TOPIX(ETF)", region: "JP" },
  { ticker: "^GSPC", label: "S&P500", region: "US" },
  { ticker: "^IXIC", label: "NASDAQ", region: "US" },
];
