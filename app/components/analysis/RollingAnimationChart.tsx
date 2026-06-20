"use client";

import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import { PricePoint } from "../../lib/types";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; }

interface RRPoint { time: string; ret: number; vol: number; }

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
  return { ctx, width, height };
}

export default function RollingAnimationChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number | null>(null);

  const series = useMemo<RRPoint[]>(() => {
    const w = 63;
    const r: number[] = [];
    for (let i = 1; i < prices.length; i++) r.push(prices[i - 1].close > 0 ? Math.log(prices[i].close / prices[i - 1].close) : 0);
    const out: RRPoint[] = [];
    for (let end = w; end <= r.length; end++) {
      const seg = r.slice(end - w, end);
      const m = seg.reduce((s, v) => s + v, 0) / w;
      const sd = Math.sqrt(seg.reduce((s, v) => s + (v - m) ** 2, 0) / w);
      out.push({ time: prices[end].time, ret: m * 252, vol: sd * Math.sqrt(252) });
    }
    return out;
  }, [prices]);

  // 初期位置=末尾。series長が変わったらレンダー時にリセット（effectでのsetStateを避ける）。
  const [t, setT] = useState(series.length - 1);
  const [seenLen, setSeenLen] = useState(series.length);
  if (seenLen !== series.length) { setSeenLen(series.length); setT(series.length - 1); }

  const draw = useCallback((idx: number) => {
    if (!canvasRef.current || series.length === 0) return;
    const init = initCanvas(canvasRef.current, 280);
    if (!init) return;
    const { ctx, width } = init;
    ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, 280);
    const ml = 48, mr = 12, mt = 18, mb = 30;
    const plotW = width - ml - mr, plotH = 280 - mt - mb;
    const maxVol = Math.max(...series.map((p) => p.vol)) * 1.05 || 1;
    const retVals = series.map((p) => p.ret);
    const maxRet = Math.max(...retVals) * 1.05, minRet = Math.min(...retVals) * 1.05;
    const xOf = (v: number) => ml + (v / maxVol) * plotW;
    const yOf = (v: number) => mt + plotH - ((v - minRet) / (maxRet - minRet)) * plotH;
    // 軸
    ctx.strokeStyle = "#e5e7eb"; ctx.beginPath(); ctx.moveTo(ml, yOf(0)); ctx.lineTo(ml + plotW, yOf(0)); ctx.stroke();
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(`${(maxRet * 100).toFixed(0)}%`, ml - 4, mt + 8);
    ctx.fillText("0", ml - 4, yOf(0) + 3);
    ctx.fillText(`${(minRet * 100).toFixed(0)}%`, ml - 4, mt + plotH);
    ctx.textAlign = "center";
    ctx.fillText(`年率ボラ →`, ml + plotW / 2, mt + plotH + 18);
    // トレイル（過去60点）
    const start = Math.max(0, idx - 60);
    for (let i = start; i <= idx; i++) {
      const a = (i - start) / Math.max(1, idx - start);
      ctx.fillStyle = `rgba(37,99,235,${0.1 + a * 0.5})`;
      ctx.beginPath(); ctx.arc(xOf(series[i].vol), yOf(series[i].ret), 2 + a * 2, 0, Math.PI * 2); ctx.fill();
    }
    // 現在点
    const cur = series[idx];
    ctx.fillStyle = cur.ret >= 0 ? "#16a34a" : "#dc2626";
    ctx.beginPath(); ctx.arc(xOf(cur.vol), yOf(cur.ret), 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(`${cur.time}  年率Ret ${(cur.ret * 100).toFixed(0)}% / Vol ${(cur.vol * 100).toFixed(0)}%`, ml, 12);
  }, [series]);

  useEffect(() => { draw(Math.min(t, series.length - 1)); }, [t, draw, series.length]);

  useEffect(() => {
    if (!playing) { if (rafRef.current) cancelAnimationFrame(rafRef.current); return; }
    let last = performance.now();
    const loop = (now: number) => {
      if (now - last > 40) {
        last = now;
        setT((prev) => { if (prev >= series.length - 1) { setPlaying(false); return prev; } return prev + 1; });
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [playing, series.length]);

  if (prices.length < 100 || series.length < 10) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">ローリング・アニメーション（リスク/リターンの遷移）</h3>

      <div className="flex items-center gap-2">
        <button
          onClick={() => { if (t >= series.length - 1) setT(0); setPlaying((p) => !p); }}
          className="px-3 py-1 text-xs rounded font-medium bg-blue-600 text-white hover:bg-blue-700"
        >{playing ? "⏸ 停止" : "▶ 再生"}</button>
        <input type="range" min={0} max={series.length - 1} value={Math.min(t, series.length - 1)} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} className="flex-1" />
        <span className="text-xs text-gray-500 w-24 text-right">{series[Math.min(t, series.length - 1)]?.time}</span>
      </div>

      <div className="relative"><canvas ref={canvasRef} /></div>
      <div className="text-xs text-gray-500">点＝63日ローリングの年率リスク/リターン。再生で時間推移（レジーム遷移）を可視化。</div>

      <AnalysisGuide title="ローリング・アニメーションの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"63日(約3ヶ月)のローリングで測った『年率リターン』と『年率ボラ』を平面にプロットし、時間とともにどう移動するかを再生する。市場が低ボラ高リターンの好環境から高ボラ低リターンの悪環境へ、どう遷移したかが直感的に見える。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>各時点で直近63日の対数リターンから平均×252（年率リターン）と標準偏差×√252（年率ボラ）。</li>
          <li>横軸=ボラ、縦軸=リターン。トレイル（残像）で直近の軌跡を表示。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>左上（低ボラ・高リターン）＝最良環境、右下（高ボラ・低リターン）＝危険環境。現在地で攻守を判断。</li>
          <li>右方向（ボラ拡大）への移動が始まったらリスク縮小の合図。</li>
          <li>軌跡の周回パターンから、リスクオン/オフのサイクルを掴む。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ローリングのため直近の急変は63日かけて反映（遅れ）。</li>
          <li>過去の位置は確定値。将来の遷移を予測するものではない。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
