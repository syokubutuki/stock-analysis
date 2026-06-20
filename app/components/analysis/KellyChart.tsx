"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { kellyOptimal } from "../../lib/kelly-bs";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; }

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

export default function KellyChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const res = useMemo(() => {
    const r: number[] = [];
    for (let i = 1; i < prices.length; i++) if (prices[i - 1].close > 0) r.push(prices[i].close / prices[i - 1].close - 1);
    return r.length >= 50 ? kellyOptimal(r) : null;
  }, [prices]);

  useEffect(() => {
    if (!canvasRef.current || !res) return;
    const init = initCanvas(canvasRef.current, 220);
    if (!init) return;
    const { ctx, width } = init;
    const ml = 44, mr = 12, mt = 22, mb = 28;
    const plotW = width - ml - mr, plotH = 220 - mt - mb;
    const mu = res.mu, s2 = res.sigma * res.sigma;
    const g = (f: number) => mu * f - 0.5 * s2 * f * f; // 年率成長率
    const fMax = Math.max(2, res.kellyFraction * 1.6);
    const gKelly = g(res.kellyFraction);
    const gMax = Math.max(0.01, gKelly * 1.1);
    const gMin = Math.min(0, g(fMax));
    const xOf = (f: number) => ml + (f / fMax) * plotW;
    const yOf = (gg: number) => mt + plotH - ((gg - gMin) / (gMax - gMin)) * plotH;
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("レバレッジ f と期待成長率 g(f)", ml, 14);
    // 0線
    ctx.strokeStyle = "#e5e7eb"; ctx.beginPath(); ctx.moveTo(ml, yOf(0)); ctx.lineTo(ml + plotW, yOf(0)); ctx.stroke();
    // 曲線
    ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2; ctx.beginPath();
    for (let px = 0; px <= plotW; px++) { const f = (px / plotW) * fMax; const y = yOf(g(f)); if (px === 0) ctx.moveTo(ml + px, y); else ctx.lineTo(ml + px, y); }
    ctx.stroke();
    // f* と half-Kelly
    const mark = (f: number, color: string, label: string) => {
      ctx.strokeStyle = color; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(xOf(f), mt); ctx.lineTo(xOf(f), mt + plotH); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(label, xOf(f), mt + 10);
    };
    if (res.kellyFraction > 0 && res.kellyFraction < fMax) mark(res.kellyFraction, "#dc2626", `f*=${res.kellyFraction.toFixed(2)}`);
    if (res.halfKelly > 0 && res.halfKelly < fMax) mark(res.halfKelly, "#16a34a", `½`);
    ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(`${(gMax * 100).toFixed(0)}%`, ml - 3, mt + 8);
    ctx.fillText("0", ml - 3, yOf(0) + 3);
    ctx.textAlign = "center";
    for (let f = 0; f <= fMax; f += fMax / 4) ctx.fillText(`${f.toFixed(1)}x`, xOf(f), mt + plotH + 12);
  }, [res]);

  if (prices.length < 60 || !res) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">ケリー基準・最適f とサイズ曲線</h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className={`p-2 rounded border ${res.kellyFraction > 0 ? "border-red-200 bg-red-50" : "border-gray-200 bg-gray-50"}`}><div className="text-gray-500">フルケリー f*</div><div className="font-mono font-bold">{(res.kellyFraction * 100).toFixed(0)}%</div></div>
        <div className="p-2 rounded border border-green-200 bg-green-50"><div className="text-gray-500">半ケリー(推奨)</div><div className="font-mono font-bold">{(res.halfKelly * 100).toFixed(0)}%</div></div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50"><div className="text-gray-500">年率μ</div><div className="font-mono font-bold">{(res.mu * 100).toFixed(1)}%</div></div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50"><div className="text-gray-500">年率σ</div><div className="font-mono font-bold">{(res.sigma * 100).toFixed(1)}%</div></div>
      </div>

      <div className="relative"><canvas ref={canvasRef} /></div>

      <AnalysisGuide title="ケリー基準の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"資産を長期的に最も速く増やす『賭け金の割合（レバレッジ）』を求める。エッジ（期待リターン）が大きく分散が小さいほど、最適な投入比率は大きくなる。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>連続時間ケリー: f* = μ/σ²（μ=年率期待リターン、σ²=年率分散）。</li>
          <li>期待成長率: g(f) = μ·f − σ²·f²/2。f*で最大、2f*で g=0（それ以上は破産的）。</li>
          <li><strong>半ケリー</strong>: f*/2。成長率を大きく落とさずに変動（ドローダウン）を大幅に減らす実務的選択。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>f*が1を超える＝理論上はレバレッジ推奨だが、推定誤差・テールリスクで危険。半ケリー以下を推奨。</li>
          <li>曲線の山が緩やか＝サイズを多少外しても成長率は大きく変わらない（安全余地）。</li>
          <li>f*が負＝期待リターンが負。ロングは見送り。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>μ・σは過去推定で誤差が大きい。μの過大評価はオーバーベットを招く（破産リスク）。</li>
          <li>正規・独立を仮定。ファットテール下では実効ケリーはより小さい。</li>
          <li>フルケリーはドローダウンが極めて深い。実務はハーフ以下が定石。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
