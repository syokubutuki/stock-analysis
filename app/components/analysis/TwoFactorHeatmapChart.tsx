"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { buildStateFn, twoFactorForward, STATE_AXES, StateAxis } from "../../lib/conditional-forward-returns";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const HORIZONS = [1, 5, 10, 20];

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

export default function TwoFactorHeatmapChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [axisX, setAxisX] = useState<StateAxis>("trend");
  const [axisY, setAxisY] = useState<StateAxis>("vol");
  const [horizon, setHorizon] = useState(5);

  const result = useMemo(() => {
    if (prices.length < 300) return null;
    const sx = buildStateFn(prices, axisX);
    const sy = buildStateFn(prices, axisY);
    return twoFactorForward(prices, sx, sy, horizon);
  }, [prices, axisX, axisY, horizon]);

  useEffect(() => {
    if (!canvasRef.current || !result) return;
    const nx = result.xOrder.length, ny = result.yOrder.length;
    const cellH = 34, labelW = 150, topH = 28, botH = 40, rightW = 16;
    const H = topH + ny * cellH + botH;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width } = init;
    const gridW = width - labelW - rightW;
    const cellW = gridW / nx;
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(`平均${horizon}日先リターン（緑=高 / 赤=低, ◆=現在）`, 4, 14);

    const cellOf = (xl: string, yl: string) => result.cells.find((c) => c.xLabel === xl && c.yLabel === yl);
    result.yOrder.forEach((yl, yi) => {
      const y = topH + yi * cellH;
      ctx.fillStyle = "#4b5563"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(yl.length > 20 ? yl.slice(0, 19) + "…" : yl, labelW - 4, y + cellH / 2 + 3);
      result.xOrder.forEach((xl, xi) => {
        const x = labelW + xi * cellW;
        const c = cellOf(xl, yl);
        if (!c) {
          ctx.fillStyle = "#f3f4f6"; ctx.fillRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
          return;
        }
        const t = Math.min(1, Math.abs(c.meanFwd) / result.maxAbs);
        ctx.fillStyle = c.meanFwd >= 0 ? `rgba(22,163,74,${0.12 + t * 0.6})` : `rgba(220,38,38,${0.12 + t * 0.6})`;
        ctx.fillRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
        ctx.fillStyle = "#1f2937"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
        ctx.fillText(`${c.meanFwd >= 0 ? "+" : ""}${(c.meanFwd * 100).toFixed(1)}%`, x + cellW / 2, y + cellH / 2);
        ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif";
        ctx.fillText(`n=${c.n}`, x + cellW / 2, y + cellH / 2 + 11);
        if (xl === result.nowX && yl === result.nowY) {
          ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 2.5; ctx.strokeRect(x + 1.5, y + 1.5, cellW - 3, cellH - 3);
        }
      });
    });
    // x軸ラベル
    ctx.fillStyle = "#4b5563"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    result.xOrder.forEach((xl, xi) => {
      const x = labelW + xi * cellW + cellW / 2;
      ctx.fillText(xl.length > 12 ? xl.slice(0, 11) + "…" : xl, x, topH + ny * cellH + 14);
    });
  }, [result, horizon]);

  if (prices.length < 300) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">2変数コンディショニング・ヒートマップ（複合エッジ）</h3>

      <div className="flex flex-wrap gap-3 text-xs text-gray-600">
        <div className="flex items-center gap-1">
          <span>X軸:</span>
          {STATE_AXES.map((a) => (
            <button key={a.value} onClick={() => setAxisX(a.value)} className={`px-2 py-0.5 rounded ${axisX === a.value ? "bg-gray-800 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{a.label}</button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-gray-600">
        <div className="flex items-center gap-1">
          <span>Y軸:</span>
          {STATE_AXES.map((a) => (
            <button key={a.value} onClick={() => setAxisY(a.value)} className={`px-2 py-0.5 rounded ${axisY === a.value ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{a.label}</button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1 text-xs text-gray-600">
        <span>先行き N:</span>
        {HORIZONS.map((h) => (
          <button key={h} onClick={() => setHorizon(h)} className={`px-2 py-0.5 rounded ${horizon === h ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{h}日</button>
        ))}
      </div>

      <div className="relative"><canvas ref={canvasRef} /></div>
      {result && result.nowX && (
        <div className="text-xs text-blue-700">◆ 現在: {result.nowX} × {result.nowY}</div>
      )}

      <AnalysisGuide title="2変数コンディショニングの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"1つの状態（例: トレンド）だけでは平均化で消えてしまうエッジを、2つの状態の組み合わせ（例: トレンド×ボラ）で掘り起こす。各マスがその複合条件でのN日先平均リターン。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>各日をX軸状態とY軸状態の両方でバケット化し、(X,Y)の組ごとにN日先リターンを平均。</li>
          <li>色＝平均リターン（緑=高/赤=低）、n＝該当日数、◆＝今日が属するマス。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>濃い緑のマスでnが十分＝複合条件の強いエッジ。今日のマス（◆）がそこなら順張り根拠。</li>
          <li>「強トレンド×低ボラ」のような象限に偏ったエッジを発見できる。</li>
          <li>nが小さいマスは偶然の可能性。色だけでなく件数を必ず確認。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>2次元に割ると各マスの標本が減り、過剰解釈しやすい。</li>
          <li>多数のマスを見る＝多重比較。派手な1マスに飛びつかない。</li>
          <li>X=Y（同じ軸）にすると対角線しか埋まらない。異なる軸を選ぶ。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
