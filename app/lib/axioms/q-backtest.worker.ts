// 合流点 q のウォークフォワード検証を担う Web Worker。
// 各リバランスで synthesizeQ を解き直すため全期間で約10秒かかる。メインスレッドで
// 走らせるとUIが固まるので、ここへ隔離する(sarima.worker.ts と同じ方式)。

import { backtestQ, type QBacktestResult } from "./q-backtest";
import { PricePoint } from "../types";

export interface QBacktestWorkerRequest {
  reqId: number;
  prices: PricePoint[];
  stepDays: number;
  minHistory: number;
}

export interface QBacktestWorkerResponse {
  reqId: number;
  ok: boolean;
  /** 進捗のみの中間通知(result は null)。 */
  progress?: number;
  result: QBacktestResult | null;
  error?: string;
}

self.onmessage = (ev: MessageEvent<QBacktestWorkerRequest>) => {
  const { reqId, prices, stepDays, minHistory } = ev.data;
  const post = (r: QBacktestWorkerResponse) => (self as unknown as Worker).postMessage(r);

  try {
    const result = backtestQ(prices, {
      stepDays,
      minHistory,
      onProgress: (p) => post({ reqId, ok: true, progress: p, result: null }),
    });
    post({ reqId, ok: true, result });
  } catch (err) {
    post({
      reqId,
      ok: false,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    });
    console.error("q-backtest worker error", err);
  }
};
