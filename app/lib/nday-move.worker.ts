// 値動き条件別の売買検証 ③（候補格子・ウォークフォワード・CSCV）の Web Worker。
// 96候補 × 10年の口座シミュレーションと、ウォークフォワードの再選択、C(16,8)=12,870通りの
// CSCV で数秒かかるため UI スレッドから退避する。
//
// キャンセルは呼び出し側が worker.terminate() して作り直す。進捗・結果には reqId を付け、
// 呼び出し側は最新の reqId 以外の応答を捨てる（条件を変えた後に古い結果が表示されないため）。

import type { PricePoint } from "./types";
import type { AnalysisRange, PriceAudit } from "./nday-move";
import { runRobustness, type RobustnessConfig, type RobustnessResult } from "./nday-move-robustness";

export interface NdayMoveWorkerRequest {
  reqId: number;
  prices: PricePoint[];
  audit: PriceAudit;
  range: AnalysisRange;
  config: RobustnessConfig;
}

export type NdayMoveWorkerResponse =
  | { reqId: number; type: "progress"; stage: "candidates" | "walk-forward" | "cscv"; done: number; total: number }
  | { reqId: number; type: "result"; result: RobustnessResult; elapsedMs: number }
  | { reqId: number; type: "error"; message: string };

self.onmessage = (ev: MessageEvent<NdayMoveWorkerRequest>) => {
  const { reqId, prices, audit, range, config } = ev.data;
  const post = (msg: NdayMoveWorkerResponse) => (self as unknown as Worker).postMessage(msg);
  const started = performance.now();
  let lastPost = 0;
  try {
    const result = runRobustness(prices, audit, range, config, (stage, done, total) => {
      // postMessage 自体のコストを抑えるため、およそ 100ms ごとと各段の最後だけ返す
      const now = performance.now();
      if (done === total || now - lastPost > 100) {
        lastPost = now;
        post({ reqId, type: "progress", stage, done, total });
      }
    });
    post({ reqId, type: "result", result, elapsedMs: performance.now() - started });
  } catch (err) {
    console.error("nday-move worker error", err);
    post({ reqId, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
