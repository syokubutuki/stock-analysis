"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeVolumeReturn } from "../../lib/volume-price-dynamics";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; }

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

const Q_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444"];

export default function VolumeReturnChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const result = useMemo(() => computeVolumeReturn(prices), [prices]);

  useEffect(() => {
    if (!canvasRef.current || result.buckets.length === 0) return;
    const H = 320;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 60, mr = 20, mt = 30, mb = 40;
    const plotW = width - ml - mr, plotH = height - mt - mb;

    const buckets = result.buckets;
    const allReturns = buckets.flatMap(b => [b.mean - b.std, b.mean + b.std]);
    const minR = Math.min(...allReturns, -0.01);
    const maxR = Math.max(...allReturns, 0.01);
    const rangeR = maxR - minR || 0.02;
    const yFrom = (v: number) => mt + plotH - ((v - minR) / rangeR) * plotH;
    const zeroY = yFrom(0);

    // Grid
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = mt + (plotH * i) / 5;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      const val = maxR - (rangeR * i) / 5;
      ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText((val * 100).toFixed(2) + "%", ml - 4, y + 3);
    }
    // Zero line
    ctx.strokeStyle = "#6b7280"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(ml, zeroY); ctx.lineTo(width - mr, zeroY); ctx.stroke();
    ctx.setLineDash([]);

    const barGroupW = plotW / buckets.length;
    const barW = barGroupW * 0.6;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      const cx = ml + barGroupW * (i + 0.5);
      const x = cx - barW / 2;
      const yMean = yFrom(b.mean);
      const yTop = yFrom(b.mean + b.std);
      const yBot = yFrom(b.mean - b.std);

      // Error bar
      ctx.strokeStyle = "#6b7280"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, yTop); ctx.lineTo(cx, yBot); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 6, yTop); ctx.lineTo(cx + 6, yTop); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 6, yBot); ctx.lineTo(cx + 6, yBot); ctx.stroke();

      // Mean bar
      const barTop = b.mean >= 0 ? yMean : zeroY;
      const barBot = b.mean >= 0 ? zeroY : yMean;
      ctx.fillStyle = Q_COLORS[i] + "cc";
      ctx.fillRect(x, barTop, barW, barBot - barTop);
      ctx.strokeStyle = Q_COLORS[i]; ctx.lineWidth = 1;
      ctx.strokeRect(x, barTop, barW, barBot - barTop);

      // Label
      ctx.fillStyle = "#374151"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(b.label, cx, height - mb + 15);
      ctx.fillText(`n=${b.n}`, cx, height - mb + 27);
      ctx.font = "bold 10px sans-serif";
      ctx.fillStyle = b.mean >= 0 ? "#16a34a" : "#dc2626";
      ctx.fillText((b.mean * 100).toFixed(3) + "%", cx, yMean - 5);
    }

    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("出来高四分位別 平均日次リターン (±1σ)", ml, mt - 10);
  }, [result]);

  if (result.buckets.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">出来高-リターン同時分析</h3>
      <div className="relative"><canvas ref={canvasRef} /></div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="p-3 bg-red-50 rounded border border-red-200">
          <div className="font-medium text-red-800 mb-1">出来高急増時 (相対出来高 &gt; 2.0)</div>
          <div className="grid grid-cols-3 gap-2">
            <div><span className="text-gray-500">平均リターン</span><div className="font-mono font-bold">{(result.surgeReturns.meanReturn * 100).toFixed(3)}%</div></div>
            <div><span className="text-gray-500">勝率</span><div className="font-mono font-bold">{(result.surgeReturns.winRate * 100).toFixed(1)}%</div></div>
            <div><span className="text-gray-500">サンプル</span><div className="font-mono font-bold">{result.surgeReturns.n}</div></div>
          </div>
        </div>
        <div className="p-3 bg-blue-50 rounded border border-blue-200">
          <div className="font-medium text-blue-800 mb-1">出来高低迷時 (相対出来高 &lt; 0.5)</div>
          <div className="grid grid-cols-3 gap-2">
            <div><span className="text-gray-500">平均リターン</span><div className="font-mono font-bold">{(result.declineReturns.meanReturn * 100).toFixed(3)}%</div></div>
            <div><span className="text-gray-500">勝率</span><div className="font-mono font-bold">{(result.declineReturns.winRate * 100).toFixed(1)}%</div></div>
            <div><span className="text-gray-500">サンプル</span><div className="font-mono font-bold">{result.declineReturns.n}</div></div>
          </div>
        </div>
      </div>

      <AnalysisGuide title="出来高-リターン同時分析の詳細理論">
        <p className="font-medium text-gray-700">1. 分析の目的</p>
        <p>出来高の大きさとリターンの関係を定量化します。出来高を20日移動平均で正規化した「相対出来高」を計算し、四分位に分割して各群のリターン特性を比較します。</p>
        <p className="font-medium text-gray-700 mt-3">2. 相対出来高の計算</p>
        <p>{"相対出来高 = V_t / MA(V, 20)_t。1.0が平均的な出来高水準。2.0以上は出来高急増（サージ）、0.5以下は出来高低迷。"}</p>
        <p className="font-medium text-gray-700 mt-3">3. 典型的なパターン</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>高出来高+正リターン</strong>: 強い買い需要。トレンド継続のシグナル。</li>
          <li><strong>高出来高+負リターン</strong>: パニック売り。底打ち（セリングクライマックス）の可能性。</li>
          <li><strong>低出来高+動き</strong>: 確信のない動き。トレンド反転の前兆の可能性。</li>
          <li><strong>出来高急増</strong>: 機関投資家の参入、ニュース、イベントを示唆。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 実務的な示唆</p>
        <p>高出来高時のリターンが有意に正の場合、出来高急増を「買いシグナル」として利用できる可能性があります。逆に、高出来高時に負のリターンが多い場合は、パニック売りが支配的です。</p>
      </AnalysisGuide>
    </div>
  );
}
