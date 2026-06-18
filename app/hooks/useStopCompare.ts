"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Horizon } from "../lib/signal-digest";
import type { StopCompareResult } from "../lib/stop-compare";
import type {
  StopCompareWorkerRequest,
  StopCompareWorkerResponse,
} from "../lib/stop-compare.worker";
import { PortfolioData } from "./usePortfolioData";

// 損切り警告 vs 機械ストップの出口比較。重いので run() の明示実行のみ。
export function useStopCompare(data: PortfolioData, horizon: Horizon) {
  const [result, setResult] = useState<StopCompareResult | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const worker = new Worker(
      new URL("../lib/stop-compare.worker.ts", import.meta.url)
    );
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<StopCompareWorkerResponse>) => {
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
      .filter(([, v]) => v.prices.length >= 100)
      .map(([ticker, v]) => ({ ticker, name: v.name, prices: v.prices }));
    if (jobs.length === 0) return;
    const reqId = ++reqIdRef.current;
    setRunning(true);
    setProgress({ done: 0, total: jobs.length });
    const req: StopCompareWorkerRequest = { reqId, jobs, horizon };
    worker.postMessage(req);
  }, [data, horizon]);

  return { result, running, progress, run };
}
