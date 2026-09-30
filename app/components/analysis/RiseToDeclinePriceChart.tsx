"use client";

import { useEffect, useRef } from "react";
import { createChart, createSeriesMarkers, LineSeries, type IChartApi, type Logical, type SeriesMarker, type Time } from "lightweight-charts";
import type { PricePoint } from "../../lib/types";
import type { RiseToDeclineEvent } from "../../lib/rise-to-decline";
import { CHART_COLORS, EVENT_WINDOW_COLORS } from "../../lib/chart-colors";

interface Props {
  prices: PricePoint[];
  event: RiseToDeclineEvent;
  lookback: number;
  horizon: number;
  isPeak: boolean;
}

const HEIGHT = 320;
const priceText = (value: number) => value.toLocaleString("ja-JP", { maximumFractionDigits: 4 });

export default function RiseToDeclinePriceChart({ prices, event, lookback, horizon, isPeak }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pastBandRef = useRef<HTMLDivElement>(null);
  const futureBandRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const focusRef = useRef<(() => void) | null>(null);
  const observed = event.outcome === "decline" || event.outcome === "peak";
  const completeWindow = event.availableFollowup === horizon;
  const start = prices[event.lookbackStartIndex];
  const signal = prices[event.signalIndex];
  const last = prices[event.followupEndIndex];
  const resultLabel = isPeak ? "最高終値" : "下落条件成立";

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: HEIGHT,
      layout: { background: { color: CHART_COLORS.surface }, textColor: CHART_COLORS.ink },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      timeScale: { timeVisible: false, borderColor: CHART_COLORS.axis, lockVisibleTimeRangeOnResize: true, minBarSpacing: 0.01 },
      rightPriceScale: { borderColor: CHART_COLORS.axis },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;
    const series = chart.addSeries(LineSeries, {
      color: CHART_COLORS.ink, lineWidth: 2, lastValueVisible: false, priceLineVisible: false,
    });
    series.setData(prices.map((p) => ({ time: p.time as Time, value: p.close })));
    const markerData: SeriesMarker<Time>[] = [
      { time: start.time, position: "belowBar", color: EVENT_WINDOW_COLORS.lookback, shape: "circle", text: "① L日前" },
      { time: signal.time, position: "aboveBar", color: EVENT_WINDOW_COLORS.lookback, shape: "arrowDown", text: "② 起点 0日" },
      { time: last.time, position: "belowBar", color: EVENT_WINDOW_COLORS.followup, shape: "square", text: completeWindow ? `④ H=${horizon}日` : `④ 末尾 ${event.availableFollowup}日` },
    ];
    if (observed) markerData.push({
      time: event.endDate, position: "belowBar", color: EVENT_WINDOW_COLORS.outcome,
      shape: "arrowDown", text: `③ ${event.duration}日後`,
    });
    markerData.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const markers = createSeriesMarkers(series, markerData);

    const redrawBands = () => {
      const ts = chart.timeScale();
      const width = ts.width();
      const height = HEIGHT - ts.height();
      const coordinate = (index: number) => ts.logicalToCoordinate(index as Logical);
      const paintBand = (element: HTMLDivElement | null, from: number, to: number) => {
        if (!element) return;
        const a = coordinate(from), b = coordinate(to);
        if (a === null || b === null) { element.style.display = "none"; return; }
        const left = Math.max(0, Math.min(width, a));
        const right = Math.max(0, Math.min(width, b));
        element.style.display = right > left ? "block" : "none";
        element.style.left = `${left}px`;
        element.style.width = `${Math.max(0, right - left)}px`;
        element.style.height = `${height}px`;
      };
      paintBand(pastBandRef.current, event.lookbackStartIndex, event.signalIndex);
      // 0日は両期間の境界。未来の価格がない部分を日付で外挿しない。
      paintBand(futureBandRef.current, event.signalIndex, event.followupEndIndex);
      const origin = originRef.current;
      const x = coordinate(event.signalIndex);
      if (origin) {
        origin.style.display = x !== null && x >= 0 && x <= width ? "block" : "none";
        origin.style.left = `${x ?? 0}px`;
        origin.style.height = `${height}px`;
      }
    };
    // サイズ変更通知は時間軸の座標更新より先に来る場合がある。描画フレームで座標を読む。
    let frame = 0;
    const scheduleBands = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(redrawBands);
    };
    const focus = () => {
      const padding = Math.max(3, Math.ceil((lookback + event.availableFollowup) * 0.15));
      chart.timeScale().setVisibleLogicalRange({
        from: event.lookbackStartIndex - padding,
        to: event.followupEndIndex + padding,
      });
      scheduleBands();
    };
    focusRef.current = focus;
    chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleBands);
    chart.timeScale().subscribeSizeChange(scheduleBands);
    focus();
    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
      scheduleBands();
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleBands);
      chart.timeScale().unsubscribeSizeChange(scheduleBands);
      markers.detach();
      chart.remove();
      chartRef.current = null;
      focusRef.current = null;
    };
  }, [prices, event, lookback, horizon, start.time, signal.time, last.time, completeWindow, observed]);

  return (
    <div className="space-y-3" data-testid="rise-event-price-chart">
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <div className="rounded border border-blue-200 bg-blue-50 p-3 text-blue-900">
          <strong>青 ① → ②：過去L={lookback}営業日の判定区間</strong>
          <p className="mt-1">{start.time} → {signal.time}</p>
          <p>{priceText(start.close)} → {priceText(signal.close)}（+{event.risePct.toFixed(2)}%）</p>
        </div>
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-amber-900">
          <strong>橙 ② → ④：その後H={horizon}営業日の追跡区間</strong>
          <p className="mt-1">{event.availableFollowup > 0 ? `${prices[event.signalIndex + 1].time}（翌日）→ ${last.time}` : "翌営業日以降の価格データはまだありません"}</p>
          <p>{completeWindow ? `${horizon}営業日分を観測済み` : `${event.availableFollowup}営業日分だけ観測済み。残り${horizon - event.availableFollowup}営業日は未観測`}</p>
        </div>
      </div>
      <p className="text-xs text-gray-700"><strong>② {signal.time}を0日目</strong>として、右へ1営業日ずつ数えます。
        {observed ? <span className="text-purple-800"> <strong>③ {resultLabel}：{event.endDate}（{event.duration}営業日後）</strong></span>
          : <span> ③はありません：{isPeak ? "H日未観測のため最高終値日は未確定" : "観測範囲内では下落条件が未成立"}。</span>}
      </p>
      <div className="flex flex-wrap gap-2 text-xs">
        <button type="button" className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50" onClick={() => focusRef.current?.()}>事例の区間に戻す</button>
        <button type="button" className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50" onClick={() => chartRef.current?.timeScale().fitContent()}>選択事例のまま全期間を見る</button>
        <span className="self-center text-gray-500">ドラッグで移動・ホイール／ピンチで拡大縮小</span>
      </div>
      <div className="relative overflow-hidden rounded border border-gray-200" role="img" aria-label={`選択事例の原系列（終値）。① ${start.time}から② ${signal.time}まで過去${lookback}営業日。追跡上限${horizon}営業日、④ ${last.time}まで${event.availableFollowup}営業日を観測。${observed ? `③ ${event.endDate}に${resultLabel}、${event.duration}営業日後。` : "結果は未成立または未確定。"}`}>
        <div ref={containerRef} />
        <div className="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
          <div ref={pastBandRef} data-window="lookback" className="absolute top-0 border-x border-blue-500 bg-blue-500/10" />
          <div ref={futureBandRef} data-window="followup" className="absolute top-0 border-r border-amber-600 bg-amber-500/10" />
          <div ref={originRef} data-window="origin" className="absolute top-0 border-l-2 border-dashed border-blue-700" />
        </div>
      </div>
      <p className="text-xs text-gray-500">黒線は取得済みの終値です。L営業日の騰落率はL+1本の終値の両端で計算します。橙色は0日目を左端の境界として、その翌日から調べる区間を示します。
        {isPeak ? " ③の最高終値日は④のH日目まで観測してから確定します。" : " ③で条件が成立しても、④の追跡上限は設定したH日のままです。"}
        {!completeWindow && " ④はデータ末尾です。未観測のH日目の日付や価格は補っていません。"}
      </p>
    </div>
  );
}
