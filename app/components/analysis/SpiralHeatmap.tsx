"use client";

import { useMemo, useCallback, useRef, useEffect } from "react";
import { PricePoint } from "../../lib/types";
import type { PeriodKey } from "../../hooks/useAnalysisData";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const DOW_TRADING = [1, 2, 3, 4, 5];
const MONTH_LABELS = [
  "1月","2月","3月","4月","5月","6月",
  "7月","8月","9月","10月","11月","12月",
];

interface DayData {
  date: string;
  dayOfWeek: number;
  month: number;
  year: number;
  dayOfMonth: number;
  weekOfMonth: number;
  tradingDayOfYear: number;
  closeReturn: number;
  intradayReturn: number;
  overnightReturn: number;
}

// --- stat helpers ---
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
function winRate(a: number[]): number { return a.length ? a.filter(v => v > 0).length / a.length : 0; }
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function pct(v: number): string { return (v * 100).toFixed(3) + "%"; }
function pct2(v: number): string { return (v * 100).toFixed(2) + "%"; }
function colorClass(v: number): string { return v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500"; }

// t-test
function tTestPValue(arr: number[]): number | null {
  const n = arr.length;
  if (n < 3) return null;
  const se = std(arr) / Math.sqrt(n);
  if (se === 0) return null;
  const t = mean(arr) / se;
  const df = n - 1, x = df / (df + t * t);
  return Math.min(incompleteBeta(df / 2, 0.5, x), 1);
}
function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const lnB = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnB) / a;
  let f = 1, c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d; f = d;
  for (let i = 1; i <= 200; i++) {
    let num = i * (b - i) * x / ((a + 2 * i - 1) * (a + 2 * i));
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30; f *= d * c;
    num = -(a + i) * (a + b + i) * x / ((a + 2 * i) * (a + 2 * i + 1));
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    const delta = d * c; f *= delta;
    if (Math.abs(delta - 1) < 1e-10) break;
  }
  return front * f;
}
function lnGamma(z: number): number {
  const c = [0.99999999999980993,676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1; let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function pValueLabel(p: number | null): { text: string; cls: string } {
  if (p === null) return { text: "-", cls: "text-gray-400" };
  const star = p < 0.01 ? "***" : p < 0.05 ? "**" : p < 0.1 ? "*" : "";
  return { text: p.toFixed(3) + star, cls: p < 0.05 ? "text-blue-600 font-medium" : "text-gray-500" };
}

// --- Canvas helpers ---
function initCanvas(canvas: HTMLCanvasElement, height: number): { ctx: CanvasRenderingContext2D; width: number; height: number } | null {
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

function returnColor(val: number, maxAbs: number): string {
  const t = Math.min(1, Math.abs(val) / (maxAbs || 0.001));
  if (val > 0) return `rgba(22, 163, 74, ${0.15 + 0.7 * t})`;
  if (val < 0) return `rgba(220, 38, 38, ${0.15 + 0.7 * t})`;
  return "#f3f4f6";
}

// ============================================================
export default function SpiralHeatmap({ prices, period }: Props) {
  // canvas refs
  const dowBarRef = useRef<HTMLCanvasElement>(null);
  const monthBarRef = useRef<HTMLCanvasElement>(null);
  const dowBoxRef = useRef<HTMLCanvasElement>(null);
  const crossHeatRef = useRef<HTMLCanvasElement>(null);
  const intraweekRef = useRef<HTMLCanvasElement>(null);
  const yearMonthRef = useRef<HTMLCanvasElement>(null);
  const womBarRef = useRef<HTMLCanvasElement>(null);
  const dowCumulRef = useRef<HTMLCanvasElement>(null);
  const monthCumulRef = useRef<HTMLCanvasElement>(null);
  const domBarRef = useRef<HTMLCanvasElement>(null);
  const seasonRef = useRef<HTMLCanvasElement>(null);

  // === core data ===
  const days: DayData[] = useMemo(() => {
    if (prices.length < 2) return [];
    const yc: Record<number, number> = {};
    return prices.slice(1).map((p, i) => {
      const prev = prices[i], d = new Date(p.time);
      const pc = prev.close || 1, op = p.open || pc;
      const y = d.getFullYear();
      yc[y] = (yc[y] || 0) + 1;
      return {
        date: p.time, dayOfWeek: d.getDay(), month: d.getMonth(), year: y,
        dayOfMonth: d.getDate(), weekOfMonth: Math.ceil(d.getDate() / 7),
        tradingDayOfYear: yc[y],
        closeReturn: (p.close - pc) / pc,
        intradayReturn: (p.close - op) / op,
        overnightReturn: (op - pc) / pc,
      };
    });
  }, [prices]);

  // === weekday raw returns (for box plot & grouped bar) ===
  const dowRaw = useMemo(() => {
    const r: Record<number, { close: number[]; intraday: number[]; overnight: number[] }> = {};
    for (const dow of DOW_TRADING) r[dow] = { close: [], intraday: [], overnight: [] };
    for (const d of days) {
      if (!(d.dayOfWeek in r)) continue;
      r[d.dayOfWeek].close.push(d.closeReturn);
      r[d.dayOfWeek].intraday.push(d.intradayReturn);
      r[d.dayOfWeek].overnight.push(d.overnightReturn);
    }
    return r;
  }, [days]);

  // === weekday computed stats ===
  const dowStats = useMemo(() =>
    DOW_TRADING.map(dow => {
      const c = dowRaw[dow]; if (!c || c.close.length === 0) return null;
      return {
        n: c.close.length,
        close: { mean: mean(c.close), median: median(c.close), std: std(c.close), winRate: winRate(c.close), pValue: tTestPValue(c.close) },
        intraday: { mean: mean(c.intraday), median: median(c.intraday), std: std(c.intraday), winRate: winRate(c.intraday) },
        overnight: { mean: mean(c.overnight), median: median(c.overnight), std: std(c.overnight), winRate: winRate(c.overnight) },
      };
    })
  , [dowRaw]);

  // === monthly raw returns ===
  const monthRaw = useMemo(() => {
    const r = Array.from({ length: 12 }, () => ({ close: [] as number[], intraday: [] as number[], overnight: [] as number[] }));
    for (const d of days) { r[d.month].close.push(d.closeReturn); r[d.month].intraday.push(d.intradayReturn); r[d.month].overnight.push(d.overnightReturn); }
    return r;
  }, [days]);

  const monthStats = useMemo(() =>
    monthRaw.map(s => {
      if (s.close.length === 0) return null;
      return {
        n: s.close.length,
        close: { mean: mean(s.close), std: std(s.close), winRate: winRate(s.close), pValue: tTestPValue(s.close) },
        intraday: { mean: mean(s.intraday), std: std(s.intraday), winRate: winRate(s.intraday) },
        overnight: { mean: mean(s.overnight), std: std(s.overnight), winRate: winRate(s.overnight) },
      };
    })
  , [monthRaw]);

  // === cross stats ===
  const crossStats = useMemo(() => {
    const grid: number[][][] = Array.from({ length: 7 }, () => Array.from({ length: 12 }, () => []));
    for (const d of days) grid[d.dayOfWeek][d.month].push(d.closeReturn);
    return grid.map(ms => ms.map(r => r.length === 0 ? null : { mean: mean(r), n: r.length }));
  }, [days]);

  // === cross stats maxAbs for heatmap ===
  const crossMaxAbs = useMemo(() => {
    let mx = 0;
    for (const dow of DOW_TRADING) for (let m = 0; m < 12; m++) { const c = crossStats[dow][m]; if (c) mx = Math.max(mx, Math.abs(c.mean)); }
    return mx;
  }, [crossStats]);

  // === streak ===
  const streakStats = useMemo(() => {
    if (days.length === 0) return null;
    let cu = 0, cd = 0, mu = 0, md = 0;
    const us: number[] = [], ds: number[] = [];
    for (const d of days) {
      if (d.closeReturn > 0) { cu++; if (cd > 0) { ds.push(cd); cd = 0; } }
      else if (d.closeReturn < 0) { cd++; if (cu > 0) { us.push(cu); cu = 0; } }
      else { if (cu > 0) us.push(cu); if (cd > 0) ds.push(cd); cu = 0; cd = 0; }
      mu = Math.max(mu, cu); md = Math.max(md, cd);
    }
    if (cu > 0) us.push(cu); if (cd > 0) ds.push(cd);
    const avg = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
    return { maxUp: mu, maxDown: md, avgUp: avg(us), avgDown: avg(ds), upCount: us.length, downCount: ds.length };
  }, [days]);

  // === day-of-month ===
  const domStats = useMemo(() => {
    const b: number[][] = Array.from({ length: 31 }, () => []);
    for (const d of days) b[d.dayOfMonth - 1].push(d.closeReturn);
    return b.map((a, i) => a.length < 2 ? null : { dom: i + 1, mean: mean(a), n: a.length });
  }, [days]);

  // === week-of-month ===
  const womStats = useMemo(() => {
    const b: number[][] = Array.from({ length: 5 }, () => []);
    for (const d of days) b[Math.min(d.weekOfMonth, 5) - 1].push(d.closeReturn);
    return b.map((a, i) => a.length < 2 ? null : { week: i + 1, mean: mean(a), std: std(a), n: a.length, winRate: winRate(a), pValue: tTestPValue(a) });
  }, [days]);

  // === seasonality ===
  const seasonality = useMemo(() => {
    const years = new Set(days.map(d => d.year));
    const ys: Record<number, number[]> = {};
    for (const y of years) ys[y] = [];
    for (const d of days) ys[d.year].push(d.closeReturn);
    const cy: Record<number, number[]> = {}; let maxLen = 0;
    for (const y of years) { let s = 0; cy[y] = ys[y].map(r => (s += r)); maxLen = Math.max(maxLen, cy[y].length); }
    const out: { day: number; avg: number }[] = [];
    for (let i = 0; i < maxLen; i++) { const v: number[] = []; for (const y of years) if (cy[y].length > i) v.push(cy[y][i]); if (v.length) out.push({ day: i + 1, avg: mean(v) }); }
    return out;
  }, [days]);

  // === conditional (prev day) ===
  const conditionalStats = useMemo(() => {
    if (days.length < 2) return null;
    const au: number[] = [], ad: number[] = [];
    for (let i = 1; i < days.length; i++) { if (days[i - 1].closeReturn > 0) au.push(days[i].closeReturn); else if (days[i - 1].closeReturn < 0) ad.push(days[i].closeReturn); }
    return {
      afterUp: { n: au.length, mean: mean(au), winRate: winRate(au), pValue: tTestPValue(au) },
      afterDown: { n: ad.length, mean: mean(ad), winRate: winRate(ad), pValue: tTestPValue(ad) },
    };
  }, [days]);

  // === cumulative by weekday ===
  const dowCumulative = useMemo(() => {
    const s: Record<number, { idx: number; cumRet: number }[]> = {}, ct: Record<number, number> = {}, cr: Record<number, number> = {};
    for (const dow of DOW_TRADING) { s[dow] = []; ct[dow] = 0; cr[dow] = 0; }
    for (const d of days) { if (!(d.dayOfWeek in s)) continue; cr[d.dayOfWeek] += d.closeReturn; ct[d.dayOfWeek]++; s[d.dayOfWeek].push({ idx: ct[d.dayOfWeek], cumRet: cr[d.dayOfWeek] }); }
    return s;
  }, [days]);

  // === cumulative by month ===
  const monthCumulative = useMemo(() => {
    const s: Record<number, { idx: number; cumRet: number }[]> = {}, ct: Record<number, number> = {}, cr: Record<number, number> = {};
    for (let m = 0; m < 12; m++) { s[m] = []; ct[m] = 0; cr[m] = 0; }
    for (const d of days) { cr[d.month] += d.closeReturn; ct[d.month]++; s[d.month].push({ idx: ct[d.month], cumRet: cr[d.month] }); }
    return s;
  }, [days]);

  // === intraweek pattern ===
  const intraweekData = useMemo(() => {
    // Group days into weeks, compute Mon→Fri cumulative within each week, then average
    const weeks: number[][] = [];
    let curWeek: number[] = [];
    for (const d of days) {
      if (d.dayOfWeek === 1 && curWeek.length > 0) { weeks.push(curWeek); curWeek = []; }
      if (d.dayOfWeek >= 1 && d.dayOfWeek <= 5) curWeek.push(d.closeReturn);
    }
    if (curWeek.length > 0) weeks.push(curWeek);
    // Build cumulative for each week, then average by position
    const maxPos = 5;
    const avgCumul: { pos: number; avg: number }[] = [];
    for (let p = 0; p < maxPos; p++) {
      const vals: number[] = [];
      for (const w of weeks) {
        if (w.length > p) {
          let cum = 0; for (let j = 0; j <= p; j++) cum += w[j];
          vals.push(cum);
        }
      }
      if (vals.length > 0) avgCumul.push({ pos: p, avg: mean(vals) });
    }
    return avgCumul;
  }, [days]);

  // === year x month returns ===
  const yearMonthData = useMemo(() => {
    const map: Record<number, Record<number, number[]>> = {};
    for (const d of days) {
      if (!map[d.year]) map[d.year] = {};
      if (!map[d.year][d.month]) map[d.year][d.month] = [];
      map[d.year][d.month].push(d.closeReturn);
    }
    const years = Object.keys(map).map(Number).sort();
    const grid: { year: number; months: (number | null)[] }[] = [];
    for (const y of years) {
      const months: (number | null)[] = [];
      for (let m = 0; m < 12; m++) {
        const arr = map[y]?.[m];
        months.push(arr && arr.length > 0 ? arr.reduce((a, b) => a + b, 0) : null);
      }
      grid.push({ year: y, months });
    }
    return grid;
  }, [days]);

  const DOW_COLORS = ["#999", "#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#999"];
  const MONTH_COLORS = ["#ef4444","#f97316","#eab308","#22c55e","#14b8a6","#06b6d4","#3b82f6","#6366f1","#8b5cf6","#a855f7","#ec4899","#f43f5e"];
  const BAR_COLORS = { close: "#3b82f6", intraday: "#22c55e", overnight: "#f59e0b" };

  // =============== DRAW FUNCTIONS ===============

  // Grouped bar chart (weekday or monthly)
  const drawGroupedBar = useCallback((
    canvas: HTMLCanvasElement,
    labels: string[],
    groups: { close: number; intraday: number; overnight: number }[],
  ) => {
    const r = initCanvas(canvas, 200); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 15, bottom: 30, left: 55, right: 15 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const vals = groups.flatMap(g => [g.close, g.intraday, g.overnight]);
    const maxAbs = Math.max(...vals.map(Math.abs), 0.0001);
    const zeroY = pad.top + plotH / 2;

    // grid
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(width - pad.right, zeroY); ctx.stroke();
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (const v of [-maxAbs, 0, maxAbs]) {
      const y = zeroY - (v / maxAbs) * (plotH / 2);
      ctx.fillText((v * 100).toFixed(2) + "%", pad.left - 5, y + 3);
    }

    const n = groups.length;
    const groupW = plotW / n;
    const barW = Math.max(3, groupW / 4.5);
    const gap = barW * 0.3;

    for (let i = 0; i < n; i++) {
      const g = groups[i];
      const cx = pad.left + (i + 0.5) * groupW;
      const bars = [
        { val: g.close, color: BAR_COLORS.close },
        { val: g.intraday, color: BAR_COLORS.intraday },
        { val: g.overnight, color: BAR_COLORS.overnight },
      ];
      for (let j = 0; j < 3; j++) {
        const x = cx - 1.5 * barW - gap + j * (barW + gap);
        const barH = (bars[j].val / maxAbs) * (plotH / 2);
        ctx.fillStyle = bars[j].color;
        ctx.fillRect(x, zeroY - Math.max(barH, 0), barW, Math.abs(barH));
      }
      ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(labels[i], cx, height - 12);
    }

    // legend
    ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    const leg = [{ label: "前日比", color: BAR_COLORS.close }, { label: "日中", color: BAR_COLORS.intraday }, { label: "夜間", color: BAR_COLORS.overnight }];
    let lx = pad.left;
    for (const l of leg) {
      ctx.fillStyle = l.color; ctx.fillRect(lx, height - 5, 10, 3);
      ctx.fillStyle = "#666"; ctx.fillText(l.label, lx + 13, height - 1);
      lx += ctx.measureText(l.label).width + 25;
    }
  }, []);

  // Box plot
  const drawBoxPlot = useCallback((
    canvas: HTMLCanvasElement,
    labels: string[],
    rawArrays: number[][],
    colors: string[],
  ) => {
    const r = initCanvas(canvas, 220); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 15, bottom: 25, left: 55, right: 15 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    // compute box stats
    const boxes = rawArrays.map(arr => {
      if (arr.length < 5) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75);
      const iqr = q3 - q1;
      const whiskerLo = Math.max(sorted[0], q1 - 1.5 * iqr);
      const whiskerHi = Math.min(sorted[sorted.length - 1], q3 + 1.5 * iqr);
      return { med: quantile(sorted, 0.5), q1, q3, whiskerLo, whiskerHi, outliers: sorted.filter(v => v < whiskerLo || v > whiskerHi) };
    });

    const allVals = rawArrays.flat();
    if (allVals.length === 0) return;
    const minVal = Math.min(...allVals), maxVal = Math.max(...allVals);
    const range = maxVal - minVal || 0.01;
    const toY = (v: number) => pad.top + plotH * (1 - (v - minVal) / range);

    // grid
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
    const zeroY = toY(0);
    if (zeroY >= pad.top && zeroY <= pad.top + plotH) {
      ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(width - pad.right, zeroY); ctx.stroke();
    }
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 5; i++) {
      const val = minVal + (range * i) / 5;
      const y = pad.top + plotH * (1 - i / 5);
      ctx.fillText((val * 100).toFixed(2) + "%", pad.left - 5, y + 3);
      ctx.strokeStyle = "#f0f0f0"; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }

    const n = boxes.length;
    const slotW = plotW / n;
    const boxW = Math.max(10, slotW * 0.5);

    for (let i = 0; i < n; i++) {
      const b = boxes[i]; if (!b) continue;
      const cx = pad.left + (i + 0.5) * slotW;
      const x = cx - boxW / 2;

      // whiskers
      ctx.strokeStyle = colors[i % colors.length]; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, toY(b.whiskerHi)); ctx.lineTo(cx, toY(b.q3)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, toY(b.q1)); ctx.lineTo(cx, toY(b.whiskerLo)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, toY(b.whiskerHi)); ctx.lineTo(x + boxW, toY(b.whiskerHi)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, toY(b.whiskerLo)); ctx.lineTo(x + boxW, toY(b.whiskerLo)); ctx.stroke();

      // box
      const boxTop = toY(b.q3), boxBot = toY(b.q1);
      ctx.fillStyle = colors[i % colors.length] + "30";
      ctx.fillRect(x, boxTop, boxW, boxBot - boxTop);
      ctx.strokeStyle = colors[i % colors.length]; ctx.lineWidth = 1.5;
      ctx.strokeRect(x, boxTop, boxW, boxBot - boxTop);

      // median
      ctx.strokeStyle = colors[i % colors.length]; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, toY(b.med)); ctx.lineTo(x + boxW, toY(b.med)); ctx.stroke();

      // outliers
      ctx.fillStyle = colors[i % colors.length] + "60";
      for (const o of b.outliers) {
        ctx.beginPath(); ctx.arc(cx, toY(o), 2, 0, Math.PI * 2); ctx.fill();
      }

      // label
      ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(labels[i], cx, height - 8);
    }
  }, []);

  // Heatmap grid for crossStats
  const drawCrossHeatmap = useCallback((
    canvas: HTMLCanvasElement,
    data: ({ mean: number; n: number } | null)[][],
    rowLabels: string[],
    colLabels: string[],
    rows: number[],
    maxAbs: number,
  ) => {
    const activeCols = colLabels.map((_, m) => rows.some(r => data[r][m] !== null)).map((v, i) => v ? i : -1).filter(i => i >= 0);
    const nRows = rows.length, nCols = activeCols.length;
    const cellW = 50, cellH = 28, labelW = 30, headerH = 20;
    const totalW = labelW + nCols * cellW, totalH = headerH + nRows * cellH;
    const r = initCanvas(canvas, totalH + 10); if (!r) return;
    const { ctx } = r;

    // header
    ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    for (let j = 0; j < nCols; j++) {
      ctx.fillText(colLabels[activeCols[j]], labelW + j * cellW + cellW / 2, headerH - 5);
    }
    // rows
    for (let i = 0; i < nRows; i++) {
      const row = rows[i];
      ctx.fillStyle = "#666"; ctx.textAlign = "right"; ctx.font = "9px sans-serif";
      ctx.fillText(rowLabels[i], labelW - 4, headerH + i * cellH + cellH / 2 + 3);
      for (let j = 0; j < nCols; j++) {
        const cell = data[row][activeCols[j]];
        const x = labelW + j * cellW, y = headerH + i * cellH;
        ctx.fillStyle = cell ? returnColor(cell.mean, maxAbs) : "#f9fafb";
        ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
        if (cell) {
          ctx.fillStyle = Math.abs(cell.mean) > maxAbs * 0.6 ? "#fff" : "#333";
          ctx.textAlign = "center"; ctx.font = "9px sans-serif";
          ctx.fillText((cell.mean * 100).toFixed(2) + "%", x + cellW / 2, y + cellH / 2 + 3);
        }
      }
    }
  }, []);

  // Intraweek pattern
  const drawIntraweek = useCallback((canvas: HTMLCanvasElement, data: { pos: number; avg: number }[]) => {
    const r = initCanvas(canvas, 180); if (!r) return;
    const { ctx, width, height } = r;
    if (data.length < 2) return;
    const pad = { top: 15, bottom: 25, left: 55, right: 15 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    let minV = Infinity, maxV = -Infinity;
    for (const p of data) { minV = Math.min(minV, p.avg); maxV = Math.max(maxV, p.avg); }
    // include zero
    minV = Math.min(minV, 0); maxV = Math.max(maxV, 0);
    const range = maxV - minV || 0.01;
    const toY = (v: number) => pad.top + plotH * (1 - (v - minV) / range);

    // zero line
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, toY(0)); ctx.lineTo(width - pad.right, toY(0)); ctx.stroke();

    // Y-axis
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const val = minV + (range * i) / 4;
      const y = pad.top + plotH * (1 - i / 4);
      ctx.fillText((val * 100).toFixed(3) + "%", pad.left - 5, y + 3);
      ctx.strokeStyle = "#f0f0f0"; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }

    // area fill
    ctx.fillStyle = "rgba(59, 130, 246, 0.1)";
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = pad.left + (data[i].pos / 4) * plotW;
      const y = toY(data[i].avg);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineTo(pad.left + (data[data.length - 1].pos / 4) * plotW, toY(0));
    ctx.lineTo(pad.left, toY(0));
    ctx.closePath(); ctx.fill();

    // line
    ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = pad.left + (data[i].pos / 4) * plotW;
      const y = toY(data[i].avg);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // dots + labels
    const dowShort = ["月", "火", "水", "木", "金"];
    for (let i = 0; i < data.length; i++) {
      const x = pad.left + (data[i].pos / 4) * plotW;
      const y = toY(data[i].avg);
      ctx.fillStyle = "#3b82f6"; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#666"; ctx.textAlign = "center"; ctx.font = "10px sans-serif";
      ctx.fillText(dowShort[i] || "", x, height - 8);
    }
  }, []);

  // Year x Month heatmap
  const drawYearMonth = useCallback((canvas: HTMLCanvasElement, data: { year: number; months: (number | null)[] }[]) => {
    if (data.length === 0) return;
    const cellW = 50, cellH = 22, labelW = 40, headerH = 20;
    const nCols = 12, nRows = data.length;
    const totalH = headerH + nRows * cellH + 5;
    const r = initCanvas(canvas, totalH); if (!r) return;
    const { ctx } = r;

    let maxAbs = 0;
    for (const row of data) for (const v of row.months) if (v !== null) maxAbs = Math.max(maxAbs, Math.abs(v));

    ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    for (let m = 0; m < nCols; m++) ctx.fillText(MONTH_LABELS[m], labelW + m * cellW + cellW / 2, headerH - 5);

    for (let i = 0; i < nRows; i++) {
      const row = data[i];
      ctx.fillStyle = "#666"; ctx.textAlign = "right"; ctx.font = "9px sans-serif";
      ctx.fillText(String(row.year), labelW - 5, headerH + i * cellH + cellH / 2 + 3);
      for (let m = 0; m < nCols; m++) {
        const x = labelW + m * cellW, y = headerH + i * cellH;
        const val = row.months[m];
        ctx.fillStyle = val !== null ? returnColor(val, maxAbs) : "#f9fafb";
        ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
        if (val !== null) {
          ctx.fillStyle = Math.abs(val) > maxAbs * 0.6 ? "#fff" : "#333";
          ctx.textAlign = "center"; ctx.font = "8px sans-serif";
          ctx.fillText((val * 100).toFixed(1) + "%", x + cellW / 2, y + cellH / 2 + 3);
        }
      }
    }
  }, []);

  // Week-of-month bar chart
  const drawWomBar = useCallback((canvas: HTMLCanvasElement, data: (typeof womStats)) => {
    const r = initCanvas(canvas, 180); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 15, bottom: 25, left: 55, right: 15 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    const valid = data.filter(d => d !== null) as NonNullable<(typeof data)[0]>[];
    if (valid.length === 0) return;
    const maxAbs = Math.max(...valid.map(d => Math.abs(d.mean)), 0.0001);
    const zeroY = pad.top + plotH / 2;

    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(width - pad.right, zeroY); ctx.stroke();
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (const v of [-maxAbs, 0, maxAbs]) {
      const y = zeroY - (v / maxAbs) * (plotH / 2);
      ctx.fillText((v * 100).toFixed(3) + "%", pad.left - 5, y + 3);
    }

    const barW = Math.max(15, plotW / 7);
    const barColors = ["#6366f1", "#8b5cf6", "#a855f7", "#c084fc", "#d8b4fe"];
    for (let i = 0; i < 5; i++) {
      const d = data[i]; if (!d) continue;
      const cx = pad.left + (i + 0.5) * (plotW / 5);
      const barH = (d.mean / maxAbs) * (plotH / 2);
      ctx.fillStyle = barColors[i];
      ctx.fillRect(cx - barW / 2, zeroY - Math.max(barH, 0), barW, Math.abs(barH));
      ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(`第${i + 1}週`, cx, height - 8);
    }
  }, []);

  // Line chart (cumulative)
  const drawLineChart = useCallback((
    canvas: HTMLCanvasElement,
    seriesData: Record<number, { idx: number; cumRet: number }[]>,
    colors: string[], labels: string[], keys: number[],
  ) => {
    const r = initCanvas(canvas, 200); if (!r) return;
    const { ctx, width, height } = r;
    let allMin = 0, allMax = 0, allMaxIdx = 0;
    for (const k of keys) for (const pt of seriesData[k]) { allMin = Math.min(allMin, pt.cumRet); allMax = Math.max(allMax, pt.cumRet); allMaxIdx = Math.max(allMaxIdx, pt.idx); }
    if (allMaxIdx === 0) return;
    const pad = { top: 15, bottom: 25, left: 50, right: 15 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom, range = allMax - allMin || 0.01;
    const zeroY = pad.top + plotH * (1 - (0 - allMin) / range);
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(width - pad.right, zeroY); ctx.stroke();
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 5; i++) { const val = allMin + (range * i) / 5; const y = pad.top + plotH * (1 - i / 5); ctx.fillText((val * 100).toFixed(1) + "%", pad.left - 5, y + 3); ctx.strokeStyle = "#f0f0f0"; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke(); }
    for (const k of keys) { const pts = seriesData[k]; if (pts.length < 2) continue; ctx.strokeStyle = colors[k]; ctx.lineWidth = 1.5; ctx.beginPath(); for (let i = 0; i < pts.length; i++) { const x = pad.left + (pts[i].idx / allMaxIdx) * plotW; const y = pad.top + plotH * (1 - (pts[i].cumRet - allMin) / range); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke(); }
    ctx.font = "9px sans-serif"; ctx.textAlign = "left"; let lx = pad.left;
    for (const k of keys) { if (!seriesData[k] || seriesData[k].length === 0) continue; ctx.fillStyle = colors[k]; ctx.fillRect(lx, height - 12, 12, 3); ctx.fillStyle = "#666"; ctx.fillText(labels[k], lx + 15, height - 7); lx += ctx.measureText(labels[k]).width + 25; }
  }, []);

  // Day-of-month bar chart
  const drawDomBar = useCallback((canvas: HTMLCanvasElement, data: (typeof domStats)) => {
    const r = initCanvas(canvas, 180); if (!r) return;
    const { ctx, width, height } = r;
    const valid = data.filter(d => d !== null) as NonNullable<(typeof data)[0]>[];
    if (valid.length === 0) return;
    const pad = { top: 15, bottom: 25, left: 50, right: 10 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    const maxAbs = Math.max(...valid.map(d => Math.abs(d.mean)), 0.001);
    const zeroY = pad.top + plotH / 2;
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(width - pad.right, zeroY); ctx.stroke();
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (const v of [-maxAbs, -maxAbs / 2, 0, maxAbs / 2, maxAbs]) { const y = zeroY - (v / maxAbs) * (plotH / 2); ctx.fillText((v * 100).toFixed(2) + "%", pad.left - 5, y + 3); ctx.strokeStyle = "#f0f0f0"; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke(); }
    const barW = Math.max(2, plotW / 31 - 2);
    for (const d of valid) { const x = pad.left + ((d.dom - 1) / 30) * plotW; const barH = (d.mean / maxAbs) * (plotH / 2); ctx.fillStyle = d.mean > 0 ? "rgba(38, 166, 154, 0.7)" : "rgba(239, 83, 80, 0.7)"; ctx.fillRect(x, zeroY - Math.max(barH, 0), barW, Math.abs(barH)); }
    ctx.fillStyle = "#999"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    for (let i = 1; i <= 31; i += 5) { const x = pad.left + ((i - 1) / 30) * plotW + barW / 2; ctx.fillText(String(i), x, height - 8); }
  }, []);

  // Seasonality line chart
  const drawSeasonality = useCallback((canvas: HTMLCanvasElement, data: { day: number; avg: number }[]) => {
    const r = initCanvas(canvas, 200); if (!r) return;
    const { ctx, width, height } = r;
    if (data.length < 2) return;
    const pad = { top: 15, bottom: 25, left: 50, right: 15 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    const maxDay = data[data.length - 1].day;
    let minVal = Infinity, maxVal = -Infinity;
    for (const pt of data) { minVal = Math.min(minVal, pt.avg); maxVal = Math.max(maxVal, pt.avg); }
    const range = maxVal - minVal || 0.01;
    if (minVal <= 0 && maxVal >= 0) { const zy = pad.top + plotH * (1 - (0 - minVal) / range); ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.left, zy); ctx.lineTo(width - pad.right, zy); ctx.stroke(); }
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 5; i++) { const val = minVal + (range * i) / 5; const y = pad.top + plotH * (1 - i / 5); ctx.fillText((val * 100).toFixed(1) + "%", pad.left - 5, y + 3); ctx.strokeStyle = "#f0f0f0"; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke(); }
    ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < data.length; i++) { const x = pad.left + ((data[i].day - 1) / (maxDay - 1)) * plotW; const y = pad.top + plotH * (1 - (data[i].avg - minVal) / range); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke();
    ctx.fillStyle = "#bbb"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    for (let m = 0; m < 12; m++) { const da = Math.round(m * (maxDay / 12)); if (da === 0) continue; const x = pad.left + (da / (maxDay - 1)) * plotW; ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke(); ctx.fillText(MONTH_LABELS[m], x, height - 8); }
  }, []);

  // === Draw all canvases ===
  useEffect(() => {
    if (days.length === 0) return;

    // 1. Weekday grouped bar
    if (dowBarRef.current) {
      const groups = DOW_TRADING.map(dow => {
        const s = dowRaw[dow];
        return { close: mean(s.close), intraday: mean(s.intraday), overnight: mean(s.overnight) };
      });
      drawGroupedBar(dowBarRef.current, DOW_TRADING.map(d => DOW_LABELS[d]), groups);
    }

    // 2. Monthly grouped bar
    if (monthBarRef.current) {
      const activeMonths = monthRaw.map((_, i) => i).filter(m => monthRaw[m].close.length > 0);
      const groups = activeMonths.map(m => ({
        close: mean(monthRaw[m].close), intraday: mean(monthRaw[m].intraday), overnight: mean(monthRaw[m].overnight),
      }));
      drawGroupedBar(monthBarRef.current, activeMonths.map(m => MONTH_LABELS[m]), groups);
    }

    // 3. Box plot
    if (dowBoxRef.current) {
      drawBoxPlot(dowBoxRef.current, DOW_TRADING.map(d => DOW_LABELS[d]), DOW_TRADING.map(d => dowRaw[d].close), DOW_TRADING.map(d => DOW_COLORS[d]));
    }

    // 4. Cross heatmap
    if (crossHeatRef.current) {
      drawCrossHeatmap(crossHeatRef.current, crossStats, DOW_TRADING.map(d => DOW_LABELS[d]), MONTH_LABELS, DOW_TRADING, crossMaxAbs);
    }

    // 5. Intraweek
    if (intraweekRef.current) drawIntraweek(intraweekRef.current, intraweekData);

    // 6. Year x Month
    if (yearMonthRef.current) drawYearMonth(yearMonthRef.current, yearMonthData);

    // 7. WoM bar
    if (womBarRef.current) drawWomBar(womBarRef.current, womStats);

    // Existing charts
    if (dowCumulRef.current) drawLineChart(dowCumulRef.current, dowCumulative, DOW_COLORS, DOW_LABELS, DOW_TRADING);
    if (monthCumulRef.current) {
      const am = Array.from({ length: 12 }, (_, i) => i).filter(m => monthCumulative[m].length > 0);
      drawLineChart(monthCumulRef.current, monthCumulative, MONTH_COLORS, MONTH_LABELS, am);
    }
    if (domBarRef.current) drawDomBar(domBarRef.current, domStats);
    if (seasonRef.current) drawSeasonality(seasonRef.current, seasonality);
  }, [days, dowRaw, monthRaw, crossStats, crossMaxAbs, intraweekData, yearMonthData, womStats, dowCumulative, monthCumulative, domStats, seasonality, drawGroupedBar, drawBoxPlot, drawCrossHeatmap, drawIntraweek, drawYearMonth, drawWomBar, drawLineChart, drawDomBar, drawSeasonality]);

  if (days.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="font-bold text-gray-800 mb-3">カレンダー分析</h3>
        <p className="text-xs text-gray-400">データが不足しています。</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-5">
      <h3 className="font-bold text-gray-800">カレンダー分析</h3>

      {/* ===== 1. Weekday grouped bar ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日別 平均リターン比較 (前日比 / 日中 / 夜間)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={dowBarRef} /></div>
      </div>

      {/* ===== 2. Weekday box plot ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日別 リターン分布 (箱ひげ図)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={dowBoxRef} /></div>
      </div>

      {/* ===== Weekday detailed stats table ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日別リターン詳細</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1 px-2 text-left text-gray-500 font-medium"></th>
                {DOW_TRADING.map((dow, i) => (
                  <th key={dow} className="py-1 px-2 text-center font-medium text-gray-700">{DOW_LABELS[dow]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-500">N</td>
                {dowStats.map((s, i) => <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{s?.n ?? 0}</td>)}
              </tr>
              <tr className="border-b border-gray-100 bg-gray-50"><td className="py-1 px-2 text-gray-500 font-medium" colSpan={6}>前日比</td></tr>
              {(["mean", "median", "std", "winRate", "pValue"] as const).map(key => (
                <tr key={`c-${key}`} className="border-b border-gray-100">
                  <td className="py-1 px-2 text-gray-400">{key === "mean" ? "平均" : key === "median" ? "中央値" : key === "std" ? "標準偏差" : key === "winRate" ? "勝率" : "p値"}</td>
                  {dowStats.map((s, i) => {
                    if (!s) return <td key={i} className="py-1 px-2 text-center">-</td>;
                    if (key === "pValue") { const pv = pValueLabel(s.close.pValue); return <td key={i} className={`py-1 px-2 text-center font-mono ${pv.cls}`}>{pv.text}</td>; }
                    if (key === "winRate") return <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{pct2(s.close.winRate)}</td>;
                    if (key === "std") return <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{pct(s.close.std)}</td>;
                    const v = s.close[key]; return <td key={i} className={`py-1 px-2 text-center font-mono ${colorClass(v)}`}>{pct(v)}</td>;
                  })}
                </tr>
              ))}
              <tr className="border-b border-gray-100 bg-gray-50"><td className="py-1 px-2 text-gray-500 font-medium" colSpan={6}>日中</td></tr>
              {(["mean", "median", "winRate"] as const).map(key => (
                <tr key={`i-${key}`} className="border-b border-gray-100">
                  <td className="py-1 px-2 text-gray-400">{key === "mean" ? "平均" : key === "median" ? "中央値" : "勝率"}</td>
                  {dowStats.map((s, i) => {
                    if (!s) return <td key={i} className="py-1 px-2 text-center">-</td>;
                    if (key === "winRate") return <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{pct2(s.intraday.winRate)}</td>;
                    const v = s.intraday[key]; return <td key={i} className={`py-1 px-2 text-center font-mono ${colorClass(v)}`}>{pct(v)}</td>;
                  })}
                </tr>
              ))}
              <tr className="border-b border-gray-100 bg-gray-50"><td className="py-1 px-2 text-gray-500 font-medium" colSpan={6}>夜間</td></tr>
              {(["mean", "median", "winRate"] as const).map(key => (
                <tr key={`o-${key}`} className="border-b border-gray-100">
                  <td className="py-1 px-2 text-gray-400">{key === "mean" ? "平均" : key === "median" ? "中央値" : "勝率"}</td>
                  {dowStats.map((s, i) => {
                    if (!s) return <td key={i} className="py-1 px-2 text-center">-</td>;
                    if (key === "winRate") return <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{pct2(s.overnight.winRate)}</td>;
                    const v = s.overnight[key]; return <td key={i} className={`py-1 px-2 text-center font-mono ${colorClass(v)}`}>{pct(v)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ===== 3. Monthly grouped bar ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月別 平均リターン比較 (前日比 / 日中 / 夜間)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={monthBarRef} /></div>
      </div>

      {/* ===== Monthly stats table ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月別リターン詳細</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1 px-1.5 text-left text-gray-500 font-medium"></th>
                {MONTH_LABELS.map((l, m) => monthStats[m] && <th key={m} className="py-1 px-1.5 text-center font-medium text-gray-700">{l}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">N</td>
                {monthStats.map((s, m) => s && <td key={m} className="py-1 px-1.5 text-center font-mono text-gray-600">{s.n}</td>)}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">前日比 平均</td>
                {monthStats.map((s, m) => s && <td key={m} className={`py-1 px-1.5 text-center font-mono ${colorClass(s.close.mean)}`}>{pct2(s.close.mean)}</td>)}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">標準偏差</td>
                {monthStats.map((s, m) => s && <td key={m} className="py-1 px-1.5 text-center font-mono text-gray-600">{pct2(s.close.std)}</td>)}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">勝率</td>
                {monthStats.map((s, m) => s && <td key={m} className="py-1 px-1.5 text-center font-mono text-gray-600">{pct2(s.close.winRate)}</td>)}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">p値</td>
                {monthStats.map((s, m) => { if (!s) return null; const pv = pValueLabel(s.close.pValue); return <td key={m} className={`py-1 px-1.5 text-center font-mono ${pv.cls}`}>{pv.text}</td>; })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">日中 平均</td>
                {monthStats.map((s, m) => s && <td key={m} className={`py-1 px-1.5 text-center font-mono ${colorClass(s.intraday.mean)}`}>{pct2(s.intraday.mean)}</td>)}
              </tr>
              <tr>
                <td className="py-1 px-1.5 text-gray-500">夜間 平均</td>
                {monthStats.map((s, m) => s && <td key={m} className={`py-1 px-1.5 text-center font-mono ${colorClass(s.overnight.mean)}`}>{pct2(s.overnight.mean)}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ===== 4. Intraweek pattern ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">週内パターン (月→金 平均累積リターン推移)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={intraweekRef} /></div>
      </div>

      {/* ===== 5. Week-of-month bar ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月内週番号別 平均リターン</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={womBarRef} /></div>
      </div>

      {/* Week-of-month table */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月内週番号別リターン詳細</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1 px-2 text-left text-gray-500 font-medium"></th>
                {[1, 2, 3, 4, 5].map(w => <th key={w} className="py-1 px-2 text-center font-medium text-gray-700">第{w}週</th>)}
              </tr>
            </thead>
            <tbody>
              {(["n", "mean", "std", "winRate", "pValue"] as const).map(key => (
                <tr key={key} className="border-b border-gray-100">
                  <td className="py-1 px-2 text-gray-500">{key === "n" ? "N" : key === "mean" ? "平均" : key === "std" ? "標準偏差" : key === "winRate" ? "勝率" : "p値"}</td>
                  {womStats.map((s, i) => {
                    if (!s) return <td key={i} className="py-1 px-2 text-center">-</td>;
                    if (key === "n") return <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{s.n}</td>;
                    if (key === "pValue") { const pv = pValueLabel(s.pValue); return <td key={i} className={`py-1 px-2 text-center font-mono ${pv.cls}`}>{pv.text}</td>; }
                    if (key === "winRate") return <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{pct2(s.winRate)}</td>;
                    if (key === "std") return <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{pct(s.std)}</td>;
                    return <td key={i} className={`py-1 px-2 text-center font-mono ${colorClass(s.mean)}`}>{pct(s.mean)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ===== 6. Cross heatmap ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日 x 月 ヒートマップ (前日比 平均)</div>
        <div className="w-full rounded border border-gray-100 overflow-x-auto overflow-hidden"><canvas ref={crossHeatRef} /></div>
      </div>

      {/* ===== Previous day conditional ===== */}
      {conditionalStats && (
        <div>
          <div className="text-xs text-gray-500 mb-1">前日騰落との関係</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="py-1 px-2 text-left text-gray-500 font-medium">条件</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">N</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">翌日平均</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">翌日勝率</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">p値</th>
                </tr>
              </thead>
              <tbody>
                {(["afterUp", "afterDown"] as const).map(key => {
                  const s = conditionalStats[key];
                  const pv = pValueLabel(s.pValue);
                  return (
                    <tr key={key} className="border-b border-gray-100">
                      <td className="py-1 px-2 text-gray-600">{key === "afterUp" ? "前日上昇後" : "前日下落後"}</td>
                      <td className="py-1 px-2 text-center font-mono text-gray-600">{s.n}</td>
                      <td className={`py-1 px-2 text-center font-mono ${colorClass(s.mean)}`}>{pct(s.mean)}</td>
                      <td className="py-1 px-2 text-center font-mono text-gray-600">{pct2(s.winRate)}</td>
                      <td className={`py-1 px-2 text-center font-mono ${pv.cls}`}>{pv.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===== Day-of-month bar chart ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月内日別 平均リターン (Turn of Month効果)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={domBarRef} /></div>
      </div>

      {/* ===== Cumulative by weekday ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日別 累積リターン</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={dowCumulRef} /></div>
      </div>

      {/* ===== Cumulative by month ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月別 累積リターン</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={monthCumulRef} /></div>
      </div>

      {/* ===== 7. Year x Month heatmap ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">年 x 月 リターンヒートマップ (月間合計リターン)</div>
        <div className="w-full rounded border border-gray-100 overflow-x-auto overflow-hidden"><canvas ref={yearMonthRef} /></div>
      </div>

      {/* ===== Seasonality ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">年間シーズナリティ曲線 (年平均 累積リターン推移)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={seasonRef} /></div>
      </div>

      {/* ===== Streak analysis ===== */}
      {streakStats && (
        <div>
          <div className="text-xs text-gray-500 mb-1">連騰・連落分析</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-400">最長連騰</div>
              <div className="font-mono text-green-600 text-sm">{streakStats.maxUp}日</div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-400">最長連落</div>
              <div className="font-mono text-red-600 text-sm">{streakStats.maxDown}日</div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-400">平均連騰</div>
              <div className="font-mono text-gray-700 text-sm">{streakStats.avgUp.toFixed(1)}日 ({streakStats.upCount}回)</div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-400">平均連落</div>
              <div className="font-mono text-gray-700 text-sm">{streakStats.avgDown.toFixed(1)}日 ({streakStats.downCount}回)</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
