"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  LineSeries,
  CandlestickSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeOBV,
  computeVWAP,
  detectOBVDivergence,
} from "../../lib/obv-vwap";
import { setInitialVisibleRange } from "../../lib/chart-visible-range";
import type { PeriodKey } from "../../hooks/useAnalysisData";
import GuideEntryPanel from "./GuideEntryPanel";
import { CHART_COLORS, CANDLESTICK_OPTIONS, CANDLESTICK_LEGEND } from "../../lib/chart-colors";
import { useAnalysisResultSummary } from "./AccordionSection";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

export default function OBVVWAPChart({ prices, period }: Props) {
  const priceChartRef = useRef<HTMLDivElement>(null);
  const obvChartRef = useRef<HTMLDivElement>(null);
  const priceChartApi = useRef<IChartApi | null>(null);
  const obvChartApi = useRef<IChartApi | null>(null);

  const obvData = computeOBV(prices);
  const vwapData = computeVWAP(prices);
  const divergence = detectOBVDivergence(prices, obvData);

  const latestVWAP = vwapData.at(-1);
  const latestOBV = obvData.at(-1);
  const latestPrice = prices.at(-1);
  useAnalysisResultSummary(
    "tech-obvvwap",
    divergence.type === "bullish"
      ? { status: "finding", direction: "up", label: "強気乖離" }
      : divergence.type === "bearish"
        ? { status: "finding", direction: "down", label: "弱気乖離" }
        : { status: "none", direction: "flat", label: "乖離なし" },
  );

  useEffect(() => {
    if (!priceChartRef.current || !obvChartRef.current) return;

    // --- Price Chart ---
    const priceChart = createChart(priceChartRef.current, {
      height: 250,
      layout: { background: { color: "#ffffff" }, textColor: "#374151" },
      grid: {
        vertLines: { color: "#f3f4f6" },
        horzLines: { color: "#f3f4f6" },
      },
      timeScale: { borderColor: "#e5e7eb" },
      rightPriceScale: { borderColor: "#e5e7eb" },
    });
    priceChartApi.current = priceChart;

    const candleSeries = priceChart.addSeries(CandlestickSeries, {
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

    const vwapSeries = priceChart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 2,
      title: "VWAP",
    });
    vwapSeries.setData(
      vwapData.map((v) => ({ time: v.time as Time, value: v.vwap }))
    );

    if (period) { setInitialVisibleRange(priceChart, prices, period); } else { priceChart.timeScale().fitContent(); }

    // --- OBV Chart ---
    const obvChart = createChart(obvChartRef.current, {
      height: 180,
      layout: { background: { color: "#ffffff" }, textColor: "#374151" },
      grid: {
        vertLines: { color: "#f3f4f6" },
        horzLines: { color: "#f3f4f6" },
      },
      timeScale: { borderColor: "#e5e7eb" },
      rightPriceScale: { borderColor: "#e5e7eb" },
    });
    obvChartApi.current = obvChart;

    const obvSeries = obvChart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      title: "OBV",
    });
    obvSeries.setData(
      obvData.map((o) => ({ time: o.time as Time, value: o.obv }))
    );

    const obvMASeries = obvChart.addSeries(LineSeries, {
      color: CHART_COLORS.neutral,
      lineWidth: 1,
      title: "OBV MA20",
    });
    obvMASeries.setData(
      obvData.map((o) => ({ time: o.time as Time, value: o.obvMA }))
    );

    if (period) { setInitialVisibleRange(obvChart, prices, period); } else { obvChart.timeScale().fitContent(); }

    // --- Resize handler ---
    const handleResize = () => {
      if (priceChartRef.current) {
        priceChart.applyOptions({
          width: priceChartRef.current.clientWidth,
        });
      }
      if (obvChartRef.current) {
        obvChart.applyOptions({
          width: obvChartRef.current.clientWidth,
        });
      }
    };

    window.addEventListener("resize", handleResize);
    handleResize();

    return () => {
      window.removeEventListener("resize", handleResize);
      priceChart.remove();
      obvChart.remove();
      priceChartApi.current = null;
      obvChartApi.current = null;
    };
  }, [prices, obvData, vwapData, period]);

  const obvVsMA =
    latestOBV && latestOBV.obv > latestOBV.obvMA
      ? { label: "MA上回り", className: "text-green-700" }
      : { label: "MA下回り", className: "text-red-600" };

  return (
    <div className="space-y-3">
      {/* Divergence Alert */}
      {divergence.type !== null && (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            divergence.type === "bullish"
              ? "bg-green-50 border-green-300 text-green-800"
              : "bg-red-50 border-red-300 text-red-800"
          }`}
        >
          <span className="font-semibold mr-2">
            {divergence.type === "bullish" ? "強気シグナル" : "弱気シグナル"}
          </span>
          {divergence.message}
        </div>
      )}

      {/* Current Values Grid */}
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="bg-purple-50 rounded-md px-3 py-2">
          <div className="text-xs text-gray-500 mb-0.5">VWAP</div>
          <div className="font-semibold text-purple-700">
            {latestVWAP ? latestVWAP.vwap.toFixed(2) : "—"}
          </div>
          {latestVWAP && latestPrice && (
            <div
              className={`text-xs mt-0.5 ${
                latestPrice.close >= latestVWAP.vwap
                  ? "text-green-700"
                  : "text-red-600"
              }`}
            >
              {latestPrice.close >= latestVWAP.vwap ? "価格 > VWAP" : "価格 < VWAP"}
            </div>
          )}
        </div>

        <div className="bg-blue-50 rounded-md px-3 py-2">
          <div className="text-xs text-gray-500 mb-0.5">OBV</div>
          <div className="font-semibold text-blue-700">
            {latestOBV
              ? latestOBV.obv >= 0
                ? `+${latestOBV.obv.toLocaleString()}`
                : latestOBV.obv.toLocaleString()
              : "—"}
          </div>
        </div>

        <div className="bg-gray-50 rounded-md px-3 py-2">
          <div className="text-xs text-gray-500 mb-0.5">OBV vs MA20</div>
          <div className={`font-semibold ${obvVsMA.className}`}>
            {obvVsMA.label}
          </div>
          {latestOBV && (
            <div className="text-xs text-fg-muted mt-0.5">
              MA: {latestOBV.obvMA.toFixed(0)}
            </div>
          )}
        </div>
      </div>

      {/* Price + VWAP Chart */}
      <div>
        <div className="text-xs text-gray-500 mb-1 font-medium">
          価格 / VWAP
        </div>
        <div ref={priceChartRef} className="w-full rounded border border-gray-100" />
        <p className="mt-1 text-[11px] text-fg-muted">{CANDLESTICK_LEGEND}</p>
      </div>

      {/* OBV Chart */}
      <div>
        <div className="text-xs text-gray-500 mb-1 font-medium">
          OBV / OBV MA20
        </div>
        <div ref={obvChartRef} className="w-full rounded border border-gray-100" />
      </div>

      {/* Analysis Guide */}
      {/* 解説本文は app/lib/analysis-guides.ts の唯一のソースから描く。
          ここに散文を書き戻すと /guide/obv-vwap と二重管理になる。 */}
      <GuideEntryPanel slug="obv-vwap" title="OBV・VWAPの見方" />
    </div>
  );
}
