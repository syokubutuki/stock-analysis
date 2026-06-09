"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { analyzeStreaks, type StreakAnalysis } from "../../lib/crash-surge-streak";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const C_DOWN = "#ef4444"; // 暴落 Close
const C_DOWN_OPEN = "#f97316"; // 暴落 Open
const C_UP = "#10b981"; // 暴騰 Close
const C_UP_OPEN = "#0ea5e9"; // 暴騰 Open

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

function pct(v: number, d = 2): string {
  return (v * 100).toFixed(d) + "%";
}

export default function CrashSurgeStreakChart({ prices }: Props) {
  const [thresholdPct, setThresholdPct] = useState(3); // %
  const [horizon, setHorizon] = useState(20);

  const analysis = useMemo<StreakAnalysis | null>(
    () => analyzeStreaks(prices, thresholdPct / 100, horizon),
    [prices, thresholdPct, horizon]
  );

  const tsRef = useRef<HTMLCanvasElement>(null);
  const lenRef = useRef<HTMLCanvasElement>(null);
  const rateRef = useRef<HTMLCanvasElement>(null);
  const pathRef = useRef<HTMLCanvasElement>(null);
  const fwdRef = useRef<HTMLCanvasElement>(null);

  // ===== 1. 連続日数の時系列分布 =====
  useEffect(() => {
    if (!tsRef.current || !analysis) return;
    const H = 320;
    const init = initCanvas(tsRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 50, mr = 20, mt = 36, mb = 40;
    const plotW = width - ml - mr;
    const plotH = height - mt - mb;
    const midY = mt + plotH / 2;
    const n = prices.length;
    const maxLen = analysis.maxLength;
    const half = plotH / 2 - 6;

    const xOf = (idx: number) => ml + (plotW * idx) / Math.max(1, n - 1);
    const barW = Math.max(2, Math.min(8, plotW / Math.max(60, n) ));

    // grid (日数目盛り 上下対称)
    ctx.strokeStyle = "#eceff3";
    ctx.lineWidth = 0.5;
    ctx.font = "9px sans-serif";
    ctx.textAlign = "right";
    const steps = Math.min(maxLen, 5);
    for (let s = 1; s <= steps; s++) {
      const frac = s / steps;
      const len = Math.round(frac * maxLen);
      const yUp = midY - half * frac;
      const yDn = midY + half * frac;
      ctx.beginPath(); ctx.moveTo(ml, yUp); ctx.lineTo(width - mr, yUp); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ml, yDn); ctx.lineTo(width - mr, yDn); ctx.stroke();
      ctx.fillStyle = "#9ca3af";
      ctx.fillText(`${len}`, ml - 5, yUp + 3);
      ctx.fillText(`${len}`, ml - 5, yDn + 3);
    }
    // center line
    ctx.strokeStyle = "#cbd5e1"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ml, midY); ctx.lineTo(width - mr, midY); ctx.stroke();

    const maxAbsRate = Math.max(
      analysis.threshold,
      ...analysis.downRuns.map((r) => -r.cumReturn),
      ...analysis.upRuns.map((r) => r.cumReturn)
    );

    // 暴騰: 上向き
    for (const run of analysis.upRuns) {
      const x = xOf(run.endIndex);
      const h = (run.length / maxLen) * half;
      const alpha = 0.35 + 0.6 * Math.min(1, run.cumReturn / maxAbsRate);
      ctx.fillStyle = `rgba(16,185,129,${alpha.toFixed(3)})`;
      ctx.fillRect(x - barW / 2, midY - h, barW, h);
    }
    // 暴落: 下向き
    for (const run of analysis.downRuns) {
      const x = xOf(run.endIndex);
      const h = (run.length / maxLen) * half;
      const alpha = 0.35 + 0.6 * Math.min(1, -run.cumReturn / maxAbsRate);
      ctx.fillStyle = `rgba(239,68,68,${alpha.toFixed(3)})`;
      ctx.fillRect(x - barW / 2, midY, barW, h);
    }

    // date labels
    ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    const nLab = 6;
    for (let i = 0; i <= nLab; i++) {
      const idx = Math.round((n - 1) * (i / nLab));
      const t = prices[idx]?.time ?? "";
      ctx.fillText(t.slice(0, 7), xOf(idx), height - mb + 14);
    }

    // labels
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("① 連続日数の時系列分布（上=暴騰 / 下=暴落、棒の高さ=連続日数、濃さ=累積率）", ml, mt - 16);
    ctx.fillStyle = C_UP; ctx.font = "10px sans-serif";
    ctx.fillText("▲ 暴騰ラン", width - mr - 130, mt - 4);
    ctx.fillStyle = C_DOWN;
    ctx.fillText("▼ 暴落ラン", width - mr - 60, mt - 4);

    ctx.save();
    ctx.translate(13, midY); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "#9ca3af"; ctx.textAlign = "center"; ctx.font = "9px sans-serif";
    ctx.fillText("連続日数", 0, 0);
    ctx.restore();
  }, [analysis, prices]);

  // ===== 2. 連続日数ヒストグラム =====
  useEffect(() => {
    if (!lenRef.current || !analysis) return;
    const H = 300;
    const init = initCanvas(lenRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 50, mr = 20, mt = 36, mb = 44;
    const plotW = width - ml - mr;
    const plotH = height - mt - mb;
    const bins = analysis.downLenHist.length;
    if (bins === 0) return;
    const maxCount = Math.max(1, ...analysis.downLenHist.map((b) => b.count), ...analysis.upLenHist.map((b) => b.count));
    const groupW = plotW / bins;
    const barW = Math.max(2, (groupW - 4) / 2);

    // grid
    ctx.strokeStyle = "#eceff3"; ctx.lineWidth = 0.5; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const y = mt + (plotH * i) / 4;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      ctx.fillStyle = "#9ca3af";
      ctx.fillText(`${Math.round(maxCount * (4 - i) / 4)}`, ml - 5, y + 3);
    }

    for (let i = 0; i < bins; i++) {
      const gx = ml + groupW * i;
      const dh = (analysis.downLenHist[i].count / maxCount) * plotH;
      const uh = (analysis.upLenHist[i].count / maxCount) * plotH;
      ctx.fillStyle = C_DOWN;
      ctx.fillRect(gx + groupW / 2 - barW - 1, mt + plotH - dh, barW, dh);
      ctx.fillStyle = C_UP;
      ctx.fillRect(gx + groupW / 2 + 1, mt + plotH - uh, barW, uh);
      // x label
      ctx.fillStyle = "#6b7280"; ctx.textAlign = "center"; ctx.font = "9px sans-serif";
      if (bins <= 16 || i % 2 === 0) ctx.fillText(`${analysis.downLenHist[i].length}`, gx + groupW / 2, height - mb + 14);
    }

    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("② 連続日数のヒストグラム（赤=暴落 / 緑=暴騰）", ml, mt - 16);
    ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("連続日数（日）", ml + plotW / 2, height - mb + 32);
    ctx.save(); ctx.translate(13, mt + plotH / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.fillText("発生回数", 0, 0); ctx.restore();
  }, [analysis]);

  // ===== 3. 暴落率・暴騰率の分布 =====
  useEffect(() => {
    if (!rateRef.current || !analysis) return;
    const H = 300;
    const init = initCanvas(rateRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 50, mr = 20, mt = 36, mb = 44;
    const plotW = width - ml - mr;
    const plotH = height - mt - mb;
    const rb = analysis.rateBins;
    if (rb.length === 0) return;
    const maxCount = Math.max(1, ...rb.map((b) => Math.max(b.downCount, b.upCount)));
    const lo = rb[0].low, hi = rb[rb.length - 1].high;
    const xOf = (v: number) => ml + (plotW * (v - lo)) / (hi - lo);
    const binPx = plotW / rb.length;

    // grid
    ctx.strokeStyle = "#eceff3"; ctx.lineWidth = 0.5; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const y = mt + (plotH * i) / 4;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      ctx.fillStyle = "#9ca3af"; ctx.fillText(`${Math.round(maxCount * (4 - i) / 4)}`, ml - 5, y + 3);
    }

    for (const b of rb) {
      const x = xOf(b.low);
      if (b.downCount > 0) {
        const h = (b.downCount / maxCount) * plotH;
        ctx.fillStyle = "rgba(239,68,68,0.7)";
        ctx.fillRect(x, mt + plotH - h, Math.max(1, binPx - 1), h);
      }
      if (b.upCount > 0) {
        const h = (b.upCount / maxCount) * plotH;
        ctx.fillStyle = "rgba(16,185,129,0.7)";
        ctx.fillRect(x, mt + plotH - h, Math.max(1, binPx - 1), h);
      }
    }

    // zero line
    const zx = xOf(0);
    ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(zx, mt); ctx.lineTo(zx, mt + plotH); ctx.stroke(); ctx.setLineDash([]);

    // x labels (%)
    ctx.fillStyle = "#6b7280"; ctx.textAlign = "center"; ctx.font = "9px sans-serif";
    for (let i = 0; i <= 6; i++) {
      const v = lo + ((hi - lo) * i) / 6;
      ctx.fillText(`${(v * 100).toFixed(0)}%`, xOf(v), height - mb + 14);
    }

    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("③ ラン累積率の分布（左=暴落率 / 右=暴騰率）", ml, mt - 16);
    ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("ラン累積リターン", ml + plotW / 2, height - mb + 32);
    ctx.save(); ctx.translate(13, mt + plotH / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.fillText("発生回数", 0, 0); ctx.restore();
  }, [analysis]);

  // ===== 4. ラン進行に伴う累積率の平均推移 =====
  useEffect(() => {
    if (!pathRef.current || !analysis) return;
    const H = 320;
    const init = initCanvas(pathRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 56, mr = 20, mt = 36, mb = 44;
    const plotW = width - ml - mr;
    const plotH = height - mt - mb;
    const dn = analysis.downPath, up = analysis.upPath;
    const maxDay = Math.max(1, analysis.maxLength);
    const allVals = [...dn.map((p) => p.meanCum), ...up.map((p) => p.meanCum)];
    if (allVals.length === 0) return;
    const vmax = Math.max(0.001, ...allVals.map(Math.abs));
    const xOf = (d: number) => ml + (plotW * (d - 1)) / Math.max(1, maxDay - 1);
    const yOf = (v: number) => mt + plotH / 2 - (v / vmax) * (plotH / 2 - 8);

    // grid + y labels
    ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const v = vmax - (2 * vmax * i) / 4;
      const y = yOf(v);
      ctx.strokeStyle = i === 2 ? "#cbd5e1" : "#eceff3"; ctx.lineWidth = i === 2 ? 1 : 0.5;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      ctx.fillStyle = "#9ca3af"; ctx.fillText(pct(v, 1), ml - 5, y + 3);
    }

    const drawPath = (pts: typeof dn, color: string) => {
      if (pts.length === 0) return;
      ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.beginPath();
      pts.forEach((p, i) => {
        const x = xOf(p.day), y = yOf(p.meanCum);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      pts.forEach((p) => {
        ctx.beginPath(); ctx.arc(xOf(p.day), yOf(p.meanCum), 3, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
      });
    };
    drawPath(up, C_UP);
    drawPath(dn, C_DOWN);

    // x labels
    ctx.fillStyle = "#6b7280"; ctx.textAlign = "center"; ctx.font = "9px sans-serif";
    for (let d = 1; d <= maxDay; d++) {
      if (maxDay <= 14 || d % 2 === 1) ctx.fillText(`${d}`, xOf(d), height - mb + 14);
    }

    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("④ ラン進行に伴う累積率の平均推移（連続n日目までの平均累積リターン）", ml, mt - 16);
    ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("ラン内の経過日数（日目）", ml + plotW / 2, height - mb + 32);
    ctx.save(); ctx.translate(14, mt + plotH / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.fillText("平均累積リターン", 0, 0); ctx.restore();
  }, [analysis]);

  // ===== 5. ラン終了後 N 日の値動き（Close/Open 併記・同一プロット） =====
  useEffect(() => {
    if (!fwdRef.current || !analysis) return;
    const H = 440;
    const init = initCanvas(fwdRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 60, mr = 20, mt = 40, mb = 48;
    const plotW = width - ml - mr;
    const plotH = height - mt - mb;
    const df = analysis.downForward, uf = analysis.upForward;
    const N = analysis.horizon;

    // y range: mean ± std を含める
    const ys: number[] = [];
    for (const p of df) { ys.push(p.closeMean + p.closeStd, p.closeMean - p.closeStd, p.openMean); }
    for (const p of uf) { ys.push(p.closeMean + p.closeStd, p.closeMean - p.closeStd, p.openMean); }
    const ymax = Math.max(0.01, ...ys);
    const ymin = Math.min(-0.01, ...ys);
    const pad = (ymax - ymin) * 0.08;
    const yLo = ymin - pad, yHi = ymax + pad;
    const xOf = (d: number) => ml + (plotW * d) / Math.max(1, N);
    const yOf = (v: number) => mt + plotH - ((v - yLo) / (yHi - yLo)) * plotH;

    // grid + y labels
    ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 5; i++) {
      const v = yHi - ((yHi - yLo) * i) / 5;
      const y = yOf(v);
      ctx.strokeStyle = "#eceff3"; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      ctx.fillStyle = "#9ca3af"; ctx.fillText(pct(v, 1), ml - 5, y + 3);
    }
    // zero line
    const zy = yOf(0);
    ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(ml, zy); ctx.lineTo(width - mr, zy); ctx.stroke(); ctx.setLineDash([]);

    // σ band (Closeのみ)
    const drawBand = (pts: typeof df, rgba: string) => {
      ctx.fillStyle = rgba; ctx.beginPath();
      pts.forEach((p, i) => { const x = xOf(p.day), y = yOf(p.closeMean + p.closeStd); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; ctx.lineTo(xOf(p.day), yOf(p.closeMean - p.closeStd)); }
      ctx.closePath(); ctx.fill();
    };
    drawBand(df, "rgba(239,68,68,0.08)");
    drawBand(uf, "rgba(16,185,129,0.08)");

    // line helper
    const drawLine = (pts: typeof df, key: "closeMean" | "openMean", color: string, dash: boolean, startDay: number) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.setLineDash(dash ? [6, 4] : []);
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        if (p.day < startDay) continue;
        const x = xOf(p.day), y = yOf(p[key]);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    };
    drawLine(df, "closeMean", C_DOWN, false, 0);
    drawLine(df, "openMean", C_DOWN_OPEN, true, 1);
    drawLine(uf, "closeMean", C_UP, false, 0);
    drawLine(uf, "openMean", C_UP_OPEN, true, 1);

    // x labels
    ctx.fillStyle = "#6b7280"; ctx.textAlign = "center"; ctx.font = "9px sans-serif";
    const xstep = N <= 20 ? 2 : Math.ceil(N / 12);
    for (let d = 0; d <= N; d += xstep) ctx.fillText(`${d}`, xOf(d), height - mb + 14);

    // title + legend
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("⑤ ラン終了後N日の平均値動き（同一時間軸・同一スケール）", ml, mt - 20);
    ctx.font = "10px sans-serif"; ctx.textAlign = "left";
    const legY = mt - 5; let lx = ml;
    const legend = (color: string, dash: boolean, label: string) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.setLineDash(dash ? [6, 4] : []);
      ctx.beginPath(); ctx.moveTo(lx, legY); ctx.lineTo(lx + 18, legY); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#374151"; ctx.fillText(label, lx + 22, legY + 3);
      lx += 26 + ctx.measureText(label).width + 12;
    };
    legend(C_DOWN, false, "暴落後Close");
    legend(C_DOWN_OPEN, true, "暴落後Open");
    legend(C_UP, false, "暴騰後Close");
    legend(C_UP_OPEN, true, "暴騰後Open");

    ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("ラン終了日からの経過営業日数", ml + plotW / 2, height - mb + 32);
    ctx.save(); ctx.translate(15, mt + plotH / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.fillText("平均累積リターン", 0, 0); ctx.restore();
  }, [analysis]);

  if (prices.length < 30) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="font-bold text-gray-800">連続暴落・暴騰ラン分析</h3>
        <p className="text-sm text-gray-500 mt-2">データが不足しています（30日以上必要）。</p>
      </div>
    );
  }

  // 後続値動きサマリの抽出ポイント
  const horizons = [1, 5, 10, Math.min(20, horizon), horizon].filter(
    (v, i, a) => v <= horizon && a.indexOf(v) === i
  );
  const fwdAt = (dir: "down" | "up", d: number) =>
    (dir === "down" ? analysis?.downForward : analysis?.upForward)?.find((p) => p.day === d);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-5">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">連続暴落・暴騰ラン分析</h3>
        {analysis && (
          <span className="text-xs text-gray-500">
            暴落ラン {analysis.downRuns.length}件（全{analysis.allDownCount}件中） /
            暴騰ラン {analysis.upRuns.length}件（全{analysis.allUpCount}件中）
          </span>
        )}
      </div>

      {/* コントロール */}
      <div className="flex flex-wrap gap-6 items-center bg-gray-50 rounded p-3">
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <span className="font-medium">暴落/暴騰の閾値（累積率）</span>
          <input
            type="range" min={0} max={10} step={0.5}
            value={thresholdPct}
            onChange={(e) => setThresholdPct(parseFloat(e.target.value))}
            className="w-40"
          />
          <span className="font-mono text-gray-800 w-12">±{thresholdPct.toFixed(1)}%</span>
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <span className="font-medium">後続日数 N</span>
          <input
            type="range" min={5} max={60} step={1}
            value={horizon}
            onChange={(e) => setHorizon(parseInt(e.target.value))}
            className="w-40"
          />
          <span className="font-mono text-gray-800 w-12">{horizon}日</span>
        </label>
      </div>

      {analysis && analysis.downRuns.length === 0 && analysis.upRuns.length === 0 && (
        <div className="text-sm text-gray-500 p-3 bg-amber-50 rounded">
          閾値 ±{thresholdPct.toFixed(1)}% を満たすランがありません。閾値を下げてください。
        </div>
      )}

      <div className="relative"><canvas ref={tsRef} /></div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="relative"><canvas ref={lenRef} /></div>
        <div className="relative"><canvas ref={rateRef} /></div>
      </div>

      <div className="relative"><canvas ref={pathRef} /></div>

      <div className="relative"><canvas ref={fwdRef} /></div>

      {/* 後続値動きサマリ表 */}
      {analysis && (analysis.downRuns.length > 0 || analysis.upRuns.length > 0) && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1 px-2 text-left text-gray-500">イベント / 経過日数</th>
                {horizons.map((d) => (
                  <th key={d} className="py-1 px-2 text-center text-gray-500">{d}日後</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 font-medium" style={{ color: C_DOWN }}>暴落後 平均(Close)</td>
                {horizons.map((d) => {
                  const f = fwdAt("down", d);
                  return <td key={d} className={`py-1 px-2 text-center font-mono ${(f?.closeMean ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>{f ? pct(f.closeMean) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 font-medium" style={{ color: C_DOWN_OPEN }}>暴落後 平均(Open)</td>
                {horizons.map((d) => {
                  const f = fwdAt("down", d);
                  return <td key={d} className={`py-1 px-2 text-center font-mono ${(f?.openMean ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>{f && d >= 1 ? pct(f.openMean) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-500">暴落後 勝率(Close)</td>
                {horizons.map((d) => {
                  const f = fwdAt("down", d);
                  return <td key={d} className="py-1 px-2 text-center font-mono text-gray-600">{f ? (f.closeWin * 100).toFixed(0) + "%" : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 font-medium" style={{ color: C_UP }}>暴騰後 平均(Close)</td>
                {horizons.map((d) => {
                  const f = fwdAt("up", d);
                  return <td key={d} className={`py-1 px-2 text-center font-mono ${(f?.closeMean ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>{f ? pct(f.closeMean) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 font-medium" style={{ color: C_UP_OPEN }}>暴騰後 平均(Open)</td>
                {horizons.map((d) => {
                  const f = fwdAt("up", d);
                  return <td key={d} className={`py-1 px-2 text-center font-mono ${(f?.openMean ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>{f && d >= 1 ? pct(f.openMean) : "-"}</td>;
                })}
              </tr>
              <tr>
                <td className="py-1 px-2 text-gray-500">暴騰後 勝率(Close)</td>
                {horizons.map((d) => {
                  const f = fwdAt("up", d);
                  return <td key={d} className="py-1 px-2 text-center font-mono text-gray-600">{f ? (f.closeWin * 100).toFixed(0) + "%" : "-"}</td>;
                })}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* サマリ判定 */}
      {analysis && (analysis.downRuns.length > 0 || analysis.upRuns.length > 0) && (
        <div className="p-3 bg-blue-50 rounded text-xs text-gray-700 space-y-1">
          <div className="font-medium text-blue-800">傾向の要約</div>
          <p>
            暴落ランは平均 <strong>{analysis.downMeanLen.toFixed(1)}日</strong>連続・平均累積 {pct(analysis.downMeanRate)}（最大 {pct(analysis.downMaxRate)}）。
            暴騰ランは平均 <strong>{analysis.upMeanLen.toFixed(1)}日</strong>連続・平均累積 {pct(analysis.upMeanRate)}（最大 {pct(analysis.upMaxRate)}）。
          </p>
          {(() => {
            const dc = fwdAt("down", Math.min(5, horizon))?.closeMean ?? 0;
            const uc = fwdAt("up", Math.min(5, horizon))?.closeMean ?? 0;
            return (
              <p>
                暴落後{Math.min(5, horizon)}日のCloseベース平均は {pct(dc)} → {dc > 0 ? "反発（押し目買い）傾向" : "下落継続傾向"}。
                暴騰後{Math.min(5, horizon)}日は {pct(uc)} → {uc > 0 ? "上昇継続（モメンタム）傾向" : "反落（利益確定）傾向"}。
              </p>
            );
          })()}
          <p className="text-gray-500">
            ⑤のCloseとOpenの乖離は寄り付きギャップの影響を示します（Closeで仕掛けるか翌寄りで仕掛けるかの差）。
          </p>
        </div>
      )}

      <AnalysisGuide title="連続暴落・暴騰ラン分析の詳細理論">
        <p className="font-medium text-gray-700">1. 何を分析しているか</p>
        <p>
          株価が前日終値比で連続して下落（または上昇）する区間を1つの「ラン」として扱い、
          その<strong>連続日数</strong>・<strong>累積変動率</strong>・<strong>その後の値動き</strong>の傾向を可視化します。
          「暴落のあとに反発しやすいのか、さらに下げるのか」「暴騰は続くのか息切れするのか」という、
          連続的な急変動の後の挙動（短期リバーサル vs モメンタム）を統計的に把握するのが目的です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 用語とラン抽出</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>日次リターン</strong> r_t = close_t / close_(t-1) − 1。</li>
          <li><strong>下落ラン</strong>: r_t &lt; 0 が連続する最大区間。<strong>上昇ラン</strong>: r_t &gt; 0 が連続する最大区間。</li>
          <li><strong>連続日数（ラン長）</strong>: その区間に含まれる営業日数。</li>
          <li><strong>累積率（暴落率/暴騰率）</strong>: ラン直前の終値 close_(start−1) からラン終了日終値までの累積リターン<br />
            {"cumReturn = close_end / close_(start-1) − 1"}</li>
          <li><strong>閾値</strong>: |累積率| ≥ 閾値 のランだけを「暴落／暴騰」イベントとして全グラフで採用します（スライダーで調整）。閾値0%なら全ランが対象。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 各グラフの読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>① 時系列分布</strong>: 横軸=日付（共通時間軸）。上向き棒=暴騰ラン、下向き棒=暴落ランで、棒の高さが連続日数、色の濃さが累積率の大きさ。棒が密集する時期＝急変動クラスター（暴落・暴騰が集中する局面）。</li>
          <li><strong>② 連続日数ヒストグラム</strong>: ラン長の発生頻度。通常は1〜2日が大半で、右肩下がり（指数的減衰）。裾が厚い（長い連続が多い）ほどトレンドが粘る銘柄。</li>
          <li><strong>③ 累積率の分布</strong>: 0を中心に左が暴落率、右が暴騰率。左右の裾の広がりで「下落の急峻さ vs 上昇の急峻さ」の非対称性が分かる（株は一般に下落側の裾が重い）。</li>
          <li><strong>④ 累積率の平均推移</strong>: 横軸=ラン内の経過日数。連続n日目まで到達したランの平均累積率。1日あたりどれだけ加速/減速して下げ（上げ）続けるか。傾きが急なら「連続で大きく動く」性質。</li>
          <li><strong>⑤ ラン終了後N日の値動き</strong>: 横軸=ラン終了日からの経過営業日数（共通時間軸・共通スケール）。暴落後・暴騰後それぞれをCloseベース（終了日終値起点）とOpenベース（翌営業日始値起点）で重ね描き。薄い帯は±1標準偏差。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 後続値動きの計算式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>Closeベース</strong>（ラン終了日の引けで仕掛けた場合）: 経過日数 d に対し<br />{"R_close(d) = close_(e+d) / close_e − 1   （e=ラン終了日, d=0..N）"}</li>
          <li><strong>Openベース</strong>（翌営業日の寄り付きで仕掛けた場合）: <br />{"R_open(d) = open_(e+d) / open_(e+1) − 1   （d=1..N）"}</li>
          <li>全イベントについて各 d の平均・中央値・勝率・標準偏差を集計。Close と Open の差は寄り付きギャップ（オーバーナイトの飛び）の効果を表します。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>⑤で暴落後Closeが右肩上がり → 短期リバーサル（押し目買い）が機能。どの経過日で反発が最大化するかでエグジット日数を設計。</li>
          <li>暴落後でもマイナスが続く → ナンピンは危険、下落継続（トレンドフォロー側）が有利。</li>
          <li>暴騰後Closeがプラス継続 → モメンタムの順張り余地。マイナスなら高値掴み・利益確定が定石。</li>
          <li>CloseとOpenの乖離が大きい → 寄り付きで大きくギャップする銘柄。引け仕掛けと寄り仕掛けで成績が変わるため執行タイミングを使い分ける。</li>
          <li>②④で長い連続が多く傾きが急 → 連続急変動の「滝」が起きやすい。逆張りのタイミングを遅らせる根拠になる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>サンプル数が少ない（特に高い閾値や長い連続日数）と平均値の信頼性は低下します。件数表示とσ帯の広さを必ず確認してください。</li>
          <li>後続リターンは起点の異なるイベントを重ね合わせた平均であり、個別の値動きの分散は大きい（σ帯が広い＝ばらつき大）。</li>
          <li>取引コスト・スリッページ・配当・流動性は考慮していません。短期ほどコストの影響が大きくなります。</li>
          <li>過去の傾向は市場レジーム（低ボラ/高ボラ局面）に依存し、将来の再現を保証しません。</li>
          <li>連続性は「前日終値比」で定義しているため、寄り付きギャップで日中は上げても前日終値割れなら下落ランに含まれます。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
