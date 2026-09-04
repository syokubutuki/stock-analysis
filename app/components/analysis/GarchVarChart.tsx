"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeGarchVar } from "../../lib/simulation";
import GuideEntryPanel from "./GuideEntryPanel";
import AccessibleCanvas from "./AccessibleCanvas";
import { CHART_COLORS } from "../../lib/chart-colors";

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

export default function GarchVarChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const result = useMemo(() => computeGarchVar(prices), [prices]);

  const chartDescription = useMemo(() => {
    if (result.dates.length === 0) return "GARCH VaRのバックテスト。計算できるデータが不足しています。";
    return `日次リターンにGARCHの95%・99%VaR予測線を重ね、突破した日を点で示した図（${result.dates.length}日）。95%VaRの突破は${result.violations95}回（期待${result.expectedViolations95.toFixed(1)}回、Kupiec p=${result.kupiecTest95.pValue.toFixed(3)}で${result.kupiecTest95.pass ? "合格" : "不合格"}）、99%は${result.violations99}回（期待${result.expectedViolations99.toFixed(1)}回、p=${result.kupiecTest99.pValue.toFixed(3)}）です。`;
  }, [result]);

  useEffect(() => {
    if (!canvasRef.current || result.dates.length === 0) return;
    const H = 350;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 50, mr = 20, mt = 30, mb = 30;
    const plotW = width - ml - mr, plotH = height - mt - mb;
    const n = result.returns.length;

    const allVals = [...result.returns, ...result.var95];
    const minV = Math.min(...allVals);
    const maxV = Math.max(...allVals);
    const rangeV = maxV - minV || 0.01;

    const xFrom = (i: number) => ml + (i / (n - 1)) * plotW;
    const yFrom = (v: number) => mt + plotH - ((v - minV) / rangeV) * plotH;

    // Returns as dots
    for (let i = 0; i < n; i++) {
      const x = xFrom(i), y = yFrom(result.returns[i]);
      const violated = result.returns[i] < result.var95[i];
      ctx.beginPath(); ctx.arc(x, y, violated ? 2.5 : 1, 0, Math.PI * 2);
      ctx.fillStyle = violated ? "#ef4444" : "rgba(148, 163, 184, 0.4)";
      ctx.fill();
    }

    // VaR95 line
    ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xFrom(i), y = yFrom(result.var95[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // VaR99 line
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xFrom(i), y = yFrom(result.var99[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]);

    // Zero line
    const y0 = yFrom(0);
    ctx.strokeStyle = "#374151"; ctx.lineWidth = 0.5; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(ml, y0); ctx.lineTo(width - mr, y0); ctx.stroke();
    ctx.setLineDash([]);

    // Grid
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = mt + (plotH * i) / 5;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      const val = maxV - (rangeV * i) / 5;
      ctx.fillStyle = CHART_COLORS.ink; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText((val * 100).toFixed(1) + "%", ml - 4, y + 3);
    }

    // Legend
    ctx.font = "10px sans-serif"; ctx.textAlign = "left";
    const lx = ml + 10;
    ctx.fillStyle = "rgba(148, 163, 184, 0.4)";
    ctx.beginPath(); ctx.arc(lx + 3, mt + 8, 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#374151"; ctx.fillText("リターン", lx + 10, mt + 12);
    ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(lx + 70, mt + 8); ctx.lineTo(lx + 88, mt + 8); ctx.stroke();
    ctx.fillText("95%損失限界", lx + 92, mt + 12);
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(lx + 160, mt + 8); ctx.lineTo(lx + 178, mt + 8); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText("99%損失限界", lx + 182, mt + 12);
    ctx.fillStyle = "#ef4444";
    ctx.beginPath(); ctx.arc(lx + 253, mt + 8, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#374151"; ctx.fillText("限界超過", lx + 260, mt + 12);

    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif";
    ctx.fillText("日次リターンと損失限界線 (VaR)", ml, mt - 10);
  }, [result]);

  if (result.dates.length === 0) return null;

  const n = result.returns.length;
  const violationRate95 = ((result.violations95 / n) * 100).toFixed(2);
  const violationRate99 = ((result.violations99 / n) * 100).toFixed(2);
  const pass95 = result.kupiecTest95.pass;
  const pass99 = result.kupiecTest99.pass;

  const bothPass = pass95 && pass99;
  const bothFail = !pass95 && !pass99;
  const summaryColor = bothPass ? "green" : bothFail ? "red" : "yellow";
  const summaryBg = summaryColor === "green" ? "bg-green-50 border-green-300" : summaryColor === "red" ? "bg-red-50 border-red-300" : "bg-yellow-50 border-yellow-300";
  const summaryIcon = summaryColor === "green" ? "text-green-700" : summaryColor === "red" ? "text-red-600" : "text-yellow-600";
  const summaryText = bothPass
    ? "このVaRモデルは過去のデータに対して適切に機能しています。損失限界線を超える回数が統計的に妥当な範囲内です。"
    : bothFail
      ? "VaRモデルが95%・99%の両水準で不適切です。実際の損失が限界線を超える頻度が想定と大きく乖離しており、リスクの見積もりを見直す必要があります。"
      : !pass95
        ? "95%水準のVaRモデルが不適切です。日常的なリスク見積もりが実態とずれている可能性があります。"
        : "99%水準のVaRモデルが不適切です。極端な損失（テールリスク）の見積もりが甘い可能性があります。";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div>
        <h3 className="font-bold text-gray-800">GARCH VaR予測 — リスク損失の限界線</h3>
        <p className="text-xs text-gray-500 mt-0.5">条件付き異分散モデルによるテールリスクの動的推定とバックテスト検証</p>
      </div>
      <div className="relative"><AccessibleCanvas ref={canvasRef} description={chartDescription} /></div>

      {/* 総合判定サマリー */}
      <div className={`p-3 rounded border ${summaryBg} flex items-start gap-2`}>
        <span className={`font-bold text-lg leading-none ${summaryIcon}`}>
          {summaryColor === "green" ? "OK" : summaryColor === "red" ? "NG" : "!"}
        </span>
        <div className="text-sm">
          <span className={`font-bold ${summaryIcon}`}>
            総合判定: {bothPass ? "合格" : bothFail ? "不合格" : "一部不合格"}
          </span>
          <p className="text-gray-600 mt-0.5">{summaryText}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="p-3 bg-amber-50 rounded border border-amber-200">
          <div className="font-medium text-amber-800 mb-1">95%損失限界のバックテスト</div>
          <div className="space-y-0.5">
            <div>違反率: <span className="font-mono font-bold">{violationRate95}%</span> <span className="text-gray-500">(期待: 5.00%)</span></div>
            <div>違反回数: <span className="font-mono">{result.violations95}回</span> / 期待 {result.expectedViolations95.toFixed(1)}回</div>
            <div className={pass95 ? "text-green-700 font-bold mt-1" : "text-red-600 font-bold mt-1"}>
              {pass95 ? "合格 — モデルは適切" : "不合格 — モデルは不適切"}
            </div>
            {!pass95 && (
              <div className="text-red-500 mt-0.5">
                {result.violations95 > result.expectedViolations95
                  ? "想定より損失超過が多く、リスクを過小評価しています"
                  : "想定より損失超過が少なく、リスクを過大評価（保守的すぎ）しています"}
              </div>
            )}
            <details className="mt-1">
              <summary className="text-gray-500 cursor-pointer">統計的詳細</summary>
              <div className="mt-1 text-gray-600">
                <div>Kupiec LR: <span className="font-mono">{result.kupiecTest95.statistic.toFixed(2)}</span></div>
                <div>p値: <span className="font-mono">{result.kupiecTest95.pValue.toFixed(3)}</span> <span className="text-fg-muted">(0.05以上で合格)</span></div>
              </div>
            </details>
          </div>
        </div>
        <div className="p-3 bg-red-50 rounded border border-red-200">
          <div className="font-medium text-red-800 mb-1">99%損失限界のバックテスト</div>
          <div className="space-y-0.5">
            <div>違反率: <span className="font-mono font-bold">{violationRate99}%</span> <span className="text-gray-500">(期待: 1.00%)</span></div>
            <div>違反回数: <span className="font-mono">{result.violations99}回</span> / 期待 {result.expectedViolations99.toFixed(1)}回</div>
            <div className={pass99 ? "text-green-700 font-bold mt-1" : "text-red-600 font-bold mt-1"}>
              {pass99 ? "合格 — モデルは適切" : "不合格 — テールリスクを過小評価の可能性"}
            </div>
            {!pass99 && (
              <div className="text-red-500 mt-0.5">
                {result.violations99 > result.expectedViolations99
                  ? "極端な損失が想定以上に頻発しています。正規分布では捉えきれないファットテールの存在を示唆します"
                  : "極端な損失が想定より少なく、リスク資本を過大に確保している可能性があります"}
              </div>
            )}
            <details className="mt-1">
              <summary className="text-gray-500 cursor-pointer">統計的詳細</summary>
              <div className="mt-1 text-gray-600">
                <div>Kupiec LR: <span className="font-mono">{result.kupiecTest99.statistic.toFixed(2)}</span></div>
                <div>p値: <span className="font-mono">{result.kupiecTest99.pValue.toFixed(3)}</span> <span className="text-fg-muted">(0.05以上で合格)</span></div>
              </div>
            </details>
          </div>
        </div>
      </div>

      {/* 解説本文は app/lib/analysis-guides.ts の唯一のソースから描く。
          ここに散文を書き戻すと /guide/garch-var と二重管理になる。 */}
      <GuideEntryPanel slug="garch-var" title="GARCH VaR予測の詳細解説" />
    </div>
  );
}
