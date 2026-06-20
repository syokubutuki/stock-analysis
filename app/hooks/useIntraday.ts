"use client";

import { useEffect, useState } from "react";
import { IntradayBar } from "../lib/intraday-core";

export interface IntradayResponse {
  symbol: string;
  name?: string;
  interval: string;
  range: string;
  gmtoffset: number;
  timezone: string;
  currency?: string;
  bars: IntradayBar[];
  error?: string;
}

// (ticker, interval) 単位でモジュールレベルにキャッシュし、複数の日中足コンポーネントが
// 同じ足を要求しても再フェッチしないようにする。
const cache = new Map<string, IntradayResponse>();

export function useIntraday(ticker: string, interval: string) {
  const [resp, setResp] = useState<IntradayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticker) return;
    const key = `${ticker}|${interval}`;
    const cached = cache.get(key);
    if (cached) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResp(cached); setError(null); setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true); setError(null); setResp(null);
    fetch(`/api/intraday?ticker=${encodeURIComponent(ticker)}&interval=${interval}`)
      .then(async (r) => {
        const json = (await r.json()) as IntradayResponse;
        if (cancelled) return;
        if (!r.ok) { setError(json.error || "日中足の取得に失敗しました"); return; }
        cache.set(key, json);
        setResp(json);
      })
      .catch(() => { if (!cancelled) setError("ネットワークエラー"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticker, interval]);

  return { resp, loading, error };
}
