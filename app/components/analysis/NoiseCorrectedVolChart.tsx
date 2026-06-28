"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { noiseCorrectedVol } from "../../lib/noise-corrected-vol";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const WINDOWS = [21, 63];

export default function NoiseCorrectedVolChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const [window_, setWindow] = useState(21);

  const res = useMemo(
    () => noiseCorrectedVol(prices, window_),
    [prices, window_]
  );

  useEffect(() => {
    if (!chartRef.current || !res || res.points.length < 2) return;
    if (apiRef.current) apiRef.current.remove();
    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 260,
      rightPriceScale: { visible: true },
      leftPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;
    const naive = chart.addSeries(LineSeries, {
      color: "#9ca3af",
      lineWidth: 1,
      title: "素朴ボラ",
      priceScaleId: "right",
    });
    naive.setData(
      res.points.map((p) => ({ time: p.time as Time, value: p.naiveVol }))
    );
    const corr = chart.addSeries(LineSeries, {
      color: "#0d9488",
      lineWidth: 2,
      title: "補正ボラ",
      priceScaleId: "right",
    });
    corr.setData(
      res.points.map((p) => ({ time: p.time as Time, value: p.correctedVol }))
    );
    const share = chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 1,
      lineStyle: 2,
      title: "ノイズ割合%",
      priceScaleId: "left",
    });
    share.setData(
      res.points.map((p) => ({ time: p.time as Time, value: p.noiseSharePct }))
    );
    chart.timeScale().fitContent();
    const onResize = () =>
      chartRef.current &&
      chart.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      apiRef.current = null;
    };
  }, [res]);

  if (prices.length < 60) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">
          ノイズ補正ボラティリティ（真のボラでサイズ調整）
        </h3>
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span>窓:</span>
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`px-2 py-0.5 rounded ${
                window_ === w
                  ? "bg-teal-600 text-white"
                  : "bg-gray-100 hover:bg-gray-200"
              }`}
            >
              {w}日
            </button>
          ))}
        </div>
      </div>

      {res && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className="p-2 rounded border border-gray-300 bg-gray-50">
            <div className="text-gray-500">素朴ボラ(年率)</div>
            <div className="font-mono font-medium text-base">
              {res.currentNaive.toFixed(1)}%
            </div>
            <div className="text-[10px] text-gray-400">ノイズで過大</div>
          </div>
          <div className="p-2 rounded border border-teal-200 bg-teal-50">
            <div className="text-gray-500">補正ボラ(年率)</div>
            <div className="font-mono font-medium text-base text-teal-700">
              {res.currentCorrected.toFixed(1)}%
            </div>
            <div className="text-[10px] text-gray-400">真の値動き</div>
          </div>
          <div className="p-2 rounded border border-amber-200 bg-amber-50">
            <div className="text-gray-500">現在のノイズ割合</div>
            <div className="font-mono font-medium text-base text-amber-700">
              {res.currentNoiseShare.toFixed(0)}%
            </div>
            <div className="text-[10px] text-gray-400">
              平均 {res.avgNoiseShare.toFixed(0)}%
            </div>
          </div>
          <div className="p-2 rounded border border-gray-200 bg-gray-50">
            <div className="text-gray-500">サイズ調整余地</div>
            <div className="font-mono font-medium text-base">
              {res.sizingAdjustPct >= 0 ? "+" : ""}
              {res.sizingAdjustPct.toFixed(0)}%
            </div>
            <div className="text-[10px] text-gray-400">vol目標の建玉</div>
          </div>
        </div>
      )}

      <div ref={chartRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="ノイズ補正ボラティリティの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {
            "日々のリターンの散らばり(ボラ)には、本当の値動きに加えて『ビッド・アスクの往復や気配の跳ね』というノイズが混ざる。ノイズは“今日上がって明日下がる”往復になりやすく、リターンの分散を水増しする。これを連続日の相関(1次自己共分散)から差し引き、真のボラを取り出す。緑=補正ボラ、灰=素朴ボラ、橙(左軸)=ノイズ割合。"
          }
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            {
              "MA(1)ノイズモデル: 観測分散 γ₀ = 真の分散 + 2σ_u²、 1次自己共分散 γ₁ = −σ_u²(往復するので負)。"
            }
          </li>
          <li>{"よって 真の分散 = γ₀ + 2γ₁、 ノイズ分散 σ_u² = −γ₁。"}</li>
          <li>{"ノイズ割合 = 2σ_u² / γ₀ = −2γ₁/γ₀。年率化は ×√252。"}</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>1次自己共分散 γ₁</strong>
            : 今日と昨日のリターンの連動。ノイズが往復だと負になり、その大きさがノイズ量。
          </li>
          <li>
            例え: 揺れる船の上で身長を測るとブレ(ノイズ)で散らばるが、ブレは上下に往復する。往復成分を取り除けば本当のばらつきが見える。
          </li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>ポジションサイズ</strong>
            : ボラ目標(建玉 ∝ 1/ボラ)では、素朴ボラは過大評価で建玉を絞り過ぎる。補正ボラで適正枚数に。『サイズ調整余地』がその目安。
          </li>
          <li>
            <strong>ストップ幅・VaR</strong>
            : ノイズ込みの広いボラでストップを置くと損切りが遠すぎる。真のボラ基準にする。
          </li>
          <li>
            <strong>ノイズ割合の急騰</strong>
            は流動性低下・板薄のサイン。約定コストが膨らむのでサイズを落とす。
          </li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            真の自己相関(モメンタム/平均回帰)が強い銘柄では γ₁ が往復ノイズ以外の理由でも動き、補正が過大/過小になる。
          </li>
          <li>
            γ₁ が正の時はノイズ分離不能(σ_u²=0)とし、補正≒素朴になる。下限クリップで負の分散は防いでいる。
          </li>
          <li>
            日足の1次補正は粗い近似。より厳密には日中足での Two-Scale RV / Realized Kernel が必要(日中足分析を参照)。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
