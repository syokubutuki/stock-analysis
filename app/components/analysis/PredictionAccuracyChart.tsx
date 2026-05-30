"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computePredictionAccuracy } from "../../lib/predictability";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; seriesMode?: string; }

export default function PredictionAccuracyChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const result = useMemo(() => computePredictionAccuracy(prices), [prices]);

  useEffect(() => {
    if (!chartRef.current || result.dates.length === 0) return;
    const chart = createChart(chartRef.current, {
      width: chartRef.current.clientWidth, height: 300,
      layout: { textColor: "#374151", fontSize: 11 },
      grid: { vertLines: { color: "#f3f4f6" }, horzLines: { color: "#f3f4f6" } },
      rightPriceScale: { borderColor: "#e5e7eb" }, timeScale: { borderColor: "#e5e7eb" },
    });
    apiRef.current = chart;

    const s1 = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 2, title: "ACF方向予測" });
    const s2 = chart.addSeries(LineSeries, { color: "#10b981", lineWidth: 2, title: "リバージョン" });
    const s3 = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 2, title: "モメンタム" });

    const toData = (vals: number[]) => result.dates.map((t, i) => ({ time: t as Time, value: vals[i] * 100 })).filter(d => d.value > 0);
    s1.setData(toData(result.acfDirectionAccuracy));
    s2.setData(toData(result.meanReversionAccuracy));
    s3.setData(toData(result.momentumAccuracy));
    chart.timeScale().fitContent();

    const h = () => { if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth }); };
    window.addEventListener("resize", h);
    return () => { window.removeEventListener("resize", h); chart.remove(); apiRef.current = null; };
  }, [result]);

  if (result.dates.length === 0) return null;

  // Latest values
  const last = (arr: number[]) => { for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] > 0) return arr[i]; } return 0; };
  const acfLast = last(result.acfDirectionAccuracy);
  const mrLast = last(result.meanReversionAccuracy);
  const momLast = last(result.momentumAccuracy);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">ローリング予測精度</h3>
      <p className="text-xs text-gray-500">3つの単純予測ルールの60日ローリング的中率。50%線が偶然の基準。</p>

      <div ref={chartRef} />

      <div className="grid grid-cols-3 gap-2 text-xs">
        {[
          { label: "ACF方向予測", value: acfLast, color: "#3b82f6", desc: "ACF(1)の符号で翌日方向を予測" },
          { label: "リバージョン", value: mrLast, color: "#10b981", desc: "|r|>1σの翌日に逆方向を予測" },
          { label: "モメンタム", value: momLast, color: "#f59e0b", desc: "5日トレンド方向を翌日に予測" },
        ].map(item => (
          <div key={item.label} className="p-2 bg-gray-50 rounded border border-gray-200">
            <div className="text-gray-500">{item.label}</div>
            <div className="font-mono font-bold text-lg" style={{ color: item.color }}>{(item.value * 100).toFixed(1)}%</div>
            <div className="text-[10px] text-gray-400 mt-0.5">{item.desc}</div>
          </div>
        ))}
      </div>

      <div className={`p-3 rounded text-xs ${Math.max(acfLast, mrLast, momLast) > 0.55 ? "bg-green-50 text-green-800" : "bg-gray-50 text-gray-700"}`}>
        <div className="font-medium mb-1">予測可能性の判定</div>
        <p>
          {Math.max(acfLast, mrLast, momLast) > 0.55
            ? `直近60日間で${acfLast > mrLast && acfLast > momLast ? "ACF方向予測" : mrLast > momLast ? "リバージョン" : "モメンタム"}が55%超の的中率。一定の予測可能性が存在する可能性。`
            : "全手法が50%近辺。直近の市場は効率的で、単純なルールでは予測困難。"}
          ただし60日の短期サンプルであり、統計的に有意とは限りません。
        </p>
      </div>

      <AnalysisGuide title="ローリング予測精度の詳細理論">
        <p className="font-medium text-gray-700">1. 3つの予測ルール</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ACF方向予測</strong>: {"ローリング60日のACF(1)を計算。ACF(1)>0なら今日と同方向、ACF(1)<0なら逆方向を翌日に予測。ACFベースの線形予測の検証。"}</li>
          <li><strong>ミーンリバージョン</strong>: {"今日のリターンが±1σを超えた場合に逆方向を予測。条件を満たさない日は予測しない。逆張り戦略の有効性検証。"}</li>
          <li><strong>モメンタム</strong>: {"過去5日の累積リターンの符号を翌日に予測。トレンドフォロー戦略の有効性検証。"}</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">2. 50%ベンチマーク</p>
        <p>完全にランダムなリターン（iid）の場合、方向予測の的中率は50%に収束します。50%から有意に離れていれば、何らかの予測可能なパターンが存在します。</p>
        <p className="font-medium text-gray-700 mt-3">3. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>60日窓は短いため、統計的なノイズが大きい。一時的に60%を超えても偶然の可能性がある。</li>
          <li>{"有意性の目安: 60日サンプルで5%有意なのは 50% ± 1.96×√(0.25/60) ≈ 50% ± 12.6%。つまり37.4%以下か62.6%以上が統計的に有意。"}</li>
          <li>取引コストを考慮すると、55%程度の精度では利益を出すのが困難な場合がある。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
