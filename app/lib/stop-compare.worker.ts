// 損切り警告 vs 機械ストップ 比較の Web Worker
// 日次のポイントインタイム digest 再計算が重いため退避する。

import {
  backtestStockStops,
  aggregateStops,
  StockTrades,
  StopCompareResult,
  StopParams,
  DEFAULT_STOP_PARAMS,
} from "./stop-compare";
import { Horizon } from "./signal-digest";
import { PricePoint } from "./types";

export interface StopCompareJob {
  ticker: string;
  name: string;
  prices: PricePoint[];
}

export interface StopCompareWorkerRequest {
  reqId: number;
  jobs: StopCompareJob[];
  horizon: Horizon;
  params?: Partial<StopParams>;
}

export interface StopCompareWorkerResponse {
  reqId: number;
  progress?: { done: number; total: number };
  result?: StopCompareResult;
}

self.onmessage = (ev: MessageEvent<StopCompareWorkerRequest>) => {
  const { reqId, jobs, horizon, params } = ev.data;
  const p: StopParams = { ...DEFAULT_STOP_PARAMS, ...(params ?? {}) };
  const post = (msg: StopCompareWorkerResponse) =>
    (self as unknown as Worker).postMessage(msg);

  const pooled: StockTrades[] = [];
  let nStocks = 0;
  let from = "";
  let to = "";

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    try {
      const trades = backtestStockStops(job.prices, job.ticker, job.name, horizon, p);
      if (trades.byRule.model.length > 0) {
        pooled.push(trades);
        nStocks++;
        const first = job.prices[Math.max(0, job.prices.length - p.lookback)]?.time;
        const last = job.prices[job.prices.length - 1]?.time;
        if (first && (!from || first < from)) from = first;
        if (last && (!to || last > to)) to = last;
      }
    } catch (err) {
      console.error("stop-compare worker error", job.ticker, err);
    }
    post({ reqId, progress: { done: i + 1, total: jobs.length } });
  }

  post({ reqId, result: aggregateStops(pooled, nStocks, p, from, to) });
};
