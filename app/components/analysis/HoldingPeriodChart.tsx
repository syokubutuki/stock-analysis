"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeHoldingPeriods, type HoldingPeriodStats } from "../../lib/cross-analysis";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";

interface Props {
  prices: PricePoint[];
}

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

function pctFmt(v: number): string {
  return (v * 100).toFixed(2) + "%";
}

export default function HoldingPeriodChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const stats = useMemo(() => computeHoldingPeriods(prices), [prices]);

  useEffect(() => {
    if (!canvasRef.current || stats.length === 0) return;
    const canvasH = 400;
    const init = initCanvas(canvasRef.current, canvasH);
    if (!init) return;
    const { ctx, width, height } = init;

    const ml = 60, mr = 60, mt = 40, mb = 50;
    const plotW = width - ml - mr;
    const plotH = height - mt - mb;

    // Find optimal Sharpe
    const maxSharpe = Math.max(...stats.map(s => s.sharpe));
    const minSharpe = Math.min(...stats.map(s => s.sharpe));
    const optimalIdx = stats.findIndex(s => s.sharpe === maxSharpe);
    const sharpeRange = Math.max(maxSharpe - minSharpe, 0.1);

    // X positions (evenly spaced)
    const xPos = stats.map((_, i) => ml + (plotW * i) / (stats.length - 1 || 1));

    // === Draw Sharpe ratio curve ===
    const yFromSharpe = (v: number) => mt + plotH - ((v - minSharpe + sharpeRange * 0.1) / (sharpeRange * 1.2)) * plotH;

    // Grid
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    const nGrid = 5;
    for (let i = 0; i <= nGrid; i++) {
      const y = mt + (plotH * i) / nGrid;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      const val = minSharpe - sharpeRange * 0.1 + (sharpeRange * 1.2 * (nGrid - i)) / nGrid;
      ctx.fillStyle = "#9ca3af";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(val.toFixed(2), ml - 6, y + 3);
    }

    // Zero line
    if (minSharpe < 0 && maxSharpe > 0) {
      const zeroY = yFromSharpe(0);
      ctx.strokeStyle = "#d1d5db";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(ml, zeroY); ctx.lineTo(width - mr, zeroY); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Sharpe curve - area fill
    ctx.beginPath();
    ctx.moveTo(xPos[0], yFromSharpe(0));
    for (let i = 0; i < stats.length; i++) {
      ctx.lineTo(xPos[i], yFromSharpe(stats[i].sharpe));
    }
    ctx.lineTo(xPos[stats.length - 1], yFromSharpe(0));
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, mt, 0, mt + plotH);
    grad.addColorStop(0, "rgba(59, 130, 246, 0.15)");
    grad.addColorStop(1, "rgba(59, 130, 246, 0.02)");
    ctx.fillStyle = grad;
    ctx.fill();

    // Sharpe curve line
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < stats.length; i++) {
      const y = yFromSharpe(stats[i].sharpe);
      if (i === 0) ctx.moveTo(xPos[i], y);
      else ctx.lineTo(xPos[i], y);
    }
    ctx.stroke();

    // Points
    for (let i = 0; i < stats.length; i++) {
      const y = yFromSharpe(stats[i].sharpe);
      ctx.beginPath();
      ctx.arc(xPos[i], y, i === optimalIdx ? 6 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = i === optimalIdx ? "#f59e0b" : "#3b82f6";
      ctx.fill();
      if (i === optimalIdx) {
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Optimal label
    if (optimalIdx >= 0) {
      const ox = xPos[optimalIdx];
      const oy = yFromSharpe(stats[optimalIdx].sharpe);
      ctx.fillStyle = "#f59e0b";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`最適: ${stats[optimalIdx].days}日`, ox, oy - 14);
      ctx.fillText(`SR=${stats[optimalIdx].sharpe.toFixed(3)}`, ox, oy - 3);
    }

    // Win rate on right Y axis
    ctx.strokeStyle = "#10b981";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    for (let i = 0; i < stats.length; i++) {
      const wr = stats[i].winRate;
      const y = mt + plotH - wr * plotH;
      if (i === 0) ctx.moveTo(xPos[i], y);
      else ctx.lineTo(xPos[i], y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Right Y axis labels (Win Rate)
    ctx.fillStyle = "#10b981";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    for (let i = 0; i <= 4; i++) {
      const y = mt + plotH - (plotH * i) / 4;
      ctx.fillText(`${(i * 25)}%`, width - mr + 6, y + 3);
    }
    ctx.save();
    ctx.translate(width - mr + 45, mt + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("勝率", 0, 0);
    ctx.restore();

    // X axis labels
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (let i = 0; i < stats.length; i++) {
      ctx.fillText(`${stats[i].days}日`, xPos[i], height - mb + 15);
    }
    ctx.fillText("保有期間", ml + plotW / 2, height - mb + 35);

    // Left Y axis label
    ctx.fillStyle = "#3b82f6";
    ctx.save();
    ctx.translate(15, mt + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.font = "10px sans-serif";
    ctx.fillText("年率シャープレシオ", 0, 0);
    ctx.restore();

    // Border
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.strokeRect(ml, mt, plotW, plotH);

    // Title
    ctx.fillStyle = "#374151";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("保有期間別シャープレシオ & 勝率", ml, mt - 15);

    // Legend
    ctx.font = "10px sans-serif";
    const legX = ml + 10;
    ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(legX, mt + 10); ctx.lineTo(legX + 20, mt + 10); ctx.stroke();
    ctx.fillStyle = "#374151";
    ctx.textAlign = "left";
    ctx.fillText("シャープレシオ", legX + 24, mt + 14);
    ctx.strokeStyle = "#10b981"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.moveTo(legX + 110, mt + 10); ctx.lineTo(legX + 130, mt + 10); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText("勝率", legX + 134, mt + 14);
  }, [stats]);

  // Find optimal
  const optimal = stats.length > 0 ? stats.reduce((best, s) => s.sharpe > best.sharpe ? s : best, stats[0]) : null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">最適保有期間分析</h3>

      <div className="relative">
        <canvas ref={canvasRef} />
      </div>

      {/* 詳細テーブル */}
      {stats.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1 px-2 text-left text-gray-500">保有日数</th>
                <th className="py-1 px-2 text-center text-gray-500">平均リターン</th>
                <th className="py-1 px-2 text-center text-gray-500">σ</th>
                <th className="py-1 px-2 text-center text-gray-500">シャープ比</th>
                <th className="py-1 px-2 text-center text-gray-500">勝率</th>
                <th className="py-1 px-2 text-center text-gray-500">中央値</th>
                <th className="py-1 px-2 text-center text-gray-500">最大</th>
                <th className="py-1 px-2 text-center text-gray-500">最小</th>
                <th className="py-1 px-2 text-center text-gray-500">サンプル数</th>
              </tr>
            </thead>
            <tbody>
              {stats.map(s => (
                <tr
                  key={s.days}
                  className={`border-b border-gray-100 ${s === optimal ? "bg-amber-50 font-medium" : ""}`}
                >
                  <td className="py-1 px-2 font-medium text-gray-700">{s.days}日</td>
                  <td className={`py-1 px-2 text-center font-mono ${s.meanReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {pctFmt(s.meanReturn)}
                  </td>
                  <td className="py-1 px-2 text-center font-mono text-gray-600">{pctFmt(s.stdReturn)}</td>
                  <td className={`py-1 px-2 text-center font-mono font-medium ${s.sharpe >= 0 ? "text-blue-600" : "text-red-600"}`}>
                    {s.sharpe.toFixed(3)}
                  </td>
                  <td className={`py-1 px-2 text-center font-mono ${s.winRate >= 0.5 ? "text-green-600" : "text-red-600"}`}>
                    {(s.winRate * 100).toFixed(1)}%
                  </td>
                  <td className={`py-1 px-2 text-center font-mono ${s.medianReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {pctFmt(s.medianReturn)}
                  </td>
                  <td className="py-1 px-2 text-center font-mono text-green-600">{pctFmt(s.maxReturn)}</td>
                  <td className="py-1 px-2 text-center font-mono text-red-600">{pctFmt(s.minReturn)}</td>
                  <td className="py-1 px-2 text-center font-mono text-gray-500">{s.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 判定 */}
      {optimal && (
        <div className="p-3 bg-blue-50 rounded text-xs text-gray-700">
          <div className="font-medium text-blue-800 mb-1">最適保有期間の分析</div>
          <p>
            過去データに基づく最適保有期間は <strong>{optimal.days}日</strong> (年率シャープレシオ {optimal.sharpe.toFixed(3)})。
            {optimal.days <= 5 ? "短期的なモメンタムまたはリバージョンが存在する可能性。" :
             optimal.days <= 20 ? "中期的なトレンドサイクルが存在する可能性。" :
             "長期的なトレンドの恩恵を受けやすい銘柄。"}
            勝率は{(optimal.winRate * 100).toFixed(1)}%、
            中央値リターンは{pctFmt(optimal.medianReturn)}。
          </p>
          <p className="mt-1 text-gray-500">
            注意: 過去の最適保有期間は将来の最適を保証しません。市場レジーム変化により最適期間は変動します。
          </p>
        </div>
      )}

      <AnalysisGuide title="最適保有期間分析の詳細理論">
        <p className="font-medium text-gray-700">1. 基本的な枠組み</p>
        <p>保有期間 N 日のリターンは、各起点 t からの N 日間の対数リターンとして計算されます:</p>
        <p>{"r_N(t) = ln(P(t+N) / P(t))"}</p>
        <p>これを全ての起点 t について計算し、各保有期間 N での統計量を求めます。</p>

        <p className="font-medium text-gray-700 mt-3">2. 年率シャープレシオの計算</p>
        <p>保有期間 N 日のシャープレシオは次のように年率換算されます:</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"年率化係数 f = 252 / N （年間取引日数 / 保有期間）"}</li>
          <li>{"年率期待リターン = mean(r_N) × f"}</li>
          <li>{"年率ボラティリティ = std(r_N) × √f"}</li>
          <li>{"シャープレシオ = 年率期待リターン / 年率ボラティリティ"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 勝率 (Win Rate)</p>
        <p>{"勝率 = (r_N > 0 となる回数) / (全サンプル数)。"}</p>
        <p>勝率50%超は正のバイアスがあることを示しますが、勝率が高くてもテールリスク（大きな負のリターン）が支配的な場合、シャープレシオは低くなります。</p>

        <p className="font-medium text-gray-700 mt-3">4. 最適保有期間の解釈</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>短期（1-5日）が最適 → 短期的な自己相関構造（モメンタムorリバージョン）が強い</li>
          <li>中期（10-20日）が最適 → スイングトレーダーのサイクルに合致</li>
          <li>長期（30-60日）が最適 → 長期トレンドが支配的。バイ&ホールド向き</li>
          <li>全期間でシャープ負 → 当該期間は買いではなく売り（ショート）が有利だった</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 限界と注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>オーバーラップするサンプルを使用しているため、推定値は独立ではなく信頼区間は過小評価される</li>
          <li>取引コスト（手数料、スプレッド、スリッページ）は考慮していない。短期ほどコストの影響が大きい</li>
          <li>過去の最適期間は市場レジーム（低ボラ/高ボラ）に大きく依存する</li>
        </ul>
      </AnalysisGuide>

      <AxiomPlacement corollaryId="C8" />
    </div>
  );
}
