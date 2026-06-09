"use client";

import React, { useMemo, useCallback, useRef, useEffect, useState } from "react";
import { PricePoint } from "../../lib/types";
import type { PeriodKey } from "../../hooks/useAnalysisData";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const DOW_TRADING = [1, 2, 3, 4, 5];
// distinct colors per weekday for distribution overlay (index = getDay())
const DOW_COLORS_DIST = ["#999", "#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#999"];
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
  openReturn: number;
  highReturn: number;
  lowReturn: number;
  logCloseReturn: number;
  logIntradayReturn: number;
  logOvernightReturn: number;
}

type ReturnTab = "rate" | "ohlc" | "log";

interface BarDef {
  color: string;
  label: string;
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
function skewness(a: number[]): number {
  const n = a.length; if (n < 3) return 0;
  const m = mean(a), s = std(a); if (s === 0) return 0;
  return (n / ((n - 1) * (n - 2))) * a.reduce((acc, v) => acc + ((v - m) / s) ** 3, 0);
}
function kurtosisExcess(a: number[]): number {
  const n = a.length; if (n < 4) return 0;
  const m = mean(a), s = std(a); if (s === 0) return 0;
  const num = a.reduce((acc, v) => acc + ((v - m) / s) ** 4, 0);
  return (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3)) * num - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
}
function normalPdf(x: number, m: number, s: number): number {
  if (s <= 0) return 0;
  return Math.exp(-((x - m) ** 2) / (2 * s * s)) / (s * Math.sqrt(2 * Math.PI));
}
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

// Return field keys for each raw data bucket
type RawFieldKey = "close" | "intraday" | "overnight" | "open" | "high" | "low" | "logClose" | "logIntraday" | "logOvernight";
type RawBucket = Record<RawFieldKey, number[]>;

const TAB_DEFS: Record<ReturnTab, { barDefs: BarDef[]; fields: RawFieldKey[] }> = {
  rate: {
    barDefs: [
      { color: "#3b82f6", label: "前C→当C" },
      { color: "#22c55e", label: "当O→当C" },
      { color: "#f59e0b", label: "前C→当O" },
    ],
    fields: ["close", "intraday", "overnight"],
  },
  ohlc: {
    barDefs: [
      { color: "#3b82f6", label: "前C→当C" },
      { color: "#8b5cf6", label: "前O→当O" },
      { color: "#ef4444", label: "前H→当H" },
      { color: "#06b6d4", label: "前L→当L" },
    ],
    fields: ["close", "open", "high", "low"],
  },
  log: {
    barDefs: [
      { color: "#3b82f6", label: "ln 前C→当C" },
      { color: "#22c55e", label: "ln 当O→当C" },
      { color: "#f59e0b", label: "ln 前C→当O" },
    ],
    fields: ["logClose", "logIntraday", "logOvernight"],
  },
};

// Interactive distribution explorer: selectable return fields
const DIST_FIELDS: { key: RawFieldKey; label: string; group: string }[] = [
  { key: "close", label: "前C→当C", group: "変化率" },
  { key: "intraday", label: "当O→当C (日中)", group: "変化率" },
  { key: "overnight", label: "前C→当O (夜間)", group: "変化率" },
  { key: "open", label: "前O→当O", group: "OHLC" },
  { key: "high", label: "前H→当H", group: "OHLC" },
  { key: "low", label: "前L→当L", group: "OHLC" },
  { key: "logClose", label: "ln 前C→当C", group: "対数" },
  { key: "logIntraday", label: "ln 当O→当C", group: "対数" },
  { key: "logOvernight", label: "ln 前C→当O", group: "対数" },
];

function makeRawBucket(): RawBucket {
  return { close: [], intraday: [], overnight: [], open: [], high: [], low: [], logClose: [], logIntraday: [], logOvernight: [] };
}

function computeFieldStats(arr: number[]) {
  return { mean: mean(arr), median: median(arr), std: std(arr), winRate: winRate(arr), pValue: tTestPValue(arr) };
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
  const distRef = useRef<HTMLCanvasElement>(null);

  const [returnTab, setReturnTab] = useState<ReturnTab>("rate");

  // === interactive distribution explorer state ===
  const [distField, setDistField] = useState<RawFieldKey>("close");
  const [distDows, setDistDows] = useState<number[]>([1, 2, 3, 4, 5]); // -1 = 全営業日
  const [distShowNormal, setDistShowNormal] = useState(true);
  const [distShowHist, setDistShowHist] = useState(true);
  const toggleDow = useCallback((dow: number) => {
    setDistDows(prev => prev.includes(dow) ? prev.filter(d => d !== dow) : [...prev, dow].sort((a, b) => a - b));
  }, []);

  // === core data ===
  const days: DayData[] = useMemo(() => {
    if (prices.length < 2) return [];
    const yc: Record<number, number> = {};
    return prices.slice(1).map((p, i) => {
      const prev = prices[i], d = new Date(p.time);
      const pc = prev.close || 1, op = p.open || pc;
      const po = prev.open || 1, ph = prev.high || 1, pl = prev.low || 1;
      const y = d.getFullYear();
      yc[y] = (yc[y] || 0) + 1;
      return {
        date: p.time, dayOfWeek: d.getDay(), month: d.getMonth(), year: y,
        dayOfMonth: d.getDate(), weekOfMonth: Math.ceil(d.getDate() / 7),
        tradingDayOfYear: yc[y],
        closeReturn: (p.close - pc) / pc,
        intradayReturn: (p.close - op) / op,
        overnightReturn: (op - pc) / pc,
        openReturn: (p.open - po) / po,
        highReturn: (p.high - ph) / ph,
        lowReturn: (p.low - pl) / pl,
        logCloseReturn: Math.log(p.close / pc),
        logIntradayReturn: Math.log(p.close / op),
        logOvernightReturn: Math.log(op / pc),
      };
    });
  }, [prices]);

  // === weekday raw returns ===
  const dowRaw = useMemo(() => {
    const r: Record<number, RawBucket> = {};
    for (const dow of DOW_TRADING) r[dow] = makeRawBucket();
    for (const d of days) {
      if (!(d.dayOfWeek in r)) continue;
      const b = r[d.dayOfWeek];
      b.close.push(d.closeReturn);
      b.intraday.push(d.intradayReturn);
      b.overnight.push(d.overnightReturn);
      b.open.push(d.openReturn);
      b.high.push(d.highReturn);
      b.low.push(d.lowReturn);
      b.logClose.push(d.logCloseReturn);
      b.logIntraday.push(d.logIntradayReturn);
      b.logOvernight.push(d.logOvernightReturn);
    }
    return r;
  }, [days]);

  // === all trading days combined (for distribution baseline) ===
  const overallRaw = useMemo(() => {
    const b = makeRawBucket();
    for (const d of days) {
      if (!DOW_TRADING.includes(d.dayOfWeek)) continue;
      b.close.push(d.closeReturn);
      b.intraday.push(d.intradayReturn);
      b.overnight.push(d.overnightReturn);
      b.open.push(d.openReturn);
      b.high.push(d.highReturn);
      b.low.push(d.lowReturn);
      b.logClose.push(d.logCloseReturn);
      b.logIntraday.push(d.logIntradayReturn);
      b.logOvernight.push(d.logOvernightReturn);
    }
    return b;
  }, [days]);

  // === distribution explorer: groups for current selection ===
  const distGroups = useMemo(() => {
    return distDows.map(dow => {
      const bucket = dow === -1 ? overallRaw : dowRaw[dow];
      const values = bucket ? bucket[distField] : [];
      return {
        dow,
        label: dow === -1 ? "全営業日" : DOW_LABELS[dow],
        color: dow === -1 ? "#6b7280" : DOW_COLORS_DIST[dow],
        values,
      };
    }).filter(g => g.values.length > 0);
  }, [distDows, distField, dowRaw, overallRaw]);

  // === weekday computed stats ===
  const dowStats = useMemo(() =>
    DOW_TRADING.map(dow => {
      const c = dowRaw[dow]; if (!c || c.close.length === 0) return null;
      const result: Record<string, { mean: number; median: number; std: number; winRate: number; pValue: number | null }> & { n: number } = { n: c.close.length } as any;
      for (const key of Object.keys(c) as RawFieldKey[]) {
        (result as any)[key] = computeFieldStats(c[key]);
      }
      return result;
    })
  , [dowRaw]);

  // === monthly raw returns ===
  const monthRaw = useMemo(() => {
    const r = Array.from({ length: 12 }, () => makeRawBucket());
    for (const d of days) {
      const b = r[d.month];
      b.close.push(d.closeReturn);
      b.intraday.push(d.intradayReturn);
      b.overnight.push(d.overnightReturn);
      b.open.push(d.openReturn);
      b.high.push(d.highReturn);
      b.low.push(d.lowReturn);
      b.logClose.push(d.logCloseReturn);
      b.logIntraday.push(d.logIntradayReturn);
      b.logOvernight.push(d.logOvernightReturn);
    }
    return r;
  }, [days]);

  const monthStats = useMemo(() =>
    monthRaw.map(s => {
      if (s.close.length === 0) return null;
      const result: Record<string, { mean: number; median: number; std: number; winRate: number; pValue: number | null }> & { n: number } = { n: s.close.length } as any;
      for (const key of Object.keys(s) as RawFieldKey[]) {
        (result as any)[key] = computeFieldStats(s[key]);
      }
      return result;
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
    const weeks: number[][] = [];
    let curWeek: number[] = [];
    for (const d of days) {
      if (d.dayOfWeek === 1 && curWeek.length > 0) { weeks.push(curWeek); curWeek = []; }
      if (d.dayOfWeek >= 1 && d.dayOfWeek <= 5) curWeek.push(d.closeReturn);
    }
    if (curWeek.length > 0) weeks.push(curWeek);
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

  // =============== DRAW FUNCTIONS ===============

  // Grouped bar chart (generic: variable number of bars)
  const drawGroupedBar = useCallback((
    canvas: HTMLCanvasElement,
    labels: string[],
    barData: number[][],   // barData[barIdx][groupIdx]
    barDefs: BarDef[],
  ) => {
    const r = initCanvas(canvas, 200); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 15, bottom: 30, left: 55, right: 15 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const vals = barData.flat();
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

    const nGroups = labels.length;
    const nBars = barDefs.length;
    const groupW = plotW / nGroups;
    const barW = Math.max(3, groupW / (nBars * 1.5));
    const gap = barW * 0.3;
    const totalBarWidth = nBars * barW + (nBars - 1) * gap;

    for (let i = 0; i < nGroups; i++) {
      const cx = pad.left + (i + 0.5) * groupW;
      const startX = cx - totalBarWidth / 2;
      for (let j = 0; j < nBars; j++) {
        const x = startX + j * (barW + gap);
        const val = barData[j][i];
        const barH = (val / maxAbs) * (plotH / 2);
        ctx.fillStyle = barDefs[j].color;
        ctx.fillRect(x, zeroY - Math.max(barH, 0), barW, Math.abs(barH));
      }
      ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(labels[i], cx, height - 14);
    }

    // legend
    ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    let lx = pad.left;
    for (const def of barDefs) {
      ctx.fillStyle = def.color; ctx.fillRect(lx, height - 5, 10, 3);
      ctx.fillStyle = "#666"; ctx.fillText(def.label, lx + 13, height - 1);
      lx += ctx.measureText(def.label).width + 25;
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
    minV = Math.min(minV, 0); maxV = Math.max(maxV, 0);
    const range = maxV - minV || 0.01;
    const toY = (v: number) => pad.top + plotH * (1 - (v - minV) / range);

    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, toY(0)); ctx.lineTo(width - pad.right, toY(0)); ctx.stroke();

    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const val = minV + (range * i) / 4;
      const y = pad.top + plotH * (1 - i / 4);
      ctx.fillText((val * 100).toFixed(3) + "%", pad.left - 5, y + 3);
      ctx.strokeStyle = "#f0f0f0"; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }

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

    ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = pad.left + (data[i].pos / 4) * plotW;
      const y = toY(data[i].avg);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

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

  // Interactive distribution explorer (histogram + KDE + normal overlay)
  const drawDistribution = useCallback((
    canvas: HTMLCanvasElement,
    groups: { label: string; color: string; values: number[] }[],
    showHist: boolean,
    showNormal: boolean,
  ) => {
    const r = initCanvas(canvas, 300); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 15, bottom: 40, left: 50, right: 15 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;

    const all = groups.flatMap(g => g.values);
    if (all.length < 5) {
      ctx.fillStyle = "#9ca3af"; ctx.font = "12px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("選択された組み合わせのデータが不足しています", width / 2, height / 2);
      return;
    }
    const sortedAll = [...all].sort((a, b) => a - b);
    let lo = quantile(sortedAll, 0.005), hi = quantile(sortedAll, 0.995);
    if (lo === hi) { lo -= 0.01; hi += 0.01; }
    const single = groups.length === 1;

    const GRID = 160;
    const toX = (v: number) => pad.left + ((v - lo) / (hi - lo)) * plotW;

    // KDE per group
    const kdeCurves = groups.map(g => {
      const vals = g.values.filter(v => v >= lo - (hi - lo) && v <= hi + (hi - lo));
      const n = vals.length || 1;
      const s = std(g.values);
      const sorted = [...g.values].sort((a, b) => a - b);
      const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
      const sigma = Math.min(s || 1e-9, iqr > 0 ? iqr / 1.349 : Infinity);
      const h = 0.9 * (isFinite(sigma) ? sigma : (s || 1e-9)) * Math.pow(n, -0.2) || 1e-9;
      const pts: number[] = [];
      for (let i = 0; i < GRID; i++) {
        const x = lo + ((hi - lo) * i) / (GRID - 1);
        let f = 0;
        for (const xi of g.values) f += normalPdf((x - xi) / h, 0, 1);
        pts.push(f / (g.values.length * h));
      }
      return { group: g, density: pts, mean: mean(g.values), std: s };
    });

    // histogram (single group only)
    let hist: { x0: number; x1: number; dens: number }[] = [];
    if (single && showHist) {
      const nBins = 40;
      const binW = (hi - lo) / nBins;
      const counts = new Array(nBins).fill(0);
      const vals = groups[0].values;
      let inRange = 0;
      for (const v of vals) {
        if (v < lo || v > hi) continue;
        const bi = Math.min(nBins - 1, Math.floor((v - lo) / binW));
        counts[bi]++; inRange++;
      }
      hist = counts.map((c, i) => ({ x0: lo + i * binW, x1: lo + (i + 1) * binW, dens: inRange ? c / (inRange * binW) : 0 }));
    }

    // y max
    let yMax = 0;
    for (const c of kdeCurves) for (const d of c.density) yMax = Math.max(yMax, d);
    for (const b of hist) yMax = Math.max(yMax, b.dens);
    if (single && showNormal) {
      const m = kdeCurves[0].mean, s = kdeCurves[0].std;
      for (let i = 0; i < GRID; i++) { const x = lo + ((hi - lo) * i) / (GRID - 1); yMax = Math.max(yMax, normalPdf(x, m, s)); }
    }
    yMax *= 1.1; if (yMax <= 0) yMax = 1;
    const toY = (d: number) => pad.top + plotH * (1 - d / yMax);

    // y grid + labels
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const d = (yMax * i) / 4, y = pad.top + plotH * (1 - i / 4);
      ctx.fillText(d.toFixed(d < 10 ? 1 : 0), pad.left - 5, y + 3);
      ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }

    // x grid + zero line
    ctx.textAlign = "center";
    for (let i = 0; i <= 6; i++) {
      const v = lo + ((hi - lo) * i) / 6, x = pad.left + (plotW * i) / 6;
      ctx.strokeStyle = "#f3f4f6"; ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke();
      ctx.fillStyle = "#999"; ctx.fillText((v * 100).toFixed(2) + "%", x, height - 24);
    }
    if (lo <= 0 && hi >= 0) {
      const zx = toX(0);
      ctx.strokeStyle = "#9ca3af"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(zx, pad.top); ctx.lineTo(zx, pad.top + plotH); ctx.stroke();
      ctx.setLineDash([]);
    }

    // histogram bars
    for (const b of hist) {
      const x0 = toX(b.x0), x1 = toX(b.x1);
      const y = toY(b.dens);
      ctx.fillStyle = groups[0].color + "26";
      ctx.fillRect(x0, y, Math.max(1, x1 - x0 - 1), pad.top + plotH - y);
    }

    // normal overlay (single)
    if (single && showNormal) {
      const m = kdeCurves[0].mean, s = kdeCurves[0].std;
      ctx.strokeStyle = "#111827"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.beginPath();
      for (let i = 0; i < GRID; i++) {
        const x = lo + ((hi - lo) * i) / (GRID - 1);
        const px = toX(x), py = toY(normalPdf(x, m, s));
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }

    // KDE curves + mean markers
    for (const c of kdeCurves) {
      ctx.strokeStyle = c.group.color; ctx.lineWidth = 2; ctx.beginPath();
      for (let i = 0; i < GRID; i++) {
        const x = lo + ((hi - lo) * i) / (GRID - 1);
        const px = toX(x), py = toY(c.density[i]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      // mean marker (triangle on axis)
      const mx = toX(Math.max(lo, Math.min(hi, c.mean)));
      ctx.fillStyle = c.group.color;
      ctx.beginPath(); ctx.moveTo(mx, pad.top + plotH); ctx.lineTo(mx - 4, pad.top + plotH + 6); ctx.lineTo(mx + 4, pad.top + plotH + 6); ctx.closePath(); ctx.fill();
    }

    // legend
    ctx.font = "9px sans-serif"; ctx.textAlign = "left"; let lx = pad.left;
    for (const c of kdeCurves) {
      ctx.strokeStyle = c.group.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx, height - 6); ctx.lineTo(lx + 14, height - 6); ctx.stroke();
      ctx.fillStyle = "#666"; ctx.fillText(c.group.label, lx + 17, height - 3);
      lx += ctx.measureText(c.group.label).width + 30;
    }
    if (single && showNormal) {
      ctx.strokeStyle = "#111827"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(lx, height - 6); ctx.lineTo(lx + 14, height - 6); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#666"; ctx.fillText("正規分布", lx + 17, height - 3);
    }
  }, []);

  // === helper to get bar data from raw buckets for current tab ===
  const getBarData = useCallback((raw: RawBucket[], tab: ReturnTab): { barData: number[][]; barDefs: BarDef[] } => {
    const def = TAB_DEFS[tab];
    const barData = def.fields.map(field => raw.map(b => mean(b[field])));
    return { barData, barDefs: def.barDefs };
  }, []);

  // === helper to get box plot data from raw buckets for current tab ===
  const getBoxData = useCallback((raw: RawBucket[], tab: ReturnTab): { labels: string[]; arrays: number[][]; colors: string[] } => {
    const def = TAB_DEFS[tab];
    const labels: string[] = [];
    const arrays: number[][] = [];
    const colors: string[] = [];
    for (const rawBucket of raw) {
      for (let j = 0; j < def.fields.length; j++) {
        labels.push(def.barDefs[j].label);
        arrays.push(rawBucket[def.fields[j]]);
        colors.push(def.barDefs[j].color);
      }
    }
    return { labels, arrays, colors };
  }, []);

  // === Draw all canvases ===
  useEffect(() => {
    if (days.length === 0) return;

    const tabDef = TAB_DEFS[returnTab];

    // 1. Weekday grouped bar
    if (dowBarRef.current) {
      const rawArr = DOW_TRADING.map(dow => dowRaw[dow]);
      const { barData, barDefs } = getBarData(rawArr, returnTab);
      drawGroupedBar(dowBarRef.current, DOW_TRADING.map(d => DOW_LABELS[d]), barData, barDefs);
    }

    // 2. Monthly grouped bar
    if (monthBarRef.current) {
      const activeMonths = monthRaw.map((_, i) => i).filter(m => monthRaw[m].close.length > 0);
      const rawArr = activeMonths.map(m => monthRaw[m]);
      const { barData, barDefs } = getBarData(rawArr, returnTab);
      drawGroupedBar(monthBarRef.current, activeMonths.map(m => MONTH_LABELS[m]), barData, barDefs);
    }

    // 3. Box plot (weekday, tab-linked)
    if (dowBoxRef.current) {
      const rawArr = DOW_TRADING.map(dow => dowRaw[dow]);
      const dowLabelsForBox: string[] = [];
      const boxArrays: number[][] = [];
      const boxColors: string[] = [];
      for (let i = 0; i < rawArr.length; i++) {
        for (let j = 0; j < tabDef.fields.length; j++) {
          dowLabelsForBox.push(DOW_LABELS[DOW_TRADING[i]] + " " + tabDef.barDefs[j].label);
          boxArrays.push(rawArr[i][tabDef.fields[j]]);
          boxColors.push(tabDef.barDefs[j].color);
        }
      }
      drawBoxPlot(dowBoxRef.current, dowLabelsForBox, boxArrays, boxColors);
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
  }, [days, dowRaw, monthRaw, crossStats, crossMaxAbs, intraweekData, yearMonthData, womStats, dowCumulative, monthCumulative, domStats, seasonality, returnTab, drawGroupedBar, drawBoxPlot, drawCrossHeatmap, drawIntraweek, drawYearMonth, drawWomBar, drawLineChart, drawDomBar, drawSeasonality, getBarData, getBoxData]);

  // === Draw interactive distribution explorer ===
  useEffect(() => {
    if (distRef.current) drawDistribution(distRef.current, distGroups, distShowHist, distShowNormal);
  }, [distGroups, distShowHist, distShowNormal, drawDistribution]);

  if (days.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="font-bold text-gray-800 mb-3">カレンダー分析</h3>
        <p className="text-xs text-gray-400">データが不足しています。</p>
      </div>
    );
  }

  const tabDef = TAB_DEFS[returnTab];
  const tabButtons = (
    <div className="flex gap-1 mb-2">
      {([["rate", "変化率"], ["ohlc", "OHLC"], ["log", "対数"]] as [ReturnTab, string][]).map(([key, label]) => (
        <button
          key={key}
          onClick={() => setReturnTab(key)}
          className={`px-2.5 py-1 text-xs rounded transition-colors ${
            returnTab === key
              ? "bg-blue-600 text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-5">
      <h3 className="font-bold text-gray-800">カレンダー分析</h3>

      {/* Tab selector */}
      {tabButtons}

      {/* ===== 1. Weekday grouped bar ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日別 平均リターン比較 ({tabDef.barDefs.map(d => d.label).join(" / ")})</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={dowBarRef} /></div>
      </div>

      {/* ===== 2. Weekday box plot ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日別 リターン分布 (箱ひげ図 - {tabDef.barDefs.map(d => d.label).join(" / ")})</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={dowBoxRef} /></div>
      </div>

      {/* ===== Interactive distribution explorer ===== */}
      <div className="border border-blue-100 rounded-lg p-3 bg-blue-50/30">
        <div className="text-sm font-medium text-gray-700 mb-2">
          曜日別リターン分布エクスプローラ
          <span className="text-xs font-normal text-gray-400">（曜日とリターン種別を選んで分布の形を比較）</span>
        </div>

        {/* return field selector */}
        <div className="mb-2">
          <div className="text-[11px] text-gray-400 mb-1">リターン種別</div>
          <div className="flex flex-wrap gap-1">
            {DIST_FIELDS.map(f => (
              <button
                key={f.key}
                onClick={() => setDistField(f.key)}
                className={`px-2 py-0.5 text-[11px] rounded transition-colors ${distField === f.key ? "bg-blue-600 text-white" : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-100"}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* weekday selector */}
        <div className="mb-2">
          <div className="text-[11px] text-gray-400 mb-1">曜日（複数選択で形状を重ね比較）</div>
          <div className="flex flex-wrap gap-1 items-center">
            {DOW_TRADING.map(dow => {
              const active = distDows.includes(dow);
              return (
                <button
                  key={dow}
                  onClick={() => toggleDow(dow)}
                  style={active ? { backgroundColor: DOW_COLORS_DIST[dow], color: "#fff" } : undefined}
                  className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${active ? "" : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-100"}`}
                >
                  {DOW_LABELS[dow]}
                </button>
              );
            })}
            <button
              onClick={() => toggleDow(-1)}
              style={distDows.includes(-1) ? { backgroundColor: "#6b7280", color: "#fff" } : undefined}
              className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${distDows.includes(-1) ? "" : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-100"}`}
            >
              全営業日
            </button>
            <span className="mx-1 text-gray-300">|</span>
            <button onClick={() => setDistDows([1, 2, 3, 4, 5])} className="px-2 py-0.5 text-[11px] rounded bg-white text-gray-500 border border-gray-200 hover:bg-gray-100">全曜日</button>
          </div>
        </div>

        {/* options */}
        <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2 text-[11px] text-gray-500">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={distShowHist} onChange={e => setDistShowHist(e.target.checked)} className="accent-blue-600" />
            ヒストグラム
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={distShowNormal} onChange={e => setDistShowNormal(e.target.checked)} className="accent-gray-700" />
            正規分布を重ねる
          </label>
          <span className="text-gray-400">※ ヒストグラム/正規分布は曜日を1つだけ選択したとき表示</span>
        </div>

        <div className="w-full rounded border border-gray-100 bg-white overflow-hidden"><canvas ref={distRef} /></div>

        {/* stats table */}
        {distGroups.length > 0 && (
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="py-1 px-2 text-left text-gray-500 font-medium">曜日</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">N</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">平均</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">中央値</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">標準偏差</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">歪度</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">尖度</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">勝率</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">p値</th>
                </tr>
              </thead>
              <tbody>
                {distGroups.map(g => {
                  const v = g.values;
                  const mn = mean(v), pv = pValueLabel(tTestPValue(v));
                  return (
                    <tr key={g.dow} className="border-b border-gray-100">
                      <td className="py-1 px-2 font-medium" style={{ color: g.color }}>{g.label}</td>
                      <td className="py-1 px-2 text-center font-mono text-gray-600">{v.length}</td>
                      <td className={`py-1 px-2 text-center font-mono ${colorClass(mn)}`}>{pct(mn)}</td>
                      <td className={`py-1 px-2 text-center font-mono ${colorClass(median(v))}`}>{pct(median(v))}</td>
                      <td className="py-1 px-2 text-center font-mono text-gray-600">{pct(std(v))}</td>
                      <td className="py-1 px-2 text-center font-mono text-gray-600">{skewness(v).toFixed(2)}</td>
                      <td className="py-1 px-2 text-center font-mono text-gray-600">{kurtosisExcess(v).toFixed(2)}</td>
                      <td className="py-1 px-2 text-center font-mono text-gray-600">{pct2(winRate(v))}</td>
                      <td className={`py-1 px-2 text-center font-mono ${pv.cls}`}>{pv.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ===== Weekday detailed stats table ===== */}
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
                {dowStats.map((s, i) => <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{s?.n ?? 0}</td>)}
              </tr>
              {tabDef.fields.map((field, fi) => {
                const label = tabDef.barDefs[fi].label;
                const isFirst = fi === 0;
                return (
                  <React.Fragment key={field}>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <td className="py-1 px-2 text-gray-500 font-medium" colSpan={6}>{label}</td>
                    </tr>
                    {(isFirst ? ["mean", "median", "std", "winRate", "pValue"] as const : ["mean", "median", "winRate"] as const).map(key => (
                      <tr key={`${field}-${key}`} className="border-b border-gray-100">
                        <td className="py-1 px-2 text-gray-400">{key === "mean" ? "平均" : key === "median" ? "中央値" : key === "std" ? "標準偏差" : key === "winRate" ? "勝率" : "p値"}</td>
                        {dowStats.map((s, i) => {
                          if (!s) return <td key={i} className="py-1 px-2 text-center">-</td>;
                          const fieldStats = (s as any)[field] as { mean: number; median: number; std: number; winRate: number; pValue: number | null };
                          if (!fieldStats) return <td key={i} className="py-1 px-2 text-center">-</td>;
                          if (key === "pValue") { const pv = pValueLabel(fieldStats.pValue); return <td key={i} className={`py-1 px-2 text-center font-mono ${pv.cls}`}>{pv.text}</td>; }
                          if (key === "winRate") return <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{pct2(fieldStats.winRate)}</td>;
                          if (key === "std") return <td key={i} className="py-1 px-2 text-center font-mono text-gray-600">{pct(fieldStats.std)}</td>;
                          const v = fieldStats[key]; return <td key={i} className={`py-1 px-2 text-center font-mono ${colorClass(v)}`}>{pct(v)}</td>;
                        })}
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ===== 3. Monthly grouped bar ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月別 平均リターン比較 ({tabDef.barDefs.map(d => d.label).join(" / ")})</div>
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
              {tabDef.fields.map((field, fi) => {
                const label = tabDef.barDefs[fi].label;
                const isFirst = fi === 0;
                return (
                  <React.Fragment key={field}>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <td className="py-1 px-1.5 text-gray-500 font-medium" colSpan={13}>{label}</td>
                    </tr>
                    <tr className="border-b border-gray-100">
                      <td className="py-1 px-1.5 text-gray-500">平均</td>
                      {monthStats.map((s, m) => { if (!s) return null; const fs = (s as any)[field]; if (!fs) return null; return <td key={m} className={`py-1 px-1.5 text-center font-mono ${colorClass(fs.mean)}`}>{pct2(fs.mean)}</td>; })}
                    </tr>
                    {isFirst && (
                      <>
                        <tr className="border-b border-gray-100">
                          <td className="py-1 px-1.5 text-gray-500">標準偏差</td>
                          {monthStats.map((s, m) => { if (!s) return null; const fs = (s as any)[field]; if (!fs) return null; return <td key={m} className="py-1 px-1.5 text-center font-mono text-gray-600">{pct2(fs.std)}</td>; })}
                        </tr>
                        <tr className="border-b border-gray-100">
                          <td className="py-1 px-1.5 text-gray-500">勝率</td>
                          {monthStats.map((s, m) => { if (!s) return null; const fs = (s as any)[field]; if (!fs) return null; return <td key={m} className="py-1 px-1.5 text-center font-mono text-gray-600">{pct2(fs.winRate)}</td>; })}
                        </tr>
                        <tr className="border-b border-gray-100">
                          <td className="py-1 px-1.5 text-gray-500">p値</td>
                          {monthStats.map((s, m) => { if (!s) return null; const fs = (s as any)[field]; if (!fs) return null; const pv = pValueLabel(fs.pValue); return <td key={m} className={`py-1 px-1.5 text-center font-mono ${pv.cls}`}>{pv.text}</td>; })}
                        </tr>
                      </>
                    )}
                  </React.Fragment>
                );
              })}
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
        <div className="text-xs text-gray-500 mb-1">曜日 x 月 ヒートマップ (前C→当C 平均)</div>
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

      <AnalysisGuide title="カレンダー分析の読み方">
        <p><span className="font-medium">リターン種別（タブ切替）:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">変化率タブ:</span> 前C→当C = (Close_t - Close_&#123;t-1&#125;) / Close_&#123;t-1&#125;（前日終値→当日終値）、当O→当C = (Close_t - Open_t) / Open_t（当日始値→当日終値＝日中リターン）、前C→当O = (Open_t - Close_&#123;t-1&#125;) / Close_&#123;t-1&#125;（前日終値→当日始値＝夜間リターン）</li>
          <li><span className="font-medium">OHLCタブ:</span> 前C→当C に加え、前O→当O = (Open_t - Open_&#123;t-1&#125;) / Open_&#123;t-1&#125;、前H→当H = (High_t - High_&#123;t-1&#125;) / High_&#123;t-1&#125;、前L→当L = (Low_t - Low_&#123;t-1&#125;) / Low_&#123;t-1&#125;。OHLC各価格の前日比を比較し、寄付・高値・安値それぞれの曜日/月パターンを把握。</li>
          <li><span className="font-medium">対数タブ:</span> ln 前C→当C = ln(Close_t / Close_&#123;t-1&#125;)、ln 当O→当C = ln(Close_t / Open_t)、ln 前C→当O = ln(Open_t / Close_&#123;t-1&#125;)。対数リターンは加法性を持ち、複利計算・長期累積に適する。</li>
        </ul>
        <p className="mt-2"><span className="font-medium">曜日別リターン分布エクスプローラ:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">何を見るか:</span> 平均や中央値といった「代表値」だけでは、リターンの<span className="font-medium">分布の形（裾の厚さ・非対称性・二峰性）</span>はわかりません。本ツールは曜日とリターン種別を選ぶと、その組み合わせの実データの分布を即座に描画します。例えば「金曜の夜間リターン（前C→当O）」だけを抜き出して、暴落側に裾が伸びているか等を直接確認できます。</li>
          <li><span className="font-medium">ヒストグラム:</span> リターンを40区間に分け、各区間の出現頻度を「密度（縦軸 = 頻度 / (総数 × 区間幅)）」に正規化した棒グラフ。面積の合計が1になるため、後述の密度曲線・正規分布と直接重ねて比較できます。</li>
          <li><span className="font-medium">KDE（カーネル密度推定）曲線:</span> ヒストグラムの区切り位置に依存しない、滑らかな確率密度の推定。各データ点に正規カーネル（小さな釣鐘）を置いて足し合わせます。式は f(x) = (1 / (n·h)) Σ&#123;i=1..n&#125; K((x − x_i) / h)。ここで K は標準正規の確率密度、h は平滑化の幅（バンド幅）で、Silvermanの目安 h = 0.9 × min(σ, IQR/1.349) × n^(−1/5) を用います（σ=標準偏差、IQR=四分位範囲）。複数曜日を選ぶと各曜日の曲線が色分けで重なり、<span className="font-medium">分布の形そのものを比較</span>できます。</li>
          <li><span className="font-medium">正規分布の重ね描き（黒破線）:</span> 同じ平均・標準偏差を持つ正規分布 N(μ, σ²) を重ねます。実データの密度がこの破線より<span className="font-medium">中央で高く尖り、両裾で厚い</span>場合、リターンは正規分布よりも「ファットテール（裾が厚い）」＝暴落・急騰が理論より起こりやすいことを意味します。</li>
          <li><span className="font-medium">歪度（わいど, skewness）:</span> 分布の左右の非対称性。式は g₁ = (n / ((n−1)(n−2))) Σ((x_i − μ)/σ)³。<span className="font-medium">正なら右に裾が長い（小さな下落が多く稀に大きな上昇）</span>、負なら左に裾が長い（小さな上昇が多く稀に大きな暴落）。株式の日次リターンは負の歪度を持ちやすい傾向があります。</li>
          <li><span className="font-medium">尖度（せんど, excess kurtosis）:</span> 裾の厚さ・中心の尖り具合。正規分布を0とした「超過尖度」で表示。<span className="font-medium">正なら正規分布より裾が厚く中心が尖る（=テールリスク大）</span>。値が3〜5を超えると極端な値が頻発する「レプトカーティック」な分布です。</li>
          <li><span className="font-medium">三角マーカー:</span> 横軸上の各色の三角は、その曜日の平均リターンの位置を示します。0%（灰色の縦破線）からの左右のズレで、曜日ごとの方向性バイアスを一目で把握できます。</li>
          <li><span className="font-medium">投資判断への活用:</span> ①平均が正でも歪度が大きく負なら「普段は小さく勝つが稀に大きく負ける」戦略で、損切り設計が重要。②特定曜日の夜間リターン（前C→当O）の裾が厚ければ、オーバーナイト保有のギャップリスクが高いと判断。③曜日間で分布形が大きく異なれば、エントリー/エグジット曜日の使い分けに根拠を与えます。</li>
          <li><span className="font-medium">注意点:</span> サンプル数Nが小さい曜日（特に「全営業日」以外）では裾の推定が不安定です。KDEのバンド幅は自動設定のため、過度に滑らかに見えることがあります。過去の分布形が将来も続く保証はなく、レジーム変化（市場構造の変化）で崩れる点に留意してください。</li>
        </ul>

        <p className="mt-2"><span className="font-medium">曜日別統計:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">平均リターン (μ_dow):</span> 各曜日に属する全営業日のリターンの算術平均。</li>
          <li><span className="font-medium">中央値:</span> 外れ値に頑健な代表値。平均と中央値の乖離が大きい場合、分布の非対称性（歪度）を示唆します。</li>
          <li><span className="font-medium">標準偏差 (σ_dow):</span> 不偏分散の平方根 σ = √(Σ(r_i - μ)² / (N-1))。曜日ごとのボラティリティの違いを捉えます。</li>
          <li><span className="font-medium">勝率:</span> r_t &gt; 0 の日数 / 全日数 × 100。50%からの乖離が大きいほど方向性バイアスが強い。</li>
          <li><span className="font-medium">p値:</span> 帰無仮説「当該曜日の平均リターン = 0」に対するt検定の有意確率。t = μ × √N / σ。p &lt; 0.05 で統計的に有意なアノマリーと判定します。</li>
        </ul>
        <p className="mt-2"><span className="font-medium">月別統計:</span> 同様にr_tを月ごとに集計。「Sell in May」「1月効果」などのカレンダーアノマリーを定量的に検証します。</p>
        <p><span className="font-medium">月内週番号別リターン:</span> 各月の営業日を週番号（第1週〜第5週）に分類。月末・月初のリバランス効果（Turn of Month効果）を検出します。</p>
        <p><span className="font-medium">曜日×月 ヒートマップ:</span> 曜日と月の2次元クロス集計で平均リターンを色分け表示。特定の曜日×月の組み合わせに偏ったアノマリーを発見できます。</p>
        <p><span className="font-medium">年×月 リターンヒートマップ:</span> 年と月の2次元で月間合計リターン Σr_t を表示。特定年の異常月（暴落・急騰）の特定や、季節性の時間的安定性を確認します。</p>
        <p><span className="font-medium">前日騰落との関係:</span> 前日上昇(r_&#123;t-1&#125; &gt; 0)・下落(r_&#123;t-1&#125; ≤ 0)で条件分けし、翌日リターンの平均・勝率・p値を算出。自己相関（モメンタムまたはリバーサル）の有無を簡易的に検証します。</p>
        <p><span className="font-medium">月内日別平均リターン:</span> 月の第1営業日〜第31営業日ごとの平均リターン。Turn of Month効果（月末最終2日+月初3日がプラス傾向）の視覚的確認に使います。</p>
        <p><span className="font-medium">累積リターン（曜日別・月別）:</span> 特定の曜日/月にのみ投資した場合の累積リターン Σr_t の推移。右肩上がりなら当該期間は歴史的にプラスの期待値を持つことを意味します。</p>
        <p><span className="font-medium">年間シーズナリティ曲線:</span> 各年について年初からの営業日番号でr_tを並べ、全年の平均累積リターン曲線を描画。年間を通じた典型的な値動きパターンを把握できます。</p>
        <p><span className="font-medium">連騰・連落分析:</span> 連続して上昇/下落した日数（ストリーク）の最長・平均・回数を集計。ランダムウォーク仮説下での理論的連続日数（幾何分布 E[streak] = 1/p）と比較することで、トレンド継続性を評価します。</p>
      </AnalysisGuide>
    </div>
  );
}
