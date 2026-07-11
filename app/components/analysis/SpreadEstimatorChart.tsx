"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { createChart, LineSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { estimateSpread } from "../../lib/spread-estimator";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";

interface Props {
  prices: PricePoint[];
}

const WINDOWS = [10, 21, 63];

export default function SpreadEstimatorChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const [window_, setWindow] = useState(21);
  const [showAmihud, setShowAmihud] = useState(true);

  const series = useMemo(() => estimateSpread(prices, window_), [prices, window_]);
  const latest = series.length ? series[series.length - 1] : null;

  useEffect(() => {
    if (!chartRef.current || series.length < 2) return;
    if (apiRef.current) apiRef.current.remove();
    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 240,
      rightPriceScale: { visible: true },
      leftPriceScale: { visible: showAmihud },
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;
    const cs = chart.addSeries(LineSeries, { color: "#dc2626", lineWidth: 2, title: "CS スプレッド%", priceScaleId: "right" });
    cs.setData(series.map((p) => ({ time: p.time as Time, value: p.cs * 100 })));
    const ar = chart.addSeries(LineSeries, { color: "#2563eb", lineWidth: 1, title: "AR スプレッド%", priceScaleId: "right" });
    ar.setData(series.map((p) => ({ time: p.time as Time, value: p.ar * 100 })));
    if (showAmihud) {
      const am = chart.addSeries(LineSeries, { color: "#d97706", lineWidth: 1, lineStyle: 2, title: "Amihud非流動性", priceScaleId: "left" });
      am.setData(series.map((p) => ({ time: p.time as Time, value: p.amihud })));
    }
    chart.timeScale().fitContent();
    const onResize = () => chartRef.current && chart.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      apiRef.current = null;
    };
  }, [series, showAmihud]);

  if (prices.length < 40) return null;

  const csBp = latest ? latest.cs * 10000 : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">高安スプレッド推定（取引コスト・流動性の代理）</h3>
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span>窓:</span>
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`px-2 py-0.5 rounded ${window_ === w ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
            >
              {w}日
            </button>
          ))}
          <button
            onClick={() => setShowAmihud((v) => !v)}
            className={`ml-2 px-2 py-0.5 rounded ${showAmihud ? "bg-amber-500 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
          >
            Amihud
          </button>
        </div>
      </div>

      {latest && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          <div className="p-2 rounded border border-red-200 bg-red-50">
            <div className="text-gray-500">現在の実効スプレッド (CS)</div>
            <div className="font-mono font-medium">{(latest.cs * 100).toFixed(3)}% ≈ {csBp.toFixed(1)}bp</div>
            <div className="font-mono text-gray-500 text-[10px]">往復コスト目安 {(csBp).toFixed(1)}bp</div>
          </div>
          <div className="p-2 rounded border border-blue-200 bg-blue-50">
            <div className="text-gray-500">Abdi-Ranaldo (頑健版)</div>
            <div className="font-mono font-medium">{(latest.ar * 100).toFixed(3)}%</div>
          </div>
          <div className="p-2 rounded border border-amber-200 bg-amber-50">
            <div className="text-gray-500">Amihud非流動性</div>
            <div className="font-mono font-medium">{latest.amihud.toFixed(3)}</div>
            <div className="font-mono text-gray-500 text-[10px]">高いほど流動性が薄い</div>
          </div>
        </div>
      )}

      <div ref={chartRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="高安スプレッド推定の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"板情報がなくても、日足の高値・安値・終値だけから『実効スプレッド（売買で実際に払う往復コスト）』と『流動性』を近似する。レンジ（高安幅）には“本当の値動き（分散）”と“ビッド・アスクの跳ね（スプレッド）”の両方が混ざるが、連続2日に共通して現れる成分からスプレッドだけを分離できる。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>Corwin-Schultz</strong>: 2日分のレンジから β=Σ(ln(H/L))²、2日通算レンジから γ=(ln(H₂max/L₂min))²、α=(√(2β)−√β)/(3−2√2)−√(γ/(3−2√2))、S=2(e^α−1)/(1+e^α)。負値は0。</li>
          <li><strong>Abdi-Ranaldo</strong>: 対数中値 η=(lnH+lnL)/2、終値 c=lnC。S=2√(max(0, E[(c−η)(c−η_next)]))。レンジのノイズに頑健。</li>
          <li><strong>Amihud非流動性</strong>: |リターン| ÷ 売買代金（出来高×終値）の平均。小さな売買代金で価格が大きく動くほど大＝流動性が薄い。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>実効スプレッド</strong>: 「すぐ買ってすぐ売る」と必ず損する幅。狭いほど低コストで回転できる。bp＝0.01%。</li>
          <li>例え: レンジは“波の高さ”、スプレッドは“桟橋のすきま”。連続する波に共通して残るすきま分を測る。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>現在の実効スプレッド(bp)を<strong>バックテストのコスト控除</strong>に使う。短期売買ほど効く。</li>
          <li>スプレッド/Amihudが<strong>急上昇＝地合い悪化・流動性枯渇</strong>のシグナル。サイズを落とす。</li>
          <li>恒常的にスプレッドが広い銘柄は、薄利の短期戦略には不向き。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>あくまで推定。ストップ高/安・寄り引け同値・出来高僅少の日は誤差が大きく、CSは過大/負値になりやすい（0クリップ）。</li>
          <li>窓（オーバーナイトギャップ）が大きい日はレンジ前提が崩れる。</li>
          <li>Amihudは銘柄の価格・出来高水準に依存するため、絶対値より時系列の変化を見る。</li>
        </ul>
      </AnalysisGuide>

      <AxiomPlacement corollaryId="C10" />
    </div>
  );
}
