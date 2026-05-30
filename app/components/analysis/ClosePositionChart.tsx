"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeClosePosition } from "../../lib/ohlc-extended";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; }

export default function ClosePositionChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const result = useMemo(() => computeClosePosition(prices), [prices]);

  useEffect(() => {
    if (!chartRef.current || result.dates.length === 0) return;
    const chart = createChart(chartRef.current, {
      width: chartRef.current.clientWidth, height: 280,
      layout: { textColor: "#374151", fontSize: 11 },
      grid: { vertLines: { color: "#f3f4f6" }, horzLines: { color: "#f3f4f6" } },
      rightPriceScale: { borderColor: "#e5e7eb" }, timeScale: { borderColor: "#e5e7eb" },
    });
    apiRef.current = chart;

    const cpSeries = chart.addSeries(LineSeries, { color: "#94a3b8", lineWidth: 1, title: "Close Position" });
    const avgSeries = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 2, title: "20日平均" });

    cpSeries.setData(result.dates.map((t, i) => ({ time: t as Time, value: result.closePosition[i] })));
    avgSeries.setData(result.dates.map((t, i) => ({ time: t as Time, value: result.rollingAvg[i] })).filter(d => d.value > 0));
    chart.timeScale().fitContent();

    const h = () => { if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth }); };
    window.addEventListener("resize", h);
    return () => { window.removeEventListener("resize", h); chart.remove(); apiRef.current = null; };
  }, [result]);

  if (result.dates.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">Close Position分析 (引け方分析)</h3>
      <div ref={chartRef} />

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead><tr className="border-b border-gray-200">
            <th className="py-1 px-2 text-left text-gray-500">Close Position帯</th>
            <th className="py-1 px-2 text-center text-gray-500">翌日平均リターン</th>
            <th className="py-1 px-2 text-center text-gray-500">勝率</th>
            <th className="py-1 px-2 text-center text-gray-500">n</th>
          </tr></thead>
          <tbody>
            {result.bucketReturns.map((b, i) => (
              <tr key={i} className="border-b border-gray-100">
                <td className="py-1 px-2 font-medium text-gray-700">{b.range}</td>
                <td className={`py-1 px-2 text-center font-mono ${b.avgReturn >= 0 ? "text-green-600" : "text-red-600"}`}>{(b.avgReturn * 100).toFixed(3)}%</td>
                <td className={`py-1 px-2 text-center font-mono ${b.winRate >= 0.5 ? "text-green-600" : "text-red-600"}`}>{(b.winRate * 100).toFixed(1)}%</td>
                <td className="py-1 px-2 text-center font-mono text-gray-500">{b.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AnalysisGuide title="Close Position分析の詳細理論">
        <p className="font-medium text-gray-700">1. Close Positionとは</p>
        <p>{"Close Position = (Close - Low) / (High - Low)。日中レンジ内での終値の位置を0-1で表します。0=安値引け、1=高値引け。0.5はレンジの中間で引けたことを意味します。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 20日移動平均の解釈</p>
        <p>ローリング平均が0.5より上を維持 → 継続的に高値圏で引ける傾向 → 買い圧力が優勢。逆に0.5以下は売り圧力が優勢。トレンド転換の先行指標として機能し得ます。</p>
        <p className="font-medium text-gray-700 mt-3">3. バケット別リターン</p>
        <p>Close Positionを5帯に分割し、翌日リターンとの関係を検証します。例えば「安値引けの翌日は反発しやすい（ミーンリバージョン）」or「高値引けの翌日も上昇しやすい（モメンタム）」かを判別できます。</p>
        <p className="font-medium text-gray-700 mt-3">4. 実務的活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>高値引けが連続 → 強気トレンドの確認。ただし過熱感にも注意。</li>
          <li>安値引けが連続 → 弱気トレンド。ただし売りクライマックスの反転も。</li>
          <li>Close Position 0.2以下 → 翌日反発の可能性を検証するリバージョン戦略。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
