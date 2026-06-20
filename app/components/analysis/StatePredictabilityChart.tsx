"use client";

import { useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { statePredictability } from "../../lib/state-predictability";
import { STATE_AXES, StateAxis } from "../../lib/conditional-forward-returns";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function StatePredictabilityChart({ prices }: Props) {
  const [axis, setAxis] = useState<StateAxis>("vol");
  const rows = useMemo(() => (prices.length < 300 ? [] : statePredictability(prices, axis, 5, 5)), [prices, axis]);

  if (prices.length < 300 || rows.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">状態別の予測可能性（方向的中率・情報係数IC）</h3>

      <div className="flex gap-1 flex-wrap">
        {STATE_AXES.map((a) => (
          <button key={a.value} onClick={() => setAxis(a.value)} className={`px-2.5 py-1 text-xs rounded font-medium ${axis === a.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{a.label}</button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 px-2">状態</th>
              <th className="text-right px-2">n</th>
              <th className="text-left px-2">方向的中率</th>
              <th className="text-right px-2">IC</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-gray-100">
                <td className="py-1 px-2 font-medium text-gray-700">{r.label}</td>
                <td className="text-right px-2 text-gray-600">{r.n}</td>
                <td className="px-2">
                  <div className="flex items-center gap-1">
                    <div className="relative h-3 w-16 bg-gray-100 rounded-sm overflow-hidden">
                      <div className={`absolute inset-y-0 left-0 ${r.hitRate >= 0.5 ? "bg-green-400" : "bg-red-400"}`} style={{ width: `${r.hitRate * 100}%` }} />
                      <div className="absolute inset-y-0 left-1/2 w-px bg-gray-400" />
                    </div>
                    <span className="text-gray-600 tabular-nums">{(r.hitRate * 100).toFixed(0)}%</span>
                  </div>
                </td>
                <td className={`text-right px-2 font-medium ${Math.abs(r.ic) >= 0.1 ? (r.ic > 0 ? "text-green-600" : "text-red-600") : "text-gray-400"}`}>{r.ic.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-400">※予測子＝過去5日リターン、実現＝先5日リターン。IC＝両者の相関（+で順張り/モメンタムが効く、−で逆張りが効く）。</p>

      <AnalysisGuide title="状態別予測可能性の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"『どの局面なら値動きが予測しやすいか』を状態別に評価する。同じ予測手法（短期モメンタム）でも、ボラやトレンドの状態によって効いたり効かなかったりする。それを的中率と情報係数(IC)で可視化する。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 用語・計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>方向的中率</strong>: 過去5日の上下と先5日の上下が一致した割合。50%超でモメンタム、未満で反転が優勢。</li>
          <li><strong>IC(情報係数)</strong>: 予測子（過去5日リターン）と実現（先5日リターン）の相関。プロの運用で予測力の標準指標。|IC|≥0.1で実用的とされることが多い。</li>
          <li>状態は選んだ軸（ボラ/トレンド/RSI等）でバケット化。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ICがプラスに大きい状態＝順張り（モメンタム）が効く局面。トレンドフォローを厚く。</li>
          <li>ICがマイナスの状態＝逆張りが効く局面。平均回帰戦略へ切替。</li>
          <li>ICがほぼ0の状態＝予測困難。サイズを落とす/見送る。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>過去依存。ICは時期で変動する（IC自体に分散がある）。</li>
          <li>予測子は単純な短期モメンタム。他の予測子では結論が変わりうる。</li>
          <li>状態で分けると標本が減る。nを確認。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
