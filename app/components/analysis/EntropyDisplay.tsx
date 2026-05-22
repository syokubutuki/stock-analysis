"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { logReturns } from "../../lib/transforms";
import {
  shannonEntropy,
  permutationEntropy,
  sampleEntropy,
  rollingEntropy,
} from "../../lib/entropy";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function EntropyDisplay({ prices }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const closes = prices.map((p) => p.close);
  const times = prices.map((p) => p.time);
  const lr = logReturns(closes);
  const lrTimes = times.slice(1);

  const shannon = useMemo(() => shannonEntropy(lr), [prices]);
  const permEnt = useMemo(() => permutationEntropy(lr, 3, 1), [prices]);
  const sampEnt = useMemo(() => sampleEntropy(lr, 2), [prices]);
  const rolling = useMemo(
    () => rollingEntropy(lr, lrTimes, 60),
    [prices]
  );

  useEffect(() => {
    if (!containerRef.current || rolling.length === 0) return;

    if (chartRef.current) chartRef.current.remove();

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      leftPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    const shannonSeries = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 1,
      title: "Shannon",
      priceScaleId: "right",
    });
    shannonSeries.setData(
      rolling.map((r) => ({
        time: r.time as Time,
        value: r.shannon,
      }))
    );

    const permSeries = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 1,
      title: "Permutation",
      priceScaleId: "left",
    });
    permSeries.setData(
      rolling.map((r) => ({
        time: r.time as Time,
        value: r.permutation,
      }))
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current)
        chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [prices, rolling]);

  const permInterp =
    permEnt > 0.9
      ? "高ランダム性 (パターンなし)"
      : permEnt > 0.7
      ? "中程度のランダム性"
      : "低ランダム性 (構造あり → チャンス?)";

  const sampInterp =
    sampEnt > 2
      ? "高い不規則性"
      : sampEnt > 1
      ? "中程度の規則性"
      : "高い規則性 (構造的な動き)";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">情報理論 / エントロピー</h3>

      <div className="grid grid-cols-3 gap-3 text-xs mb-3">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Shannon Entropy</div>
          <div className="font-mono font-medium text-sm">{shannon.toFixed(3)}</div>
          <div className="text-gray-400">分布の複雑性</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Permutation Entropy</div>
          <div className={`font-mono font-medium text-sm ${permEnt < 0.7 ? "text-orange-600" : ""}`}>
            {permEnt.toFixed(3)}
          </div>
          <div className="text-gray-400">{permInterp}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Sample Entropy</div>
          <div className={`font-mono font-medium text-sm ${sampEnt < 1 ? "text-orange-600" : ""}`}>
            {sampEnt.toFixed(3)}
          </div>
          <div className="text-gray-400">{sampInterp}</div>
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-2">
        ローリングエントロピー (60日窓) — 低下局面 = 構造化された動き
      </div>
      <div ref={containerRef} className="w-full rounded border border-gray-100" />

      <div className="mt-2 flex gap-3 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-red-500" /> Shannon
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-blue-500" /> Permutation (正規化)
        </span>
      </div>

      <AnalysisGuide title="エントロピーの読み方">
        <p><span className="font-medium">エントロピーとは:</span> 情報理論における「不確実性」「複雑性」「ランダム性」の尺度です。エントロピーが高い = ランダムで予測困難、低い = パターンがあり構造化されている、と解釈します。</p>
        <p><span className="font-medium">Shannon Entropy:</span> リターンの分布(ヒストグラム)から計算されるエントロピーです。分布が一様(均等に散らばっている)ほど高く、特定の値に集中しているほど低くなります。値の範囲はビン数(20)に依存し、最大値は log₂(20) ≈ 4.32 です。</p>
        <p><span className="font-medium">Permutation Entropy (PE):</span> 連続する3点の「順序パターン」(上下の並び)の出現頻度から計算します。0〜1に正規化されており、パラメータ選択に対してロバスト(頑健)という利点があります。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">PE &gt; 0.9:</span> ほぼランダム。全ての順序パターンがほぼ均等に出現。</li>
          <li><span className="font-medium">0.7 &lt; PE &lt; 0.9:</span> 中程度のランダム性。弱い構造がある可能性。</li>
          <li><span className="font-medium">PE &lt; 0.7:</span> 明確な構造が存在。特定の順序パターンが頻出している = 予測可能性が高い。トレード機会の可能性。</li>
        </ul>
        <p><span className="font-medium">Sample Entropy (SampEn):</span> 系列中で似たパターンが繰り返される頻度を測定します。値が小さいほどパターンの反復が多い(規則的)です。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">SampEn &lt; 1:</span> 高い規則性。系列中に自己相似的な構造がある。</li>
          <li><span className="font-medium">1 &lt; SampEn &lt; 2:</span> 中程度。</li>
          <li><span className="font-medium">SampEn &gt; 2:</span> 不規則。パターンの繰り返しが少ない。</li>
        </ul>
        <p><span className="font-medium">ローリングエントロピー(時系列):</span> 60日窓でエントロピーを計算し、時間推移を表示しています。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">エントロピーが低下している期間:</span> 市場の動きが構造化されている = トレンドやパターンが明確な時期。テクニカル分析が有効になりやすい。</li>
          <li><span className="font-medium">エントロピーが急上昇する時点:</span> 市場が混乱している = ボラティリティの急変やレジーム変化の可能性。</li>
          <li><span className="font-medium">エントロピーが安定して高い期間:</span> 効率的な市場状態。アルファの獲得が困難。</li>
        </ul>
        <p><span className="font-medium">トレードへの活用:</span> エントロピーが低下している局面は、市場に何らかの「秩序」が生まれていることを意味し、その秩序を利用した戦略(トレンドフォロー等)が有効な可能性があります。エントロピーの低下を検出してからエントリーし、上昇に転じたらエグジットする、という使い方が考えられます。</p>
      </AnalysisGuide>
    </div>
  );
}
