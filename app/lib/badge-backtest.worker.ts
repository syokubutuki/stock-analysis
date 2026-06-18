// 判定実績化のバックテスト Web Worker
// ポイントインタイム digest 再計算(GARCH/BOCPD/カルマン)が重いため退避する。

import {
  backtestStock,
  aggregate,
  ForwardObs,
  BacktestResult,
  EVAL_HORIZONS,
} from "./badge-backtest";
import { Horizon } from "./signal-digest";
import { PricePoint } from "./types";

export interface BacktestJob {
  ticker: string;
  name: string;
  prices: PricePoint[];
}

export interface BacktestWorkerRequest {
  reqId: number;
  jobs: BacktestJob[];
  horizon: Horizon;
  step?: number;
  lookback?: number;
}

export interface BacktestWorkerResponse {
  reqId: number;
  progress?: { done: number; total: number };
  result?: BacktestResult;
}

self.onmessage = (ev: MessageEvent<BacktestWorkerRequest>) => {
  const { reqId, jobs, horizon, step, lookback } = ev.data;
  const post = (msg: BacktestWorkerResponse) =>
    (self as unknown as Worker).postMessage(msg);

  const pooled: ForwardObs[] = [];
  let nStocks = 0;
  let from = "";
  let to = "";

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    try {
      const obs = backtestStock(job.prices, job.ticker, job.name, horizon, { step, lookback });
      if (obs.length > 0) {
        pooled.push(...obs);
        nStocks++;
        const first = job.prices[Math.max(0, job.prices.length - (lookback ?? 756))]?.time;
        const last = job.prices[job.prices.length - 1]?.time;
        if (first && (!from || first < from)) from = first;
        if (last && (!to || last > to)) to = last;
      }
    } catch (err) {
      console.error("backtest worker error", job.ticker, err);
    }
    post({ reqId, progress: { done: i + 1, total: jobs.length } });
  }

  const { baseRate, byEvent } = aggregate(pooled, EVAL_HORIZONS);
  const result: BacktestResult = {
    ok: pooled.length > 0,
    evalHorizons: EVAL_HORIZONS,
    baseRate,
    byEvent,
    nStocks,
    totalEvals: pooled.length,
    from,
    to,
  };
  post({ reqId, result });
};
