"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { analyzeVolume, detectVolumeSurges, type VolumeSurge } from "../../lib/volume-analysis";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function VolumeAnalysis({ prices }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const volumeBars = analyzeVolume(prices);
  const surges = detectVolumeSurges(volumeBars, 2.0);

  useEffect(() => {
    if (!containerRef.current || prices.length === 0) return;

    if (chartRef.current) {
      chartRef.current.remove();
    }

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: {
        vertLines: { color: "#f0f0f0" },
        horzLines: { color: "#f0f0f0" },
      },
      width: containerRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      leftPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    // 出来高ヒストグラム
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "right",
    });
    volumeSeries.setData(
      volumeBars.map((bar) => ({
        time: bar.time as Time,
        value: bar.volume,
        color:
          bar.ratio >= 2.0
            ? "rgba(255, 152, 0, 0.8)"
            : bar.type === "up"
            ? "rgba(38, 166, 154, 0.5)"
            : bar.type === "down"
            ? "rgba(239, 83, 80, 0.5)"
            : "rgba(158, 158, 158, 0.5)",
      }))
    );

    // 出来高移動平均線
    const avgSeries = chart.addSeries(LineSeries, {
      color: "#ff9800",
      lineWidth: 1,
      priceScaleId: "right",
    });
    avgSeries.setData(
      volumeBars.map((bar) => ({
        time: bar.time as Time,
        value: bar.avgVolume,
      }))
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [prices]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">出来高分析</h3>
      <div ref={containerRef} className="w-full rounded border border-gray-100" />

      {surges.length > 0 && (
        <div className="mt-3">
          <h4 className="text-sm font-medium text-gray-700 mb-2">
            出来高急増 (平均の2倍以上): {surges.length}件
          </h4>
          <div className="max-h-40 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b">
                  <th className="text-left py-1">日付</th>
                  <th className="text-right py-1">出来高</th>
                  <th className="text-right py-1">倍率</th>
                  <th className="text-right py-1">価格変動</th>
                </tr>
              </thead>
              <tbody>
                {surges.slice(-10).reverse().map((s) => (
                  <tr key={s.time} className="border-b border-gray-50">
                    <td className="py-1">{s.time}</td>
                    <td className="text-right">{(s.volume / 1000).toFixed(0)}K</td>
                    <td className="text-right font-medium text-orange-600">
                      {s.ratio.toFixed(1)}x
                    </td>
                    <td
                      className={`text-right ${
                        s.priceChange > 0
                          ? "text-green-600"
                          : s.priceChange < 0
                          ? "text-red-600"
                          : "text-gray-400"
                      }`}
                    >
                      {s.priceChange > 0 ? "+" : ""}
                      {s.priceChange.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-2 flex gap-3 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: "rgba(255, 152, 0, 0.8)" }} />
          急増
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: "rgba(38, 166, 154, 0.5)" }} />
          上昇日
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: "rgba(239, 83, 80, 0.5)" }} />
          下落日
        </span>
      </div>

      <AnalysisGuide title="出来高分析の読み方">
        <p><span className="font-medium">出来高(Volume)とは:</span> 一定期間に取引された株数です。価格が「何が起きたか」を示すのに対し、出来高は「どれだけの参加者がその動きに関与したか」を示します。</p>
        <p><span className="font-medium">20日移動平均線(オレンジ線):</span> 出来高の直近20営業日の平均です。これを基準に、当日の出来高が「普段より多いか少ないか」を判断します。</p>
        <p><span className="font-medium">出来高急増(2倍以上)の意味:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">上昇+出来高急増:</span> 機関投資家の大口買い、または重要なレジスタンスのブレイクアウト。トレンド転換や加速のシグナルになりやすい。</li>
          <li><span className="font-medium">下落+出来高急増:</span> パニック売りまたは機関の大口売り。ただし「セリングクライマックス」(売りの最終段階)で底打ちのシグナルになることも。</li>
          <li><span className="font-medium">横ばい+出来高急増:</span> 買いと売りが拮抗。大きな動きの前兆である可能性。</li>
        </ul>
        <p><span className="font-medium">出来高が低い状態が続く場合:</span> 市場参加者の関心が薄い。この状態からの出来高急増は、新たなトレンドの始まりを示唆することが多い。</p>
        <p><span className="font-medium">価格と出来高の乖離(ダイバージェンス):</span> 価格は上昇しているのに出来高が減少している場合、上昇トレンドの勢いが弱まっている可能性があります。逆に価格下落中に出来高が減少していれば、売り圧力が弱まっているサインです。</p>
        <p><span className="font-medium">倍率の目安:</span> 2倍以上は「注目すべき」、3倍以上は「異常値」、5倍以上は「何らかの重大イベント」を示唆します。</p>
      </AnalysisGuide>
    </div>
  );
}
