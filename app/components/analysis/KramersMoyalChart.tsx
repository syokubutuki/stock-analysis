"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { logReturns } from "../../lib/transforms";
import { kramersMoyal } from "../../lib/kramers-moyal";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function KramersMoyalChart({ prices }: Props) {
  const driftCanvasRef = useRef<HTMLCanvasElement>(null);
  const potentialCanvasRef = useRef<HTMLCanvasElement>(null);

  const closes = prices.map((p) => p.close);
  const lr = logReturns(closes);
  const km = useMemo(() => kramersMoyal(closes.slice(0, -1), lr, 20), [prices]);

  // Drift + Diffusion plot
  useEffect(() => {
    const canvas = driftCanvasRef.current;
    if (!canvas || km.priceLevels.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement?.clientWidth || 400;
    const height = 220;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { left: 55, right: 15, top: 20, bottom: 30 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const pMin = Math.min(...km.priceLevels);
    const pMax = Math.max(...km.priceLevels);
    const pRange = pMax - pMin || 1;
    const maxDrift = Math.max(...km.drift.map(Math.abs), 0.001);
    const maxDiff = Math.max(...km.diffusion, 0.001);

    const toX = (p: number) => margin.left + ((p - pMin) / pRange) * plotW;
    const halfH = plotH / 2;

    // Zero line
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top + halfH);
    ctx.lineTo(margin.left + plotW, margin.top + halfH);
    ctx.stroke();

    // Drift μ(p)
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    km.priceLevels.forEach((p, i) => {
      const x = toX(p);
      const y = margin.top + halfH - (km.drift[i] / maxDrift) * halfH * 0.9;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill positive/negative drift
    ctx.globalAlpha = 0.15;
    km.priceLevels.forEach((p, i) => {
      const x = toX(p);
      const y = margin.top + halfH - (km.drift[i] / maxDrift) * halfH * 0.9;
      const barW = plotW / km.priceLevels.length;
      ctx.fillStyle = km.drift[i] >= 0 ? "#22c55e" : "#ef4444";
      ctx.fillRect(x - barW / 2, Math.min(y, margin.top + halfH), barW, Math.abs(y - margin.top - halfH));
    });
    ctx.globalAlpha = 1;

    // Diffusion σ(p) (bottom half, inverted)
    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 2;
    ctx.beginPath();
    km.priceLevels.forEach((p, i) => {
      const x = toX(p);
      const y = margin.top + halfH + (km.diffusion[i] / maxDiff) * halfH * 0.8;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Stable/unstable points
    ctx.font = "bold 12px sans-serif";
    km.stablePoints.forEach((p) => {
      const x = toX(p);
      ctx.fillStyle = "#22c55e";
      ctx.textAlign = "center";
      ctx.fillText("▲", x, margin.top + halfH + 14);
    });
    km.unstablePoints.forEach((p) => {
      const x = toX(p);
      ctx.fillStyle = "#ef4444";
      ctx.textAlign = "center";
      ctx.fillText("▼", x, margin.top + halfH + 14);
    });

    // Labels
    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Kramers-Moyal: ドリフト μ(p) と拡散 σ(p)", width / 2, 12);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("株価レベル", width / 2, height - 5);

    ctx.textAlign = "left";
    ctx.fillStyle = "#3b82f6";
    ctx.fillText("μ(p) ドリフト", margin.left + 5, margin.top + 15);
    ctx.fillStyle = "#f97316";
    ctx.fillText("σ(p) 拡散", margin.left + 5, margin.top + plotH - 5);
  }, [km]);

  // Potential function
  useEffect(() => {
    const canvas = potentialCanvasRef.current;
    if (!canvas || km.priceLevels.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement?.clientWidth || 400;
    const height = 200;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { left: 55, right: 15, top: 20, bottom: 30 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const pMin = Math.min(...km.priceLevels);
    const pMax = Math.max(...km.priceLevels);
    const pRange = pMax - pMin || 1;

    const toX = (p: number) => margin.left + ((p - pMin) / pRange) * plotW;

    // Potential curve
    ctx.strokeStyle = "#8b5cf6";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    km.priceLevels.forEach((p, i) => {
      const x = toX(p);
      const y = margin.top + plotH - km.potential[i] * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill under curve
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = "#8b5cf6";
    ctx.beginPath();
    km.priceLevels.forEach((p, i) => {
      const x = toX(p);
      const y = margin.top + plotH - km.potential[i] * plotH;
      if (i === 0) ctx.moveTo(x, margin.top + plotH);
      ctx.lineTo(x, y);
    });
    ctx.lineTo(toX(km.priceLevels[km.priceLevels.length - 1]), margin.top + plotH);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Stable points (minima = attractors)
    ctx.font = "bold 11px sans-serif";
    km.stablePoints.forEach((p) => {
      const x = toX(p);
      const idx = km.priceLevels.findIndex((v) => Math.abs(v - p) < (pRange / km.priceLevels.length));
      if (idx >= 0) {
        const y = margin.top + plotH - km.potential[idx] * plotH;
        ctx.fillStyle = "#22c55e";
        ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fill();
        ctx.textAlign = "center";
        ctx.fillText(`${p.toFixed(0)}`, x, y + 16);
      }
    });

    km.unstablePoints.forEach((p) => {
      const x = toX(p);
      const idx = km.priceLevels.findIndex((v) => Math.abs(v - p) < (pRange / km.priceLevels.length));
      if (idx >= 0) {
        const y = margin.top + plotH - km.potential[idx] * plotH;
        ctx.fillStyle = "#ef4444";
        ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fill();
      }
    });

    // Labels
    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("ポテンシャル関数 V(p) = -∫μ(p)dp", width / 2, 12);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("株価レベル (緑=安定点, 赤=不安定点)", width / 2, height - 5);
  }, [km]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">Kramers-Moyal係数 / ポテンシャル関数</h3>
      <p className="text-xs text-gray-500 mb-3">確率微分方程式の局所ドリフトと拡散を非パラメトリックに推定</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3 text-xs">
        <div className="p-2 bg-green-50 rounded">
          <div className="text-green-700 font-medium">安定点 (ポテンシャル極小)</div>
          <div className="font-bold">{km.stablePoints.map((p) => p.toFixed(0)).join(", ") || "なし"}</div>
          <div className="text-green-600">株価が引き寄せられる価格帯</div>
        </div>
        <div className="p-2 bg-red-50 rounded">
          <div className="text-red-700 font-medium">不安定点 (ポテンシャル極大)</div>
          <div className="font-bold">{km.unstablePoints.map((p) => p.toFixed(0)).join(", ") || "なし"}</div>
          <div className="text-red-600">株価が反発される価格帯</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">解析ビン数</div>
          <div className="font-bold">{km.priceLevels.length}</div>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <canvas ref={driftCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <canvas ref={potentialCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      <AnalysisGuide title="Kramers-Moyal・ポテンシャルの読み方">
        <p><span className="font-medium">Kramers-Moyal係数:</span> 確率微分方程式 dp = μ(p)dt + σ(p)dW の局所係数を、各価格帯での条件付きモーメントから非パラメトリックに推定します。μ(p)が正なら上昇圧力、負なら下降圧力がその価格帯にあります。</p>
        <p><span className="font-medium">ポテンシャル関数:</span> V(p) = -∫μ(p)dp を数値積分。物理学の「ポテンシャルエネルギー」のアナロジー。極小点(安定平衡)は株価のアトラクタ(引力点)、極大点(不安定平衡)は反発点です。ボールが谷底に転がるように、株価はポテンシャルの極小に向かう傾向があります。</p>
        <p><span className="font-medium">拡散 σ(p):</span> 各価格帯でのボラティリティ。安い価格帯と高い価格帯で拡散が異なれば、価格レベル依存のリスク構造があることを意味します。</p>
      </AnalysisGuide>
    </div>
  );
}
