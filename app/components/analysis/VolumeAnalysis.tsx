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
import GuideEntryPanel from "./GuideEntryPanel";
import { setInitialVisibleRange } from "../../lib/chart-visible-range";
import type { PeriodKey } from "../../hooks/useAnalysisData";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

export default function VolumeAnalysis({ prices, period }: Props) {
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

    if (period) { setInitialVisibleRange(chart, prices, period); } else { chart.timeScale().fitContent(); }

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
                          : "text-fg-muted"
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

      {/* 解説本文は app/lib/analysis-guides.ts の唯一のソースから描く。
          ここに散文を書き戻すと /guide/volume-analysis と二重管理になる。 */}
      <GuideEntryPanel slug="volume-analysis" title="出来高分析の読み方" />
    </div>
  );
}
