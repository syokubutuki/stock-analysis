// 曜日×前夜米国 交互作用の Web Worker
// 4標本（全体／連休除外／前半／後半）× 反復1000 ×（曜日別HC3回帰2種 + セル集計）で
// 数千万回の走査になるため UI スレッドから退避する。

import { WuParams, WuResult, emptyWu, runWeekdayUs } from "./weekday-us-interaction";
import { PricePoint } from "./types";

export interface WuWorkerRequest {
  reqId: number;
  prices: PricePoint[];
  usPrices: PricePoint[] | null;
  params: WuParams;
}

export interface WuWorkerResponse {
  reqId: number;
  progress?: { done: number; total: number };
  result?: WuResult;
}

self.onmessage = (ev: MessageEvent<WuWorkerRequest>) => {
  const { reqId, prices, usPrices, params } = ev.data;
  const post = (msg: WuWorkerResponse) => (self as unknown as Worker).postMessage(msg);
  try {
    const result = runWeekdayUs(prices, usPrices, params, (done, total) =>
      post({ reqId, progress: { done, total } }),
    );
    post({ reqId, result });
  } catch (err) {
    console.error("weekday-us-interaction worker error", err);
    post({ reqId, result: emptyWu(params, String(err)) });
  }
};
