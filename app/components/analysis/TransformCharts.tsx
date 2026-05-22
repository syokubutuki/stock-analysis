"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  logReturns,
  rankTransform,
  volNormalizedReturns,
} from "../../lib/transforms";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

type TransformMode = "logReturn" | "rank" | "volNorm";

const MODE_LABELS: Record<TransformMode, string> = {
  logReturn: "対数リターン",
  rank: "順位変換",
  volNorm: "ボラ正規化",
};

export default function TransformCharts({ prices }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [mode, setMode] = useState<TransformMode>("logReturn");

  const closes = prices.map((p) => p.close);
  const times = prices.map((p) => p.time);

  useEffect(() => {
    if (!containerRef.current || closes.length < 2) return;

    if (chartRef.current) chartRef.current.remove();

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 220,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    let data: number[] = [];
    let dataTimesArr: string[] = [];

    if (mode === "logReturn") {
      data = logReturns(closes);
      dataTimesArr = times.slice(1);
    } else if (mode === "rank") {
      const lr = logReturns(closes);
      data = rankTransform(lr);
      dataTimesArr = times.slice(1);
    } else {
      data = volNormalizedReturns(closes, 20);
      dataTimesArr = times.slice(1);
    }

    if (mode === "logReturn" || mode === "volNorm") {
      const series = chart.addSeries(HistogramSeries, {
        title: MODE_LABELS[mode],
      });
      series.setData(
        data.map((v, i) => ({
          time: dataTimesArr[i] as Time,
          value: v,
          color: v >= 0 ? "rgba(38, 166, 154, 0.6)" : "rgba(239, 83, 80, 0.6)",
        }))
      );
    } else {
      const series = chart.addSeries(LineSeries, {
        color: "#6366f1",
        lineWidth: 1,
        title: MODE_LABELS[mode],
      });
      series.setData(
        data.map((v, i) => ({
          time: dataTimesArr[i] as Time,
          value: v,
        }))
      );
    }

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current)
        chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [prices, mode]);

  // 統計情報
  const lr = logReturns(closes);
  const mean = lr.length > 0 ? lr.reduce((a, b) => a + b, 0) / lr.length : 0;
  const std = lr.length > 0
    ? Math.sqrt(lr.reduce((a, v) => a + (v - mean) ** 2, 0) / lr.length)
    : 0;
  const skew = lr.length > 0 && std > 0
    ? lr.reduce((a, v) => a + ((v - mean) / std) ** 3, 0) / lr.length
    : 0;
  const kurt = lr.length > 0 && std > 0
    ? lr.reduce((a, v) => a + ((v - mean) / std) ** 4, 0) / lr.length - 3
    : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">スケール・変換</h3>
        <div className="flex gap-1">
          {(Object.keys(MODE_LABELS) as TransformMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2 py-1 text-xs rounded font-medium transition-colors ${
                mode === m
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      <div ref={containerRef} className="w-full rounded border border-gray-100" />

      <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均リターン</div>
          <div className="font-mono font-medium">{(mean * 100).toFixed(4)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">標準偏差</div>
          <div className="font-mono font-medium">{(std * 100).toFixed(4)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">歪度</div>
          <div className={`font-mono font-medium ${Math.abs(skew) > 0.5 ? "text-orange-600" : ""}`}>
            {skew.toFixed(3)}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">尖度(超過)</div>
          <div className={`font-mono font-medium ${kurt > 1 ? "text-red-600" : ""}`}>
            {kurt.toFixed(3)}
          </div>
        </div>
      </div>

      <AnalysisGuide title="スケール変換の読み方">
        <p><span className="font-medium">対数リターン (Log Return):</span> {"ln(P_t / P_{t-1})"} で計算される対数差分です。通常の変化率と異なり、加法的に積み上がる性質があります(例: 2日間のリターン = 1日目 + 2日目)。金融工学の標準的な尺度であり、正規分布の仮定との相性が良いとされます。</p>
        <p><span className="font-medium">順位変換 (Rank Transform):</span> 各日のリターンを全期間中での相対的な順位(0〜1)に変換します。外れ値の影響を完全に排除でき、分布の形状に依存しないノンパラメトリックな分析が可能です。0.5付近が中央値で、1に近いほど高リターンの日です。</p>
        <p><span className="font-medium">ボラティリティ正規化リターン:</span> 各日のリターンを直近20日間の標準偏差で割ったものです。「ボラティリティが高い時期の1%」と「低い時期の1%」を同じ尺度で比較できます。±2を超える値は統計的に異常な動き(約5%の確率)を意味します。</p>
        <p><span className="font-medium">統計指標の見方:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">平均リターン:</span> 期間中の1日あたり平均収益率。年率換算は × 252(営業日数)。</li>
          <li><span className="font-medium">標準偏差:</span> リスクの大きさ。年率換算は × √252。日次で1%を超えるとボラティリティが高い銘柄。</li>
          <li><span className="font-medium">歪度(Skewness):</span> 分布の非対称性。負の歪度は大きな下落が起きやすい(ファットテール)。正の歪度は大きな上昇が起きやすい。絶対値が0.5を超えると有意な偏り。</li>
          <li><span className="font-medium">尖度(Kurtosis, 超過):</span> 分布の裾の厚さ。正規分布なら0。正の値が大きいほど極端な値動きが多い。株式リターンは典型的に正の超過尖度を示し、3〜10程度が一般的です。尖度が高い時期は、リスク管理を厳格にすべきです。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
