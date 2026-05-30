"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeMonteCarlo } from "../../lib/simulation";
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

export default function MonteCarloChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const result = useMemo(() => computeMonteCarlo(prices), [prices]);

  useEffect(() => {
    if (!canvasRef.current || result.paths.length === 0) return;
    const H = 400;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 60, mr = 20, mt = 30, mb = 30;
    const plotW = width - ml - mr, plotH = height - mt - mb;

    const horizon = result.horizon;
    const p = result.percentiles;
    const allVals = [...p.p5, ...p.p95];
    const minV = Math.min(...allVals);
    const maxV = Math.max(...allVals);
    const rangeV = maxV - minV || 0.01;

    const xFrom = (i: number) => ml + (i / horizon) * plotW;
    const yFrom = (v: number) => mt + plotH - ((v - minV) / rangeV) * plotH;

    // Draw sample paths (faint)
    const nShow = Math.min(result.paths.length, 100);
    for (let pi = 0; pi < nShow; pi++) {
      ctx.strokeStyle = "rgba(148, 163, 184, 0.08)"; ctx.lineWidth = 0.5;
      ctx.beginPath();
      const path = result.paths[pi];
      for (let i = 0; i <= horizon && i < path.length; i++) {
        const x = xFrom(i), y = yFrom(path[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Confidence bands
    const drawBand = (upper: number[], lower: number[], color: string) => {
      ctx.beginPath();
      for (let i = 0; i <= horizon; i++) ctx.lineTo(xFrom(i), yFrom(upper[i]));
      for (let i = horizon; i >= 0; i--) ctx.lineTo(xFrom(i), yFrom(lower[i]));
      ctx.closePath();
      ctx.fillStyle = color; ctx.fill();
    };
    drawBand(p.p95, p.p5, "rgba(59, 130, 246, 0.08)");
    drawBand(p.p75, p.p25, "rgba(59, 130, 246, 0.15)");

    // Percentile lines
    const drawLine = (vals: number[], color: string, width2: number, dash?: number[]) => {
      ctx.strokeStyle = color; ctx.lineWidth = width2;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      for (let i = 0; i <= horizon; i++) {
        const x = xFrom(i), y = yFrom(vals[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (dash) ctx.setLineDash([]);
    };
    drawLine(p.p5, "#ef4444", 1, [4, 4]);
    drawLine(p.p25, "#f59e0b", 1, [4, 4]);
    drawLine(p.p50, "#3b82f6", 2);
    drawLine(p.p75, "#f59e0b", 1, [4, 4]);
    drawLine(p.p95, "#ef4444", 1, [4, 4]);

    // Zero line
    const y0 = yFrom(0);
    ctx.strokeStyle = "#374151"; ctx.lineWidth = 0.8; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(ml, y0); ctx.lineTo(width - mr, y0); ctx.stroke();
    ctx.setLineDash([]);

    // Grid
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = mt + (plotH * i) / 5;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      const val = maxV - (rangeV * i) / 5;
      ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText((val * 100).toFixed(0) + "%", ml - 4, y + 3);
    }

    // X labels
    ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    for (let d = 0; d <= horizon; d += Math.max(1, Math.floor(horizon / 6))) {
      ctx.fillText(`${d}日`, xFrom(d), height - mb + 15);
    }

    // Labels on right side
    ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    const labelX = width - mr + 4;
    ctx.fillStyle = "#ef4444"; ctx.fillText("95%", labelX, yFrom(p.p95[horizon]) + 3);
    ctx.fillStyle = "#f59e0b"; ctx.fillText("75%", labelX, yFrom(p.p75[horizon]) + 3);
    ctx.fillStyle = "#3b82f6"; ctx.fillText("50%", labelX, yFrom(p.p50[horizon]) + 3);
    ctx.fillStyle = "#f59e0b"; ctx.fillText("25%", labelX, yFrom(p.p25[horizon]) + 3);
    ctx.fillStyle = "#ef4444"; ctx.fillText("5%", labelX, yFrom(p.p5[horizon]) + 3);

    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(`モンテカルロ・シミュレーション (${horizon}日, ${result.paths.length}パス)`, ml, mt - 10);
  }, [result]);

  if (result.paths.length === 0) return null;

  const fd = result.finalDistribution;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">モンテカルロ・シミュレーション</h3>
      <div className="relative"><canvas ref={canvasRef} /></div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded border">
          <div className="text-gray-500">期待リターン (中央値)</div>
          <div className={`font-mono font-bold ${fd.p50 >= 0 ? "text-green-600" : "text-red-600"}`}>{(fd.p50 * 100).toFixed(1)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded border">
          <div className="text-gray-500">平均 ± σ</div>
          <div className="font-mono font-bold text-gray-700">{(fd.mean * 100).toFixed(1)}% ± {(fd.std * 100).toFixed(1)}%</div>
        </div>
        <div className="p-2 bg-red-50 rounded border border-red-200">
          <div className="text-gray-500">5%最悪シナリオ</div>
          <div className="font-mono font-bold text-red-600">{(fd.p5 * 100).toFixed(1)}%</div>
        </div>
        <div className="p-2 bg-green-50 rounded border border-green-200">
          <div className="text-gray-500">95%最良シナリオ</div>
          <div className="font-mono font-bold text-green-600">{(fd.p95 * 100).toFixed(1)}%</div>
        </div>
      </div>

      <AnalysisGuide title="モンテカルロ・シミュレーションの詳細理論">
        <p className="font-medium text-gray-700">1. ヒストリカル・ブートストラップ法</p>
        <p>過去の日次対数リターンの経験分布から復元抽出（ブートストラップ）し、将来の価格パスをシミュレーションします。パラメトリックな分布仮定を置かないため、実際のリターン分布の歪度・尖度・テール特性が自動的に反映されます。</p>
        <p className="font-medium text-gray-700 mt-3">2. シミュレーション手順</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"1. 過去の日次対数リターン {r_1, r_2, ..., r_n} を計算"}</li>
          <li>{"2. 各シミュレーションパスで、リターン集合からランダムに復元抽出してH日分のリターンを生成"}</li>
          <li>{"3. 累積和 S_t = Σ_{i=1}^{t} r*_i を計算（累積対数リターン）"}</li>
          <li>{"4. 1000パスを生成し、各時点でのパーセンタイルを計算"}</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. ファンチャートの読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>中央の青線 (50%): 中央値パス。最も可能性の高い結果。</li>
          <li>濃い帯 (25%-75%): 50%信頼区間。半数のパスがこの範囲に収まる。</li>
          <li>薄い帯 (5%-95%): 90%信頼区間。ほぼ全てのパスがこの範囲。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>リターンの時間的独立性を仮定（ボラティリティクラスタリングは無視）。</li>
          <li>過去の分布が将来も続くと仮定（レジーム変化は考慮せず）。</li>
          <li>GARCHブートストラップ等の改良版はこれらの限界を緩和する。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
