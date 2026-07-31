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
  const [storedResult, setStoredResult] = useState<BacktestResult | null>(null);
  const [runningState, setRunningState] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const [resultKey, setResultKey] = useState("");

  useEffect(() => {
    const worker = new Worker(
      new URL("../lib/badge-backtest.worker.ts", import.meta.url)
    );
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<BacktestWorkerResponse>) => {
      if (ev.data.reqId !== reqIdRef.current) return;
      if (ev.data.progress) setProgress(ev.data.progress);
      if (ev.data.result) {
        setStoredResult(ev.data.result);
        setRunningState(false);
      }
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const dataKey = Object.keys(data).sort().join(",");
  const inputKey = `${dataKey}|${horizon}`;
  const current = resultKey === inputKey;
  const result = current ? storedResult : null;
  const running = current && runningState;

  const run = useCallback(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const jobs = Object.entries(data)
      .filter(([, v]) => v.prices.length >= 80)
      .map(([ticker, v]) => ({ ticker, name: v.name, prices: v.prices }));
    if (jobs.length === 0) return;
    const reqId = ++reqIdRef.current;
    setResultKey(inputKey);
    setStoredResult(null);
    setRunningState(true);
    setProgress({ done: 0, total: jobs.length });
    const req: BacktestWorkerRequest = { reqId, jobs, horizon };
    worker.postMessage(req);
  }, [data, horizon, inputKey]);

  return { result, running, progress, run };
}
