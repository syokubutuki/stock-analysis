"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { createChart, LineSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { decomposeEquity } from "../../lib/overnight-intraday";
import { representativeSpread } from "../../lib/spread-estimator";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

export default function OvernightIntradayChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const [logScale, setLogScale] = useState(true);
  const [deductCost, setDeductCost] = useState(false);

  const spread = useMemo(() => representativeSpread(prices), [prices]);
  const { series, stats } = useMemo(
    () => decomposeEquity(prices, deductCost ? spread : 0),
    [prices, deductCost, spread]
  );

  useEffect(() => {
    if (!chartRef.current || series.length < 2) return;
    if (apiRef.current) apiRef.current.remove();
    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 280,
      rightPriceScale: { visible: true, mode: logScale ? 1 : 0 },
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;
    const add = (color: string, title: string, key: "overnight" | "intraday" | "buyhold", w: 1 | 2) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: w, title });
      s.setData(series.map((p) => ({ time: p.time as Time, value: p[key] })));
    };
    add("#dc2626", "夜間(持ち越し)", "overnight", 2);
    add("#2563eb", "日中(寄→引)", "intraday", 2);
    add("#9ca3af", "単純保有", "buyhold", 1);
    chart.timeScale().fitContent();
    const onResize = () => chartRef.current && chart.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      apiRef.current = null;
    };
  }, [series, logScale]);

  if (prices.length < 30) return null;

  const winner = stats.cumOvernight >= stats.cumIntraday ? "夜間(持ち越し)" : "日中(寄→引)";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">オーバーナイト vs 日中エクイティ（リターンの時間帯分解）</h3>
        <div className="flex gap-1">
          <button
            onClick={() => setDeductCost((v) => !v)}
            className={`px-2.5 py-1 text-xs rounded font-medium ${deductCost ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            title={`往復コスト ${(spread * 100).toFixed(3)}%/日 を控除`}
          >
            コスト控除{deductCost ? `(${(spread * 100).toFixed(2)}%/日)` : ""}
          </button>
          <button
            onClick={() => setLogScale((v) => !v)}
            className={`px-2.5 py-1 text-xs rounded font-medium ${logScale ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >
            {logScale ? "対数軸" : "線形軸"}
          </button>
        </div>
      </div>

      <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
        この銘柄のリターンは主に<span className="font-bold">「{winner}」</span>で稼いでいる
        （夜間 {fmtPct(stats.cumOvernight - 1)} / 日中 {fmtPct(stats.cumIntraday - 1)} / 単純保有 {fmtPct(stats.cumBuyhold - 1)}）。
        リスク（分散）の<span className="font-bold">{(stats.volShareOvernight * 100).toFixed(0)}%</span>は夜間が占める。
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
        <div className="p-2 rounded border border-red-200 bg-red-50">
          <div className="text-gray-500">夜間（持ち越し）</div>
          <div className="font-mono">累積 {fmtPct(stats.cumOvernight - 1)}</div>
          <div className="font-mono text-gray-500">Sharpe {stats.sharpeOvernight.toFixed(2)} / 勝率 {(stats.winOvernight * 100).toFixed(0)}%</div>
        </div>
        <div className="p-2 rounded border border-blue-200 bg-blue-50">
          <div className="text-gray-500">日中（寄→引）</div>
          <div className="font-mono">累積 {fmtPct(stats.cumIntraday - 1)}</div>
          <div className="font-mono text-gray-500">Sharpe {stats.sharpeIntraday.toFixed(2)} / 勝率 {(stats.winIntraday * 100).toFixed(0)}%</div>
        </div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50">
          <div className="text-gray-500">夜間リスク寄与</div>
          <div className="font-mono">{(stats.volShareOvernight * 100).toFixed(0)}%</div>
          <div className="font-mono text-gray-500">日中 {((1 - stats.volShareOvernight) * 100).toFixed(0)}%</div>
        </div>
      </div>

      <div ref={chartRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="オーバーナイト/日中分解の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"1日のリターンを2つに割る。夜間＝前日終値→当日始値（ポジションを持ち越している間）、日中＝当日始値→当日終値（ザラ場中）。それぞれを毎日複利で積み上げ、どちらが利益の源泉かを比べる。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>夜間リターン</strong>: r_on = (O_t − C_t−1) / C_t−1</li>
          <li><strong>日中リターン</strong>: r_id = (C_t − O_t) / O_t</li>
          <li><strong>エクイティ</strong>: E_t = Π(1 + r)。<strong>Sharpe</strong>=平均/標準偏差×√252。</li>
          <li><strong>夜間リスク寄与</strong>: Var(r_on) / (Var(r_on)+Var(r_id))。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>オーバーナイト・ドリフト</strong>: 多くの株価指数で、上昇の大半が夜間（取引時間外）に発生し、日中はほぼ横ばい〜マイナスという実証的アノマリー。リスクプレミアムが取引時間外に織り込まれる等の仮説。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>夜間カーブが右肩上がりで日中が横ばい＝持ち越し（引け買い→寄り売り）が有利な銘柄。</li>
          <li>日中カーブが優位＝デイトレ（寄り買い→引け売り）向き、持ち越しは避ける。</li>
          <li>夜間リスク寄与が高い＝ギャップ（窓）でリスクを取っている。持ち越しサイズを抑える判断に。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>夜間/日中戦略は毎日1往復約定するため手数料負けしやすい。「コスト控除」ONで高安スプレッド推定（CSの中央値）を1日あたりの往復コストとして差し引いた正味エクイティを表示できる（スリッページは別途）。</li>
          <li>始値は寄り付き気配で歪むことがあり、流動性の薄い銘柄では誤差。</li>
          <li>配当・株式分割の調整方法により始値/終値の整合がずれる場合がある。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
