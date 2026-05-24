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
  computeGapSeries,
  computeGapStats,
  computeCumulativeReturns,
} from "../../lib/gap-analysis";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function GapAnalysisChart({ prices }: Props) {
  const gapChartRef = useRef<HTMLDivElement>(null);
  const cumChartRef = useRef<HTMLDivElement>(null);
  const gapApiRef = useRef<IChartApi | null>(null);
  const cumApiRef = useRef<IChartApi | null>(null);

  const gaps = useMemo(() => computeGapSeries(prices), [prices]);
  const stats = useMemo(() => computeGapStats(prices, gaps), [prices, gaps]);
  const cumReturns = useMemo(() => computeCumulativeReturns(gaps), [gaps]);

  // ギャップヒストグラム
  useEffect(() => {
    if (!gapChartRef.current || gaps.length < 2) return;
    if (gapApiRef.current) gapApiRef.current.remove();

    const chart = createChart(gapChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: gapChartRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    gapApiRef.current = chart;

    const overnightSeries = chart.addSeries(HistogramSeries, {
      title: "夜間リターン",
      priceScaleId: "right",
    });
    overnightSeries.setData(
      gaps.map((g) => ({
        time: g.time as Time,
        value: g.overnightReturn * 100,
        color:
          g.overnightReturn >= 0
            ? "rgba(59, 130, 246, 0.6)"
            : "rgba(239, 83, 80, 0.6)",
      }))
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (gapChartRef.current)
        chart.applyOptions({ width: gapChartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      gapApiRef.current = null;
    };
  }, [gaps]);

  // 累積リターン分解チャート
  useEffect(() => {
    if (!cumChartRef.current || cumReturns.length < 2) return;
    if (cumApiRef.current) cumApiRef.current.remove();

    const chart = createChart(cumChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: cumChartRef.current.clientWidth,
      height: 220,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    cumApiRef.current = chart;

    const totalSeries = chart.addSeries(LineSeries, {
      color: "#6b7280",
      lineWidth: 2,
      title: "全体",
    });
    totalSeries.setData(
      cumReturns.map((c) => ({
        time: c.time as Time,
        value: c.total * 100,
      }))
    );

    const overnightSeries = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      title: "夜間累積",
    });
    overnightSeries.setData(
      cumReturns.map((c) => ({
        time: c.time as Time,
        value: c.overnight * 100,
      }))
    );

    const intradaySeries = chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 2,
      title: "日中累積",
    });
    intradaySeries.setData(
      cumReturns.map((c) => ({
        time: c.time as Time,
        value: c.intraday * 100,
      }))
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (cumChartRef.current)
        chart.applyOptions({ width: cumChartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      cumApiRef.current = null;
    };
  }, [cumReturns]);

  const pct = (v: number) => (v * 100).toFixed(4);
  const pct2 = (v: number) => (v * 100).toFixed(1);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">
        ギャップ・日中/夜間リターン分解
      </h3>

      {/* 統計サマリー */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-4">
        <StatBox
          label="夜間リターン (平均)"
          value={`${pct(stats.overnightMean)}%`}
          sub={`σ: ${pct(stats.overnightStd)}%`}
        />
        <StatBox
          label="日中リターン (平均)"
          value={`${pct(stats.intradayMean)}%`}
          sub={`σ: ${pct(stats.intradayStd)}%`}
        />
        <StatBox
          label="夜間寄与率"
          value={`${pct2(stats.overnightContribution)}%`}
          sub={`日中: ${pct2(stats.intradayContribution)}%`}
          highlight={Math.abs(stats.overnightContribution) > 0.6}
        />
        <StatBox
          label="夜間↔日中 相関"
          value={stats.correlation.toFixed(3)}
          sub={
            stats.correlation < -0.3
              ? "逆相関 (ギャップ反転傾向)"
              : stats.correlation > 0.3
              ? "正相関 (ギャップ継続傾向)"
              : "低相関"
          }
          highlight={Math.abs(stats.correlation) > 0.3}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-4">
        <StatBox
          label="ギャップアップ"
          value={`${stats.gapUpCount}日`}
          sub={`${pct2(stats.gapUpCount / stats.count)}%`}
        />
        <StatBox
          label="ギャップダウン"
          value={`${stats.gapDownCount}日`}
          sub={`${pct2(stats.gapDownCount / stats.count)}%`}
        />
        <StatBox
          label="ギャップフィル率"
          value={`${pct2(stats.gapFillRate)}%`}
          sub="ギャップが当日中に埋まった割合"
        />
        <StatBox
          label="寄付き天井 / 底"
          value={`${pct2(stats.openHighRate)}% / ${pct2(stats.openLowRate)}%`}
          sub="open≈high / open≈low"
        />
      </div>

      {/* 夜間リターンヒストグラム */}
      <div className="mb-2 text-xs text-gray-500 font-medium">
        夜間リターン (open[t] vs close[t-1])
      </div>
      <div
        ref={gapChartRef}
        className="w-full rounded border border-gray-100 mb-4"
      />

      {/* 累積リターン分解 */}
      <div className="mb-2 text-xs text-gray-500 font-medium">
        累積リターン分解 (
        <span className="text-gray-500">全体</span> ={" "}
        <span className="text-blue-500">夜間</span> +{" "}
        <span className="text-amber-500">日中</span>)
      </div>
      <div
        ref={cumChartRef}
        className="w-full rounded border border-gray-100"
      />

      <AnalysisGuide title="ギャップ分析の読み方">
        <p>
          <span className="font-medium">夜間リターン (Overnight Return):</span>{" "}
          前日終値から当日始値への変動 ln(open[t]/close[t-1])。
          決算発表・海外市場・ニュースなど、ザラ場外の情報インパクトを反映します。
        </p>
        <p>
          <span className="font-medium">日中リターン (Intraday Return):</span>{" "}
          当日始値から当日終値への変動 ln(close[t]/open[t])。
          ザラ場中の売買圧力を反映します。
        </p>
        <p>
          <span className="font-medium">累積リターン分解:</span>{" "}
          全体リターン = 夜間 + 日中 に分解して、リターンの源泉がどちらにあるかを可視化します。
          多くの銘柄で夜間リターンが全体リターンの大部分を占めることが知られています。
        </p>
        <p>
          <span className="font-medium">夜間↔日中の相関:</span>{" "}
          負の相関は「ギャップアップ後に日中で下落する（反転）」パターンを示唆します。
          正の相関は「ギャップの方向に日中も動く（継続）」パターンです。
        </p>
        <p>
          <span className="font-medium">ギャップフィル率:</span>{" "}
          ギャップアップ後に安値が前日終値まで下がった（またはギャップダウン後に高値が前日終値まで上がった）割合です。
          高いフィル率は逆張り戦略の有効性を示唆します。
        </p>
        <p>
          <span className="font-medium">寄付き天井/底:</span>{" "}
          始値がその日の高値付近（天井）or 安値付近（底）である割合です。
          寄付き天井が多い銘柄は寄り付き後に下落しやすく、寄付き底が多い銘柄は上昇しやすい傾向があります。
        </p>
      </AnalysisGuide>
    </div>
  );
}

function StatBox({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div className="p-2 bg-gray-50 rounded">
      <div className="text-gray-500">{label}</div>
      <div
        className={`font-mono font-medium ${
          highlight ? "text-blue-600" : ""
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}
