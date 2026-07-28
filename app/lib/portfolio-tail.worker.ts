// ポートフォリオのテール系分析（重いモンテカルロ／ブートストラップ）を担う Web Worker。
// ────────────────────────────────────────────────────────────────────────────
// 対象は次の3つ。いずれも「反復 × 全ペア × 全日」で、銘柄数が増えると
// メインスレッドを1〜2秒止めてしまう。
//
//   stressCI        : Δρ = ρ_危機 − ρ_平時 のブロック・ブートストラップ CI
//   stressCIProfile : 上記を複数の窓で連続実行（窓依存プロファイル図）
//   exceedanceAll   : exceedance correlation を3種のヌルすべてで実行
//
// プロジェクト2つ目の Worker。1つ目（sarima.worker.ts）と同じく Turbopack の
// `new Worker(new URL(..., import.meta.url))` で読み込む。
//
// 【設計】リクエストに `key`（呼び出し側が作る一意な文字列）を持たせ、応答にそのまま返す。
// 呼び出し側は「今欲しい key」と一致する応答だけを採用すればよく、古い応答の破棄と
// 「計算中かどうか」の判定が同じ1つの値でできる（reqId とローディングフラグを
// 別々に持つ必要がない）。

import { AlignedReturns } from "./portfolio-risk";
import { stressCorrelationCI, type StressCorrCI } from "./dcc";
import {
  exceedanceCorrelation,
  type ExceedanceResult,
  type NullMode,
} from "./exceedance-correlation";

/** Worker に渡す最小の整列済みリターン（dates/vols は使わないので送らない）。 */
export interface TailReturns {
  tickers: string[];
  returns: number[][];
}

export interface StressCIOpts {
  quantile?: number;
  lookback?: number;
  b?: number;
  blockLen?: number;
  level?: number;
  seed?: number;
}

export type TailWorkerRequest =
  | { key: string; kind: "stressCI"; data: TailReturns; opts: StressCIOpts }
  | {
      key: string;
      kind: "stressCIProfile";
      data: TailReturns;
      /** 末尾から何本使うか（大きい順・データ長を超えるものは丸める）。 */
      windows: number[];
      opts: StressCIOpts;
    }
  | {
      key: string;
      kind: "exceedanceAll";
      data: TailReturns;
      nullModes: NullMode[];
      opts: { thetas?: number[]; sims?: number; seed?: number; minObs?: number; refTheta?: number };
    };

export interface StressProfilePoint {
  /** 実際に使ったリターン本数。 */
  periods: number;
  /** 要求した窓（表示ラベル用。periods と一致しないことがある）。 */
  requested: number;
  ci: StressCorrCI;
}

export type TailWorkerResponse =
  | { key: string; kind: "stressCI"; result: StressCorrCI }
  | { key: string; kind: "stressCIProfile"; result: StressProfilePoint[] }
  | { key: string; kind: "exceedanceAll"; result: Record<string, ExceedanceResult> }
  | { key: string; kind: "error"; message: string };

/** 末尾 n 本に切り詰めた AlignedReturns を作る（alignReturns と同じ「直近を使う」流儀）。 */
function tail(data: TailReturns, n?: number): AlignedReturns {
  const T = data.returns[0]?.length ?? 0;
  const take = n == null ? T : Math.min(n, T);
  const returns = take === T ? data.returns : data.returns.map((r) => r.slice(T - take));
  return { tickers: data.tickers, dates: [], returns, vols: [] };
}

self.onmessage = (ev: MessageEvent<TailWorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.kind === "stressCI") {
      const result = stressCorrelationCI(tail(req.data), req.opts);
      (self as unknown as Worker).postMessage({ key: req.key, kind: "stressCI", result });
      return;
    }
    if (req.kind === "stressCIProfile") {
      const T = req.data.returns[0]?.length ?? 0;
      const result: StressProfilePoint[] = req.windows
        .filter((w) => w > 0)
        .map((w) => {
          const periods = Math.min(w, T);
          return { periods, requested: w, ci: stressCorrelationCI(tail(req.data, periods), req.opts) };
        });
      (self as unknown as Worker).postMessage({ key: req.key, kind: "stressCIProfile", result });
      return;
    }
    if (req.kind === "exceedanceAll") {
      const aligned = tail(req.data);
      const result: Record<string, ExceedanceResult> = {};
      for (const m of req.nullModes) {
        result[m] = exceedanceCorrelation(aligned, { ...req.opts, nullMode: m });
      }
      (self as unknown as Worker).postMessage({ key: req.key, kind: "exceedanceAll", result });
      return;
    }
  } catch (e) {
    (self as unknown as Worker).postMessage({
      key: (req as { key: string }).key,
      kind: "error",
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
