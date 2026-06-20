"use client";

import { useEffect, useRef, useMemo } from "react";
import { createChart, HistogramSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeRVOL } from "../../lib/volume-indicators";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function RelativeVolumeChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const series = useMemo(() => computeRVOL(prices, 20), [prices]);
  const latest = series.length ? series[series.length - 1] : null;
  const surges = series.filter((p) => p.z >= 2).length;

  useEffect(() => {
    if (!chartRef.current || series.length < 2) return;
    if (apiRef.current) apiRef.current.remove();
    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth, height: 220,
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;
    const hist = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" } });
    hist.setData(series.map((p) => ({
      time: p.time as Time,
      value: p.rvol,
      color: p.z >= 2 ? "#dc2626" : p.z >= 1 ? "#f59e0b" : p.z <= -1 ? "#93c5fd" : "#d1d5db",
    })));
    chart.timeScale().fitContent();
    const onResize = () => chartRef.current && chart.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); apiRef.current = null; };
  }, [series]);

  if (prices.length < 30) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">相対出来高 RVOL（出来高の枯渇/急増）</h3>

      {latest && (
        <div className={`rounded-md border px-3 py-2 text-xs ${latest.z >= 2 ? "border-red-200 bg-red-50 text-red-900" : latest.z <= -1 ? "border-blue-200 bg-blue-50 text-blue-900" : "border-gray-200 bg-gray-50 text-gray-700"}`}>
          現在 RVOL = <span className="font-bold">{latest.rvol.toFixed(2)}倍</span>（Z={latest.z.toFixed(1)}）
          {latest.z >= 2 ? "＝異常な出来高急増" : latest.z <= -1 ? "＝出来高枯渇" : "＝平常"}。
          過去に Z≥2 の急増日が {surges} 回。
        </div>
      )}

      <div ref={chartRef} className="w-full rounded border border-gray-100" />
      <div className="text-xs text-gray-500">赤=急増(Z≥2) / 橙=やや多(Z≥1) / 灰=平常 / 青=枯渇(Z≤-1)。基準=1.0倍（20日平均）</div>

      <AnalysisGuide title="相対出来高(RVOL)の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"出来高の『多い/少ない』を絶対量でなく過去平均との比で見る。RVOL＝当日出来高÷20日平均出来高。1を超えれば平均より活発、Zスコアで異常度を測る。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>RVOL_t = V_t / mean(V, 過去20日)。Z = (V_t − mean)/std。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>急増（Z≥2）＝転換・ブレイク・ニュースの予兆。値動きの信頼度が上がる（出来高を伴うブレイクは本物になりやすい）。</li>
          <li>枯渇（Z≤−1）＝関心低下・レンジ膠着。ブレイク前の収縮であることも。</li>
          <li>価格の動きと出来高を併せて判断（出来高なきブレイクはだましになりやすい）。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>イベント（決算・配当落ち・指数入替）で機械的に急増する。背景の確認を。</li>
          <li>長期の出来高トレンド（上場来の増減）があると基準がずれる。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
