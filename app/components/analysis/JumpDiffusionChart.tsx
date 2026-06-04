"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { fitJumpDiffusion, simulateJumpDiffusion } from "../../lib/jump-diffusion";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function JumpDiffusionChart({ prices }: Props) {
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

  const result = useMemo(() => {
    const params = fitJumpDiffusion(returns);
    const lastPrice = prices[prices.length - 1]?.close ?? 100;
    return simulateJumpDiffusion(params, lastPrice, 60, 500, 42);
  }, [returns, prices]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

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

    const pad = { top: 20, right: 15, bottom: 25, left: 60 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const days = result.percentiles.p5.length;
    if (days === 0) return;

    // Y range from percentiles
    const allVals = [...result.percentiles.p5, ...result.percentiles.p95];
    let minY = Math.min(...allVals);
    let maxY = Math.max(...allVals);
    const yRange = maxY - minY || 1;
    minY -= yRange * 0.05;
    maxY += yRange * 0.05;

    const toX = (t: number) => pad.left + (t / (days - 1)) * plotW;
    const toY = (v: number) => pad.top + (1 - (v - minY) / (maxY - minY)) * plotH;

    // 5-95% band
    ctx.fillStyle = "rgba(239, 68, 68, 0.1)";
    ctx.beginPath();
    for (let t = 0; t < days; t++) ctx.lineTo(toX(t), toY(result.percentiles.p95[t]));
    for (let t = days - 1; t >= 0; t--) ctx.lineTo(toX(t), toY(result.percentiles.p5[t]));
    ctx.closePath();
    ctx.fill();

    // 25-75% band
    ctx.fillStyle = "rgba(239, 68, 68, 0.2)";
    ctx.beginPath();
    for (let t = 0; t < days; t++) ctx.lineTo(toX(t), toY(result.percentiles.p75[t]));
    for (let t = days - 1; t >= 0; t--) ctx.lineTo(toX(t), toY(result.percentiles.p25[t]));
    ctx.closePath();
    ctx.fill();

    // Sample paths
    const colors = ["#6366f1", "#8b5cf6", "#a78bfa", "#c4b5fd", "#ddd6fe"];
    for (let p = 0; p < Math.min(result.paths.length, 5); p++) {
      ctx.strokeStyle = colors[p % colors.length];
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      for (let t = 0; t < result.paths[p].length && t < days; t++) {
        const x = toX(t);
        const y = toY(result.paths[p][t]);
        t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Median line
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let t = 0; t < days; t++) {
      const x = toX(t);
      const y = toY(result.percentiles.p50[t]);
      t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Labels
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(maxY.toFixed(0), pad.left - 4, pad.top + 8);
    ctx.fillText(minY.toFixed(0), pad.left - 4, height - pad.bottom);
    ctx.textAlign = "center";
    ctx.fillText("0日", pad.left, height - 8);
    ctx.fillText(`${days - 1}日`, width - pad.right, height - 8);
    ctx.fillText("Merton Jump-Diffusion 60日予測", width / 2, 14);
  }, [result]);

  const p = result.params;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        Merton ジャンプ拡散モデル
      </h3>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3">
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">μ (年率)</div>
          <div className="font-mono text-xs">{(p.mu * 100).toFixed(1)}%</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">σ (拡散)</div>
          <div className="font-mono text-xs">{(p.sigma * 100).toFixed(1)}%</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">λ (ジャンプ/年)</div>
          <div className="font-mono text-xs">{p.lambda.toFixed(1)}</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">μ_J</div>
          <div className="font-mono text-xs">{(p.muJ * 100).toFixed(2)}%</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">σ_J</div>
          <div className="font-mono text-xs">{(p.sigmaJ * 100).toFixed(2)}%</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">ジャンプ寄与</div>
          <div className="font-mono text-xs font-semibold">{(result.jumpContribution * 100).toFixed(1)}%</div>
        </div>
      </div>

      <div className="text-xs text-gray-600 mb-3">{result.interpretation}</div>

      <canvas ref={canvasRef} />

      <AnalysisGuide title="Merton Jump-Diffusionの詳細理論">
        <p className="font-medium text-gray-700">1. ジャンプ拡散モデルとは</p>
        <p>
          通常のGBM（幾何ブラウン運動）は連続的な価格変動のみをモデル化しますが、
          Merton(1976)のジャンプ拡散モデルは突発的なジャンプ（急騰・急落）も含めます。
          「普段はゆっくり歩いているが、たまに突然走り出す」ようなイメージです。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          {"dS/S = (μ - λk)dt + σdW + JdN"}
          <br />
          {"J ~ N(μ_J, σ²_J): ジャンプサイズ分布"}
          <br />
          {"N ~ Poisson(λ): ジャンプ発生過程"}
          <br />
          {"k = E[e^J - 1]: ジャンプの期待変化率"}
        </p>

        <p className="font-medium text-gray-700 mt-3">3. パラメータの意味</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>σ: 通常の連続的な変動の大きさ</li>
          <li>λ: 年間のジャンプ発生回数</li>
          <li>μ_J: ジャンプの平均サイズ（負なら下方ジャンプが主）</li>
          <li>σ_J: ジャンプサイズのばらつき</li>
          <li>ジャンプ寄与率: 全分散に対するジャンプの寄与</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ジャンプ寄与が大きい → テールリスクが高い → プット保護が重要</li>
          <li>μ_J {"<"} 0 → 暴落方向のジャンプが主 → 下方リスクに特に注意</li>
          <li>GBMと比較: ジャンプを考慮すると信頼区間が大幅に拡大</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>パラメータ推定はモーメント法（簡易）。MLEほど精度は高くない</li>
          <li>ジャンプはまれな事象のため、推定が不安定になりやすい</li>
          <li>ボラティリティ・クラスタリングは捕捉しない（Hestonモデルと組合せが理想）</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
