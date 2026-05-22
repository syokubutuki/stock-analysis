"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { logReturns } from "../../lib/transforms";
import { computeDFA, computeMFDFA } from "../../lib/fractal";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function DFAChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mfCanvasRef = useRef<HTMLCanvasElement>(null);

  const closes = prices.map((p) => p.close);
  const lr = logReturns(closes);

  const dfa = useMemo(() => computeDFA(lr), [prices]);
  const mfdfa = useMemo(() => computeMFDFA(lr), [prices]);

  // DFA log-logプロット
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dfa.points.length < 2) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 220;
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

    const margin = { top: 20, right: 20, bottom: 30, left: 50 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    const logNs = dfa.points.map((p) => p.logN);
    const logFs = dfa.points.map((p) => p.logF);
    const minX = Math.min(...logNs);
    const maxX = Math.max(...logNs);
    const minY = Math.min(...logFs);
    const maxY = Math.max(...logFs);
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    const toX = (v: number) => margin.left + ((v - minX) / rangeX) * plotW;
    const toY = (v: number) => margin.top + plotH - ((v - minY) / rangeY) * plotH;

    // グリッド
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = margin.top + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(width - margin.right, y);
      ctx.stroke();
    }

    // 回帰直線
    const x1 = minX;
    const x2 = maxX;
    const sumX = logNs.reduce((a, b) => a + b, 0);
    const sumY2 = logFs.reduce((a, b) => a + b, 0);
    const n = logNs.length;
    const sumXY = logNs.reduce((a, x, i) => a + x * logFs[i], 0);
    const sumX2_ = logNs.reduce((a, x) => a + x * x, 0);
    const slope = (n * sumXY - sumX * sumY2) / (n * sumX2_ - sumX * sumX);
    const intercept = (sumY2 - slope * sumX) / n;

    ctx.strokeStyle = "rgba(239, 68, 68, 0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(toX(x1), toY(slope * x1 + intercept));
    ctx.lineTo(toX(x2), toY(slope * x2 + intercept));
    ctx.stroke();
    ctx.setLineDash([]);

    // データ点
    ctx.fillStyle = "#2563eb";
    for (const p of dfa.points) {
      ctx.beginPath();
      ctx.arc(toX(p.logN), toY(p.logF), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // 軸ラベル
    ctx.fillStyle = "#666";
    ctx.font = "11px sans-serif";
    ctx.fillText("log₁₀(n)", width / 2 - 20, height - 5);
    ctx.save();
    ctx.translate(12, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("log₁₀(F(n))", -25, 0);
    ctx.restore();

    // H値
    ctx.fillStyle = "#333";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText(`H = ${dfa.hurstExponent.toFixed(3)}`, margin.left + 10, margin.top + 15);
  }, [dfa]);

  // MF-DFA: h(q)プロットと特異性スペクトル
  useEffect(() => {
    const canvas = mfCanvasRef.current;
    if (!canvas || mfdfa.qValues.length === 0) return;

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

    const halfW = width / 2;
    const margin = { top: 20, right: 15, bottom: 25, left: 40 };

    // 左: h(q) vs q
    {
      const plotW = halfW - margin.left - margin.right;
      const plotH = height - margin.top - margin.bottom;

      const qs = mfdfa.qValues;
      const hs = mfdfa.hurst;
      const minQ = Math.min(...qs);
      const maxQ = Math.max(...qs);
      const minH = Math.min(...hs);
      const maxH = Math.max(...hs);
      const rangeQ = maxQ - minQ || 1;
      const rangeH = maxH - minH || 0.5;

      const toX = (v: number) => margin.left + ((v - minQ) / rangeQ) * plotW;
      const toY = (v: number) => margin.top + plotH - ((v - minH + 0.1) / (rangeH + 0.2)) * plotH;

      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < qs.length; i++) {
        const x = toX(qs[i]);
        const y = toY(hs[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.fillStyle = "#3b82f6";
      for (let i = 0; i < qs.length; i++) {
        ctx.beginPath();
        ctx.arc(toX(qs[i]), toY(hs[i]), 3, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = "#666";
      ctx.font = "10px sans-serif";
      ctx.fillText("q", halfW / 2 - 5, height - 5);
      ctx.fillText("h(q)", margin.left, margin.top - 5);
    }

    // 右: f(α) 特異性スペクトル
    {
      const offsetX = halfW;
      const plotW = halfW - margin.left - margin.right;
      const plotH = height - margin.top - margin.bottom;

      const spec = mfdfa.singularitySpectrum;
      if (spec.length > 0) {
        const alphas = spec.map((s) => s.alpha);
        const fs = spec.map((s) => s.f);
        const minA = Math.min(...alphas);
        const maxA = Math.max(...alphas);
        const minF = Math.min(...fs);
        const maxF = Math.max(...fs);
        const rangeA = maxA - minA || 1;
        const rangeF = maxF - minF || 1;

        const toX = (v: number) => offsetX + margin.left + ((v - minA + 0.1) / (rangeA + 0.2)) * plotW;
        const toY = (v: number) => margin.top + plotH - ((v - minF + 0.1) / (rangeF + 0.2)) * plotH;

        ctx.strokeStyle = "#a855f7";
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < spec.length; i++) {
          const x = toX(spec[i].alpha);
          const y = toY(spec[i].f);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        ctx.fillStyle = "#a855f7";
        for (let i = 0; i < spec.length; i++) {
          ctx.beginPath();
          ctx.arc(toX(spec[i].alpha), toY(spec[i].f), 3, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.fillStyle = "#666";
        ctx.font = "10px sans-serif";
        ctx.fillText("α", offsetX + halfW / 2 - 5, height - 5);
        ctx.fillText("f(α)", offsetX + margin.left, margin.top - 5);
      }
    }
  }, [mfdfa]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">フラクタル / スケーリング</h3>

      <div className="text-sm font-medium text-gray-700 mb-2">DFA (Detrended Fluctuation Analysis)</div>
      <div className="w-full rounded border border-gray-100 overflow-hidden">
        <canvas ref={canvasRef} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Hurst指数 (α)</div>
          <div className={`font-mono font-medium text-sm ${
            dfa.hurstExponent > 0.6
              ? "text-green-600"
              : dfa.hurstExponent < 0.4
              ? "text-blue-600"
              : ""
          }`}>
            {dfa.hurstExponent.toFixed(3)}
          </div>
          <div className="text-gray-400">{dfa.interpretation}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">MF-DFA スペクトル幅</div>
          <div className="font-mono font-medium text-sm">{mfdfa.width.toFixed(3)}</div>
          <div className="text-gray-400">
            {mfdfa.width > 0.3 ? "マルチフラクタル性強" : "モノフラクタル寄り"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">h(2) (標準DFA)</div>
          <div className="font-mono font-medium text-sm">
            {mfdfa.hurst.length > 0
              ? mfdfa.hurst[mfdfa.qValues.indexOf(2)]?.toFixed(3) || "-"
              : "-"}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <div className="text-sm font-medium text-gray-700 mb-2">
          MF-DFA: h(q) と 特異性スペクトル f(α)
        </div>
        <div className="w-full rounded border border-gray-100 overflow-hidden">
          <canvas ref={mfCanvasRef} />
        </div>
        <div className="mt-1 flex gap-3 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-blue-500" /> h(q) — 一般化Hurst
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-purple-500" /> f(α) — 特異性スペクトル
          </span>
        </div>
      </div>

      <AnalysisGuide title="フラクタル分析の読み方">
        <p><span className="font-medium">DFA(Detrended Fluctuation Analysis):</span> 時系列の長期依存性(長期記憶)を推定する手法です。データからトレンドを除去した上で、様々なスケール(時間幅)での変動の大きさを測定し、そのスケーリング則からHurst指数を推定します。</p>
        <p><span className="font-medium">Hurst指数(H)の解釈:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">H &lt; 0.4 (反持続性):</span> 上がったら次は下がりやすい、下がったら次は上がりやすい傾向。平均回帰的な動き。逆張り戦略が有効な可能性。</li>
          <li><span className="font-medium">H ≈ 0.5 (ランダムウォーク):</span> 過去の動きが将来に影響しない。効率的市場仮説と整合的。予測は困難。</li>
          <li><span className="font-medium">H &gt; 0.6 (持続性):</span> 上がったら次も上がりやすい傾向。トレンドフォロー戦略が有効な可能性。</li>
          <li><span className="font-medium">H &gt; 0.8 (強い持続性):</span> 非常に強いトレンド。ただし、これほど高い値が持続することは稀。</li>
        </ul>
        <p><span className="font-medium">log-logプロット:</span> 横軸がスケール(n)の対数、縦軸が変動関数F(n)の対数です。点がきれいな直線上に乗っていれば、単一のスケーリング則に従っている(モノフラクタル)ことを意味します。直線から外れる場合は、スケールによって異なる性質を持つ(マルチフラクタル)可能性があります。</p>
        <p><span className="font-medium">MF-DFA(マルチフラクタルDFA):</span> 通常のDFAを一般化し、異なる「瞬間」(q値)でのスケーリングを調べます。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">h(q)プロット(左図):</span> 一般化Hurst指数。h(q)がqによって変化すればマルチフラクタル、一定ならモノフラクタル。q&gt;0は大きな変動のスケーリング、q&lt;0は小さな変動のスケーリングに敏感です。</li>
          <li><span className="font-medium">f(α)スペクトル(右図):</span> 特異性スペクトル。逆U字型の形状になります。幅(Δα)が広いほどマルチフラクタル性が強い = 大きな変動と小さな変動のスケーリングが異なる。</li>
        </ul>
        <p><span className="font-medium">スペクトル幅の解釈:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">Δα &lt; 0.3 (モノフラクタル寄り):</span> 市場が単一のメカニズムで動いている。比較的安定した環境。</li>
          <li><span className="font-medium">Δα &gt; 0.3 (マルチフラクタル性強):</span> 複数の異なるメカニズムが共存。極端な変動(テールイベント)のスケーリングが通常の変動と異なる = リスク管理に注意が必要。大きな変動が通常のモデルで予測されるよりも頻繁に起こりうる。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
