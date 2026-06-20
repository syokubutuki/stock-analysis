"use client";

import { useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { stopComparison } from "../../lib/execution-stats";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; }
const HOLDS = [10, 20, 40];
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

export default function StopComparisonChart({ prices }: Props) {
  const [maxHold, setMaxHold] = useState(20);
  const stats = useMemo(() => (prices.length < 260 ? [] : stopComparison(prices, maxHold)), [prices, maxHold]);
  if (prices.length < 260 || stats.length === 0) return null;
  const best = stats.reduce((a, b) => (b.expReturn > a.expReturn ? b : a), stats[0]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">ストップ方式の比較（固定%/ATR/シャンデリア/トレーリング）</h3>
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span>保有上限:</span>
          {HOLDS.map((h) => <button key={h} onClick={() => setMaxHold(h)} className={`px-2 py-0.5 rounded ${maxHold === h ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{h}日</button>)}
        </div>
      </div>

      <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">
        この銘柄で期待値最大のストップ方式: <span className="font-bold">{best.label}</span>（期待 {fmtPct(best.expReturn)}・勝率 {(best.winRate * 100).toFixed(0)}%）
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-gray-500 border-b border-gray-200"><th className="text-left py-1 px-2">方式</th><th className="text-right px-2">期待リターン</th><th className="text-right px-2">勝率</th><th className="text-right px-2">平均保有</th><th className="text-right px-2">n</th></tr></thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.method} className={`border-b border-gray-100 ${s.method === best.method ? "bg-green-50" : ""}`}>
                <td className="py-1 px-2 font-medium text-gray-700">{s.label}</td>
                <td className={`text-right px-2 font-medium ${s.expReturn >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtPct(s.expReturn)}</td>
                <td className="text-right px-2 text-gray-600">{(s.winRate * 100).toFixed(0)}%</td>
                <td className="text-right px-2 text-gray-500">{s.avgHold.toFixed(1)}日</td>
                <td className="text-right px-2 text-gray-500">{s.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AnalysisGuide title="ストップ方式比較の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"同じエントリーでも損切りの置き方で成績は大きく変わる。固定%・ATR・シャンデリア・トレーリングの4方式を同条件でシミュレートし、どれが期待値を最大化するかを比べる。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 各方式（当日引けロング）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>固定%</strong>: エントリーから−5%固定。シンプルだがボラを無視。</li>
          <li><strong>ATR</strong>: エントリー−2×ATR。ボラに応じて損切り幅を調整。</li>
          <li><strong>シャンデリア</strong>: 保有中の最高値−3×ATR（トレーリング）。利を伸ばしつつ守る。</li>
          <li><strong>トレーリング%</strong>: 最高値−8%。利益を確定方向に追従。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>期待値最大の方式を採用。ただし勝率と平均保有のバランスも見る（低勝率高期待値は連敗に耐える資金管理が必要）。</li>
          <li>トレンド銘柄はトレーリング/シャンデリアが有利、レンジ銘柄は固定/ATRが有利になりやすい。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>全日エントリーの平均（無条件）。特定シグナルでは最適方式が変わる。</li>
          <li>パラメータ(5%/2ATR等)固定。最適化すると過剰最適化のリスク。</li>
          <li>日中の約定順序は日足では不明。ギャップ割れの想定外約定は未考慮。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
