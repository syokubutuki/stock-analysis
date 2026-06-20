"use client";

import { useEffect, useRef, useMemo } from "react";
import { createChart, BaselineSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeSignedVolume } from "../../lib/volume-indicators";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function SignedVolumeChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const res = useMemo(() => computeSignedVolume(prices, 20), [prices]);
  const latest = res.series.length ? res.series[res.series.length - 1] : null;

  useEffect(() => {
    if (!chartRef.current || res.series.length < 2) return;
    if (apiRef.current) apiRef.current.remove();
    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth, height: 200,
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;
    const base = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: 0.5 },
      topLineColor: "#16a34a", topFillColor1: "rgba(22,163,74,0.2)", topFillColor2: "rgba(22,163,74,0.02)",
      bottomLineColor: "#dc2626", bottomFillColor1: "rgba(220,38,38,0.02)", bottomFillColor2: "rgba(220,38,38,0.2)",
      lineWidth: 2,
    });
    base.setData(res.series.map((p) => ({ time: p.time as Time, value: p.upRatio })));
    chart.timeScale().fitContent();
    const onResize = () => chartRef.current && chart.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); apiRef.current = null; };
  }, [res]);

  if (prices.length < 30) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">出来高×リターンの符号付き分析（買い需要/売り需要の質）</h3>

      {latest && (
        <div className={`rounded-md border px-3 py-2 text-xs ${latest.upRatio >= 0.5 ? "border-green-200 bg-green-50 text-green-900" : "border-red-200 bg-red-50 text-red-900"}`}>
          直近20日の上昇日出来高比率 = <span className="font-bold">{(latest.upRatio * 100).toFixed(0)}%</span>
          （{latest.upRatio >= 0.5 ? "買い需要優勢" : "売り需要優勢"}）。全期間では {(res.upVolShare * 100).toFixed(0)}%。
        </div>
      )}

      <div ref={chartRef} className="w-full rounded border border-gray-100" />
      <div className="text-xs text-gray-500">緑=上昇日出来高優勢（買い需要） / 赤=下落日出来高優勢（売り需要）。基準=50%</div>

      <AnalysisGuide title="符号付き出来高の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"同じ出来高でも、上昇日に出たのか下落日に出たのかで意味が違う。上昇日と下落日の出来高比から、買い需要と売り需要のどちらが厚いかを測る。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>上昇日出来高比率</strong>: Σ(上昇日の出来高) / Σ(全出来高)（ローリング20日）。0.5超で買い需要優勢。</li>
          <li><strong>価格効率</strong>: |価格変化| / 出来高。少ない出来高で大きく動く＝流動性が薄い/効率的。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>上昇日出来高比率が高い＝上昇に出来高が伴う健全な上げ。継続性が高い。</li>
          <li>価格が上がっているのに上昇日出来高比率が低下＝買いの勢い喪失（分配の疑い）。</li>
          <li>下落日に出来高集中＝投げ売り。セリングクライマックスなら反転の芽。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>日足の終値方向で買い/売りを近似（真の約定方向は不明）。</li>
          <li>窓やイベント日の出来高が比率を歪めることがある。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
