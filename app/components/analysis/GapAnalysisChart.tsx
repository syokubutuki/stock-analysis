"use client";

import { useEffect, useRef, useMemo, useCallback } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeGapSeries,
  computeGapStats,
  computeCumulativeReturns,
  type GapPoint,
} from "../../lib/gap-analysis";
import { setInitialVisibleRange } from "../../lib/chart-visible-range";
import type { PeriodKey } from "../../hooks/useAnalysisData";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

// --- helpers ---
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
function winRate(a: number[]): number { return a.length ? a.filter(v => v > 0).length / a.length : 0; }
function corr(x: number[], y: number[]): number {
  const n = x.length; if (n < 2) return 0;
  const mx = mean(x), my = mean(y);
  let cv = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { cv += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
  const d = Math.sqrt(sx * sy);
  return d > 1e-10 ? cv / d : 0;
}
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function pctFmt(v: number, d = 4): string { return (v * 100).toFixed(d) + "%"; }
function colorClass(v: number): string { return v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500"; }

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

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const DOW_TRADING = [1, 2, 3, 4, 5];

export default function GapAnalysisChart({ prices, period }: Props) {
  const gapChartRef = useRef<HTMLDivElement>(null);
  const cumChartRef = useRef<HTMLDivElement>(null);
  const gapApiRef = useRef<IChartApi | null>(null);
  const cumApiRef = useRef<IChartApi | null>(null);
  const gapDistRef = useRef<HTMLCanvasElement>(null);
  const quadCumulRef = useRef<HTMLCanvasElement>(null);
  const rollingRef = useRef<HTMLCanvasElement>(null);

  const gaps = useMemo(() => computeGapSeries(prices), [prices]);
  const stats = useMemo(() => computeGapStats(prices, gaps), [prices, gaps]);
  const cumReturns = useMemo(() => computeCumulativeReturns(gaps), [gaps]);

  // --- 1. Gap size conditional analysis ---
  const gapSizeAnalysis = useMemo(() => {
    if (gaps.length < 10) return null;
    const absGaps = gaps.map(g => Math.abs(g.overnightReturn));
    const sorted = [...absGaps].sort((a, b) => a - b);
    const p33 = quantile(sorted, 0.33);
    const p66 = quantile(sorted, 0.66);

    const classify = (g: GapPoint) => {
      const abs = Math.abs(g.overnightReturn);
      return abs <= p33 ? "small" : abs <= p66 ? "medium" : "large";
    };

    const buckets: Record<string, { intraday: number[]; gapUp: number; gapDown: number; filled: number; total: number }> = {
      small: { intraday: [], gapUp: 0, gapDown: 0, filled: 0, total: 0 },
      medium: { intraday: [], gapUp: 0, gapDown: 0, filled: 0, total: 0 },
      large: { intraday: [], gapUp: 0, gapDown: 0, filled: 0, total: 0 },
    };

    for (let i = 0; i < gaps.length; i++) {
      const g = gaps[i];
      const cat = classify(g);
      const b = buckets[cat];
      b.intraday.push(g.intradayReturn);
      b.total++;
      if (g.overnightReturn > 0) b.gapUp++; else b.gapDown++;
      // Check fill
      const p = prices[i + 1]; // gaps[i] corresponds to prices[i+1]
      const prevClose = prices[i].close;
      if (p && g.overnightReturn > 0 && p.low <= prevClose) b.filled++;
      if (p && g.overnightReturn < 0 && p.high >= prevClose) b.filled++;
    }

    const labels = ["small", "medium", "large"] as const;
    const labelJP = { small: `小 (≤${(p33 * 100).toFixed(2)}%)`, medium: `中 (≤${(p66 * 100).toFixed(2)}%)`, large: `大 (>${(p66 * 100).toFixed(2)}%)` };
    return labels.map(k => {
      const b = buckets[k];
      const reversalCount = b.intraday.filter((r, idx) => {
        // Find original gap direction
        const origIdx = gaps.findIndex((g, gi) => classify(g) === k && b.intraday.indexOf(r) === idx);
        return false; // Simplified below
      }).length;

      // Reversal: gap and intraday in opposite directions
      let revCount = 0;
      let gapIdx = 0;
      for (const g of gaps) {
        if (classify(g) !== k) continue;
        if ((g.overnightReturn > 0 && g.intradayReturn < 0) || (g.overnightReturn < 0 && g.intradayReturn > 0)) revCount++;
        gapIdx++;
      }

      return {
        label: labelJP[k],
        n: b.total,
        intradayMean: mean(b.intraday),
        intradayWinRate: winRate(b.intraday),
        fillRate: b.total > 0 ? b.filled / b.total : 0,
        reversalRate: b.total > 0 ? revCount / b.total : 0,
      };
    });
  }, [gaps, prices]);

  // --- 2. Quadrant cumulative returns ---
  const quadrantCumul = useMemo(() => {
    const series: Record<string, { idx: number; cumRet: number }[]> = {
      "GU→続伸": [], "GU→反転": [], "GD→続落": [], "GD→反転": [],
    };
    const counters: Record<string, number> = { "GU→続伸": 0, "GU→反転": 0, "GD→続落": 0, "GD→反転": 0 };
    const cumRet: Record<string, number> = { "GU→続伸": 0, "GU→反転": 0, "GD→続落": 0, "GD→反転": 0 };

    for (const g of gaps) {
      let key: string;
      if (g.overnightReturn > 0 && g.intradayReturn > 0) key = "GU→続伸";
      else if (g.overnightReturn > 0 && g.intradayReturn <= 0) key = "GU→反転";
      else if (g.overnightReturn <= 0 && g.intradayReturn <= 0) key = "GD→続落";
      else key = "GD→反転";

      cumRet[key] += g.totalReturn;
      counters[key]++;
      series[key].push({ idx: counters[key], cumRet: cumRet[key] });
    }
    return series;
  }, [gaps]);

  // --- 3. Rolling contribution & correlation (60-day window) ---
  const rollingData = useMemo(() => {
    const window = 60;
    if (gaps.length < window) return [];
    const result: { time: string; contribution: number; correlation: number }[] = [];
    for (let i = window - 1; i < gaps.length; i++) {
      const slice = gaps.slice(i - window + 1, i + 1);
      const ov = slice.map(g => g.overnightReturn);
      const id = slice.map(g => g.intradayReturn);
      const tot = slice.map(g => g.totalReturn);
      const cumOv = ov.reduce((a, b) => a + b, 0);
      const cumTot = tot.reduce((a, b) => a + b, 0);
      const contrib = Math.abs(cumTot) > 1e-10 ? cumOv / cumTot : 0;
      const c = corr(ov, id);
      result.push({ time: gaps[i].time, contribution: contrib, correlation: c });
    }
    return result;
  }, [gaps]);

  // --- 4. Previous day intraday → next overnight ---
  const chainAnalysis = useMemo(() => {
    if (gaps.length < 10) return null;
    const absIntraday = gaps.map(g => Math.abs(g.intradayReturn));
    const sorted = [...absIntraday].sort((a, b) => a - b);
    const p50 = quantile(sorted, 0.5);

    const buckets = {
      bigUp: { overnight: [] as number[], n: 0 },
      bigDown: { overnight: [] as number[], n: 0 },
      smallUp: { overnight: [] as number[], n: 0 },
      smallDown: { overnight: [] as number[], n: 0 },
    };

    for (let i = 0; i < gaps.length - 1; i++) {
      const today = gaps[i];
      const tomorrow = gaps[i + 1];
      const isBig = Math.abs(today.intradayReturn) > p50;
      if (today.intradayReturn > 0) {
        const key = isBig ? "bigUp" : "smallUp";
        buckets[key].overnight.push(tomorrow.overnightReturn);
        buckets[key].n++;
      } else {
        const key = isBig ? "bigDown" : "smallDown";
        buckets[key].overnight.push(tomorrow.overnightReturn);
        buckets[key].n++;
      }
    }

    return {
      threshold: p50,
      bigUp: { n: buckets.bigUp.n, mean: mean(buckets.bigUp.overnight), winRate: winRate(buckets.bigUp.overnight) },
      bigDown: { n: buckets.bigDown.n, mean: mean(buckets.bigDown.overnight), winRate: winRate(buckets.bigDown.overnight) },
      smallUp: { n: buckets.smallUp.n, mean: mean(buckets.smallUp.overnight), winRate: winRate(buckets.smallUp.overnight) },
      smallDown: { n: buckets.smallDown.n, mean: mean(buckets.smallDown.overnight), winRate: winRate(buckets.smallDown.overnight) },
    };
  }, [gaps]);

  // --- 5. Gap size distribution ---
  const gapDistData = useMemo(() => {
    if (gaps.length < 5) return null;
    const vals = gaps.map(g => g.overnightReturn * 100);
    const min = Math.min(...vals), max = Math.max(...vals);
    const bins = 30;
    const binW = (max - min) / bins;
    if (binW <= 0) return null;
    const hist: { center: number; count: number }[] = [];
    for (let i = 0; i < bins; i++) {
      const lo = min + i * binW, hi = lo + binW;
      const center = (lo + hi) / 2;
      const count = vals.filter(v => v >= lo && (i === bins - 1 ? v <= hi : v < hi)).length;
      hist.push({ center, count });
    }
    return hist;
  }, [gaps]);

  // --- 6. Weekday overnight/intraday decomposition ---
  const dowDecomp = useMemo(() => {
    const data: Record<number, { overnight: number[]; intraday: number[] }> = {};
    for (const dow of DOW_TRADING) data[dow] = { overnight: [], intraday: [] };
    for (const g of gaps) {
      const d = new Date(g.time).getDay();
      if (d in data) {
        data[d].overnight.push(g.overnightReturn);
        data[d].intraday.push(g.intradayReturn);
      }
    }
    return DOW_TRADING.map(dow => {
      const d = data[dow];
      if (d.overnight.length === 0) return null;
      return {
        dow,
        n: d.overnight.length,
        overnightMean: mean(d.overnight),
        intradayMean: mean(d.intraday),
        overnightWinRate: winRate(d.overnight),
        intradayWinRate: winRate(d.intraday),
        corr: corr(d.overnight, d.intraday),
      };
    });
  }, [gaps]);

  // === Draw functions ===

  const drawGapDist = useCallback((canvas: HTMLCanvasElement, data: { center: number; count: number }[]) => {
    const r = initCanvas(canvas, 180); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 15, bottom: 25, left: 45, right: 15 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    const maxCount = Math.max(...data.map(d => d.count), 1);
    const barW = Math.max(2, plotW / data.length - 1);

    // Y-axis
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const val = Math.round((maxCount * i) / 4);
      const y = pad.top + plotH * (1 - i / 4);
      ctx.fillText(String(val), pad.left - 5, y + 3);
      ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }

    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const x = pad.left + (i / data.length) * plotW;
      const barH = (d.count / maxCount) * plotH;
      ctx.fillStyle = d.center > 0 ? "rgba(59, 130, 246, 0.6)" : "rgba(239, 83, 80, 0.6)";
      ctx.fillRect(x, pad.top + plotH - barH, barW, barH);
    }

    // X-axis labels
    ctx.fillStyle = "#999"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(data.length / 6));
    for (let i = 0; i < data.length; i += step) {
      const x = pad.left + ((i + 0.5) / data.length) * plotW;
      ctx.fillText(data[i].center.toFixed(1) + "%", x, height - 8);
    }
  }, []);

  const QUAD_COLORS: Record<string, string> = {
    "GU→続伸": "#22c55e", "GU→反転": "#f97316", "GD→続落": "#ef4444", "GD→反転": "#3b82f6",
  };

  const drawQuadCumul = useCallback((canvas: HTMLCanvasElement, data: Record<string, { idx: number; cumRet: number }[]>) => {
    const r = initCanvas(canvas, 200); if (!r) return;
    const { ctx, width, height } = r;
    const keys = Object.keys(data);
    let allMin = 0, allMax = 0, allMaxIdx = 0;
    for (const k of keys) for (const pt of data[k]) { allMin = Math.min(allMin, pt.cumRet); allMax = Math.max(allMax, pt.cumRet); allMaxIdx = Math.max(allMaxIdx, pt.idx); }
    if (allMaxIdx === 0) return;
    const pad = { top: 15, bottom: 25, left: 50, right: 15 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    const range = allMax - allMin || 0.01;

    // Zero line
    const zeroY = pad.top + plotH * (1 - (0 - allMin) / range);
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(width - pad.right, zeroY); ctx.stroke();

    // Y-axis
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 5; i++) {
      const val = allMin + (range * i) / 5;
      const y = pad.top + plotH * (1 - i / 5);
      ctx.fillText((val * 100).toFixed(1) + "%", pad.left - 5, y + 3);
      ctx.strokeStyle = "#f0f0f0"; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }

    for (const k of keys) {
      const pts = data[k]; if (pts.length < 2) continue;
      ctx.strokeStyle = QUAD_COLORS[k] || "#999"; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = pad.left + (pts[i].idx / allMaxIdx) * plotW;
        const y = pad.top + plotH * (1 - (pts[i].cumRet - allMin) / range);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Legend
    ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    let lx = pad.left;
    for (const k of keys) {
      if (!data[k] || data[k].length === 0) continue;
      ctx.fillStyle = QUAD_COLORS[k] || "#999"; ctx.fillRect(lx, height - 12, 12, 3);
      ctx.fillStyle = "#666"; ctx.fillText(k, lx + 15, height - 7);
      lx += ctx.measureText(k).width + 25;
    }
  }, []);

  const drawRolling = useCallback((canvas: HTMLCanvasElement, data: { time: string; contribution: number; correlation: number }[]) => {
    const r = initCanvas(canvas, 200); if (!r) return;
    const { ctx, width, height } = r;
    if (data.length < 2) return;
    const pad = { top: 15, bottom: 25, left: 50, right: 50 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    const n = data.length;

    // Contribution range (can be >1 or negative)
    let cMin = Infinity, cMax = -Infinity;
    for (const d of data) { cMin = Math.min(cMin, d.contribution); cMax = Math.max(cMax, d.contribution); }
    const cRange = cMax - cMin || 1;

    // Correlation range: -1 to 1
    const corrMin = -1, corrMax = 1;

    // Left Y-axis (contribution)
    ctx.fillStyle = "#3b82f6"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const val = cMin + (cRange * i) / 4;
      const y = pad.top + plotH * (1 - i / 4);
      ctx.fillText((val * 100).toFixed(0) + "%", pad.left - 5, y + 3);
      ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }

    // Right Y-axis (correlation)
    ctx.fillStyle = "#f59e0b"; ctx.textAlign = "left";
    for (let i = 0; i <= 4; i++) {
      const val = corrMin + (2 * i) / 4;
      const y = pad.top + plotH * (1 - (val - corrMin) / 2);
      ctx.fillText(val.toFixed(1), width - pad.right + 5, y + 3);
    }

    // Zero line for correlation
    const corrZeroY = pad.top + plotH * (1 - (0 - corrMin) / 2);
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.left, corrZeroY); ctx.lineTo(width - pad.right, corrZeroY); ctx.stroke();
    ctx.setLineDash([]);

    // Contribution line
    ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = pad.left + (i / (n - 1)) * plotW;
      const y = pad.top + plotH * (1 - (data[i].contribution - cMin) / cRange);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Correlation line
    ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = pad.left + (i / (n - 1)) * plotW;
      const y = pad.top + plotH * (1 - (data[i].correlation - corrMin) / 2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Legend
    ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    ctx.fillStyle = "#3b82f6"; ctx.fillRect(pad.left, height - 12, 12, 3);
    ctx.fillStyle = "#666"; ctx.fillText("夜間寄与率", pad.left + 15, height - 7);
    const lx2 = pad.left + 80;
    ctx.fillStyle = "#f59e0b"; ctx.fillRect(lx2, height - 12, 12, 3);
    ctx.fillStyle = "#666"; ctx.fillText("夜間↔日中相関", lx2 + 15, height - 7);
  }, []);

  // === Draw canvases ===
  useEffect(() => {
    if (gaps.length < 5) return;
    if (gapDistRef.current && gapDistData) drawGapDist(gapDistRef.current, gapDistData);
    if (quadCumulRef.current) drawQuadCumul(quadCumulRef.current, quadrantCumul);
    if (rollingRef.current && rollingData.length > 0) drawRolling(rollingRef.current, rollingData);
  }, [gaps, gapDistData, quadrantCumul, rollingData, drawGapDist, drawQuadCumul, drawRolling]);

  // ギャップヒストグラム (lightweight-charts)
  useEffect(() => {
    if (!gapChartRef.current || gaps.length < 2) return;
    if (gapApiRef.current) gapApiRef.current.remove();
    const chart = createChart(gapChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: gapChartRef.current.clientWidth, height: 200,
      rightPriceScale: { visible: true }, timeScale: { timeVisible: false },
    });
    gapApiRef.current = chart;
    const s = chart.addSeries(HistogramSeries, { priceScaleId: "right" });
    s.setData(gaps.map(g => ({ time: g.time as Time, value: g.overnightReturn * 100, color: g.overnightReturn >= 0 ? "rgba(59, 130, 246, 0.6)" : "rgba(239, 83, 80, 0.6)" })));
    if (period) setInitialVisibleRange(chart, prices, period); else chart.timeScale().fitContent();
    const h = () => { if (gapChartRef.current) chart.applyOptions({ width: gapChartRef.current.clientWidth }); };
    window.addEventListener("resize", h);
    return () => { window.removeEventListener("resize", h); chart.remove(); gapApiRef.current = null; };
  }, [gaps, prices, period]);

  // 累積リターン分解 (lightweight-charts)
  useEffect(() => {
    if (!cumChartRef.current || cumReturns.length < 2) return;
    if (cumApiRef.current) cumApiRef.current.remove();
    const chart = createChart(cumChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: cumChartRef.current.clientWidth, height: 220,
      rightPriceScale: { visible: true }, timeScale: { timeVisible: false },
    });
    cumApiRef.current = chart;
    chart.addSeries(LineSeries, { color: "#6b7280", lineWidth: 2 }).setData(cumReturns.map(c => ({ time: c.time as Time, value: c.total * 100 })));
    chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 2 }).setData(cumReturns.map(c => ({ time: c.time as Time, value: c.overnight * 100 })));
    chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 2 }).setData(cumReturns.map(c => ({ time: c.time as Time, value: c.intraday * 100 })));
    if (period) setInitialVisibleRange(chart, prices, period); else chart.timeScale().fitContent();
    const h = () => { if (cumChartRef.current) chart.applyOptions({ width: cumChartRef.current.clientWidth }); };
    window.addEventListener("resize", h);
    return () => { window.removeEventListener("resize", h); chart.remove(); cumApiRef.current = null; };
  }, [cumReturns, prices, period]);

  const pct4 = (v: number) => (v * 100).toFixed(4);
  const pct1 = (v: number) => (v * 100).toFixed(1);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-5">
      <h3 className="font-bold text-gray-800">ギャップ・日中/夜間リターン分解</h3>

      {/* 統計サマリー */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <StatBox label="夜間リターン (平均)" value={`${pct4(stats.overnightMean)}%`} sub={`σ: ${pct4(stats.overnightStd)}%`} />
        <StatBox label="日中リターン (平均)" value={`${pct4(stats.intradayMean)}%`} sub={`σ: ${pct4(stats.intradayStd)}%`} />
        <StatBox label="夜間寄与率" value={`${pct1(stats.overnightContribution)}%`} sub={`日中: ${pct1(stats.intradayContribution)}%`} highlight={Math.abs(stats.overnightContribution) > 0.6} />
        <StatBox label="夜間↔日中 相関" value={stats.correlation.toFixed(3)} sub={stats.correlation < -0.3 ? "逆相関 (ギャップ反転傾向)" : stats.correlation > 0.3 ? "正相関 (ギャップ継続傾向)" : "低相関"} highlight={Math.abs(stats.correlation) > 0.3} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <StatBox label="ギャップアップ" value={`${stats.gapUpCount}日`} sub={`${pct1(stats.gapUpCount / stats.count)}%`} />
        <StatBox label="ギャップダウン" value={`${stats.gapDownCount}日`} sub={`${pct1(stats.gapDownCount / stats.count)}%`} />
        <StatBox label="ギャップフィル率" value={`${pct1(stats.gapFillRate)}%`} sub="ギャップが当日中に埋まった割合" />
        <StatBox label="寄付き天井 / 底" value={`${pct1(stats.openHighRate)}% / ${pct1(stats.openLowRate)}%`} sub="open≈high / open≈low" />
      </div>

      {/* 夜間リターンヒストグラム */}
      <div>
        <div className="text-xs text-gray-500 mb-1">夜間リターン (open[t] vs close[t-1])</div>
        <div ref={gapChartRef} className="w-full rounded border border-gray-100" />
      </div>

      {/* 累積リターン分解 */}
      <div>
        <div className="text-xs text-gray-500 mb-1">
          累積リターン分解 (<span className="text-gray-500">全体</span> = <span className="text-blue-500">夜間</span> + <span className="text-amber-500">日中</span>)
        </div>
        <div ref={cumChartRef} className="w-full rounded border border-gray-100" />
      </div>

      {/* === NEW: 5. Gap size distribution === */}
      {gapDistData && (
        <div>
          <div className="text-xs text-gray-500 mb-1">ギャップサイズ分布 (夜間リターンのヒストグラム)</div>
          <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={gapDistRef} /></div>
        </div>
      )}

      {/* === NEW: 1. Gap size conditional analysis === */}
      {gapSizeAnalysis && (
        <div>
          <div className="text-xs text-gray-500 mb-1">ギャップサイズ別 条件付き分析</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="py-1 px-2 text-left text-gray-500 font-medium">ギャップサイズ</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">N</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">日中平均</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">日中勝率</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">フィル率</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">反転率</th>
                </tr>
              </thead>
              <tbody>
                {gapSizeAnalysis.map((row, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    <td className="py-1 px-2 text-gray-600 font-medium">{row.label}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{row.n}</td>
                    <td className={`py-1 px-2 text-center font-mono ${colorClass(row.intradayMean)}`}>{pctFmt(row.intradayMean)}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{pctFmt(row.intradayWinRate, 1)}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{pctFmt(row.fillRate, 1)}</td>
                    <td className={`py-1 px-2 text-center font-mono ${row.reversalRate > 0.5 ? "text-orange-600 font-medium" : "text-gray-600"}`}>{pctFmt(row.reversalRate, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* === NEW: 6. Weekday decomposition === */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日別 夜間/日中リターン分解</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1 px-2 text-left text-gray-500 font-medium"></th>
                {DOW_TRADING.map(d => <th key={d} className="py-1 px-2 text-center font-medium text-gray-700">{DOW_LABELS[d]}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-500">N</td>
                {dowDecomp.map((s, i) => <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{s?.n ?? 0}</td>)}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-500">夜間 平均</td>
                {dowDecomp.map((s, i) => <td key={i} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.overnightMean) : ""}`}>{s ? pctFmt(s.overnightMean) : "-"}</td>)}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-500">日中 平均</td>
                {dowDecomp.map((s, i) => <td key={i} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.intradayMean) : ""}`}>{s ? pctFmt(s.intradayMean) : "-"}</td>)}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-500">夜間 勝率</td>
                {dowDecomp.map((s, i) => <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{s ? pctFmt(s.overnightWinRate, 1) : "-"}</td>)}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-500">日中 勝率</td>
                {dowDecomp.map((s, i) => <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{s ? pctFmt(s.intradayWinRate, 1) : "-"}</td>)}
              </tr>
              <tr>
                <td className="py-1 px-2 text-gray-500">夜↔日中 相関</td>
                {dowDecomp.map((s, i) => <td key={i} className={`py-1 px-2 text-center font-mono ${s && Math.abs(s.corr) > 0.3 ? "text-blue-600 font-medium" : "text-gray-600"}`}>{s ? s.corr.toFixed(3) : "-"}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* === NEW: 4. Chain analysis === */}
      {chainAnalysis && (
        <div>
          <div className="text-xs text-gray-500 mb-1">前日日中リターン → 翌夜間リターンの連鎖 (閾値: |日中|&gt;{(chainAnalysis.threshold * 100).toFixed(2)}%)</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="py-1 px-2 text-left text-gray-500 font-medium">前日日中</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">N</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">翌夜間 平均</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">翌夜間 勝率</th>
                </tr>
              </thead>
              <tbody>
                {([
                  { label: "大幅上昇", data: chainAnalysis.bigUp },
                  { label: "小幅上昇", data: chainAnalysis.smallUp },
                  { label: "小幅下落", data: chainAnalysis.smallDown },
                  { label: "大幅下落", data: chainAnalysis.bigDown },
                ]).map(row => (
                  <tr key={row.label} className="border-b border-gray-100">
                    <td className="py-1 px-2 text-gray-600">{row.label}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{row.data.n}</td>
                    <td className={`py-1 px-2 text-center font-mono ${colorClass(row.data.mean)}`}>{pctFmt(row.data.mean)}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{pctFmt(row.data.winRate, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* === NEW: 2. Quadrant cumulative returns === */}
      <div>
        <div className="text-xs text-gray-500 mb-1">象限別 累積リターン (各パターンに投資した場合のパフォーマンス)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={quadCumulRef} /></div>
      </div>

      {/* === NEW: 3. Rolling contribution & correlation === */}
      {rollingData.length > 0 && (
        <div>
          <div className="text-xs text-gray-500 mb-1">ローリング夜間寄与率・相関 (60日窓)</div>
          <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={rollingRef} /></div>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className="p-2 bg-gray-50 rounded">
      <div className="text-gray-500">{label}</div>
      <div className={`font-mono font-medium ${highlight ? "text-blue-600" : ""}`}>{value}</div>
      {sub && <div className="text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}
