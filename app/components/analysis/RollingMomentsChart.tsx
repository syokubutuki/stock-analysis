"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { rollingMoments } from "../../lib/distribution-extended";
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
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

function drawTimeSeries(
  canvas: HTMLCanvasElement,
  data: { time: string; value: number }[],
  title: string,
  color: string,
  thresholds?: { value: number; color: string; label: string }[],
  chartHeight = 180
) {
  const r = initCanvas(canvas, chartHeight); if (!r) return;
  const { ctx, width, height } = r;
  const pad = { top: 20, bottom: 25, left: 50, right: 15 };
  const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;
  const n = data.length;
  if (n < 2) return;

  let minV = Infinity, maxV = -Infinity;
  for (const d of data) { minV = Math.min(minV, d.value); maxV = Math.max(maxV, d.value); }
  if (thresholds) {
    for (const t of thresholds) { minV = Math.min(minV, t.value); maxV = Math.max(maxV, t.value); }
  }
  const range = maxV - minV || 1;
  minV -= range * 0.05; maxV += range * 0.05;
  const fullRange = maxV - minV;

  const toX = (i: number) => pad.left + (i / (n - 1)) * pw;
  const toY = (v: number) => pad.top + ph * (1 - (v - minV) / fullRange);

  // ゼロライン
  if (minV <= 0 && maxV >= 0) {
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.left, toY(0)); ctx.lineTo(width - pad.right, toY(0)); ctx.stroke();
    ctx.setLineDash([]);
  }

  // 閾値線
  if (thresholds) {
    for (const t of thresholds) {
      ctx.strokeStyle = t.color; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(pad.left, toY(t.value)); ctx.lineTo(width - pad.right, toY(t.value)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = t.color; ctx.font = "8px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(t.label, width - pad.right - 60, toY(t.value) - 3);
    }
  }

  // Y軸
  ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = minV + (fullRange * i) / 4;
    ctx.fillText(v.toFixed(2), pad.left - 5, toY(v) + 3);
    ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(pad.left, toY(v)); ctx.lineTo(width - pad.right, toY(v)); ctx.stroke();
  }

  // データライン
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = toX(i), y = toY(data[i].value);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = "#333"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(title, pad.left + 5, pad.top - 5);
}

export default function RollingMomentsChart({ prices, seriesMode }: Props) {
  const skewRef = useRef<HTMLCanvasElement>(null);
  const kurtRef = useRef<HTMLCanvasElement>(null);
  const stdRef = useRef<HTMLCanvasElement>(null);

  const { values: lr, times } = extractSeries(prices, seriesMode);
  const rolling = useMemo(() => rollingMoments(lr, times, 60), [prices, seriesMode]);

  useEffect(() => {
    if (rolling.length < 2) return;

    if (skewRef.current) {
      drawTimeSeries(
        skewRef.current,
        rolling.map(d => ({ time: d.time, value: d.skewness })),
        "ローリング歪度 (60日窓)",
        "#8b5cf6",
        [
          { value: 0.5, color: "#f59e0b", label: "+0.5" },
          { value: -0.5, color: "#f59e0b", label: "-0.5" },
        ]
      );
    }

    if (kurtRef.current) {
      drawTimeSeries(
        kurtRef.current,
        rolling.map(d => ({ time: d.time, value: d.kurtosis })),
        "ローリング超過尖度 (60日窓)",
        "#ef4444",
        [
          { value: 0, color: "#d1d5db", label: "0 (正規)" },
          { value: 3, color: "#dc2626", label: "3.0" },
        ]
      );
    }

    if (stdRef.current) {
      drawTimeSeries(
        stdRef.current,
        rolling.map(d => ({ time: d.time, value: d.std * 100 })),
        "ローリング標準偏差 (60日窓, %)",
        "#3b82f6"
      );
    }
  }, [rolling]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">ローリング高次モーメント</h3>

      <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={skewRef} /></div>
      <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={kurtRef} /></div>
      <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={stdRef} /></div>

      <AnalysisGuide title="ローリング高次モーメントの詳細理論">
        <p className="font-medium text-gray-700">ローリング窓の意味</p>
        <p>過去60営業日（約3ヶ月）のデータから歪度・尖度・標準偏差を逐次計算することで、分布形状の時変性を可視化します。リターン分布は時間とともに変化するため、全期間の単一の統計量では捉えられないダイナミクスが明らかになります。</p>

        <p className="font-medium text-gray-700 mt-3">歪度 (Skewness)</p>
        <p>歪度 γ₁ = E[(X-μ)³]/σ³ は分布の非対称性を測定します。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>γ₁ = 0: 対称分布（正規分布）</li>
          <li>γ₁ &lt; 0 (負の歪度): 左テールが重い。大きな下落が大きな上昇より起きやすい。多くの株式で観察される</li>
          <li>γ₁ &gt; 0 (正の歪度): 右テールが重い。「宝くじ型」のリターン特性</li>
          <li>|γ₁| &gt; 0.5 を超えると実質的に有意な非対称性（橙色の閾値線）</li>
        </ul>
        <p>ローリング歪度の時変性は以下を示唆します:</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>歪度が急に負に振れる → 暴落リスクの高まり。プットオプション需要が増加</li>
          <li>歪度の符号反転 → 市場心理の転換。強気相場では正、弱気相場では負になりやすい</li>
          <li>歪度の絶対値が増大 → 分布のテールイベントが増加。リスク管理の見直しが必要</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">超過尖度 (Excess Kurtosis)</p>
        <p>超過尖度 γ₂ = E[(X-μ)⁴]/σ⁴ - 3 は分布のテールの厚さを測定します。正規分布では γ₂ = 0 です。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>γ₂ = 0: 正規分布と同等のテール</li>
          <li>γ₂ &gt; 0 (正の超過尖度、レプトクルティック): テールが重い。極端な値動きが正規分布の予測より頻繁。ほぼ全ての金融資産で観察される</li>
          <li>γ₂ &lt; 0 (負の超過尖度、プラティクルティック): テールが軽い。稀</li>
          <li>γ₂ &gt; 3 は非常に重いテール（赤の閾値線）</li>
        </ul>
        <p>ローリング尖度の時変性は以下を示唆します:</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>尖度の急上昇 → テールイベントの頻度増加。暴落やスパイクが増える前兆の可能性</li>
          <li>尖度が高い状態の持続 → VaRやCVaRの正規分布ベースの推定が大幅に過小評価</li>
          <li>尖度がゼロ付近で安定 → 分布が正規分布に近く、標準的なリスク管理手法が有効</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">実務への応用</p>
        <p>ローリング歪度と尖度を組み合わせることで、Jarque-Bera検定のローリング版（正規性の時変検定）を暗黙的に実行していることになります。JB = (n/6)(γ₁² + γ₂²/4) が大きくなる時期は、リスクモデルの信頼性が低下し、ポジションサイズの縮小やオプションによるヘッジを検討すべき時期です。</p>
      </AnalysisGuide>
    </div>
  );
}
