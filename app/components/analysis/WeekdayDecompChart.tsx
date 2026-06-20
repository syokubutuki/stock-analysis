"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { decomposeByWeekday } from "../../lib/overnight-intraday";
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

type Mode = "mean" | "cum";

export default function WeekdayDecompChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>("mean");
  const rows = useMemo(() => decomposeByWeekday(prices), [prices]);

  useEffect(() => {
    if (!canvasRef.current || rows.length === 0) return;
    const init = initCanvas(canvasRef.current, 240);
    if (!init) return;
    const { ctx, width } = init;
    const ml = 44, mr = 14, mt = 24, mb = 30;
    const plotW = width - ml - mr, plotH = 240 - mt - mb;
    const getOn = (r: typeof rows[0]) => (mode === "mean" ? r.meanOvernight : r.cumOvernight);
    const getId = (r: typeof rows[0]) => (mode === "mean" ? r.meanIntraday : r.cumIntraday);
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(mode === "mean" ? "曜日別 平均リターン（夜間/日中）" : "曜日別 累積リターン（夜間/日中）", ml, 14);
    const maxAbs = Math.max(1e-9, ...rows.flatMap((r) => [Math.abs(getOn(r)), Math.abs(getId(r))]));
    const zeroY = mt + plotH / 2;
    ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(ml, zeroY); ctx.lineTo(ml + plotW, zeroY); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(`${(maxAbs * 100).toFixed(mode === "mean" ? 2 : 0)}%`, ml - 4, mt + 8);
    ctx.fillText(`-${(maxAbs * 100).toFixed(mode === "mean" ? 2 : 0)}%`, ml - 4, mt + plotH);
    const slot = plotW / rows.length;
    const barW = slot * 0.32;
    rows.forEach((r, i) => {
      const x0 = ml + i * slot + slot * 0.1;
      const series = [
        { v: getOn(r), color: "#dc2626", off: 0 },
        { v: getId(r), color: "#2563eb", off: barW + 4 },
      ];
      for (const s of series) {
        const h = (Math.abs(s.v) / maxAbs) * (plotH / 2 - 2);
        ctx.fillStyle = s.color;
        ctx.fillRect(x0 + s.off, s.v >= 0 ? zeroY - h : zeroY, barW, h);
      }
      ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(r.label, x0 + barW + 2, mt + plotH + 14);
      ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif";
      ctx.fillText(`n=${r.n}`, x0 + barW + 2, mt + plotH + 25);
    });
    ctx.textAlign = "left"; ctx.font = "9px sans-serif";
    ctx.fillStyle = "#dc2626"; ctx.fillText("■夜間", ml + 4, mt + 10);
    ctx.fillStyle = "#2563eb"; ctx.fillText("■日中", ml + 50, mt + 10);
  }, [rows, mode]);

  if (prices.length < 60 || rows.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">曜日別 夜間/日中エクイティ分解</h3>
        <div className="flex gap-1 text-xs">
          {(["mean", "cum"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`px-2 py-0.5 rounded ${mode === m ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{m === "mean" ? "平均" : "累積"}</button>
          ))}
        </div>
      </div>

      <div className="relative"><canvas ref={canvasRef} /></div>

      <AnalysisGuide title="曜日別 夜間/日中分解の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"1日のリターンを夜間（持ち越し）と日中（ザラ場）に分け、さらに曜日別に集計する。『どの曜日の、どの時間帯でリターンが出やすいか』を見て、執行タイミングの戦略を選ぶ。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>夜間=(始値−前日終値)/前日終値、日中=(終値−始値)/始値。曜日ごとに平均・複利累積。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>特定曜日の夜間がプラスに偏る＝その曜日の持ち越しが有利（曜日×時間帯のアノマリー）。</li>
          <li>日中がマイナスの曜日＝デイトレを避ける/ショート寄りに。</li>
          <li>累積で見て安定して効いているか（一発依存でないか）を確認。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>取引コスト未控除。曜日×時間帯の細分化で標本が減る（nを確認）。</li>
          <li>祝日・連休で曜日の意味がずれる週がある。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
