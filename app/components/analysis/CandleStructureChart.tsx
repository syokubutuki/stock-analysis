"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeCandleMetrics,
  computeCandleStats,
  rollingCandleStats,
} from "../../lib/candle-structure";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function CandleStructureChart({ prices }: Props) {
  const bodyChartRef = useRef<HTMLDivElement>(null);
  const posChartRef = useRef<HTMLDivElement>(null);
  const bodyApiRef = useRef<IChartApi | null>(null);
  const posApiRef = useRef<IChartApi | null>(null);

  const metrics = useMemo(() => computeCandleMetrics(prices), [prices]);
  const stats = useMemo(() => computeCandleStats(metrics), [metrics]);
  const rolling = useMemo(() => rollingCandleStats(metrics, 20), [metrics]);

  // 実体率ヒストグラム
  useEffect(() => {
    if (!bodyChartRef.current || metrics.length < 2) return;
    if (bodyApiRef.current) bodyApiRef.current.remove();

    const chart = createChart(bodyChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: bodyChartRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    bodyApiRef.current = chart;

    const series = chart.addSeries(HistogramSeries, { title: "実体率" });
    series.setData(
      metrics.map((m) => ({
        time: m.time as Time,
        value: m.bodyRatio * 100,
        color: m.isBullish
          ? "rgba(38, 166, 154, 0.6)"
          : "rgba(239, 83, 80, 0.6)",
      }))
    );

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (bodyChartRef.current)
        chart.applyOptions({ width: bodyChartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      bodyApiRef.current = null;
    };
  }, [metrics]);

  // 終値位置 (ローリング)
  useEffect(() => {
    if (!posChartRef.current || rolling.length < 2) return;
    if (posApiRef.current) posApiRef.current.remove();

    const chart = createChart(posChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: posChartRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    posApiRef.current = chart;

    const posSeries = chart.addSeries(LineSeries, {
      color: "#6366f1",
      lineWidth: 2,
      title: "終値位置 (20日MA)",
    });
    posSeries.setData(
      rolling.map((r) => ({
        time: r.time as Time,
        value: r.closePositionMA * 100,
      }))
    );

    const bodySeries = chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 1,
      title: "実体率 (20日MA)",
    });
    bodySeries.setData(
      rolling.map((r) => ({
        time: r.time as Time,
        value: r.bodyRatioMA * 100,
      }))
    );

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (posChartRef.current)
        chart.applyOptions({ width: posChartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      posApiRef.current = null;
    };
  }, [rolling]);

  const pct = (v: number) => (v * 100).toFixed(1);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">ローソク足構造分析</h3>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs mb-4">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均実体率</div>
          <div className="font-mono font-medium">{pct(stats.avgBodyRatio)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均上ヒゲ率</div>
          <div className="font-mono font-medium">{pct(stats.avgUpperShadow)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均下ヒゲ率</div>
          <div className="font-mono font-medium">{pct(stats.avgLowerShadow)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">陽線率</div>
          <div className="font-mono font-medium">{pct(stats.bullishRate)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">終値位置 (平均)</div>
          <div className="font-mono font-medium">{pct(stats.avgClosePosition)}%</div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs mb-4">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">大陽線</div>
          <div className="font-mono font-medium">{stats.bigBullishCount}日</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">大陰線</div>
          <div className="font-mono font-medium">{stats.bigBearishCount}日</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">十字線</div>
          <div className="font-mono font-medium">{stats.dojiCount}日</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">上ヒゲ優勢</div>
          <div className="font-mono font-medium">{stats.upperDominantCount}日</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">下ヒゲ優勢</div>
          <div className="font-mono font-medium">{stats.lowerDominantCount}日</div>
        </div>
      </div>

      <div className="mb-2 text-xs text-gray-500 font-medium">
        実体率 (陽線: 緑, 陰線: 赤)
      </div>
      <div ref={bodyChartRef} className="w-full rounded border border-gray-100 mb-4" />

      <div className="mb-2 text-xs text-gray-500 font-medium">
        <span className="text-indigo-500">終値位置</span> /{" "}
        <span className="text-amber-500">実体率</span> (20日移動平均, %)
      </div>
      <div ref={posChartRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="ローソク足構造の読み方">
        <p>
          <span className="font-medium">実体率:</span>{" "}
          |close-open| / (high-low)。大きいほど方向性が明確。70%超は大陽線/大陰線、10%未満は十字線。
        </p>
        <p>
          <span className="font-medium">上ヒゲ率 / 下ヒゲ率:</span>{" "}
          上ヒゲが長いほど上値での売り圧力が強く、下ヒゲが長いほど下値での買い支えが強い。
        </p>
        <p>
          <span className="font-medium">終値位置:</span>{" "}
          (close-low)/(high-low)。1に近いほど高値引け、0に近いほど安値引け。
          20日MAが50%を大きく上回る場合は買い圧力が優勢、下回る場合は売り圧力が優勢。
        </p>
        <p>
          <span className="font-medium">大陽線/大陰線:</span>{" "}
          実体率70%超の足。トレンドの勢いを示す。連続する場合は強いモメンタム。
        </p>
        <p>
          <span className="font-medium">十字線:</span>{" "}
          実体率10%未満。売り買いが拮抗しており、トレンド転換の兆候となることがある。
        </p>
      </AnalysisGuide>
    </div>
  );
}
