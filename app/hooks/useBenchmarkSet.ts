"use client";

import { useEffect, useState } from "react";
import { fetchBenchmarkPrices, type CacheEntry } from "./useBenchmarkPrices";

// 複数の参照系列（金・BTC・金利・為替…）を /api/stock から10年分まとめて取得するフック。
// useBenchmarkPrices とモジュールキャッシュを共有するので、他の分析が取得済みの系列は再取得しない。
// 同時接続は CONCURRENCY 本に抑える（数十本を一斉に投げると最初の表示がかえって遅くなる）。

const CONCURRENCY = 6;

export interface BenchmarkSet {
  entries: Map<string, CacheEntry>;
  failed: string[];
  done: number;
  total: number;
  loading: boolean;
}

export function useBenchmarkSet(tickers: readonly string[]): BenchmarkSet {
  const key = tickers.join("|");
  const [state, setState] = useState<{ key: string; entries: Map<string, CacheEntry>; failed: string[]; done: number }>(
    () => ({ key, entries: new Map(), failed: [], done: 0 }),
  );

  useEffect(() => {
    let cancelled = false;
    const list = key.split("|").filter(Boolean);
    const entries = new Map<string, CacheEntry>();
    const failed: string[] = [];
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < list.length) {
        const t = list[next++];
        try {
          entries.set(t, await fetchBenchmarkPrices(t));
        } catch {
          failed.push(t);
        }
        done++;
        if (!cancelled) setState({ key, entries: new Map(entries), failed: [...failed], done });
      }
    };
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
    return () => {
      cancelled = true;
    };
  }, [key]);

  const total = tickers.length;
  const resolved = state.key === key;
  const done = resolved ? state.done : 0;
  return {
    entries: resolved ? state.entries : new Map(),
    failed: resolved ? state.failed : [],
    done,
    total,
    loading: done < total,
  };
}
