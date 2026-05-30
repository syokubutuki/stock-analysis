"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { conditionalDistributions, violinByGroup, type ViolinData } from "../../lib/distribution-extended";
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

function pctFmt(v: number, d = 4): string { return (v * 100).toFixed(d) + "%"; }
function colorClass(v: number): string { return v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500"; }

function drawViolins(canvas: HTMLCanvasElement, data: ViolinData[], title: string) {
  const r = initCanvas(canvas, 280); if (!r) return;
  const { ctx, width, height } = r;
  if (data.length === 0) return;
  const pad = { top: 25, bottom: 35, left: 50, right: 15 };
  const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;
  const nGroups = data.length;
  const groupW = pw / nGroups;

  // 全体のKDE値域を求める
  let allMinX = Infinity, allMaxX = -Infinity, allMaxDensity = 0;
  for (const d of data) {
    for (const k of d.kde) {
      allMinX = Math.min(allMinX, k.x);
      allMaxX = Math.max(allMaxX, k.x);
      allMaxDensity = Math.max(allMaxDensity, k.density);
    }
  }
  const xRange = allMaxX - allMinX || 1;
  const toY = (x: number) => pad.top + ph * (1 - (x - allMinX) / xRange);
  const maxHalfW = groupW * 0.4;

  const colors = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6",
    "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16", "#06b6d4", "#e11d48"];

  for (let g = 0; g < nGroups; g++) {
    const d = data[g];
    const cx = pad.left + (g + 0.5) * groupW;
    const color = colors[g % colors.length];

    if (d.kde.length < 2) continue;

    // バイオリンの輪郭 (左右対称)
    ctx.fillStyle = color.replace(")", ", 0.25)").replace("rgb", "rgba");
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < d.kde.length; i++) {
      const y = toY(d.kde[i].x);
      const halfW = (d.kde[i].density / allMaxDensity) * maxHalfW;
      if (i === 0) ctx.moveTo(cx - halfW, y);
      else ctx.lineTo(cx - halfW, y);
    }
    for (let i = d.kde.length - 1; i >= 0; i--) {
      const y = toY(d.kde[i].x);
      const halfW = (d.kde[i].density / allMaxDensity) * maxHalfW;
      ctx.lineTo(cx + halfW, y);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();

    // 四分位のボックス
    const q25Y = toY(d.q25), q75Y = toY(d.q75);
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.fillRect(cx - 3, q75Y, 6, q25Y - q75Y);

    // 中央値の線
    const medY = toY(d.median);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx - 6, medY); ctx.lineTo(cx + 6, medY); ctx.stroke();

    // 平均のドット
    const meanY = toY(d.mean);
    ctx.fillStyle = "#000";
    ctx.beginPath(); ctx.arc(cx, meanY, 3, 0, Math.PI * 2); ctx.fill();

    // ラベル
    ctx.fillStyle = "#333"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(d.label, cx, height - pad.bottom + 14);
    ctx.fillStyle = "#999"; ctx.font = "8px sans-serif";
    ctx.fillText(`n=${d.n}`, cx, height - pad.bottom + 24);
  }

  // Y軸
  ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const v = allMinX + (xRange * i) / 5;
    const y = toY(v);
    ctx.fillText(pctFmt(v, 2), pad.left - 5, y + 3);
    ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
  }

  // ゼロライン
  if (allMinX <= 0 && allMaxX >= 0) {
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.left, toY(0)); ctx.lineTo(width - pad.right, toY(0)); ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.fillStyle = "#333"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(title, pad.left + 5, pad.top - 8);
}

// 条件付き分布のヒストグラム
function drawConditionalHists(canvas: HTMLCanvasElement, data: ReturnType<typeof conditionalDistributions>) {
  const r = initCanvas(canvas, 250); if (!r) return;
  const { ctx, width, height } = r;
  if (data.length === 0) return;
  const pad = { top: 15, bottom: 25, left: 15, right: 15 };
  const pw = width - pad.left - pad.right;
  const cols = data.length;
  const cellW = pw / cols;
  const cellH = height - pad.top - pad.bottom;

  const colors = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6"];

  for (let c = 0; c < cols; c++) {
    const bucket = data[c];
    if (bucket.values.length < 3) continue;
    const vals = bucket.values;
    const ox = pad.left + c * cellW;

    // ヒストグラム
    const bins = 20;
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = max - min || 1;
    const binW = range / bins;
    const counts = new Array(bins).fill(0);
    for (const v of vals) {
      const idx = Math.min(Math.floor((v - min) / binW), bins - 1);
      counts[idx]++;
    }
    const maxCount = Math.max(...counts, 1);
    const barW = Math.max(2, (cellW - 10) / bins - 1);

    for (let i = 0; i < bins; i++) {
      const x = ox + 5 + (i / bins) * (cellW - 10);
      const barH = (counts[i] / maxCount) * (cellH - 20);
      ctx.fillStyle = colors[c] + "80";
      ctx.fillRect(x, pad.top + cellH - 20 - barH, barW, barH);
    }

    // ラベル
    ctx.fillStyle = "#333"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(bucket.label, ox + cellW / 2, height - 5);
    ctx.fillText(`μ=${pctFmt(bucket.mean, 2)}`, ox + cellW / 2, pad.top + 10);
  }
}

export default function ConditionalViolinChart({ prices, seriesMode }: Props) {
  const weekdayRef = useRef<HTMLCanvasElement>(null);
  const monthRef = useRef<HTMLCanvasElement>(null);
  const condRef = useRef<HTMLCanvasElement>(null);
  const [violinMode, setViolinMode] = useState<"weekday" | "month">("weekday");

  const { values: lr, times } = extractSeries(prices, seriesMode);

  const weekdayViolins = useMemo(() => violinByGroup(lr, times, "weekday"), [prices, seriesMode]);
  const monthViolins = useMemo(() => violinByGroup(lr, times, "month"), [prices, seriesMode]);
  const condDist = useMemo(() => conditionalDistributions(lr), [prices, seriesMode]);

  useEffect(() => {
    if (weekdayRef.current && weekdayViolins.length > 0)
      drawViolins(weekdayRef.current, weekdayViolins, "曜日別リターン分布 (バイオリンプロット)");
  }, [weekdayViolins]);

  useEffect(() => {
    if (monthRef.current && monthViolins.length > 0)
      drawViolins(monthRef.current, monthViolins, "月別リターン分布 (バイオリンプロット)");
  }, [monthViolins]);

  useEffect(() => {
    if (condRef.current && condDist.length > 0)
      drawConditionalHists(condRef.current, condDist);
  }, [condDist]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">条件付き分布・バイオリンプロット</h3>

      {/* 条件付き分布テーブル */}
      {condDist.length > 0 && (
        <>
          <div className="text-xs text-gray-500 mb-1">前日のリターン大きさ別: 翌日リターンの条件付き分布</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="py-1 px-2 text-left text-gray-500 font-medium">前日の状態</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">N</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">翌日平均</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">翌日σ</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">翌日歪度</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">翌日尖度</th>
                </tr>
              </thead>
              <tbody>
                {condDist.map((b, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    <td className="py-1 px-2 text-gray-600 font-medium">{b.label}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{b.n}</td>
                    <td className={`py-1 px-2 text-center font-mono ${colorClass(b.mean)}`}>{pctFmt(b.mean)}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{pctFmt(b.std)}</td>
                    <td className={`py-1 px-2 text-center font-mono ${Math.abs(b.skewness) > 0.5 ? "text-orange-600" : "text-gray-600"}`}>{b.skewness.toFixed(3)}</td>
                    <td className={`py-1 px-2 text-center font-mono ${b.kurtosis > 1 ? "text-red-600" : "text-gray-600"}`}>{b.kurtosis.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={condRef} /></div>
        </>
      )}

      {/* バイオリンプロット */}
      <div className="flex gap-2 mb-2">
        <button
          onClick={() => setViolinMode("weekday")}
          className={`px-3 py-1 text-xs rounded border ${violinMode === "weekday" ? "bg-blue-600 text-white border-blue-600" : "bg-gray-50 text-gray-600 border-gray-200"}`}
        >曜日別</button>
        <button
          onClick={() => setViolinMode("month")}
          className={`px-3 py-1 text-xs rounded border ${violinMode === "month" ? "bg-blue-600 text-white border-blue-600" : "bg-gray-50 text-gray-600 border-gray-200"}`}
        >月別</button>
      </div>

      {violinMode === "weekday" && weekdayViolins.length > 0 && (
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={weekdayRef} /></div>
      )}
      {violinMode === "month" && monthViolins.length > 0 && (
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={monthRef} /></div>
      )}

      <AnalysisGuide title="条件付き分布・バイオリンプロットの詳細理論">
        <p className="font-medium text-gray-700">1. 条件付き分布 f(rₜ | rₜ₋₁ ∈ A)</p>
        <p>前日のリターンの大きさで4つのバケット（大幅下落/小幅下落/小幅上昇/大幅上昇）に分類し、各バケットに属する日の翌日リターンの分布を比較します。閾値は標準偏差σを使い、±1σで区分します。</p>
        <p>条件付き分布の比較により以下がわかります:</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>条件付き平均の差 → リターンの予測可能性（モメンタム or ミーンリバージョン）</li>
          <li>条件付き標準偏差の差 → ボラティリティの非対称性（大変動後にボラが増大するか）</li>
          <li>条件付き歪度・尖度の差 → 分布の形状が前日の状態に依存するか</li>
          <li>大幅下落後の翌日: 平均は正（ミーンリバージョン）だが分散が大きい → 「反発するが不確実性も高い」</li>
        </ul>
        <p>条件付き独立の仮定が成り立つなら、すべてのバケットで同じ分布パラメータになるはずです。有意な差がある場合、リターン系列はiid（独立同一分布）ではなく、何らかの予測可能な構造が存在します。</p>

        <p className="font-medium text-gray-700 mt-3">2. バイオリンプロット</p>
        <p>各グループ（曜日/月）のリターン分布をカーネル密度推定（KDE）で推定し、左右対称に描画したものです。ボックスプロットの一般化であり、以下の情報を同時に表示します:</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>輪郭の幅 → その値付近の密度（出現頻度）</li>
          <li>灰色ボックス → 四分位範囲 (Q1~Q3)</li>
          <li>白い横線 → 中央値（メディアン）</li>
          <li>黒い点 → 平均値</li>
        </ul>
        <p>ボックスプロットでは見えない以下の構造を捉えます:</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>多峰性 → 分布にくびれがある場合、2つの異なるレジーム（例: ギャップアップ/ダウン）が混在</li>
          <li>テールの厚さ → バイオリンの端がどこまで伸びているかで、極端な値動きの頻度を視覚的に比較</li>
          <li>非対称性 → 上下でバイオリンの形が異なれば、歪度が存在</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">曜日効果・月効果（カレンダーアノマリー）</p>
        <p>効率的市場仮説(EMH)のもとでは、リターン分布は曜日や月に依存しないはずです。バイオリンプロットで分布の形状に系統的な差が見られれば、カレンダーアノマリーの存在を示唆します。ただし、取引コストやスリッページを考慮すると、統計的に有意な差があっても経済的に有意でない場合があります。</p>
      </AnalysisGuide>
    </div>
  );
}
