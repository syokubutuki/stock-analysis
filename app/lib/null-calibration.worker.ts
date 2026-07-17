// ヌル較正の Web Worker
// 反復 1000 回 × ウォークフォワード(週ごとに bestCombination を再最適化)は
// 数千万回のスロット集計になるため、UI スレッドから退避する。

import {
  runNullCalibration,
  emptyResult,
  NullCalibParams,
  NullCalibResult,
} from "./null-calibration";
import { PricePoint } from "./types";

export interface NullCalibWorkerRequest {
  reqId: number;
  prices: PricePoint[];
  params: NullCalibParams;
}

export interface NullCalibWorkerResponse {
  reqId: number;
  progress?: { done: number; total: number };
  result?: NullCalibResult;
}

self.onmessage = (ev: MessageEvent<NullCalibWorkerRequest>) => {
  const { reqId, prices, params } = ev.data;
  const post = (msg: NullCalibWorkerResponse) => (self as unknown as Worker).postMessage(msg);

  try {
    const result = runNullCalibration(prices, params, (done, total) => {
      // 25 反復ごとに進捗を返す(postMessage 自体のコストを抑える)
      if (done % 25 === 0 || done === total) post({ reqId, progress: { done, total } });
    });
    post({ reqId, result });
  } catch (err) {
    console.error("null-calibration worker error", err);
    post({ reqId, result: emptyResult(params, String(err)) });
  }
};
