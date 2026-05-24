"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  CandlestickSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeFibonacci } from "../../lib/fibonacci";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const RETRACE_COLORS: Record<string, string> = {
  "0.0%": "#16a34a",
  "23.6%": "#22c55e",
  "38.2%": "#84cc16",
  "50.0%": "#eab308",
  "61.8%": "#f59e0b",
  "78.6%": "#ef4444",
  "100.0%": "#dc2626",
};

export default function FibonacciChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);

  const fib = useMemo(() => computeFibonacci(prices), [prices]);

  useEffect(() => {
    if (!chartRef.current || !fib || prices.length < 10) return;
    if (apiRef.current) apiRef.current.remove();

    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 350,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderUpColor: "#26a69a",
      borderDownColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });
    candle.setData(
      prices.map((p) => ({
        time: p.time as Time,
        open: p.open, high: p.high, low: p.low, close: p.close,
      }))
    );

    // Draw fibonacci levels
    for (const level of fib.levels) {
      const color = level.isExtension
        ? "rgba(139, 92, 246, 0.5)"
        : RETRACE_COLORS[level.label] || "rgba(107, 114, 128, 0.5)";

      candle.createPriceLine({
        price: level.price,
        color,
        lineWidth: level.ratio === 0.618 || level.ratio === 0.5 ? 2 : 1,
        lineStyle: level.isExtension ? 2 : 0,
        axisLabelVisible: true,
        title: level.label,
      });
    }

    chart.timeScale().fitContent();
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
  }, [prices, fib]);

  if (!fib) return null;

  const currentPrice = prices[prices.length - 1].close;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">フィボナッチリトレースメント</h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">トレンド</div>
          <div className={`font-medium ${fib.trend === "up" ? "text-green-600" : "text-red-600"}`}>
            {fib.trend === "up" ? "上昇" : "下降"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">スイング高値</div>
          <div className="font-mono font-medium">{fib.swingHigh.price.toLocaleString()}</div>
          <div className="text-gray-400">{fib.swingHigh.time}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">スイング安値</div>
          <div className="font-mono font-medium">{fib.swingLow.price.toLocaleString()}</div>
          <div className="text-gray-400">{fib.swingLow.time}</div>
        </div>
        <div className="p-2 bg-blue-50 rounded border border-blue-100">
          <div className="text-gray-500">現在のレベル</div>
          <div className="font-medium text-blue-700">{fib.currentLevel}</div>
        </div>
      </div>

      <div ref={chartRef} className="w-full rounded border border-gray-100 mb-3" />

      {/* Level table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left py-1.5 pr-2 text-gray-500 font-medium">レベル</th>
              <th className="text-right py-1.5 px-2 text-gray-500 font-medium">価格</th>
              <th className="text-right py-1.5 px-2 text-gray-500 font-medium">現在価格からの距離</th>
              <th className="text-left py-1.5 pl-2 text-gray-500 font-medium">種別</th>
            </tr>
          </thead>
          <tbody>
            {fib.levels
              .filter((l) => !l.isExtension || Math.abs((l.price - currentPrice) / currentPrice) < 0.3)
              .sort((a, b) => b.price - a.price)
              .map((l, i) => {
                const dist = ((l.price - currentPrice) / currentPrice) * 100;
                const isNear = Math.abs(dist) < 2;
                return (
                  <tr key={i} className={`border-b border-gray-50 ${isNear ? "bg-blue-50" : ""}`}>
                    <td className="py-1.5 pr-2 font-medium">{l.label}</td>
                    <td className="text-right py-1.5 px-2 font-mono">{l.price.toLocaleString()}</td>
                    <td className={`text-right py-1.5 px-2 font-mono ${dist >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {dist >= 0 ? "+" : ""}{dist.toFixed(1)}%
                    </td>
                    <td className="py-1.5 pl-2 text-gray-500">
                      {l.isExtension ? "エクステンション" : "リトレースメント"}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      <AnalysisGuide title="フィボナッチの読み方">
        <p><span className="font-medium">フィボナッチリトレースメント:</span> スイング高値とスイング安値の間をフィボナッチ比率で分割した水準。押し目や戻りの目標値として使う。</p>
        <p><span className="font-medium">重要な比率:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">38.2%:</span> 浅い押し目。強いトレンドではここで反発することが多い。</li>
          <li><span className="font-medium">50.0%:</span> 半値押し/半値戻し。心理的な節目。</li>
          <li><span className="font-medium">61.8%:</span> 黄金比。最も重要なリトレースメント水準。ここを割ると全戻しの可能性。</li>
        </ul>
        <p><span className="font-medium">エクステンション:</span> 127.2%, 161.8%等。スイングを超えた後の目標値。ブレイクアウト後の利確ポイントとして使用。</p>
        <p><span className="font-medium">注意:</span> フィボナッチは「自己実現的予言」の側面が強く、多くのトレーダーが意識するために機能する場合がある。他のテクニカル指標との合流点（コンフルエンス）で使うと信頼性が高まる。</p>
      </AnalysisGuide>
    </div>
  );
}
