"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { drawdownEpisodes } from "../../lib/risk-extra";
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

function histogram(vals: number[], bins: number): { x0: number; x1: number; c: number }[] {
  if (!vals.length) return [];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const step = (hi - lo) / bins || 1;
  const out = Array.from({ length: bins }, (_, i) => ({ x0: lo + i * step, x1: lo + (i + 1) * step, c: 0 }));
  for (const v of vals) { const b = Math.min(bins - 1, Math.floor((v - lo) / step)); out[b].c++; }
  return out;
}

export default function DrawdownDistChart({ prices }: Props) {
  const depthRef = useRef<HTMLCanvasElement>(null);
  const durRef = useRef<HTMLCanvasElement>(null);
  const eps = useMemo(() => drawdownEpisodes(prices).filter((e) => e.depth < -0.02), [prices]);

  const draw = (canvas: HTMLCanvasElement | null, vals: number[], title: string, color: string, fmt: (v: number) => string) => {
    if (!canvas) return;
    const init = initCanvas(canvas, 180);
    if (!init) return;
    const { ctx, width } = init;
    const ml = 30, mr = 10, mt = 22, mb = 28;
    const plotW = width - ml - mr, plotH = 180 - mt - mb;
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(title, ml, 14);
    const h = histogram(vals, 12);
    const maxC = Math.max(1, ...h.map((b) => b.c));
    const slot = plotW / h.length;
    h.forEach((b, i) => {
      const bh = (b.c / maxC) * plotH;
      ctx.fillStyle = color;
      ctx.fillRect(ml + i * slot + 1, mt + plotH - bh, slot - 2, bh);
    });
    ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    [0, Math.floor(h.length / 2), h.length - 1].forEach((i) => h[i] && ctx.fillText(fmt(h[i].x0), ml + i * slot + slot / 2, mt + plotH + 12));
  };

  useEffect(() => {
    draw(depthRef.current, eps.map((e) => e.depth * 100), "DDの深さ分布(%)", "#dc2626", (v) => v.toFixed(0));
    draw(durRef.current, eps.map((e) => e.recovery), "回復日数の分布", "#2563eb", (v) => v.toFixed(0));
  }, [eps]);

  if (prices.length < 60 || eps.length < 3) return null;
  const worst = eps.reduce((a, b) => (b.depth < a.depth ? b : a), eps[0]);
  const avgRecovery = Math.round(eps.reduce((s, e) => s + e.recovery, 0) / eps.length);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">ドローダウン期間・回復時間の分布</h3>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded"><div className="text-gray-500">DD回数(2%超)</div><div className="font-mono font-medium">{eps.length}回</div></div>
        <div className="p-2 bg-red-50 rounded"><div className="text-gray-500">最大DD</div><div className="font-mono font-medium">{(worst.depth * 100).toFixed(1)}%</div></div>
        <div className="p-2 bg-blue-50 rounded"><div className="text-gray-500">平均回復日数</div><div className="font-mono font-medium">{avgRecovery}日</div></div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="relative"><canvas ref={depthRef} /></div>
        <div className="relative"><canvas ref={durRef} /></div>
      </div>

      <AnalysisGuide title="ドローダウン分布の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"過去の各ドローダウン（高値からの下落局面）を1件ずつ取り出し、深さ・継続日数・回復日数の分布を見る。『今のDDは過去と比べてどれくらい深刻か』『あとどれくらいで戻りそうか』の感覚を得る。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>DDエピソード</strong>: 終値が直近高値を更新してから、次に高値を更新するまでの一山。</li>
          <li><strong>深さ</strong>=(谷−山)/山、<strong>継続</strong>=山→谷の日数、<strong>回復</strong>=谷→高値更新の日数。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>現在のDDが分布の右端（過去最大級）なら、底値圏の可能性／一方で更なる悪化の警戒。</li>
          <li>回復日数の中央値＝含み損から戻るまでの目安。資金計画・メンタル管理に。</li>
          <li>深いDDが頻発する対象は、サイズを抑えるかヘッジを併用。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>未回復のDDは回復日数が確定しない（進行中）。</li>
          <li>2%未満の小さなDDは除外して集計。閾値で件数が変わる。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
