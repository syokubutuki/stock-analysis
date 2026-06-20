// TP×SL グリッド評価（エントリー数×グリッド×保有日数で計算が重い）を担う Web Worker。
// メインスレッドの UI ブロックを防ぐ。

import { optimizeTpSl, type TpSlResult, type TpSlOptions } from "./tp-sl-optimizer";
import { PricePoint } from "./types";

export interface TpSlWorkerRequest {
  reqId: number;
  prices: PricePoint[];
  opts: TpSlOptions;
}

export interface TpSlWorkerResponse {
  reqId: number;
  result: TpSlResult;
}

self.onmessage = (ev: MessageEvent<TpSlWorkerRequest>) => {
  const { reqId, prices, opts } = ev.data;
  const result = optimizeTpSl(prices, opts);
  const res: TpSlWorkerResponse = { reqId, result };
  (self as unknown as Worker).postMessage(res);
};
