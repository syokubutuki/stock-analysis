"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { computeRecurrenceNetwork } from "../../lib/recurrence-network";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function RecurrenceNetworkChart({ prices, seriesMode }: Props) {
  const degreeRef = useRef<HTMLDivElement>(null);
  const clusterRef = useRef<HTMLDivElement>(null);
  const degreeChartRef = useRef<IChartApi | null>(null);
  const clusterChartRef = useRef<IChartApi | null>(null);

  const { values: lr, times } = extractSeries(prices, seriesMode);

  const rn = useMemo(() => computeRecurrenceNetwork(lr), [prices, seriesMode]);

  // Degree series
  useEffect(() => {
    if (!degreeRef.current) return;
    if (degreeChartRef.current) degreeChartRef.current.remove();
    const chart = createChart(degreeRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: degreeRef.current.clientWidth,
      height: 150,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    degreeChartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 1,
      title: "RN degree",
    });
    series.setData(
      rn.degreeSeries.slice(0, times.length).map((v, i) => ({
        time: times[i] as Time, value: v,
      }))
    );
    chart.timeScale().fitContent();
    const handleResize = () => {
      if (degreeRef.current) chart.applyOptions({ width: degreeRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); degreeChartRef.current = null; };
  }, [prices, rn]);

  // Local clustering
  useEffect(() => {
    if (!clusterRef.current) return;
    if (clusterChartRef.current) clusterChartRef.current.remove();
    const chart = createChart(clusterRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: clusterRef.current.clientWidth,
      height: 120,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    clusterChartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#06b6d4",
      lineWidth: 1,
      title: "局所CC",
    });
    series.setData(
      rn.localClustering.slice(0, times.length).map((v, i) => ({
        time: times[i] as Time, value: v,
      }))
    );
    chart.timeScale().fitContent();
    const handleResize = () => {
      if (clusterRef.current) chart.applyOptions({ width: clusterRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); clusterChartRef.current = null; };
  }, [prices, rn]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">Recurrence Network</h3>
      <p className="text-xs text-gray-500 mb-3">リカレンスプロットをグラフとして解析</p>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">クラスタリング係数</div>
          <div className="font-bold">{rn.clusteringCoeff.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">推移性</div>
          <div className="font-bold">{rn.transitivity.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均経路長</div>
          <div className="font-bold">{rn.avgPathLength.toFixed(2)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">コミュニティ数</div>
          <div className="font-bold">{rn.numCommunities}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">次数分布</div>
          <div className="font-bold">{rn.degreeDistribution.length} bins</div>
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-1">Recurrence Network 次数 (時系列)</div>
      <div ref={degreeRef} className="w-full rounded border border-gray-100 mb-2" />

      <div className="text-xs text-gray-500 mb-1">局所クラスタリング係数 (時系列)</div>
      <div ref={clusterRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="Recurrence Networkの読み方">
        <p><span className="font-medium">概要:</span> 既存のRecurrence Plotの隣接行列をグラフ(ネットワーク)として扱い、ネットワーク指標を算出します。高い次数は「多くの過去の状態に類似」＝よく訪れる状態(アトラクタの中心)を意味します。</p>
        <p><span className="font-medium">クラスタリング係数:</span> ある点の近傍同士がどれだけ接続されているか。高いと状態空間が局所的に密→安定したダイナミクス。</p>
        <p><span className="font-medium">コミュニティ:</span> Label Propagationによる簡易検出。複数のコミュニティ＝複数のレジーム(状態クラスタ)の存在を示唆。</p>
      </AnalysisGuide>
    </div>
  );
}
