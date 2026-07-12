"use client";

import { useState } from "react";
import Link from "next/link";
import {
  COROLLARIES,
  AXIOM_LABEL,
  Q_CHOICE_LABEL,
  type Corollary,
  type AxiomRef,
} from "../lib/axioms/corollaries";

// 系譜図の階層定義。公準・公理・命題は固定（docs/investment-axioms.md）。
const POSTULATES: AxiomRef[] = ["公準1", "公準2", "公準3", "公準4", "公準5"];
const PROPOSITIONS: AxiomRef[] = ["命題1", "命題2", "命題3", "命題4", "命題5"];

function AxiomBox({ id, highlight }: { id: AxiomRef; highlight?: boolean }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs leading-snug ${
        highlight
          ? "border-indigo-400 bg-indigo-50 text-indigo-900 font-medium"
          : "border-gray-200 bg-white text-gray-700"
      }`}
    >
      {AXIOM_LABEL[id]}
    </div>
  );
}

function CorollaryCard({ c }: { c: Corollary }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-baseline gap-2">
        <span className="rounded bg-indigo-600 px-2 py-0.5 text-xs font-bold text-white">
          {c.id}
        </span>
        <h3 className="text-base font-bold text-gray-900">{c.theory}</h3>
        <span className="ml-auto text-[11px] text-gray-400">
          優先度 {"★".repeat(c.priority)}
        </span>
      </div>

      <p className="mt-2 text-sm text-gray-700">{c.claim}</p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {c.basis.map((b) => (
          <span
            key={b}
            className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] text-indigo-700"
          >
            {b}
          </span>
        ))}
        {c.qChoice.map((q) => (
          <span
            key={q}
            className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700"
          >
            q: {Q_CHOICE_LABEL[q]}
          </span>
        ))}
      </div>

      <div className="mt-3 grid gap-1 text-xs text-gray-600 sm:grid-cols-2">
        <div>
          <span className="font-medium text-gray-700">測る P の性質: </span>
          {c.pProperty}
        </div>
        <div>
          <span className="font-medium text-gray-700">実装: </span>
          {c.components.join(" / ")}
        </div>
      </div>

      <button
        onClick={() => setOpen(!open)}
        className="mt-3 text-xs text-indigo-600 hover:text-indigo-800"
      >
        {open ? "▼ 導出鎖を隠す" : "▶ 会計恒等式 W=∫q dP−C からの導出鎖を見る"}
      </button>

      {open && (
        <div className="mt-2 space-y-2 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
          <div>
            <span className="font-medium text-gray-700">P に置く仮定: </span>
            {c.assumption}
          </div>
          <ol className="list-decimal space-y-1.5 pl-4">
            {c.derivation.map((step, i) => (
              <li key={i}>
                <span className="font-medium text-gray-700">{step.label}</span>
                <div className="my-0.5 rounded bg-white px-1.5 py-1 font-mono text-[11px] text-gray-800">
                  {step.expr}
                </div>
                {step.note && <div className="text-gray-500">{step.note}</div>}
              </li>
            ))}
          </ol>
          <div>
            <span className="font-medium text-gray-700">結論の公式: </span>
            <span className="font-mono text-[11px]">{c.formula}</span>
          </div>
          <p className="text-gray-600">{c.conclusion}</p>
          <div className="border-t border-gray-200 pt-1.5">
            <span className="font-medium text-gray-700">摩擦の扱い（公準5）: </span>
            {c.frictionEffect}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AxiomsPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white px-4 py-4">
        <div className="mx-auto flex max-w-5xl items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">株式原論 ─ 投資の公理系</h1>
            <p className="mt-1 text-sm text-gray-500">
              我々が動かせるのは価格 P ではなく建玉 q だけ。全分析はこの一点から出発する。
            </p>
          </div>
          <Link
            href="/"
            className="shrink-0 rounded-lg border border-blue-200 px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 hover:text-blue-700"
          >
            ← 個別分析へ
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-6">
        {/* 序 */}
        <section className="rounded-xl border border-indigo-200 bg-white p-5">
          <h2 className="text-sm font-bold text-gray-900">正すべき認識</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">
            「上がりそう」「ここで買いたい」は、すべて外生的な価格 P への言及であり、
            自分に決定権のない変数への願望にすぎない。我々が実際に選べるのは建玉{" "}
            <b>q(t)</b>（符号・大きさ・タイミング・保有期間）ただ一つ。損益は会計恒等式{" "}
            <span className="font-mono">W = ∫ q dP − C</span>{" "}
            で決まり、あらゆる分析は「P の記述」にすぎず、q の選択を変えて初めて価値を持つ。
          </p>
        </section>

        {/* 系譜図 */}
        <section>
          <h2 className="mb-3 text-sm font-bold text-gray-900">公理系の系譜図</h2>
          <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
            <div>
              <div className="mb-1.5 text-xs font-medium text-gray-500">
                公準（株式に固有の要請）
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {POSTULATES.map((p) => (
                  <AxiomBox key={p} id={p} highlight={p === "公準4"} />
                ))}
              </div>
              <div className="mt-1 text-[11px] text-indigo-500">
                ↑ すべての系は公準4（会計恒等式）から出発する
              </div>
            </div>

            <div className="text-center text-gray-300">▼</div>

            <div>
              <div className="mb-1.5 text-xs font-medium text-gray-500">
                命題（直接導かれる基本定理）
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {PROPOSITIONS.map((p) => (
                  <AxiomBox key={p} id={p} />
                ))}
              </div>
            </div>

            <div className="text-center text-gray-300">▼</div>

            <div>
              <div className="mb-1.5 text-xs font-medium text-gray-500">
                系（既存理論の再導出）
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {COROLLARIES.map((c) => (
                  <div
                    key={c.id}
                    className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs"
                  >
                    <span className="font-bold text-emerald-800">{c.id}</span>{" "}
                    <span className="text-gray-700">{c.theory}</span>
                    <div className="mt-0.5 text-[10px] text-gray-500">
                      ← {c.basis.join(", ")}
                    </div>
                  </div>
                ))}
                <div className="flex items-center justify-center rounded-lg border border-dashed border-gray-300 px-3 py-2 text-[11px] text-gray-400">
                  C22〜（レバレッジと破産・課税の建玉価値 等）は順次追記
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 系カード一覧 */}
        <section>
          <h2 className="mb-3 text-sm font-bold text-gray-900">
            系の一覧（導出鎖つき）
          </h2>
          <div className="space-y-4">
            {COROLLARIES.map((c) => (
              <CorollaryCard key={c.id} c={c} />
            ))}
          </div>
        </section>

        <p className="pb-8 text-center text-xs text-gray-400">
          出典: docs/investment-axioms.md ／ データ源: app/lib/axioms/corollaries.ts
        </p>
      </main>
    </div>
  );
}
