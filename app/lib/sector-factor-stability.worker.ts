// L2-C 構造変化（supWald ＋ ブロック・ブート臨界値）の Web Worker。
//
// 計算量の内訳: 16銘柄 × 約80分割点 × 2回帰 の探索を、ブート300回ぶん繰り返す。
// 分割点探索は累積和で O(1) 化してあるが（sector-factor-stability.ts の segB）、
// それでも replicate ごとに全長の累積和を組み直すため UI スレッドを数秒止める。
// L2-A/B/D は先に描き、この層だけ後から差し替える。
//
// **Worker には価格を渡さず、構築済みのパネル（数値配列）を渡す。**
// buildPanel を Worker 側で走らせると履歴フィルタが二重になり、
// メインスレッドと違う銘柄集合で計算する事故が起きうる。

import { computeBreaks, type BreakResult, type StabilityPanelExport, type StabilityParams } from "./sector-factor-stability";

export interface StabilityWorkerRequest {
  reqId: number;
  kind: "breaks";
  panel: StabilityPanelExport;
  params: Pick<StabilityParams, "trim" | "rollStep" | "nBoot" | "blockLen" | "seed">;
}

export interface StabilityWorkerResponse {
  reqId: number;
  kind: "breaks";
  progress?: { done: number; total: number };
  result?: BreakResult;
  error?: string;
}

self.onmessage = (ev: MessageEvent<StabilityWorkerRequest>) => {
  const { reqId, panel, params } = ev.data;
  const post = (msg: StabilityWorkerResponse) => (self as unknown as Worker).postMessage(msg);
  try {
    const result = computeBreaks(panel, params, (done, total) =>
      post({ reqId, kind: "breaks", progress: { done, total } })
    );
    post({ reqId, kind: "breaks", result });
  } catch (err) {
    console.error("sector-factor-stability worker error", err);
    post({ reqId, kind: "breaks", error: String(err) });
  }
};
