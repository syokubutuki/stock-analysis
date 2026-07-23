// 分析パネル間ジャンプ導線。
// あるコンポーネントから別の折りたたみ分析(CollapsibleAnalysis)を
// プログラム的に「開いてスクロール」するための最小イベント。
// CollapsibleAnalysis が window の OPEN_PANEL_EVENT を購読し、
// detail.id が自分のIDと一致したら開いて scrollIntoView する。

export const OPEN_PANEL_EVENT = "sa:open-panel";

export interface OpenPanelDetail {
  id: string;
}

/** 指定IDの分析パネルを開いてスクロールする（別コンポーネントから呼ぶ）。 */
export function openAnalysisPanel(id: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenPanelDetail>(OPEN_PANEL_EVENT, { detail: { id } }));
}
