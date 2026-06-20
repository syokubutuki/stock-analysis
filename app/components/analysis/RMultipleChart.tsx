"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { rMultiples } from "../../lib/execution-stats";
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

export default function RMultipleChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const res = useMemo(() => (prices.length < 260 ? null : rMultiples(prices, 20)), [prices]);

  useEffect(() => {
    if (!canvasRef.current || !res) return;
    const init = initCanvas(canvasRef.current, 200);
    if (!init) return;
    const { ctx, width } = init;
    const ml = 30, mr = 10, mt = 22, mb = 24;
    const plotW = width - ml - mr, plotH = 200 - mt - mb;
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("R倍数の分布（1R=リスク=2ATR）", ml, 14);
    const lo = -3, hi = 5, bins = 16;
    const step = (hi - lo) / bins;
    const counts = new Array(bins).fill(0);
    for (const r of res.rs) { const b = Math.max(0, Math.min(bins - 1, Math.floor((r - lo) / step))); counts[b]++; }
    const maxC = Math.max(1, ...counts);
    const slot = plotW / bins;
    const zeroBin = (0 - lo) / step;
    for (let i = 0; i < bins; i++) {
      const h = (counts[i] / maxC) * plotH;
      const binCenter = lo + (i + 0.5) * step;
      ctx.fillStyle = binCenter >= 0 ? "#16a34a" : "#dc2626";
      ctx.fillRect(ml + i * slot + 1, mt + plotH - h, slot - 2, h);
    }
    // 0R線
    ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(ml + zeroBin * slot, mt); ctx.lineTo(ml + zeroBin * slot, mt + plotH); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    for (let r = lo; r <= hi; r += 2) ctx.fillText(`${r}R`, ml + ((r - lo) / step) * slot, mt + plotH + 12);
  }, [res]);

  if (prices.length < 260 || !res) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">トレード期待値・R倍数分布</h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className={`p-2 rounded border ${res.expectancyR >= 0 ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}><div className="text-gray-500">期待値</div><div className="font-mono font-bold">{res.expectancyR.toFixed(2)}R</div></div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50"><div className="text-gray-500">勝率</div><div className="font-mono font-bold">{(res.winRate * 100).toFixed(0)}%</div></div>
        <div className="p-2 rounded border border-green-200 bg-green-50"><div className="text-gray-500">平均利益</div><div className="font-mono font-bold">{res.avgWinR.toFixed(2)}R</div></div>
        <div className="p-2 rounded border border-red-200 bg-red-50"><div className="text-gray-500">平均損失</div><div className="font-mono font-bold">{res.avgLossR.toFixed(2)}R</div></div>
      </div>

      <div className="relative"><canvas ref={canvasRef} /></div>

      <AnalysisGuide title="R倍数分布の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"1トレードの損益を『リスク(1R)の何倍取れたか』で標準化して見る。1R＝最初に決めた損切り幅(=2ATR)。これにより銘柄や時期によらず戦略の優位性を比較できる。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>R = 損益 / リスク幅。<strong>期待値(R)</strong> = 勝率×平均利益R − 負け率×平均損失R。</li>
          <li>期待値がプラスなら、繰り返すほど資産は増える（正の期待値戦略）。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>期待値Rがプラスかをまず確認。プラスでない戦略は資金管理では救えない。</li>
          <li>低勝率でも平均利益Rが大きければ成立（トレンドフォロー型）。勝率と平均RのバランスでKelly的なサイズを決める。</li>
          <li>分布の右裾（大きなプラスR）が利益の源泉。それを刈り取らない出口設計が重要。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>全日エントリー・固定ストップの簡易シミュレーション。特定シグナルでは分布が変わる。</li>
          <li>取引コスト未控除。スリッページで期待値は目減りする。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
