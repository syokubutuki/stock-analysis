"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  GROUPS,
  SERIES,
  DEFAULT_ENABLED,
  type SeriesDef,
  type TimeValue,
} from "../../lib/chart-series";

interface Props {
  prices: PricePoint[];
}

export default function UnifiedChart({ prices }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(DEFAULT_ENABLED)
  );
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(["price"])
  );
  const [computing, setComputing] = useState(false);

  const toggle = useCallback((id: string) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((groupId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const enabledSeries = useMemo(
    () => SERIES.filter((s) => enabled.has(s.id)),
    [enabled]
  );

  // Build chart
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
      height: 500,
      rightPriceScale: { visible: true },
      leftPriceScale: { visible: false },
      timeScale: { timeVisible: false },
      crosshair: {
        mode: 0, // Normal
      },
    });
    chartRef.current = chart;

    setComputing(true);

    // Track which scales we've added so we can configure them
    const usedScales = new Set<string>();

    for (const def of enabledSeries) {
      try {
        if (def.type === "candlestick" && def.computeOHLC) {
          const data = def.computeOHLC(prices);
          if (data.length === 0) continue;
          const s = chart.addSeries(CandlestickSeries, {
            upColor: "#26a69a",
            downColor: "#ef5350",
            borderUpColor: "#26a69a",
            borderDownColor: "#ef5350",
            wickUpColor: "#26a69a",
            wickDownColor: "#ef5350",
            priceScaleId: def.scaleId === "price" ? "right" : def.scaleId,
          });
          s.setData(
            data.map((d) => ({
              time: d.time as Time,
              open: d.open,
              high: d.high,
              low: d.low,
              close: d.close,
            }))
          );
          usedScales.add(def.scaleId);
        } else if (def.type === "histogram") {
          const data = def.compute(prices);
          if (data.length === 0) continue;
          const scaleId =
            def.scaleId === "price" ? "right" : def.scaleId;
          const s = chart.addSeries(HistogramSeries, {
            priceScaleId: scaleId,
          });
          s.setData(
            data.map((d) => ({
              time: d.time as Time,
              value: d.value,
              color: def.colorFn
                ? def.colorFn(d.value)
                : def.color,
            }))
          );
          usedScales.add(def.scaleId);
        } else {
          // line
          const data = def.compute(prices);
          if (data.length === 0) continue;
          const scaleId =
            def.scaleId === "price" ? "right" : def.scaleId;
          const s = chart.addSeries(LineSeries, {
            color: def.color,
            lineWidth: (def.lineWidth ?? 1) as 1 | 2 | 3 | 4,
            lineStyle: def.lineStyle ?? 0,
            priceScaleId: scaleId,
          });
          s.setData(
            data.map((d) => ({
              time: d.time as Time,
              value: d.value,
            }))
          );
          usedScales.add(def.scaleId);
        }
      } catch {
        // Skip series that fail to compute
      }
    }

    // Configure volume scale to appear at bottom
    if (usedScales.has("volume")) {
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.75, bottom: 0 },
      });
    }

    // Show left scale if any non-price series are active
    const hasLeftScales = [...usedScales].some(
      (s) => s !== "price" && s !== "volume"
    );
    if (hasLeftScales) {
      // Find the first non-price, non-volume scale and display it on the left
      // lightweight-charts auto-creates scales; we don't need to manually set left
    }

    chart.timeScale().fitContent();
    setComputing(false);

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
  }, [prices, enabledSeries]);

  // Group series by group
  const groupedSeries = useMemo(() => {
    const map = new Map<string, SeriesDef[]>();
    for (const s of SERIES) {
      const list = map.get(s.group) || [];
      list.push(s);
      map.set(s.group, list);
    }
    return map;
  }, []);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">Series Explorer</h3>

      {/* Series selector */}
      <div className="mb-3 space-y-1 max-h-64 overflow-y-auto border border-gray-100 rounded p-2 text-xs">
        {GROUPS.map((group) => {
          const series = groupedSeries.get(group.id) || [];
          const isExpanded = expanded.has(group.id);
          const activeCount = series.filter((s) => enabled.has(s.id)).length;
          return (
            <div key={group.id}>
              <button
                onClick={() => toggleGroup(group.id)}
                className="flex items-center gap-1.5 w-full text-left py-1 px-1 rounded hover:bg-gray-50 font-medium text-gray-700"
              >
                <span className="text-[10px] text-gray-400 w-3">
                  {isExpanded ? "▼" : "▶"}
                </span>
                <span>{group.label}</span>
                {activeCount > 0 && (
                  <span className="text-[10px] bg-blue-100 text-blue-600 px-1.5 rounded-full">
                    {activeCount}
                  </span>
                )}
              </button>
              {isExpanded && (
                <div className="flex flex-wrap gap-1 pl-5 pb-1.5">
                  {series.map((s) => {
                    const isOn = enabled.has(s.id);
                    return (
                      <button
                        key={s.id}
                        onClick={() => toggle(s.id)}
                        className={`px-2 py-0.5 rounded transition-colors ${
                          isOn
                            ? "text-white"
                            : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                        }`}
                        style={
                          isOn ? { backgroundColor: s.color } : undefined
                        }
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {computing && (
        <div className="text-xs text-gray-400 mb-1">計算中...</div>
      )}

      {/* Chart */}
      <div ref={containerRef} className="w-full rounded border border-gray-100" />

      {/* Legend */}
      {enabledSeries.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
          {enabledSeries
            .filter((s) => s.type !== "candlestick")
            .map((s) => (
              <span key={s.id} className="flex items-center gap-1">
                <span
                  className="inline-block w-3 h-0.5"
                  style={{ backgroundColor: s.color }}
                />
                {s.label}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}
