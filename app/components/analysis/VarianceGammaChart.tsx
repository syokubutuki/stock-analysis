"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { fitVarianceGamma, simulateVG } from "../../lib/variance-gamma";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function VarianceGammaChart({ prices }: Props) {
  const fanRef = useRef<HTMLCanvasElement>(null);
  const densityRef = useRef<HTMLCanvasElement>(null);

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
    const params = fitVarianceGamma(returns);
    const S0 = prices[prices.length - 1]?.close ?? 100;
    return simulateVG(params, S0, 60, 500, 42);
  }, [returns, prices]);

  // Fan chart
  useEffect(() => {
    const canvas = fanRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const width = parent.clientWidth;
    const height = 250;
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

    const allVals = [...result.percentiles.p5, ...result.percentiles.p95];
    let minY = Math.min(...allVals);
    let maxY = Math.max(...allVals);
    const yRange = maxY - minY || 1;
    minY -= yRange * 0.05;
    maxY += yRange * 0.05;

    const toX = (t: number) => pad.left + (t / (days - 1)) * plotW;
    const toY = (v: number) => pad.top + (1 - (v - minY) / (maxY - minY)) * plotH;

    // 5-95% band
    ctx.fillStyle = "rgba(124, 58, 237, 0.1)";
    ctx.beginPath();
    for (let t = 0; t < days; t++) ctx.lineTo(toX(t), toY(result.percentiles.p95[t]));
    for (let t = days - 1; t >= 0; t--) ctx.lineTo(toX(t), toY(result.percentiles.p5[t]));
    ctx.closePath();
    ctx.fill();

    // 25-75% band
    ctx.fillStyle = "rgba(124, 58, 237, 0.2)";
    ctx.beginPath();
    for (let t = 0; t < days; t++) ctx.lineTo(toX(t), toY(result.percentiles.p75[t]));
    for (let t = days - 1; t >= 0; t--) ctx.lineTo(toX(t), toY(result.percentiles.p25[t]));
    ctx.closePath();
    ctx.fill();

    // Sample paths
    const colors = ["#8b5cf6", "#a78bfa", "#c4b5fd", "#ddd6fe"];
    for (let p = 0; p < Math.min(result.paths.length, 4); p++) {
      ctx.strokeStyle = colors[p % colors.length];
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      for (let t = 0; t < result.paths[p].length && t < days; t++) {
        t === 0 ? ctx.moveTo(toX(t), toY(result.paths[p][t])) : ctx.lineTo(toX(t), toY(result.paths[p][t]));
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Median
    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let t = 0; t < days; t++) {
      t === 0 ? ctx.moveTo(toX(t), toY(result.percentiles.p50[t])) : ctx.lineTo(toX(t), toY(result.percentiles.p50[t]));
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
    ctx.fillText("Variance Gamma 60日予測", width / 2, 14);
  }, [result]);

  // Density comparison
  useEffect(() => {
    const canvas = densityRef.current;
    if (!canvas || result.densityComparison.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const width = parent.clientWidth;
    const height = 180;
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

    const pad = { top: 20, right: 15, bottom: 25, left: 50 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const d = result.densityComparison;
    const maxDensity = Math.max(...d.map((p) => Math.max(p.vg, p.normal)));
    if (maxDensity === 0) return;

    const toX = (i: number) => pad.left + (i / (d.length - 1)) * plotW;
    const toY = (v: number) => pad.top + (1 - v / maxDensity) * plotH;

    // VG density
    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < d.length; i++) {
      i === 0 ? ctx.moveTo(toX(i), toY(d[i].vg)) : ctx.lineTo(toX(i), toY(d[i].vg));
    }
    ctx.stroke();

    // Normal density
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (let i = 0; i < d.length; i++) {
      i === 0 ? ctx.moveTo(toX(i), toY(d[i].normal)) : ctx.lineTo(toX(i), toY(d[i].normal));
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Legend
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#7c3aed";
    ctx.textAlign = "left";
    ctx.fillText("VG分布", pad.left + 5, pad.top + 12);
    ctx.fillStyle = "#9ca3af";
    ctx.fillText("正規分布", pad.left + 55, pad.top + 12);
    ctx.fillStyle = "#666";
    ctx.textAlign = "center";
    ctx.fillText("リターン密度比較", width / 2, 14);
  }, [result]);

  const p = result.params;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        Variance Gamma過程
      </h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">sigma</div>
          <div className="font-mono text-xs">{p.sigma.toFixed(4)}</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">theta</div>
          <div className="font-mono text-xs">{p.theta.toFixed(4)}</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">nu</div>
          <div className="font-mono text-xs">{p.nu.toFixed(3)}</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">mu</div>
          <div className="font-mono text-xs">{p.mu.toFixed(5)}</div>
        </div>
      </div>

      <canvas ref={fanRef} />
      <canvas ref={densityRef} className="mt-3" />

      <p className="text-xs text-gray-600 mt-2">{result.interpretation}</p>

      <AnalysisGuide title="Variance Gamma過程の詳細理論">
        <p className="font-medium text-gray-700">1. Variance Gamma過程とは</p>
        <p>
          ブラウン運動の「時間」をガンマ過程で置き換えたモデルです。
          通常のブラウン運動では時間が均等に流れますが、VG過程では
          「市場の活性度」に応じて時間の流れが変動します。
          活発な時期は時間が速く流れ（大きな価格変動）、
          閑散期は時間が遅く流れる（小さな変動）イメージです。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>{"X(t) = theta*G(t) + sigma*W(G(t))"}</p>
        <p>{"G(t) ~ Gamma(t/nu, nu): 内在時間（ガンマ従属子）"}</p>
        <p>{"W: 標準ブラウン運動"}</p>
        <p>{"sigma: BM volatility, theta: drift(歪度制御), nu: 分散率(尖度制御)"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>sigma: ブラウン運動のボラティリティ。大きいほど基本的な変動が大きい</li>
          <li>theta: 歪度を制御。負なら下落方向に歪む</li>
          <li>nu: 尖度を制御。大きいほど裾が厚い（ファットテール）</li>
          <li>ファンチャート: 紫帯が予測の分布幅</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>nuが大きい場合: テールリスクが高く、通常のGBMよりリスクを保守的に見積もるべき</li>
          <li>thetaが負: 暴落リスクが高い。プット購入でヘッジを検討</li>
          <li>GBMとの予測区間の差: VG特有のファットテールリスクを定量化</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>パラメータ推定はモーメント法。MLE（最尤推定）ほど精度は高くない</li>
          <li>ボラティリティの時変性（クラスタリング）は捕捉しない</li>
          <li>Merton JDモデルと競合するが、VGは連続的なジャンプを仮定</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
