"use client";

import React, { useMemo, useCallback, useRef, useEffect, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import type { PeriodKey } from "../../hooks/useAnalysisData";
import AnalysisGuide from "./AnalysisGuide";
import {
  computeStrategy,
  computePlan,
  bestCombination,
  buyHoldEquity,
  buyHoldMetrics,
  weekdayMatrix,
  type TradeSpec,
  type Timing,
  type Side,
  type MatrixMetric,
  type EquityPoint,
  type StrategyResult,
  type PlanGapFill,
  type PlanResult,
  type BestCombination,
} from "../../lib/weekday-trade";

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
// 曜日トレード戦略の重ね描き用カラーパレット
const STRAT_COLORS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2"];
// 比較リストに登録できるレグの上限。最適プラン(週内クロック10スロットを連結)は最大10レグに
// なり得るので、単独ロングの手動比較(従来6)より広く取る。
const MAX_SPECS = 12;
const TIMING_LABEL: Record<Timing, string> = { open: "始値", close: "終値" };
// 注文タイミングの全組み合わせ（エントリー × エグジット）
const TIMING_COMBOS: [Timing, Timing][] = [
  ["open", "open"],
  ["open", "close"],
  ["close", "open"],
  ["close", "close"],
];
function specLabel(s: TradeSpec): string {
  const dow = ["", "月", "火", "水", "木", "金"];
  return `${dow[s.entryDow]}${TIMING_LABEL[s.entryTiming]}→${dow[s.exitDow]}${TIMING_LABEL[s.exitTiming]}${s.side === "short" ? " [売]" : ""}`;
}
// EquityPoint.t は "YYYY-MM-DD" を UTC 深夜として解釈した ms（weekday-trade.ts の toDayPts と同じ）。
// lightweight-charts の日付 Time("YYYY-MM-DD") へ UTC で往復変換する。
function msToYmd(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
// lightweight-charts は時刻が厳密に昇順かつ重複なしであることを要求する。
// 同一日に複数点が来た場合は後勝ちで潰し、昇順に整える。
function toEquityRows(pts: EquityPoint[]): { time: Time; value: number }[] {
  const byDay = new Map<string, number>();
  for (const p of pts) byDay.set(msToYmd(p.t), p.v);
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([time, value]) => ({ time: time as Time, value }));
}
function sameSpec(a: TradeSpec, b: TradeSpec): boolean {
  return a.entryDow === b.entryDow && a.exitDow === b.exitDow
    && a.entryTiming === b.entryTiming && a.exitTiming === b.exitTiming && a.side === b.side;
}
function sameSpecList(a: TradeSpec[], b: TradeSpec[]): boolean {
  return a.length === b.length && a.every((s, i) => sameSpec(s, b[i]));
}

// ロング戦略ランキング: 全注文タイミング(4) × 全曜日ペア(25) = 100通りのロング戦略を
// 指標で降順に並べる。初期表示の自動選択(最良ロング)とランキング表で共有する純粋関数。
type RankMetric = "perDay" | "total" | "annualized" | "sharpe" | "efficiency" | "winRate";
const RANK_METRIC_LABELS: Record<RankMetric, string> = {
  perDay: "日当たり",
  total: "総リターン",
  annualized: "年率",
  sharpe: "Sharpe",
  efficiency: "効率",
  winRate: "勝率",
};
// 1市場滞在日あたりの平均リターン(総リターン÷延べ滞在日数)。
// 滞在期間の長い戦略ほど総リターンが嵩む偏りを取り除き、保有1日あたりの質で公平に比較する。
function perDayReturn(r: StrategyResult): number {
  return r.heldDays > 0 ? r.totalReturn / r.heldDays : 0;
}
function strategyMetric(r: StrategyResult, m: RankMetric): number {
  switch (m) {
    case "perDay": return perDayReturn(r);
    case "total": return r.totalReturn;
    case "annualized": return r.annualized;
    case "sharpe": return r.sharpe;
    case "efficiency": return r.exposure > 0 ? r.totalReturn / r.exposure : 0;
    case "winRate": return r.winRate;
  }
}
interface RankedStrategy { spec: TradeSpec; result: StrategyResult; }
function rankLongStrategies(prices: PricePoint[], compound: boolean, metric: RankMetric): RankedStrategy[] {
  const out: RankedStrategy[] = [];
  for (const [entryTiming, exitTiming] of TIMING_COMBOS) {
    for (let e = 1; e <= 5; e++) {
      for (let x = 1; x <= 5; x++) {
        const spec: TradeSpec = { entryDow: e, entryTiming, exitDow: x, exitTiming, side: "long" };
        const result = computeStrategy(prices, spec, compound);
        if (result.nTrades < 3) continue;
        out.push({ spec, result });
      }
    }
  }
  out.sort((a, b) => strategyMetric(b.result, metric) - strategyMetric(a.result, metric));
  return out;
}

// エントリー/エグジット軸の色(HTML凡例と Canvas 軸ラベルで共有し、縦=建て・横=手仕舞いを直感的に示す)
const AXIS_ENTRY_COLOR = "#1d4ed8"; // 青 = エントリー(建て・行/縦軸)
const AXIS_EXIT_COLOR = "#b45309";  // 橙 = エグジット(手仕舞い・列/横軸)
// 注文タイミング・ヒートマップ(4サブ行列)のレイアウト幾何。描画とクリック判定で共有する。
// axisLabelW: 左の縦書き「エントリー↓」帯、axisHeaderH: 上の「エグジット→」帯の高さ。
const TM_LAYOUT = { cellW: 44, cellH: 24, rowLabelW: 20, axisLabelW: 15, titleH: 18, axisHeaderH: 13, headerH: 14, rowGap: 30, colGap: 14, topPad: 6 };
function timingMatrixGeom(width: number) {
  const L = TM_LAYOUT;
  const subW = L.axisLabelW + L.rowLabelW + 5 * L.cellW;        // サブ行列1つの横幅
  const subH = L.titleH + L.axisHeaderH + L.headerH + 5 * L.cellH; // サブ行列1つの縦幅
  // 幅に応じて列数を決める。2列を並べると重なる狭い端末(スマホ)では1列に縦積みする。
  const cols = width >= 2 * subW + L.colGap ? 2 : 1;
  const rows = Math.ceil(4 / cols);
  const totalH = L.topPad + rows * subH + (rows - 1) * L.rowGap;
  const colW = width / cols;                       // 各列に割り当てる横幅
  const subAt = (idx: number) => {
    const col = idx % cols, rowBlock = Math.floor(idx / cols);
    const subLeft = col * colW + (colW - subW) / 2;
    const subTop = L.topPad + rowBlock * (subH + L.rowGap);
    const gridLeft = subLeft + L.axisLabelW + L.rowLabelW;
    const gridTop = subTop + L.titleH + L.axisHeaderH + L.headerH;
    return { subLeft, subTop, gridLeft, gridTop };
  };
  return { ...L, subW, subH, cols, rows, totalH, subAt };
}
// クリック座標(CSS px) → どのセル(idx=タイミング, 行=エントリー曜日, 列=エグジット曜日)か
function hitTestTimingMatrix(width: number, x: number, y: number): { idx: number; entryDow: number; exitDow: number } | null {
  const g = timingMatrixGeom(width);
  for (let idx = 0; idx < 4; idx++) {
    const s = g.subAt(idx);
    const j = Math.floor((x - s.gridLeft) / g.cellW);
    const i = Math.floor((y - s.gridTop) / g.cellH);
    if (x >= s.gridLeft && y >= s.gridTop && i >= 0 && i < 5 && j >= 0 && j < 5) {
      return { idx, entryDow: i + 1, exitDow: j + 1 };
    }
  }
  return null;
}

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
const pad2 = (n: number) => String(n).padStart(2, "0");
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
// 1滞在日あたりリターンはごく小さいので bps(万分率)で表示する
function bpDay(v: number): string { return (v * 10000).toFixed(2) + "bp"; }
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
  const yearMonthRef = useRef<HTMLCanvasElement>(null);
  const womBarRef = useRef<HTMLCanvasElement>(null);
  const dowCumulRef = useRef<HTMLCanvasElement>(null);
  const monthCumulRef = useRef<HTMLCanvasElement>(null);
  // 曜日別 平均リターンの推移: 横軸=日付の時系列なのでズーム/パン可能な lightweight-charts で描画する。
  const trendContainerRef = useRef<HTMLDivElement>(null);
  const trendChartRef = useRef<IChartApi | null>(null);
  const trendSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const domBarRef = useRef<HTMLCanvasElement>(null);
  const seasonRef = useRef<HTMLCanvasElement>(null);
  const distRef = useRef<HTMLCanvasElement>(null);

  const [returnTab, setReturnTab] = useState<ReturnTab>("rate");

  // === 曜日別 平均リターンの推移 state ===
  // bucket: 分解能セレクタ(年/四半期/月/週)で排他バケットに集計しその平均。trendSmooth>0で連続バケットの移動平均。
  // rolling: 各曜日の出現列に対し直近trendWindow回の移動平均を毎出現日にプロット(xは全出現日で最密)。
  const [trendMode, setTrendMode] = useState<"bucket" | "rolling">("bucket");
  const [trendRes, setTrendRes] = useState<"year" | "quarter" | "month" | "week">("year");
  const [trendSmooth, setTrendSmooth] = useState(0); // bucket: 連続バケットの移動平均窓(0/1=生値)
  const [trendWindow, setTrendWindow] = useState(26); // rolling: 直近W回の平均

  // === interactive distribution explorer state ===
  const [distField, setDistField] = useState<RawFieldKey>("close");
  const [distDows, setDistDows] = useState<number[]>([1, 2, 3, 4, 5]); // -1 = 全営業日
  const [distShowNormal, setDistShowNormal] = useState(true);
  const [distShowHist, setDistShowHist] = useState(true);
  const toggleDow = useCallback((dow: number) => {
    setDistDows(prev => prev.includes(dow) ? prev.filter(d => d !== dow) : [...prev, dow].sort((a, b) => a - b));
  }, []);

  // === 曜日トレード・シミュレータ state ===
  // エクイティ曲線は横軸=日付の時系列なので、ズーム/パン可能な lightweight-charts で描画する。
  const equityContainerRef = useRef<HTMLDivElement>(null);
  const equityChartRef = useRef<IChartApi | null>(null);
  const equitySeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const tradeMatrixRef = useRef<HTMLCanvasElement>(null);
  // 編集中のスペック（ビルダー）
  const [builder, setBuilder] = useState<TradeSpec>({ entryDow: 1, entryTiming: "close", exitDow: 2, exitTiming: "close", side: "long" });
  // 比較対象として確定した戦略リスト。ユーザーが未編集の間は最適プラン(買+売の非重複組合せ)を自動追従(下の useEffect)。
  const [specs, setSpecs] = useState<TradeSpec[]>([]);
  // ユーザーが比較リストを手動操作したか。trueになると自動追従を止め、選択を固定する。
  const [specsTouched, setSpecsTouched] = useState(false);
  const [tradeCompound, setTradeCompound] = useState(true);
  const [matrixMetric, setMatrixMetric] = useState<MatrixMetric>("perDay");
  // ロング戦略ランキングの並べ替え指標(既定=日当たり: 滞在期間の偏りを除いた公平比較)
  const [rankMetric, setRankMetric] = useState<RankMetric>("perDay");
  // ロング戦略ランキングの折りたたみ表示
  const [showRanking, setShowRanking] = useState(false);
  // 週内プラン(複数レグ連結)モード。既定オン: 初期表示の最適プラン(複数レグ)を1本に連結して見せる。
  const [planMode, setPlanMode] = useState(true);
  const [gapFill, setGapFill] = useState<PlanGapFill>("cash");
  const [costBps, setCostBps] = useState(0);
  const addSpec = useCallback(() => {
    setSpecsTouched(true);
    setSpecs(prev => (prev.length >= MAX_SPECS || prev.some(s => sameSpec(s, builder))) ? prev : [...prev, builder]);
  }, [builder]);
  // 任意の spec を比較リストへ追加（ランキング/ヒートマップから共有）。連結モードは変更しない。
  const addSpecObj = useCallback((spec: TradeSpec) => {
    setSpecsTouched(true);
    setSpecs(prev => (prev.length >= MAX_SPECS || prev.some(s => sameSpec(s, spec))) ? prev : [...prev, spec]);
  }, []);
  const removeSpec = useCallback((idx: number) => {
    setSpecsTouched(true);
    setSpecs(prev => prev.filter((_, i) => i !== idx));
  }, []);
  // 手動編集後に最適プラン(買+売の非重複組合せ)へ戻す。specsTouched を解除して自動追従を再開させる。
  const restoreOptimal = useCallback(() => {
    setSpecsTouched(false);
    setPlanMode(true);
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

  // === 曜日別 平均リターンの推移 (分解能可変 + 拡大表示: アノマリーの持続/減衰を見る) ===
  // bucket: 分解能(年/四半期/月/週)で排他バケットに集計しその平均。trendSmooth>1で連続バケットの移動平均。
  // rolling: 各曜日の出現列に直近trendWindow回の移動平均を毎出現日にプロット(xは全出現日で最密)。
  // 返り値は共通で Record<曜日, {time:"YYYY-MM-DD", value, n}[]> (lightweight-charts にそのまま渡す)。
  const dowTrend = useMemo(() => {
    const out: Record<number, { time: string; value: number; n: number }[]> = {};
    for (const dow of DOW_TRADING) out[dow] = [];
    if (days.length === 0) return out;

    if (trendMode === "rolling") {
      const W = Math.max(1, trendWindow);
      for (const dow of DOW_TRADING) {
        const buf: number[] = [];
        let sum = 0;
        for (const d of days) {
          if (d.dayOfWeek !== dow) continue;
          buf.push(d.closeReturn); sum += d.closeReturn;
          if (buf.length > W) sum -= buf.shift()!;
          out[dow].push({ time: d.date, value: sum / buf.length, n: buf.length });
        }
      }
      return out;
    }

    // bucket モード: 各営業日を排他バケットに割り当て、その代表日(バケット先頭日)を time にする。
    const bucketOf = (d: DayData): { key: string; time: string } => {
      if (trendRes === "year") return { key: `${d.year}`, time: `${d.year}-01-01` };
      if (trendRes === "quarter") { const q = Math.floor(d.month / 3); return { key: `${d.year}-Q${q}`, time: `${d.year}-${pad2(q * 3 + 1)}-01` }; }
      if (trendRes === "month") return { key: `${d.year}-${d.month}`, time: `${d.year}-${pad2(d.month + 1)}-01` };
      // week: その週の月曜日を代表日にする ((dayOfWeek+6)%7 = 月曜からの経過日数, 日=6)
      const dt = new Date(`${d.date}T00:00:00`);
      dt.setDate(dt.getDate() - ((d.dayOfWeek + 6) % 7));
      const t = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
      return { key: t, time: t };
    };
    for (const dow of DOW_TRADING) {
      const agg = new Map<string, { time: string; sum: number; n: number }>();
      for (const d of days) {
        if (d.dayOfWeek !== dow) continue;
        const { key, time } = bucketOf(d);
        const b = agg.get(key) || { time, sum: 0, n: 0 };
        b.sum += d.closeReturn; b.n++;
        agg.set(key, b);
      }
      let arr = Array.from(agg.values())
        .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
        .map(b => ({ time: b.time, value: b.sum / b.n, n: b.n }));
      // 平滑化: 分解能を上げたときのノイズを、連続する trendSmooth バケットの移動平均で緩和する。
      const W = Math.floor(trendSmooth);
      if (W > 1 && arr.length) {
        const raw = arr.map(p => p.value);
        arr = arr.map((p, i) => {
          const win = raw.slice(Math.max(0, i - W + 1), i + 1);
          return { ...p, value: win.reduce((s, v) => s + v, 0) / win.length };
        });
      }
      out[dow] = arr;
    }
    return out;
  }, [days, trendMode, trendRes, trendSmooth, trendWindow]);

  // === 曜日トレード: 各戦略の結果 / バイ&ホールド / 全組合せマトリクス ===
  const tradeResults = useMemo<StrategyResult[]>(
    () => specs.map(s => computeStrategy(prices, s, tradeCompound)),
    [specs, prices, tradeCompound],
  );
  const bhEquity = useMemo<EquityPoint[]>(() => buyHoldEquity(prices, tradeCompound), [prices, tradeCompound]);
  const bhMetrics = useMemo(() => buyHoldMetrics(prices, tradeCompound), [prices, tradeCompound]);
  // 週内プラン: specs を1本の資金ストリームに連結
  const planResult = useMemo<PlanResult>(
    () => computePlan(prices, specs, gapFill, costBps, tradeCompound),
    [prices, specs, gapFill, costBps, tradeCompound],
  );
  // 注文タイミングの全4通り（始値/終値 × 始値/終値）のヒートマップを一括計算
  const tradeMatrices = useMemo(
    () => TIMING_COMBOS.map(([entryTiming, exitTiming]) => ({
      entryTiming,
      exitTiming,
      grid: weekdayMatrix(prices, entryTiming, exitTiming, builder.side, tradeCompound, matrixMetric),
    })),
    [prices, builder.side, tradeCompound, matrixMetric],
  );
  // ロング戦略ランキング: 全100通りを指標で降順に。ランキング表で使用。
  const longRanking = useMemo<RankedStrategy[]>(
    () => rankLongStrategies(prices, tradeCompound, rankMetric),
    [prices, tradeCompound, rankMetric],
  );
  // 最適プラン: 週内クロックを10スロットに分解し各スロットの最適サイド(買/売/無)を独立選択→
  // 連続同符号を連結したレグ列。無レバ・単位ポジション・非重複の枠内で最大リターンの組合せ。
  const bestCombo = useMemo<BestCombination>(
    () => bestCombination(prices, tradeCompound),
    [prices, tradeCompound],
  );
  // ユーザーが比較リストを未編集の間は、最適プラン(買+売の複数レグ)を初期表示として自動選択する。
  // 期間・複利設定を変えると最適プランも変わり追従する。手動編集すると固定される。
  useEffect(() => {
    if (specsTouched) return;
    setSpecs(prev => sameSpecList(prev, bestCombo.legs) ? prev : bestCombo.legs);
  }, [bestCombo, specsTouched]);
  // ヒートマップのセルをクリック → その(曜日ペア×注文タイミング×方向)を比較リストに追加(連結モードは変えない)
  const addSpecFromMatrix = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const hit = hitTestTimingMatrix(canvas.clientWidth, e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    const grid = tradeMatrices[hit.idx]?.grid;
    if (!grid || grid[hit.entryDow - 1][hit.exitDow - 1] === null) return; // 成立しないセルは無視
    const [entryTiming, exitTiming] = TIMING_COMBOS[hit.idx];
    addSpecObj({ entryDow: hit.entryDow, entryTiming, exitDow: hit.exitDow, exitTiming, side: builder.side });
  }, [tradeMatrices, builder.side, addSpecObj]);

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

  // 曜日トレード: 注文タイミング全4通り(始値/終値 × 始値/終値)の
  // (エントリー曜日 × エグジット曜日)ヒートマップを描画。
  // 幅が広ければ2列、狭い端末(スマホ)では1列に縦積みして重なりを防ぐ。
  const drawTimingMatrices = useCallback((
    canvas: HTMLCanvasElement,
    matrices: { entryTiming: Timing; exitTiming: Timing; grid: (number | null)[][] }[],
    metric: MatrixMetric,
  ) => {
    const dow = ["月", "火", "水", "木", "金"];
    // 幾何はクリック判定と共有(timingMatrixGeom)
    // initCanvas に渡す高さを得るため、まず暫定幅でレイアウトを求める
    const parentW = canvas.parentElement?.clientWidth || 600;
    const { cellW, cellH, totalH } = timingMatrixGeom(parentW);
    const r = initCanvas(canvas, totalH); if (!r) return;
    const { ctx, width } = r;
    const geom = timingMatrixGeom(width);
    const gridW = 5 * cellW, gridH = 5 * cellH;

    // 色の基準は全4行列で共有し、タイミング間の比較を可能にする
    let maxAbs = 0;
    for (const m of matrices) for (const row of m.grid) for (const v of row) if (v !== null) maxAbs = Math.max(maxAbs, Math.abs(v));
    const fmt = (v: number) => metric === "winRate" ? (v * 100).toFixed(0) + "%" : metric === "sharpe" ? v.toFixed(2) : metric === "perDay" ? (v * 10000).toFixed(1) + "bp" : (v * 100).toFixed(1) + "%";

    matrices.forEach((m, idx) => {
      const { subLeft, subTop, gridLeft, gridTop } = geom.subAt(idx);

      // サブタイトル（注文タイミング）: 建て時刻→手仕舞い時刻を軸色で分けて示す
      ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      const entryTxt = `建 ${TIMING_LABEL[m.entryTiming]}`, arrowTxt = " → ", exitTxt = `仕舞 ${TIMING_LABEL[m.exitTiming]}`;
      const twEntry = ctx.measureText(entryTxt).width, twArrow = ctx.measureText(arrowTxt).width, twExit = ctx.measureText(exitTxt).width;
      let tx = gridLeft + (gridW - (twEntry + twArrow + twExit)) / 2;
      const titleY = subTop + 13;
      ctx.fillStyle = AXIS_ENTRY_COLOR; ctx.fillText(entryTxt, tx, titleY); tx += twEntry;
      ctx.fillStyle = "#9ca3af"; ctx.fillText(arrowTxt, tx, titleY); tx += twArrow;
      ctx.fillStyle = AXIS_EXIT_COLOR; ctx.fillText(exitTxt, tx, titleY);

      // 横軸タイトル「エグジット(手仕舞い)曜日 →」: 列ヘッダーの上に橙で
      ctx.fillStyle = AXIS_EXIT_COLOR; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("エグジット(手仕舞い)曜日 →", gridLeft + gridW / 2, gridTop - geom.headerH - 3);

      // 縦軸タイトル「↓ エントリー(建て)曜日」: グリッド左に縦書き(90°回転)で青
      ctx.save();
      ctx.translate(subLeft + geom.axisLabelW / 2 + 2, gridTop + gridH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = AXIS_ENTRY_COLOR; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("↓ エントリー(建て)曜日", 0, 0);
      ctx.restore();
      ctx.textBaseline = "alphabetic";

      // エグジット曜日ヘッダー(列): 橙系
      ctx.fillStyle = AXIS_EXIT_COLOR; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      for (let j = 0; j < 5; j++) ctx.fillText(dow[j], gridLeft + j * cellW + cellW / 2, gridTop - 4);

      for (let i = 0; i < 5; i++) {
        // エントリー曜日（行ラベル）: 青系
        ctx.fillStyle = AXIS_ENTRY_COLOR; ctx.textAlign = "right"; ctx.font = "9px sans-serif";
        ctx.fillText(dow[i], gridLeft - 4, gridTop + i * cellH + cellH / 2 + 3);
        for (let j = 0; j < 5; j++) {
          const v = m.grid[i][j];
          const x = gridLeft + j * cellW, y = gridTop + i * cellH;
          let bg = "#f9fafb";
          if (v !== null) {
            if (metric === "winRate") {
              const t = Math.min(1, Math.abs(v - 0.5) / 0.25);
              bg = v >= 0.5 ? `rgba(22,163,74,${0.15 + 0.7 * t})` : `rgba(220,38,38,${0.15 + 0.7 * t})`;
            } else {
              bg = returnColor(v, maxAbs);
            }
          }
          ctx.fillStyle = bg; ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
          if (v !== null) {
            const strong = metric === "winRate" ? Math.abs(v - 0.5) > 0.18 : Math.abs(v) > maxAbs * 0.6;
            ctx.fillStyle = strong ? "#fff" : "#333";
            ctx.textAlign = "center"; ctx.font = "8px sans-serif";
            ctx.fillText(fmt(v), x + cellW / 2, y + cellH / 2 + 3);
          } else {
            ctx.fillStyle = "#d1d5db"; ctx.textAlign = "center"; ctx.font = "8px sans-serif";
            ctx.fillText("-", x + cellW / 2, y + cellH / 2 + 3);
          }
        }
      }
    });

    // 軸の凡例（左下）: 色で縦=建て・横=手仕舞いを再確認
    ctx.font = "bold 9px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    let lx = 2; const ly = totalH - 3;
    ctx.fillStyle = AXIS_ENTRY_COLOR; ctx.fillText("縦↓=エントリー(建て)曜日", lx, ly); lx += ctx.measureText("縦↓=エントリー(建て)曜日").width + 8;
    ctx.fillStyle = "#9ca3af"; ctx.fillText("/", lx, ly); lx += ctx.measureText("/").width + 8;
    ctx.fillStyle = AXIS_EXIT_COLOR; ctx.fillText("横→=エグジット(手仕舞い)曜日", lx, ly);
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
  }, [days, dowRaw, monthRaw, crossStats, crossMaxAbs, yearMonthData, womStats, dowCumulative, monthCumulative, domStats, seasonality, returnTab, drawGroupedBar, drawBoxPlot, drawCrossHeatmap, drawYearMonth, drawWomBar, drawLineChart, drawDomBar, drawSeasonality, getBarData, getBoxData]);

  // === Draw interactive distribution explorer ===
  useEffect(() => {
    if (distRef.current) drawDistribution(distRef.current, distGroups, distShowHist, distShowNormal);
  }, [distGroups, distShowHist, distShowNormal, drawDistribution]);

  // 表示中のエクイティ系列（B&H + 戦略 or 連結プラン）をまとめる。
  const equitySeriesData = useMemo(() => {
    const strategies = planMode
      ? [{ label: "週内プラン(連結)", color: "#059669", points: planResult.equity }]
      : tradeResults.map((res, i) => ({
          label: specLabel(specs[i]),
          color: STRAT_COLORS[i % STRAT_COLORS.length],
          points: res.equity,
        }));
    return { strategies };
  }, [planMode, planResult, tradeResults, specs]);

  // === エクイティ曲線チャートの生成（コンテナ出現後に1度だけ） ===
  useEffect(() => {
    if (days.length === 0 || !equityContainerRef.current) return;
    const chart = createChart(equityContainerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f0f0f0" } },
      width: equityContainerRef.current.clientWidth,
      height: 260,
      crosshair: { mode: 0 },
      rightPriceScale: { visible: true },
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(1)}%` },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    equityChartRef.current = chart;
    const onResize = () => {
      if (equityContainerRef.current) chart.applyOptions({ width: equityContainerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      equityChartRef.current = null;
      equitySeriesRef.current = [];
    };
  }, [days.length]);

  // === エクイティ曲線のデータ更新（系列の増減に応じて張り替え） ===
  useEffect(() => {
    const chart = equityChartRef.current;
    if (!chart) return;
    for (const s of equitySeriesRef.current) chart.removeSeries(s);
    equitySeriesRef.current = [];

    // バイ&ホールド（灰・背面）
    if (bhEquity.length >= 2) {
      const bhs = chart.addSeries(LineSeries, {
        color: "#9ca3af", lineWidth: 1, title: "B&H",
        priceLineVisible: false, lastValueVisible: false,
      });
      bhs.setData(toEquityRows(bhEquity));
      equitySeriesRef.current.push(bhs);
    }
    // 各戦略 / 連結プラン
    for (const s of equitySeriesData.strategies) {
      if (s.points.length < 2) continue;
      const ls = chart.addSeries(LineSeries, {
        color: s.color, lineWidth: 2, title: s.label,
        priceLineVisible: false, lastValueVisible: false,
      });
      ls.setData(toEquityRows(s.points));
      equitySeriesRef.current.push(ls);
    }
    if (equityContainerRef.current && equityContainerRef.current.clientWidth > 0) {
      chart.applyOptions({ width: equityContainerRef.current.clientWidth });
    }
    chart.timeScale().fitContent();
  }, [bhEquity, equitySeriesData]);

  // === 曜日別 平均リターンの推移チャートの生成（コンテナ出現後に1度だけ）===
  useEffect(() => {
    if (days.length === 0 || !trendContainerRef.current) return;
    const chart = createChart(trendContainerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f0f0f0" } },
      width: trendContainerRef.current.clientWidth,
      height: 240,
      crosshair: { mode: 0 },
      rightPriceScale: { visible: true },
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(2)}%` },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    trendChartRef.current = chart;
    const onResize = () => {
      if (trendContainerRef.current) chart.applyOptions({ width: trendContainerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      trendChartRef.current = null;
      trendSeriesRef.current = [];
    };
  }, [days.length]);

  // === 曜日別 平均リターンの推移データ更新（モード/分解能/平滑化の変更で系列を張り替え）===
  useEffect(() => {
    const chart = trendChartRef.current;
    if (!chart) return;
    for (const s of trendSeriesRef.current) chart.removeSeries(s);
    trendSeriesRef.current = [];
    for (const dow of DOW_TRADING) {
      const pts = dowTrend[dow];
      if (!pts || pts.length < 2) continue;
      const ls = chart.addSeries(LineSeries, {
        color: DOW_COLORS_DIST[dow], lineWidth: 2, title: DOW_LABELS[dow],
        priceLineVisible: false, lastValueVisible: false,
      });
      ls.setData(pts.map(p => ({ time: p.time as Time, value: p.value })));
      trendSeriesRef.current.push(ls);
    }
    if (trendContainerRef.current && trendContainerRef.current.clientWidth > 0) {
      chart.applyOptions({ width: trendContainerRef.current.clientWidth });
    }
    chart.timeScale().fitContent();
  }, [dowTrend]);

  // === Draw 曜日トレード・シミュレータ（全組合せヒートマップ） ===
  useEffect(() => {
    if (tradeMatrixRef.current) drawTimingMatrices(tradeMatrixRef.current, tradeMatrices, matrixMetric);
  }, [tradeMatrices, matrixMetric, drawTimingMatrices]);

  // 全組合せヒートマップは幅に応じて列数(2列⇄1列)を切り替えるため、
  // 画面幅の変化(端末回転・リサイズ)で再描画してレイアウトの重なりを防ぐ。
  useEffect(() => {
    const onResize = () => {
      if (tradeMatrixRef.current) drawTimingMatrices(tradeMatrixRef.current, tradeMatrices, matrixMetric);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [tradeMatrices, matrixMetric, drawTimingMatrices]);

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
        <AnalysisGuide title="解説: 曜日別 平均リターン比較">
          <p><span className="font-medium">何を明らかにするか:</span> 各曜日(月〜金)に、選択中のリターン種別の平均がプラスかマイナスか、どの曜日が強い/弱いかを比較します。曜日アノマリー(例: 月曜が弱い、金曜が強い)の有無を一目で把握する出発点です。</p>
          <p><span className="font-medium">使う数字・数式:</span> 各曜日に属する全営業日のリターン r を集め、算術平均 μ = (1/N)Σr を棒の高さにします。棒のグループ=曜日、棒の色=リターン種別(前C→当C / 当O→当C(日中) / 前C→当O(夜間) 等。タブで切替)。縦軸は%。</p>
          <p><span className="font-medium">読み方:</span> 0(中央の横線)より上=平均プラス、下=マイナス。夜間(前C→当O)と日中(当O→当C)を比べると、その曜日の値動きが「持ち越し」と「場中」のどちらで生じているかが分かります。</p>
          <p><span className="font-medium">注意:</span> 平均は外れ値に弱く、サンプルが少ない期間では偶然の偏りが出ます。有意性は下の「曜日別リターン詳細」のp値で確認してください。</p>
        </AnalysisGuide>
      </div>

      {/* ===== 2. Weekday box plot ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日別 リターン分布 (箱ひげ図 - {tabDef.barDefs.map(d => d.label).join(" / ")})</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={dowBoxRef} /></div>
        <AnalysisGuide title="解説: 曜日別 リターン分布 (箱ひげ図)">
          <p><span className="font-medium">何を明らかにするか:</span> 平均だけでは見えない「ばらつき(リスク)」と「分布の偏り」を曜日ごとに比較します。同じ平均でも箱が縦長ならハイリスクな曜日です。</p>
          <p><span className="font-medium">使う数字・数式:</span> 各曜日のリターンを昇順に並べ、四分位数を計算。箱の上端=第3四分位 Q3(上位25%境界)、下端=第1四分位 Q1(下位25%境界)、箱内の太線=中央値、箱の高さ=四分位範囲 IQR = Q3−Q1。ひげは Q1−1.5×IQR 〜 Q3+1.5×IQR の範囲、それを超える点=外れ値(丸)。</p>
          <p><span className="font-medium">読み方:</span> 箱の縦幅=その曜日のボラティリティ。中央線が箱の中で上/下に寄る=分布の歪み。外れ値の数や位置で「稀な大変動」がどちらの方向に多いかを把握します。</p>
        </AnalysisGuide>
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

        <AnalysisGuide title="解説: 曜日別リターン分布エクスプローラ">
          <p><span className="font-medium">何を明らかにするか:</span> 代表値(平均・中央値)では見えない<span className="font-medium">分布の形そのもの</span>(裾の厚さ・左右非対称・二峰性)を、曜日×リターン種別を自由に選んで確認します。例:「金曜の夜間リターンは暴落側に裾が伸びているか」を直接見る。</p>
          <p><span className="font-medium">ヒストグラム:</span> リターンを40区間に分け、各区間の頻度を密度(縦軸=頻度 /(総数×区間幅))に正規化。面積合計=1なので密度曲線・正規分布と重ねて比較できます(曜日1つ選択時に表示)。</p>
          <p><span className="font-medium">KDE(カーネル密度推定)曲線:</span> 区切り位置に依存しない滑らかな密度推定。f(x) = (1/(n·h)) Σ K((x − x_i)/h)、K=標準正規、バンド幅 h = 0.9 × min(σ, IQR/1.349) × n^(−1/5)(Silverman)。複数曜日を選ぶと形を重ね比較できます。</p>
          <p><span className="font-medium">正規分布の重ね描き(黒破線):</span> 同じ平均・標準偏差の正規分布 N(μ,σ²)。実データが中央で尖り両裾で厚い=ファットテール(急騰急落が理論より起きやすい)。</p>
          <p><span className="font-medium">歪度・尖度(表):</span> 歪度 g₁ = (n/((n−1)(n−2)))Σ((x_i−μ)/σ)³(正=右裾が長い/負=左裾が長い)。超過尖度(正規=0)が正=裾が厚い(テールリスク大)。三角マーカー=平均位置、灰破線=0%。</p>
          <p><span className="font-medium">活用:</span> ①平均が正でも歪度が大きく負なら「普段は小勝ち・稀に大負け」で損切り設計が重要。②夜間リターンの裾が厚い曜日は持ち越しギャップリスクが高い。<span className="font-medium">注意:</span> N が小さい曜日は裾の推定が不安定。</p>
        </AnalysisGuide>
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

      <div>
        <AnalysisGuide title="解説: 曜日別リターン詳細 (統計量とp値)">
          <p><span className="font-medium">何を明らかにするか:</span> 各曜日の代表値・ばらつき・勝率・統計的有意性を数値で精査します。図で見えた偏りが「偶然か、意味のあるアノマリーか」を判定する中核の表です。</p>
          <p><span className="font-medium">使う数字・数式:</span> 平均 μ=(1/N)Σr、中央値(外れ値に頑健)、標準偏差 σ=√(Σ(r−μ)²/(N−1))、勝率=(r&gt;0 の日数)/N。<span className="font-medium">p値</span>=帰無仮説「平均=0」のt検定 t = μ·√N/σ の有意確率。</p>
          <p><span className="font-medium">読み方:</span> p &lt; 0.05(青字)で「平均が0と有意に異なる」=偶然では説明しにくいアノマリー。平均と中央値の乖離は分布の歪みを示唆。σが大きい曜日は同じ平均でもリスクが高い。</p>
          <p><span className="font-medium">注意:</span> 5曜日×複数指標を一度に見ると、偶然どれかが有意に見える<span className="font-medium">多重比較</span>の罠があります。単独のp値を過信しないこと。</p>
        </AnalysisGuide>
      </div>


      {/* ===== 曜日別 平均リターンの推移 (分解能可変 + 拡大表示) ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">
          曜日別 平均リターンの推移
          <span className="text-gray-400 ml-1">※各曜日の前C→当C平均を時系列に。分解能を上げ、ホイールでズーム/ドラッグでパンして詳細の変化を追える</span>
        </div>
        {/* モード切替 + 分解能/平滑化コントロール */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-1.5">
          <div className="flex gap-1">
            {([["bucket", "バケット集計"], ["rolling", "移動平均"]] as [typeof trendMode, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTrendMode(key)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${trendMode === key ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {trendMode === "bucket" ? (
            <>
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-gray-500">分解能</span>
                {([["year", "年"], ["quarter", "四半期"], ["month", "月"], ["week", "週"]] as [typeof trendRes, string][]).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setTrendRes(key)}
                    className={`px-2 py-0.5 text-[11px] rounded transition-colors ${trendRes === key ? "bg-emerald-600 text-white" : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-100"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-[11px] text-gray-500">
                平滑化 <span className="text-gray-700 tabular-nums w-14">{trendSmooth <= 1 ? "なし" : `${trendSmooth}点平均`}</span>
                <input type="range" min={1} max={12} step={1} value={trendSmooth} onChange={e => setTrendSmooth(Number(e.target.value))} className="w-24" />
              </label>
            </>
          ) : (
            <label className="flex items-center gap-1.5 text-[11px] text-gray-500">
              窓(直近N回) <span className="text-gray-700 tabular-nums w-8">{trendWindow}</span>
              <input type="range" min={4} max={104} step={1} value={trendWindow} onChange={e => setTrendWindow(Number(e.target.value))} className="w-32" />
              <span className="text-gray-400">≒{(trendWindow / 52).toFixed(1)}年</span>
            </label>
          )}
        </div>
        <div ref={trendContainerRef} className="w-full rounded border border-gray-100 overflow-hidden" />
        <AnalysisGuide title="解説: 曜日別 平均リターンの推移">
          <p><span className="font-medium">何を明らかにするか:</span> 他の図は全期間を1つに集計するため「いつ効いていたか」が消えます。本図は<span className="font-medium">曜日効果が時間とともに持続しているか/減衰・反転したか</span>を可視化します。アノマリーは発見後に裁定で消えることが多く、その兆候を掴むためのものです。<span className="font-medium">分解能を上げてグラフをホイール拡大/ドラッグ移動</span>すれば、特定期間の細かな変化まで追えます。</p>
          <p><span className="font-medium">2つのモード:</span></p>
          <ul className="list-disc pl-4 space-y-1">
            <li><span className="font-medium">バケット集計:</span> 期間を<span className="font-medium">年/四半期/月/週</span>の排他区間に区切り、各区間・各曜日の平均リターン μ = (1/N)Σr を点にします。横軸=時間、縦軸=平均(%)、色=曜日。細かくするほど「いつ効いたか」の分解能が上がります。</li>
            <li><span className="font-medium">移動平均:</span> 各曜日の出現ごとに<span className="font-medium">直近N回</span>の平均を毎回プロット。N=平滑の強さで、点の密度(=分解能)を落とさずノイズだけを調整できます。Nを小さくすると細部が、大きくすると長期トレンドが見えます。</li>
          </ul>
          <p><span className="font-medium">分解能とノイズ:</span> 区間を細かくするほど1点あたりのサンプルNが減り(週なら各曜日N=1で生の日次リターンそのもの)、値は激しく揺れます。バケット集計の<span className="font-medium">平滑化(連続K点の移動平均)</span>で、xの細かさを保ったままノイズを抑えられます。</p>
          <p><span className="font-medium">読み方:</span> ある曜日の線が一貫して0より上(下)=その効果が長期的に持続。時間とともに0へ近づく=アノマリーの減衰(裁定消滅)。プラスとマイナスを行き来=不安定で再現性が低い。直近の符号が過去と逆=レジーム変化の疑い。</p>
          <p><span className="font-medium">注意:</span> 細かい区間では1点のサンプルが少なくばらつきます。個々の点の上下より「複数点の傾き・水準」を見てください。平滑化/大きな窓Nは反応が遅れる(ラグ)ため、直近の転換点は割り引いて解釈します。</p>
        </AnalysisGuide>
      </div>

      {/* ===== 3. Monthly grouped bar ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月別 平均リターン比較 ({tabDef.barDefs.map(d => d.label).join(" / ")})</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={monthBarRef} /></div>
        <AnalysisGuide title="解説: 月別 平均リターン比較">
          <p><span className="font-medium">何を明らかにするか:</span> 12か月それぞれの平均リターンを比較し、「Sell in May(5月以降軟調)」「年末高」などの季節性(カレンダーアノマリー)を検証します。</p>
          <p><span className="font-medium">使う数字・数式:</span> 各月に属する全営業日のリターンを集め平均 μ = (1/N)Σr を棒の高さに。棒の色=リターン種別(タブ切替)。縦軸%。</p>
          <p><span className="font-medium">読み方:</span> 0より上の月=歴史的に上昇しやすい月。連続する月の傾向(例: 11〜翌1月が強い)に注目。<span className="font-medium">注意:</span> 月次は1年に1サンプルしか増えず、10年でもN≈10年分。下の月別詳細のp値・標準偏差で確からしさを確認。</p>
        </AnalysisGuide>
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

      <div>
        <AnalysisGuide title="解説: 月別リターン詳細 (統計量とp値)">
          <p><span className="font-medium">何を明らかにするか:</span> 月別の平均・標準偏差・勝率・p値を精査し、季節性が統計的に有意かを判定します。</p>
          <p><span className="font-medium">使う数字・数式:</span> 各月のリターンについて 平均 μ=(1/N)Σr、標準偏差 σ=√(Σ(r−μ)²/(N−1))、勝率=(r&gt;0)/N、p値=t検定(t=μ·√N/σ)の有意確率。</p>
          <p><span className="font-medium">読み方:</span> p &lt; 0.05(青字)の月は平均が0と有意に異なる。<span className="font-medium">注意:</span> 月効果は年に1回しか観測が増えず、10年でもN≈10。p値は参考程度に、複数年の安定性(下の年×月ヒートマップ)と併せて判断してください。</p>
        </AnalysisGuide>
      </div>

      {/* 週内パターン(月→金→翌月の累積)は「曜日エッジスキャン」の週内クロックに集約。
          そちらは夜間/日中の10素片に分解し、谷=買・山=売の最良窓やエッジの年次推移まで見られる。 */}
      <p className="text-[11px] text-gray-400">
        週内の累積リターン経路（夜間/日中の分解・週末ギャップ・谷で買い／山で売り）は
        <span className="font-medium text-gray-500">「曜日エッジスキャン」の週内クロック</span>
        に統合しました。
      </p>

      {/* ===== 曜日トレード・シミュレータ ===== */}
      <div className="border border-emerald-100 rounded-lg p-3 bg-emerald-50/30">
        <div className="text-sm font-medium text-gray-700 mb-2">
          曜日トレード・シミュレータ
          <span className="text-xs font-normal text-gray-400">（初期表示＝買+売を組合せた最大リターンの週内プラン。任意の曜日・注文タイミングで売買を編集でき、連結モードで複数レグを1本に繋いでB&Hと公平比較）</span>
        </div>

        {/* builder */}
        <div className="flex flex-wrap items-end gap-2 mb-2 text-[11px]">
          <div>
            <div className="text-gray-400 mb-0.5">エントリー</div>
            <div className="flex gap-1">
              <select value={builder.entryDow} onChange={e => setBuilder(b => ({ ...b, entryDow: Number(e.target.value) }))} className="border border-gray-200 rounded px-1 py-0.5 bg-white">
                {[1, 2, 3, 4, 5].map(d => <option key={d} value={d}>{DOW_LABELS[d]}</option>)}
              </select>
              <select value={builder.entryTiming} onChange={e => setBuilder(b => ({ ...b, entryTiming: e.target.value as Timing }))} className="border border-gray-200 rounded px-1 py-0.5 bg-white">
                <option value="open">始値</option>
                <option value="close">終値</option>
              </select>
            </div>
          </div>
          <div className="text-gray-400 pb-1">→</div>
          <div>
            <div className="text-gray-400 mb-0.5">エグジット</div>
            <div className="flex gap-1">
              <select value={builder.exitDow} onChange={e => setBuilder(b => ({ ...b, exitDow: Number(e.target.value) }))} className="border border-gray-200 rounded px-1 py-0.5 bg-white">
                {[1, 2, 3, 4, 5].map(d => <option key={d} value={d}>{DOW_LABELS[d]}</option>)}
              </select>
              <select value={builder.exitTiming} onChange={e => setBuilder(b => ({ ...b, exitTiming: e.target.value as Timing }))} className="border border-gray-200 rounded px-1 py-0.5 bg-white">
                <option value="open">始値</option>
                <option value="close">終値</option>
              </select>
            </div>
          </div>
          <div>
            <div className="text-gray-400 mb-0.5">方向</div>
            <div className="flex gap-1">
              {(["long", "short"] as Side[]).map(sd => (
                <button key={sd} onClick={() => setBuilder(b => ({ ...b, side: sd }))} className={`px-2 py-0.5 rounded transition-colors ${builder.side === sd ? (sd === "long" ? "bg-blue-600 text-white" : "bg-rose-600 text-white") : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-100"}`}>
                  {sd === "long" ? "ロング(買)" : "ショート(売)"}
                </button>
              ))}
            </div>
          </div>
          <button onClick={addSpec} disabled={specs.length >= MAX_SPECS} className="px-3 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40">+ 比較に追加</button>
          <label className="flex items-center gap-1 cursor-pointer text-gray-500 pb-1 ml-auto">
            <input type="checkbox" checked={tradeCompound} onChange={e => setTradeCompound(e.target.checked)} className="accent-emerald-600" />
            複利 Π(1+r)（オフで単純合計 Σr）
          </label>
        </div>

        {/* active strategy chips */}
        <div className="flex flex-wrap items-center gap-1 mb-2">
          {!specsTouched && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded bg-amber-100 text-amber-800 border border-amber-200" title="週内クロックを10スロットに分解し各スロットの買/売/無を独立最適化した、非重複で最大リターンの組合せ">
              ★ 最適プラン（買{bestCombo.nLong}・売{bestCombo.nShort}スロット / 週内滞在{Math.round(bestCombo.coverage * 100)}%）
            </span>
          )}
          {specs.map((s, i) => (
            <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border" style={{ borderColor: STRAT_COLORS[i % STRAT_COLORS.length], color: STRAT_COLORS[i % STRAT_COLORS.length] }}>
              {specLabel(s)}
              <button onClick={() => removeSpec(i)} className="text-gray-400 hover:text-gray-700 leading-none">×</button>
            </span>
          ))}
          {specs.length === 0 && <span className="text-[11px] text-gray-400">戦略を「比較に追加」してください</span>}
          {specsTouched && (
            <button onClick={restoreOptimal} className="ml-1 px-2 py-0.5 text-[11px] rounded bg-amber-600 text-white hover:bg-amber-700" title="手動編集を破棄し、買+売の最大リターン組合せを再表示">★ 最適プランに戻す</button>
          )}
        </div>

        {/* ロング戦略ランキング（リターン/Sharpe順） */}
        <div className="mb-2 border border-gray-100 rounded bg-white/70 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowRanking(v => !v)}
              className="flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-800"
              aria-expanded={showRanking}
            >
              <span className="text-gray-400 text-[10px] w-3 inline-block">{showRanking ? "▼" : "▶"}</span>
              ロング戦略ランキング
            </button>
            <span className="text-[11px] text-gray-400">全{longRanking.length}通り(注文4×曜日ペア25, 取引3未満は除外)を{RANK_METRIC_LABELS[rankMetric]}の高い順に</span>
            {showRanking && (
              <div className="flex flex-wrap gap-1 ml-auto">
                {(Object.keys(RANK_METRIC_LABELS) as RankMetric[]).map(k => (
                  <button key={k} onClick={() => setRankMetric(k)} className={`px-2 py-0.5 text-[11px] rounded transition-colors ${rankMetric === k ? "bg-emerald-600 text-white" : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-100"}`}>{RANK_METRIC_LABELS[k]}</button>
                ))}
              </div>
            )}
          </div>
          {!showRanking ? null : longRanking.length === 0 ? (
            <div className="text-[11px] text-gray-400 py-1">成立する戦略がありません(データ不足)。</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-gray-200 text-gray-500">
                    <th className="py-1 px-2 text-right font-medium">#</th>
                    <th className="py-1 px-2 text-left font-medium">戦略</th>
                    <th className="py-1 px-2 text-center font-medium">取引数</th>
                    <th className="py-1 px-2 text-center font-medium" title="総リターン÷延べ市場滞在日数: 保有1日あたりの平均リターン。滞在期間の偏りを除いた公平比較の主指標">日当たり</th>
                    <th className="py-1 px-2 text-center font-medium">総リターン</th>
                    <th className="py-1 px-2 text-center font-medium">年率</th>
                    <th className="py-1 px-2 text-center font-medium">Sharpe</th>
                    <th className="py-1 px-2 text-center font-medium">勝率</th>
                    <th className="py-1 px-2 text-center font-medium" title="総リターン÷滞在率">効率</th>
                    <th className="py-1 px-2 text-center font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {longRanking.slice(0, 10).map(({ spec, result }, i) => {
                    const active = specs.some(s => sameSpec(s, spec));
                    return (
                      <tr key={i} className={`border-b border-gray-100 ${i === 0 ? "bg-emerald-50/60" : ""}`}>
                        <td className="py-1 px-2 text-right font-mono text-gray-500">{i + 1}</td>
                        <td className="py-1 px-2 font-medium text-gray-700">{specLabel(spec)}</td>
                        <td className="py-1 px-2 text-center font-mono text-gray-600">{result.nTrades}</td>
                        <td className={`py-1 px-2 text-center font-mono font-semibold ${colorClass(perDayReturn(result))}`}>{result.heldDays > 0 ? bpDay(perDayReturn(result)) : "-"}</td>
                        <td className={`py-1 px-2 text-center font-mono ${colorClass(result.totalReturn)}`}>{pct2(result.totalReturn)}</td>
                        <td className={`py-1 px-2 text-center font-mono ${colorClass(result.annualized)}`}>{pct2(result.annualized)}</td>
                        <td className="py-1 px-2 text-center font-mono text-gray-600">{result.sharpe.toFixed(2)}</td>
                        <td className="py-1 px-2 text-center font-mono text-gray-600">{pct2(result.winRate)}</td>
                        <td className={`py-1 px-2 text-center font-mono ${colorClass(result.exposure > 0 ? result.totalReturn / result.exposure : 0)}`}>{result.exposure > 0 ? pct2(result.totalReturn / result.exposure) : "-"}</td>
                        <td className="py-1 px-2 text-center">
                          <button
                            onClick={() => addSpecObj(spec)}
                            disabled={active || specs.length >= MAX_SPECS}
                            className="px-2 py-0.5 text-[11px] rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
                          >{active ? "追加済" : "+ 比較"}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 週内プラン(連結)モード コントロール */}
        <div className="flex flex-wrap items-center gap-3 mb-2 text-[11px] border-t border-emerald-100 pt-2">
          <label className="flex items-center gap-1 cursor-pointer text-gray-600">
            <input type="checkbox" checked={planMode} onChange={e => setPlanMode(e.target.checked)} className="accent-emerald-600" />
            <span className="font-medium">連結モード</span>（上の戦略を週内レグとして1本に連結）
          </label>
          {planMode && (
            <>
              <div className="flex items-center gap-1">
                <span className="text-gray-400">レグ間の隙間:</span>
                {(["cash", "hold"] as PlanGapFill[]).map(g => (
                  <button key={g} onClick={() => setGapFill(g)} className={`px-2 py-0.5 rounded transition-colors ${gapFill === g ? "bg-emerald-600 text-white" : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-100"}`}>
                    {g === "cash" ? "現金(ノーポジ)" : "ロング保有"}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1 text-gray-500">
                取引コスト
                <input type="number" min={0} max={50} step={1} value={costBps} onChange={e => setCostBps(Math.max(0, Number(e.target.value) || 0))} className="w-12 border border-gray-200 rounded px-1 py-0.5 bg-white text-right" />
                bps/片道
              </label>
            </>
          )}
        </div>

        {/* equity curve（ズーム/パン可能な lightweight-charts） */}
        <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mb-1">
          <span className="inline-flex items-center gap-1 text-[11px] text-gray-500">
            <span className="inline-block w-4 h-0.5" style={{ backgroundColor: "#9ca3af" }} />バイ&ホールド
          </span>
          {equitySeriesData.strategies.map((s, i) => (
            <span key={i} className="inline-flex items-center gap-1 text-[11px]" style={{ color: s.color }}>
              <span className="inline-block w-4 h-0.5" style={{ backgroundColor: s.color }} />{s.label}
            </span>
          ))}
          <span className="text-[11px] text-gray-400 ml-auto">ホイールでズーム・ドラッグでパン。折れ線の各頂点＝1トレードの決済日。十字線で日付を確認できる。</span>
        </div>
        <div ref={equityContainerRef} className="w-full rounded border border-gray-100 bg-white overflow-hidden" />

        {/* metrics table */}
        {specs.length > 0 && (
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="py-1 px-2 text-left text-gray-500 font-medium">戦略</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">取引数</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">総リターン</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">年率</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">Sharpe</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">最大DD</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">勝率</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">平均/回</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">滞在率</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium" title="総リターン÷滞在率: 市場にいる時間あたりの効率">効率</th>
                </tr>
              </thead>
              <tbody>
                {planMode && (
                  <tr className="border-b border-gray-200 bg-emerald-50">
                    <td className="py-1 px-2 font-medium" style={{ color: "#059669" }}>週内プラン(連結){gapFill === "hold" ? "・隙間ロング" : ""}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600" title="ポジション変更回数">{planResult.nTurnovers}</td>
                    <td className={`py-1 px-2 text-center font-mono ${colorClass(planResult.totalReturn)}`}>{pct2(planResult.totalReturn)}</td>
                    <td className={`py-1 px-2 text-center font-mono ${colorClass(planResult.annualized)}`}>{pct2(planResult.annualized)}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{planResult.sharpe.toFixed(2)}</td>
                    <td className="py-1 px-2 text-center font-mono text-red-600">{pct2(planResult.maxDD)}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-400">-</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-400">-</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{pct2(planResult.exposure)}</td>
                    <td className={`py-1 px-2 text-center font-mono ${colorClass(planResult.exposure > 0 ? planResult.totalReturn / planResult.exposure : 0)}`}>{planResult.exposure > 0 ? pct2(planResult.totalReturn / planResult.exposure) : "-"}</td>
                  </tr>
                )}
                {tradeResults.map((res, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    <td className="py-1 px-2 font-medium" style={{ color: STRAT_COLORS[i % STRAT_COLORS.length] }}>{specLabel(specs[i])}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{res.nTrades}</td>
                    <td className={`py-1 px-2 text-center font-mono ${colorClass(res.totalReturn)}`}>{pct2(res.totalReturn)}</td>
                    <td className={`py-1 px-2 text-center font-mono ${colorClass(res.annualized)}`}>{pct2(res.annualized)}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{res.sharpe.toFixed(2)}</td>
                    <td className="py-1 px-2 text-center font-mono text-red-600">{pct2(res.maxDD)}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{pct2(res.winRate)}</td>
                    <td className={`py-1 px-2 text-center font-mono ${colorClass(res.avgTrade)}`}>{pct(res.avgTrade)}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{pct2(res.exposure)}</td>
                    <td className={`py-1 px-2 text-center font-mono ${colorClass(res.exposure > 0 ? res.totalReturn / res.exposure : 0)}`}>{res.exposure > 0 ? pct2(res.totalReturn / res.exposure) : "-"}</td>
                  </tr>
                ))}
                <tr className="border-b border-gray-100 bg-gray-50">
                  <td className="py-1 px-2 font-medium text-gray-500">バイ&ホールド</td>
                  <td className="py-1 px-2 text-center font-mono text-gray-400">-</td>
                  <td className={`py-1 px-2 text-center font-mono ${colorClass(bhMetrics.totalReturn)}`}>{pct2(bhMetrics.totalReturn)}</td>
                  <td className={`py-1 px-2 text-center font-mono ${colorClass(bhMetrics.annualized)}`}>{pct2(bhMetrics.annualized)}</td>
                  <td className="py-1 px-2 text-center font-mono text-gray-600">{bhMetrics.sharpe.toFixed(2)}</td>
                  <td className="py-1 px-2 text-center font-mono text-red-600">{pct2(bhMetrics.maxDD)}</td>
                  <td className="py-1 px-2 text-center font-mono text-gray-400">-</td>
                  <td className="py-1 px-2 text-center font-mono text-gray-400">-</td>
                  <td className="py-1 px-2 text-center font-mono text-gray-600">100%</td>
                  <td className={`py-1 px-2 text-center font-mono ${colorClass(bhMetrics.totalReturn)}`}>{pct2(bhMetrics.totalReturn)}</td>
                </tr>
              </tbody>
            </table>
            {planMode && (
              <div className="text-[11px] text-gray-500 mt-1">
                グロス(コスト前) {pct2(planResult.grossReturn)} − コスト {pct2(planResult.totalCost)} = 純 {pct2(planResult.totalReturn)}（回転 {planResult.nTurnovers} 回 @ {costBps}bps/片道）。
                {gapFill === "cash"
                  ? "「現金」: レグ外は市場から退出。滞在率が低いほどB&Hに累積で勝ちにくい。"
                  : "「ロング保有」: レグ外は常時ロング(B&Hを土台にレグで上書き)。滞在率≈100%でB&Hと公平に比較できる。"}
              </div>
            )}
          </div>
        )}

        {/* all-combinations matrix */}
        <div className="mt-3">
          <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mb-1">
            <span className="text-xs text-gray-500">全組合せヒートマップ（注文タイミング4通り）</span>
            <span className="text-[11px] inline-flex items-center gap-1 rounded bg-gray-50 border border-gray-200 px-1.5 py-0.5">
              <span className="font-semibold text-blue-700">縦↓＝エントリー(建て)曜日</span>
              <span className="text-gray-400">×</span>
              <span className="font-semibold text-amber-700">横→＝エグジット(手仕舞い)曜日</span>
            </span>
            <span className="text-[11px] text-emerald-700">セルをクリックで{builder.side === "long" ? "ロング" : "ショート"}戦略を比較に追加</span>
            {matrixMetric === "perDay" && <span className="text-[11px] text-gray-400">日当たりは bp(=0.01%)表示</span>}
            <div className="flex gap-1 ml-auto">
              {([["perDay", "日当たり"], ["total", "総リターン"], ["sharpe", "Sharpe"], ["winRate", "勝率"]] as [MatrixMetric, string][]).map(([k, l]) => (
                <button key={k} onClick={() => setMatrixMetric(k)} className={`px-2 py-0.5 text-[11px] rounded transition-colors ${matrixMetric === k ? "bg-emerald-600 text-white" : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-100"}`}>{l}</button>
              ))}
            </div>
          </div>
          <div className="w-full rounded border border-gray-100 bg-white overflow-x-auto overflow-hidden"><canvas ref={tradeMatrixRef} onClick={addSpecFromMatrix} className="cursor-pointer" /></div>
        </div>
      </div>

      <div>
        <AnalysisGuide title="解説: 曜日トレード・シミュレータ">
          <p><span className="font-medium">何をするか:</span> 「月曜終値で買い→火曜終値で売る」のように、エントリー/エグジット曜日と注文タイミング(始値/終値)・方向(買/売)を指定し、毎週そのトレードを繰り返した累積リターンをバイ&ホールド(B&H)と比較します。</p>
          <p><span className="font-medium">トレード判定・数式:</span> 各営業日に始値=2i・終値=2i+1 の時刻順序を与え、エントリー時刻より<span className="font-medium">後</span>の最初のエグジット曜日で解消。ロング r = P_exit/P_entry − 1、ショート r = −(P_exit/P_entry − 1)。累積は複利 Π(1+r)−1 か単純合計 Σr(切替)。</p>

          <p className="font-medium text-gray-700 mt-3">なぜ単独の戦略はB&Hに累積で負けやすいか（重要）</p>
          <p>1本の戦略(例: 月終→火終で1日保有)は、エグジット後〜次のエントリーまで<span className="font-medium">現金で待機</span>します。複利の世界ではリターンの源泉は「市場にいる時間」なので、週5営業日中1日しか持たない＝<span className="font-medium">滞在率(exposure)≈0.2</span>の戦略が、常時フル投資(滞在率1.0)のB&Hに累積で勝つのは構造的にほぼ不可能です。これは戦略が悪いのではなく<span className="font-medium">土俵が違う比較</span>であることが原因です。表の<span className="font-medium">効率=総リターン÷滞在率</span>(市場にいる時間あたりの質)を見れば、滞在率を揃えた本来の優位がわかります。</p>

          <p className="font-medium text-gray-700 mt-3">初期表示＝最適プラン（買+売の非重複組合せ・最大リターン）</p>
          <p>比較リストを手動編集する前の初期表示は、<span className="font-medium">買いと売りを組合せて最大リターンになる週内プラン</span>を自動選択します。求め方は次の通りで、貪欲法ではなく<span className="font-medium">厳密な最適解</span>です:</p>
          <ul className="list-disc pl-4 space-y-1">
            <li><span className="font-medium">週内クロックを10スロットに分解:</span> 各曜日D(月〜金)の<span className="font-medium">日中(D始→D終)</span>と<span className="font-medium">オーバーナイト(D終→翌始)</span>で 5×2=10 区間。金曜後のオーバーナイトは週末ギャップ(金終→月始)。</li>
            <li><span className="font-medium">スロット独立最適化:</span> 連結プランの富 W = Π(1 + pos_s·r_s) は<span className="font-medium">スロットごとに因数分解</span>できる(各スロットは毎週同じ pos を適用)。よって各スロットで pos∈{"{+1買, −1売, 0無}"} を独立に選び、そのスロットの累積富 max(買W, 売W, 1) を最大化すれば、全体の富も最大になる。買W&lt;1 かつ 売W&lt;1(高ボラでゼロドリフトのボラ引き)なら<span className="font-medium">無ポジ</span>が最良。</li>
            <li><span className="font-medium">レグへ連結:</span> 連続する同符号スロットを環状に連結して1レグ(例: 木終→火始の買い)にまとめ、連結モードで1本のエクイティにする。<span className="font-medium">非重複</span>(同時に2ポジションを持たない)が保証される。</li>
            <li>チップ上の<span className="font-medium">「★ 最適プラン」</span>バッジに買/売スロット数と週内滞在率を表示。期間・複利設定を変えると最適プランも再計算され追従する。手動で「+比較」やヒートマップクリック等をすると固定され、<span className="font-medium">「★ 最適プランに戻す」</span>で復帰できる。</li>
          </ul>
          <p className="text-[11px] text-gray-400">※ これは<span className="font-medium">過去データ上で</span>最大リターンになる後知恵の組合せ。多数スロットの符号を過去に最適化するため<span className="font-medium">過剰適合(オーバーフィット)</span>しやすく、将来もそのまま効く保証はない点に注意(下の注意点も参照)。</p>

          <p className="font-medium text-gray-700 mt-3">連結モード（複数レグを週内で1本に繋ぐ）</p>
          <p>B&Hに累積で勝つには滞在率を上げる必要があります。連結モードは登録した戦略を<span className="font-medium">週内のレグ</span>とみなし、1本の資金ストリームに連結します。内部実装は<span className="font-medium">セグメント×ポジションベクトル方式</span>:</p>
          <ul className="list-disc pl-4 space-y-1">
            <li><span className="font-medium">区間分解:</span> 価格を日中(open_i→close_i, 区間index 2i)とオーバーナイト(close_i→open_(i+1), 2i+1)に分解。各区間に目標ポジション pos∈{"{−1,0,+1}"} を割り当てる。</li>
            <li><span className="font-medium">エクイティ:</span> 富 W = Π(1 + pos_s · r_s)。pos が変わる境界で取引コスト(片道 bps)を W から差し引く。<span className="font-medium">B&Hは「全区間 pos=+1」の特殊ケース</span>なので、戦略と完全に同一基盤で公平に比較できる。</li>
            <li><span className="font-medium">レグ間の隙間:</span> 「現金」=レグ外は pos=0(退出)。「ロング保有」=既定 pos=+1(常時ロング)をレグが上書き ⇒ 滞在率≈100%でB&Hを土台に「悪い曜日だけ売り/見送り」を重ねるオーバーレイになる。</li>
            <li><span className="font-medium">滞在率</span> = 非ゼロ区間の割合。<span className="font-medium">回転</span> = pos変更回数(コスト計算の基礎)。</li>
          </ul>

          <p className="font-medium text-gray-700 mt-3">B&Hを超えるレグの探し方</p>
          <ul className="list-disc pl-4 space-y-1">
            <li><span className="font-medium">ロング戦略ランキング</span>(折りたたみ式)は全100通り(注文4×曜日ペア25)のロング戦略を、<span className="font-medium">日当たり</span>/総リターン/年率/Sharpe/効率/勝率の指標で降順に並べたもの。<span className="font-medium">既定は「日当たり」=総リターン÷延べ市場滞在日数(bps表示)</span>。総リターンで並べると「水始値→水始値」のように<span className="font-medium">毎週ほぼ常に持ち越す≒バイ&ホールド</span>の組合せが、単に市場滞在日数が長いという理由だけで上位を独占してしまう。日当たりは保有1日あたりの質に揃えるので、滞在期間の偏りを除いて本当に効率の良い曜日区間が浮かび上がる。</li>
            <li>このランキングは<span className="font-medium">ロング単独</span>の1レグを効率良い順に眺めるための一覧で、良い区間を「+比較」で手動リストに拾える(初期表示は上記の買+売の最適プランで、こちらは編集用の素材)。</li>
            <li><span className="font-medium">グラフの初期表示</span>は、比較リストを手動編集する前であれば<span className="font-medium">買+売の最大リターン組合せ(最適プラン)に自動追従</span>する(期間・複利設定を変えると再計算される)。「+比較」やヒートマップのクリック、チップの×で一度でも手動編集すると自動追従は止まり、<span className="font-medium">「★ 最適プランに戻す」</span>で復帰できる。</li>
            <li>あるいは<span className="font-medium">全組合せヒートマップ</span>(5×5曜日ペア×注文4通り)で良いペアを発見(緑=プラス/赤=マイナス、トレード3未満は「-」)。<span className="font-medium">注文4通り</span>とは「エントリーを始値/終値」×「エグジットを始値/終値」の2×2の組合せ(始→始・始→終・終→始・終→終)で、各サブ行列は行=エントリー曜日・列=エグジット曜日の5×5。並べ替え指標は<span className="font-medium">日当たり(bp=0.01%表示)</span>/総リターン/Sharpe/勝率から選べ、<span className="font-medium">既定は日当たり</span>(滞在期間の長いセルが総リターンだけで濃くなる偏りを避ける)。<span className="font-medium">良いセルをクリック</span>すると、その曜日ペア×注文タイミング×方向がそのまま比較リストに追加される。連結して1本に繋ぎたいときは<span className="font-medium">連結モード</span>を手動でオンにする。</li>
            <li>良いロングのレグを複数(例: 月終→火終 と 水終→木終)拾い、連結モード「現金」で滞在率を積み上げる。隙間の弱い曜日を避けつつ強い区間だけ拾えればB&H超えが狙える。</li>
            <li>あるいは「ロング保有」で土台をB&Hにし、ヒートマップで<span className="font-medium">マイナスが濃い曜日だけショート</span>のレグを重ねて差を上乗せする(滞在率≈1.0のまま改善余地を探す最短ルート)。</li>
            <li><span className="font-medium">効率</span>と<span className="font-medium">コスト後の純リターン</span>の両方でB&Hを上回って初めて実戦的な優位です。</li>
          </ul>

          <p><span className="font-medium">指標:</span> 年率(複利は (1+総)^(252/N日)−1)/Sharpe(日次リターンの平均÷標準偏差×√252)/最大DD(資産曲線のピークからの最大下落)。</p>
          <p><span className="font-medium">注意:</span> コストは片道bpsの線形近似で税・スリッページの非線形性や約定不成立は未考慮。滞在率は区間数ベースで日中/オーバーナイトの時間差は等価扱い(近似)。過去アノマリーは発見後に消えやすく、多数の組合せを試すと偶然有意に見える<span className="font-medium">多重比較</span>に注意。</p>
        </AnalysisGuide>
      </div>

      {/* ===== 5. Week-of-month bar ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月内週番号別 平均リターン</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={womBarRef} /></div>
        <AnalysisGuide title="解説: 月内週番号別 平均リターン">
          <p><span className="font-medium">何を明らかにするか:</span> 月の前半/後半どの週が強いか(月末・月初のリバランス資金流入=Turn of Month効果など)を検証します。</p>
          <p><span className="font-medium">使う数字・数式:</span> 各営業日を週番号 weekOfMonth = ⌈日付/7⌉(第1〜第5週)に分類し、各週の前C→当C リターンの平均を棒に。</p>
          <p><span className="font-medium">読み方:</span> 第1週・第5週(月初・月末)が高い=Turn of Month効果の示唆。詳細表のp値で有意性を確認。<span className="font-medium">注意:</span> 第5週は日数が少なくNが小さめです。</p>
        </AnalysisGuide>
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

      <div>
        <AnalysisGuide title="解説: 月内週番号別リターン詳細">
          <p><span className="font-medium">使う数字・数式:</span> 第1〜第5週ごとに 平均 μ、標準偏差 σ、勝率、p値(t=μ·√N/σ のt検定)。p &lt; 0.05(青字)で平均が0と有意に異なる。</p>
          <p><span className="font-medium">読み方:</span> 棒グラフで目立った週が、Nとp値からも支持されるかを確認する数値版です。</p>
        </AnalysisGuide>
      </div>

      {/* ===== 6. Cross heatmap ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日 x 月 ヒートマップ (前C→当C 平均)</div>
        <div className="w-full rounded border border-gray-100 overflow-x-auto overflow-hidden"><canvas ref={crossHeatRef} /></div>
        <AnalysisGuide title="解説: 曜日 × 月 ヒートマップ">
          <p><span className="font-medium">何を明らかにするか:</span> 「曜日」と「月」を掛け合わせた2次元のアノマリー(例: 12月の金曜だけ強い)を発見します。単独では平凡でも組合せで偏る効果を捉えます。</p>
          <p><span className="font-medium">使う数字・数式:</span> 各セル=その(曜日,月)に該当する全営業日の前C→当C リターンの平均。色=緑(プラス)/赤(マイナス)、濃さ=全セル中の最大絶対値に対する相対強度。セル内の数値は平均%。</p>
          <p><span className="font-medium">読み方:</span> 濃い緑/赤のセルが偏った組合せ。<span className="font-medium">注意:</span> 5×12=60セルに分割するためセルあたりのNが小さく、偶然の偏りが出やすい。強い色でもサンプル数の少なさに留意。</p>
        </AnalysisGuide>
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

      <div>
        <AnalysisGuide title="解説: 前日騰落との関係">
          <p><span className="font-medium">何を明らかにするか:</span> 前日が上がった/下がった後の翌日リターンを比べ、<span className="font-medium">モメンタム(順張り)かリバーサル(逆張り)か</span>という日次の自己相関の性質を簡易検証します。</p>
          <p><span className="font-medium">使う数字・数式:</span> 前日上昇(r_&#123;t-1&#125;&gt;0)・下落(r_&#123;t-1&#125;≤0)で翌日 r_t を条件分けし、平均・勝率・p値(t検定)を算出。</p>
          <p><span className="font-medium">読み方:</span> 前日下落後の平均が高い=リバーサル(押し目買いが効く)、前日上昇後が高い=モメンタム(順張り)。p &lt; 0.05(青字)で有意。</p>
        </AnalysisGuide>
      </div>

      {/* ===== Day-of-month bar chart ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月内日別 平均リターン (Turn of Month効果)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={domBarRef} /></div>
        <AnalysisGuide title="解説: 月内日別 平均リターン (Turn of Month効果)">
          <p><span className="font-medium">何を明らかにするか:</span> 暦日(1日〜31日)ごとの平均リターン。月末最終数日+月初数日がプラスに偏る「Turn of Month効果」(機関投資家の月次リバランス・年金資金流入が一因とされる)を視覚的に確認します。</p>
          <p><span className="font-medium">使う数字・数式:</span> 各暦日 dayOfMonth に該当する全営業日の前C→当C リターンの平均を棒に(緑=プラス/赤=マイナス)。N&lt;2 の日は非表示。</p>
          <p><span className="font-medium">読み方:</span> 月末〜月初(右端と左端)が緑に偏れば Turn of Month効果。<span className="font-medium">注意:</span> 29〜31日は月により存在せずNが小さい。暦日は祝日でずれるため、厳密には営業日ベースの月内週番号図も併用してください。</p>
        </AnalysisGuide>
      </div>

      {/* ===== Cumulative by weekday ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日別 累積リターン</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={dowCumulRef} /></div>
        <AnalysisGuide title="解説: 曜日別 累積リターン">
          <p><span className="font-medium">何を明らかにするか:</span> 「その曜日だけに投資し続けたら資産はどう増減したか」を累積で見て、曜日効果の方向と一貫性(右肩上がりか)を把握します。</p>
          <p><span className="font-medium">使う数字・数式:</span> 各曜日について出現順に並べ、累積 Σr_t(前C→当C の単純合計)を折れ線に。横軸=その曜日の出現回数(時間の代理)、縦軸=累積%。</p>
          <p><span className="font-medium">読み方:</span> 一貫して右肩上がりの曜日=歴史的にプラス期待値。途中で傾きが変わる=効果が時間で変化(年次推移の図と併読)。<span className="font-medium">注意:</span> 横軸は回数で実時間と等間隔ではありません。</p>
        </AnalysisGuide>
      </div>

      {/* ===== Cumulative by month ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月別 累積リターン</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={monthCumulRef} /></div>
        <AnalysisGuide title="解説: 月別 累積リターン">
          <p><span className="font-medium">何を明らかにするか:</span> 「特定の月だけに毎年投資し続けたら」の累積推移。各月の長期的な寄与とその安定性を比較します。</p>
          <p><span className="font-medium">使う数字・数式:</span> 各月について出現順(年ごと)に累積 Σr_t を折れ線に。横軸=その月の出現年数、縦軸=累積%。色=月。</p>
          <p><span className="font-medium">読み方:</span> 一貫して上昇する月=季節的に強い。途中で下落に転じる月=効果の減衰や特定年の暴落の影響。<span className="font-medium">注意:</span> 月次は年1回しか増えず線が短く、単年の暴落に大きく振られます。</p>
        </AnalysisGuide>
      </div>

      {/* ===== 7. Year x Month heatmap ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">年 x 月 リターンヒートマップ (月間合計リターン)</div>
        <div className="w-full rounded border border-gray-100 overflow-x-auto overflow-hidden"><canvas ref={yearMonthRef} /></div>
        <AnalysisGuide title="解説: 年 × 月 リターンヒートマップ">
          <p><span className="font-medium">何を明らかにするか:</span> 各年・各月の月間リターンを一覧し、季節性が<span className="font-medium">毎年安定して効いているか</span>、暴落・急騰の月がいつだったかを俯瞰します。月別平均(集計値)が一部の年に依存していないかの検証に最適です。</p>
          <p><span className="font-medium">使う数字・数式:</span> 各セル=その年その月の前C→当C リターンの合計 Σr_t。色=緑(プラス)/赤(マイナス)、濃さ=全セル最大絶対値に対する相対。</p>
          <p><span className="font-medium">読み方:</span> 縦に同じ月の列を見て、毎年同じ色なら安定した季節性。1年だけ極端=その年固有のイベント(月別平均がそれに引っ張られている可能性)。</p>
        </AnalysisGuide>
      </div>

      {/* ===== Seasonality ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">年間シーズナリティ曲線 (年平均 累積リターン推移)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={seasonRef} /></div>
        <AnalysisGuide title="解説: 年間シーズナリティ曲線">
          <p><span className="font-medium">何を明らかにするか:</span> 1年を通じた「典型的な値動きの形」。年初から年末までの平均的な累積リターン曲線で、年央の谷(夏枯れ)・年末ラリーなどの季節パターンを掴みます。</p>
          <p><span className="font-medium">使う数字・数式:</span> 各年について年初からの営業日番号 i にリターンを並べ、その年の累積 C_y(i)=Σ&#123;k≤i&#125; r を作り、全年で平均 (1/Y)Σ_y C_y(i) を曲線に。横軸=年初からの営業日(月目盛)、縦軸=平均累積%。</p>
          <p><span className="font-medium">読み方:</span> 曲線が上る区間=歴史的に上昇しやすい時期、平坦/下降=軟調な時期。傾きの変化で「いつ買い場/手仕舞いが多かったか」を読みます。<span className="font-medium">注意:</span> 年により営業日数が異なり、年末側はサンプルが減ります。</p>
        </AnalysisGuide>
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
          <AnalysisGuide title="解説: 連騰・連落分析">
            <p><span className="font-medium">何を明らかにするか:</span> 連続して上昇/下落した日数(ストリーク)の長さから、値動きに<span className="font-medium">トレンド継続性(クラスタリング)があるか</span>を見ます。ランダムウォークより連続が長ければ順張りが効きやすい地合いです。</p>
            <p><span className="font-medium">使う数字・数式:</span> 前C→当C の符号が同じ向きに続いた日数を1ストリークとして集計。最長・平均・回数を表示。比較基準: 勝率pのランダムウォーク下の平均連続日数は幾何分布で E[連騰]=1/(1−p)、E[連落]=1/p。</p>
            <p><span className="font-medium">読み方:</span> 平均連騰/連落が理論値より明確に長い=トレンドが持続しやすい(モメンタム有利)。理論値並み=ほぼランダム。<span className="font-medium">注意:</span> 最長記録は1回の偶然でも伸びるため、平均と回数を重視してください。</p>
          </AnalysisGuide>
        </div>
      )}

      <AnalysisGuide title="カレンダー分析の概要（各図の詳しい解説は、各図の直下「解説:」を開いてください）">
        <p>リターンを<span className="font-medium">曜日・月・月内日・週番号・年</span>などの時間区分で集計し、特定タイミングへの偏り（カレンダーアノマリー）の有無を検証するセクションです。各図の数式・使う数字・読み方の詳細は、それぞれの図の直下にある折りたたみ「解説:」にまとめています。</p>
        <p><span className="font-medium">共通の前提（リターン種別タブ）:</span> 既定は前C→当C = (Close_t − Close_&#123;t-1&#125;)/Close_&#123;t-1&#125;。タブで「変化率／OHLC／対数(ln)」を切替できます。日中=当O→当C、夜間=前C→当O。対数リターンは加法性があり累積・複利向きです。</p>
        <p><span className="font-medium">共通の読み方:</span> 棒・ヒートマップは緑=プラス/赤=マイナス、濃さ=相対的な強さ。表のp値はt検定 t = μ·√N/σ の有意確率で、p &lt; 0.05（青字）なら平均が0と統計的に有意に異なります。</p>
        <p><span className="font-medium">共通の注意:</span> ①過去のアノマリーは将来も続く保証がなく、発見後に裁定で消えやすい（「曜日別 平均リターンの年次推移」で持続性を確認）。②区分を細かく割るほどサンプルNが減り偶然の偏りが出ます。③多数の組合せを試すと偶然有意に見える「多重比較」に注意。④取引コスト・スリッページ・税は未考慮です。</p>
      </AnalysisGuide>
    </div>
  );
}
