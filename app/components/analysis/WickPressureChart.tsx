"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { createChart, LineSeries, BaselineSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeWickPressure } from "../../lib/wick-pressure";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const WINDOWS = [5, 10, 20];

export default function WickPressureChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const [window_, setWindow] = useState(10);

  const series = useMemo(() => computeWickPressure(prices, window_), [prices, window_]);
  const latest = series.length ? series[series.length - 1] : null;

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
    const base = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: 0 },
      topLineColor: "#16a34a", topFillColor1: "rgba(22,163,74,0.2)", topFillColor2: "rgba(22,163,74,0.02)",
      bottomLineColor: "#dc2626", bottomFillColor1: "rgba(220,38,38,0.02)", bottomFillColor2: "rgba(220,38,38,0.2)",
      lineWidth: 2,
    });
    base.setData(series.map((p) => ({ time: p.time as Time, value: p.rollAsym })));
    const clv = chart.addSeries(LineSeries, { color: "#6b7280", lineWidth: 1, lineStyle: 2, title: "CLV(引けの強さ)" });
    clv.setData(series.map((p) => ({ time: p.time as Time, value: p.clvRoll })));
    chart.timeScale().fitContent();
    const onResize = () => chartRef.current && chart.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); apiRef.current = null; };
  }, [series]);

  if (prices.length < 30) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">髭非対称・圧力指標の時系列（買い圧/売り圧）</h3>
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span>窓:</span>
          {WINDOWS.map((w) => (
            <button key={w} onClick={() => setWindow(w)} className={`px-2 py-0.5 rounded ${window_ === w ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{w}日</button>
          ))}
        </div>
      </div>

      {latest && (
        <div className={`rounded-md border px-3 py-2 text-xs ${latest.rollAsym >= 0 ? "border-green-200 bg-green-50 text-green-900" : "border-red-200 bg-red-50 text-red-900"}`}>
          現在の圧力（{window_}日平均）: <span className="font-bold">{latest.rollAsym >= 0 ? "買い圧優勢" : "売り圧優勢"}</span>
          （{latest.rollAsym.toFixed(3)}）。下ヒゲ優勢＝安値を買われている／上ヒゲ優勢＝高値を売られている。
        </div>
      )}

      <div ref={chartRef} className="w-full rounded border border-gray-100" />
      <div className="text-xs text-gray-500">緑=買い圧（下ヒゲ優勢） / 赤=売り圧（上ヒゲ優勢） / 灰点線=CLV（引けの強さ）</div>

      <AnalysisGuide title="髭非対称・圧力指標の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"ローソク足の上ヒゲ・下ヒゲの長さの偏りから、日々の『買い圧 vs 売り圧』を測り、その推移を追う。上ヒゲが長い＝高値で売られた（売り圧）、下ヒゲが長い＝安値で買い戻された（買い圧）。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>髭非対称</strong>: (下ヒゲ − 上ヒゲ) / レンジ。下ヒゲ=min(O,C)−L、上ヒゲ=H−max(O,C)、レンジ=H−L。+で買い圧、−で売り圧。</li>
          <li><strong>ローリング平均</strong>: 直近window日の平均でノイズを均す。</li>
          <li><strong>CLV</strong>: (2C−H−L)/(H−L)。引けがレンジ上部(+1)か下部(−1)か。引けの強さ。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>緑（買い圧）が続く＝押し目で買いが入りやすい局面。下落途中で買い圧に転じれば反転の兆し。</li>
          <li>赤（売り圧）が続く＝戻り売り優勢。上昇途中で売り圧に転じれば天井警戒。</li>
          <li>CLVと圧力が揃って上向き＝強い買い需要。乖離（価格上昇でも売り圧）はダイバージェンスで反転警戒。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ヒゲは日中の一時的な行き過ぎを反映し、ストップ狩り等のノイズも含む。</li>
          <li>窓（ギャップ）が大きい日はヒゲの解釈が変わる。</li>
          <li>圧力指標は方向のヒント。単独でなくトレンド・出来高と併用する。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
