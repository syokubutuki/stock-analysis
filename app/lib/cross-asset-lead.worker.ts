// クロスアセット先行指標スキャンの族補正（円環シフトの帰無 max|t|）を担う Web Worker。
// 26候補×2特徴×3ホライズン×300回の回帰になるため、メインスレッドから外す。

import { scanLeads, type JpTargets, type LeadScanResult } from "./cross-asset-lead";

export interface CrossAssetLeadWorkerRequest {
  reqId: number;
  targets: JpTargets;
  features: { ticker: string; d1: Float64Array; d5: Float64Array }[];
  nNull: number;
}

export interface CrossAssetLeadWorkerResponse {
  reqId: number;
  ok: boolean;
  result: LeadScanResult | null;
  error?: string;
}

self.onmessage = (ev: MessageEvent<CrossAssetLeadWorkerRequest>) => {
  const { reqId, targets, features, nNull } = ev.data;
  try {
    const result = scanLeads({ targets, features, nNull });
    (self as unknown as Worker).postMessage({ reqId, ok: true, result } satisfies CrossAssetLeadWorkerResponse);
  } catch (e) {
    (self as unknown as Worker).postMessage({ reqId, ok: false, result: null, error: String(e) } satisfies CrossAssetLeadWorkerResponse);
  }
};
