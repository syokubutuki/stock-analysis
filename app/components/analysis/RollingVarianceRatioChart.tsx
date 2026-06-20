"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { createChart, LineSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { rollingVarianceRatio } from "../../lib/rolling-variance-ratio";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const QS = [2, 5, 10, 21];

export default function RollingVarianceRatioChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const [q, setQ] = useState(5);

  const series = useMemo(() => rollingVarianceRatio(prices, q, 126), [prices, q]);
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
    const vr = chart.addSeries(LineSeries, { color: "#7c3aed", lineWidth: 2, title: `VR(${q})` });
    vr.setData(series.map((p) => ({ time: p.time as Time, value: p.vr })));
    const one = chart.addSeries(LineSeries, { color: "#9ca3af", lineWidth: 1, title: "RW=1" });
    one.setData(series.map((p) => ({ time: p.time as Time, value: 1 })));
    for (const key of ["upper", "lower"] as const) {
      const b = chart.addSeries(LineSeries, { color: "#d1d5db", lineWidth: 1, lineStyle: 2 });
      b.setData(series.map((p) => ({ time: p.time as Time, value: p[key] })));
    }
    chart.timeScale().fitContent();
    const onResize = () => chartRef.current && chart.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); apiRef.current = null; };
  }, [series, q]);

  if (prices.length < 150) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">分散比のローリングと有意性（トレンド/回帰の切替監視）</h3>
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span>q:</span>
          {QS.map((v) => (
            <button key={v} onClick={() => setQ(v)} className={`px-2 py-0.5 rounded ${q === v ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{v}</button>
          ))}
        </div>
      </div>

      {latest && (
        <div className={`rounded-md border px-3 py-2 text-xs ${Math.abs(latest.z) > 1.96 ? (latest.vr > 1 ? "border-green-200 bg-green-50 text-green-900" : "border-red-200 bg-red-50 text-red-900") : "border-gray-200 bg-gray-50 text-gray-700"}`}>
          現在 VR({q}) = <span className="font-bold">{latest.vr.toFixed(2)}</span>（z={latest.z.toFixed(1)}）
          {Math.abs(latest.z) > 1.96
            ? latest.vr > 1 ? "＝有意にトレンド（順張り優位）" : "＝有意に平均回帰（逆張り優位）"
            : "＝ランダムウォークと区別できない"}
        </div>
      )}

      <div ref={chartRef} className="w-full rounded border border-gray-100" />
      <div className="text-xs text-gray-500">紫=VR / 灰実線=1(ランダムウォーク) / 灰点線=95%信頼帯。帯の外＝有意</div>

      <AnalysisGuide title="分散比検定の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"価格がランダムウォーク（予測不能）か、トレンド（勢いが続く）か、平均回帰（行き過ぎが戻る）かを、リターンの分散の伸び方から判定し、その状態の時間推移を追う。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>VR(q)</strong> = Var(q期間リターン) / (q × Var(1期間リターン))。</li>
          <li>独立なら q期間の分散は1期間の q倍 → VR≈1。VR&gt;1＝正の自己相関（トレンド）、VR&lt;1＝負の自己相関（平均回帰）。</li>
          <li>有意性: 漸近標準誤差 σ=√(2(2q−1)(q−1)/(3qN))。z=(VR−1)/σ。|z|&gt;1.96 で5%有意。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>VRが帯の上に有意に出る局面＝順張り（ブレイク・モメンタム）戦略が機能しやすい。</li>
          <li>VRが帯の下＝逆張り（平均回帰）が機能しやすい。</li>
          <li>1付近を行き来＝効率的でエッジが薄い。戦略の切替タイミングの判断に。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>本実装は同分散仮定の簡易版。ボラ変動が大きい局面では不均一分散頑健版が望ましい。</li>
          <li>ローリング窓の長さで感度が変わる。窓が短いと不安定。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
