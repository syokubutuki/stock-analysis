"use client";

// μ の定義（対数平均 / 算術平均）をパネル間で共有するストア。
// ────────────────────────────────────────────────────────────────────────────
// 効率的フロンティア（pf-frontier）と CAPM・SML（pf-capm）は、どちらも
// 「μ を対数平均で見るか算術平均で見るか」のトグルを持つ。ところが state が別々だと
// **片方だけ切り替えたまま2つのパネルを見比べる**という事故が起きる——
// フロンティアの接点は算術μ、CAPM の α は対数μ、という食い違いに気づけない。
// 物差しは1つであるべきなので、localStorage + CustomEvent で共有する
// （panel-nav.ts / downside-rho.ts と同じ最小構成）。
//
// 既定は "log"（従来どおり・数値不変）。docs/portfolio-analysis-open-issues.md §1.6 の
// 「既定は反転しない」という決定に従う。

import { useCallback, useEffect, useState } from "react";
import type { MuMode } from "./efficient-frontier";

export const MU_MODE_EVENT = "sa:mu-mode";
const STORAGE_KEY = "sa:mu-mode";

export function loadMuMode(): MuMode {
  if (typeof window === "undefined") return "log";
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "arithmetic" ? "arithmetic" : "log";
  } catch {
    return "log";
  }
}

export function publishMuMode(mode: MuMode): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // localStorage が使えなくてもイベントで同一ページ内は同期できる
  }
  window.dispatchEvent(new CustomEvent<MuMode>(MU_MODE_EVENT, { detail: mode }));
}

/**
 * 共有された μ の定義を読み書きするフック。
 * どのパネルで切り替えても、同じページの他パネルが即座に追従する。
 */
export function useSharedMuMode(): [MuMode, (mode: MuMode) => void] {
  // このフックを使うパネルはすべて ssr:false の動的インポートなので、
  // 遅延初期化で localStorage を直接読んでよい（初期フラッシュが起きない）。
  const [mode, setMode] = useState<MuMode>(() => loadMuMode());

  useEffect(() => {
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<MuMode>).detail;
      if (next === "log" || next === "arithmetic") setMode(next);
    };
    window.addEventListener(MU_MODE_EVENT, onChange as EventListener);
    return () => window.removeEventListener(MU_MODE_EVENT, onChange as EventListener);
  }, []);

  const update = useCallback((next: MuMode) => {
    setMode(next); // 自分は即座に反映（イベントは他パネル向け）
    publishMuMode(next);
  }, []);

  return [mode, update];
}
