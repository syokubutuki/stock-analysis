"use client";

// ウォッチリスト横断テーブル(WeekdayUsCrossChart / WeeklyAnalogCrossChart)の共通部品。
//
// 左端の「銘柄」列は sticky で横スクロール中も残す必要がある(どの行かが分からなくなるため)。
// ただし名称を出し切る幅(≈172px)のまま固定されると、横にスライドして本題の数値を見たいときに
// その分だけ表示幅を食う。そこで名称/コードの2段階で列幅を切り替えられるようにし、選択は
// localStorage に保存する(銘柄非依存＝再検索しても維持)。

import { useState } from "react";

export type NameColMode = "name" | "code";

const LS_KEY = "cross-table-name-col";

/** 列幅(px)。sticky 列は内容で伸びないよう th/td 双方にこの幅を固定する。 */
export const NAME_COL_W: Record<NameColMode, number> = { name: 172, code: 62 };

export function useNameColMode(): [NameColMode, (m: NameColMode) => void] {
  // ssr:false の動的インポート配下なので、遅延初期化で localStorage を直接読んでよい。
  const [mode, setMode] = useState<NameColMode>(() => {
    try {
      const v = localStorage.getItem(LS_KEY);
      if (v === "name" || v === "code") return v;
    } catch {
      // localStorage 利用不可時は既定値
    }
    return "name";
  });
  const set = (m: NameColMode) => {
    setMode(m);
    try {
      localStorage.setItem(LS_KEY, m);
    } catch {}
  };
  return [mode, set];
}

/** sticky 銘柄列の th/td に渡す固定幅スタイル。 */
export function nameColStyle(mode: NameColMode) {
  const w = NAME_COL_W[mode];
  return { width: w, minWidth: w, maxWidth: w };
}

/** 「銘柄」見出し + 列幅トグル。横スクロール時の可視幅を稼ぐためのボタン。 */
export function NameColHeader({ mode, onChange }: {
  mode: NameColMode;
  onChange: (m: NameColMode) => void;
}) {
  const narrow = mode === "code";
  return (
    <div className="flex items-center gap-1">
      <span>{narrow ? "コード" : "銘柄"}</span>
      <button
        onClick={() => onChange(narrow ? "name" : "code")}
        title={narrow ? "銘柄列を広げて名称を表示" : "銘柄列を狭めてコードのみ表示(横スクロール時の表示幅を稼ぐ)"}
        className="text-gray-300 hover:text-blue-500 text-[11px] leading-none flex-shrink-0"
      >
        {narrow ? "»" : "«"}
      </button>
    </div>
  );
}
