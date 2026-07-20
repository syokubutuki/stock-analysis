"use client";

import React, { useMemo, useState } from "react";
import AnalysisGuide from "./AnalysisGuide";
import { TEST_INVENTORY, registrySummary } from "../../lib/test-registry";

function Badge({ label, value, tone, sub }: { label: string; value: string; tone: "good" | "bad" | "neutral"; sub?: string }) {
  const cls = tone === "good" ? "bg-green-50 border-green-200 text-green-700"
    : tone === "bad" ? "bg-red-50 border-red-200 text-red-700"
    : "bg-gray-50 border-gray-200 text-gray-700";
  return (
    <div className={`rounded border px-3 py-2 ${cls}`}>
      <div className="text-[10px] opacity-70">{label}</div>
      <div className="text-base font-bold font-mono">{value}</div>
      {sub && <div className="text-[10px] opacity-70">{sub}</div>}
    </div>
  );
}

export default function TestRegistryChart() {
  const [alpha, setAlpha] = useState(0.05);
  const [effDivisor, setEffDivisor] = useState(3);

  const summary = useMemo(() => registrySummary(alpha, effDivisor), [alpha, effDivisor]);

  const sections = useMemo(() => {
    const map = new Map<string, typeof TEST_INVENTORY>();
    for (const item of TEST_INVENTORY) {
      const arr = map.get(item.section) ?? [];
      arr.push(item);
      map.set(item.section, arr);
    }
    return Array.from(map.entries());
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">グローバル多重検定台帳 — このアプリは全体で何回サイコロを振ったか</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          各分析のFDR補正は「その分析の中」しか守らない。アプリ中の光る画面を渡り歩いて拾った発見の母数はアプリ全体。
          その全体母数と、エッジゼロでも出るはずの偽発見数を常設表示する。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-1">
          per-test α
          <select className="border rounded px-1 py-0.5" value={alpha} onChange={(e) => setAlpha(Number(e.target.value))}>
            {[0.01, 0.05, 0.1].map((v) => <option key={v} value={v}>{(v * 100).toFixed(0)}%</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          相関割引(実効独立数=M÷)
          <select className="border rounded px-1 py-0.5" value={effDivisor} onChange={(e) => setEffDivisor(Number(e.target.value))}>
            {[1, 2, 3, 5, 10].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <Badge label="総検定数M(概算)" value={summary.totalTests.toLocaleString()} tone="neutral" sub={`${summary.nAnalyses}分析・既定パラメータ`} />
        <Badge
          label="エッジゼロでの期待偽発見数"
          value={`${summary.expectedFalse.toFixed(0)}個`}
          tone="bad"
          sub={`M×α(相関に依存しない)`}
        />
        <Badge
          label="どこかで「有意」が出る確率"
          value={`${(summary.probAtLeastOne * 100).toFixed(1)}%`}
          tone={summary.probAtLeastOne > 0.5 ? "bad" : "neutral"}
          sub={`実効独立数 M/${summary.effDivisor} で計算`}
        />
        <Badge
          label="全体5%を守るper-test閾値"
          value={`p<${summary.bonferroniAlpha.toExponential(1)}`}
          tone="neutral"
          sub="Bonferroni(保守的な下限)"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 px-1.5">セクション</th>
              <th className="text-left px-1.5">分析</th>
              <th className="text-right px-1">検定数(概算)</th>
              <th className="text-left px-1.5">数え方</th>
              <th className="text-center px-1">局所FDR</th>
            </tr>
          </thead>
          <tbody>
            {sections.map(([sec, items]) => (
              <React.Fragment key={sec}>
                {items.map((item, i) => (
                  <tr key={item.analysisId} className="border-b border-gray-100">
                    <td className="py-1 px-1.5 text-gray-500">{i === 0 ? sec : ""}</td>
                    <td className="px-1.5">{item.label}</td>
                    <td className="text-right px-1 font-mono">{item.count}</td>
                    <td className="px-1.5 text-gray-400">{item.basis}</td>
                    <td className="text-center px-1">{item.fdrLocal ? "✓" : "—"}</td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
            <tr className="border-t border-gray-300 font-medium">
              <td className="py-1 px-1.5" colSpan={2}>合計</td>
              <td className="text-right px-1 font-mono font-bold">{summary.totalTests.toLocaleString()}</td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-gray-400">
        検定数は既定パラメータでのオーダーの目安。銘柄を替えて同じスキャンを再実行すれば、母数はさらに銘柄数倍に膨らむ。
      </p>

      <AnalysisGuide title="グローバル多重検定台帳の詳細理論">
        <p className="font-medium text-gray-700">1. 何が問題か</p>
        <p>
          検定を1回行うとき、エッジが本当はゼロでも確率α(通常5%)で「有意」が出ます。これを M 回繰り返すと、
          偽の「有意」は平均 M×α 個出ます。このアプリには数百の検定が組み込まれているため、
          <span className="font-medium">全銘柄・全エッジが完全にゼロでも、常時数十個の「光る発見」が画面のどこかに表示されている</span>
          のが数学的な既定状態です。個々の分析は内部でFDR補正をしていますが、補正の母数(家族)はその分析の中だけ。
          「いろいろな画面を見て回って、光っていたものを採用する」という使い方をした瞬間、家族はアプリ全体に広がります。
          これは「忘れられた分岐の庭(garden of forking paths)」と呼ばれる問題です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"期待偽発見数 = M×α。期待値の線形性により検定間の相関に関係なく成り立つ、最も頑健な数字です。"}</li>
          <li>{"少なくとも1つ偽の有意が出る確率 = 1−(1−α)^M_eff。こちらは相関に依存するため、実効独立数 M_eff = M÷(相関割引) で近似します。同じ価格系列を使い回す検定は強く相関するので、割引3〜5が現実的です。"}</li>
          <li>{"全体の偽陽性率を5%に抑えるper-test閾値: Bonferroni α* = 0.05/M。Šidák版 1−0.95^(1/M) もほぼ同じ値になります。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 直感的な例え</p>
        <p>
          宝くじ売り場で「当たりが出た売り場」が必ずどこかに存在するのと同じです。売り場(分析)が多いほど、
          実力ゼロでも「あの売り場は当たる」という物語が必ず生まれます。問うべきは「この売り場で当たりが出たか」
          ではなく「売り場が何軒あったか」。この台帳はその軒数を数えています。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・使い方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>アプリを一巡して見つけた「有意」の個数が、期待偽発見数(M×α)と同程度なら、それは実力ゼロと区別がつきません。</li>
          <li>本気で採用したい発見には、(1) その分析内のFDR補正済みp値がBonferroni閾値に迫るほど小さい、(2) ウォークフォワードのDSR/PBOを通過、(3) ヌル較正の床を超える、(4) 前向き検証台帳で凍結後も生き残る——の多段の関門を課すこと。</li>
          <li>ヌル較正での実証(エッジゼロでも曜日最適化の累積は+279%になりうる)は、この台帳の「1分析版」です。判断は累積リターンでなくF統計量などの検定量で行うこと。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>検定数は既定パラメータでの概算です。スライダやパラメータを動かして再計算するたび、暗黙の検定数はさらに増えます(ここには数えられていません)。</li>
          <li>複数銘柄で同じスキャンを繰り返すと母数は銘柄数倍になります。台帳の数字は「1銘柄分」です。</li>
          <li>Bonferroniは検定間相関を無視するため過度に保守的です。全体制御の実務はFDR(期待偽発見割合)の考え方で緩めるのが標準ですが、「まず母数を知る」ことがこの台帳の目的です。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
