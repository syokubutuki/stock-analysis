"use client";

import { useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  COROLLARIES,
  Q_CHOICE_LABEL,
  type Corollary,
} from "../lib/axioms/corollaries";
import TeX from "../components/analysis/TeX";
import AxiomGraph from "../components/analysis/AxiomGraph";

// 合流点(今日の q 提案)。自前でデータ取得する client コンポーネントなので SSR 無効。
const TodayQProposal = dynamic(
  () => import("../components/analysis/TodayQProposal"),
  { ssr: false }
);

function CorollaryCard({ c }: { c: Corollary }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      id={c.id}
      className="scroll-mt-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
    >
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

      {/* 結論の公式(見出しとして常時表示)。導出鎖はこの式に到達するための一本道。 */}
      <div className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50/40 px-3 py-2 text-center">
        <TeX block>{c.formulaTex}</TeX>
      </div>

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
            <div className="my-1 rounded bg-white px-2 py-1.5 text-center">
              <TeX block>{c.formulaTex}</TeX>
            </div>
            <span className="text-gray-600">{c.formula}</span>
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
            <b>q(t)</b>（符号・大きさ・タイミング・保有期間）ただ一つ。損益は会計恒等式
          </p>

          {/* 公準4: この一式から全23系が導出される。 */}
          <div className="my-3 rounded-lg border border-indigo-200 bg-indigo-50/50 py-2 text-center">
            <TeX block>{"W(T) = \\int_0^T q(t)\\,dP(t) \\;-\\; C"}</TeX>
          </div>

          <p className="text-sm leading-relaxed text-gray-700">
            で決まり、あらゆる分析は「P の記述」にすぎず、q の選択を変えて初めて価値を持つ。
            儲けは価格の動き <TeX>{"dP"}</TeX> そのものではなく、
            <b>その瞬間の建玉 <TeX>{"q"}</TeX> との積</b>でしか発生しない。
          </p>
        </section>

        {/* 合流点: 今日の q 提案(全系が単一の建玉に畳み込まれる場所) */}
        <TodayQProposal />

        {/* 系譜図(インタラクティブ依存グラフ) */}
        <section>
          <h2 className="mb-3 text-sm font-bold text-gray-900">公理系の系譜図</h2>
          <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
            <AxiomGraph />

            {/* 命題1(技術の分解定理): 投資の巧拙は「当てる力」ではなく Cov(q,dP)。 */}
            <div className="rounded-lg bg-gray-50 py-1.5 text-center">
              <TeX block>
                {"\\mathbb{E}[W] = \\int \\mathbb{E}[q]\\,\\mathbb{E}[dP] \\;+\\; \\int \\mathrm{Cov}(q,\\,dP) \\;-\\; \\mathbb{E}[C]"}
              </TeX>
              <div className="text-[11px] text-gray-500">
                命題1（技術の分解定理）── 巧拙は「価格を当てる力」ではなく{" "}
                <TeX>{"\\mathrm{Cov}(q, dP)"}</TeX>（エッジ）に宿る
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
