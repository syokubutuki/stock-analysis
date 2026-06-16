"use client";

import { useEffect, useRef, useState } from "react";
import { Horizon, SignalDigest } from "../lib/signal-digest";
import type {
  DigestWorkerRequest,
  DigestWorkerResponse,
} from "../lib/portfolio-digest.worker";
import { PortfolioData } from "./usePortfolioData";

// 取得済み価格データ + 時間軸から、Worker で蒸留結果(SignalDigest)を計算する。
// 銘柄ごとに逐次到着するため digests は部分的に埋まっていく。
export function usePortfolioDigests(data: PortfolioData, horizon: Horizon) {
  const [digests, setDigests] = useState<Record<string, SignalDigest>>({});
  const [computing, setComputing] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  // Worker 起動
  useEffect(() => {
    const worker = new Worker(
      new URL("../lib/portfolio-digest.worker.ts", import.meta.url)
    );
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<DigestWorkerResponse>) => {
      if (ev.data.reqId !== reqIdRef.current) return; // 古い応答は破棄
      if (ev.data.done) {
        setComputing(false);
        return;
      }
      if (ev.data.ticker && ev.data.digest) {
        const t = ev.data.ticker;
        const dg = ev.data.digest;
        setDigests((prev) => ({ ...prev, [t]: dg }));
      }
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // 計算リクエスト送信(データ or 時間軸が変わったら)
  const dataKey = Object.keys(data).sort().join(",");
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const jobs = Object.entries(data)
      .filter(([, v]) => v.prices.length > 0)
      .map(([ticker, v]) => ({ ticker, name: v.name, prices: v.prices }));
    if (jobs.length === 0) {
      setDigests({});
      return;
    }
    const reqId = ++reqIdRef.current;
    setComputing(true);
    const req: DigestWorkerRequest = { reqId, jobs, horizon };
    worker.postMessage(req);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, horizon]);

  return { digests, computing };
}
