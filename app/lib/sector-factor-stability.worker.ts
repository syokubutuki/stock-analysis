// P2（系C29 持続性層）の計算をまるごと引き受ける Web Worker。
//
// **設計書 §7.7 からの変更**: 当初は「重いのは L2-C だけなので supWald だけ Worker へ」
// という切り分けだった。実測すると L2-A/B の側も UI をブロックする:
//   刻み5日 × 全体窓2400 × ローリング窓500 で 380窓 × 16銘柄 の Newey-West 回帰、
//   さらに 500回の横断シャッフルと 4×300 のペア・ブートが乗る。
// メインスレッドの `setTimeout(…, 0)` は**実行を遅らせるだけで逃がさない**ので、
// 操作のたびに数秒フリーズし、「計算中」の表示すら描画されない（同じタスク内なので）。
// よって全部こちらへ寄せ、結果は2段階（main → breaks）で返して描画は先に進める。
//
// 価格をそのまま渡す。設計書は「Worker で buildPanel を二重に走らせないこと」を理由に
// パネルを渡す形にしていたが、**計算が全部こちら側に来た以上 buildPanel は1回しか走らない**ので
// その懸念は消える。むしろメインスレッド側にパネル構築が残らないぶん素直になる。

import {
  computeSectorStability,
  computeBreaks,
  type BreakResult,
  type StabilityParams,
  type StabilityResult,
} from "./sector-factor-stability";
import type { FactorPrices } from "./sector-factor-select";
import type { PricePoint } from "./types";

export interface StabilityWorkerRequest {
  reqId: number;
  pricesByTicker: Record<string, PricePoint[]>;
  factors: FactorPrices;
  params: Partial<StabilityParams>;
  names: Record<string, string>;
}

export interface StabilityWorkerResponse {
  reqId: number;
  /** main = L2-A/B/D ＋ 建玉翻訳（先に描く） / breaks = L2-C（後から差し替える） */
  kind: "main" | "breaks" | "progress" | "error";
  result?: StabilityResult | null;
  breaks?: BreakResult;
  progress?: { done: number; total: number };
  error?: string;
}

self.onmessage = (ev: MessageEvent<StabilityWorkerRequest>) => {
  const { reqId, pricesByTicker, factors, params, names } = ev.data;
  const post = (msg: StabilityWorkerResponse) => (self as unknown as Worker).postMessage(msg);
  let res: StabilityResult | null = null;
  try {
    res = computeSectorStability(pricesByTicker, factors, params, names);
    post({ reqId, kind: "main", result: res });
  } catch (err) {
    console.error("sector-factor-stability worker (main) error", err);
    post({ reqId, kind: "error", error: String(err) });
    return;
  }
  if (!res) return;
  try {
    const breaks = computeBreaks(
      res.panel,
      {
        trim: res.params.trim,
        rollStep: res.params.rollStep,
        nBoot: res.params.nBoot,
        blockLen: res.params.blockLen,
        seed: res.params.seed,
      },
      (done, total) => post({ reqId, kind: "progress", progress: { done, total } })
    );
    post({ reqId, kind: "breaks", breaks });
  } catch (err) {
    console.error("sector-factor-stability worker (breaks) error", err);
    post({ reqId, kind: "error", error: String(err) });
  }
};
