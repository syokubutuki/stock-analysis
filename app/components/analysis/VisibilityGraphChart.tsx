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
import { computeVisibilityGraph } from "../../lib/visibility-graph";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function VisibilityGraphChart({ prices }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const degDistRef = useRef<HTMLCanvasElement>(null);

  const closes = prices.map((p) => p.close);
  const times = prices.map((p) => p.time);
  const lr = logReturns(closes);
  const lrTimes = times.slice(1);

  const vg = useMemo(
    () => computeVisibilityGraph(lr, lrTimes, 50),
    [prices]
  );

  // 次数の時系列チャート
  useEffect(() => {
    if (!containerRef.current || vg.degreeSeries.length === 0) return;

    if (chartRef.current) chartRef.current.remove();

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#059669",
      lineWidth: 1,
      title: "次数(degree)",
    });
    series.setData(
      vg.degreeSeries.map((d) => ({
        time: d.time as Time,
        value: d.degree,
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
  }, [prices, vg]);

  // 次数分布 log-logプロット
  useEffect(() => {
    const canvas = degDistRef.current;
    if (!canvas || vg.degreeDistribution.length === 0) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 160;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, width, height);

    const margin = { top: 15, right: 15, bottom: 25, left: 40 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    const dist = vg.degreeDistribution.filter((d) => d.degree > 0);
    if (dist.length === 0) return;

    const logK = dist.map((d) => Math.log10(d.degree));
    const logP = dist.map((d) => Math.log10(d.ratio));
    const minLK = Math.min(...logK);
    const maxLK = Math.max(...logK);
    const minLP = Math.min(...logP);
    const maxLP = Math.max(...logP);
    const rlk = maxLK - minLK || 1;
    const rlp = maxLP - minLP || 1;

    const toX = (v: number) => margin.left + ((v - minLK) / rlk) * plotW;
    const toY = (v: number) => margin.top + plotH - ((v - minLP) / rlp) * plotH;

    // 点
    ctx.fillStyle = "#059669";
    for (let i = 0; i < dist.length; i++) {
      ctx.beginPath();
      ctx.arc(toX(logK[i]), toY(logP[i]), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // べき乗則フィット線
    if (vg.powerLawExponent > 0) {
      const nPts = logK.length;
      const sumX = logK.reduce((a, b) => a + b, 0);
      const sumY = logP.reduce((a, b) => a + b, 0);
      const fitSlope = -vg.powerLawExponent;
      const fitIntercept = (sumY - fitSlope * sumX) / nPts;

      ctx.strokeStyle = "rgba(239, 68, 68, 0.5)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(toX(minLK), toY(fitSlope * minLK + fitIntercept));
      ctx.lineTo(toX(maxLK), toY(fitSlope * maxLK + fitIntercept));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.fillText("log₁₀(k)", width / 2 - 20, height - 5);
    ctx.save();
    ctx.translate(10, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("log₁₀(P(k))", -20, 0);
    ctx.restore();
  }, [vg]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">
        Visibility Graph (時系列→ネットワーク)
      </h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">ノード数</div>
          <div className="font-mono font-medium">{vg.numNodes}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">エッジ数</div>
          <div className="font-mono font-medium">{vg.numEdges.toLocaleString()}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均次数</div>
          <div className="font-mono font-medium">{vg.avgDegree.toFixed(2)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">クラスタ係数</div>
          <div className="font-mono font-medium">{vg.clusteringCoefficient.toFixed(3)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-gray-500 mb-1">次数の時間推移 — 高次数 = 価格の「可視性」が高い時点</div>
          <div ref={containerRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">
            次数分布 (log-log) — べき指数: {vg.powerLawExponent.toFixed(2)}
          </div>
          <div className="w-full rounded border border-gray-100 overflow-hidden">
            <canvas ref={degDistRef} />
          </div>
        </div>
      </div>

      <AnalysisGuide title="Visibility Graphの読み方">
        <p><span className="font-medium">Visibility Graphとは:</span> 時系列データをネットワーク(グラフ)に変換する手法です。各時点をノード(節点)とし、2つの時点間で「間にある全ての値が、2点を結ぶ直線より下にある」場合にエッジ(辺)を引きます。つまり、2つの時点が互いに「見える」(visibility)関係にあるとき接続されます。</p>
        <p><span className="font-medium">ネットワーク指標の意味:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">次数(Degree):</span> あるノードが持つエッジの数。次数が高い時点 = その値が「突出」しており、多くの他の時点から「見える」。つまり、局所的な高値(ピーク)は高次数になりやすい。</li>
          <li><span className="font-medium">平均次数:</span> ネットワーク全体の接続密度。高いほど時系列の変動が小さい(多くの点が互いに見える)。</li>
          <li><span className="font-medium">クラスタ係数:</span> 「友達の友達も友達である」確率。高いほど局所的なパターンの繰り返しが多い。ランダム系列では低く、周期的な系列では高くなる。</li>
        </ul>
        <p><span className="font-medium">次数分布とべき指数(γ):</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">γ ≈ 3:</span> ランダム系列(i.i.d.プロセス)の理論値。</li>
          <li><span className="font-medium">γ &lt; 3:</span> 持続性(トレンド的)。高次数ノード(大きなピーク)が理論値より多い = 大きなトレンドの山が頻出。</li>
          <li><span className="font-medium">γ &gt; 3:</span> 反持続性(平均回帰的)。高次数ノードが少ない = 価格が大きく突出しにくい。</li>
        </ul>
        <p><span className="font-medium">次数の時間推移チャート:</span> 各時点の次数を時系列で表示しています。次数のスパイク(急増)は、その時点が周囲の値に対して大きく突出していたことを意味します。これは重要な高値・安値ポイントの自動検出として使えます。</p>
        <p><span className="font-medium">トレードへの活用:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li>次数のスパイクは重要な転換点(サポート/レジスタンス)を示唆。</li>
          <li>γが3から大きく乖離していれば、市場は効率的でない可能性がある = 予測可能性が存在。</li>
          <li>クラスタ係数が高い時期は、パターン認識ベースの戦略が有効な可能性がある。</li>
          <li>これらの指標はHurst指数やエントロピーと組み合わせると、市場の状態をより立体的に把握できます。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
