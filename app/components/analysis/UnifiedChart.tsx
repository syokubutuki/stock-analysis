"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type LogicalRange,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  GROUPS,
  GROUP_DETAIL,
  SERIES,
  DEFAULT_ENABLED,
  PRESETS,
  HEAVY_GROUPS,
  type SeriesDef,
  type SeriesPreset,
  type ComputedSeries,
  type SeriesWorkerResponse,
} from "../../lib/chart-series";
import { setInitialVisibleRange } from "../../lib/chart-visible-range";
import type { PeriodKey } from "../../hooks/useAnalysisData";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
  /** 系列グループから対応する詳細分析セクションへ遷移する（タブ切替＋スクロール） */
  onNavigate?: (section: string, anchor?: string) => void;
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
const LS_CUSTOM_PRESETS = "unifiedChart.customPresets";

function loadCustomPresets(): SeriesPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_CUSTOM_PRESETS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.filter(
          (p): p is SeriesPreset =>
            p &&
            typeof p.id === "string" &&
            typeof p.label === "string" &&
            Array.isArray(p.ids)
        );
      }
    }
  } catch {
    // ignore malformed storage
  }
  return [];
}

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

export default function UnifiedChart({ prices, period, onNavigate }: Props) {
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
  // resize ハンドラのクロージャから最新の全画面状態を参照するための ref。
  // iOS Safari 等は Fullscreen API 非対応で document.fullscreenElement が
  // 常に null のため、CSS フォールバック時の全画面状態を別途保持する。
  const isFullscreenRef = useRef(false);
  useEffect(() => {
    isFullscreenRef.current = isFullscreen;
  }, [isFullscreen]);
  const [logScale, setLogScale] = useState(false);
  const [selectorOpen, setSelectorOpen] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= 768
  );
  const [legendTime, setLegendTime] = useState("");
  const [legendEntries, setLegendEntries] = useState<LegendEntry[]>([]);
  const [query, setQuery] = useState("");
  const [customPresets, setCustomPresets] =
    useState<SeriesPreset[]>(loadCustomPresets);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState("");

  const applyPreset = useCallback((ids: string[]) => {
    setEnabled(new Set(ids));
  }, []);

  const clearAll = useCallback(() => {
    setEnabled(new Set());
  }, []);

  // 現在の選択をユーザー定義セットとして保存（同名は上書き）
  const saveCurrentAsPreset = useCallback(() => {
    const label = presetName.trim();
    if (!label || enabled.size === 0) return;
    const ids = [...enabled];
    setCustomPresets((prev) => {
      const exists = prev.some((p) => p.label === label);
      if (exists) {
        return prev.map((p) => (p.label === label ? { ...p, ids } : p));
      }
      return [...prev, { id: `custom_${Date.now()}`, label, ids }];
    });
    setPresetName("");
    setSavingPreset(false);
  }, [presetName, enabled]);

  const deleteCustomPreset = useCallback((id: string) => {
    setCustomPresets((prev) => prev.filter((p) => p.id !== id));
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
      // CSS フォールバック全画面（iOS Safari 等）では document.fullscreenElement が
      // null のため、isFullscreenRef も併せて見る。これがないとスマホで下に
      // スクロール→アドレスバー開閉による resize で高さが 350 に戻ってしまう。
      const fs = !!document.fullscreenElement || isFullscreenRef.current;
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

  // 価格軸の対数/線形スケール切替（右軸）
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.priceScale("right").applyOptions({
      mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [logScale, version]);

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
  useEffect(() => {
    try {
      window.localStorage.setItem(
        LS_CUSTOM_PRESETS,
        JSON.stringify(customPresets)
      );
    } catch {
      // ignore
    }
  }, [customPresets]);

  // 計算済みデータをチャートに反映（全系列を同一ペインに重ねて表示）
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || prices.length === 0) return;

    const pricesChanged = prevPricesRef.current !== prices;
    prevPricesRef.current = prices;

    if (pricesChanged) {
      savedLogicalRange.current = null;
      pendingRangeResetRef.current = true;
      for (const [, api] of seriesMapRef.current) {
        try { chart.removeSeries(api); } catch { /* disposed */ }
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
        try { chart.removeSeries(api); } catch { /* disposed */ }
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

      const computed = computedRef.current.get(def.id);
      if (!computed) continue; // まだWorkerの計算待ち

      const priceScaleId = def.scaleId === "price" ? "right" : def.scaleId;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let api: ISeriesApi<any>;
        if (def.type === "candlestick" && computed.ohlc) {
          if (computed.ohlc.length === 0) continue;
          api = chart.addSeries(CandlestickSeries, {
            upColor: "#26a69a",
            downColor: "#ef5350",
            borderUpColor: "#26a69a",
            borderDownColor: "#ef5350",
            wickUpColor: "#26a69a",
            wickDownColor: "#ef5350",
            priceScaleId,
          });
          api.setData(
            computed.ohlc.map((d) => ({
              time: d.time as Time,
              open: d.open,
              high: d.high,
              low: d.low,
              close: d.close,
            }))
          );
        } else if (def.type === "histogram") {
          const data = computed.line ?? [];
          if (data.length === 0) continue;
          const dim = def.scaleId !== "volume";
          api = chart.addSeries(HistogramSeries, { priceScaleId });
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
        } else {
          const data = computed.line ?? [];
          if (data.length === 0) continue;
          api = chart.addSeries(LineSeries, {
            color: def.color,
            lineWidth: (def.lineWidth ?? 1) as 1 | 2 | 3 | 4,
            lineStyle: def.lineStyle ?? 0,
            priceScaleId,
          });
          api.setData(
            data.map((d) => ({ time: d.time as Time, value: d.value }))
          );
        }

        seriesMapRef.current.set(def.id, api);
        seriesDefMapRef.current.set(api, def);
      } catch {
        // Skip series that fail to render
      }
    }

    // 出来高が空の銘柄(指数など)では volume 系列が描画されず "volume" スケールが
    // 生成されないため、usedScales(描画前の予定)ではなく実際に追加された系列で判定する。
    const hasVolumeSeries = [...seriesMapRef.current.values()].some(
      (api) => seriesDefMapRef.current.get(api)?.scaleId === "volume"
    );
    if (hasVolumeSeries) {
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
        {/* ユーザー定義セット */}
        {customPresets.map((preset) => (
          <span
            key={preset.id}
            className="inline-flex items-center rounded text-[10px] bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors"
          >
            <button
              onClick={() => applyPreset(preset.ids)}
              className="pl-1.5 py-0.5"
              title={`${preset.ids.length}系列を表示`}
            >
              {preset.label}
            </button>
            <button
              onClick={() => deleteCustomPreset(preset.id)}
              className="px-1 py-0.5 text-emerald-400 hover:text-emerald-700"
              title="このセットを削除"
            >
              ✕
            </button>
          </span>
        ))}
        <button
          onClick={clearAll}
          className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors"
        >
          全クリア
        </button>
        <button
          onClick={() => setLogScale((v) => !v)}
          className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${logScale ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
          title="価格軸を対数スケール/線形スケールで切替"
        >
          {logScale ? "対数" : "線形"}スケール
        </button>
        <button
          onClick={() => setSavingPreset((v) => !v)}
          disabled={enabled.size === 0}
          className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-50 text-emerald-600 hover:bg-emerald-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="現在表示中の系列をセットとして保存"
        >
          ＋セット保存
        </button>
      </div>

      {/* セット保存用の名前入力 */}
      {savingPreset && (
        <div className="flex items-center gap-1 mb-1.5">
          <input
            type="text"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveCurrentAsPreset();
              else if (e.key === "Escape") {
                setSavingPreset(false);
                setPresetName("");
              }
            }}
            autoFocus
            placeholder="セット名（例: マイ・トレンド）"
            className="flex-1 min-w-0 pl-2 pr-2 py-1 text-[11px] rounded border border-emerald-200 bg-white/80 focus:outline-none focus:border-emerald-400"
          />
          <button
            onClick={saveCurrentAsPreset}
            disabled={!presetName.trim() || enabled.size === 0}
            className="px-2 py-1 rounded text-[10px] bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            保存
          </button>
        </div>
      )}

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
              {GROUP_DETAIL[group.id] && onNavigate && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation(); // グループの開閉トグルを誘発しない
                    const d = GROUP_DETAIL[group.id];
                    onNavigate(d.section, d.anchor);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      e.preventDefault();
                      const d = GROUP_DETAIL[group.id];
                      onNavigate(d.section, d.anchor);
                    }
                  }}
                  className="ml-1 text-[10px] font-normal text-blue-500 hover:text-blue-700 hover:underline cursor-pointer"
                  title={`「${GROUP_DETAIL[group.id].label}」タブで詳細を見る`}
                >
                  詳細 →
                </span>
              )}
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
