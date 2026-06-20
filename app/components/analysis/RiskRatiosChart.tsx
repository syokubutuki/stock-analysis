"use client";

import { useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { riskRatios } from "../../lib/risk-extra";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function RiskRatiosChart({ prices }: Props) {
  const r = useMemo(() => riskRatios(prices), [prices]);
  if (prices.length < 60 || !r) return null;

  const cards: { label: string; value: string; good: boolean; hint: string }[] = [
    { label: "Sortino比", value: r.sortino.toFixed(2), good: r.sortino > 1, hint: "下方リスク調整後の超過リターン" },
    { label: "Calmar比", value: r.calmar.toFixed(2), good: r.calmar > 0.5, hint: "年率リターン/最大DD" },
    { label: "Sterling比", value: r.sterling.toFixed(2), good: r.sterling > 0.5, hint: "年率リターン/平均大DD" },
    { label: "Omega(0)", value: r.omega.toFixed(2), good: r.omega > 1, hint: "利益/損失の総量比" },
    { label: "Ulcer指数", value: (r.ulcer * 100).toFixed(1) + "%", good: r.ulcer < 0.1, hint: "DDの深さ×期間(小さいほど良)" },
    { label: "Pain比", value: r.painRatio.toFixed(2), good: r.painRatio > 1, hint: "年率リターン/平均DD" },
    { label: "Tail比", value: r.tailRatio.toFixed(2), good: r.tailRatio > 1, hint: "上裾/下裾(>1で上方優位)" },
    { label: "Rachev比", value: r.rachev.toFixed(2), good: r.rachev > 1, hint: "上位5%平均/下位5%平均" },
  ];

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">リスク調整指標の拡充</h3>
      <div className="text-xs text-gray-500">年率リターン {(r.annReturn * 100).toFixed(1)}% / 最大DD {(r.maxDD * 100).toFixed(1)}%</div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        {cards.map((c) => (
          <div key={c.label} className={`p-2 rounded border ${c.good ? "border-green-200 bg-green-50" : "border-gray-200 bg-gray-50"}`}>
            <div className="text-gray-500">{c.label}</div>
            <div className="font-mono font-bold text-gray-800">{c.value}</div>
            <div className="text-[10px] text-gray-400 leading-tight">{c.hint}</div>
          </div>
        ))}
      </div>

      <AnalysisGuide title="リスク調整指標の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"シャープ比だけでは捉えきれないリスクの側面（下方リスク・ドローダウンの深さと持続・テールの偏り）を、複数の比率で多面的に評価する。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 各指標</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>Sortino</strong>: 平均/下方偏差×√252。下落のブレだけを罰する（上昇のブレは歓迎）。</li>
          <li><strong>Calmar/Sterling/Pain</strong>: 年率リターンを「最大DD / 上位大DDの平均 / 平均DD」で割る。DD耐性あたりのリターン。</li>
          <li><strong>Omega(τ=0)</strong>: 閾値超の利益総量÷閾値割れの損失総量。1超で利益優位。分布全体を使う。</li>
          <li><strong>Ulcer指数</strong>: √(平均DD²)。ドローダウンの深さと長さの両方を罰する苦痛度。</li>
          <li><strong>Tail比</strong>: |95%点|/|5%点|。1超で上裾が下裾より厚い。<strong>Rachev比</strong>: 上位5%平均/下位5%平均。テールの上下バランス。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Sortino/Calmarが高い＝下落・DDの割にリターンが取れている。資金効率の良い対象。</li>
          <li>Ulcer/Painが大きい＝精神的に持ちづらい。サイズを抑えるか別対象を検討。</li>
          <li>Tail/Rachevが1未満＝下方テールが厚い。テールヘッジやサイズ縮小を検討。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>過去依存。レジームが変わると指標も変わる。期間を変えて頑健性を確認。</li>
          <li>年率化は√時間則の近似。自己相関が強いと過小/過大評価。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
