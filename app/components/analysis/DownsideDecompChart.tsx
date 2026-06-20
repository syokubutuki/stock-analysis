"use client";

import { useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { downsideDecomp } from "../../lib/risk-extra";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function DownsideDecompChart({ prices }: Props) {
  const d = useMemo(() => downsideDecomp(prices), [prices]);
  if (prices.length < 60 || !d) return null;
  const maxC = Math.max(1, ...d.streakHist.map((s) => s.count));

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">下方リスク分解（半偏差・損失寄与・連敗分布）</h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded"><div className="text-gray-500">半偏差(年率)</div><div className="font-mono font-medium">{(d.semiDev * 100).toFixed(1)}%</div></div>
        <div className="p-2 bg-gray-50 rounded"><div className="text-gray-500">損失日の割合</div><div className="font-mono font-medium">{(d.lossDayShare * 100).toFixed(0)}%</div></div>
        <div className="p-2 bg-gray-50 rounded"><div className="text-gray-500">損失寄与</div><div className="font-mono font-medium">{(d.lossContribution * 100).toFixed(0)}%</div></div>
        <div className="p-2 bg-red-50 rounded"><div className="text-gray-500">最長連敗</div><div className="font-mono font-medium">{d.worstStreak}日</div></div>
      </div>

      <div>
        <div className="text-xs text-gray-500 mb-1">連敗（連続下落日数）の分布</div>
        <div className="space-y-1">
          {d.streakHist.map((s) => (
            <div key={s.len} className="flex items-center gap-2 text-xs">
              <span className="w-10 text-right text-gray-600">{s.len}日</span>
              <div className="flex-1 bg-gray-100 rounded-sm overflow-hidden h-4">
                <div className="bg-red-400 h-full" style={{ width: `${(s.count / maxC) * 100}%` }} />
              </div>
              <span className="w-8 text-gray-500">{s.count}</span>
            </div>
          ))}
        </div>
      </div>

      <AnalysisGuide title="下方リスク分解の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"損失の構造を分解する。全体のブレではなく『下落だけ』の大きさ（半偏差）、損失日がどれだけあり全体の変動にどれだけ寄与するか、そして連敗がどこまで続くかを見る。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>半偏差</strong>: 負リターンだけの二乗平均平方根（年率）。下方向のブレの大きさ。</li>
          <li><strong>損失寄与</strong>: Σ|負リターン| / Σ|全リターン|。値動きのうち下落が占める割合。</li>
          <li><strong>連敗分布</strong>: 連続下落日数の頻度。最長連敗は心理的・資金的な耐性の目安。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>半偏差が大きい＝下方向に振れやすい。ストップ幅・サイズの設計に反映。</li>
          <li>連敗分布の右裾＝想定すべき連続損失。資金管理（許容連敗数）の根拠に。</li>
          <li>損失寄与が高いのにリターンがプラス＝大きな上昇日に依存。取りこぼしリスク。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>連敗は終値ベース。日中の値動きは含まない。</li>
          <li>期間が短いと連敗分布の右裾が過小評価される。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
