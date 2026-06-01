"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  entropyHeatmap,
  permutationPatternDistribution,
  entropyDivergenceMap,
} from "../../lib/entropy-visualization";
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

function heatColor(value: number, min: number, max: number): string {
  const range = max - min || 1;
  const t = Math.max(0, Math.min(1, (value - min) / range));
  // blue → green → yellow → red
  if (t < 0.33) {
    const s = t / 0.33;
    return `rgb(${Math.round(30 + 30 * s)}, ${Math.round(60 + 140 * s)}, ${Math.round(200 - 100 * s)})`;
  } else if (t < 0.66) {
    const s = (t - 0.33) / 0.33;
    return `rgb(${Math.round(60 + 180 * s)}, ${Math.round(200 - 30 * s)}, ${Math.round(100 - 80 * s)})`;
  } else {
    const s = (t - 0.66) / 0.34;
    return `rgb(${Math.round(240)}, ${Math.round(170 - 130 * s)}, ${Math.round(20)})`;
  }
}

export default function EntropyHeatmapChart({ prices, seriesMode }: Props) {
  const heatmapRef = useRef<HTMLCanvasElement>(null);
  const patternRef = useRef<HTMLCanvasElement>(null);
  const divRef = useRef<HTMLCanvasElement>(null);

  const { values, times } = extractSeries(prices, seriesMode);

  const heatmap = useMemo(() => entropyHeatmap(values, times, 20, 60, 5), [prices, seriesMode]);
  const patterns = useMemo(() => permutationPatternDistribution(values, 3, 1), [prices, seriesMode]);
  const divergence = useMemo(() => entropyDivergenceMap(values, times, 30, 120), [prices, seriesMode]);

  // ヒートマップ
  useEffect(() => {
    const canvas = heatmapRef.current;
    if (!canvas || heatmap.values.length === 0) return;
    const result = initCanvas(canvas, 250);
    if (!result) return;
    const { ctx, width, height } = result;

    const margin = { top: 25, right: 60, bottom: 30, left: 50 };
    const pw = width - margin.left - margin.right;
    const ph = height - margin.top - margin.bottom;

    const nTime = heatmap.values.length;
    const nScale = heatmap.scales.length;

    // min/max for color
    let minVal = Infinity, maxVal = -Infinity;
    for (const row of heatmap.values) {
      for (const v of row) {
        if (isFinite(v)) {
          if (v < minVal) minVal = v;
          if (v > maxVal) maxVal = v;
        }
      }
    }
    if (!isFinite(minVal)) minVal = 0;
    if (!isFinite(maxVal)) maxVal = 1;

    const cellW = pw / nTime;
    const cellH = ph / nScale;

    for (let ti = 0; ti < nTime; ti++) {
      for (let si = 0; si < nScale; si++) {
        const v = heatmap.values[ti][si];
        if (!isFinite(v)) continue;
        ctx.fillStyle = heatColor(v, minVal, maxVal);
        ctx.fillRect(margin.left + ti * cellW, margin.top + (nScale - 1 - si) * cellH, cellW + 0.5, cellH + 0.5);
      }
    }

    // 軸
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("時間", width / 2, height - 4);
    ctx.save();
    ctx.translate(12, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("スケール", 0, 0);
    ctx.restore();

    ctx.textAlign = "right";
    for (let s = 0; s < nScale; s += 4) {
      ctx.fillText(`${heatmap.scales[s]}`, margin.left - 4, margin.top + (nScale - 1 - s) * cellH + cellH / 2 + 3);
    }

    // カラーバー
    const barX = width - margin.right + 10;
    const barH = ph;
    for (let i = 0; i < barH; i++) {
      const t = 1 - i / barH;
      const v = minVal + (maxVal - minVal) * t;
      ctx.fillStyle = heatColor(v, minVal, maxVal);
      ctx.fillRect(barX, margin.top + i, 12, 1);
    }
    ctx.fillStyle = "#666";
    ctx.font = "8px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(maxVal.toFixed(2), barX + 14, margin.top + 6);
    ctx.fillText(minVal.toFixed(2), barX + 14, margin.top + barH);
    ctx.fillText("SampEn", barX, margin.top - 5);

    ctx.fillStyle = "#333";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("エントロピーヒートマップ (time × scale)", margin.left, margin.top - 8);
  }, [heatmap]);

  // パターン頻度棒グラフ
  useEffect(() => {
    const canvas = patternRef.current;
    if (!canvas || patterns.length === 0) return;
    const result = initCanvas(canvas, 180);
    if (!result) return;
    const { ctx, width, height } = result;

    const margin = { top: 25, right: 15, bottom: 40, left: 50 };
    const pw = width - margin.left - margin.right;
    const ph = height - margin.top - margin.bottom;

    const n = patterns.length;
    const maxFreq = Math.max(...patterns.map((p) => p.frequency));
    const uniform = 1 / n;
    const barWidth = pw / (n * 1.5);

    const colors = ["#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6", "#ec4899"];

    for (let i = 0; i < n; i++) {
      const p = patterns[i];
      const x = margin.left + (i * 1.5 + 0.25) * barWidth;
      const barH = (p.frequency / maxFreq) * ph;

      ctx.fillStyle = colors[i % colors.length];
      ctx.globalAlpha = 0.7;
      ctx.fillRect(x, margin.top + ph - barH, barWidth, barH);
      ctx.globalAlpha = 1;

      ctx.fillStyle = "#333";
      ctx.font = "8px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${(p.frequency * 100).toFixed(1)}%`, x + barWidth / 2, margin.top + ph - barH - 3);

      ctx.fillStyle = "#666";
      ctx.save();
      ctx.translate(x + barWidth / 2, height - 4);
      ctx.fillText(p.label, 0, 0);
      ctx.restore();
    }

    // 一様分布ライン
    const uniformY = margin.top + ph - (uniform / maxFreq) * ph;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, uniformY);
    ctx.lineTo(width - margin.right, uniformY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`一様: ${(uniform * 100).toFixed(1)}%`, width - margin.right - 5, uniformY - 4);

    ctx.fillStyle = "#333";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("順列パターン頻度 (order=3)", margin.left, margin.top - 8);
  }, [patterns]);

  // 乖離マップ
  useEffect(() => {
    const canvas = divRef.current;
    if (!canvas || divergence.length === 0) return;
    const result = initCanvas(canvas, 200);
    if (!result) return;
    const { ctx, width, height } = result;

    const margin = { top: 25, right: 15, bottom: 25, left: 50 };
    const pw = width - margin.left - margin.right;
    const ph = height - margin.top - margin.bottom;

    const n = divergence.length;
    const allVals = divergence.flatMap((d) => [d.shortEntropy, d.longEntropy]);
    const minE = Math.min(...allVals);
    const maxE = Math.max(...allVals);
    const rangeE = maxE - minE || 1;

    const toX = (i: number) => margin.left + (i / (n - 1)) * pw;
    const toY = (v: number) => margin.top + ph - ((v - minE) / rangeE) * ph;

    // 乖離塗りつぶし
    ctx.beginPath();
    for (let i = 0; i < n; i++) ctx.lineTo(toX(i), toY(divergence[i].shortEntropy));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(toX(i), toY(divergence[i].longEntropy));
    ctx.closePath();
    ctx.fillStyle = "rgba(139, 92, 246, 0.15)";
    ctx.fill();

    // 短期線
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 1;
    ctx.beginPath();
    divergence.forEach((d, i) => {
      if (i === 0) ctx.moveTo(toX(i), toY(d.shortEntropy));
      else ctx.lineTo(toX(i), toY(d.shortEntropy));
    });
    ctx.stroke();

    // 長期線
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1;
    ctx.beginPath();
    divergence.forEach((d, i) => {
      if (i === 0) ctx.moveTo(toX(i), toY(d.longEntropy));
      else ctx.lineTo(toX(i), toY(d.longEntropy));
    });
    ctx.stroke();

    ctx.fillStyle = "#333";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("エントロピー乖離マップ", margin.left + 5, margin.top - 8);

    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#ef4444";
    ctx.fillText("短期(30日)", margin.left + pw - 130, margin.top + 10);
    ctx.fillStyle = "#3b82f6";
    ctx.fillText("長期(120日)", margin.left + pw - 65, margin.top + 10);
  }, [divergence]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">エントロピーヒートマップ / パターン分布</h3>

      <div className="w-full rounded border border-gray-100 overflow-hidden mb-4">
        <canvas ref={heatmapRef} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div className="rounded border border-gray-100 overflow-hidden">
          <canvas ref={patternRef} />
        </div>
        <div className="rounded border border-gray-100 overflow-hidden">
          <canvas ref={divRef} />
        </div>
      </div>

      <AnalysisGuide title="エントロピーヒートマップの理論">
        <p className="font-medium text-gray-700">1. エントロピーヒートマップ</p>
        <p>X軸=時間、Y軸=粗視化スケール(1-20)のSample Entropyを色で表現します。暖色=高エントロピー(ランダム)、寒色=低エントロピー(構造的)。特定のスケール×時間帯で構造が出現するパターンを視覚的に把握できます。</p>

        <p className="font-medium text-gray-700 mt-3">2. 順列パターン頻度</p>
        <p>order=3で6種類の順序パターン(上昇・下降・山型・谷型等)の出現頻度を表示。一様分布(16.7%)からの偏りが予測可能性の源泉です。特定パターンの頻出=トレード戦略の根拠。</p>

        <p className="font-medium text-gray-700 mt-3">3. エントロピー乖離マップ</p>
        <p>短期(30日)と長期(120日)のShannonエントロピーを比較。乖離(紫の塗りつぶし)が大きい=短期と長期で市場特性が異なる=レジーム変化中の可能性。</p>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ヒートマップの寒色帯: そのスケールでの構造的な動き → 対応する保有期間の戦略が有効</li>
          <li>特定パターン(例:上昇)の頻出: モメンタム効果の存在を示唆</li>
          <li>短期エントロピー {"<"} 長期: 市場が一時的に構造化 → 短期トレード機会</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
