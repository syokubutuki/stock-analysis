"use client";

import { useMemo, useCallback, useRef, useEffect } from "react";
import { PricePoint } from "../../lib/types";
import type { PeriodKey } from "../../hooks/useAnalysisData";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const DOW_TRADING = [1, 2, 3, 4, 5]; // Mon-Fri
const MONTH_LABELS = [
  "1月","2月","3月","4月","5月","6月",
  "7月","8月","9月","10月","11月","12月",
];

interface DayStats {
  date: string;
  dayOfWeek: number;
  month: number;
  dayOfMonth: number;
  weekOfMonth: number; // 1-5
  tradingDayOfYear: number;
  closeReturn: number;
  intradayReturn: number;
  overnightReturn: number;
}

function pct(v: number): string {
  return (v * 100).toFixed(3) + "%";
}
function pct2(v: number): string {
  return (v * 100).toFixed(2) + "%";
}

function colorClass(v: number): string {
  return v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500";
}

function mean(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function winRate(arr: number[]): number {
  return arr.length > 0 ? arr.filter((v) => v > 0).length / arr.length : 0;
}

// Two-tailed t-test: H0: mean = 0
function tTestPValue(arr: number[]): number | null {
  const n = arr.length;
  if (n < 3) return null;
  const m = mean(arr);
  const se = std(arr) / Math.sqrt(n);
  if (se === 0) return null;
  const t = m / se;
  // Approximate p-value using normal distribution for large n
  // For small n, use approximation of Student's t CDF
  const df = n - 1;
  const x = df / (df + t * t);
  // Regularized incomplete beta function approximation
  const p = incompleteBeta(df / 2, 0.5, x);
  return Math.min(p, 1);
}

// Simple approximation of regularized incomplete beta function
function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Use continued fraction for Ix(a,b)
  const maxIter = 200;
  const eps = 1e-10;
  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;
  // Lentz's algorithm for continued fraction
  let f = 1, c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d; f = d;
  for (let i = 1; i <= maxIter; i++) {
    const m = i;
    let numerator = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + numerator * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + numerator / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    f *= d * c;
    numerator = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + numerator / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    const delta = d * c;
    f *= delta;
    if (Math.abs(delta - 1) < eps) break;
  }
  return front * f;
}

function lnGamma(z: number): number {
  // Lanczos approximation
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function pValueLabel(p: number | null): { text: string; cls: string } {
  if (p === null) return { text: "-", cls: "text-gray-400" };
  const star = p < 0.01 ? "***" : p < 0.05 ? "**" : p < 0.1 ? "*" : "";
  const cls = p < 0.05 ? "text-blue-600 font-medium" : "text-gray-500";
  return { text: p.toFixed(3) + star, cls };
}

export default function SpiralHeatmap({ prices, period }: Props) {
  const dowCumulRef = useRef<HTMLCanvasElement>(null);
  const monthCumulRef = useRef<HTMLCanvasElement>(null);
  const domBarRef = useRef<HTMLCanvasElement>(null);
  const seasonRef = useRef<HTMLCanvasElement>(null);

  const days: DayStats[] = useMemo(() => {
    if (prices.length < 2) return [];
    // Compute trading day of year per year
    const yearCounters: Record<number, number> = {};
    return prices.slice(1).map((p, i) => {
      const prev = prices[i];
      const d = new Date(p.time);
      const prevClose = prev.close || 1;
      const open = p.open || prevClose;
      const year = d.getFullYear();
      yearCounters[year] = (yearCounters[year] || 0) + 1;
      const dom = d.getDate();
      const weekOfMonth = Math.ceil(dom / 7);
      return {
        date: p.time,
        dayOfWeek: d.getDay(),
        month: d.getMonth(),
        dayOfMonth: dom,
        weekOfMonth,
        tradingDayOfYear: yearCounters[year],
        closeReturn: (p.close - prevClose) / prevClose,
        intradayReturn: (p.close - open) / open,
        overnightReturn: (open - prevClose) / prevClose,
      };
    });
  }, [prices]);

  // --- Weekday stats ---
  const dowStats = useMemo(() => {
    const stats = Array.from({ length: 7 }, () => ({
      closeReturns: [] as number[],
      intradayReturns: [] as number[],
      overnightReturns: [] as number[],
    }));
    for (const d of days) {
      stats[d.dayOfWeek].closeReturns.push(d.closeReturn);
      stats[d.dayOfWeek].intradayReturns.push(d.intradayReturn);
      stats[d.dayOfWeek].overnightReturns.push(d.overnightReturn);
    }
    return stats.map((s) => {
      const n = s.closeReturns.length;
      if (n === 0) return null;
      return {
        n,
        close: { mean: mean(s.closeReturns), median: median(s.closeReturns), std: std(s.closeReturns), winRate: winRate(s.closeReturns), pValue: tTestPValue(s.closeReturns) },
        intraday: { mean: mean(s.intradayReturns), median: median(s.intradayReturns), std: std(s.intradayReturns), winRate: winRate(s.intradayReturns) },
        overnight: { mean: mean(s.overnightReturns), median: median(s.overnightReturns), std: std(s.overnightReturns), winRate: winRate(s.overnightReturns) },
      };
    });
  }, [days]);

  // --- Month stats ---
  const monthStats = useMemo(() => {
    const stats = Array.from({ length: 12 }, () => ({
      closeReturns: [] as number[],
      intradayReturns: [] as number[],
      overnightReturns: [] as number[],
    }));
    for (const d of days) {
      stats[d.month].closeReturns.push(d.closeReturn);
      stats[d.month].intradayReturns.push(d.intradayReturn);
      stats[d.month].overnightReturns.push(d.overnightReturn);
    }
    return stats.map((s) => {
      const n = s.closeReturns.length;
      if (n === 0) return null;
      return {
        n,
        close: { mean: mean(s.closeReturns), std: std(s.closeReturns), winRate: winRate(s.closeReturns), pValue: tTestPValue(s.closeReturns) },
        intraday: { mean: mean(s.intradayReturns), std: std(s.intradayReturns), winRate: winRate(s.intradayReturns) },
        overnight: { mean: mean(s.overnightReturns), std: std(s.overnightReturns), winRate: winRate(s.overnightReturns) },
      };
    });
  }, [days]);

  // --- Weekday x Month cross stats ---
  const crossStats = useMemo(() => {
    const grid: number[][][] = Array.from({ length: 7 }, () =>
      Array.from({ length: 12 }, () => [])
    );
    for (const d of days) {
      grid[d.dayOfWeek][d.month].push(d.closeReturn);
    }
    return grid.map((months) =>
      months.map((returns) => {
        if (returns.length === 0) return null;
        return { mean: mean(returns), n: returns.length };
      })
    );
  }, [days]);

  // --- Streak analysis ---
  const streakStats = useMemo(() => {
    if (days.length === 0) return null;
    let curUp = 0, curDown = 0;
    let maxUp = 0, maxDown = 0;
    const upStreaks: number[] = [];
    const downStreaks: number[] = [];
    for (const d of days) {
      if (d.closeReturn > 0) {
        curUp++;
        if (curDown > 0) { downStreaks.push(curDown); curDown = 0; }
      } else if (d.closeReturn < 0) {
        curDown++;
        if (curUp > 0) { upStreaks.push(curUp); curUp = 0; }
      } else {
        if (curUp > 0) upStreaks.push(curUp);
        if (curDown > 0) downStreaks.push(curDown);
        curUp = 0; curDown = 0;
      }
      maxUp = Math.max(maxUp, curUp);
      maxDown = Math.max(maxDown, curDown);
    }
    if (curUp > 0) upStreaks.push(curUp);
    if (curDown > 0) downStreaks.push(curDown);
    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    return { maxUp, maxDown, avgUp: avg(upStreaks), avgDown: avg(downStreaks), upCount: upStreaks.length, downCount: downStreaks.length };
  }, [days]);

  // --- Day-of-month stats ---
  const domStats = useMemo(() => {
    const buckets: number[][] = Array.from({ length: 31 }, () => []);
    for (const d of days) {
      buckets[d.dayOfMonth - 1].push(d.closeReturn);
    }
    return buckets.map((arr, i) => {
      if (arr.length < 2) return null;
      return { dom: i + 1, mean: mean(arr), n: arr.length };
    });
  }, [days]);

  // --- Week-of-month stats ---
  const womStats = useMemo(() => {
    const buckets: number[][] = Array.from({ length: 5 }, () => []);
    for (const d of days) {
      const w = Math.min(d.weekOfMonth, 5) - 1;
      buckets[w].push(d.closeReturn);
    }
    return buckets.map((arr, i) => {
      if (arr.length < 2) return null;
      return {
        week: i + 1,
        mean: mean(arr),
        std: std(arr),
        n: arr.length,
        winRate: winRate(arr),
        pValue: tTestPValue(arr),
      };
    });
  }, [days]);

  // --- Annual seasonality (average cumulative return by trading day of year) ---
  const seasonality = useMemo(() => {
    // Group returns by trading day of year, then compute average cumulative
    const years = new Set(days.map((d) => new Date(d.date).getFullYear()));
    const yearSeries: Record<number, number[]> = {};
    for (const y of years) yearSeries[y] = [];
    for (const d of days) {
      const y = new Date(d.date).getFullYear();
      yearSeries[y].push(d.closeReturn);
    }
    // Build cumulative for each year
    const cumulByYear: Record<number, number[]> = {};
    let maxLen = 0;
    for (const y of years) {
      const series = yearSeries[y];
      const cumul: number[] = [];
      let sum = 0;
      for (const r of series) { sum += r; cumul.push(sum); }
      cumulByYear[y] = cumul;
      maxLen = Math.max(maxLen, cumul.length);
    }
    // Average across years at each trading day
    const avgCumul: { day: number; avg: number }[] = [];
    for (let i = 0; i < maxLen; i++) {
      const vals: number[] = [];
      for (const y of years) {
        if (cumulByYear[y].length > i) vals.push(cumulByYear[y][i]);
      }
      if (vals.length > 0) avgCumul.push({ day: i + 1, avg: mean(vals) });
    }
    return avgCumul;
  }, [days]);

  // --- Previous day conditional probability ---
  const conditionalStats = useMemo(() => {
    if (days.length < 2) return null;
    const afterUp: number[] = [];
    const afterDown: number[] = [];
    for (let i = 1; i < days.length; i++) {
      if (days[i - 1].closeReturn > 0) afterUp.push(days[i].closeReturn);
      else if (days[i - 1].closeReturn < 0) afterDown.push(days[i].closeReturn);
    }
    return {
      afterUp: { n: afterUp.length, mean: mean(afterUp), winRate: winRate(afterUp), pValue: tTestPValue(afterUp) },
      afterDown: { n: afterDown.length, mean: mean(afterDown), winRate: winRate(afterDown), pValue: tTestPValue(afterDown) },
    };
  }, [days]);

  // --- Cumulative return by weekday ---
  const dowCumulative = useMemo(() => {
    const series: Record<number, { idx: number; cumRet: number }[]> = {};
    const counters: Record<number, number> = {};
    const cumRet: Record<number, number> = {};
    for (const dow of DOW_TRADING) {
      series[dow] = []; counters[dow] = 0; cumRet[dow] = 0;
    }
    for (const d of days) {
      if (!(d.dayOfWeek in series)) continue;
      cumRet[d.dayOfWeek] += d.closeReturn;
      counters[d.dayOfWeek]++;
      series[d.dayOfWeek].push({ idx: counters[d.dayOfWeek], cumRet: cumRet[d.dayOfWeek] });
    }
    return series;
  }, [days]);

  // --- Monthly cumulative return ---
  const monthCumulative = useMemo(() => {
    const series: Record<number, { idx: number; cumRet: number }[]> = {};
    const counters: Record<number, number> = {};
    const cumRet: Record<number, number> = {};
    for (let m = 0; m < 12; m++) {
      series[m] = []; counters[m] = 0; cumRet[m] = 0;
    }
    for (const d of days) {
      cumRet[d.month] += d.closeReturn;
      counters[d.month]++;
      series[d.month].push({ idx: counters[d.month], cumRet: cumRet[d.month] });
    }
    return series;
  }, [days]);

  const DOW_COLORS = ["#999", "#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#999"];
  const MONTH_COLORS = [
    "#ef4444","#f97316","#eab308","#22c55e","#14b8a6","#06b6d4",
    "#3b82f6","#6366f1","#8b5cf6","#a855f7","#ec4899","#f43f5e",
  ];

  // Generic line chart drawer
  const drawLineChart = useCallback((
    canvas: HTMLCanvasElement,
    seriesData: Record<number, { idx: number; cumRet: number }[]>,
    colors: string[],
    labels: string[],
    keys: number[],
  ) => {
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 200;
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

    let allMin = 0, allMax = 0, allMaxIdx = 0;
    for (const k of keys) {
      for (const pt of seriesData[k]) {
        allMin = Math.min(allMin, pt.cumRet);
        allMax = Math.max(allMax, pt.cumRet);
        allMaxIdx = Math.max(allMaxIdx, pt.idx);
      }
    }
    if (allMaxIdx === 0) return;

    const pad = { top: 15, bottom: 25, left: 50, right: 15 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const range = allMax - allMin || 0.01;

    const zeroY = pad.top + plotH * (1 - (0 - allMin) / range);
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(width - pad.right, zeroY); ctx.stroke();

    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 5; i++) {
      const val = allMin + (range * i) / 5;
      const y = pad.top + plotH * (1 - i / 5);
      ctx.fillText((val * 100).toFixed(1) + "%", pad.left - 5, y + 3);
      ctx.strokeStyle = "#f0f0f0"; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }

    for (const k of keys) {
      const pts = seriesData[k];
      if (pts.length < 2) continue;
      ctx.strokeStyle = colors[k]; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = pad.left + (pts[i].idx / allMaxIdx) * plotW;
        const y = pad.top + plotH * (1 - (pts[i].cumRet - allMin) / range);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    let lx = pad.left;
    for (const k of keys) {
      if (!seriesData[k] || seriesData[k].length === 0) continue;
      ctx.fillStyle = colors[k]; ctx.fillRect(lx, height - 12, 12, 3);
      ctx.fillStyle = "#666"; ctx.fillText(labels[k], lx + 15, height - 7);
      lx += ctx.measureText(labels[k]).width + 25;
    }
  }, []);

  // Bar chart drawer for day-of-month
  const drawBarChart = useCallback((
    canvas: HTMLCanvasElement,
    data: ({ dom: number; mean: number; n: number } | null)[],
  ) => {
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

    const valid = data.filter((d) => d !== null) as { dom: number; mean: number; n: number }[];
    if (valid.length === 0) return;

    const pad = { top: 15, bottom: 25, left: 50, right: 10 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const maxAbs = Math.max(...valid.map((d) => Math.abs(d.mean)), 0.001);

    const zeroY = pad.top + plotH / 2;
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(width - pad.right, zeroY); ctx.stroke();

    // Y-axis
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (const v of [-maxAbs, -maxAbs / 2, 0, maxAbs / 2, maxAbs]) {
      const y = zeroY - (v / maxAbs) * (plotH / 2);
      ctx.fillText((v * 100).toFixed(2) + "%", pad.left - 5, y + 3);
      ctx.strokeStyle = "#f0f0f0"; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }

    const barW = Math.max(2, plotW / 31 - 2);
    for (const d of valid) {
      const x = pad.left + ((d.dom - 1) / 30) * plotW;
      const barH = (d.mean / maxAbs) * (plotH / 2);
      ctx.fillStyle = d.mean > 0 ? "rgba(38, 166, 154, 0.7)" : "rgba(239, 83, 80, 0.7)";
      ctx.fillRect(x, zeroY - Math.max(barH, 0), barW, Math.abs(barH));
    }

    // X-axis labels
    ctx.fillStyle = "#999"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    for (let i = 1; i <= 31; i += 5) {
      const x = pad.left + ((i - 1) / 30) * plotW + barW / 2;
      ctx.fillText(String(i), x, height - 8);
    }
  }, []);

  // Seasonality chart drawer
  const drawSeasonality = useCallback((
    canvas: HTMLCanvasElement,
    data: { day: number; avg: number }[],
  ) => {
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 200;
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

    if (data.length < 2) return;

    const pad = { top: 15, bottom: 25, left: 50, right: 15 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const maxDay = data[data.length - 1].day;
    let minVal = Infinity, maxVal = -Infinity;
    for (const pt of data) { minVal = Math.min(minVal, pt.avg); maxVal = Math.max(maxVal, pt.avg); }
    const range = maxVal - minVal || 0.01;

    // Zero line
    if (minVal <= 0 && maxVal >= 0) {
      const zeroY = pad.top + plotH * (1 - (0 - minVal) / range);
      ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(width - pad.right, zeroY); ctx.stroke();
    }

    // Y-axis
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 5; i++) {
      const val = minVal + (range * i) / 5;
      const y = pad.top + plotH * (1 - i / 5);
      ctx.fillText((val * 100).toFixed(1) + "%", pad.left - 5, y + 3);
      ctx.strokeStyle = "#f0f0f0"; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }

    // Draw line
    ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = pad.left + ((data[i].day - 1) / (maxDay - 1)) * plotW;
      const y = pad.top + plotH * (1 - (data[i].avg - minVal) / range);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Month boundaries (approx ~21 trading days per month)
    ctx.fillStyle = "#bbb"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    for (let m = 0; m < 12; m++) {
      const dayApprox = Math.round(m * (maxDay / 12));
      if (dayApprox === 0) continue;
      const x = pad.left + (dayApprox / (maxDay - 1)) * plotW;
      ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke();
      ctx.fillText(MONTH_LABELS[m], x, height - 8);
    }
  }, []);

  // Draw all canvases
  useEffect(() => {
    if (days.length === 0) return;
    if (dowCumulRef.current) drawLineChart(dowCumulRef.current, dowCumulative, DOW_COLORS, DOW_LABELS, DOW_TRADING);
    if (monthCumulRef.current) {
      const activeMonths = Array.from({ length: 12 }, (_, i) => i).filter((m) => monthCumulative[m].length > 0);
      drawLineChart(monthCumulRef.current, monthCumulative, MONTH_COLORS, MONTH_LABELS, activeMonths);
    }
    if (domBarRef.current) drawBarChart(domBarRef.current, domStats);
    if (seasonRef.current) drawSeasonality(seasonRef.current, seasonality);
  }, [days, dowCumulative, monthCumulative, domStats, seasonality, drawLineChart, drawBarChart, drawSeasonality]);

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

      {/* Weekday detailed stats */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日別リターン詳細</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1 px-2 text-left text-gray-500 font-medium"></th>
                {DOW_TRADING.map((dow) => (
                  <th key={dow} className="py-1 px-2 text-center font-medium text-gray-700">{DOW_LABELS[dow]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-500">N</td>
                {DOW_TRADING.map((dow) => (
                  <td key={dow} className="py-1 px-2 text-center font-mono text-gray-600">{dowStats[dow]?.n ?? 0}</td>
                ))}
              </tr>
              <tr className="border-b border-gray-100 bg-gray-50">
                <td className="py-1 px-2 text-gray-500 font-medium" colSpan={6}>前日比 (Close-to-Close)</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">平均</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.close.mean) : ""}`}>{s ? pct(s.close.mean) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">中央値</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.close.median) : ""}`}>{s ? pct(s.close.median) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">標準偏差</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className="py-1 px-2 text-center font-mono text-gray-600">{s ? pct(s.close.std) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">勝率</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className="py-1 px-2 text-center font-mono text-gray-600">{s ? pct2(s.close.winRate) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">p値</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  const pv = s ? pValueLabel(s.close.pValue) : { text: "-", cls: "text-gray-400" };
                  return <td key={dow} className={`py-1 px-2 text-center font-mono ${pv.cls}`}>{pv.text}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100 bg-gray-50">
                <td className="py-1 px-2 text-gray-500 font-medium" colSpan={6}>日中 (Open→Close)</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">平均</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.intraday.mean) : ""}`}>{s ? pct(s.intraday.mean) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">中央値</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.intraday.median) : ""}`}>{s ? pct(s.intraday.median) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">勝率</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className="py-1 px-2 text-center font-mono text-gray-600">{s ? pct2(s.intraday.winRate) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100 bg-gray-50">
                <td className="py-1 px-2 text-gray-500 font-medium" colSpan={6}>夜間 (PrevClose→Open)</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">平均</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.overnight.mean) : ""}`}>{s ? pct(s.overnight.mean) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">中央値</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.overnight.median) : ""}`}>{s ? pct(s.overnight.median) : "-"}</td>;
                })}
              </tr>
              <tr>
                <td className="py-1 px-2 text-gray-400">勝率</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className="py-1 px-2 text-center font-mono text-gray-600">{s ? pct2(s.overnight.winRate) : "-"}</td>;
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Monthly stats */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月別リターン詳細</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1 px-1.5 text-left text-gray-500 font-medium"></th>
                {MONTH_LABELS.map((label, m) => (
                  monthStats[m] && <th key={m} className="py-1 px-1.5 text-center font-medium text-gray-700">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">N</td>
                {monthStats.map((s, m) => s && (
                  <td key={m} className="py-1 px-1.5 text-center font-mono text-gray-600">{s.n}</td>
                ))}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">前日比 平均</td>
                {monthStats.map((s, m) => s && (
                  <td key={m} className={`py-1 px-1.5 text-center font-mono ${colorClass(s.close.mean)}`}>{pct2(s.close.mean)}</td>
                ))}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">標準偏差</td>
                {monthStats.map((s, m) => s && (
                  <td key={m} className="py-1 px-1.5 text-center font-mono text-gray-600">{pct2(s.close.std)}</td>
                ))}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">勝率</td>
                {monthStats.map((s, m) => s && (
                  <td key={m} className="py-1 px-1.5 text-center font-mono text-gray-600">{pct2(s.close.winRate)}</td>
                ))}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">p値</td>
                {monthStats.map((s, m) => {
                  if (!s) return null;
                  const pv = pValueLabel(s.close.pValue);
                  return <td key={m} className={`py-1 px-1.5 text-center font-mono ${pv.cls}`}>{pv.text}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">日中 平均</td>
                {monthStats.map((s, m) => s && (
                  <td key={m} className={`py-1 px-1.5 text-center font-mono ${colorClass(s.intraday.mean)}`}>{pct2(s.intraday.mean)}</td>
                ))}
              </tr>
              <tr>
                <td className="py-1 px-1.5 text-gray-500">夜間 平均</td>
                {monthStats.map((s, m) => s && (
                  <td key={m} className={`py-1 px-1.5 text-center font-mono ${colorClass(s.overnight.mean)}`}>{pct2(s.overnight.mean)}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Week-of-month stats */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月内週番号別リターン (第1週〜第5週)</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1 px-2 text-left text-gray-500 font-medium"></th>
                {[1, 2, 3, 4, 5].map((w) => (
                  <th key={w} className="py-1 px-2 text-center font-medium text-gray-700">第{w}週</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-500">N</td>
                {womStats.map((s, i) => (
                  <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{s?.n ?? 0}</td>
                ))}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-500">平均</td>
                {womStats.map((s, i) => (
                  <td key={i} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.mean) : ""}`}>{s ? pct(s.mean) : "-"}</td>
                ))}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-500">標準偏差</td>
                {womStats.map((s, i) => (
                  <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{s ? pct(s.std) : "-"}</td>
                ))}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-500">勝率</td>
                {womStats.map((s, i) => (
                  <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{s ? pct2(s.winRate) : "-"}</td>
                ))}
              </tr>
              <tr>
                <td className="py-1 px-2 text-gray-500">p値</td>
                {womStats.map((s, i) => {
                  const pv = s ? pValueLabel(s.pValue) : { text: "-", cls: "text-gray-400" };
                  return <td key={i} className={`py-1 px-2 text-center font-mono ${pv.cls}`}>{pv.text}</td>;
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Weekday x Month cross table */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日 x 月 クロス集計 (前日比 平均)</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1 px-1.5 text-left text-gray-500 font-medium"></th>
                {MONTH_LABELS.map((label, m) => {
                  const hasData = DOW_TRADING.some((dow) => crossStats[dow][m] !== null);
                  return hasData && <th key={m} className="py-1 px-1.5 text-center font-medium text-gray-700">{label}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {DOW_TRADING.map((dow) => (
                <tr key={dow} className="border-b border-gray-100">
                  <td className="py-1 px-1.5 text-gray-600 font-medium">{DOW_LABELS[dow]}</td>
                  {MONTH_LABELS.map((_, m) => {
                    const hasData = DOW_TRADING.some((d) => crossStats[d][m] !== null);
                    if (!hasData) return null;
                    const cell = crossStats[dow][m];
                    if (!cell) return <td key={m} className="py-1 px-1.5 text-center text-gray-300">-</td>;
                    return (
                      <td key={m} className={`py-1 px-1.5 text-center font-mono ${colorClass(cell.mean)}`} title={`N=${cell.n}`}>
                        {pct2(cell.mean)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Previous day conditional */}
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
                <tr className="border-b border-gray-100">
                  <td className="py-1 px-2 text-gray-600">前日上昇後</td>
                  <td className="py-1 px-2 text-center font-mono text-gray-600">{conditionalStats.afterUp.n}</td>
                  <td className={`py-1 px-2 text-center font-mono ${colorClass(conditionalStats.afterUp.mean)}`}>{pct(conditionalStats.afterUp.mean)}</td>
                  <td className="py-1 px-2 text-center font-mono text-gray-600">{pct2(conditionalStats.afterUp.winRate)}</td>
                  {(() => { const pv = pValueLabel(conditionalStats.afterUp.pValue); return <td className={`py-1 px-2 text-center font-mono ${pv.cls}`}>{pv.text}</td>; })()}
                </tr>
                <tr>
                  <td className="py-1 px-2 text-gray-600">前日下落後</td>
                  <td className="py-1 px-2 text-center font-mono text-gray-600">{conditionalStats.afterDown.n}</td>
                  <td className={`py-1 px-2 text-center font-mono ${colorClass(conditionalStats.afterDown.mean)}`}>{pct(conditionalStats.afterDown.mean)}</td>
                  <td className="py-1 px-2 text-center font-mono text-gray-600">{pct2(conditionalStats.afterDown.winRate)}</td>
                  {(() => { const pv = pValueLabel(conditionalStats.afterDown.pValue); return <td className={`py-1 px-2 text-center font-mono ${pv.cls}`}>{pv.text}</td>; })()}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Day-of-month bar chart */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月内日別 平均リターン (Turn of Month効果)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden">
          <canvas ref={domBarRef} />
        </div>
      </div>

      {/* Cumulative return by weekday */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日別 累積リターン</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden">
          <canvas ref={dowCumulRef} />
        </div>
      </div>

      {/* Monthly cumulative return */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月別 累積リターン</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden">
          <canvas ref={monthCumulRef} />
        </div>
      </div>

      {/* Annual seasonality curve */}
      <div>
        <div className="text-xs text-gray-500 mb-1">年間シーズナリティ曲線 (年平均 累積リターン推移)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden">
          <canvas ref={seasonRef} />
        </div>
      </div>

      {/* Streak analysis */}
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
