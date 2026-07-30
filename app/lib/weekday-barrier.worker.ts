// 曜日別バリア（系C28）の Web Worker。
// 層3が「格子 8×8 × サロゲート数百本」＋「一致ブラウン運動の経路生成」を回すため、
// UIスレッドから退避する。経路の構築もここで行い、メインからは生データだけ渡す。

import {
  BarrierParams, BarrierResult, buildIntradayPaths, buildMultidayPaths,
  emptyBarrierResult, runWeekdayBarrier,
} from "./weekday-barrier";
import { IntradayBar } from "./intraday-core";
import { PricePoint } from "./types";

export interface BarrierWorkerRequest {
  reqId: number;
  params: BarrierParams;
  bars?: IntradayBar[]; // 日中モード
  gmtoffset?: number;
  prices?: PricePoint[]; // 数日モード
}

export interface BarrierWorkerResponse {
  reqId: number;
  progress?: { done: number; total: number };
  result?: BarrierResult;
}

self.onmessage = (ev: MessageEvent<BarrierWorkerRequest>) => {
  const { reqId, params, bars, gmtoffset, prices } = ev.data;
  const post = (msg: BarrierWorkerResponse) => (self as unknown as Worker).postMessage(msg);
  try {
    const paths = params.mode === "intraday"
      ? buildIntradayPaths(bars ?? [], gmtoffset ?? 0)
      : buildMultidayPaths(prices ?? [], params.hDays);
    const result = runWeekdayBarrier(paths, params, (done, total) =>
      post({ reqId, progress: { done, total } })
    );
    post({ reqId, result });
  } catch (err) {
    console.error("weekday-barrier worker error", err);
    post({ reqId, result: emptyBarrierResult(params.mode, String(err)) });
  }
};
