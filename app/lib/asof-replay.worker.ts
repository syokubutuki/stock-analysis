// as-of リプレイの Web Worker
// 各 as-of 点で蒸留層(BOCPD は O(n²)・GJR-GARCH の最尤推定を含む)を丸ごと再計算するため、
// 150点なら数千万〜億オーダーの演算になる。UI スレッドから退避する。

import { runAsOfReplay, AsOfReplayParams, AsOfReplayResult } from "./asof-replay";
import { PricePoint } from "./types";

export interface AsOfWorkerRequest {
  reqId: number;
  prices: PricePoint[];
  ticker: string;
  params: AsOfReplayParams;
}

export interface AsOfWorkerResponse {
  reqId: number;
  progress?: { done: number; total: number };
  result?: AsOfReplayResult;
}

self.onmessage = (ev: MessageEvent<AsOfWorkerRequest>) => {
  const { reqId, prices, ticker, params } = ev.data;
  const post = (msg: AsOfWorkerResponse) => (self as unknown as Worker).postMessage(msg);
  try {
    const result = runAsOfReplay(prices, ticker, params, (done, total) => {
      post({ reqId, progress: { done, total } });
    });
    post({ reqId, result });
  } catch (err) {
    console.error("asof-replay worker error", err);
    post({
      reqId,
      result: {
        ok: false, reason: String(err), params, points: [], firstDate: "", lastDate: "",
        overlap: [], nEff: [], direction: [], probability: [], intervals: [], vol: [], ics: [], events: [],
      },
    });
  }
};
