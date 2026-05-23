"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { logReturns } from "../../lib/transforms";
import { extremeValueAnalysis, higherOrderCumulants, tailDependence } from "../../lib/tail-risk";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function TailRiskChart({ prices }: Props) {
  const qqCanvasRef = useRef<HTMLCanvasElement>(null);
  const returnLevelCanvasRef = useRef<HTMLCanvasElement>(null);

  const closes = prices.map((p) => p.close);
  const volumes = prices.map((p) => p.volume);
  const lr = logReturns(closes);
  const volRet = logReturns(volumes.map((v) => v || 1));

  const evt = useMemo(() => extremeValueAnalysis(lr, 0.9), [prices]);
  const cumulants = useMemo(() => higherOrderCumulants(lr), [prices]);
  const tailDep = useMemo(() => tailDependence(lr, volRet.slice(0, lr.length), 0.1), [prices]);

  // GPD Q-Q plot
  useEffect(() => {
    const canvas = qqCanvasRef.current;
    if (!canvas || evt.qqPlot.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const size = 250;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { left: 45, right: 10, top: 20, bottom: 30 };
    const plotW = size - margin.left - margin.right;
    const plotH = size - margin.top - margin.bottom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);

    const maxVal = Math.max(
      ...evt.qqPlot.map((p) => p.theoretical),
      ...evt.qqPlot.map((p) => p.empirical)
    ) || 1;

    // 45-degree line
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top + plotH);
    ctx.lineTo(margin.left + plotW, margin.top);
    ctx.stroke();

    // Points
    ctx.fillStyle = "#ef4444";
    for (const p of evt.qqPlot) {
      const x = margin.left + (p.theoretical / maxVal) * plotW;
      const y = margin.top + plotH - (p.empirical / maxVal) * plotH;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
      ctx.fill();
    }

    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("GPD Q-Q Plot (テイル)", size / 2, 12);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("理論分位点", size / 2, size - 5);
    ctx.save();
    ctx.translate(10, margin.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("経験分位点", 0, 0);
    ctx.restore();
  }, [evt]);

  // Return level plot
  useEffect(() => {
    const canvas = returnLevelCanvasRef.current;
    if (!canvas || evt.returnLevels.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = 300;
    const height = 200;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { left: 55, right: 10, top: 20, bottom: 30 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const levels = evt.returnLevels;
    const maxPeriod = Math.max(...levels.map((l) => l.period));
    const maxLevel = Math.max(...levels.map((l) => Math.abs(l.level)));

    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 2;
    ctx.beginPath();
    levels.forEach((l, i) => {
      const x = margin.left + (Math.log(l.period) / Math.log(maxPeriod)) * plotW;
      const y = margin.top + plotH - (Math.abs(l.level) / maxLevel) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Points with labels
    ctx.fillStyle = "#ef4444";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    levels.forEach((l) => {
      const x = margin.left + (Math.log(l.period) / Math.log(maxPeriod)) * plotW;
      const y = margin.top + plotH - (Math.abs(l.level) / maxLevel) * plotH;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillText(`${l.period}d`, x, y - 8);
      ctx.fillText(`${(Math.abs(l.level) * 100).toFixed(1)}%`, x, y + 14);
    });

    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.fillText("再現期間リターン", width / 2, 12);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("再現期間 (日)", width / 2, height - 5);
  }, [evt]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">テイルリスク解析</h3>
      <p className="text-xs text-gray-500 mb-3">極値統計(EVT) / 高次キュムラント / テイル依存性</p>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">GPD形状 ξ</div>
          <div className="font-bold">{evt.shape.toFixed(3)}</div>
          <div className="text-gray-400">{evt.interpretation}</div>
        </div>
        <div className="p-2 bg-red-50 rounded">
          <div className="text-red-600">VaR 95%</div>
          <div className="font-bold text-red-700">{(evt.var95 * 100).toFixed(2)}%</div>
        </div>
        <div className="p-2 bg-red-50 rounded">
          <div className="text-red-600">ES 95% (CVaR)</div>
          <div className="font-bold text-red-700">
            {isFinite(evt.expectedShortfall95) ? `${(evt.expectedShortfall95 * 100).toFixed(2)}%` : "∞"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">超過尖度</div>
          <div className="font-bold">{cumulants.kurtosis.toFixed(2)}</div>
          <div className="text-gray-400">{cumulants.isGaussian ? "正規分布的" : "非正規"}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">テイル依存 (↓/↑)</div>
          <div className="font-bold">{tailDep.lowerTail.toFixed(3)} / {tailDep.upperTail.toFixed(3)}</div>
        </div>
      </div>

      {/* High-order cumulants */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3 text-xs">
        <div className="p-1 bg-gray-50 rounded text-center">
          <div className="text-gray-400">κ₁ (平均)</div>
          <div className="font-bold">{(cumulants.mean * 100).toFixed(4)}%</div>
        </div>
        <div className="p-1 bg-gray-50 rounded text-center">
          <div className="text-gray-400">κ₂ (分散)</div>
          <div className="font-bold">{(cumulants.variance * 10000).toFixed(4)}</div>
        </div>
        <div className="p-1 bg-gray-50 rounded text-center">
          <div className="text-gray-400">κ₃ (歪度)</div>
          <div className="font-bold">{cumulants.skewness.toFixed(3)}</div>
        </div>
        <div className="p-1 bg-gray-50 rounded text-center">
          <div className="text-gray-400">κ₄ (尖度)</div>
          <div className="font-bold">{cumulants.kurtosis.toFixed(3)}</div>
        </div>
        <div className="p-1 bg-gray-50 rounded text-center">
          <div className="text-gray-400">κ₅</div>
          <div className="font-bold">{cumulants.c5.toFixed(3)}</div>
        </div>
        <div className="p-1 bg-gray-50 rounded text-center">
          <div className="text-gray-400">κ₆</div>
          <div className="font-bold">{cumulants.c6.toFixed(3)}</div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div>
          <canvas ref={qqCanvasRef} className="rounded border border-gray-100" />
        </div>
        <div>
          <canvas ref={returnLevelCanvasRef} className="rounded border border-gray-100" />
        </div>
        <div className="flex-1 text-xs text-gray-600 space-y-2">
          <div className="p-2 bg-red-50 rounded">
            <div className="font-medium text-red-800">VaR (Value at Risk)</div>
            <div>指定信頼水準を超える最大損失の推定。GPDモデルにより正規分布仮定より精密な裾の推定が可能。</div>
          </div>
          <div className="p-2 bg-orange-50 rounded">
            <div className="font-medium text-orange-800">テイル依存性 (価格×出来高)</div>
            <div>下側λ_L={tailDep.lowerTail.toFixed(3)}: 急落時の価格-出来高連動性。Kendall τ={tailDep.kendallTau.toFixed(3)}</div>
          </div>
        </div>
      </div>

      <AnalysisGuide title="テイルリスクの読み方">
        <p><span className="font-medium">EVT (極値統計):</span> リターンの裾(極端値)をGPD (Generalized Pareto Distribution)でモデル化。形状パラメータξ{`>`}0で厚い裾(パレート型)、ξ=0で指数型、ξ{`<`}0で有界な裾。正規分布仮定よりもリスクを適切に評価できます。</p>
        <p><span className="font-medium">高次キュムラント:</span> κ₃(歪度)・κ₄(尖度)は既存の分布チャートにもありますが、κ₅・κ₆まで計算することでガウスからの逸脱をより精密に定量します。全てが0に近ければ正規分布に近い。</p>
        <p><span className="font-medium">再現期間リターン:</span> 「N日に1回起きうる最大損失」の推定。250日=約1年に1回の損失水準、500日=約2年に1回の損失水準。</p>
      </AnalysisGuide>
    </div>
  );
}
