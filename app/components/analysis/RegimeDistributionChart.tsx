"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeRegimeDistribution } from "../../lib/regime-extended";
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

export default function RegimeDistributionChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const result = useMemo(() => computeRegimeDistribution(prices), [prices]);

  useEffect(() => {
    if (!canvasRef.current || result.regimes.length === 0) return;
    const H = 320;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 50, mr = 20, mt = 30, mb = 40;
    const plotW = width - ml - mr, plotH = height - mt - mb;

    // Combined KDE plot
    const allKDE = result.regimes.flatMap(r => r.kde);
    if (allKDE.length === 0) return;
    const xMin = Math.min(...allKDE.map(p => p.x));
    const xMax = Math.max(...allKDE.map(p => p.x));
    const yMax = Math.max(...allKDE.map(p => p.y));
    const xRange = xMax - xMin || 1;

    const xFrom = (v: number) => ml + ((v - xMin) / xRange) * plotW;
    const yFrom = (v: number) => mt + plotH - (v / yMax) * plotH;

    // Grid
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = mt + (plotH * i) / 5;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
    }
    // Zero line
    const zeroX = xFrom(0);
    if (zeroX > ml && zeroX < width - mr) {
      ctx.strokeStyle = "#9ca3af"; ctx.lineWidth = 0.8; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(zeroX, mt); ctx.lineTo(zeroX, mt + plotH); ctx.stroke();
      ctx.setLineDash([]);
    }

    // KDE curves with fill
    for (const regime of result.regimes) {
      if (regime.kde.length === 0) continue;
      // Fill
      ctx.beginPath();
      ctx.moveTo(xFrom(regime.kde[0].x), yFrom(0));
      for (const p of regime.kde) ctx.lineTo(xFrom(p.x), yFrom(p.y));
      ctx.lineTo(xFrom(regime.kde[regime.kde.length - 1].x), yFrom(0));
      ctx.closePath();
      ctx.fillStyle = regime.color + "22";
      ctx.fill();
      // Line
      ctx.strokeStyle = regime.color; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < regime.kde.length; i++) {
        const x = xFrom(regime.kde[i].x), y = yFrom(regime.kde[i].y);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // X axis labels
    ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    for (let i = 0; i <= 6; i++) {
      const v = xMin + (xRange * i) / 6;
      ctx.fillText((v * 100).toFixed(1) + "%", xFrom(v), height - mb + 15);
    }
    ctx.fillText("日次リターン", ml + plotW / 2, height - mb + 30);

    // Legend
    const legX = ml + 10;
    for (let i = 0; i < result.regimes.length; i++) {
      const r = result.regimes[i];
      ctx.fillStyle = r.color + "cc";
      ctx.fillRect(legX + i * 100, mt + 5, 14, 10);
      ctx.fillStyle = "#374151"; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(r.label, legX + i * 100 + 18, mt + 14);
    }

    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("レジーム別リターン分布 (KDE)", ml, mt - 10);
  }, [result]);

  if (result.regimes.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">レジーム別分布特性</h3>
      <div className="relative"><canvas ref={canvasRef} /></div>

      <div className="grid grid-cols-3 gap-3">
        {result.regimes.map((r, i) => (
          <div key={i} className="p-3 rounded-lg border bg-gray-50 text-xs">
            <div className="font-bold mb-1" style={{ color: r.color }}>{r.label}</div>
            <div className="grid grid-cols-2 gap-1">
              <div>平均: <span className="font-mono">{(r.mean * 100).toFixed(3)}%</span></div>
              <div>σ: <span className="font-mono">{(r.std * 100).toFixed(3)}%</span></div>
              <div>歪度: <span className="font-mono">{r.skew.toFixed(3)}</span></div>
              <div>尖度: <span className="font-mono">{r.kurtosis.toFixed(2)}</span></div>
              <div className="col-span-2">n = {r.n}</div>
            </div>
          </div>
        ))}
      </div>

      <AnalysisGuide title="レジーム別分布特性の詳細理論">
        <p className="font-medium text-gray-700">1. レジーム別分布比較の目的</p>
        <p>市場のボラティリティ状態（レジーム）によって、リターンの分布形状は大きく変化します。低ボラレジームでは正規分布に近く、高ボラレジームではファットテール・左歪みが顕著になる傾向があります。</p>
        <p className="font-medium text-gray-700 mt-3">2. KDE (カーネル密度推定)</p>
        <p>{"f̂(x) = (1/nh) Σ K((x - x_i)/h)。Gaussian カーネル K(u) = (1/√(2π))exp(-u²/2) を使用。バンド幅 h はSilvermanの法則 h = 1.06 × σ × n^(-1/5) で自動設定。"}</p>
        <p className="font-medium text-gray-700 mt-3">3. 分布特性の比較</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>平均</strong>: 各レジームでのリターンの方向バイアス。高ボラレジームは平均負（暴落局面）になりやすい。</li>
          <li><strong>標準偏差</strong>: 変動の大きさ。定義上、レジーム間で大きく異なる。</li>
          <li><strong>歪度</strong>: 負の歪度 → 大きな下落が多い。高ボラレジームで顕著。</li>
          <li><strong>尖度</strong>: {"3超 → ファットテール。極端なリターンが正規分布より頻繁。"}</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 実務的活用</p>
        <p>現在のレジームに対応する分布を用いてリスク管理を行うことで、全期間平均のVaRよりも精度の高いリスク推定が可能になります。</p>
      </AnalysisGuide>
    </div>
  );
}
