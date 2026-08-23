"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { extraTechnical } from "../../lib/extra-technical";
import GuideEntryPanel from "./GuideEntryPanel";
import { useAnalysisResultSummary } from "./AccordionSection";

interface Props {
  prices: PricePoint[];
}

export default function ExtraTechnicalChart({ prices }: Props) {
  const cciRef = useRef<HTMLDivElement>(null);
  const wrRef = useRef<HTMLDivElement>(null);
  const cciApiRef = useRef<IChartApi | null>(null);
  const wrApiRef = useRef<IChartApi | null>(null);

  const result = useMemo(() => extraTechnical(prices), [prices]);
  useAnalysisResultSummary(
    "tech-extra",
    result.cci.current > 100 || result.williamsR.current > -20
      ? { status: "finding", direction: "down", label: "買われすぎ" }
      : result.cci.current < -100 || result.williamsR.current < -80
        ? { status: "finding", direction: "up", label: "売られすぎ" }
        : { status: "none", direction: "flat", label: "中立ゾーン" },
  );

  // CCI chart
  useEffect(() => {
    if (!cciRef.current) return;
    if (cciApiRef.current) cciApiRef.current.remove();

    const chart = createChart(cciRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: cciRef.current.clientWidth,
      height: 150,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    cciApiRef.current = chart;

    if (result.cci.values.length > 0) {
      const series = chart.addSeries(LineSeries, {
        color: "#2563eb",
        lineWidth: 1,
        title: "CCI(20)",
      });
      series.setData(
        result.cci.values.map(d => ({ time: d.time as Time, value: d.value }))
      );
      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver(() => {
      if (cciRef.current) chart.applyOptions({ width: cciRef.current.clientWidth });
    });
    ro.observe(cciRef.current);
    return () => { ro.disconnect(); chart.remove(); cciApiRef.current = null; };
  }, [result]);

  // Williams %R chart
  useEffect(() => {
    if (!wrRef.current) return;
    if (wrApiRef.current) wrApiRef.current.remove();

    const chart = createChart(wrRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: wrRef.current.clientWidth,
      height: 150,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    wrApiRef.current = chart;

    if (result.williamsR.values.length > 0) {
      const series = chart.addSeries(LineSeries, {
        color: "#059669",
        lineWidth: 1,
        title: "%R(14)",
      });
      series.setData(
        result.williamsR.values.map(d => ({ time: d.time as Time, value: d.value }))
      );
      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver(() => {
      if (wrRef.current) chart.applyOptions({ width: wrRef.current.clientWidth });
    });
    ro.observe(wrRef.current);
    return () => { ro.disconnect(); chart.remove(); wrApiRef.current = null; };
  }, [result]);

  const sarTrend = result.sar.currentTrend;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        追加テクニカル (SAR / CCI / %R)
      </h3>

      {/* SAR summary */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className={`border rounded p-2 text-center ${sarTrend === "up" ? "bg-green-50" : "bg-red-50"}`}>
          <div className="text-xs text-gray-500">Parabolic SAR</div>
          <div className={`font-semibold text-sm ${sarTrend === "up" ? "text-green-700" : "text-red-700"}`}>
            {sarTrend === "up" ? "上昇トレンド" : "下降トレンド"}
          </div>
        </div>
        <div className={`border rounded p-2 text-center ${result.cci.current > 100 ? "bg-red-50" : result.cci.current < -100 ? "bg-green-50" : ""}`}>
          <div className="text-xs text-gray-500">CCI(20)</div>
          <div className="font-mono text-sm font-semibold">{result.cci.current.toFixed(1)}</div>
        </div>
        <div className={`border rounded p-2 text-center ${result.williamsR.current > -20 ? "bg-red-50" : result.williamsR.current < -80 ? "bg-green-50" : ""}`}>
          <div className="text-xs text-gray-500">%R(14)</div>
          <div className="font-mono text-sm font-semibold">{result.williamsR.current.toFixed(1)}</div>
        </div>
      </div>

      <div className="text-xs text-gray-600 mb-2">{result.sar.interpretation}</div>

      <div className="text-xs text-gray-500 mb-1">CCI (Commodity Channel Index)</div>
      <div ref={cciRef} />

      <div className="text-xs text-gray-500 mb-1 mt-3">Williams %R</div>
      <div ref={wrRef} />

      {/* 解説本文は app/lib/analysis-guides.ts の唯一のソースから描く。
          ここに散文を書き戻すと /guide/extra-technical と二重管理になる。 */}
      <GuideEntryPanel slug="extra-technical" title="追加テクニカル指標の詳細理論" />
    </div>
  );
}
