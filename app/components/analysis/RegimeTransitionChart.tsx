"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeRegimeTransition } from "../../lib/regime-extended";
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

const COLORS = ["#10b981", "#f59e0b", "#ef4444"];
const LABELS = ["低ボラ", "中ボラ", "高ボラ"];

export default function RegimeTransitionChart({ prices }: Props) {
  const matrixRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef<HTMLCanvasElement>(null);
  const result = useMemo(() => computeRegimeTransition(prices), [prices]);

  // Transition matrix heatmap
  useEffect(() => {
    if (!matrixRef.current || result.overallMatrix.length === 0) return;
    const H = 220;
    const init = initCanvas(matrixRef.current, H);
    if (!init) return;
    const { ctx, width } = init;
    const cellSize = 50;
    const startX = (width - cellSize * 3 - 100) / 2 + 80;
    const startY = 40;

    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("遷移確率行列 (行=現在, 列=次)", width / 2, 20);

    // Headers
    ctx.font = "10px sans-serif";
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = COLORS[i]; ctx.font = "bold 10px sans-serif";
      ctx.fillText(LABELS[i], startX + cellSize * (i + 0.5), startY - 5);
      ctx.save();
      ctx.translate(startX - 8, startY + cellSize * (i + 0.5));
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(LABELS[i], 0, 0);
      ctx.restore();
    }

    // Cells
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const val = result.overallMatrix[r][c];
        const x = startX + c * cellSize;
        const y = startY + r * cellSize;
        // Color intensity
        const intensity = Math.min(1, val * 1.5);
        const bg = r === c
          ? `rgba(59, 130, 246, ${0.1 + intensity * 0.5})`
          : `rgba(239, 68, 68, ${0.05 + intensity * 0.3})`;
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, cellSize, cellSize);
        ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
        ctx.strokeRect(x, y, cellSize, cellSize);
        ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center";
        ctx.fillText((val * 100).toFixed(1) + "%", x + cellSize / 2, y + cellSize / 2 + 4);
      }
    }

    // Average duration
    ctx.fillStyle = "#374151"; ctx.font = "11px sans-serif"; ctx.textAlign = "left";
    const durX = startX + cellSize * 3 + 20;
    ctx.font = "bold 11px sans-serif";
    ctx.fillText("平均滞在日数", durX, startY + 10);
    ctx.font = "10px sans-serif";
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = COLORS[i];
      ctx.fillText(`${LABELS[i]}: ${result.avgDuration[i]?.toFixed(1) || "?"}日`, durX, startY + 30 + i * 20);
    }
  }, [result]);

  // Rolling transition probabilities (key transitions)
  useEffect(() => {
    if (!timeRef.current || result.rollingMatrix.length === 0) return;
    const H = 220;
    const init = initCanvas(timeRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 50, mr = 20, mt = 25, mb = 30;
    const plotW = width - ml - mr, plotH = height - mt - mb;

    const rm = result.rollingMatrix;
    const n = rm.length;
    const xFrom = (i: number) => ml + (i / (n - 1)) * plotW;

    // Plot key transitions: stay-in-high (2→2), high-to-low (2→0)
    const traces = [
      { r: 0, c: 0, label: "低→低", color: "#10b981" },
      { r: 2, c: 2, label: "高→高", color: "#ef4444" },
      { r: 2, c: 0, label: "高→低", color: "#3b82f6" },
    ];

    // Grid
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = mt + (plotH * i) / 4;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(`${((4 - i) * 25)}%`, ml - 4, y + 3);
    }

    for (const trace of traces) {
      ctx.strokeStyle = trace.color; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const y = mt + plotH - rm[i].matrix[trace.r][trace.c] * plotH;
        if (i === 0) ctx.moveTo(xFrom(i), y); else ctx.lineTo(xFrom(i), y);
      }
      ctx.stroke();
    }

    // Legend
    ctx.font = "10px sans-serif";
    for (let i = 0; i < traces.length; i++) {
      const lx = ml + 10 + i * 90;
      ctx.strokeStyle = traces[i].color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx, mt + 8); ctx.lineTo(lx + 16, mt + 8); ctx.stroke();
      ctx.fillStyle = "#374151"; ctx.textAlign = "left";
      ctx.fillText(traces[i].label, lx + 20, mt + 12);
    }

    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("ローリング遷移確率 (120日窓)", ml, mt - 8);
  }, [result]);

  if (result.overallMatrix.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">レジーム遷移分析</h3>
      <div className="relative"><canvas ref={matrixRef} /></div>
      <div className="relative"><canvas ref={timeRef} /></div>

      <div className="p-3 bg-blue-50 rounded text-xs text-gray-700">
        <div className="font-medium text-blue-800 mb-1">遷移構造の判定</div>
        {result.overallMatrix.length > 0 && (
          <ul className="space-y-1">
            <li>高ボラ持続確率: {(result.overallMatrix[2]?.[2] * 100).toFixed(1)}%
              {result.overallMatrix[2]?.[2] > 0.6 ? " — 高ボラレジームは持続性が強い。暴落局面は長引きやすい。" : " — 高ボラは比較的短命。"}
            </li>
            <li>平均滞在日数: 低ボラ {result.avgDuration[0]?.toFixed(0)}日、中ボラ {result.avgDuration[1]?.toFixed(0)}日、高ボラ {result.avgDuration[2]?.toFixed(0)}日</li>
          </ul>
        )}
      </div>

      <AnalysisGuide title="レジーム遷移分析の詳細理論">
        <p className="font-medium text-gray-700">1. 遷移確率行列</p>
        <p>{"P(i→j) = (状態iから状態jへの遷移回数) / (状態iの出現回数)。各行の合計は100%。対角要素が大きいほど各レジームの持続性が高い。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. ローリング遷移確率</p>
        <p>120日窓で遷移行列を再計算し、遷移確率の時変性を可視化します。例えば「高ボラ→高ボラ」の確率が上昇している場合、暴落局面が長期化するリスクを示唆します。</p>
        <p className="font-medium text-gray-700 mt-3">3. 平均滞在日数</p>
        <p>{"各レジームに連続して滞在する日数の平均。自己遷移確率 p_ii から理論的には 1/(1-p_ii) と推定できますが、ここでは直接データから計算しています。"}</p>
        <p className="font-medium text-gray-700 mt-3">4. 実務への示唆</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>高ボラ持続確率が高い → ヘッジのタイミングが遅れると損失が拡大しやすい</li>
          <li>「高ボラ→低ボラ」遷移確率が上昇中 → ボラティリティのピークアウトの兆候</li>
          <li>レジーム遷移直後は不確実性が高い → ポジションサイズを縮小すべき</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
