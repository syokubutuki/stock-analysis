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
import AnalysisGuide from "./AnalysisGuide";

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
          <div className="text-xs text-gray-400">データ不足（60営業日以上が必要）</div>
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
          <div className="text-xs text-gray-400">データ不足（60営業日以上が必要）</div>
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
              <span className={checked[c.id] ? "line-through text-gray-400" : ""}>
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
                    className="inline-block text-gray-400 transition-transform duration-200"
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
                    <div className="text-[10px] text-gray-400">{b.en}</div>
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

      <AnalysisGuide title="投資家バイアス・コーチの使い方と根拠">
        <p className="font-medium text-gray-700">1. この分析の狙い</p>
        <p>
          モメンタムやアンカリングといった「市場に現れる統計的規則性」とは別に、
          その裏側にある「投資家自身の認知バイアス（判断の癖）」を扱います。
          分析結果を眺めて終わりにせず、実際の売買行動を変えるための橋渡しが目的です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 「この銘柄のデータで裏づけるバイアス」の算出</p>
        <p>
          既存計算と結びつく4つのバイアスを、この銘柄の実数値で定量化・判定します。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <span className="font-medium">アンカリング</span>：52週高値比率が高値近辺(&gt;90%)と低水準(≤70%)のときの翌月平均リターンを比較。
            近辺の方が高ければ過小反応（アンカリング効果あり）、逆なら平均回帰型と判定。
          </li>
          <li>
            <span className="font-medium">モメンタム/リバーサル</span>：短期(20日)と長期(120日)のWML(勝者−敗者)とt値から、
            順張り・逆張りのどちらが有意かを判定。
          </li>
          <li>
            <span className="font-medium">ディスポジション効果のコスト</span>：過去120日の勝者/敗者に分け、
            それぞれの翌20日平均リターンを計算。勝者を早売りして放棄する分・敗者を保有して被る分を金額感で提示。
          </li>
          <li>
            <span className="font-medium">損失回避</span>：日次の上昇日/下落日の平均と、下方/上方ボラティリティ比から下方の非対称性を測定。
            損失回避係数λ≈2.25を掛けて「下落の痛みが上昇の喜びの何倍か」を提示。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 「いまの局面で注意すべきこと」の算出</p>
        <p>
          既存の行動ファイナンス指標（52週高値比率・モメンタム）に加え、直近ピークからのドローダウン、
          直近20/60営業日リターンを計算し、以下のルールで該当するバイアス警告を表示します。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>52週高値比率 ≥ 90% → アンカリング／早すぎる利確</li>
          <li>高値比率 ≤ 75% またはドローダウン ≥ 20% → 塩漬け・ナンピン（ディスポジション／サンクコスト）</li>
          <li>直近20日 ≤ −8% → 狼狽売り・過剰反応（リセンシー）</li>
          <li>直近20日 ≥ +10% → 自信過剰・ハウスマネー効果</li>
          <li>モメンタム構造に応じて代表性／確証バイアスを喚起</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. チェックリストの意味</p>
        <p>
          売買の直前に自問することで、感情的な即断（システム1）を、
          ルールに基づく熟慮（システム2）へ切り替える「事前コミットメント」の道具です。
          チェック状態はこの画面内の一時的なもので、保存はされません。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>エントリー前にチェックリストを一巡し、未確認項目があれば見送る</li>
          <li>警告に該当する局面では、成行での衝動的な売買を避け事前ルールに従う</li>
          <li>自分が繰り返しがちなバイアスをカードで復習し、対策を仕組み化する</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>警告のしきい値は経験則であり、売買シグナルそのものではない</li>
          <li>バイアスの有無や強さは個人差が大きい。自己観察と併用すること</li>
          <li>「バイアスを知る」ことと「行動を変える」ことは別。仕組み（自動損切り等）で補うのが有効</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
