"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeBacktest, type BacktestResult } from "../../lib/predictability";
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

const STRAT_COLORS = ["#6b7280", "#3b82f6", "#10b981", "#f59e0b"];

export default function SimpleBacktestChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const results = useMemo(() => computeBacktest(prices), [prices]);

  useEffect(() => {
    if (!canvasRef.current || results.length === 0) return;
    const H = 350;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 60, mr = 20, mt = 30, mb = 30;
    const plotW = width - ml - mr, plotH = height - mt - mb;

    const allCum = results.flatMap(r => r.cumReturns);
    const minCum = Math.min(...allCum, 0);
    const maxCum = Math.max(...allCum, 0.01);
    const rangeCum = maxCum - minCum || 0.01;
    const maxLen = Math.max(...results.map(r => r.cumReturns.length));

    const xFrom = (i: number) => ml + (i / (maxLen - 1)) * plotW;
    const yFrom = (v: number) => mt + plotH - ((v - minCum) / rangeCum) * plotH;

    // Grid
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = mt + (plotH * i) / 5;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      const val = maxCum - (rangeCum * i) / 5;
      ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText((val * 100).toFixed(0) + "%", ml - 4, y + 3);
    }
    // Zero line
    const zeroY = yFrom(0);
    ctx.strokeStyle = "#374151"; ctx.lineWidth = 0.8; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(ml, zeroY); ctx.lineTo(width - mr, zeroY); ctx.stroke();
    ctx.setLineDash([]);

    // Draw curves
    for (let si = 0; si < results.length; si++) {
      const r = results[si];
      ctx.strokeStyle = STRAT_COLORS[si]; ctx.lineWidth = si === 0 ? 2.5 : 1.5;
      ctx.beginPath();
      for (let i = 0; i < r.cumReturns.length; i++) {
        const x = xFrom(i), y = yFrom(r.cumReturns[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Legend
    ctx.font = "10px sans-serif";
    for (let si = 0; si < results.length; si++) {
      const lx = ml + 10 + si * 130;
      ctx.strokeStyle = STRAT_COLORS[si]; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx, mt + 8); ctx.lineTo(lx + 18, mt + 8); ctx.stroke();
      ctx.fillStyle = "#374151"; ctx.textAlign = "left";
      ctx.fillText(results[si].strategy, lx + 22, mt + 12);
    }

    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("戦略別 累積リターン比較", ml, mt - 10);
  }, [results]);

  if (results.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">シンプルバックテスト</h3>
      <div className="relative"><canvas ref={canvasRef} /></div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead><tr className="border-b border-gray-200">
            <th className="py-1 px-2 text-left text-gray-500">戦略</th>
            <th className="py-1 px-2 text-center text-gray-500">累積R</th>
            <th className="py-1 px-2 text-center text-gray-500">年率R</th>
            <th className="py-1 px-2 text-center text-gray-500">年率Vol</th>
            <th className="py-1 px-2 text-center text-gray-500">Sharpe</th>
            <th className="py-1 px-2 text-center text-gray-500">MaxDD</th>
            <th className="py-1 px-2 text-center text-gray-500">勝率</th>
            <th className="py-1 px-2 text-center text-gray-500">取引数</th>
          </tr></thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i} className="border-b border-gray-100">
                <td className="py-1 px-2 font-medium" style={{ color: STRAT_COLORS[i] }}>{r.strategy}</td>
                <td className={`py-1 px-2 text-center font-mono ${r.totalReturn >= 0 ? "text-green-600" : "text-red-600"}`}>{(r.totalReturn * 100).toFixed(1)}%</td>
                <td className={`py-1 px-2 text-center font-mono ${r.annualReturn >= 0 ? "text-green-600" : "text-red-600"}`}>{(r.annualReturn * 100).toFixed(1)}%</td>
                <td className="py-1 px-2 text-center font-mono text-gray-600">{(r.annualVol * 100).toFixed(1)}%</td>
                <td className={`py-1 px-2 text-center font-mono font-medium ${r.sharpe >= 0 ? "text-blue-600" : "text-red-600"}`}>{r.sharpe.toFixed(3)}</td>
                <td className="py-1 px-2 text-center font-mono text-red-600">{(r.maxDrawdown * 100).toFixed(1)}%</td>
                <td className={`py-1 px-2 text-center font-mono ${r.winRate >= 0.5 ? "text-green-600" : "text-red-600"}`}>{(r.winRate * 100).toFixed(1)}%</td>
                <td className="py-1 px-2 text-center font-mono text-gray-500">{r.nTrades}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AnalysisGuide title="シンプルバックテストの詳細理論">
        <p className="font-medium text-gray-700">1. 4つの戦略</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>Buy &amp; Hold</strong>: 常にロングポジション。ベンチマーク。</li>
          <li><strong>RSIリバージョン</strong>: {"RSI(14)<30で5日間ロング、RSI(14)>70で5日間フラット。売られすぎ買い/買われすぎ売りの逆張り戦略。"}</li>
          <li><strong>MACDモメンタム</strong>: MACDヒストグラムが正ならロング、負ならフラット。トレンドフォロー戦略。</li>
          <li><strong>ボラティリティブレイクアウト</strong>: {"日次リターンが±1.5σ(20日)を超えたらその方向にポジション。ブレイクアウト戦略。"}</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">2. パフォーマンス指標</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>年率リターン</strong>: (累積対数リターン / 日数) x 252</li>
          <li><strong>シャープレシオ</strong>: 年率リターン / 年率ボラティリティ</li>
          <li><strong>最大ドローダウン</strong>: 累積リターンのピークからの最大下落</li>
          <li><strong>勝率</strong>: ポジション保有中に正リターンだった日の割合</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>取引コスト（手数料、スプレッド）は含まれていません。実際のパフォーマンスはこれより悪化。</li>
          <li>スリッページ（執行価格のずれ）も未考慮。</li>
          <li>過去のパフォーマンスは将来の結果を保証しません（過学習のリスク）。</li>
          <li>Buy &amp; Holdを上回る戦略がない場合、アクティブ運用の必要性は低い。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
