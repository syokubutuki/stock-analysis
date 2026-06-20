"use client";

import { useEffect, useRef, useMemo } from "react";
import { createChart, LineSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { fitHAR } from "../../lib/har-model";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function HARChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);

  const res = useMemo(() => fitHAR(prices), [prices]);

  useEffect(() => {
    if (!chartRef.current || !res) return;
    if (apiRef.current) apiRef.current.remove();
    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth, height: 240,
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;
    const actual = chart.addSeries(LineSeries, { color: "#9ca3af", lineWidth: 1, title: "実現ボラ(実績)" });
    actual.setData(res.fitted.map((p) => ({ time: p.time as Time, value: p.actual })));
    const fit = chart.addSeries(LineSeries, { color: "#dc2626", lineWidth: 2, title: "HAR予測" });
    fit.setData(res.fitted.map((p) => ({ time: p.time as Time, value: p.fitted })));
    chart.timeScale().fitContent();
    const onResize = () => chartRef.current && chart.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); apiRef.current = null; };
  }, [res]);

  if (prices.length < 60) return null;
  if (!res) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">HARモデル（日/週/月の実現ボラでボラ予測）</h3>

      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
        翌日ボラ予測（年率）: <span className="font-bold">{(res.forecastVol * 100).toFixed(1)}%</span>
        ／ あてはまり R² = <span className="font-bold">{res.r2.toFixed(3)}</span>（n={res.n}）
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded"><div className="text-gray-500">β0(定数)</div><div className="font-mono">{res.coef.b0.toExponential(2)}</div></div>
        <div className="p-2 bg-gray-50 rounded"><div className="text-gray-500">βd(日)</div><div className="font-mono">{res.coef.bd.toFixed(3)}</div></div>
        <div className="p-2 bg-gray-50 rounded"><div className="text-gray-500">βw(週)</div><div className="font-mono">{res.coef.bw.toFixed(3)}</div></div>
        <div className="p-2 bg-gray-50 rounded"><div className="text-gray-500">βm(月)</div><div className="font-mono">{res.coef.bm.toFixed(3)}</div></div>
      </div>

      <div ref={chartRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="HARモデルの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"ボラティリティは『日・週・月』という異なる時間スケールの参加者（デイトレーダー/スイング/長期）が重なって決まる、という発想で、明日のボラを過去の日次・週次・月次の平均ボラから予測する。シンプルだが実務で非常に強いボラ予測の定番。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>RV_t+1 = β0 + βd·RV_d + βw·RV_w + βm·RV_m</li>
          <li>RV_d＝当日の実現分散、RV_w＝直近5日平均、RV_m＝直近22日平均。最小二乗法(OLS)で係数推定。</li>
          <li>実現分散には<strong>Garman-Klass（レンジ由来）</strong>を使用（終値法より効率的な入力＝提案2.2の趣旨）。表示は年率σ%=√(RV×252)。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>実現ボラ(RV)</strong>: 実際に観測された変動の大きさ。GARCHが潜在ボラを推定するのに対し、HARは観測されたボラを直接回帰する。</li>
          <li><strong>R²</strong>: 予測が実績の分散をどれだけ説明できたか（1に近いほど良い）。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>翌日ボラ予測でポジションサイズ・ストップ幅を調整（高ボラ予測時は縮小）。</li>
          <li>βw・βmが大きい＝長めのボラ記憶が効く銘柄。短期の急変より持続性を重視。</li>
          <li>予測ボラとオプションのインプライドボラを比べ、割高/割安を判断。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>日足RVは intraday RV より粗い代理。急変時の追従は限定的。</li>
          <li>線形・係数一定を仮定。レジーム変化には弱い。</li>
          <li>ジャンプ（窓・暴落）を別途扱うHAR-J等の拡張もある。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
