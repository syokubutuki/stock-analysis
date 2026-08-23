"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  CandlestickSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeStochastics, detectStochSignals } from "../../lib/stochastics";
import { setInitialVisibleRange } from "../../lib/chart-visible-range";
import type { PeriodKey } from "../../hooks/useAnalysisData";
import GuideEntryPanel from "./GuideEntryPanel";
import { CANDLESTICK_OPTIONS, CANDLESTICK_LEGEND } from "../../lib/chart-colors";
import { useAnalysisResultSummary } from "./AccordionSection";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

export default function StochasticsChart({ prices, period }: Props) {
  const upperRef = useRef<HTMLDivElement>(null);
  const lowerRef = useRef<HTMLDivElement>(null);
  const upperApiRef = useRef<IChartApi | null>(null);
  const lowerApiRef = useRef<IChartApi | null>(null);

  const stochPoints = useMemo(() => computeStochastics(prices), [prices]);
  const signals = useMemo(() => detectStochSignals(stochPoints), [stochPoints]);
  const last = stochPoints.length > 0 ? stochPoints[stochPoints.length - 1] : null;
  const primarySignal = signals.find((signal) => signal.type !== "info");
  useAnalysisResultSummary(
    "tech-stoch",
    primarySignal
      ? {
          status: "finding",
          direction: primarySignal.type === "buy" ? "up" : "down",
          label: primarySignal.type === "buy" ? "買い所見" : "売り所見",
        }
      : last && last.slowK <= 20
        ? { status: "finding", direction: "up", label: "売られすぎ" }
        : last && last.slowK >= 80
          ? { status: "finding", direction: "down", label: "買われすぎ" }
          : { status: "none", direction: "flat", label: "中立ゾーン" },
  );

  useEffect(() => {
    if (!upperRef.current || !lowerRef.current) return;

    // Cleanup previous instances
    if (upperApiRef.current) {
      upperApiRef.current.remove();
      upperApiRef.current = null;
    }
    if (lowerApiRef.current) {
      lowerApiRef.current.remove();
      lowerApiRef.current = null;
    }

    const sharedOptions = {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    };

    // Upper chart: candlestick
    const upperChart = createChart(upperRef.current, {
      ...sharedOptions,
      width: upperRef.current.clientWidth,
      height: 220,
    });
    upperApiRef.current = upperChart;

    const candleSeries = upperChart.addSeries(CandlestickSeries, {
      ...CANDLESTICK_OPTIONS,
    });
    candleSeries.setData(
      prices.map((p) => ({
        time: p.time as Time,
        open: p.open,
        high: p.high,
        low: p.low,
        close: p.close,
      }))
    );
    if (period) { setInitialVisibleRange(upperChart, prices, period); } else { upperChart.timeScale().fitContent(); }

    // Lower chart: stochastics
    const lowerChart = createChart(lowerRef.current, {
      ...sharedOptions,
      width: lowerRef.current.clientWidth,
      height: 180,
    });
    lowerApiRef.current = lowerChart;

    if (stochPoints.length > 0) {
      // Slow %K
      const slowKSeries = lowerChart.addSeries(LineSeries, {
        color: "#3b82f6",
        lineWidth: 2,
        title: "Slow %K",
      });
      slowKSeries.setData(
        stochPoints.map((p) => ({ time: p.time as Time, value: p.slowK }))
      );

      // Slow %D
      const slowDSeries = lowerChart.addSeries(LineSeries, {
        color: "#f59e0b",
        lineWidth: 1,
        title: "Slow %D",
      });
      slowDSeries.setData(
        stochPoints.map((p) => ({ time: p.time as Time, value: p.slowD }))
      );

      // 80 reference line
      const line80 = lowerChart.addSeries(LineSeries, {
        color: "rgba(239, 68, 68, 0.35)",
        lineWidth: 1,
        lineStyle: 2,
        title: "80",
      });
      line80.setData(
        stochPoints.map((p) => ({ time: p.time as Time, value: 80 }))
      );

      // 20 reference line
      const line20 = lowerChart.addSeries(LineSeries, {
        color: "rgba(34, 197, 94, 0.35)",
        lineWidth: 1,
        lineStyle: 2,
        title: "20",
      });
      line20.setData(
        stochPoints.map((p) => ({ time: p.time as Time, value: 20 }))
      );

      if (period) { setInitialVisibleRange(lowerChart, prices, period); } else { lowerChart.timeScale().fitContent(); }
    }

    const handleResize = () => {
      if (upperRef.current)
        upperChart.applyOptions({ width: upperRef.current.clientWidth });
      if (lowerRef.current)
        lowerChart.applyOptions({ width: lowerRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      upperChart.remove();
      lowerChart.remove();
      upperApiRef.current = null;
      lowerApiRef.current = null;
    };
  }, [prices, stochPoints, period]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">ストキャスティクス</h3>

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
              <span>{s.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Current values grid */}
      {last && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">Fast %K</div>
            <div
              className={`font-mono font-medium ${
                last.fastK > 80
                  ? "text-red-600"
                  : last.fastK < 20
                  ? "text-green-700"
                  : ""
              }`}
            >
              {last.fastK.toFixed(1)}
            </div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">Fast %D</div>
            <div
              className={`font-mono font-medium ${
                last.fastD > 80
                  ? "text-red-600"
                  : last.fastD < 20
                  ? "text-green-700"
                  : ""
              }`}
            >
              {last.fastD.toFixed(1)}
            </div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">Slow %K</div>
            <div
              className={`font-mono font-medium ${
                last.slowK > 80
                  ? "text-red-600"
                  : last.slowK < 20
                  ? "text-green-700"
                  : ""
              }`}
            >
              {last.slowK.toFixed(1)}
            </div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">Slow %D</div>
            <div
              className={`font-mono font-medium ${
                last.slowD > 80
                  ? "text-red-600"
                  : last.slowD < 20
                  ? "text-green-700"
                  : ""
              }`}
            >
              {last.slowD.toFixed(1)}
            </div>
          </div>
        </div>
      )}

      {/* Upper chart: candlestick */}
      <div ref={upperRef} className="w-full rounded border border-gray-100 mb-1" />
      <p className="mt-1 text-[11px] text-fg-muted">{CANDLESTICK_LEGEND}</p>

      {/* Lower chart: stochastics */}
      <div ref={lowerRef} className="w-full rounded border border-gray-100" />

      {/* 解説本文は app/lib/analysis-guides.ts の唯一のソースから描く。
          ここに散文を書き戻すと /guide/stochastics と二重管理になる。 */}
      <GuideEntryPanel slug="stochastics" title="ストキャスティクスの読み方" />
    </div>
  );
}
