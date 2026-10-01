"use client";

// 元の価格チャート（終値）。イベント・売買のマーカーを置き、一覧で選んだ事例の区間へ移動する。
// 横軸は日付なので lightweight-charts（ズーム・パン可）。帯は描画フレームで座標に同期する
// （RiseToDeclinePriceChart と同じ方式）。

import { useEffect, useRef } from "react";
import {
  createChart, createSeriesMarkers, LineSeries, PriceScaleMode,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Logical, type MouseEventParams, type SeriesMarker, type Time,
} from "lightweight-charts";
import type { PricePoint } from "../../lib/types";
import type { AnalysisRange } from "../../lib/nday-move";
import { CHART_COLORS, DIRECTION_COLORS, EVENT_WINDOW_COLORS } from "../../lib/chart-colors";
import { buttonClass } from "./ndayMoveShared";

export interface PriceMarker {
  id: string;
  index: number;
  kind: "event" | "event-dim" | "entry" | "exit" | "open";
  text?: string;
}

export interface PriceFocus {
  from: number;
  to: number;
  bands: { from: number; to: number; tone: "lookback" | "forward" | "holding" }[];
  label: string;
}

interface Props {
  prices: PricePoint[];
  range: AnalysisRange;
  markers: PriceMarker[];
  focus: PriceFocus | null;
  onSelect?: (id: string) => void;
  ariaLabel: string;
  height?: number;
}

const BAND_CLASS = {
  lookback: "border-x border-blue-500 bg-blue-500/10",
  forward: "border-r border-amber-600 bg-amber-500/10",
  holding: "border-x border-emerald-600 bg-emerald-500/15",
} as const;

export default function NdayMovePriceChart({ prices, range, markers, focus, onSelect, ariaLabel, height = 320 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const bandRefs = useRef<(HTMLDivElement | null)[]>([]);
  const focusRef = useRef<PriceFocus | null>(focus);
  const markerListRef = useRef<PriceMarker[]>(markers);
  const onSelectRef = useRef(onSelect);
  const scheduleRef = useRef<() => void>(() => {});

  useEffect(() => {
    focusRef.current = focus;
    markerListRef.current = markers;
    onSelectRef.current = onSelect;
  });

  // チャート本体（価格が変わったときだけ作り直す。選択の変更でズームを失わない）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      width: container.clientWidth,
      height,
      layout: { background: { color: CHART_COLORS.surface }, textColor: CHART_COLORS.ink },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      timeScale: { timeVisible: false, borderColor: CHART_COLORS.axis, lockVisibleTimeRangeOnResize: true, minBarSpacing: 0.01 },
      // 10年で何倍にもなる銘柄では、算術目盛りだと前半の値動きがつぶれる。騰落率で見るので対数目盛り。
      rightPriceScale: { borderColor: CHART_COLORS.axis, mode: PriceScaleMode.Logarithmic },
      crosshair: { mode: 0 },
    });
    const series = chart.addSeries(LineSeries, { color: CHART_COLORS.ink, lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
    series.setData(prices.map((p) => ({ time: p.time as Time, value: p.close })));
    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);

    const redraw = () => {
      const ts = chart.timeScale();
      const width = ts.width();
      const plotHeight = height - ts.height();
      const bands = focusRef.current?.bands ?? [];
      bandRefs.current.forEach((el, k) => {
        if (!el) return;
        const band = bands[k];
        if (!band) { el.style.display = "none"; return; }
        const a = ts.logicalToCoordinate(band.from as Logical);
        const b = ts.logicalToCoordinate(band.to as Logical);
        if (a === null || b === null) { el.style.display = "none"; return; }
        const left = Math.max(0, Math.min(width, a));
        const right = Math.max(0, Math.min(width, b));
        el.style.display = right > left ? "block" : "none";
        el.style.left = `${left}px`;
        el.style.width = `${Math.max(0, right - left)}px`;
        el.style.height = `${plotHeight}px`;
      });
    };
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(redraw); };
    scheduleRef.current = schedule;
    const onClick = (param: MouseEventParams<Time>) => {
      const id = param.hoveredInfo?.objectId;
      if (typeof id === "string" && id.startsWith("sel:")) { onSelectRef.current?.(id.slice(4)); return; }
      if (!param.point) return;
      // 密集していても、クリックした位置に最も近いマーカー（9px 以内）を選ぶ
      let closest: PriceMarker | undefined;
      let distance = 9;
      for (const m of markerListRef.current) {
        const x = chart.timeScale().logicalToCoordinate(m.index as Logical);
        if (x === null) continue;
        const d = Math.abs(x - param.point.x);
        if (d < distance) { distance = d; closest = m; }
      }
      if (closest) onSelectRef.current?.(closest.id);
    };
    chart.subscribeClick(onClick);
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    chart.timeScale().subscribeSizeChange(schedule);
    const observer = new ResizeObserver(() => { chart.applyOptions({ width: container.clientWidth }); schedule(); });
    observer.observe(container);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      chart.unsubscribeClick(onClick);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule);
      chart.timeScale().unsubscribeSizeChange(schedule);
      markersRef.current?.detach();
      markersRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [prices, height]);

  // 分析期間を初期表示にする
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().setVisibleLogicalRange({ from: range.start - 2, to: range.end + 2 });
    scheduleRef.current();
  }, [prices, range.start, range.end]);

  // マーカー
  useEffect(() => {
    const api = markersRef.current;
    if (!api) return;
    const data: SeriesMarker<Time>[] = markers
      .filter((m) => m.index >= 0 && m.index < prices.length)
      .map((m) => {
        const time = prices[m.index].time as Time;
        const id = `sel:${m.id}`;
        switch (m.kind) {
          case "entry": return { id, time, position: "belowBar", color: DIRECTION_COLORS.up, shape: "arrowUp", text: m.text };
          case "exit": return { id, time, position: "aboveBar", color: DIRECTION_COLORS.down, shape: "arrowDown", text: m.text };
          case "open": return { id, time, position: "aboveBar", color: CHART_COLORS.neutral, shape: "square", text: m.text };
          case "event-dim": return { id, time, position: "belowBar", color: CHART_COLORS.neutral, shape: "circle", text: m.text };
          default: return { id, time, position: "belowBar", color: EVENT_WINDOW_COLORS.lookback, shape: "circle", text: m.text };
        }
      });
    data.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    api.setMarkers(data);
  }, [markers, prices]);

  // 選択した事例へ移動し、帯を描く
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (focus) {
      const pad = Math.max(5, Math.ceil((focus.to - focus.from) * 0.4));
      chart.timeScale().setVisibleLogicalRange({ from: focus.from - pad, to: focus.to + pad });
    }
    scheduleRef.current();
  }, [focus]);

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded border border-gray-200" role="img" aria-label={ariaLabel}>
        <div ref={containerRef} />
        <div className="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
          {[0, 1, 2].map((k) => (
            <div
              key={k}
              ref={(el) => { bandRefs.current[k] = el; }}
              className={`absolute top-0 ${BAND_CLASS[focus?.bands[k]?.tone ?? "forward"]}`}
              style={{ display: "none" }}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {focus && <span className="text-gray-700">{focus.label}</span>}
        <button type="button" className={buttonClass} onClick={() => {
          const chart = chartRef.current;
          if (chart && focus) {
            const pad = Math.max(5, Math.ceil((focus.to - focus.from) * 0.4));
            chart.timeScale().setVisibleLogicalRange({ from: focus.from - pad, to: focus.to + pad });
          }
        }} disabled={!focus}>選択した区間に戻す</button>
        <button type="button" className={buttonClass} onClick={() => chartRef.current?.timeScale().setVisibleLogicalRange({ from: range.start - 2, to: range.end + 2 })}>分析期間の全体を見る</button>
        <span className="text-gray-500">終値（調整後・対数目盛り）。ドラッグで移動・ホイール／ピンチで拡大縮小。マーカーをクリックすると一覧の行を選びます。</span>
      </div>
    </div>
  );
}
