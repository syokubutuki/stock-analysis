"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeIntradayPath } from "../../lib/ohlc-extended";
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

const PAT_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444"];

export default function IntradayPathChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const result = useMemo(() => computeIntradayPath(prices), [prices]);

  useEffect(() => {
    if (!canvasRef.current || result.patterns.length === 0) return;
    const H = 300;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 140, mr = 20, mt = 30, mb = 30;
    const plotW = width - ml - mr, plotH = height - mt - mb;

    const pats = result.patterns;
    const maxPct = Math.max(...pats.map(p => p.pct), 0.1);
    const rowH = plotH / pats.length;

    for (let i = 0; i < pats.length; i++) {
      const p = pats[i];
      const y = mt + i * rowH;
      const barW = (p.pct / maxPct) * plotW * 0.7;

      // Bar
      ctx.fillStyle = PAT_COLORS[i % PAT_COLORS.length] + "bb";
      ctx.fillRect(ml, y + rowH * 0.15, barW, rowH * 0.5);

      // Pattern name
      ctx.fillStyle = "#374151"; ctx.font = "11px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(p.name, ml - 8, y + rowH * 0.45);
      ctx.font = "9px sans-serif"; ctx.fillStyle = "#9ca3af";
      ctx.fillText(p.description, ml - 8, y + rowH * 0.7);

      // Stats
      ctx.fillStyle = "#374151"; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
      const statsText = `${(p.pct * 100).toFixed(1)}%  (n=${p.count})  翌日: ${(p.avgNextReturn * 100).toFixed(3)}%  勝率${(p.winRate * 100).toFixed(0)}%`;
      ctx.fillText(statsText, ml + barW + 8, y + rowH * 0.48);

      // Win rate indicator
      const wrColor = p.winRate > 0.52 ? "#22c55e" : p.winRate < 0.48 ? "#ef4444" : "#9ca3af";
      ctx.fillStyle = wrColor;
      ctx.beginPath(); ctx.arc(ml + barW + 4, y + rowH * 0.42, 3, 0, Math.PI * 2); ctx.fill();
    }

    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("日中パスパターン別 出現頻度と翌日リターン", ml, mt - 10);
  }, [result]);

  if (result.patterns.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">日中パス推定</h3>
      <div className="relative"><canvas ref={canvasRef} /></div>

      <AnalysisGuide title="日中パス推定の詳細理論">
        <p className="font-medium text-gray-700">1. 日中パスとは</p>
        <p>{"OHLCの4値から日中の価格の動き順序を推定します。Open→High(O→H)の距離とOpen→Low(O→L)の距離を比較し、どちらが先に到達したかを推定します。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. パターン分類</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>強気上昇</strong>: O→H距離が大きく、陽線。朝から高値を目指す展開。</li>
          <li><strong>反転上昇</strong>: O→L距離が大きいが、最終的に陽線。一度下がってから反発。</li>
          <li><strong>反転下落</strong>: O→H距離が大きいが、最終的に陰線。一度上がってから失速。</li>
          <li><strong>強気下落</strong>: O→L距離が大きく、陰線。朝から安値を目指す展開。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. OH比率・OL比率</p>
        <p>{"OH比率 = (High-Open)/(High-Low): 日中レンジのうち始値から高値までの割合。OL比率 = (Open-Low)/(High-Low): 始値から安値までの割合。"}</p>
        <p className="font-medium text-gray-700 mt-3">4. 翌日リターンとの関係</p>
        <p>各パターン後の翌日リターンを計算し、特定のパターンが翌日の方向を予測するか検証します。反転パターン（一度反対方向に動いてから戻る）は、特にトレンド転換のシグナルとして注目されます。</p>
      </AnalysisGuide>
    </div>
  );
}
