// 曜日構造の解剖の Web Worker
// 層別軸 4〜5 本 × 反復 1000 回 × (F + 順位F + 刈り込みF + Brown-Forsythe + t ベクトル)
// で数億回のスロット集計になるため、UI スレッドから退避する。

import {
  AnatomyParams,
  AnatomyResult,
  emptyAnatomy,
  runAnatomy,
} from "./null-anatomy";
import { PricePoint } from "./types";

export interface AnatomyWorkerRequest {
  reqId: number;
  prices: PricePoint[];
  usPrices: PricePoint[] | null;
  params: AnatomyParams;
}

export interface AnatomyWorkerResponse {
  reqId: number;
  progress?: { done: number; total: number };
  result?: AnatomyResult;
}

self.onmessage = (ev: MessageEvent<AnatomyWorkerRequest>) => {
  const { reqId, prices, usPrices, params } = ev.data;
  const post = (msg: AnatomyWorkerResponse) => (self as unknown as Worker).postMessage(msg);

  try {
    const result = runAnatomy(prices, usPrices, params, (done, total) => {
      if (done % 50 === 0 || done === total) post({ reqId, progress: { done, total } });
    });
    post({ reqId, result });
  } catch (err) {
    console.error("null-anatomy worker error", err);
    post({ reqId, result: emptyAnatomy(params, String(err)) });
  }
};
