"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  CandlestickSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { detectSupportResistance } from "../../lib/support-resistance";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function SupportResistanceChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);

  const levels = useMemo(
    () => detectSupportResistance(prices, 8),
    [prices]
  );

  useEffect(() => {
    if (!chartRef.current || prices.length < 20) return;
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

    // Draw support/resistance lines
    for (const level of levels) {
      candle.createPriceLine({
        price: level.price,
        color: level.type === "resistance" ? "rgba(239, 68, 68, 0.6)" : "rgba(34, 197, 94, 0.6)",
        lineWidth: level.strength > 60 ? 2 : 1,
        lineStyle: level.strength > 40 ? 0 : 2,
        axisLabelVisible: true,
        title: `${level.type === "resistance" ? "R" : "S"} (${level.touches})`,
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
  }, [prices, levels]);

  const currentPrice = prices.length > 0 ? prices[prices.length - 1].close : 0;
  const nearestSupport = levels.filter((l) => l.type === "support").sort((a, b) => b.price - a.price)[0];
  const nearestResistance = levels.filter((l) => l.type === "resistance").sort((a, b) => a.price - b.price)[0];

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">支持線・抵抗線</h3>

      {nearestSupport && nearestResistance && (
        <div className="grid grid-cols-2 gap-2 text-xs mb-3">
          <div className="p-2 bg-green-50 rounded border border-green-100">
            <div className="text-gray-500">直近支持線</div>
            <div className="font-mono font-bold text-green-600">
              {nearestSupport.price.toLocaleString()}
            </div>
            <div className="text-gray-400">
              {nearestSupport.distancePercent.toFixed(1)}% / {nearestSupport.touches}回タッチ
            </div>
          </div>
          <div className="p-2 bg-red-50 rounded border border-red-100">
            <div className="text-gray-500">直近抵抗線</div>
            <div className="font-mono font-bold text-red-600">
              {nearestResistance.price.toLocaleString()}
            </div>
            <div className="text-gray-400">
              +{nearestResistance.distancePercent.toFixed(1)}% / {nearestResistance.touches}回タッチ
            </div>
          </div>
        </div>
      )}

      <div ref={chartRef} className="w-full rounded border border-gray-100 mb-3" />

      {/* Level table */}
      {levels.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-1.5 pr-2 text-gray-500 font-medium">タイプ</th>
                <th className="text-right py-1.5 px-2 text-gray-500 font-medium">価格</th>
                <th className="text-right py-1.5 px-2 text-gray-500 font-medium">距離</th>
                <th className="text-right py-1.5 px-2 text-gray-500 font-medium">タッチ</th>
                <th className="text-right py-1.5 px-2 text-gray-500 font-medium">強度</th>
                <th className="text-right py-1.5 pl-2 text-gray-500 font-medium">最終タッチ</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((l, i) => (
                <tr key={i} className="border-b border-gray-50">
                  <td className="py-1.5 pr-2">
                    <span className={`font-medium ${l.type === "resistance" ? "text-red-600" : "text-green-600"}`}>
                      {l.type === "resistance" ? "抵抗線" : "支持線"}
                    </span>
                  </td>
                  <td className="text-right py-1.5 px-2 font-mono">{l.price.toLocaleString()}</td>
                  <td className="text-right py-1.5 px-2 font-mono">
                    {l.distancePercent >= 0 ? "+" : ""}{l.distancePercent.toFixed(1)}%
                  </td>
                  <td className="text-right py-1.5 px-2 font-mono">{l.touches}回</td>
                  <td className="text-right py-1.5 px-2">
                    <div className="flex items-center justify-end gap-1">
                      <div className="w-12 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${l.type === "resistance" ? "bg-red-400" : "bg-green-400"}`}
                          style={{ width: `${l.strength}%` }}
                        />
                      </div>
                      <span className="text-gray-500 w-6 text-right">{l.strength}</span>
                    </div>
                  </td>
                  <td className="text-right py-1.5 pl-2 font-mono text-gray-500">{l.lastTouch}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AnalysisGuide title="支持線・抵抗線の読み方">
        <p><span className="font-medium">支持線 (Support):</span> 株価が下落した際に反発しやすい価格帯。過去に複数回安値をつけた水準。</p>
        <p><span className="font-medium">抵抗線 (Resistance):</span> 株価が上昇した際に反落しやすい価格帯。過去に複数回高値をつけた水準。</p>
        <p><span className="font-medium">検出方法:</span> 局所的な高値/安値（ピボットポイント）を検出し、近い価格帯をクラスタリング。タッチ回数が多いほど信頼性が高い。</p>
        <p><span className="font-medium">強度:</span> タッチ回数と最近のタッチほど高く評価。強い支持/抵抗線ほど突破が困難だが、一度突破されると大きな動きにつながりやすい。</p>
        <p><span className="font-medium">ロールリバーサル:</span> 支持線を下に突破すると抵抗線に、抵抗線を上に突破すると支持線に転換することが多い。</p>
      </AnalysisGuide>
    </div>
  );
}
