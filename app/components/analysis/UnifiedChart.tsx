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
  PRESETS,
  HEAVY_GROUPS,
  type SeriesDef,
  type ComputedSeries,
  type SeriesWorkerResponse,
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

const LS_ENABLED = "unifiedChart.enabled";
const LS_EXPANDED = "unifiedChart.expanded";

function loadSet(key: string, fallback: Iterable<string>): Set<string> {
  if (typeof window === "undefined") return new Set(fallback);
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr as string[]);
    }
  } catch {
    // ignore malformed storage
  }
  return new Set(fallback);
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
  // Web Worker による系列計算（メインスレッドのブロッキング回避）
  const workerRef = useRef<Worker | null>(null);
  const computedRef = useRef(new Map<string, ComputedSeries>());
  const reqPrevPricesRef = useRef<PricePoint[]>(prices);
  const reqIdRef = useRef(0);
  const pendingChunksRef = useRef(0);
  const pendingRangeResetRef = useRef(true);
  // 現在のペイン構成（scaleId の並び。price が常にペイン0）
  const currentScaleOrderRef = useRef<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const isMobile = useIsMobile();
  const [enabled, setEnabled] = useState<Set<string>>(
    () => loadSet(LS_ENABLED, DEFAULT_ENABLED)
  );
  const [expanded, setExpanded] = useState<Set<string>>(
    () => loadSet(LS_EXPANDED, ["price"])
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectorOpen, setSelectorOpen] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= 768
  );
  const [legendTime, setLegendTime] = useState("");
  const [legendEntries, setLegendEntries] = useState<LegendEntry[]>([]);
  const [query, setQuery] = useState("");

  const applyPreset = useCallback((ids: string[]) => {
    setEnabled(new Set(ids));
  }, []);

  const clearAll = useCallback(() => {
    setEnabled(new Set());
  }, []);

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

  // Web Worker のライフサイクル管理
  useEffect(() => {
    const worker = new Worker(
      new URL("../../lib/chart-series.worker.ts", import.meta.url)
    );
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<SeriesWorkerResponse>) => {
      const { reqId, results } = e.data;
      if (reqId !== reqIdRef.current) return; // 古い応答は破棄
      for (const r of results) computedRef.current.set(r.id, r);
      pendingChunksRef.current -= 1;
      if (pendingChunksRef.current <= 0) setLoading(false);
      setVersion((v) => v + 1);
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // 計算リクエスト: prices / 有効系列の変化で未計算分だけWorkerに依頼
  useEffect(() => {
    if (prices.length === 0) return;

    if (reqPrevPricesRef.current !== prices) {
      reqPrevPricesRef.current = prices;
      computedRef.current.clear();
    }

    const missing = enabledSeries.filter((s) => !computedRef.current.has(s.id));

    if (missing.length === 0) {
      // 全て計算済み → 描画だけ更新（削除系のトグル等）
      setVersion((v) => v + 1);
      return;
    }

    // 軽い系列を先に、重い系列を後に依頼（段階描画）
    const light = missing
      .filter((s) => !HEAVY_GROUPS.has(s.group))
      .map((s) => s.id);
    const heavy = missing
      .filter((s) => HEAVY_GROUPS.has(s.group))
      .map((s) => s.id);

    const reqId = ++reqIdRef.current;
    pendingChunksRef.current = (light.length ? 1 : 0) + (heavy.length ? 1 : 0);
    setLoading(true);
    if (light.length) workerRef.current?.postMessage({ reqId, prices, ids: light });
    if (heavy.length) workerRef.current?.postMessage({ reqId, prices, ids: heavy });
  }, [prices, enabledSeries]);

  // 選択状態を localStorage に永続化
  useEffect(() => {
    try {
      window.localStorage.setItem(LS_ENABLED, JSON.stringify([...enabled]));
    } catch {
      // ignore
    }
  }, [enabled]);
  useEffect(() => {
    try {
      window.localStorage.setItem(LS_EXPANDED, JSON.stringify([...expanded]));
    } catch {
      // ignore
    }
  }, [expanded]);

  // 計算済みデータをチャートに反映（scaleId 単位でペイン分割）
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || prices.length === 0) return;

    // 計算済みで非空のデータを持つ系列のみ描画対象
    const renderable = enabledSeries.filter((def) => {
      const c = computedRef.current.get(def.id);
      if (!c) return false;
      const len =
        def.type === "candlestick" ? c.ohlc?.length ?? 0 : c.line?.length ?? 0;
      return len > 0;
    });

    // 望ましいペイン構成: scaleId の出現順（price は必ずペイン0）
    const desiredOrder: string[] = [];
    for (const def of renderable) {
      if (!desiredOrder.includes(def.scaleId)) desiredOrder.push(def.scaleId);
    }
    const pIdx = desiredOrder.indexOf("price");
    if (pIdx > 0) {
      desiredOrder.splice(pIdx, 1);
      desiredOrder.unshift("price");
    }
    const paneOf = (scaleId: string) =>
      Math.max(0, desiredOrder.indexOf(scaleId));

    const pricesChanged = prevPricesRef.current !== prices;
    prevPricesRef.current = prices;

    const prev = currentScaleOrderRef.current;
    const sameLayout =
      !pricesChanged &&
      prev.length === desiredOrder.length &&
      prev.every((s, i) => s === desiredOrder[i]);

    // 現在の表示レンジを保存（価格更新時はリセット）
    if (pricesChanged) {
      savedLogicalRange.current = null;
      pendingRangeResetRef.current = true;
    } else {
      try {
        const lr = chart.timeScale().getVisibleLogicalRange();
        if (lr) savedLogicalRange.current = lr;
      } catch {
        // ignore
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addOne = (def: SeriesDef, paneIndex: number): ISeriesApi<any> | null => {
      const computed = computedRef.current.get(def.id);
      if (!computed) return null;
      const priceScaleId = def.scaleId === "price" ? "right" : def.scaleId;
      try {
        if (def.type === "candlestick" && computed.ohlc) {
          const api = chart.addSeries(
            CandlestickSeries,
            {
              upColor: "#26a69a",
              downColor: "#ef5350",
              borderUpColor: "#26a69a",
              borderDownColor: "#ef5350",
              wickUpColor: "#26a69a",
              wickDownColor: "#ef5350",
              priceScaleId,
            },
            paneIndex
          );
          api.setData(
            computed.ohlc.map((d) => ({
              time: d.time as Time,
              open: d.open,
              high: d.high,
              low: d.low,
              close: d.close,
            }))
          );
          return api;
        } else if (def.type === "histogram") {
          const data = computed.line ?? [];
          const dim = def.scaleId !== "volume";
          const api = chart.addSeries(
            HistogramSeries,
            { priceScaleId },
            paneIndex
          );
          api.setData(
            data.map((d) => {
              const raw =
                d.color ?? (def.colorFn ? def.colorFn(d.value) : def.color);
              return {
                time: d.time as Time,
                value: d.value,
                color: dim ? dimColor(raw) : raw,
              };
            })
          );
          return api;
        } else {
          const data = computed.line ?? [];
          const api = chart.addSeries(
            LineSeries,
            {
              color: def.color,
              lineWidth: (def.lineWidth ?? 1) as 1 | 2 | 3 | 4,
              lineStyle: def.lineStyle ?? 0,
              priceScaleId,
            },
            paneIndex
          );
          api.setData(
            data.map((d) => ({ time: d.time as Time, value: d.value }))
          );
          return api;
        }
      } catch {
        return null;
      }
    };

    if (sameLayout) {
      // ペイン構成が不変 → 差分のみ更新（チャートのちらつきを抑制）
      const renderIds = new Set(renderable.map((s) => s.id));
      for (const [id, api] of seriesMapRef.current) {
        if (!renderIds.has(id)) {
          try { chart.removeSeries(api); } catch { /* disposed */ }
          seriesDefMapRef.current.delete(api);
          seriesMapRef.current.delete(id);
        }
      }
      for (const def of renderable) {
        if (seriesMapRef.current.has(def.id)) continue;
        const api = addOne(def, paneOf(def.scaleId));
        if (api) {
          seriesMapRef.current.set(def.id, api);
          seriesDefMapRef.current.set(api, def);
        }
      }
    } else {
      // ペイン構成が変化 → 全系列を再構築
      for (const [, api] of seriesMapRef.current) {
        try { chart.removeSeries(api); } catch { /* disposed */ }
      }
      seriesMapRef.current.clear();
      seriesDefMapRef.current.clear();
      if (pricesChanged) {
        setLegendEntries([]);
        setLegendTime("");
      }
      for (const def of renderable) {
        const api = addOne(def, paneOf(def.scaleId));
        if (api) {
          seriesMapRef.current.set(def.id, api);
          seriesDefMapRef.current.set(api, def);
        }
      }
      // 余分なペインを除去（高インデックス側から）
      try {
        const need = Math.max(1, desiredOrder.length);
        while (chart.panes().length > need) {
          chart.removePane(chart.panes().length - 1);
        }
      } catch {
        // ignore
      }
      // ペイン高さ: 価格(ペイン0)を大きく、サブペインは均等
      try {
        const panes = chart.panes();
        if (panes.length > 1) {
          panes.forEach((pane, i) => pane.setStretchFactor(i === 0 ? 3 : 1));
        }
      } catch {
        // ignore
      }
      currentScaleOrderRef.current = desiredOrder;
    }

    if (desiredOrder.includes("volume")) {
      try {
        chart
          .priceScale("volume", paneOf("volume"))
          .applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });
      } catch {
        // ignore
      }
    }

    const hasSeries = seriesMapRef.current.size > 0;
    if (savedLogicalRange.current && hasSeries) {
      try {
        chart.timeScale().setVisibleLogicalRange(savedLogicalRange.current);
      } catch {
        chart.timeScale().fitContent();
      }
    } else if (pendingRangeResetRef.current && hasSeries) {
      pendingRangeResetRef.current = false;
      if (period) {
        setInitialVisibleRange(chart, prices, period);
      } else {
        chart.timeScale().fitContent();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prices, enabledSeries, version]);

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

  const q = query.trim().toLowerCase();
  const searchResults = useMemo(
    () => (q ? SERIES.filter((s) => s.label.toLowerCase().includes(q)) : []),
    [q]
  );

  // Shared selector content
  const selectorContent = (
    <div
      className={
        isMobile
          ? "space-y-0.5 text-xs"
          : "space-y-0.5"
      }
    >
      {/* 検索ボックス */}
      <div className="relative mb-1">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="系列を検索…"
          className="w-full pl-2 pr-6 py-1 text-[11px] rounded border border-gray-200 bg-white/80 focus:outline-none focus:border-blue-300"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs px-1"
            title="クリア"
          >
            ✕
          </button>
        )}
      </div>

      {/* プリセット & 全クリア */}
      <div className="flex flex-wrap gap-0.5 mb-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            onClick={() => applyPreset(preset.ids)}
            className="px-1.5 py-0.5 rounded text-[10px] bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
          >
            {preset.label}
          </button>
        ))}
        <button
          onClick={clearAll}
          className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors"
        >
          全クリア
        </button>
      </div>

      {/* 検索中: フラットな結果一覧 */}
      {q ? (
        searchResults.length === 0 ? (
          <p className="text-[11px] text-gray-400 px-1 py-2">該当なし</p>
        ) : (
          <div className="flex flex-wrap gap-0.5">
            {searchResults.map((s) => {
              const isOn = enabled.has(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => toggle(s.id)}
                  className={`px-1.5 py-0.5 rounded text-[11px] transition-colors ${
                    isOn ? "text-white" : "bg-gray-100/80 text-gray-500 hover:bg-gray-200/80"
                  }`}
                  style={isOn ? { backgroundColor: s.color } : undefined}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        )
      ) : (
      GROUPS.map((group) => {
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
      })
      )}
    </div>
  );

  return (
    <div ref={fullscreenRef} className={`bg-white rounded-lg border border-gray-200 p-4${isFullscreen ? " fixed inset-0 z-50 flex flex-col h-screen overflow-auto [&:fullscreen]:static [&:fullscreen]:inset-auto [&:fullscreen]:z-auto" : ""}`}>
      {!isFullscreen && (
        <h3 className="font-bold text-gray-800 mb-3">Series Explorer</h3>
      )}

      <div className={`relative${isFullscreen ? " flex-1" : ""}`}>
        <div
          ref={containerRef}
          className="w-full rounded border border-gray-100"
        />

        {/* 計算中インジケータ */}
        {loading && (
          <div className="absolute top-1 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 bg-white/90 border border-gray-200 rounded-full px-2.5 py-1 text-xs text-gray-600 shadow-sm backdrop-blur-sm pointer-events-none">
            <span className="inline-block w-3 h-3 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
            計算中…
          </div>
        )}

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
