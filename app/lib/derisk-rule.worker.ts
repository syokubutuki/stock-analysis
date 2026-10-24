// ストレス退避規則の頑健性（ランダム配置ヌル 1000回・定常ブロックブート 2000回）を担う Web Worker。
// 計算は derisk-robust.ts（純粋関数）。設計は docs/derisk-rule-design.md §2.7。
// 「偶然との比較を計算」ボタンで起動する（オンデマンド）。

import { computeRobustness, type RobustInput, type RobustResult } from "./derisk-robust";

export interface DeriskWorkerRequest extends RobustInput {
  reqId: number;
  y: number[];
  w: number[];
}

export interface DeriskWorkerResponse {
  reqId: number;
  ok: boolean;
  result: RobustResult | null;
  error?: string;
}

self.onmessage = (ev: MessageEvent<DeriskWorkerRequest>) => {
  const { reqId, ...input } = ev.data;
  try {
    const result = computeRobustness(input);
    (self as unknown as Worker).postMessage({ reqId, ok: true, result } satisfies DeriskWorkerResponse);
  } catch (e) {
    (self as unknown as Worker).postMessage({ reqId, ok: false, result: null, error: String(e) } satisfies DeriskWorkerResponse);
  }
};
