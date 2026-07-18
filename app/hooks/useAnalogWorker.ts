"use client";

// 今週の軌跡アナログの重い計算(横断バッチ / OOS / カタログ)を Web Worker に投げるフック。
// reqId で最新リクエストだけ採用し、古い応答は破棄する(設定を素早く変えてもチラつかない)。

import { useEffect, useRef, useCallback } from "react";
import type { AnalogWorkerRequest, AnalogWorkerResponse } from "../lib/weekly-analog.worker";

// ユニオン各枝に Omit を分配する(通常の Omit<union,K> は共通キーだけに潰れてしまう)
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type AnalogRunRequest = DistributiveOmit<AnalogWorkerRequest, "reqId">;

export function useAnalogWorker() {
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const pending = useRef<Map<number, (r: AnalogWorkerResponse) => void>>(new Map());

  useEffect(() => {
    const w = new Worker(new URL("../lib/weekly-analog.worker.ts", import.meta.url));
    w.onmessage = (ev: MessageEvent<AnalogWorkerResponse>) => {
      const cb = pending.current.get(ev.data.reqId);
      if (cb) { pending.current.delete(ev.data.reqId); cb(ev.data); }
    };
    workerRef.current = w;
    return () => { w.terminate(); workerRef.current = null; pending.current.clear(); };
  }, []);

  // 最新リクエストの応答だけ resolve。過去分は自動的に握り潰す。
  const run = useCallback((req: AnalogRunRequest): Promise<AnalogWorkerResponse> => {
    return new Promise((resolve) => {
      const w = workerRef.current;
      if (!w) return;
      const reqId = ++reqIdRef.current;
      pending.current.set(reqId, resolve);
      w.postMessage({ ...req, reqId } as AnalogWorkerRequest);
    });
  }, []);

  // 現時点で最新の reqId（応答が最新かの判定に使う）
  const latest = useCallback(() => reqIdRef.current, []);

  return { run, latest };
}
