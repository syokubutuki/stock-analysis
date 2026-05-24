"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeGapSeries, type GapPoint } from "../../lib/gap-analysis";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

interface QuadrantStats {
  label: string;
  count: number;
  ratio: number;
  color: string;
}

function computeQuadrants(gaps: GapPoint[]): QuadrantStats[] {
  const n = gaps.length;
  if (n === 0) return [];
  const gapUpContinue = gaps.filter((g) => g.overnightReturn > 0 && g.intradayReturn > 0).length;
  const gapUpReverse = gaps.filter((g) => g.overnightReturn > 0 && g.intradayReturn <= 0).length;
  const gapDownContinue = gaps.filter((g) => g.overnightReturn <= 0 && g.intradayReturn <= 0).length;
  const gapDownReverse = gaps.filter((g) => g.overnightReturn <= 0 && g.intradayReturn > 0).length;
  return [
    { label: "GU→続伸", count: gapUpContinue, ratio: gapUpContinue / n, color: "text-green-600" },
    { label: "GU→反転", count: gapUpReverse, ratio: gapUpReverse / n, color: "text-orange-600" },
    { label: "GD→続落", count: gapDownContinue, ratio: gapDownContinue / n, color: "text-red-600" },
    { label: "GD→反転", count: gapDownReverse, ratio: gapDownReverse / n, color: "text-blue-600" },
  ];
}

function linearRegression(x: number[], y: number[]): { slope: number; intercept: number; r2: number } {
  const n = x.length;
  if (n < 2) return { slope: 0, intercept: 0, r2: 0 };
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((a, xi, i) => a + xi * y[i], 0);
  const sumX2 = x.reduce((a, xi) => a + xi * xi, 0);
  const sumY2 = y.reduce((a, yi) => a + yi * yi, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-15) return { slope: 0, intercept: sumY / n, r2: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const ssRes = y.reduce((a, yi, i) => a + (yi - (slope * x[i] + intercept)) ** 2, 0);
  const meanY = sumY / n;
  const ssTot = y.reduce((a, yi) => a + (yi - meanY) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, r2 };
}

export default function GapScatterChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const gaps = useMemo(() => computeGapSeries(prices), [prices]);
  const quadrants = useMemo(() => computeQuadrants(gaps), [gaps]);
  const regression = useMemo(() => {
    const x = gaps.map((g) => g.overnightReturn * 100);
    const y = gaps.map((g) => g.intradayReturn * 100);
    return linearRegression(x, y);
  }, [gaps]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || gaps.length < 2) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const overnights = gaps.map((g) => g.overnightReturn * 100);
    const intradays = gaps.map((g) => g.intradayReturn * 100);
    const maxAbs = Math.max(
      ...overnights.map(Math.abs),
      ...intradays.map(Math.abs),
      0.1
    ) * 1.1;

    const margin = 45;
    const plotW = w - margin * 2;
    const plotH = h - margin * 2;
    const cx = margin + plotW / 2;
    const cy = margin + plotH / 2;
    const scaleX = (v: number) => cx + (v / maxAbs) * (plotW / 2);
    const scaleY = (v: number) => cy - (v / maxAbs) * (plotH / 2);

    // 象限の背景
    ctx.fillStyle = "rgba(34, 197, 94, 0.04)";
    ctx.fillRect(cx, margin, plotW / 2, plotH / 2); // 右上: GU→続伸
    ctx.fillStyle = "rgba(239, 68, 68, 0.04)";
    ctx.fillRect(margin, cy, plotW / 2, plotH / 2); // 左下: GD→続落

    // 軸
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin, cy);
    ctx.lineTo(margin + plotW, cy);
    ctx.moveTo(cx, margin);
    ctx.lineTo(cx, margin + plotH);
    ctx.stroke();

    // 回帰直線
    ctx.strokeStyle = "#6366f1";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 3]);
    const regX1 = -maxAbs;
    const regX2 = maxAbs;
    const regY1 = regression.slope * regX1 + regression.intercept;
    const regY2 = regression.slope * regX2 + regression.intercept;
    ctx.beginPath();
    ctx.moveTo(scaleX(regX1), scaleY(regY1));
    ctx.lineTo(scaleX(regX2), scaleY(regY2));
    ctx.stroke();
    ctx.setLineDash([]);

    // 点
    for (let i = 0; i < gaps.length; i++) {
      const x = scaleX(overnights[i]);
      const y = scaleY(intradays[i]);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      if (overnights[i] >= 0) {
        ctx.fillStyle = intradays[i] >= 0
          ? "rgba(34, 197, 94, 0.5)"
          : "rgba(249, 115, 22, 0.5)";
      } else {
        ctx.fillStyle = intradays[i] < 0
          ? "rgba(239, 68, 68, 0.5)"
          : "rgba(59, 130, 246, 0.5)";
      }
      ctx.fill();
    }

    // ラベル
    ctx.fillStyle = "#6b7280";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("夜間リターン (%)", cx, h - 5);
    ctx.save();
    ctx.translate(12, cy);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("日中リターン (%)", 0, 0);
    ctx.restore();

    // 軸の数値
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`-${maxAbs.toFixed(1)}`, margin, cy + 14);
    ctx.fillText(`+${maxAbs.toFixed(1)}`, margin + plotW, cy + 14);
    ctx.textAlign = "right";
    ctx.fillText(`+${maxAbs.toFixed(1)}`, cx - 4, margin + 4);
    ctx.fillText(`-${maxAbs.toFixed(1)}`, cx - 4, margin + plotH + 3);

    // 回帰情報
    ctx.fillStyle = "#6366f1";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(
      `y = ${regression.slope.toFixed(3)}x ${regression.intercept >= 0 ? "+" : ""}${regression.intercept.toFixed(3)}, R² = ${regression.r2.toFixed(3)}`,
      margin + 4,
      margin + 14
    );
  }, [gaps, regression]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">
        ギャップ vs 日中モメンタム
      </h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-4">
        {quadrants.map((q) => (
          <div key={q.label} className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">{q.label}</div>
            <div className={`font-mono font-medium ${q.color}`}>
              {q.count}日 ({(q.ratio * 100).toFixed(1)}%)
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs mb-4">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">回帰係数 (傾き)</div>
          <div className={`font-mono font-medium ${regression.slope < 0 ? "text-orange-600" : "text-green-600"}`}>
            {regression.slope.toFixed(4)}
          </div>
          <div className="text-gray-400">
            {regression.slope < -0.1
              ? "強い反転傾向"
              : regression.slope < 0
              ? "弱い反転傾向"
              : regression.slope > 0.1
              ? "強い継続傾向"
              : "弱い継続傾向"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">決定係数 (R²)</div>
          <div className="font-mono font-medium">{regression.r2.toFixed(4)}</div>
          <div className="text-gray-400">
            {regression.r2 > 0.1 ? "有意な関係あり" : "弱い関係"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">反転率</div>
          <div className="font-mono font-medium">
            {quadrants.length >= 4
              ? ((quadrants[1].ratio + quadrants[3].ratio) * 100).toFixed(1)
              : 0}%
          </div>
          <div className="text-gray-400">ギャップ方向と逆に動いた日の割合</div>
        </div>
      </div>

      <canvas
        ref={canvasRef}
        className="w-full rounded border border-gray-100"
        style={{ height: 300 }}
      />

      <AnalysisGuide title="ギャップ散布図の読み方">
        <p>
          <span className="font-medium">散布図:</span>{" "}
          X軸が夜間リターン（ギャップ）、Y軸が日中リターン。
          回帰直線の傾きが負なら「ギャップの反転」（mean reversion）、正なら「ギャップの継続」（momentum）を示唆。
        </p>
        <p>
          <span className="font-medium">象限分析:</span>{" "}
          GU→続伸は右上象限、GU→反転は右下象限、GD→続落は左下象限、GD→反転は左上象限。
          反転が50%を超える場合は逆張り戦略が有効な可能性。
        </p>
        <p>
          <span className="font-medium">非線形パターン:</span>{" "}
          点が扇形に広がっている場合、ギャップが大きいほど日中の振れ幅も大きい（ボラティリティの伝播）。
          特定の象限にクラスターがある場合は、その銘柄特有のパターンがある。
        </p>
      </AnalysisGuide>
    </div>
  );
}
