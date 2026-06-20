"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { multivarSimplex } from "../../lib/multivar-simplex";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
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

export default function MultivarSimplexChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [emb, setEmb] = useState(3);
  const res = useMemo(() => (prices.length < 150 ? null : multivarSimplex(prices, emb)), [prices, emb]);

  useEffect(() => {
    if (!canvasRef.current || !res) return;
    const init = initCanvas(canvasRef.current, 240);
    if (!init) return;
    const { ctx, width } = init;
    const sz = Math.min(width, 240);
    const ml = 40, mt = 16;
    const plotW = sz - ml - 10, plotH = 240 - mt - 28;
    const all = res.points.flatMap((p) => [p.predicted, p.actual]);
    const mx = Math.max(0.01, ...all.map(Math.abs));
    const xOf = (v: number) => ml + ((v + mx) / (2 * mx)) * plotW;
    const yOf = (v: number) => mt + plotH - ((v + mx) / (2 * mx)) * plotH;
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("予測 vs 実現（翌日リターン）", ml, 12);
    // 対角線
    ctx.strokeStyle = "#e5e7eb"; ctx.beginPath(); ctx.moveTo(xOf(-mx), yOf(-mx)); ctx.lineTo(xOf(mx), yOf(mx)); ctx.stroke();
    ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(xOf(0), mt); ctx.lineTo(xOf(0), mt + plotH); ctx.moveTo(ml, yOf(0)); ctx.lineTo(ml + plotW, yOf(0)); ctx.stroke();
    ctx.fillStyle = "rgba(37,99,235,0.4)";
    for (const p of res.points) { ctx.beginPath(); ctx.arc(xOf(p.predicted), yOf(p.actual), 1.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("予測→", ml + plotW / 2, mt + plotH + 14);
  }, [res]);

  if (prices.length < 150 || !res) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">多変量埋め込みでの近傍予測（multivariate simplex）</h3>
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span>埋め込み次元:</span>
          {[2, 3, 4].map((v) => (
            <button key={v} onClick={() => setEmb(v)} className={`px-2 py-0.5 rounded ${emb === v ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{v}</button>
          ))}
        </div>
      </div>

      <div className={`rounded-md border px-3 py-2 text-xs ${res.rho > 0.1 ? "border-green-200 bg-green-50 text-green-900" : "border-gray-200 bg-gray-50 text-gray-700"}`}>
        予測力 ρ = <span className="font-bold">{res.rho.toFixed(3)}</span>
        {res.rho > 0.1 ? "（非線形な近傍予測に一定の有効性）" : "（予測力は限定的）"}
        ／ 直近状態からの翌日予測 <span className="font-bold">{res.currentForecast >= 0 ? "+" : ""}{(res.currentForecast * 100).toFixed(2)}%</span>
        （近傍 {res.nNeighbors}点）
      </div>

      <div className="relative"><canvas ref={canvasRef} /></div>

      <AnalysisGuide title="多変量近傍予測の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"市場の状態をOHLC由来の特徴ベクトル（リターン・レンジ・ボラ）で表し、『今と似た過去の状態の、その次の動き』から翌日を予測する。線形モデルでは捉えにくい非線形な再現性を測る。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>各日を [リターン, レンジ, GKボラ] × 埋め込み次元 だけ連結した状態ベクトルに（標準化）。</li>
          <li><strong>simplex projection</strong>: 対象に近い過去の近傍を距離で抽出し、距離で重み付けした近傍の『次リターン』で予測。</li>
          <li><strong>予測力ρ</strong>: 予測と実現の相関。0より有意に大きいほど非線形予測が効く。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ρが高い＝状態空間に再現性がある＝近傍予測をシグナルに使える。</li>
          <li>埋め込み次元を上げてρが改善するなら、より長い文脈が効く。</li>
          <li>現在の予測符号を、他のシグナルと組み合わせて方向判断に。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ρはサンプル全体の平均的予測力。局面で変動する。</li>
          <li>次元を上げすぎると近傍が疎になり過学習（次元の呪い）。</li>
          <li>ノイズの多い金融データではρは小さくなりがち（0.1前後でも有意なら価値）。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
