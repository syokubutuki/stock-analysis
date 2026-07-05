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
// 同一キーの同時多発フェッチ(バスケットで同じ銘柄が重複した場合など)を1本に束ねる。
const inflight = new Map<string, Promise<IntradayResponse>>();

// 単発の日中足取得。キャッシュ命中なら即返し、進行中の同一リクエストがあれば相乗りする。
// 成功レスポンス(error無し)のみキャッシュする。フックとバスケットの双方が共有する。
export function fetchIntraday(ticker: string, interval: string): Promise<IntradayResponse> {
  const key = `${ticker}|${interval}`;
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const running = inflight.get(key);
  if (running) return running;

  const p = fetch(`/api/intraday?ticker=${encodeURIComponent(ticker)}&interval=${interval}`)
    .then(async (r) => {
      const json = (await r.json()) as IntradayResponse;
      if (!r.ok) return { ...json, error: json.error || "日中足の取得に失敗しました" };
      cache.set(key, json);
      return json;
    })
    .catch(() => ({ error: "ネットワークエラー" } as IntradayResponse))
    .finally(() => { inflight.delete(key); });

  inflight.set(key, p);
  return p;
}

export function useIntraday(ticker: string, interval: string) {
  const [resp, setResp] = useState<IntradayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setError(null); setResp(null);
    fetchIntraday(ticker, interval)
      .then((json) => {
        if (cancelled) return;
        if (json.error) { setError(json.error); return; }
        setResp(json);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticker, interval]);

  return { resp, loading, error };
}

export interface BasketItem {
  ticker: string;
  resp: IntradayResponse | null;
  error: string | null;
}

// 複数銘柄の日中足をまとめて取得する。各銘柄は fetchIntraday の共有キャッシュ経由なので
// 単一銘柄フックと重複フェッチしない。順序は tickers に一致し、欠損/エラー銘柄も items に残す
// (呼び出し側で「取得できた銘柄だけプール」できるように)。
export function useIntradayBasket(tickers: string[], interval: string) {
  const [items, setItems] = useState<BasketItem[]>([]);
  const [loading, setLoading] = useState(false);
  // 重複除去しつつ順序を保つ。依存配列を安定させるため文字列キー化。
  const uniq = Array.from(new Set(tickers.filter((t) => t && t.trim())));
  const key = `${uniq.join(",")}|${interval}`;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (uniq.length === 0) { setItems([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    Promise.all(
      uniq.map((t) =>
        fetchIntraday(t, interval).then((json): BasketItem => ({
          ticker: t,
          resp: json.error ? null : json,
          error: json.error || null,
        }))
      )
    ).then((res) => {
      if (cancelled) return;
      setItems(res);
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const ok = items.filter((it) => it.resp && it.resp.bars.length > 0);
  const error = ok.length === 0 && items.length > 0 && !loading
    ? "いずれの銘柄も日中足を取得できませんでした"
    : null;

  return { items, ok, loading, error };
}
