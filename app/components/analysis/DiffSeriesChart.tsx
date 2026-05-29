"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeDiffSeries,
  computeDiffSeriesPercent,
  computeDiffStats,
  type DiffStats,
} from "../../lib/diff-series";
import AnalysisGuide from "./AnalysisGuide";
import { setInitialVisibleRange } from "../../lib/chart-visible-range";
import type { PeriodKey } from "../../hooks/useAnalysisData";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

type DiffMode = "absolute" | "percent";

export default function DiffSeriesChart({ prices, period }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<Map<string, ISeriesApi<"Histogram">>>(new Map());
  const [activeLags, setActiveLags] = useState<Set<number>>(new Set([1]));
  const [mode, setMode] = useState<DiffMode>("absolute");
  const [stats, setStats] = useState<DiffStats[]>([]);

  const LAGS = [1, 2, 3];
  const COLORS: Record<number, { positive: string; negative: string; line: string }> = {
    1: { positive: "rgba(38, 166, 154, 0.6)", negative: "rgba(239, 83, 80, 0.6)", line: "#26a69a" },
    2: { positive: "rgba(66, 133, 244, 0.6)", negative: "rgba(251, 140, 0, 0.6)", line: "#4285f4" },
    3: { positive: "rgba(156, 39, 176, 0.6)", negative: "rgba(255, 193, 7, 0.6)", line: "#9c27b0" },
  };

  const toggleLag = (lag: number) => {
    setActiveLags((prev) => {
      const next = new Set(prev);
      if (next.has(lag)) {
        if (next.size > 1) next.delete(lag);
      } else {
        next.add(lag);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!containerRef.current || prices.length === 0) return;

    if (chartRef.current) {
      chartRef.current.remove();
      seriesRefs.current.clear();
    }

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: {
        vertLines: { color: "#f0f0f0" },
        horzLines: { color: "#f0f0f0" },
      },
      width: containerRef.current.clientWidth,
      height: 250,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    const computeFn = mode === "percent" ? computeDiffSeriesPercent : computeDiffSeries;
    const newStats: DiffStats[] = [];

    LAGS.forEach((lag) => {
      const diffData = computeFn(prices, lag);
      const s = computeDiffStats(diffData);
      newStats.push({ lag, ...s });

      if (!activeLags.has(lag)) return;

      const colors = COLORS[lag];
      const series = chart.addSeries(HistogramSeries, {
        priceScaleId: `diff${lag}`,
      });

      series.setData(
        diffData.map((d) => ({
          time: d.time as Time,
          value: d.value,
          color: d.value >= 0 ? colors.positive : colors.negative,
        }))
      );

      seriesRefs.current.set(`diff${lag}`, series);
    });

    setStats(newStats);
    if (period) { setInitialVisibleRange(chart, prices, period); } else { chart.timeScale().fitContent(); }

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
      seriesRefs.current.clear();
    };
  }, [prices, activeLags, mode]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">差分系列</h3>
        <div className="flex gap-2 items-center">
          <div className="flex gap-1">
            {LAGS.map((lag) => (
              <button
                key={lag}
                onClick={() => toggleLag(lag)}
                className={`px-2 py-1 text-xs rounded font-medium transition-colors ${
                  activeLags.has(lag)
                    ? "text-white"
                    : "bg-gray-100 text-gray-500"
                }`}
                style={
                  activeLags.has(lag)
                    ? { backgroundColor: COLORS[lag].line }
                    : undefined
                }
              >
                {lag}日
              </button>
            ))}
          </div>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as DiffMode)}
            className="text-xs border border-gray-300 rounded px-2 py-1"
          >
            <option value="absolute">絶対値</option>
            <option value="percent">変化率(%)</option>
          </select>
        </div>
      </div>

      <div ref={containerRef} className="w-full rounded border border-gray-100" />

      {stats.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          {stats.map((s) => (
            <div
              key={s.lag}
              className={`p-2 rounded border ${
                activeLags.has(s.lag) ? "border-gray-300 bg-gray-50" : "border-gray-100 opacity-50"
              }`}
            >
              <div className="font-medium text-gray-700 mb-1">{s.lag}日差分</div>
              <div>平均: {mode === "percent" ? `${s.mean.toFixed(3)}%` : s.mean.toFixed(1)}</div>
              <div>標準偏差: {mode === "percent" ? `${s.stdDev.toFixed(3)}%` : s.stdDev.toFixed(1)}</div>
              <div>上昇率: {(s.positiveRatio * 100).toFixed(1)}%</div>
              <div className="text-green-600">最大上昇: {mode === "percent" ? `${s.maxUp.toFixed(2)}%` : s.maxUp.toFixed(1)}</div>
              <div className="text-red-600">最大下落: {mode === "percent" ? `${s.maxDown.toFixed(2)}%` : s.maxDown.toFixed(1)}</div>
            </div>
          ))}
        </div>
      )}

      <AnalysisGuide title="差分系列の読み方">
        <p><span className="font-medium">差分系列とは:</span> 価格の変化量そのものを時系列として可視化したものです。1日差分は「前日比」、2日差分は「2日前との差」、3日差分は「3日前との差」を表します。通常のチャートでは見えにくい短期的な価格変動の構造を抽出できます。</p>
        <p><span className="font-medium">絶対値モード:</span> 価格差をそのまま表示します。株価水準が高い銘柄ほど値が大きくなるため、異なる銘柄間の比較には不向きですが、実際の円建て変動幅を直感的に把握できます。</p>
        <p><span className="font-medium">変化率(%)モード:</span> 価格差を基準価格で割ったもので、異なる株価水準の銘柄間で比較可能です。ログリターンに近い値になります。</p>
        <p><span className="font-medium">統計指標の見方:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">平均:</span> 正なら上昇バイアス、負なら下降バイアス。ゼロに近いほどトレンドなし。</li>
          <li><span className="font-medium">標準偏差:</span> 変動の大きさ(ボラティリティ)。大きいほど値動きが荒い。</li>
          <li><span className="font-medium">上昇率:</span> 差分が正の日の割合。50%から大きく乖離していればバイアスがある可能性。日本株では概ね48〜52%が典型的。</li>
          <li><span className="font-medium">最大上昇/最大下落:</span> 期間中の極端な変動。テールリスクの大きさを示す。</li>
        </ul>
        <p><span className="font-medium">トレードへの活用:</span> 2日・3日差分の平均が一方向に偏っている場合、短期的なモメンタムが存在する可能性があります。また、標準偏差が急に拡大した時期はレジーム変化(相場環境の転換)を示唆します。複数のラグを同時に表示し、パターンの一致・乖離を観察してください。</p>
      </AnalysisGuide>
    </div>
  );
}
