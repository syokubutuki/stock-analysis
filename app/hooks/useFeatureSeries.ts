"use client";

import { useEffect, useRef, useState } from "react";
import { Horizon } from "../lib/signal-digest";
import { FeaturePoint } from "../lib/feature-series";
import type {
  FeatureWorkerRequest,
  FeatureWorkerResponse,
} from "../lib/feature-series.worker";
import { PricePoint } from "../lib/types";

// 選択銘柄の特徴量系列を Worker で計算。prices/horizon が変わると自動再計算。
export function useFeatureSeries(prices: PricePoint[] | null, horizon: Horizon) {
  const [features, setFeatures] = useState<FeaturePoint[]>([]);
  const [computing, setComputing] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const worker = new Worker(
      new URL("../lib/feature-series.worker.ts", import.meta.url)
    );
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<FeatureWorkerResponse>) => {
      if (ev.data.reqId !== reqIdRef.current) return;
      setFeatures(ev.data.features);
      setComputing(false);
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const len = prices?.length ?? 0;
  const lastTime = len > 0 ? prices![len - 1].time : "";
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || !prices || prices.length < 80) {
      setFeatures([]);
      return;
    }
    const reqId = ++reqIdRef.current;
    setComputing(true);
    const req: FeatureWorkerRequest = { reqId, prices, horizon };
    worker.postMessage(req);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [len, lastTime, horizon]);

  return { features, computing };
}
