"use client";

import { useEffect, useRef } from "react";
import { createChart, createSeriesMarkers, LineSeries, type IChartApi, type Logical, type MouseEventParams, type SeriesMarker, type Time } from "lightweight-charts";
import type { PricePoint } from "../../lib/types";
import type { RiseToDeclineEvent } from "../../lib/rise-to-decline";
import { CHART_COLORS, EVENT_WINDOW_COLORS } from "../../lib/chart-colors";

interface Props {
  prices: PricePoint[];
  events: RiseToDeclineEvent[];
  lookback: number;
  horizon: number;
  isPeak: boolean;
  onSelect: (date: string) => void;
}

const HEIGHT = 380;

export default function RiseToDeclineOverviewChart({ prices, events, lookback, horizon, isPeak, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (!container || !overlay) return;
    const chart = createChart(container, {
      width: container.clientWidth, height: HEIGHT,
      layout: { background: { color: CHART_COLORS.surface }, textColor: CHART_COLORS.ink },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      timeScale: { timeVisible: false, borderColor: CHART_COLORS.axis, lockVisibleTimeRangeOnResize: true, minBarSpacing: 0.01 },
      rightPriceScale: { borderColor: CHART_COLORS.axis },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;
    const series = chart.addSeries(LineSeries, { color: CHART_COLORS.ink, lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
    series.setData(prices.map((p) => ({ time: p.time as Time, value: p.close })));
    const markers: SeriesMarker<Time>[] = events.map((e) => ({
      time: e.signalDate, position: "aboveBar", shape: "arrowDown", color: EVENT_WINDOW_COLORS.lookback,
      size: 0.6, id: `signal:${e.signalDate}`,
    }));
    // 同じ日に複数の事例が成立しても、結果マーカーを縦に大量に積まない。
    const resultDates = new Set(events.filter((e) => e.outcome === "decline" || e.outcome === "peak").map((e) => e.endDate));
    for (const time of resultDates) markers.push({ time, position: "belowBar", shape: "circle", color: EVENT_WINDOW_COLORS.outcome, size: 0.6 });
    markers.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const markerApi = createSeriesMarkers(series, markers);
    const groups = Array.from(overlay.querySelectorAll<SVGGElement>("g[data-event-date]"));

    const redraw = () => {
      const ts = chart.timeScale();
      const width = ts.width(), height = HEIGHT - ts.height();
      overlay.setAttribute("width", String(width));
      overlay.setAttribute("height", String(height));
      const coordinate = (i: number) => ts.logicalToCoordinate(i as Logical);
      events.forEach((event, i) => {
        const group = groups[i];
        const start = coordinate(event.lookbackStartIndex), signal = coordinate(event.signalIndex), end = coordinate(event.followupEndIndex);
        if (start === null || signal === null || end === null || end < 0 || start > width) {
          group.style.display = "none";
          return;
        }
        group.style.display = "";
        const clipped = (x: number) => Math.max(0, Math.min(width, x));
        const [past, future, origin] = Array.from(group.children);
        for (const [element, a, b] of [[past, start, signal], [future, signal, end]] as const) {
          element.setAttribute("x", String(clipped(a)));
          element.setAttribute("width", String(Math.max(0, clipped(b) - clipped(a))));
          element.setAttribute("height", String(height));
        }
        origin.setAttribute("x1", String(signal));
        origin.setAttribute("x2", String(signal));
        origin.setAttribute("y2", String(height));
      });
    };
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(redraw); };
    const onClick = (param: MouseEventParams<Time>) => {
      const id = param.hoveredInfo?.objectId;
      if (typeof id === "string" && id.startsWith("signal:")) {
        onSelect(id.slice(7));
        return;
      }
      if (!param.point) return;
      // 密集時にもクリックした時期に最も近い起点を選べる。離れた場所では切り替えない。
      let closest: RiseToDeclineEvent | undefined;
      let distance = 9;
      for (const event of events) {
        const x = chart.timeScale().logicalToCoordinate(event.signalIndex as Logical);
        if (x === null) continue;
        const delta = Math.abs(x - param.point.x);
        if (delta < distance) { distance = delta; closest = event; }
      }
      if (closest) onSelect(closest.signalDate);
    };
    chart.subscribeClick(onClick);
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    chart.timeScale().subscribeSizeChange(schedule);
    chart.timeScale().fitContent();
    schedule();
    const observer = new ResizeObserver(() => { chart.applyOptions({ width: container.clientWidth }); schedule(); });
    observer.observe(container);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      chart.unsubscribeClick(onClick);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule);
      chart.timeScale().unsubscribeSizeChange(schedule);
      markerApi.detach();
      chart.remove();
      chartRef.current = null;
    };
  }, [prices, events, onSelect]);

  return (
    <div className="space-y-3" data-testid="rise-event-overview-chart">
      <p className="text-xs text-gray-700">採用した<strong>全{events.length}事例</strong>の区間を原系列上に表示しています。帯が重なる場所は濃くなります。青い起点が集まる時期を拡大すると、各事例の位置関係を確認できます。</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="text-blue-800">青の帯：過去L={lookback}営業日 ／ ▼：条件成立日</span>
        <span className="text-amber-800">橙の帯：その後H={horizon}営業日（観測できた範囲）</span>
        <span className="text-purple-800">紫の●：{isPeak ? "最高終値日" : "下落条件成立日"}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50" onClick={() => chartRef.current?.timeScale().fitContent()}>全事例が見える範囲に戻す</button>
        <span className="text-gray-500">ドラッグで移動・ホイール／ピンチで拡大縮小。青の起点付近をクリックすると個別表示へ。</span>
      </div>
      <div className="relative overflow-hidden rounded border border-gray-200" role="img" aria-label={`全${events.length}事例を表示した原系列。青は過去${lookback}営業日の判定区間、橙は最大${horizon}営業日の追跡区間。青の起点付近をクリックして1事例の表示に切り替えられます。`}>
        <div ref={containerRef} />
        {/* SVG全体の不透明度を制限し、数千の区間が重なっても価格線を塗りつぶさない。 */}
        <svg ref={overlayRef} className="pointer-events-none absolute left-0 top-0 z-10 overflow-hidden" style={{ opacity: 0.35 }} aria-hidden="true">
          {events.map((e) => <g key={e.signalDate} data-event-date={e.signalDate}>
            <rect data-window="lookback" y="0" fill={EVENT_WINDOW_COLORS.lookback} fillOpacity="0.25" />
            <rect data-window="followup" y="0" fill={EVENT_WINDOW_COLORS.followup} fillOpacity="0.2" />
            <line data-window="origin" y1="0" stroke={EVENT_WINDOW_COLORS.lookback} strokeOpacity="0.7" strokeWidth="1" />
          </g>)}
        </svg>
      </div>
      <p className="text-xs text-gray-500">紫の●は同じ結果日を1点にまとめています。結果が未成立・未確定の事例は紫の●がありません。橙の帯は早期に条件が成立してもH日目まで示し、データ末尾以降には延長しません。色の濃さは区間の重なりで、件数や確率の正確な目盛りではありません。</p>
    </div>
  );
}
