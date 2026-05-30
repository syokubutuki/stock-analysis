"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeGarchVar } from "../../lib/simulation";
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

export default function GarchVarChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const result = useMemo(() => computeGarchVar(prices), [prices]);

  useEffect(() => {
    if (!canvasRef.current || result.dates.length === 0) return;
    const H = 350;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 50, mr = 20, mt = 30, mb = 30;
    const plotW = width - ml - mr, plotH = height - mt - mb;
    const n = result.returns.length;

    const allVals = [...result.returns, ...result.var95];
    const minV = Math.min(...allVals);
    const maxV = Math.max(...allVals);
    const rangeV = maxV - minV || 0.01;

    const xFrom = (i: number) => ml + (i / (n - 1)) * plotW;
    const yFrom = (v: number) => mt + plotH - ((v - minV) / rangeV) * plotH;

    // Returns as dots
    for (let i = 0; i < n; i++) {
      const x = xFrom(i), y = yFrom(result.returns[i]);
      const violated = result.returns[i] < result.var95[i];
      ctx.beginPath(); ctx.arc(x, y, violated ? 2.5 : 1, 0, Math.PI * 2);
      ctx.fillStyle = violated ? "#ef4444" : "rgba(148, 163, 184, 0.4)";
      ctx.fill();
    }

    // VaR95 line
    ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xFrom(i), y = yFrom(result.var95[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // VaR99 line
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xFrom(i), y = yFrom(result.var99[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]);

    // Zero line
    const y0 = yFrom(0);
    ctx.strokeStyle = "#374151"; ctx.lineWidth = 0.5; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(ml, y0); ctx.lineTo(width - mr, y0); ctx.stroke();
    ctx.setLineDash([]);

    // Grid
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = mt + (plotH * i) / 5;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      const val = maxV - (rangeV * i) / 5;
      ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText((val * 100).toFixed(1) + "%", ml - 4, y + 3);
    }

    // Legend
    ctx.font = "10px sans-serif"; ctx.textAlign = "left";
    const lx = ml + 10;
    ctx.fillStyle = "rgba(148, 163, 184, 0.4)";
    ctx.beginPath(); ctx.arc(lx + 3, mt + 8, 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#374151"; ctx.fillText("リターン", lx + 10, mt + 12);
    ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(lx + 70, mt + 8); ctx.lineTo(lx + 88, mt + 8); ctx.stroke();
    ctx.fillText("VaR95", lx + 92, mt + 12);
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(lx + 130, mt + 8); ctx.lineTo(lx + 148, mt + 8); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText("VaR99", lx + 152, mt + 12);
    ctx.fillStyle = "#ef4444";
    ctx.beginPath(); ctx.arc(lx + 203, mt + 8, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#374151"; ctx.fillText("違反", lx + 210, mt + 12);

    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif";
    ctx.fillText("GARCH(1,1)ベース VaR予測とバックテスト", ml, mt - 10);
  }, [result]);

  if (result.dates.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">GARCH VaR予測</h3>
      <div className="relative"><canvas ref={canvasRef} /></div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="p-3 bg-amber-50 rounded border border-amber-200">
          <div className="font-medium text-amber-800 mb-1">VaR 95% バックテスト</div>
          <div className="space-y-0.5">
            <div>実際の違反: <span className="font-mono font-bold">{result.violations95}回</span></div>
            <div>期待違反数: <span className="font-mono">{result.expectedViolations95.toFixed(1)}回</span></div>
            <div>Kupiec LR: <span className="font-mono">{result.kupiecTest95.statistic.toFixed(2)}</span> (p={result.kupiecTest95.pValue.toFixed(3)})</div>
            <div className={result.kupiecTest95.pass ? "text-green-600 font-medium" : "text-red-600 font-medium"}>
              {result.kupiecTest95.pass ? "合格 — VaRモデルは適切" : "不合格 — VaRモデルは不適切"}
            </div>
          </div>
        </div>
        <div className="p-3 bg-red-50 rounded border border-red-200">
          <div className="font-medium text-red-800 mb-1">VaR 99% バックテスト</div>
          <div className="space-y-0.5">
            <div>実際の違反: <span className="font-mono font-bold">{result.violations99}回</span></div>
            <div>期待違反数: <span className="font-mono">{result.expectedViolations99.toFixed(1)}回</span></div>
            <div>Kupiec LR: <span className="font-mono">{result.kupiecTest99.statistic.toFixed(2)}</span> (p={result.kupiecTest99.pValue.toFixed(3)})</div>
            <div className={result.kupiecTest99.pass ? "text-green-600 font-medium" : "text-red-600 font-medium"}>
              {result.kupiecTest99.pass ? "合格" : "不合格 — テールリスクを過小評価の可能性"}
            </div>
          </div>
        </div>
      </div>

      <AnalysisGuide title="GARCH VaR予測の詳細理論">
        <p className="font-medium text-gray-700">1. GARCH(1,1)モデル</p>
        <p>{"条件付き分散: σ²_t = ω + α × r²_{t-1} + β × σ²_{t-1}。α: 直前のショックの影響（ARCH項）、β: 過去の分散の持続性（GARCH項）。α+β < 1 で定常。ω = (1 - α - β) × σ²_uncond（分散ターゲティング）。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 条件付きVaR</p>
        <p>{"VaR_p(t) = μ + z_p × σ_t。z_0.05 = -1.645 (95% VaR), z_0.01 = -2.326 (99% VaR)。条件付き正規分布を仮定。"}</p>
        <p className="font-medium text-gray-700 mt-3">3. Kupiecバックテスト</p>
        <p>{"帰無仮説: 実際の違反率 = 期待違反率。LR = -2[n₁ln(p) + n₀ln(1-p) - n₁ln(n₁/n) - n₀ln(n₀/n)]。χ²(1)分布で検定。p値 > 0.05 なら合格（VaRモデルが適切）。"}</p>
        <p className="font-medium text-gray-700 mt-3">4. 結果の解釈</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>違反が期待より多い → VaRがリスクを過小評価。テール分布が正規より重い（ファットテール）。t分布VaRを検討。</li>
          <li>違反が期待より少ない → VaRが保守的。リスク資本を過大に要求している可能性。</li>
          <li>赤い点（VaR違反）がクラスタリングしている場合、条件付き分散の推定が追いついていない。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
