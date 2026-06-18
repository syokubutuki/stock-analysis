// 戦略ラボの特徴量系列計算 Web Worker(単一銘柄・ポイントインタイム digest が重いため)

import { computeFeatureSeries, FeaturePoint } from "./feature-series";
import { Horizon } from "./signal-digest";
import { PricePoint } from "./types";

export interface FeatureWorkerRequest {
  reqId: number;
  prices: PricePoint[];
  horizon: Horizon;
  lookback?: number;
}

export interface FeatureWorkerResponse {
  reqId: number;
  features: FeaturePoint[];
}

self.onmessage = (ev: MessageEvent<FeatureWorkerRequest>) => {
  const { reqId, prices, horizon, lookback } = ev.data;
  let features: FeaturePoint[] = [];
  try {
    features = computeFeatureSeries(prices, horizon, { lookback });
  } catch (err) {
    console.error("feature-series worker error", err);
  }
  (self as unknown as Worker).postMessage({ reqId, features } as FeatureWorkerResponse);
};
