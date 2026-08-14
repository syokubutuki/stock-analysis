"use client";

// 分析パネルの末尾に付ける、折りたたみ式の解説。
//
// 呼び出しは287箇所ある。props と DOM 構造を変えない範囲の変更は一括で効くので、
// 見た目を触るときは「呼び出し側を1つも直さずに済むか」を先に確かめること。
//
// 重みの設計: 親の CollapsibleAnalysis が「▶ ＋太字見出し」で分析そのものを畳む。
// この解説トグルはそれより弱く、しかし本文より強い ― 押せると分かるピル1個に留める。
// 1ファイルに18個並ぶ例(SpiralHeatmap)があるため、全幅の帯にはしない。
//
// 中身は open のときだけマウントする。KaTeX を含む解説が287個常時描画されると重い。

import { useState } from "react";
import { track } from "@vercel/analytics";

interface Props {
  title: string;
  /**
   * children が自前で枠(カード)を持つ場合に true。
   * 既定の bg-gray-50 の箱を外し、枠が二重になるのを防ぐ。GuideEntryPanel 用。
   */
  bare?: boolean;
  children: React.ReactNode;
}

export default function AnalysisGuide({ title, bare, children }: Props) {
  const [open, setOpen] = useState(false);

  const toggle = () => {
    setOpen((current) => {
      const next = !current;
      if (next) track("guide_open", { guide: title });
      return next;
    });
  };

  return (
    <div className="mt-3 border-t border-gray-100 pt-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        // rounded-full ではなく 2xl。1行なら丸ピルに見え、狭い画面で
        // 見出しが折り返したときだけ角丸長方形へ degrade する(潰れた勾玉にならない)。
        className={`inline-flex max-w-full items-center gap-1.5 rounded-2xl border px-2.5 py-1 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${
          open
            ? "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
            : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-800"
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
          <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5" />
        </svg>
        {title}
        <svg
          viewBox="0 0 24 24"
          className="h-3 w-3 shrink-0 transition-transform duration-200"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open &&
        (bare ? (
          <div className="mt-2">{children}</div>
        ) : (
          <div className="mt-2 space-y-2 rounded bg-gray-50 p-3 text-xs leading-relaxed text-gray-600">
            {children}
          </div>
        ))}
    </div>
  );
}
