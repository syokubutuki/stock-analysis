"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { behavioralAnalysis } from "../../lib/behavioral";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function BehavioralChart({ prices }: Props) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const anchorApiRef = useRef<IChartApi | null>(null);

  const result = useMemo(() => behavioralAnalysis(prices), [prices]);

  // 52-week high ratio chart
  useEffect(() => {
    if (!anchorRef.current) return;
    if (anchorApiRef.current) anchorApiRef.current.remove();

    const chart = createChart(anchorRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: anchorRef.current.clientWidth,
      height: 160,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    anchorApiRef.current = chart;

    if (result.anchoring.rollingRatio.length > 0) {
      const series = chart.addSeries(LineSeries, {
        color: "#2563eb",
        lineWidth: 1,
        title: "52週高値比率",
      });
      series.setData(
        result.anchoring.rollingRatio.map(d => ({
          time: d.time as Time,
          value: d.ratio * 100,
        }))
      );
      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver(() => {
      if (anchorRef.current) chart.applyOptions({ width: anchorRef.current.clientWidth });
    });
    ro.observe(anchorRef.current);
    return () => { ro.disconnect(); chart.remove(); };
  }, [result]);

  const mom = result.momentum;
  const anch = result.anchoring;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        行動ファイナンス（モメンタム / アンカリング）
      </h3>

      {/* モメンタム効果テーブル */}
      <div className="mb-4">
        <div className="text-xs font-medium text-gray-600 mb-1">モメンタム/リバーサル効果</div>
        {mom.periods.length > 0 ? (
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr className="border-b">
                <th className="text-left py-1 text-gray-500">ルックバック</th>
                <th className="text-right py-1 text-gray-500">WML平均</th>
                <th className="text-right py-1 text-gray-500">勝率</th>
                <th className="text-right py-1 text-gray-500">t値</th>
                <th className="text-right py-1 text-gray-500">現在</th>
              </tr>
            </thead>
            <tbody>
              {mom.periods.map(p => (
                <tr key={p.days} className="border-b border-gray-100">
                  <td className="py-1">{p.days}日</td>
                  <td className={`text-right font-mono ${p.avgReturn > 0 ? "text-green-700" : "text-red-700"}`}>
                    {(p.avgReturn * 100).toFixed(2)}%
                  </td>
                  <td className="text-right font-mono">{(p.winRate * 100).toFixed(1)}%</td>
                  <td className={`text-right font-mono ${Math.abs(p.tStat) > 2 ? "font-semibold" : ""}`}>
                    {p.tStat.toFixed(2)}
                  </td>
                  <td className="text-right font-mono">
                    {mom.currentMomentum[`${p.days}d`] !== undefined
                      ? (mom.currentMomentum[`${p.days}d`] * 100).toFixed(1) + "%"
                      : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-xs text-gray-400">データ不足</div>
        )}
        <div className="text-xs text-gray-600 mt-1">{mom.interpretation}</div>
      </div>

      {/* アンカリング */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">52週高値比率</div>
          <div className={`font-mono text-sm font-semibold ${anch.ratio > 0.9 ? "text-green-700" : anch.ratio < 0.7 ? "text-red-700" : "text-gray-700"}`}>
            {(anch.ratio * 100).toFixed(1)}%
          </div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">高値近辺翌月</div>
          <div className="font-mono text-xs">{(anch.avgReturnNearHigh * 100).toFixed(2)}%</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">低水準時翌月</div>
          <div className="font-mono text-xs">{(anch.avgReturnFarHigh * 100).toFixed(2)}%</div>
        </div>
      </div>

      <div className="text-xs text-gray-600 mb-3">{anch.interpretation}</div>

      <div className="text-xs text-gray-500 mb-1">52週高値比率の推移 (%)</div>
      <div ref={anchorRef} />

      <AnalysisGuide title="行動ファイナンスの詳細理論">
        <p className="font-medium text-gray-700">1. モメンタム効果</p>
        <p>
          Jegadeesh-Titman(1993)が発見。過去の勝者（上昇銘柄）は将来も上昇しやすく、
          敗者（下落銘柄）は下落しやすい傾向。3-12ヶ月で最も顕著。
          {"WML = Winner平均リターン - Loser平均リターン"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. リバーサル効果</p>
        <p>
          短期（1-4週間）では逆に「直近の上昇銘柄が下落する」リバーサルが起きることがあります。
          これはマイクロストラクチャー（ビッドアスクバウンス）や過剰反応の修正によるものです。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. アンカリング効果</p>
        <p>
          George-Hwang(2004)が発見。52週高値が投資家の心理的なアンカー（基準点）として機能。
          高値に近い銘柄は「高すぎる」と感じて買い控え → 過小反応 → その後上昇する傾向。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>WML {">"} 0かつt値 {">"} 2 → 統計的に有意なモメンタム効果</li>
          <li>WML {"<"} 0 → リバーサル効果（逆張りが有効）</li>
          <li>52週比率 {">"} 90% → アンカリングによる過小反応の可能性</li>
          <li>52週比率 {"<"} 70% → 大幅下落後。リバウンドか更なる下落かは別途判断</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>個別銘柄のモメンタムは市場全体より不安定</li>
          <li>モメンタム効果はクラッシュリスクを伴う（モメンタムクラッシュ）</li>
          <li>取引コスト・税金を考慮すると実際の利益は縮小する</li>
          <li>過去のパターンが将来も続く保証はない</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
