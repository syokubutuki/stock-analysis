"use client";

import { useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeMultiTimeframe, type TimeframeStats } from "../../lib/multi-timeframe";
import GuideEntryPanel from "./GuideEntryPanel";

interface Props { prices: PricePoint[]; }

function StatCell({ value, fmt, green }: { value: number; fmt: (v: number) => string; green?: boolean }) {
  const color = green === undefined ? "text-gray-700" : value >= 0 ? "text-green-600" : "text-red-600";
  return <td className={`py-1.5 px-2 text-center font-mono ${color}`}>{fmt(value)}</td>;
}

export default function MultiTimeframeChart({ prices }: Props) {
  const result = useMemo(() => computeMultiTimeframe(prices), [prices]);

  if (result.stats.length === 0) return null;

  const pct = (v: number) => (v * 100).toFixed(2) + "%";
  const f3 = (v: number) => v.toFixed(3);
  const f2 = (v: number) => v.toFixed(2);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">マルチタイムフレーム分析</h3>
      <p className="text-xs text-gray-500">日足・週足・月足でのリターン統計を比較。時間集約による構造変化を検出。</p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead><tr className="border-b border-gray-300">
            <th className="py-2 px-2 text-left text-gray-500">時間軸</th>
            <th className="py-2 px-2 text-center text-gray-500">n</th>
            <th className="py-2 px-2 text-center text-gray-500">平均R</th>
            <th className="py-2 px-2 text-center text-gray-500">σ</th>
            <th className="py-2 px-2 text-center text-gray-500">Sharpe</th>
            <th className="py-2 px-2 text-center text-gray-500">歪度</th>
            <th className="py-2 px-2 text-center text-gray-500">尖度</th>
            <th className="py-2 px-2 text-center text-gray-500">Hurst</th>
            <th className="py-2 px-2 text-center text-gray-500">ACF(1)</th>
            <th className="py-2 px-2 text-center text-gray-500">MaxDD</th>
          </tr></thead>
          <tbody>
            {result.stats.map((s, i) => (
              <tr key={i} className={`border-b border-gray-100 ${i === 0 ? "bg-blue-50" : ""}`}>
                <td className="py-1.5 px-2 font-bold text-gray-700">{s.timeframe}</td>
                <td className="py-1.5 px-2 text-center font-mono text-gray-500">{s.n}</td>
                <StatCell value={s.meanReturn} fmt={pct} green />
                <td className="py-1.5 px-2 text-center font-mono text-gray-600">{pct(s.stdReturn)}</td>
                <StatCell value={s.sharpe} fmt={f3} green />
                <td className="py-1.5 px-2 text-center font-mono text-gray-600">{f3(s.skewness)}</td>
                <td className={`py-1.5 px-2 text-center font-mono ${s.kurtosis > 3 ? "text-red-600 font-medium" : "text-gray-600"}`}>{f2(s.kurtosis)}</td>
                <td className={`py-1.5 px-2 text-center font-mono ${s.hurst > 0.55 ? "text-blue-600" : s.hurst < 0.45 ? "text-orange-600" : "text-gray-600"}`}>{f3(s.hurst)}</td>
                <td className={`py-1.5 px-2 text-center font-mono ${Math.abs(s.acf1) > 0.1 ? "text-purple-600 font-medium" : "text-gray-600"}`}>{f3(s.acf1)}</td>
                <td className="py-1.5 px-2 text-center font-mono text-red-600">{pct(s.maxDrawdown)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result.stats.length >= 3 && (() => {
        const daily = result.stats[0];
        const weekly = result.stats[1];
        const monthly = result.stats[2];
        return (
          <div className="p-3 bg-blue-50 rounded text-xs text-gray-700">
            <div className="font-medium text-blue-800 mb-1">タイムフレーム比較の判定</div>
            <ul className="space-y-1">
              <li>
                尖度: 日足{f2(daily.kurtosis)} → 週足{f2(weekly.kurtosis)} → 月足{f2(monthly.kurtosis)}。
                {daily.kurtosis > weekly.kurtosis && weekly.kurtosis > monthly.kurtosis
                  ? "時間集約で尖度が低下 → 日次の極端なリターンは独立で、集約により正規分布に接近（CLTの効果）。"
                  : "時間集約でも尖度が低下しない → リターンの依存構造が強い。"}
              </li>
              <li>
                Hurst: 日足{f3(daily.hurst)} → 週足{f3(weekly.hurst)}。
                {Math.abs(daily.hurst - weekly.hurst) < 0.1
                  ? "時間スケールで安定 → フラクタル的な自己相似性。"
                  : "時間スケールで変化 → 特定のスケールに構造が集中。"}
              </li>
            </ul>
          </div>
        );
      })()}

      {/* 解説本文は app/lib/analysis-guides.ts の唯一のソースから描く。
          ここに散文を書き戻すと /guide/multi-timeframe と二重管理になる。 */}
      <GuideEntryPanel slug="multi-timeframe" title="マルチタイムフレーム分析の詳細理論" />
    </div>
  );
}
