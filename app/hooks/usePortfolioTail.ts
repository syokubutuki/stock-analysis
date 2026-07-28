"use client";

// テール系の重い計算（Δρ の CI / その窓依存プロファイル / exceedance の3ヌル）を
// Web Worker に逃がすフック。
//
// 【設計】結果を `{ key, value }` の形で持ち、`key` が「今欲しい入力」と一致するかどうかだけで
//  - 古い応答の破棄（key 不一致は無視）
//  - 「計算中か」の判定（保持している key ≠ 今の key なら計算中）
// の両方を賄う。ローディング用の state を別に持たないので、**効果の中で同期 setState を
// 呼ばずに済む**（このリポジトリの lint はそれを禁じている）。
//
// Worker が使えない環境（極端に古いブラウザ等）では同じ関数を同期で回すが、
// その場合も setState は queueMicrotask 経由にして効果本体からは呼ばない。

import { useEffect, useMemo, useRef, useState } from "react";
import type { AlignedReturns } from "../lib/portfolio-risk";
import { stressCorrelationCI, type StressCorrCI } from "../lib/dcc";
import {
  exceedanceCorrelation,
  type ExceedanceResult,
  type NullMode,
} from "../lib/exceedance-correlation";
import type {
  StressCIOpts,
  StressProfilePoint,
  TailReturns,
  TailWorkerRequest,
  TailWorkerResponse,
} from "../lib/portfolio-tail.worker";

export type { StressProfilePoint };

/** 入力（銘柄・本数・オプション）から一意な key を作る。中身が同じなら再計算しない。 */
function keyOf(kind: string, data: TailReturns | null, extra: unknown): string {
  if (!data) return `${kind}|none`;
  const T = data.returns[0]?.length ?? 0;
  return `${kind}|${data.tickers.join(",")}|${T}|${JSON.stringify(extra)}`;
}

function toTail(aligned: AlignedReturns | null): TailReturns | null {
  if (!aligned || aligned.tickers.length < 2) return null;
  return { tickers: aligned.tickers, returns: aligned.returns };
}

interface Slot<T> {
  key: string;
  value: T;
}

/**
 * Worker を1つ共有して使う内部フック。`request` は「今計算したいもの」（null なら何もしない）。
 * 返り値の `value` は key が一致したときだけ入り、それ以外は null（＝計算中）。
 */
function useTailJob<T>(
  request: TailWorkerRequest | null,
  fallback: (req: TailWorkerRequest) => T
): { value: T | null; loading: boolean; error: string | null } {
  const workerRef = useRef<Worker | null>(null);
  const [slot, setSlot] = useState<Slot<T> | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const key = request?.key ?? null;

  useEffect(() => {
    if (!request) return;
    let cancelled = false;

    // Worker が使えないときは同期実行にフォールバック（効果本体では setState しない）
    if (typeof Worker === "undefined") {
      queueMicrotask(() => {
        if (cancelled) return;
        try {
          setSlot({ key: request.key, value: fallback(request) });
        } catch (e) {
          setError({ key: request.key, message: e instanceof Error ? e.message : String(e) });
        }
      });
      return () => {
        cancelled = true;
      };
    }

    if (!workerRef.current) {
      workerRef.current = new Worker(new URL("../lib/portfolio-tail.worker.ts", import.meta.url));
    }
    const w = workerRef.current;
    const onMsg = (ev: MessageEvent<TailWorkerResponse>) => {
      const res = ev.data;
      if (res.key !== request.key) return; // 古い応答は破棄
      if (res.kind === "error") {
        setError({ key: res.key, message: res.message });
        return;
      }
      setSlot({ key: res.key, value: res.result as T });
    };
    w.addEventListener("message", onMsg);
    w.postMessage(request);
    return () => {
      cancelled = true;
      w.removeEventListener("message", onMsg);
    };
    // request はメモ化された同一参照が渡ってくる前提（key が変わったときだけ再送信）
  }, [request, fallback]);

  // アンマウントで Worker を止める（開きっぱなしのパネルでスレッドを残さない）
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const value = slot && key != null && slot.key === key ? slot.value : null;
  return {
    value,
    loading: key != null && value === null && (error == null || error.key !== key),
    error: error != null && error.key === key ? error.message : null,
  };
}

// ───────────────────────── 公開フック ─────────────────────────

/** Δρ の ブロック・ブートストラップ CI。 */
export function useStressCorrCI(aligned: AlignedReturns | null, opts: StressCIOpts) {
  const data = useMemo(() => toTail(aligned), [aligned]);
  const request = useMemo<TailWorkerRequest | null>(
    () => (data ? { key: keyOf("stressCI", data, opts), kind: "stressCI", data, opts } : null),
    [data, opts]
  );
  const fallback = useMemo(
    () => (req: TailWorkerRequest) => {
      const r = req as Extract<TailWorkerRequest, { kind: "stressCI" }>;
      return stressCorrelationCI(
        { tickers: r.data.tickers, dates: [], returns: r.data.returns, vols: [] },
        r.opts
      );
    },
    []
  );
  return useTailJob<StressCorrCI>(request, fallback);
}

/** Δρ の窓依存プロファイル（窓ごとに CI を並べる）。 */
export function useStressCorrCIProfile(
  aligned: AlignedReturns | null,
  windows: number[],
  opts: StressCIOpts
) {
  const data = useMemo(() => toTail(aligned), [aligned]);
  const winKey = windows.join("/");
  const request = useMemo<TailWorkerRequest | null>(
    () =>
      data
        ? {
            key: keyOf("stressCIProfile", data, { winKey, opts }),
            kind: "stressCIProfile",
            data,
            windows,
            opts,
          }
        : null,
    // windows は毎回新しい配列で来るので、内容から作った winKey を依存に使う
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, winKey, opts]
  );
  const fallback = useMemo(
    () => (req: TailWorkerRequest) => {
      const r = req as Extract<TailWorkerRequest, { kind: "stressCIProfile" }>;
      const T = r.data.returns[0]?.length ?? 0;
      return r.windows.map((w) => {
        const periods = Math.min(w, T);
        return {
          periods,
          requested: w,
          ci: stressCorrelationCI(
            {
              tickers: r.data.tickers,
              dates: [],
              returns: r.data.returns.map((x) => x.slice(T - periods)),
              vols: [],
            },
            r.opts
          ),
        };
      });
    },
    []
  );
  return useTailJob<StressProfilePoint[]>(request, fallback);
}

/** exceedance correlation を複数ヌルで一度に。 */
export function useExceedanceAll(
  aligned: AlignedReturns | null,
  nullModes: NullMode[],
  opts: { thetas?: number[]; sims?: number; seed?: number; minObs?: number; refTheta?: number } = {}
) {
  const data = useMemo(() => toTail(aligned), [aligned]);
  const modeKey = nullModes.join("/");
  const request = useMemo<TailWorkerRequest | null>(
    () =>
      data
        ? {
            key: keyOf("exceedanceAll", data, { modeKey, opts }),
            kind: "exceedanceAll",
            data,
            nullModes,
            opts,
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, modeKey, opts]
  );
  const fallback = useMemo(
    () => (req: TailWorkerRequest) => {
      const r = req as Extract<TailWorkerRequest, { kind: "exceedanceAll" }>;
      const a: AlignedReturns = {
        tickers: r.data.tickers,
        dates: [],
        returns: r.data.returns,
        vols: [],
      };
      const out: Record<string, ExceedanceResult> = {};
      for (const m of r.nullModes) out[m] = exceedanceCorrelation(a, { ...r.opts, nullMode: m });
      return out;
    },
    []
  );
  return useTailJob<Record<string, ExceedanceResult>>(request, fallback);
}
