"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type LogicalRange,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  GROUPS,
  SERIES,
  DEFAULT_ENABLED,
  type SeriesDef,
} from "../../lib/chart-series";
import { setInitialVisibleRange } from "../../lib/chart-visible-range";
import type { PeriodKey } from "../../hooks/useAnalysisData";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

interface LegendEntry {
  label: string;
  color: string;
  values: string;
}

/** Reduce alpha of an rgba/hex color to 1/3 opacity for non-price histograms */
function dimColor(color: string): string {
  const m = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (m) {
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    return `rgba(${m[1]},${m[2]},${m[3]},${(a / 3).toFixed(3)})`;
  }
  // hex
  const h = color.match(/^#([0-9a-f]{6})$/i);
  if (h) {
    const r = parseInt(h[1].slice(0, 2), 16);
    const g = parseInt(h[1].slice(2, 4), 16);
    const b = parseInt(h[1].slice(4, 6), 16);
    return `rgba(${r},${g},${b},0.333)`;
  }
  return color;
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000)
    return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < breakpoint
  );
  useEffect(() => {
    const check = () => setMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [breakpoint]);
  return mobile;
}

export default function UnifiedChart({ prices, period }: Props) {
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const seriesMapRef = useRef(new Map<string, ISeriesApi<any>>());
  const seriesDefMapRef = useRef(new Map<ISeriesApi<any>, SeriesDef>());
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const savedLogicalRange = useRef<LogicalRange | null>(null);
  const prevPricesRef = useRef<PricePoint[]>(prices);
  const isMobile = useIsMobile();
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(DEFAULT_ENABLED)
  );
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(["price"])
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectorOpen, setSelectorOpen] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= 768
  );
  const [legendTime, setLegendTime] = useState("");
  const [legendEntries, setLegendEntries] = useState<LegendEntry[]>([]);

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

  const resizeChartForFullscreen = useCallback((fs: boolean) => {
    const chart = chartRef.current;
    if (!chart || !containerRef.current) return;
    requestAnimationFrame(() => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      const mob = window.innerWidth < 768;
      const h = fs ? window.innerHeight - 80 : mob ? 350 : 600;
      chart.applyOptions({ width: w, height: h, rightPriceScale: { visible: !mob } });
    });
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = fullscreenRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (el.requestFullscreen) {
      el.requestFullscreen();
    } else {
      // CSS fallback for iOS Safari
      const next = !isFullscreen;
      setIsFullscreen(next);
      resizeChartForFullscreen(next);
    }
  }, [isFullscreen, resizeChartForFullscreen]);

  // Listen for fullscreenchange (native API)
  useEffect(() => {
    const onFullscreenChange = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
      resizeChartForFullscreen(fs);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [resizeChartForFullscreen]);

  const enabledSeries = useMemo(
    () => SERIES.filter((s) => enabled.has(s.id)),
    [enabled]
  );

  // Create/destroy chart on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const initMobile = window.innerWidth < 768;
    const initHeight = initMobile ? 350 : 600;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: {
        vertLines: { color: "#f0f0f0" },
        horzLines: { color: "#f0f0f0" },
      },
      width: containerRef.current.clientWidth,
      height: initHeight,
      rightPriceScale: { visible: !initMobile },
      leftPriceScale: { visible: false },
      timeScale: { timeVisible: false },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    // Crosshair: only show candlestick OHLC
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) return;
      const entries: LegendEntry[] = [];
      for (const [api, data] of param.seriesData) {
        const def = seriesDefMapRef.current.get(api);
        if (!def || def.type !== "candlestick") continue;
        if ("open" in data) {
          const d = data as {
            open: number;
            high: number;
            low: number;
            close: number;
          };
          entries.push({
            label: def.label,
            color: def.color,
            values: `O ${fmt(d.open)}  H ${fmt(d.high)}  L ${fmt(d.low)}  C ${fmt(d.close)}`,
          });
        }
      }
      setLegendEntries(entries);
      setLegendTime(String(param.time));
    });

    const handleResize = () => {
      if (!containerRef.current) return;
      const fs = !!document.fullscreenElement;
      const mob = window.innerWidth < 768;
      const w = containerRef.current.clientWidth;
      const h = fs ? window.innerHeight - 80 : mob ? 350 : 600;
      chart.applyOptions({ width: w, height: h, rightPriceScale: { visible: !mob } });
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      seriesMapRef.current.clear();
      seriesDefMapRef.current.clear();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Sync series when prices or enabled series change
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || prices.length === 0) return;

    const pricesChanged = prevPricesRef.current !== prices;
    prevPricesRef.current = prices;

    if (pricesChanged) {
      savedLogicalRange.current = null;
      for (const [, api] of seriesMapRef.current) {
        try { chart.removeSeries(api); } catch { /* chart may be disposed */ }
        seriesDefMapRef.current.delete(api);
      }
      seriesMapRef.current.clear();
      setLegendEntries([]);
      setLegendTime("");
    } else {
      try {
        const lr = chart.timeScale().getVisibleLogicalRange();
        if (lr) savedLogicalRange.current = lr;
      } catch {
        // ignore
      }
    }

    const enabledIds = new Set(enabledSeries.map((s) => s.id));
    for (const [id, api] of seriesMapRef.current) {
      if (!enabledIds.has(id)) {
        try { chart.removeSeries(api); } catch { /* chart may be disposed */ }
        seriesDefMapRef.current.delete(api);
        seriesMapRef.current.delete(id);
      }
    }

    const usedScales = new Set<string>();
    for (const [, api] of seriesMapRef.current) {
      const def = seriesDefMapRef.current.get(api);
      if (def) usedScales.add(def.scaleId);
    }

    for (const def of enabledSeries) {
      usedScales.add(def.scaleId);
      if (seriesMapRef.current.has(def.id)) continue;

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let api: ISeriesApi<any>;
        if (def.type === "candlestick" && def.computeOHLC) {
          const data = def.computeOHLC(prices);
          if (data.length === 0) continue;
          api = chart.addSeries(CandlestickSeries, {
            upColor: "#26a69a",
            downColor: "#ef5350",
            borderUpColor: "#26a69a",
            borderDownColor: "#ef5350",
            wickUpColor: "#26a69a",
            wickDownColor: "#ef5350",
            priceScaleId: def.scaleId === "price" ? "right" : def.scaleId,
          });
          api.setData(
            data.map((d) => ({
              time: d.time as Time,
              open: d.open,
              high: d.high,
              low: d.low,
              close: d.close,
            }))
          );
        } else if (def.type === "histogram") {
          const data = def.compute(prices);
          if (data.length === 0) continue;
          const dim = def.scaleId !== "volume";
          api = chart.addSeries(HistogramSeries, {
            priceScaleId: def.scaleId === "price" ? "right" : def.scaleId,
          });
          api.setData(
            data.map((d) => {
              const raw =
                d.color ??
                (def.colorFn ? def.colorFn(d.value) : def.color);
              return {
                time: d.time as Time,
                value: d.value,
                color: dim ? dimColor(raw) : raw,
              };
            })
          );
        } else {
          const data = def.compute(prices);
          if (data.length === 0) continue;
          api = chart.addSeries(LineSeries, {
            color: def.color,
            lineWidth: (def.lineWidth ?? 1) as 1 | 2 | 3 | 4,
            lineStyle: def.lineStyle ?? 0,
            priceScaleId: def.scaleId === "price" ? "right" : def.scaleId,
          });
          api.setData(
            data.map((d) => ({
              time: d.time as Time,
              value: d.value,
            }))
          );
        }

        seriesMapRef.current.set(def.id, api);
        seriesDefMapRef.current.set(api, def);
      } catch {
        // Skip series that fail to compute
      }
    }

    if (usedScales.has("volume")) {
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.75, bottom: 0 },
      });
    }

    const hasSeries = seriesMapRef.current.size > 0;
    if (savedLogicalRange.current && hasSeries) {
      try {
        chart.timeScale().setVisibleLogicalRange(savedLogicalRange.current);
      } catch {
        chart.timeScale().fitContent();
      }
    } else if (pricesChanged && hasSeries) {
      if (period) {
        setInitialVisibleRange(chart, prices, period);
      } else {
        chart.timeScale().fitContent();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prices, enabledSeries]);

  // Update visible range when period changes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !period || seriesMapRef.current.size === 0) return;
    try {
      setInitialVisibleRange(chart, prices, period);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  const groupedSeries = useMemo(() => {
    const map = new Map<string, SeriesDef[]>();
    for (const s of SERIES) {
      const list = map.get(s.group) || [];
      list.push(s);
      map.set(s.group, list);
    }
    return map;
  }, []);

  // Shared selector content
  const selectorContent = (
    <div
      className={
        isMobile
          ? "space-y-0.5 text-xs"
          : "space-y-0.5"
      }
    >
      {GROUPS.map((group) => {
        const series = groupedSeries.get(group.id) || [];
        const isExpanded = expanded.has(group.id);
        const activeCount = series.filter((s) => enabled.has(s.id)).length;
        return (
          <div key={group.id}>
            <button
              onClick={() => toggleGroup(group.id)}
              className="flex items-center gap-1 w-full text-left py-0.5 px-1 rounded hover:bg-gray-100/80 font-medium text-gray-700"
            >
              <span className="text-[10px] text-gray-400 w-3">
                {isExpanded ? "▼" : "▶"}
              </span>
              <span>{group.label}</span>
              {activeCount > 0 && (
                <span className="text-[10px] bg-blue-100 text-blue-600 px-1 rounded-full ml-auto">
                  {activeCount}
                </span>
              )}
            </button>
            {isExpanded && (
              <div className="flex flex-wrap gap-0.5 pl-4 pb-1">
                {series.map((s) => {
                  const isOn = enabled.has(s.id);
                  return (
                    <button
                      key={s.id}
                      onClick={() => toggle(s.id)}
                      className={`px-1.5 py-0.5 rounded text-[11px] transition-colors ${
                        isOn
                          ? "text-white"
                          : "bg-gray-100/80 text-gray-500 hover:bg-gray-200/80"
                      }`}
                      style={isOn ? { backgroundColor: s.color } : undefined}
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
  );

  return (
    <div ref={fullscreenRef} className={`bg-white rounded-lg border border-gray-200 p-4${isFullscreen ? " fixed inset-0 z-50 flex flex-col h-screen overflow-auto [&:fullscreen]:static [&:fullscreen]:inset-auto [&:fullscreen]:z-auto" : ""}`}>
      <h3 className="font-bold text-gray-800 mb-3">Series Explorer</h3>

      <div className={`relative${isFullscreen ? " flex-1" : ""}`}>
        <div
          ref={containerRef}
          className="w-full rounded border border-gray-100"
        />

        {/* PC: Crosshair legend - top right */}
        {!isMobile && legendEntries.length > 0 && (
          <div className="absolute top-7 right-1 z-10 bg-white/90 backdrop-blur-sm border border-gray-200/50 rounded shadow-sm px-2 py-1 text-xs pointer-events-none">
            {legendTime && (
              <div className="text-gray-500 font-medium mb-0.5">
                {legendTime}
              </div>
            )}
            {legendEntries.map((e) => (
              <div
                key={e.label}
                className="flex items-center gap-1.5 whitespace-nowrap"
              >
                <span
                  className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: e.color }}
                />
                <span className="font-mono text-gray-800">{e.values}</span>
              </div>
            ))}
          </div>
        )}

        {/* Fullscreen toggle button */}
        <button
          onClick={toggleFullscreen}
          className="absolute top-1 right-1 z-10 bg-white/90 border border-gray-200 rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 shadow-sm backdrop-blur-sm"
          title={isFullscreen ? "全画面解除" : "全画面表示"}
        >
          {isFullscreen ? "✕" : "⛶"}
        </button>

        {/* Overlay selector on the left (PC & Mobile共通) */}
        <div className="absolute top-1 left-1 z-10 flex flex-col items-start">
          <button
            onClick={() => setSelectorOpen((v) => !v)}
            className="bg-white/90 border border-gray-200 rounded px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100 shadow-sm backdrop-blur-sm"
          >
            {selectorOpen ? "◀ 系列" : "▶ 系列"}
          </button>
          {selectorOpen && (
            <div className={`mt-1 bg-white/50 backdrop-blur-sm border border-gray-200/50 rounded shadow-md p-1.5 overflow-y-auto text-xs ${
              isMobile ? "max-h-[240px] w-44" : "max-h-[460px] w-48"
            }`}>
              {selectorContent}
            </div>
          )}
        </div>
      </div>

      {/* Mobile: crosshair legend below chart */}
      {isMobile && legendEntries.length > 0 && (
        <div className="bg-gray-50 rounded-b border-x border-b border-gray-200 px-2 py-1 text-xs flex items-center gap-2 -mt-[1px] pointer-events-none">
          <span className="text-gray-400">{legendTime}</span>
          {legendEntries.map((e) => (
            <span key={e.label} className="font-mono text-gray-700">
              {e.values}
            </span>
          ))}
        </div>
      )}

      {/* PC: Static legend */}
      {!isMobile && enabledSeries.length > 0 && (
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
