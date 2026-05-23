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
import { rsAnalysis, computeDCCA, correlationDimension } from "../../lib/fractal-ext";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function FractalExtChart({ prices }: Props) {
  const rsCanvasRef = useRef<HTMLCanvasElement>(null);
  const dccaCanvasRef = useRef<HTMLCanvasElement>(null);
  const corrDimCanvasRef = useRef<HTMLCanvasElement>(null);

  const closes = prices.map((p) => p.close);
  const volumes = prices.map((p) => p.volume);
  const lr = logReturns(closes);
  const volReturns = logReturns(volumes.map((v) => v || 1));

  const rs = useMemo(() => rsAnalysis(lr), [prices]);
  const dcca = useMemo(() => computeDCCA(lr, volReturns), [prices]);
  const corrDim = useMemo(() => correlationDimension(lr), [prices]);

  // R/S plot
  useEffect(() => {
    const canvas = rsCanvasRef.current;
    if (!canvas || rs.scales.length === 0) return;
    drawLogLogPlot(canvas, rs.scales.map(Math.log), rs.rsValues.map((v) => Math.log(v + 1e-20)),
      `R/S解析 — H=${rs.hurst.toFixed(3)} [${rs.confidence[0].toFixed(2)}, ${rs.confidence[1].toFixed(2)}]`,
      "log(s)", "log(R/S)", "#3b82f6");
  }, [rs]);

  // DCCA plot
  useEffect(() => {
    const canvas = dccaCanvasRef.current;
    if (!canvas || dcca.scales.length === 0) return;
    drawLogLogPlot(canvas, dcca.scales.map(Math.log), dcca.rho,
      `DCCA相関 (価格×出来高) — Cross-H=${dcca.crossHurst.toFixed(3)}`,
      "log(s)", "ρ_DCCA(s)", "#22c55e");
  }, [dcca]);

  // Correlation dimension plot
  useEffect(() => {
    const canvas = corrDimCanvasRef.current;
    if (!canvas || corrDim.logR.length === 0) return;
    drawLogLogPlot(canvas, corrDim.logR, corrDim.logC,
      `相関次元 — D₂=${corrDim.dimension.toFixed(3)}`,
      "log(r)", "log(C(r))", "#ef4444",
      corrDim.scalingRegion);
  }, [corrDim]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">フラクタル拡張解析</h3>
      <p className="text-xs text-gray-500 mb-3">R/S解析 / DCCA / 相関次元</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">R/S Hurst指数</div>
          <div className="font-bold">{rs.hurst.toFixed(3)}</div>
          <div className="text-gray-400">{rs.interpretation}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Cross-Hurst</div>
          <div className="font-bold">{dcca.crossHurst.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">相関次元 D₂</div>
          <div className="font-bold">{corrDim.dimension.toFixed(3)}</div>
          <div className="text-gray-400">{corrDim.dimension < 3 ? "低次元構造あり" : "高次元 (ノイズ的)"}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">95%CI (R/S)</div>
          <div className="font-bold">[{rs.confidence[0].toFixed(2)}, {rs.confidence[1].toFixed(2)}]</div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <canvas ref={rsCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <canvas ref={dccaCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <canvas ref={corrDimCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      <AnalysisGuide title="フラクタル拡張の読み方">
        <p><span className="font-medium">R/S解析:</span> Hurstの古典的Rescaled Range法。DFA(既に実装済み)とは異なるアルゴリズムでHurst指数を推定します。H{`<`}0.5=反平均回帰, H=0.5=ランダムウォーク, H{`>`}0.5=トレンド持続性。DFAとR/Sの値が一致するとHurst推定の信頼性が高まります。</p>
        <p><span className="font-medium">DCCA (Detrended Cross-Correlation):</span> DFAの2変数版。価格リターンと出来高リターンのスケール依存的な相関を測定します。ρ_DCCA(s)が特定スケールで高い場合、そのスケールでの連動性が強いことを示します。Cross-Hurst指数はクロスコリレーションのスケーリング指数です。</p>
        <p><span className="font-medium">相関次元 (Grassberger-Procaccia):</span> 位相空間再構成後のアトラクタの次元。低い値({`<`}3)なら低次元の決定論的構造がある可能性。高い値はノイズ支配的で、予測困難を示唆します。Lyapunov指数(既存)が「カオスの強さ」なら、相関次元は「アトラクタの複雑さ」を測定します。</p>
      </AnalysisGuide>
    </div>
  );
}

function drawLogLogPlot(
  canvas: HTMLCanvasElement,
  x: number[], y: number[],
  title: string, xLabel: string, yLabel: string,
  color: string,
  highlightRegion?: [number, number]
) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.parentElement?.clientWidth || 300;
  const height = 220;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx || x.length === 0) return;
  ctx.scale(dpr, dpr);

  const margin = { left: 45, right: 10, top: 20, bottom: 30 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);

  const xMin = Math.min(...x), xMax = Math.max(...x);
  const yMin = Math.min(...y), yMax = Math.max(...y);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const toX = (v: number) => margin.left + ((v - xMin) / xRange) * plotW;
  const toY = (v: number) => margin.top + plotH - ((v - yMin) / yRange) * plotH;

  // Grid
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const yy = margin.top + (i / 4) * plotH;
    ctx.beginPath(); ctx.moveTo(margin.left, yy); ctx.lineTo(margin.left + plotW, yy); ctx.stroke();
  }

  // Highlight scaling region
  if (highlightRegion) {
    ctx.fillStyle = color + "15";
    const x1 = toX(x[highlightRegion[0]]);
    const x2 = toX(x[highlightRegion[1]]);
    ctx.fillRect(x1, margin.top, x2 - x1, plotH);
  }

  // Data points
  ctx.fillStyle = color;
  for (let i = 0; i < x.length; i++) {
    ctx.beginPath();
    ctx.arc(toX(x[i]), toY(y[i]), 3, 0, 2 * Math.PI);
    ctx.fill();
  }

  // Line
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < x.length; i++) {
    const px = toX(x[i]), py = toY(y[i]);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Labels
  ctx.fillStyle = "#374151";
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(title, margin.left + plotW / 2, 12);
  ctx.font = "9px sans-serif";
  ctx.fillStyle = "#6b7280";
  ctx.fillText(xLabel, margin.left + plotW / 2, height - 5);
  ctx.save();
  ctx.translate(10, margin.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}
