"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { rollingDensitySurface } from "../../lib/distribution-extended";
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

// 密度値→色 (Viridis風)
function viridisColor(t: number): string {
  t = Math.max(0, Math.min(1, t));
  // 簡略版Viridis
  const r = Math.round(68 + (253 - 68) * t * (1 - t) * 4 + (t > 0.75 ? (t - 0.75) * 4 * (253 - 100) : 0));
  const g = Math.round(1 + (231 - 1) * t);
  const b = Math.round(84 + (37 - 84) * t + (t < 0.5 ? (0.5 - t) * 2 * (150 - 84) : 0));
  return `rgb(${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)})`;
}

export default function DistributionSurfaceChart({ prices, seriesMode }: Props) {
  const surfaceRef = useRef<HTMLCanvasElement>(null);

  const { values: lr, times } = extractSeries(prices, seriesMode);
  const surface = useMemo(
    () => rollingDensitySurface(lr, times, 60, 40, 3),
    [prices, seriesMode]
  );

  useEffect(() => {
    if (!surfaceRef.current || surface.rows.length < 2) return;
    const r = initCanvas(surfaceRef.current, 350); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 20, bottom: 50, left: 60, right: 60 };
    const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;

    const rows = surface.rows;
    const nTime = rows.length;
    const nBins = surface.binCenters.length;

    // 最大密度を取得
    let maxDensity = 0;
    for (const row of rows) {
      for (const d of row.densities) {
        if (d > maxDensity) maxDensity = d;
      }
    }
    if (maxDensity <= 0) return;

    // セルサイズ
    const cellW = pw / nTime;
    const cellH = ph / nBins;

    // ヒートマップ描画
    for (let t = 0; t < nTime; t++) {
      for (let b = 0; b < nBins; b++) {
        const density = rows[t].densities[b];
        const normalized = density / maxDensity;
        if (normalized < 0.01) continue; // 背景色のまま
        ctx.fillStyle = viridisColor(normalized);
        const x = pad.left + t * cellW;
        const y = pad.top + (nBins - 1 - b) * cellH;
        ctx.fillRect(x, y, cellW + 0.5, cellH + 0.5);
      }
    }

    // ゼロラインの位置を計算
    const binCenters = surface.binCenters;
    const zeroIdx = binCenters.reduce((best, v, i) =>
      Math.abs(v) < Math.abs(binCenters[best]) ? i : best, 0);
    const zeroY = pad.top + (nBins - 1 - zeroIdx) * cellH + cellH / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(pad.left + pw, zeroY); ctx.stroke();
    ctx.setLineDash([]);

    // Y軸ラベル (リターン値)
    ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    const yStep = Math.max(1, Math.floor(nBins / 6));
    for (let i = 0; i < nBins; i += yStep) {
      const v = binCenters[i];
      const y = pad.top + (nBins - 1 - i) * cellH + cellH / 2;
      ctx.fillText((v * 100).toFixed(1) + "%", pad.left - 5, y + 3);
    }

    // X軸ラベル (日付)
    ctx.textAlign = "center";
    const xStep = Math.max(1, Math.floor(nTime / 6));
    for (let t = 0; t < nTime; t += xStep) {
      const x = pad.left + (t + 0.5) * cellW;
      const date = rows[t].time;
      ctx.fillText(date.slice(2, 7), x, height - pad.bottom + 15);
    }

    // 軸タイトル
    ctx.fillStyle = "#333"; ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("時間 →", width / 2, height - 5);
    ctx.save(); ctx.translate(12, height / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText("リターン", 0, 0); ctx.restore();

    // カラーバー
    const barW = 12, barH = ph;
    const barX = width - pad.right + 15;
    for (let i = 0; i < barH; i++) {
      const t = i / barH;
      ctx.fillStyle = viridisColor(t);
      ctx.fillRect(barX, pad.top + barH - i, barW, 1);
    }
    ctx.fillStyle = "#999"; ctx.font = "8px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("高密度", barX + barW + 3, pad.top + 8);
    ctx.fillText("低密度", barX + barW + 3, pad.top + barH);
  }, [surface]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">分布のダイナミクス (ローリング密度サーフェス)</h3>

      <div className="text-xs text-gray-500 mb-1">
        60日ローリング窓でKDE推定した密度を時間軸に沿ってヒートマップ表示 (白破線=リターン0%)
      </div>
      {surface.rows.length >= 2 ? (
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={surfaceRef} /></div>
      ) : (
        <div className="text-xs text-gray-400 py-8 text-center">データが不足しています (最低60日必要)</div>
      )}

      <AnalysisGuide title="分布ダイナミクスの詳細理論">
        <p className="font-medium text-gray-700">ローリング密度サーフェス</p>
        <p>時刻tにおけるリターン分布の推定密度 f̂ₜ(x) を、窓幅W=60日のカーネル密度推定（KDE）で逐次計算し、時間(横軸)×リターン値(縦軸)×密度(色)の二次元ヒートマップとして表示します。これは三次元サーフェスの等高線図（バードアイビュー）に相当します。</p>
        <p>数式: f̂ₜ(x) = (1/Wh) Σᵢ₌ₜ₋ᵤ₊₁ᵗ K((x - rᵢ)/h) ここで K はガウスカーネル、h = 1.06σ̂ₜW⁻¹/⁵ はSilvermanの経験則によるバンド幅です。</p>

        <p className="font-medium text-gray-700 mt-3">読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>明るい（黄色/緑）領域 → 高密度。リターンがその範囲に集中している時期</li>
          <li>暗い（紫/黒）領域 → 低密度。リターンがその範囲にはほとんど分布していない時期</li>
          <li>白破線 → リターン0%の位置。分布の中心がこの線からどれだけずれているかで、平均リターンの時変性がわかる</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">パターンの解釈</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>高密度領域が狭い帯 → ボラティリティが低い時期。分布が鋭いピークを持つ</li>
          <li>高密度領域が広い帯 → ボラティリティが高い時期。分布が扁平になっている</li>
          <li>帯の幅が急に変わる → ボラティリティレジームの変化。GARCH型モデルのブレークポイント</li>
          <li>帯の中心が上下に動く → ドリフト（平均リターン）の時変性</li>
          <li>2つの帯が見える（分岐） → 分布の二峰化。2つのレジームが混在する証拠。HMM分析との整合性を確認</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">他の分析手法との関係</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ローリング標準偏差 → サーフェスの「帯の幅」に対応する1次元の要約</li>
          <li>ローリング歪度/尖度 → サーフェスの「形状の非対称性/テール」に対応する1次元の要約</li>
          <li>GARCH → サーフェスの分散の時変性をパラメトリックにモデル化したもの</li>
          <li>HMM → サーフェスの分岐パターンを離散的な状態遷移としてモデル化したもの</li>
          <li>この密度サーフェスはこれらすべての「元データ」であり、最も情報量が多い表現です</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
