"use client";

import { useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { behavioralAnalysis } from "../../lib/behavioral";
import {
  generateCoach,
  generateEvidence,
  BIAS_CARDS,
  CHECKLIST,
  type Severity,
  type BiasCard,
  type Tone,
} from "../../lib/behavioral-coach";
import GuideEntryPanel from "./GuideEntryPanel";

interface Props {
  prices: PricePoint[];
}

const SEVERITY_STYLE: Record<Severity, { box: string; tag: string; label: string }> = {
  high: { box: "border-red-200 bg-red-50", tag: "bg-red-600 text-white", label: "要注意" },
  medium: { box: "border-amber-200 bg-amber-50", tag: "bg-amber-500 text-white", label: "注意" },
  info: { box: "border-blue-200 bg-blue-50", tag: "bg-blue-500 text-white", label: "参考" },
};

const CATEGORY_STYLE: Record<BiasCard["category"], string> = {
  "信念・判断": "bg-indigo-100 text-indigo-700",
  "選好・行動": "bg-emerald-100 text-emerald-700",
  社会的: "bg-rose-100 text-rose-700",
};

const TONE_TEXT: Record<Tone, string> = {
  pos: "text-green-700",
  neg: "text-red-700",
  neutral: "text-gray-700",
};

const VERDICT_STYLE: Record<Tone, string> = {
  pos: "border-green-200 bg-green-50",
  neg: "border-red-200 bg-red-50",
  neutral: "border-gray-200 bg-gray-50",
};

export default function InvestorBiasCoach({ prices }: Props) {
  const { coach, evidence } = useMemo(() => {
    const result = behavioralAnalysis(prices);
    return {
      coach: generateCoach(prices, result),
      evidence: generateEvidence(prices, result),
    };
  }, [prices]);

  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [openCard, setOpenCard] = useState<string | null>(null);

  const doneCount = CHECKLIST.filter((c) => checked[c.id]).length;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">
        投資家バイアス・コーチ（癖と対策）
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        市場の統計ではなく「投資家自身の癖・習性」に光を当て、いまの局面で陥りやすい罠と具体的な対策を提示します。
      </p>

      {/* ②' 実データで裏づけるバイアス */}
      <div className="mb-4">
        <div className="text-xs font-medium text-gray-600 mb-2">
          この銘柄のデータで裏づけるバイアス
        </div>
        {evidence.length === 0 ? (
          <div className="text-xs text-fg-muted">データ不足（60営業日以上が必要）</div>
        ) : (
          <div className="space-y-2">
            {evidence.map((e, i) => (
              <div key={i} className={`border rounded p-2.5 ${VERDICT_STYLE[e.verdictTone]}`}>
                <div className="text-xs font-semibold text-gray-800 mb-1.5">{e.name}</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mb-1.5">
                  {e.metrics.map((m, j) => (
                    <div key={j} className="text-xs">
                      <span className="text-gray-500">{m.label}: </span>
                      <span className={`font-mono font-semibold ${TONE_TEXT[m.tone ?? "neutral"]}`}>
                        {m.value}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="text-xs text-gray-800 mb-0.5">
                  <span className="text-gray-500">判定：</span>
                  {e.verdict}
                </div>
                <div className="text-xs text-gray-700">
                  <span className="text-gray-500">行動への含意：</span>
                  {e.implication}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ② 現在局面に連動した警告 */}
      <div className="mb-4">
        <div className="text-xs font-medium text-gray-600 mb-2">
          いまの局面で注意すべきこと
        </div>
        {!coach.metrics.enoughData ? (
          <div className="text-xs text-fg-muted">データ不足（60営業日以上が必要）</div>
        ) : (
          <div className="space-y-2">
            {coach.signals.map((s, i) => {
              const st = SEVERITY_STYLE[s.severity];
              return (
                <div key={i} className={`border rounded p-2.5 ${st.box}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${st.tag}`}>
                      {st.label}
                    </span>
                    <span className="text-xs font-semibold text-gray-800">{s.title}</span>
                  </div>
                  <div className="text-xs text-gray-600 mb-1">{s.situation}</div>
                  <div className="text-xs text-gray-700 mb-1">
                    <span className="text-gray-500">陥りやすい罠：</span>
                    {s.trap}
                  </div>
                  <div className="text-xs text-gray-800">
                    <span className="text-gray-500">対策：</span>
                    {s.action}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ③ 売買前チェックリスト */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-gray-600">売買前チェックリスト</div>
          <div className="text-xs text-gray-500">
            {doneCount}/{CHECKLIST.length} 確認
          </div>
        </div>
        <div className="space-y-1">
          {CHECKLIST.map((c) => (
            <label
              key={c.id}
              className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5"
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={!!checked[c.id]}
                onChange={(e) =>
                  setChecked((prev) => ({ ...prev, [c.id]: e.target.checked }))
                }
              />
              <span className={checked[c.id] ? "line-through text-fg-muted" : ""}>
                {c.text}
              </span>
            </label>
          ))}
        </div>
        {doneCount === CHECKLIST.length && (
          <div className="text-xs text-green-700 mt-2 font-medium">
            全項目を確認済み。感情ではなくルールに沿った判断ができています。
          </div>
        )}
      </div>

      {/* ① バイアス・ナレッジカード */}
      <div>
        <div className="text-xs font-medium text-gray-600 mb-2">
          主要バイアス図鑑（クリックで対策を表示）
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {BIAS_CARDS.map((b) => {
            const open = openCard === b.id;
            return (
              <div key={b.id} className="border rounded overflow-hidden">
                <button
                  onClick={() => setOpenCard(open ? null : b.id)}
                  className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-gray-50"
                >
                  <span
                    className="inline-block text-gray-500 transition-transform duration-200"
                    style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
                  >
                    ▶
                  </span>
                  <span className="text-xs font-semibold text-gray-800">{b.name}</span>
                  <span className={`text-[10px] px-1 py-0.5 rounded ${CATEGORY_STYLE[b.category]}`}>
                    {b.category}
                  </span>
                </button>
                {open && (
                  <div className="px-2.5 pb-2.5 text-xs space-y-1.5 bg-gray-50">
                    <div className="text-[10px] text-fg-muted">{b.en}</div>
                    <div>
                      <span className="text-gray-500">症状：</span>
                      <span className="text-gray-700">{b.symptom}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">なぜ起きる：</span>
                      <span className="text-gray-700">{b.cause}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">対策：</span>
                      <span className="text-gray-800 font-medium">{b.countermeasure}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 解説本文は app/lib/analysis-guides.ts の唯一のソースから描く。
          ここに散文を書き戻すと /guide/investor-bias と二重管理になる。 */}
      <GuideEntryPanel slug="investor-bias" title="投資家バイアス・コーチの使い方と根拠" />
    </div>
  );
}
