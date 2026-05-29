"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeRangeVolatility,
  compareEstimators,
} from "../../lib/range-volatility";
import AnalysisGuide from "./AnalysisGuide";
import { setInitialVisibleRange } from "../../lib/chart-visible-range";
import type { PeriodKey } from "../../hooks/useAnalysisData";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

const COLORS = {
  closeToClose: "#9ca3af",
  parkinson: "#3b82f6",
  garmanKlass: "#8b5cf6",
  rogersSatchell: "#f59e0b",
  yangZhang: "#ef4444",
};

export default function RangeVolatilityChart({ prices, period }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);

  const points = useMemo(
    () => computeRangeVolatility(prices, 20),
    [prices]
  );
  const comparison = useMemo(() => compareEstimators(points), [points]);

  useEffect(() => {
    if (!chartRef.current || points.length < 2) return;
    if (apiRef.current) apiRef.current.remove();

    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: {
        vertLines: { color: "#f0f0f0" },
        horzLines: { color: "#f0f0f0" },
      },
      width: chartRef.current.clientWidth,
      height: 250,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;

    const entries: [keyof typeof COLORS, string][] = [
      ["closeToClose", "C-to-C"],
      ["parkinson", "Parkinson"],
      ["garmanKlass", "Garman-Klass"],
      ["rogersSatchell", "Rogers-Satchell"],
      ["yangZhang", "Yang-Zhang"],
    ];

    for (const [key, title] of entries) {
      const series = chart.addSeries(LineSeries, {
        color: COLORS[key],
        lineWidth: key === "yangZhang" ? 2 : 1,
        title,
      });
      series.setData(
        points.map((p) => ({
          time: p.time as Time,
          value: p[key] * 100,
        }))
      );
    }

    if (period) { setInitialVisibleRange(chart, prices, period); } else { chart.timeScale().fitContent(); }

    const handleResize = () => {
      if (chartRef.current)
        chart.applyOptions({ width: chartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      apiRef.current = null;
    };
  }, [points, prices, period]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">
        レンジベースボラティリティ推定量 (年率, 20日窓)
      </h3>

      <div ref={chartRef} className="w-full rounded border border-gray-100 mb-3" />

      {/* 比較テーブル */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left py-1.5 pr-3 text-gray-500 font-medium">推定量</th>
              <th className="text-right py-1.5 px-3 text-gray-500 font-medium">現在値</th>
              <th className="text-right py-1.5 px-3 text-gray-500 font-medium">期間平均</th>
              <th className="text-right py-1.5 pl-3 text-gray-500 font-medium">情報効率</th>
            </tr>
          </thead>
          <tbody>
            {comparison.map((c) => (
              <tr key={c.name} className="border-b border-gray-50">
                <td className="py-1.5 pr-3 font-medium text-gray-700">{c.name}</td>
                <td className="text-right py-1.5 px-3 font-mono">
                  {(c.current * 100).toFixed(1)}%
                </td>
                <td className="text-right py-1.5 px-3 font-mono">
                  {(c.mean * 100).toFixed(1)}%
                </td>
                <td className="text-right py-1.5 pl-3 text-gray-500">
                  {c.efficiency}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AnalysisGuide title="レンジベースボラティリティの読み方">
        <p>
          <span className="font-medium">Close-to-Close:</span>{" "}
          終値のみを使う従来型。日中の値動き情報を捨てている。
        </p>
        <p>
          <span className="font-medium">Parkinson:</span>{" "}
          高値・安値を使用。Close-to-Closeの約5倍の情報効率。ただしギャップを考慮しない。
        </p>
        <p>
          <span className="font-medium">Garman-Klass:</span>{" "}
          OHLCフル活用。約7倍の情報効率。ドリフト(トレンド)がある場合にバイアスが生じる。
        </p>
        <p>
          <span className="font-medium">Rogers-Satchell:</span>{" "}
          OHLCを使い、ドリフトに依存しない推定量。トレンド相場でも正確。
        </p>
        <p>
          <span className="font-medium">Yang-Zhang:</span>{" "}
          夜間ギャップも考慮した最良の推定量。約14倍の情報効率。
          Close-to-Closeとの乖離が大きい場合、日中レンジや夜間ギャップの影響が大きいことを意味する。
        </p>
      </AnalysisGuide>
    </div>
  );
}
