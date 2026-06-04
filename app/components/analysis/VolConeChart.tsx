"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeVolCone } from "../../lib/cornish-fisher";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function VolConeChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const returns = useMemo(() => {
    const r: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i].close > 0 && prices[i - 1].close > 0) {
        r.push(Math.log(prices[i].close / prices[i - 1].close));
      }
    }
    return r;
  }, [prices]);

  const cone = useMemo(() => computeVolCone(returns), [returns]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || cone.windows.length === 0) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 280;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, width, height);

    const pad = { top: 25, right: 20, bottom: 35, left: 55 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const n = cone.windows.length;
    if (n === 0) return;

    // Find y range
    let maxVol = 0;
    for (const p of cone.percentiles) {
      if (p.p90 > maxVol) maxVol = p.p90;
    }
    for (const v of cone.currentVol) {
      if (v > maxVol) maxVol = v;
    }
    maxVol *= 1.1;

    const toX = (i: number) => pad.left + (i / (n - 1)) * plotW;
    const toY = (v: number) => pad.top + (1 - v / maxVol) * plotH;

    // 90-10 percentile band
    ctx.fillStyle = "rgba(147, 197, 253, 0.2)";
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = toX(i);
      ctx.lineTo(x, toY(cone.percentiles[i].p90));
    }
    for (let i = n - 1; i >= 0; i--) {
      ctx.lineTo(toX(i), toY(cone.percentiles[i].p10));
    }
    ctx.closePath();
    ctx.fill();

    // 75-25 percentile band
    ctx.fillStyle = "rgba(147, 197, 253, 0.3)";
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      ctx.lineTo(toX(i), toY(cone.percentiles[i].p75));
    }
    for (let i = n - 1; i >= 0; i--) {
      ctx.lineTo(toX(i), toY(cone.percentiles[i].p25));
    }
    ctx.closePath();
    ctx.fill();

    // Median line
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = toX(i);
      const y = toY(cone.percentiles[i].p50);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Current vol line
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = toX(i);
      const y = toY(cone.currentVol[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Current vol dots
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = "#dc2626";
      ctx.beginPath();
      ctx.arc(toX(i), toY(cone.currentVol[i]), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // X-axis labels
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (let i = 0; i < n; i++) {
      ctx.fillText(`${cone.windows[i]}日`, toX(i), height - pad.bottom + 15);
    }
    ctx.fillText("測定期間", width / 2, height - 3);

    // Y-axis labels
    ctx.textAlign = "right";
    const ySteps = 5;
    for (let i = 0; i <= ySteps; i++) {
      const v = maxVol * i / ySteps;
      ctx.fillText((v * 100).toFixed(0) + "%", pad.left - 4, toY(v) + 4);
    }

    // Legend
    ctx.textAlign = "left";
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#2563eb";
    ctx.fillText("● 中央値", pad.left + 10, 14);
    ctx.fillStyle = "#dc2626";
    ctx.fillText("● 現在値", pad.left + 80, 14);
    ctx.fillStyle = "#93c5fd";
    ctx.fillText("■ 10-90%帯", pad.left + 150, 14);
  }, [cone]);

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        ボラティリティ・コーン
      </h3>

      {cone.currentPercentile.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {cone.windows.map((w, i) => {
            const pctile = cone.currentPercentile[i];
            const color = pctile > 75 ? "bg-red-50 text-red-700" :
              pctile < 25 ? "bg-green-50 text-green-700" : "bg-gray-50 text-gray-700";
            return (
              <div key={w} className={`text-xs rounded px-2 py-1 ${color}`}>
                {w}日: {(cone.currentVol[i] * 100).toFixed(1)}% ({pctile.toFixed(0)}%ile)
              </div>
            );
          })}
        </div>
      )}

      <div className="text-xs text-gray-600 mb-3">{cone.interpretation}</div>

      <canvas ref={canvasRef} />

      <AnalysisGuide title="ボラティリティ・コーンの詳細理論">
        <p className="font-medium text-gray-700">1. ボラティリティ・コーンとは</p>
        <p>
          異なる測定期間（5日、20日、60日等）のボラティリティの歴史的な分布を「コーン（円錐）」形状で表示します。
          現在のvolがそのコーンのどの位置にあるかで、ボラティリティが歴史的に高いか低いかを判断します。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算方法</p>
        <p>
          {"各測定窓幅Wについて、全ローリングvolを計算: σ_W = √(252/W · Σr²)"}
          <br />
          これらのvolの10%, 25%, 50%, 75%, 90%パーセンタイルを算出してコーン形状を描画します。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>赤点（現在値）がコーン上部 → ボラティリティが歴史的に高い</li>
          <li>赤点がコーン下部 → ボラティリティが歴史的に低い</li>
          <li>赤点が中央値（青線）付近 → 平均的なボラティリティ水準</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>コーン上限近く → ボラ売り戦略（オプションのショートストラドル等）</li>
          <li>コーン下限近く → ボラ買い戦略（ロングストラドル、保護プット等）</li>
          <li>短期volが長期volより高い → ボラのコンタンゴ（一時的高ボラ）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ボラティリティは平均回帰する傾向があるが、レジーム変化には注意</li>
          <li>「高い」ボラティリティがさらに高くなるリスク（テールリスク）を忘れない</li>
          <li>最低1年分のデータが必要（コーンの信頼性のため）</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
