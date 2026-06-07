// 系列計算をメインスレッドから分離するWeb Worker。
// chart-series.ts の SERIES カタログを読み込み、要求された系列だけを計算して返す。
// 1リクエスト内では prices 参照が共通なので chart-series 側の memoBy が効き、
// 兄弟系列（BB上限/中央/下限など）の重複計算もまとめて排除される。
import {
  SERIES,
  type SeriesWorkerRequest,
  type SeriesWorkerResponse,
  type ComputedSeries,
} from "./chart-series";

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<SeriesWorkerRequest>) => {
  const { reqId, prices, ids } = e.data;
  const results: ComputedSeries[] = [];

  for (const id of ids) {
    const def = SERIES.find((s) => s.id === id);
    if (!def) continue;
    try {
      if (def.type === "candlestick" && def.computeOHLC) {
        results.push({ id, kind: "candlestick", ohlc: def.computeOHLC(prices) });
      } else {
        results.push({ id, kind: def.type, line: def.compute(prices) });
      }
    } catch {
      // 計算失敗時は空データを返してメイン側で安全にスキップさせる
      results.push({ id, kind: def.type, line: [] });
    }
  }

  const res: SeriesWorkerResponse = { reqId, results };
  ctx.postMessage(res);
};
