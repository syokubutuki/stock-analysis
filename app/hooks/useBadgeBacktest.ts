"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Horizon } from "../lib/signal-digest";
import type { BacktestResult } from "../lib/badge-backtest";
import type {
  BacktestWorkerRequest,
  BacktestWorkerResponse,
} from "../lib/badge-backtest.worker";
import { PortfolioData } from "./usePortfolioData";

// 判定実績化のバックテスト。重いので run() の明示実行のみ。
// data / horizon が変わったら結果を破棄(再実行を促す)。
export function useBadgeBacktest(data: PortfolioData, horizon: Horizon) {
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const worker = new Worker(
      new URL("../lib/badge-backtest.worker.ts", import.meta.url)
    );
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<BacktestWorkerResponse>) => {
      if (ev.data.reqId !== reqIdRef.current) return;
      if (ev.data.progress) setProgress(ev.data.progress);
      if (ev.data.result) {
        setResult(ev.data.result);
        setRunning(false);
      }
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // 入力が変わったら古い実績を無効化
  const dataKey = Object.keys(data).sort().join(",");
  useEffect(() => {
    setResult(null);
    setRunning(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, horizon]);

  const run = useCallback(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const jobs = Object.entries(data)
      .filter(([, v]) => v.prices.length >= 80)
      .map(([ticker, v]) => ({ ticker, name: v.name, prices: v.prices }));
    if (jobs.length === 0) return;
    const reqId = ++reqIdRef.current;
    setRunning(true);
    setProgress({ done: 0, total: jobs.length });
    const req: BacktestWorkerRequest = { reqId, jobs, horizon };
    worker.postMessage(req);
  }, [data, horizon]);

  return { result, running, progress, run };
}
