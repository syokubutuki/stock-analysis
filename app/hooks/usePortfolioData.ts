"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PricePoint, StockData } from "../lib/types";
import { getCached, putCached, DEFAULT_TTL_MS } from "../lib/price-cache";

export interface FetchedStock {
  prices: PricePoint[];
  name: string;
  error?: string;
}

export type PortfolioData = Record<string, FetchedStock>;

const CONCURRENCY = 4;

// セッション内メモリキャッシュ(同一銘柄の再取得を避ける)
const memCache = new Map<string, FetchedStock>();

async function fetchOne(ticker: string): Promise<FetchedStock> {
  // L1: セッション内メモリ
  const cached = memCache.get(ticker);
  if (cached) return cached;
  // L2: IndexedDB(ページ再読込を跨ぐ永続キャッシュ・TTL内なら Yahoo を叩かない)
  const idb = await getCached(ticker, DEFAULT_TTL_MS);
  if (idb) {
    const result: FetchedStock = { prices: idb.prices, name: idb.name };
    memCache.set(ticker, result);
    return result;
  }
  // L3: Yahoo 実取得
  try {
    const res = await fetch(`/api/stock?ticker=${encodeURIComponent(ticker)}&range=10y`);
    const json = (await res.json()) as StockData & { error?: string };
    if (!res.ok) {
      return { prices: [], name: ticker, error: json.error || "取得失敗" };
    }
    const result: FetchedStock = { prices: json.prices ?? [], name: json.name ?? ticker };
    memCache.set(ticker, result);
    if (result.prices.length > 0) void putCached(ticker, result.name, result.prices);
    return result;
  } catch {
    return { prices: [], name: ticker, error: "通信エラー" };
  }
}

// 同時実行数を制限しながら全ティッカーを取得する。
export function usePortfolioData(tickers: string[]) {
  const [data, setData] = useState<PortfolioData>({});
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const runIdRef = useRef(0);

  const load = useCallback(async (list: string[]) => {
    const runId = ++runIdRef.current;
    if (list.length === 0) {
      setData({});
      setProgress({ done: 0, total: 0 });
      return;
    }
    setLoading(true);
    setProgress({ done: 0, total: list.length });

    const result: PortfolioData = {};
    let done = 0;
    const queue = [...list];

    async function worker() {
      while (queue.length > 0) {
        const t = queue.shift()!;
        const r = await fetchOne(t);
        if (runId !== runIdRef.current) return; // 新しい読み込みが始まったら破棄
        result[t] = r;
        done++;
        setProgress({ done, total: list.length });
        setData({ ...result });
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker)
    );
    if (runId === runIdRef.current) setLoading(false);
  }, []);

  useEffect(() => {
    load(tickers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers.join(",")]);

  const reload = useCallback(() => {
    tickers.forEach((t) => memCache.delete(t));
    load(tickers);
  }, [tickers, load]);

  return { data, loading, progress, reload };
}
