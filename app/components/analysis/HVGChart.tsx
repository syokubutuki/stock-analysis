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
import { computeHVG } from "../../lib/hvg";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function HVGChart({ prices }: Props) {
  const degreeRef = useRef<HTMLDivElement>(null);
  const degreeChartRef = useRef<IChartApi | null>(null);
  const distCanvasRef = useRef<HTMLCanvasElement>(null);

  const closes = prices.map((p) => p.close);
  const times = prices.map((p) => p.time);
  const lr = logReturns(closes);
  const lrTimes = times.slice(1);

  const hvg = useMemo(() => computeHVG(lr, 50), [prices]);

  // Degree time series
  useEffect(() => {
    if (!degreeRef.current) return;
    if (degreeChartRef.current) degreeChartRef.current.remove();

    const chart = createChart(degreeRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: degreeRef.current.clientWidth,
      height: 160,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    degreeChartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 1,
      title: "HVG degree",
    });
    series.setData(
      hvg.degreeSeries.map((v, i) => ({
        time: lrTimes[Math.min(i, lrTimes.length - 1)] as Time,
        value: v,
      }))
    );

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (degreeRef.current) chart.applyOptions({ width: degreeRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); degreeChartRef.current = null; };
  }, [prices, hvg]);

  // Degree distribution
  useEffect(() => {
    const canvas = distCanvasRef.current;
    if (!canvas || hvg.degreeDistribution.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = 280;
    const height = 180;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { left: 40, right: 10, top: 20, bottom: 25 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const dist = hvg.degreeDistribution.filter((d) => d.count > 0);
    const maxK = Math.max(...dist.map((d) => d.degree));
    const minLogP = Math.min(...dist.map((d) => d.logCount));
    const maxLogP = 0;
    const kRange = maxK || 1;
    const logRange = maxLogP - minLogP || 1;

    // Points
    ctx.fillStyle = "#8b5cf6";
    for (const d of dist) {
      const x = margin.left + (d.degree / kRange) * plotW;
      const y = margin.top + plotH - ((d.logCount - minLogP) / logRange) * plotH;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, 2 * Math.PI);
      ctx.fill();
    }

    // Theoretical line (exponential with λ = ln(3/2))
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (let k = 1; k <= maxK; k++) {
      const logP = -hvg.theoreticalLambda * k;
      const x = margin.left + (k / kRange) * plotW;
      const y = margin.top + plotH - ((logP - minLogP) / logRange) * plotH;
      if (k === 1) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Labels
    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("HVG 次数分布", width / 2, 12);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("degree k", margin.left + plotW / 2, height - 5);
    ctx.fillStyle = "#ef4444";
    ctx.textAlign = "left";
    ctx.fillText(`理論値 λ=${hvg.theoreticalLambda.toFixed(3)}`, margin.left + 5, margin.top + 15);
    ctx.fillStyle = "#8b5cf6";
    ctx.fillText(`実測 λ=${hvg.lambda.toFixed(3)}`, margin.left + 5, margin.top + 28);
  }, [hvg]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">Horizontal Visibility Graph (HVG)</h3>
      <p className="text-xs text-gray-500 mb-3">水平可視性グラフ — ランダム性の理論的ベースラインとの比較</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均次数</div>
          <div className="font-bold">{hvg.meanDegree.toFixed(2)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">λ (実測)</div>
          <div className="font-bold">{hvg.lambda.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">λ (理論: ランダム)</div>
          <div className="font-bold">{hvg.theoreticalLambda.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">非線形性</div>
          <div className="font-bold">{hvg.isNonlinear ? "検出" : "なし"}</div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <div className="text-xs text-gray-500 mb-1">HVG次数の時系列</div>
          <div ref={degreeRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <canvas ref={distCanvasRef} className="rounded border border-gray-100" />
        </div>
      </div>

      <AnalysisGuide title="HVGの読み方">
        <p><span className="font-medium">HVG (Horizontal Visibility Graph):</span> NVG(Natural Visibility Graph, 既存)の簡略版。2点i,jの間の全ての値がmin(v_i, v_j)未満なら接続します。ランダム系列の理論的な指数減衰率 λ=ln(3/2)≈0.405 が既知なので、実測値との比較で非線形構造の強さを定量できます。</p>
        <p><span className="font-medium">λの解釈:</span> λが理論値より大きい場合、次数分布がより急速に減衰→短距離接続が支配的→相関の減衰が速い。λが小さい場合、長距離接続が多い→持続的な構造がある。</p>
      </AnalysisGuide>
    </div>
  );
}
