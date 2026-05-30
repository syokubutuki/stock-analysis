"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeTRDecomp } from "../../lib/ohlc-extended";
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

export default function TrueRangeDecompChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const result = useMemo(() => computeTRDecomp(prices), [prices]);

  useEffect(() => {
    if (!canvasRef.current || result.dates.length === 0) return;
    const H = 300;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 50, mr = 20, mt = 30, mb = 30;
    const plotW = width - ml - mr, plotH = height - mt - mb;

    const gc = result.gapContribution;
    const n = gc.length;
    if (n === 0) return;

    // Draw gap contribution ratio time series
    const xFrom = (i: number) => ml + (i / (n - 1)) * plotW;
    const yFrom = (v: number) => mt + plotH - v * plotH;

    // Shaded area
    ctx.beginPath();
    ctx.moveTo(xFrom(0), yFrom(0));
    for (let i = 0; i < n; i++) ctx.lineTo(xFrom(i), yFrom(gc[i]));
    ctx.lineTo(xFrom(n - 1), yFrom(0));
    ctx.closePath();
    ctx.fillStyle = "rgba(239, 68, 68, 0.15)";
    ctx.fill();

    // Line
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xFrom(i), y = yFrom(gc[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Grid
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = mt + (plotH * i) / 5;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(`${((5 - i) * 20)}%`, ml - 4, y + 3);
    }

    // Dominant component stats
    const intraCount = result.dominantComponent.filter(d => d === "intraday").length;
    const gapUpCount = result.dominantComponent.filter(d => d === "gapUp").length;
    const gapDownCount = result.dominantComponent.filter(d => d === "gapDown").length;
    const total = result.dominantComponent.length || 1;

    // Pie chart (small, in corner)
    const pieX = width - mr - 70, pieY = mt + 50, pieR = 35;
    const segments = [
      { pct: intraCount / total, color: "#3b82f6", label: "日中" },
      { pct: gapUpCount / total, color: "#22c55e", label: "GU" },
      { pct: gapDownCount / total, color: "#ef4444", label: "GD" },
    ];
    let startAngle = -Math.PI / 2;
    for (const seg of segments) {
      const endAngle = startAngle + seg.pct * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(pieX, pieY);
      ctx.arc(pieX, pieY, pieR, startAngle, endAngle);
      ctx.closePath(); ctx.fillStyle = seg.color + "cc"; ctx.fill();
      // Label
      const mid = (startAngle + endAngle) / 2;
      const lx = pieX + Math.cos(mid) * (pieR + 14);
      const ly = pieY + Math.sin(mid) * (pieR + 14);
      ctx.fillStyle = "#374151"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(`${seg.label} ${(seg.pct * 100).toFixed(0)}%`, lx, ly + 3);
      startAngle = endAngle;
    }

    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("ギャップ寄与率 (20日ローリング) と支配的成分", ml, mt - 10);
  }, [result]);

  if (result.dates.length === 0) return null;

  // Latest stats
  const lastGC = result.gapContribution[result.gapContribution.length - 1] || 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">True Range分解</h3>
      <div className="relative"><canvas ref={canvasRef} /></div>

      <div className={`p-3 rounded text-xs ${lastGC > 0.3 ? "bg-red-50 text-red-800" : "bg-green-50 text-green-800"}`}>
        <div className="font-medium mb-1">現在のギャップ寄与率: {(lastGC * 100).toFixed(1)}%</div>
        <p>
          {lastGC > 0.3
            ? "オーバーナイトリスクが高い状態。ギャップ（前日終値→当日始値の乖離）がTrue Rangeの主要因。ポジションの翌日持ち越しリスクに注意。"
            : "日中の価格変動が主体。オーバーナイトリスクは限定的。"}
        </p>
      </div>

      <AnalysisGuide title="True Range分解の詳細理論">
        <p className="font-medium text-gray-700">1. True Range (TR) の定義</p>
        <p>{"TR_t = max(H_t - L_t, |H_t - C_{t-1}|, |L_t - C_{t-1}|)。通常の日中レンジ(H-L)に加え、前日終値からのギャップを考慮した「真の変動幅」です。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 3つの成分</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>日中成分 (H-L)</strong>: ザラ場中の価格変動。流動性と板の厚さに依存。</li>
          <li><strong>ギャップアップ成分 |H-C_prev|</strong>: 翌日始値が前日終値より高い場合の上方ギャップ。好材料やオーバーナイトの買い。</li>
          <li><strong>ギャップダウン成分 |L-C_prev|</strong>: 翌日始値が前日終値より低い場合の下方ギャップ。悪材料やオーバーナイトの売り。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. ギャップ寄与率</p>
        <p>{"20日ローリングでギャップ成分(max(|H-C_prev|, |L-C_prev|) - (H-L)の正部分)のTRに対する比率を計算。オーバーナイトリスクの時変性を可視化します。"}</p>
        <p className="font-medium text-gray-700 mt-3">4. 実務への示唆</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ギャップ寄与率が高い時期 → 翌日持ち越しリスクが大きい → デイトレードが有利</li>
          <li>ギャップ寄与率が低い時期 → 日中の価格発見機能が活発 → スイングトレードが可能</li>
          <li>決算シーズンではギャップ寄与率が急上昇する傾向がある</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
