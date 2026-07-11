"use client";

import { useEffect, useRef, useMemo } from "react";
import { createChart, LineSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { rollingVaR } from "../../lib/rolling-var";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";

interface Props {
  prices: PricePoint[];
}

export default function RollingVaRChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const series = useMemo(() => rollingVaR(prices, 250), [prices]);
  const latest = series.length ? series[series.length - 1] : null;

  useEffect(() => {
    if (!chartRef.current || series.length < 2) return;
    if (apiRef.current) apiRef.current.remove();
    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth, height: 240,
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;
    const add = (key: "hist95" | "cvar95" | "cf95" | "evt99", color: string, title: string, w: 1 | 2) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: w, title });
      s.setData(series.map((p) => ({ time: p.time as Time, value: p[key] * 100 })));
    };
    add("hist95", "#2563eb", "Hist VaR95", 2);
    add("cvar95", "#dc2626", "CVaR95", 1);
    add("cf95", "#f59e0b", "Cornish-Fisher VaR95", 1);
    add("evt99", "#7c3aed", "EVT VaR99", 1);
    chart.timeScale().fitContent();
    const onResize = () => chartRef.current && chart.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); apiRef.current = null; };
  }, [series]);

  if (prices.length < 280) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">ローリング VaR / CVaR（historical / EVT / Cornish-Fisher）</h3>

      {latest && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className="p-2 rounded border border-blue-200 bg-blue-50"><div className="text-gray-500">Hist VaR95</div><div className="font-mono font-medium">{(latest.hist95 * 100).toFixed(2)}%</div></div>
          <div className="p-2 rounded border border-red-200 bg-red-50"><div className="text-gray-500">CVaR95</div><div className="font-mono font-medium">{(latest.cvar95 * 100).toFixed(2)}%</div></div>
          <div className="p-2 rounded border border-amber-200 bg-amber-50"><div className="text-gray-500">CF VaR95</div><div className="font-mono font-medium">{(latest.cf95 * 100).toFixed(2)}%</div></div>
          <div className="p-2 rounded border border-purple-200 bg-purple-50"><div className="text-gray-500">EVT VaR99</div><div className="font-mono font-medium">{(latest.evt99 * 100).toFixed(2)}%</div></div>
        </div>
      )}

      <div ref={chartRef} className="w-full rounded border border-gray-100" />
      <div className="text-xs text-gray-500">値は1日の損失率(%)。大きいほどリスク高。窓250日ローリング。</div>

      <AnalysisGuide title="ローリングVaR/CVaRの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"『明日、一定確率で被りうる最大損失（VaR）』が時間とともにどう変動するかを追う。同じVaRでも推定法で値が変わるため、3つの方法を並べて頑健性を見る。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 各手法</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ヒストリカルVaR95</strong>: 過去リターンの5%下側分位。分布仮定なし。<strong>CVaR</strong>(期待ショートフォール): VaRを超えた時の平均損失（テールの厚みを反映）。</li>
          <li><strong>Cornish-Fisher VaR</strong>: 正規分位に歪度・尖度の補正を加える。ファットテール・歪みを反映。</li>
          <li><strong>EVT VaR99</strong>: 極値理論。閾値超の損失に一般化パレート分布(GPD)を当て、稀な大損失(99%)を外挿。積率法で推定。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>VaR上昇局面＝リスク拡大。ポジションサイズを VaR一定になるよう縮小（ボラ・ターゲティング）。</li>
          <li>CVaRがVaRより大きく乖離＝テールが厚い。最悪時の備え（ヘッジ・現金比率）を厚く。</li>
          <li>EVT99はストレス時の想定損失。証拠金・追証耐性の設計に。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>VaRは「超えない」保証ではなく確率的な目安。超過は必ず起きる。</li>
          <li>EVTは閾値・標本数に敏感。窓内の極値が少ないと不安定。</li>
          <li>過去に起きていない規模の事象は捉えられない。</li>
        </ul>
      </AnalysisGuide>

      <AxiomPlacement corollaryId="C6" />
    </div>
  );
}
