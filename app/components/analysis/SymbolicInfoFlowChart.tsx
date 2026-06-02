"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  symbolicTransferEntropy,
  partialInfoDecomposition,
} from "../../lib/information-flow";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

export default function SymbolicInfoFlowChart({ prices, seriesMode }: Props) {
  const flowRef = useRef<HTMLCanvasElement>(null);
  const pidRef = useRef<HTMLCanvasElement>(null);

  const { values, times } = extractSeries(prices, seriesMode);
  const volumes = useMemo(() => {
    const vols = prices.map((p) => p.volume);
    return vols.slice(vols.length - values.length);
  }, [prices, seriesMode]);
  const absReturns = useMemo(() => values.map((v) => Math.abs(v)), [prices, seriesMode]);

  // Symbolic TE between all pairs
  const teVolPrice = useMemo(() => symbolicTransferEntropy(volumes, values), [prices, seriesMode]);
  const tePriceVol = useMemo(() => symbolicTransferEntropy(values, volumes), [prices, seriesMode]);
  const teVolVola = useMemo(() => symbolicTransferEntropy(volumes, absReturns), [prices, seriesMode]);
  const teVolaPrice = useMemo(() => symbolicTransferEntropy(absReturns, values), [prices, seriesMode]);
  const tePriceVola = useMemo(() => symbolicTransferEntropy(values, absReturns), [prices, seriesMode]);
  const teVolaVol = useMemo(() => symbolicTransferEntropy(absReturns, volumes), [prices, seriesMode]);

  // PID: target=price, src1=volume, src2=volatility
  const pid = useMemo(
    () => partialInfoDecomposition(values, volumes, absReturns),
    [prices, seriesMode]
  );

  // フロー図
  useEffect(() => {
    const canvas = flowRef.current;
    if (!canvas) return;
    const result = initCanvas(canvas, 200);
    if (!result) return;
    const { ctx, width, height } = result;

    const boxes = [
      { label: "Volume", x: width * 0.15, y: 40, color: "#3b82f6" },
      { label: "Price", x: width * 0.5, y: 40, color: "#ef4444" },
      { label: "Volatility", x: width * 0.85, y: 40, color: "#f59e0b" },
    ];

    const flows = [
      { from: 0, to: 1, value: teVolPrice, y: 90 },
      { from: 1, to: 0, value: tePriceVol, y: 110 },
      { from: 0, to: 2, value: teVolVola, y: 140 },
      { from: 2, to: 0, value: teVolaVol, y: 160 },
      { from: 2, to: 1, value: teVolaPrice, y: 140 },
      { from: 1, to: 2, value: tePriceVola, y: 160 },
    ];

    const maxTE = Math.max(...flows.map((f) => f.value), 0.001);

    // ボックス
    for (const box of boxes) {
      const bw = 70, bh = 28;
      ctx.fillStyle = box.color;
      ctx.globalAlpha = 0.15;
      ctx.fillRect(box.x - bw / 2, box.y - bh / 2, bw, bh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = box.color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(box.x - bw / 2, box.y - bh / 2, bw, bh);
      ctx.fillStyle = "#333";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(box.label, box.x, box.y + 4);
    }

    // 矢印
    for (const flow of flows) {
      const from = boxes[flow.from];
      const to = boxes[flow.to];
      const lineWidth = Math.max(1, (flow.value / maxTE) * 5);
      const alpha = Math.max(0.3, flow.value / maxTE);

      ctx.strokeStyle = `rgba(100,100,100,${alpha})`;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();

      const startX = from.x;
      const endX = to.x;
      const midY = flow.y;

      ctx.moveTo(startX, from.y + 14);
      ctx.quadraticCurveTo(startX, midY, (startX + endX) / 2, midY);
      ctx.quadraticCurveTo(endX, midY, endX, to.y + 14);
      ctx.stroke();

      // 矢印の先端
      const arrowSize = 4;
      ctx.fillStyle = `rgba(100,100,100,${alpha})`;
      ctx.beginPath();
      ctx.moveTo(endX, to.y + 14);
      ctx.lineTo(endX - arrowSize, to.y + 14 + arrowSize * 2);
      ctx.lineTo(endX + arrowSize, to.y + 14 + arrowSize * 2);
      ctx.closePath();
      ctx.fill();

      // 値ラベル
      ctx.fillStyle = "#666";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(flow.value.toFixed(4), (startX + endX) / 2, midY - 4);
    }

    ctx.fillStyle = "#333";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Symbolic Transfer Entropy フロー図", 10, 16);
  }, [teVolPrice, tePriceVol, teVolVola, teVolaPrice, tePriceVola, teVolaVol]);

  // PID棒グラフ
  useEffect(() => {
    const canvas = pidRef.current;
    if (!canvas) return;
    const result = initCanvas(canvas, 200);
    if (!result) return;
    const { ctx, width, height } = result;

    const margin = { top: 25, right: 15, bottom: 30, left: 50 };
    const pw = width - margin.left - margin.right;
    const ph = height - margin.top - margin.bottom;

    const bars = [
      { label: "Redundancy", value: pid.redundancy, color: "#6366f1" },
      { label: "Unique(Vol)", value: pid.unique1, color: "#3b82f6" },
      { label: "Unique(Vola)", value: pid.unique2, color: "#f59e0b" },
      { label: "Synergy", value: pid.synergy, color: "#22c55e" },
    ];

    const maxVal = Math.max(...bars.map((b) => b.value), 0.001);
    const barWidth = pw / (bars.length * 2);

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const x = margin.left + (i * 2 + 0.5) * barWidth;
      const barH = (bar.value / maxVal) * ph;

      ctx.fillStyle = bar.color;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(x, margin.top + ph - barH, barWidth, barH);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = bar.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, margin.top + ph - barH, barWidth, barH);

      // 値
      ctx.fillStyle = "#333";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(bar.value.toFixed(4), x + barWidth / 2, margin.top + ph - barH - 4);

      // ラベル
      ctx.fillStyle = "#666";
      ctx.font = "9px sans-serif";
      ctx.save();
      ctx.translate(x + barWidth / 2, height - 4);
      ctx.fillText(bar.label, 0, 0);
      ctx.restore();
    }

    ctx.fillStyle = "#333";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Partial Information Decomposition", margin.left, margin.top - 8);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#666";
    ctx.fillText("Target: Price / Sources: Volume + Volatility", margin.left, margin.top + 2);
  }, [pid]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">シンボル情報フロー / 情報分解</h3>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs mb-3">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Vol→Price</div>
          <div className="font-mono font-medium">{teVolPrice.toFixed(4)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Price→Vol</div>
          <div className="font-mono font-medium">{tePriceVol.toFixed(4)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Vola→Price</div>
          <div className="font-mono font-medium">{teVolaPrice.toFixed(4)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Net(Vol→Price)</div>
          <div className={`font-mono font-medium ${teVolPrice > tePriceVol ? "text-green-600" : "text-red-600"}`}>
            {(teVolPrice - tePriceVol).toFixed(4)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded border border-gray-100 overflow-hidden">
          <canvas ref={flowRef} />
        </div>
        <div className="rounded border border-gray-100 overflow-hidden">
          <canvas ref={pidRef} />
        </div>
      </div>

      <AnalysisGuide title="シンボル情報フローとPIDの理論">
        <p className="font-medium text-gray-700">1. Symbolic Transfer Entropy</p>
        <p>時系列をシンボル列に変換してからTEを計算する高速版です。中央値で3レベルにシンボル化し、パターン遷移の条件付き確率からTEを算出します。通常のTEよりノイズに強く、ノンパラメトリックです。</p>

        <p className="font-medium text-gray-700 mt-3">2. Partial Information Decomposition (PID)</p>
        <p>2つの情報源(Volume, Volatility)がTarget(Price)について提供する情報を4成分に分解します:</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Redundancy: 両方が重複して持つ情報</li>
          <li>Unique(Vol): 出来高だけが持つ固有情報</li>
          <li>Unique(Vola): ボラティリティだけが持つ固有情報</li>
          <li>Synergy: 両方を組み合わせて初めて得られる情報</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Synergyが高い: 出来高とボラティリティの複合指標が有効</li>
          <li>Unique(Vol)が高い: 出来高分析に注力すべき</li>
          <li>フロー図で太い矢印: その方向の因果的影響が強い</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
