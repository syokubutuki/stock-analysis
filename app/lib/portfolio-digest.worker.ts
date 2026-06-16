// ポートフォリオ蒸留 Web Worker
// 各銘柄の computeDigest(GARCH/カルマン/BOCPD 等を含む重い計算)をメインスレッド
// から退避する。銘柄ごとに逐次 postMessage し、表が順次埋まるようにする。

import { computeDigest, Horizon, SignalDigest } from "./signal-digest";
import { PricePoint } from "./types";

export interface DigestJob {
  ticker: string;
  name: string;
  prices: PricePoint[];
}

export interface DigestWorkerRequest {
  reqId: number;
  jobs: DigestJob[];
  horizon: Horizon;
}

export interface DigestWorkerResponse {
  reqId: number;
  ticker?: string; // 1銘柄ぶんの結果(逐次)
  digest?: SignalDigest;
  done?: boolean; // 全件完了
}

self.onmessage = (ev: MessageEvent<DigestWorkerRequest>) => {
  const { reqId, jobs, horizon } = ev.data;
  const post = (msg: DigestWorkerResponse) =>
    (self as unknown as Worker).postMessage(msg);

  for (const job of jobs) {
    try {
      const digest = computeDigest(job.prices, job.ticker, job.name, horizon);
      post({ reqId, ticker: job.ticker, digest });
    } catch (err) {
      console.error("digest worker error", job.ticker, err);
    }
  }
  post({ reqId, done: true });
};
