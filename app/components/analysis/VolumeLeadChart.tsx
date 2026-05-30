"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeVolumeLead } from "../../lib/volume-price-dynamics";
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

export default function VolumeLeadChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const result = useMemo(() => computeVolumeLead(prices), [prices]);

  useEffect(() => {
    if (!canvasRef.current || result.crossCorrelations.length === 0) return;
    const H = 280;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 50, mr = 20, mt = 30, mb = 40;
    const plotW = width - ml - mr, plotH = height - mt - mb;

    const cc = result.crossCorrelations;
    const maxAbs = Math.max(...cc.map(c => Math.abs(c.correlation)), 0.1);
    const yFrom = (v: number) => mt + plotH / 2 - (v / maxAbs) * (plotH / 2);
    const n = cc.length;
    const barW = plotW / n * 0.7;
    const conf = 1.96 / Math.sqrt(prices.length);

    // Grid
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = mt + (plotH * i) / 4;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
    }
    // Zero line
    ctx.strokeStyle = "#374151"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ml, yFrom(0)); ctx.lineTo(width - mr, yFrom(0)); ctx.stroke();
    // Confidence bands
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 0.8; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(ml, yFrom(conf)); ctx.lineTo(width - mr, yFrom(conf)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ml, yFrom(-conf)); ctx.lineTo(width - mr, yFrom(-conf)); ctx.stroke();
    ctx.setLineDash([]);

    // Bars
    for (let i = 0; i < n; i++) {
      const c = cc[i];
      const cx = ml + plotW * (i + 0.5) / n;
      const x = cx - barW / 2;
      const y0 = yFrom(0);
      const y1 = yFrom(c.correlation);
      const significant = Math.abs(c.correlation) > conf;
      ctx.fillStyle = c.lag < 0
        ? (significant ? "#3b82f6cc" : "#3b82f644")
        : c.lag > 0
        ? (significant ? "#ef4444cc" : "#ef444444")
        : (significant ? "#10b981cc" : "#10b98144");
      ctx.fillRect(x, Math.min(y0, y1), barW, Math.abs(y1 - y0));

      ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(`${c.lag}`, cx, height - mb + 14);
    }

    // Y labels
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let v = -maxAbs; v <= maxAbs; v += maxAbs / 2) {
      ctx.fillText(v.toFixed(2), ml - 4, yFrom(v) + 3);
    }

    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("出来高変化 ↔ リターン クロスコレログラム", ml, mt - 10);
    ctx.font = "9px sans-serif"; ctx.fillStyle = "#6b7280"; ctx.textAlign = "center";
    ctx.fillText("ラグ (負=出来高が先行, 正=リターンが先行)", ml + plotW / 2, height - mb + 30);
  }, [result, prices.length]);

  if (result.crossCorrelations.length === 0) return null;

  const vUp = result.volumeChangePrediction.volUp;
  const vDown = result.volumeChangePrediction.volDown;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">出来高先行性分析</h3>
      <div className="relative"><canvas ref={canvasRef} /></div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="p-3 bg-green-50 rounded border border-green-200">
          <div className="font-medium text-green-800 mb-1">出来高急増翌日 (+50%超)</div>
          <div className="space-y-0.5">
            <div>平均リターン: <span className="font-mono font-bold">{(vUp.meanReturn * 100).toFixed(3)}%</span></div>
            <div>勝率: <span className="font-mono font-bold">{(vUp.winRate * 100).toFixed(1)}%</span> (n={vUp.n})</div>
          </div>
        </div>
        <div className="p-3 bg-orange-50 rounded border border-orange-200">
          <div className="font-medium text-orange-800 mb-1">出来高急減翌日 (-33%超)</div>
          <div className="space-y-0.5">
            <div>平均リターン: <span className="font-mono font-bold">{(vDown.meanReturn * 100).toFixed(3)}%</span></div>
            <div>勝率: <span className="font-mono font-bold">{(vDown.winRate * 100).toFixed(1)}%</span> (n={vDown.n})</div>
          </div>
        </div>
      </div>

      <AnalysisGuide title="出来高先行性分析の詳細理論">
        <p className="font-medium text-gray-700">1. クロスコレログラム</p>
        <p>{"出来高変化率 ΔV_t = V_t/V_{t-1} - 1 とリターン r_t のクロスコレログラムを計算します。ラグ k での相関 ρ(k) = Corr(ΔV_t, r_{t+k})。"}</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>負のラグで有意</strong>: 出来高変化がリターンに先行。出来高が予測情報を持つ。</li>
          <li><strong>正のラグで有意</strong>: リターンが出来高に先行。価格変動後に出来高が追随。</li>
          <li><strong>ラグ0で有意</strong>: 同時相関。出来高と価格が同時に動く。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">2. 条件付き分析</p>
        <p>出来高が前日比50%以上増加した翌日のリターン特性を評価します。出来高急増は情報イベント（決算発表、ニュース等）を示唆し、翌日に方向性バイアスが存在するか検証します。</p>
        <p className="font-medium text-gray-700 mt-3">3. 実務への示唆</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>出来高の先行性が確認されれば、出来高急増をエントリートリガーとして利用可能</li>
          <li>出来高の自己相関が高い場合、出来高自体が予測可能でモデルに組み込める</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
