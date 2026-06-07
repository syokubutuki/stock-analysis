// SARIMA グリッド探索・推定・予測・診断を担う Web Worker
// （メインスレッドの UI ブロックを防ぐ）

import {
  fitSarima,
  forecastSarima,
  diagnose,
  gridSearchSarima,
  differencedSeriesAcf,
  type SarimaSpec,
  type GridRanges,
} from "./sarima";
import { adfTest, kpssTest } from "./unit-root";

export interface SarimaWorkerRequest {
  reqId: number;
  values: number[];
  s: number;
  horizon: number;
  ranges: GridRanges;
  manualSpec?: SarimaSpec | null; // 指定時はグリッド探索より優先
  topN: number;
}

export interface SarimaWorkerResponse {
  reqId: number;
  ok: boolean;
  candidates: ReturnType<typeof gridSearchSarima>;
  fit: ReturnType<typeof fitSarima> | null;
  forecast: ReturnType<typeof forecastSarima> | null;
  diagnostics: ReturnType<typeof diagnose> | null;
  diffAcf: ReturnType<typeof differencedSeriesAcf> | null;
  adfLevel: ReturnType<typeof adfTest> | null;
  adfDiff: ReturnType<typeof adfTest> | null;
  kpssLevel: ReturnType<typeof kpssTest> | null;
}

self.onmessage = (ev: MessageEvent<SarimaWorkerRequest>) => {
  const { reqId, values, s, horizon, ranges, manualSpec, topN } = ev.data;

  try {
    const candidates = gridSearchSarima(values, ranges, s, topN);

    const spec: SarimaSpec | null =
      manualSpec ?? (candidates.length > 0 ? candidates[0].spec : null);

    let fit = null;
    let forecast = null;
    let diagnostics = null;
    let diffAcf = null;

    if (spec) {
      fit = fitSarima(values, spec);
      if (fit.ok) {
        forecast = forecastSarima(values, fit, horizon);
        diagnostics = diagnose(fit);
      }
      diffAcf = differencedSeriesAcf(values, spec, 30);
    }

    // 定常性検定（1 階差分系列も）
    const adfLevel = adfTest(values);
    const diff1: number[] = [];
    for (let i = 1; i < values.length; i++) diff1.push(values[i] - values[i - 1]);
    const adfDiff = adfTest(diff1);
    const kpssLevel = kpssTest(values, "level");

    const res: SarimaWorkerResponse = {
      reqId,
      ok: !!fit && fit.ok,
      candidates,
      fit,
      forecast,
      diagnostics,
      diffAcf,
      adfLevel,
      adfDiff,
      kpssLevel,
    };
    (self as unknown as Worker).postMessage(res);
  } catch (err) {
    const res: SarimaWorkerResponse = {
      reqId,
      ok: false,
      candidates: [],
      fit: null,
      forecast: null,
      diagnostics: null,
      diffAcf: null,
      adfLevel: null,
      adfDiff: null,
      kpssLevel: null,
    };
    (self as unknown as Worker).postMessage(res);
    console.error("SARIMA worker error", err);
  }
};
