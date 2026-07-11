"use client";

import { useState } from "react";
import {
  getCorollary,
  AXIOM_LABEL,
  Q_CHOICE_LABEL,
} from "../../lib/axioms/corollaries";

interface Props {
  /** app/lib/axioms/corollaries.ts の系ID（例: "C1"）。 */
  corollaryId: string;
}

/**
 * 「この分析の公理的位置づけ（株式原論）」ブロック。
 * corollaries.ts の系データを唯一の源として、各分析コンポーネントの末尾に1行で差し込む。
 *   <AxiomPlacement corollaryId="C1" />
 * docs/investment-axioms.md 第6部の定型ブロックに対応。
 */
export default function AxiomPlacement({ corollaryId }: Props) {
  const [open, setOpen] = useState(false);
  const [showDeriv, setShowDeriv] = useState(false);
  const c = getCorollary(corollaryId);

  if (!c) return null;

  return (
    <div className="mt-3 border-t border-indigo-100 pt-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-700 transition-colors"
      >
        <span
          className="inline-block transition-transform duration-200"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
        {`公理的位置づけ（株式原論 ${c.id}: ${c.theory}）`}
      </button>

      {open && (
        <div className="mt-2 text-xs text-gray-600 leading-relaxed space-y-2 bg-indigo-50/50 rounded p-3">
          <p className="text-gray-700">{c.claim}</p>

          <div className="grid grid-cols-1 gap-y-1 mt-2">
            <div>
              <span className="font-medium text-gray-700">立脚する公準/命題: </span>
              {c.basis.map((b) => AXIOM_LABEL[b]).join(" ／ ")}
            </div>
            <div>
              <span className="font-medium text-gray-700">測る P の性質: </span>
              {c.pProperty}
            </div>
            <div>
              <span className="font-medium text-gray-700">変える q の選択: </span>
              {c.qChoice.map((q) => Q_CHOICE_LABEL[q]).join("・")}
            </div>
            <div>
              <span className="font-medium text-gray-700">摩擦の扱い（公準5）: </span>
              {c.frictionEffect}
            </div>
          </div>

          <button
            onClick={() => setShowDeriv(!showDeriv)}
            className="mt-1 text-indigo-500 hover:text-indigo-700"
          >
            {showDeriv ? "▼ 導出鎖を隠す" : "▶ 会計恒等式 W=∫q dP−C からの導出鎖を見る"}
          </button>

          {showDeriv && (
            <div className="mt-1 space-y-2 border-l-2 border-indigo-200 pl-3">
              <div>
                <span className="font-medium text-gray-700">P に置く仮定: </span>
                {c.assumption}
              </div>
              <ol className="list-decimal pl-4 space-y-1">
                {c.derivation.map((step, i) => (
                  <li key={i}>
                    <span className="font-medium text-gray-700">{step.label}</span>
                    <div className="font-mono text-[11px] text-gray-800 bg-white/70 rounded px-1.5 py-0.5 my-0.5">
                      {step.expr}
                    </div>
                    {step.note && <div className="text-gray-500">{step.note}</div>}
                  </li>
                ))}
              </ol>
              <div className="mt-1">
                <span className="font-medium text-gray-700">結論の公式: </span>
                <span className="font-mono text-[11px]">{c.formula}</span>
              </div>
              <p className="text-gray-500">{c.conclusion}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
