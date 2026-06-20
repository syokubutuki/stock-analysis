"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { blockBootstrap } from "../../lib/block-bootstrap";
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

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;

export default function BlockBootstrapChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const res = useMemo(() => (prices.length < 80 ? null : blockBootstrap(prices, 1000)), [prices]);

  useEffect(() => {
    if (!canvasRef.current || !res) return;
    const init = initCanvas(canvasRef.current, 180);
    if (!init) return;
    const { ctx, width } = init;
    const ml = 20, mr = 10, mt = 22, mb = 24;
    const plotW = width - ml - mr, plotH = 180 - mt - mb;
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("ブートストラップ最終リターン分布（赤=実績, 帯=90%CI）", ml, 14);
    const sorted = [...res.samples].sort((a, b) => a - b);
    const lo = sorted[0], hi = sorted[sorted.length - 1];
    const bins = 30, step = (hi - lo) / bins || 1;
    const counts = new Array(bins).fill(0);
    for (const v of res.samples) counts[Math.max(0, Math.min(bins - 1, Math.floor((v - lo) / step)))]++;
    const maxC = Math.max(1, ...counts);
    const slot = plotW / bins;
    const xOf = (v: number) => ml + ((v - lo) / (hi - lo)) * plotW;
    // CI帯
    ctx.fillStyle = "rgba(37,99,235,0.08)";
    ctx.fillRect(xOf(res.terminalLo), mt, xOf(res.terminalHi) - xOf(res.terminalLo), plotH);
    for (let i = 0; i < bins; i++) {
      const h = (counts[i] / maxC) * plotH;
      ctx.fillStyle = "#93c5fd";
      ctx.fillRect(ml + i * slot, mt + plotH - h, slot - 0.5, h);
    }
    // 実績線
    ctx.strokeStyle = "#dc2626"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(xOf(res.actualTerminal), mt); ctx.lineTo(xOf(res.actualTerminal), mt + plotH); ctx.stroke();
    ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    [res.terminalLo, res.terminalMedian, res.terminalHi].forEach((v) => ctx.fillText(fmtPct(v), xOf(v), mt + plotH + 12));
  }, [res]);

  if (prices.length < 80 || !res) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">ブロック・ブートストラップでの頑健性</h3>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
        <div className="p-2 rounded border border-red-200 bg-red-50"><div className="text-gray-500">実績 最終リターン</div><div className="font-mono font-bold">{fmtPct(res.actualTerminal)}</div></div>
        <div className="p-2 rounded border border-blue-200 bg-blue-50"><div className="text-gray-500">90%CI</div><div className="font-mono font-bold">{fmtPct(res.terminalLo)} 〜 {fmtPct(res.terminalHi)}</div></div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50"><div className="text-gray-500">プラス確率</div><div className="font-mono font-bold">{(res.pPositive * 100).toFixed(0)}%</div></div>
        <div className="p-2 rounded border border-red-200 bg-red-50"><div className="text-gray-500">実績シャープ</div><div className="font-mono font-bold">{res.actualSharpe.toFixed(2)}</div></div>
        <div className="p-2 rounded border border-blue-200 bg-blue-50"><div className="text-gray-500">シャープ90%CI</div><div className="font-mono font-bold">{res.sharpeLo.toFixed(2)} 〜 {res.sharpeHi.toFixed(2)}</div></div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50"><div className="text-gray-500">シャープ中央値</div><div className="font-mono font-bold">{res.sharpeMedian.toFixed(2)}</div></div>
      </div>

      <div className="relative"><canvas ref={canvasRef} /></div>

      <AnalysisGuide title="ブロック・ブートストラップの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"実績の好成績が『実力か、たまたまか』を検証する。日次リターンをブロック単位でシャッフルして無数の『もしもの履歴』を作り、最終リターンやシャープがどれくらいばらつくかを見る。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ブロック</strong>: 連続する数日をひと塊で再標本化。自己相関（ボラのクラスタリング等）を壊さず保つ。</li>
          <li>1000回リサンプルし、各回の最終リターン・シャープの分布から90%信頼区間を作る。</li>
          <li>実績値がこの分布のどこに位置するかを見る。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>CIの下限がマイナス＝負ける履歴も十分あり得る＝過信禁物。サイズを抑える。</li>
          <li>プラス確率が高くCI下限もプラス＝頑健な優位性。</li>
          <li>シャープのCIが広い＝運の要素が大きい。サンプル不足を疑う。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ここでは買い持ち(B&H)のリターン列を対象。戦略エクイティに差し替えると戦略の頑健性検証になる。</li>
          <li>ブロック長の選択で結果が変わる。順序入替なので長期トレンドの情報は一部失われる。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
