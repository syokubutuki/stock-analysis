"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeRSI,
  computeMACD,
  computeBollinger,
  detectSignals,
} from "../../lib/technical-indicators";
import { setInitialVisibleRange } from "../../lib/chart-visible-range";
import type { PeriodKey } from "../../hooks/useAnalysisData";
import GuideEntryPanel from "./GuideEntryPanel";
import DirectionValue from "./DirectionValue";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

type IndicatorTab = "rsi" | "macd" | "bollinger";

export default function TechnicalIndicators({ prices, period }: Props) {
  const [tab, setTab] = useState<IndicatorTab>("rsi");
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);

  const rsi = useMemo(() => computeRSI(prices, 14), [prices]);
  const macd = useMemo(() => computeMACD(prices), [prices]);
  const bollinger = useMemo(() => computeBollinger(prices, 20, 2), [prices]);
  const signals = useMemo(
    () => detectSignals(prices, rsi, macd, bollinger),
    [prices, rsi, macd, bollinger]
  );

  useEffect(() => {
    if (!chartRef.current) return;
    if (apiRef.current) apiRef.current.remove();

    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 280,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;

    if (tab === "rsi" && rsi.length > 0) {
      const series = chart.addSeries(LineSeries, {
        color: "#8b5cf6",
        lineWidth: 2,
        title: "RSI (14)",
      });
      series.setData(
        rsi.map((r) => ({ time: r.time as Time, value: r.value }))
      );

      // 70/30 lines using additional series
      const line70 = chart.addSeries(LineSeries, {
        color: "rgba(239, 68, 68, 0.4)",
        lineWidth: 1,
        lineStyle: 2,
        title: "70",
      });
      line70.setData(
        rsi.map((r) => ({ time: r.time as Time, value: 70 }))
      );

      const line30 = chart.addSeries(LineSeries, {
        color: "rgba(34, 197, 94, 0.4)",
        lineWidth: 1,
        lineStyle: 2,
        title: "30",
      });
      line30.setData(
        rsi.map((r) => ({ time: r.time as Time, value: 30 }))
      );
    }

    if (tab === "macd" && macd.length > 0) {
      const macdSeries = chart.addSeries(LineSeries, {
        color: "#3b82f6",
        lineWidth: 2,
        title: "MACD",
      });
      macdSeries.setData(
        macd.map((m) => ({ time: m.time as Time, value: m.macd }))
      );

      const signalSeries = chart.addSeries(LineSeries, {
        color: "#f59e0b",
        lineWidth: 1,
        title: "Signal",
      });
      signalSeries.setData(
        macd.map((m) => ({ time: m.time as Time, value: m.signal }))
      );

      const histSeries = chart.addSeries(HistogramSeries, {
        title: "Histogram",
      });
      histSeries.setData(
        macd.map((m) => ({
          time: m.time as Time,
          value: m.histogram,
          color:
            m.histogram >= 0
              ? "rgba(38, 166, 154, 0.5)"
              : "rgba(239, 83, 80, 0.5)",
        }))
      );
    }

    if (tab === "bollinger" && bollinger.length > 0) {
      const upperSeries = chart.addSeries(LineSeries, {
        color: "rgba(239, 68, 68, 0.6)",
        lineWidth: 1,
        title: "Upper Band",
      });
      upperSeries.setData(
        bollinger.map((b) => ({ time: b.time as Time, value: b.upper }))
      );

      const middleSeries = chart.addSeries(LineSeries, {
        color: "#6b7280",
        lineWidth: 1,
        title: "SMA(20)",
      });
      middleSeries.setData(
        bollinger.map((b) => ({ time: b.time as Time, value: b.middle }))
      );

      const lowerSeries = chart.addSeries(LineSeries, {
        color: "rgba(34, 197, 94, 0.6)",
        lineWidth: 1,
        title: "Lower Band",
      });
      lowerSeries.setData(
        bollinger.map((b) => ({ time: b.time as Time, value: b.lower }))
      );

      const closeSeries = chart.addSeries(LineSeries, {
        color: "#1e293b",
        lineWidth: 2,
        title: "Close",
      });
      closeSeries.setData(
        bollinger.map((b) => ({ time: b.time as Time, value: b.close }))
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
  }, [tab, rsi, macd, bollinger, prices, period]);

  // Current values
  const lastRSI = rsi.length > 0 ? rsi[rsi.length - 1].value : null;
  const lastMACD = macd.length > 0 ? macd[macd.length - 1] : null;
  const lastBB = bollinger.length > 0 ? bollinger[bollinger.length - 1] : null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">テクニカル指標</h3>
        <div className="flex gap-1">
          {([
            ["rsi", "RSI"],
            ["macd", "MACD"],
            ["bollinger", "ボリンジャー"],
          ] as [IndicatorTab, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                tab === key
                  ? "bg-violet-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Signal alerts */}
      {signals.length > 0 && (
        <div className="mb-3 space-y-1">
          {signals.map((s, i) => (
            <div
              key={i}
              className={`text-xs px-3 py-1.5 rounded flex items-center gap-2 ${
                s.type === "buy"
                  ? "bg-green-50 text-green-700 border border-green-200"
                  : s.type === "sell"
                  ? "bg-red-50 text-red-700 border border-red-200"
                  : "bg-blue-50 text-blue-700 border border-blue-200"
              }`}
            >
              <span className="font-bold">
                {s.type === "buy" ? "BUY" : s.type === "sell" ? "SELL" : "INFO"}
              </span>
              <span className="font-medium">[{s.indicator}]</span>
              <span>{s.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Current values */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
        {lastRSI !== null && (
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">RSI (14)</div>
            <div className={`font-mono font-medium ${
              lastRSI > 70 ? "text-red-600" : lastRSI < 30 ? "text-green-700" : ""
            }`}>
              {lastRSI.toFixed(1)}
            </div>
          </div>
        )}
        {lastMACD && (
          <>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">MACD</div>
              <div className="font-mono font-medium">
                <DirectionValue value={lastMACD.macd}>{lastMACD.macd.toFixed(2)}</DirectionValue>
              </div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">MACD Histogram</div>
              <div className="font-mono font-medium">
                <DirectionValue value={lastMACD.histogram}>{lastMACD.histogram.toFixed(2)}</DirectionValue>
              </div>
            </div>
          </>
        )}
        {lastBB && (
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">%B</div>
            <div className={`font-mono font-medium ${
              lastBB.percentB > 1 ? "text-red-600" : lastBB.percentB < 0 ? "text-green-700" : ""
            }`}>
              {(lastBB.percentB * 100).toFixed(1)}%
            </div>
            <div className="text-fg-muted">帯域幅: {(lastBB.bandwidth * 100).toFixed(1)}%</div>
          </div>
        )}
      </div>

      <div ref={chartRef} className="w-full rounded border border-gray-100" />

      {/* 解説本文は app/lib/analysis-guides.ts の唯一のソースから描く。
          ここに散文を書き戻すと /guide/technical-indicators と二重管理になる。 */}
      <GuideEntryPanel slug="technical-indicators" title="テクニカル指標の読み方" />
    </div>
  );
}
