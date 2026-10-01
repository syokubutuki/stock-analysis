"use client";

// 待機資金を含む日次の資産曲線（戦略 vs 同じ日・同じ初期資金の買い持ち）。横軸は日付なので lightweight-charts。

import { useEffect, useRef } from "react";
import { createChart, LineSeries, type Time } from "lightweight-charts";
import { CHART_COLORS, EVENT_WINDOW_COLORS } from "../../lib/chart-colors";

interface Props {
  points: { date: string; strategy: number; buyHold: number }[];
  strategyLabel: string;
  ariaLabel: string;
  height?: number;
}

export default function NdayMoveEquityChart({ points, strategyLabel, ariaLabel, height = 260 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || points.length === 0) return;
    const chart = createChart(container, {
      width: container.clientWidth,
      height,
      layout: { background: { color: CHART_COLORS.surface }, textColor: CHART_COLORS.ink },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      timeScale: { timeVisible: false, borderColor: CHART_COLORS.axis },
      rightPriceScale: { borderColor: CHART_COLORS.axis },
      crosshair: { mode: 0 },
      localization: { priceFormatter: (v: number) => `${Math.round(v).toLocaleString("ja-JP")}` },
    });
    const bh = chart.addSeries(LineSeries, { color: CHART_COLORS.neutral, lineWidth: 1, lineStyle: 2, title: "買い持ち", priceLineVisible: false });
    bh.setData(points.map((p) => ({ time: p.date as Time, value: p.buyHold })));
    const st = chart.addSeries(LineSeries, { color: EVENT_WINDOW_COLORS.lookback, lineWidth: 2, title: strategyLabel, priceLineVisible: false });
    st.setData(points.map((p) => ({ time: p.date as Time, value: p.strategy })));
    chart.timeScale().fitContent();
    const observer = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth }));
    observer.observe(container);
    return () => { observer.disconnect(); chart.remove(); };
  }, [points, strategyLabel, height]);

  if (points.length === 0) return <p className="rounded bg-gray-50 p-3 text-xs text-gray-600">資産曲線を描ける期間がありません。</p>;
  return (
    <div>
      <div className="mb-1 flex flex-wrap gap-3 text-xs text-gray-700">
        <span><span className="mr-1 inline-block h-0.5 w-5 align-middle" style={{ background: EVENT_WINDOW_COLORS.lookback }} />{strategyLabel}（待機資金を含む）</span>
        <span><span className="mr-1 inline-block w-5 border-t-2 border-dashed align-middle" style={{ borderColor: CHART_COLORS.neutral }} />買い持ち（同じ日・同じ初期資金）</span>
      </div>
      <div ref={containerRef} className="overflow-hidden rounded border border-gray-200" role="img" aria-label={ariaLabel} />
    </div>
  );
}
