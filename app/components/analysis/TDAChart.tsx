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
import { computePersistentHomology, fisherRaoDistance } from "../../lib/tda";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function TDAChart({ prices }: Props) {
  const diagramCanvasRef = useRef<HTMLCanvasElement>(null);
  const bettiCanvasRef = useRef<HTMLCanvasElement>(null);
  const frRef = useRef<HTMLDivElement>(null);
  const frChartRef = useRef<IChartApi | null>(null);

  const lr = logReturns(prices.map((p) => p.close));
  const times = prices.map((p) => p.time).slice(1);

  const tda = useMemo(() => computePersistentHomology(lr), [prices]);
  const fr = useMemo(() => fisherRaoDistance(lr, Math.min(60, Math.floor(lr.length / 4))), [prices]);

  // Persistence diagram
  useEffect(() => {
    const canvas = diagramCanvasRef.current;
    if (!canvas || tda.diagram.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const size = 250;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { left: 40, right: 10, top: 20, bottom: 30 };
    const plotW = size - margin.left - margin.right;
    const plotH = size - margin.top - margin.bottom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);

    const maxVal = tda.maxPersistence * 1.1 || 1;

    // Diagonal line (birth = death)
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top + plotH);
    ctx.lineTo(margin.left + plotW, margin.top);
    ctx.stroke();

    // Points
    for (const p of tda.diagram) {
      const x = margin.left + (p.birth / maxVal) * plotW;
      const y = margin.top + plotH - (Math.min(p.death, maxVal) / maxVal) * plotH;
      ctx.fillStyle = p.dimension === 0 ? "#3b82f6" : "#ef4444";
      ctx.beginPath();
      ctx.arc(x, y, p.persistence > tda.maxPersistence * 0.3 ? 5 : 3, 0, 2 * Math.PI);
      ctx.fill();
    }

    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Persistence Diagram", size / 2, 12);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("birth", size / 2, size - 5);
    ctx.save();
    ctx.translate(10, margin.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("death", 0, 0);
    ctx.restore();

    // Legend
    ctx.fillStyle = "#3b82f6";
    ctx.fillRect(margin.left + 5, margin.top + 5, 8, 8);
    ctx.fillStyle = "#374151";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("H₀ (成分)", margin.left + 16, margin.top + 13);
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(margin.left + 5, margin.top + 18, 8, 8);
    ctx.fillStyle = "#374151";
    ctx.fillText("H₁ (ループ)", margin.left + 16, margin.top + 26);
  }, [tda]);

  // Betti curves
  useEffect(() => {
    const canvas = bettiCanvasRef.current;
    if (!canvas || tda.thresholds.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = 300;
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

    const maxBetti = Math.max(...tda.bettiCurve0, ...tda.bettiCurve1, 1);
    const nT = tda.thresholds.length;

    // β₀
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    tda.bettiCurve0.forEach((v, i) => {
      const x = margin.left + (i / (nT - 1)) * plotW;
      const y = margin.top + plotH - (v / maxBetti) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // β₁
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 2;
    ctx.beginPath();
    tda.bettiCurve1.forEach((v, i) => {
      const x = margin.left + (i / (nT - 1)) * plotW;
      const y = margin.top + plotH - (v / maxBetti) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Betti Curves", width / 2, 12);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("ε (threshold)", width / 2, height - 5);

    // Legend
    ctx.fillStyle = "#3b82f6";
    ctx.fillText("β₀", margin.left + 30, margin.top + 15);
    ctx.fillStyle = "#ef4444";
    ctx.fillText("β₁", margin.left + 60, margin.top + 15);
  }, [tda]);

  // Fisher-Rao distance
  useEffect(() => {
    if (!frRef.current || fr.distances.length === 0) return;
    if (frChartRef.current) frChartRef.current.remove();

    const chart = createChart(frRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: frRef.current.clientWidth,
      height: 130,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    frChartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 2,
      title: "Fisher-Rao距離",
    });
    series.setData(
      fr.times
        .filter((t) => t < times.length)
        .map((t, i) => ({
          time: times[t] as Time,
          value: fr.distances[i],
        }))
    );
    chart.timeScale().fitContent();
    const handleResize = () => {
      if (frRef.current) chart.applyOptions({ width: frRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); frChartRef.current = null; };
  }, [prices, fr]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">位相的データ解析 (TDA) / Fisher-Rao距離</h3>
      <p className="text-xs text-gray-500 mb-3">パーシステントホモロジーと情報幾何学的レジーム検出</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">H₀特徴数</div>
          <div className="font-bold">{tda.diagram.filter((p) => p.dimension === 0).length}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">H₁特徴数 (ループ)</div>
          <div className="font-bold">{tda.diagram.filter((p) => p.dimension === 1).length}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">最大persistence</div>
          <div className="font-bold">{tda.maxPersistence.toFixed(4)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">FR変化点</div>
          <div className="font-bold">{fr.changePoints.length}箇所</div>
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-1">{tda.interpretation}</div>

      <div className="flex flex-col sm:flex-row gap-3 mb-3">
        <canvas ref={diagramCanvasRef} className="rounded border border-gray-100" />
        <canvas ref={bettiCanvasRef} className="rounded border border-gray-100" />
      </div>

      <div className="text-xs text-gray-500 mb-1">Fisher-Rao距離 — リターン分布の変化速度 (スパイク=レジーム変化)</div>
      <div ref={frRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="TDA・Fisher-Raoの読み方">
        <p><span className="font-medium">パーシステントホモロジー:</span> Takens埋め込みから点群のトポロジー(接続成分H₀、ループH₁)を抽出。Persistence Diagramで対角線から遠い点が「消えにくい=頑健な構造」。対角線上の点はノイズです。</p>
        <p><span className="font-medium">Betti曲線:</span> 閾値εを増やしたときの位相的特徴の数。β₀の急減はクラスターの統合、β₁のピークはループ(周期的構造)の出現を示します。</p>
        <p><span className="font-medium">Fisher-Rao距離:</span> 連続する窓のリターン分布間のHellinger距離から計算。分布の形状変化を検出し、スパイクはレジーム転換(ボラティリティシフト、トレンド反転等)を示唆します。</p>
      </AnalysisGuide>
    </div>
  );
}
