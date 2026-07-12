"use client";

// 曜日トレード・シミュレータ（旧: SpiralHeatmap 内に埋没していた機能を独立コンポーネントへ移設）。
// 任意の曜日×注文タイミング(始値/終値)×方向(買/売)の売買を編集し、複数レグを週内で1本に連結して
// バイ&ホールドと公平比較する。初期表示は買+売の非重複最大リターン組合せ(最適プラン)。
// フィット窓/検証期間、逐次ウォークフォワード評価、注文タイミング全4通りヒートマップ、ロング戦略ランキングを内包。
// onSendPlan を渡すと「最適プラン(週内10スロットのサイド)」をワークベンチの共有プランへ送れる。

import React, { useMemo, useCallback, useRef, useEffect, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import AnalysisGuide from "./AnalysisGuide";
import { type SlotSide } from "./WeekSlotGrid";
import {
  computeStrategy,
  computePlan,
  computeWalkForward,
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
  type WalkForwardResult,
  type BestCombination,
} from "../../lib/weekday-trade";

interface Props {
  prices: PricePoint[];
  onSendPlan?: (sides: SlotSide[]) => void; // 最適プランを共有プラン(週内10スロット)へ送る
}

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const STRAT_COLORS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2"];
const MAX_SPECS = 12;
const TIMING_LABEL: Record<Timing, string> = { open: "始値", close: "終値" };
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
// EquityPoint.t は "YYYY-MM-DD" を UTC 深夜として解釈した ms。lightweight-charts の Time へ UTC で往復。
function msToYmd(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
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

type RankMetric = "perDay" | "total" | "annualized" | "sharpe" | "efficiency" | "winRate";
const RANK_METRIC_LABELS: Record<RankMetric, string> = {
  perDay: "日当たり",
  total: "総リターン",
  annualized: "年率",
  sharpe: "Sharpe",
  efficiency: "効率",
  winRate: "勝率",
};
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

const AXIS_ENTRY_COLOR = "#1d4ed8"; // 青 = エントリー(建て・行/縦軸)
const AXIS_EXIT_COLOR = "#b45309";  // 橙 = エグジット(手仕舞い・列/横軸)
const TM_LAYOUT = { cellW: 44, cellH: 24, rowLabelW: 20, axisLabelW: 15, titleH: 18, axisHeaderH: 13, headerH: 14, rowGap: 30, colGap: 14, topPad: 6 };
function timingMatrixGeom(width: number) {
  const L = TM_LAYOUT;
  const subW = L.axisLabelW + L.rowLabelW + 5 * L.cellW;
  const subH = L.titleH + L.axisHeaderH + L.headerH + 5 * L.cellH;
  const cols = width >= 2 * subW + L.colGap ? 2 : 1;
  const rows = Math.ceil(4 / cols);
  const totalH = L.topPad + rows * subH + (rows - 1) * L.rowGap;
  const colW = width / cols;
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

function pct(v: number): string { return (v * 100).toFixed(3) + "%"; }
function pct2(v: number): string { return (v * 100).toFixed(2) + "%"; }
function bpDay(v: number): string { return (v * 10000).toFixed(2) + "bp"; }
function colorClass(v: number): string { return v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500"; }
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

export default function WeekdayTradeSimulator({ prices, onSendPlan }: Props) {
  const equityContainerRef = useRef<HTMLDivElement>(null);
  const equityChartRef = useRef<IChartApi | null>(null);
  const equitySeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const tradeMatrixRef = useRef<HTMLCanvasElement>(null);
  // 編集中のスペック（ビルダー）
  const [builder, setBuilder] = useState<TradeSpec>({ entryDow: 1, entryTiming: "close", exitDow: 2, exitTiming: "close", side: "long" });
  const [specs, setSpecs] = useState<TradeSpec[]>([]);
  const [specsTouched, setSpecsTouched] = useState(false);
  const [tradeCompound, setTradeCompound] = useState(true);
  const [matrixMetric, setMatrixMetric] = useState<MatrixMetric>("perDay");
  const [rankMetric, setRankMetric] = useState<RankMetric>("perDay");
  const [showRanking, setShowRanking] = useState(false);
  const [planMode, setPlanMode] = useState(true);
  const [gapFill, setGapFill] = useState<PlanGapFill>("cash");
  const [costBps, setCostBps] = useState(0);
  const [fitMode, setFitMode] = useState<"latest" | "rolling">("latest");
  const [fitLen, setFitLen] = useState(0);
  const [fitEnd, setFitEnd] = useState(0);
  const [evalMode, setEvalMode] = useState<"full" | "window" | "walkforward">("full");
  // 銘柄・期間の切替でデータ長が変わったら全期間・最新起点に戻す。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFitMode("latest");
    setFitLen(prices.length);
    setFitEnd(prices.length);
  }, [prices.length]);
  const addSpec = useCallback(() => {
    setSpecsTouched(true);
    setSpecs(prev => (prev.length >= MAX_SPECS || prev.some(s => sameSpec(s, builder))) ? prev : [...prev, builder]);
  }, [builder]);
  const addSpecObj = useCallback((spec: TradeSpec) => {
    setSpecsTouched(true);
    setSpecs(prev => (prev.length >= MAX_SPECS || prev.some(s => sameSpec(s, spec))) ? prev : [...prev, spec]);
  }, []);
  const removeSpec = useCallback((idx: number) => {
    setSpecsTouched(true);
    setSpecs(prev => prev.filter((_, i) => i !== idx));
  }, []);
  const restoreOptimal = useCallback(() => {
    setSpecsTouched(false);
    setPlanMode(true);
  }, []);

  const setFitLenPreset = useCallback((n: number) => {
    setFitLen(n);
    setFitEnd((prev) => {
      const end = prev > 0 ? Math.min(prev, prices.length) : prices.length;
      return Math.max(end, n);
    });
  }, [prices.length]);
  const switchFitMode = useCallback((m: "latest" | "rolling") => {
    if (m === "rolling") {
      setFitLen((prev) => {
        const cur = prev > 0 ? Math.min(prev, prices.length) : prices.length;
        return cur >= prices.length ? Math.min(252, prices.length - 1) : cur;
      });
    }
    setFitEnd(prices.length);
    setFitMode(m);
  }, [prices.length]);
  const switchEvalMode = useCallback((m: "full" | "window" | "walkforward") => {
    if (m === "walkforward") {
      setFitMode("latest");
      setFitEnd(prices.length);
    }
    setEvalMode(m);
  }, [prices.length]);

  // === フィット窓・検証期間の導出 ===
  const effFitEnd = fitEnd > 0 ? Math.min(fitEnd, prices.length) : prices.length;
  const rawFitLen = fitLen > 0 ? fitLen : prices.length;
  const effFitLen = Math.min(rawFitLen, effFitEnd);
  const fitPrices = useMemo(
    () => prices.slice(effFitEnd - effFitLen, effFitEnd),
    [prices, effFitEnd, effFitLen],
  );
  const isFullFit = fitMode === "latest" && effFitLen >= prices.length;
  const fitBarsAfter = prices.length - effFitEnd;
  const fitStartDate = fitPrices[0]?.time ?? "";
  const fitEndDate = fitPrices[fitPrices.length - 1]?.time ?? "";
  const evalPrices = evalMode === "window" ? fitPrices : prices;
  const isWF = evalMode === "walkforward";

  const walkForward = useMemo<WalkForwardResult | null>(
    () => isWF ? computeWalkForward(prices, effFitLen, gapFill, costBps, tradeCompound) : null,
    [isWF, prices, effFitLen, gapFill, costBps, tradeCompound],
  );

  const tradeResults = useMemo<StrategyResult[]>(
    () => specs.map(s => computeStrategy(evalPrices, s, tradeCompound)),
    [specs, evalPrices, tradeCompound],
  );
  const bhEquity = useMemo<EquityPoint[]>(() => buyHoldEquity(evalPrices, tradeCompound), [evalPrices, tradeCompound]);
  const bhMetrics = useMemo(() => buyHoldMetrics(evalPrices, tradeCompound), [evalPrices, tradeCompound]);
  const planResult = useMemo<PlanResult>(
    () => computePlan(evalPrices, specs, gapFill, costBps, tradeCompound),
    [evalPrices, specs, gapFill, costBps, tradeCompound],
  );
  const tradeMatrices = useMemo(
    () => TIMING_COMBOS.map(([entryTiming, exitTiming]) => ({
      entryTiming,
      exitTiming,
      grid: weekdayMatrix(evalPrices, entryTiming, exitTiming, builder.side, tradeCompound, matrixMetric),
    })),
    [evalPrices, builder.side, tradeCompound, matrixMetric],
  );
  const longRanking = useMemo<RankedStrategy[]>(
    () => rankLongStrategies(evalPrices, tradeCompound, rankMetric),
    [evalPrices, tradeCompound, rankMetric],
  );
  const bestCombo = useMemo<BestCombination>(
    () => bestCombination(fitPrices, tradeCompound),
    [fitPrices, tradeCompound],
  );
  useEffect(() => {
    if (specsTouched) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSpecs(prev => sameSpecList(prev, bestCombo.legs) ? prev : bestCombo.legs);
  }, [bestCombo, specsTouched]);
  const addSpecFromMatrix = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const hit = hitTestTimingMatrix(canvas.clientWidth, e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    const grid = tradeMatrices[hit.idx]?.grid;
    if (!grid || grid[hit.entryDow - 1][hit.exitDow - 1] === null) return;
    const [entryTiming, exitTiming] = TIMING_COMBOS[hit.idx];
    addSpecObj({ entryDow: hit.entryDow, entryTiming, exitDow: hit.exitDow, exitTiming, side: builder.side });
  }, [tradeMatrices, builder.side, addSpecObj]);

  const drawTimingMatrices = useCallback((
    canvas: HTMLCanvasElement,
    matrices: { entryTiming: Timing; exitTiming: Timing; grid: (number | null)[][] }[],
    metric: MatrixMetric,
  ) => {
    const dow = ["月", "火", "水", "木", "金"];
    const parentW = canvas.parentElement?.clientWidth || 600;
    const { cellW, cellH, totalH } = timingMatrixGeom(parentW);
    const r = initCanvas(canvas, totalH); if (!r) return;
    const { ctx, width } = r;
    const geom = timingMatrixGeom(width);
    const gridW = 5 * cellW, gridH = 5 * cellH;

    let maxAbs = 0;
    for (const m of matrices) for (const row of m.grid) for (const v of row) if (v !== null) maxAbs = Math.max(maxAbs, Math.abs(v));
    const fmt = (v: number) => metric === "winRate" ? (v * 100).toFixed(0) + "%" : metric === "sharpe" ? v.toFixed(2) : metric === "perDay" ? (v * 10000).toFixed(1) + "bp" : (v * 100).toFixed(1) + "%";

    matrices.forEach((m, idx) => {
      const { subLeft, subTop, gridLeft, gridTop } = geom.subAt(idx);

      ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      const entryTxt = `建 ${TIMING_LABEL[m.entryTiming]}`, arrowTxt = " → ", exitTxt = `仕舞 ${TIMING_LABEL[m.exitTiming]}`;
      const twEntry = ctx.measureText(entryTxt).width, twArrow = ctx.measureText(arrowTxt).width, twExit = ctx.measureText(exitTxt).width;
      let tx = gridLeft + (gridW - (twEntry + twArrow + twExit)) / 2;
      const titleY = subTop + 13;
      ctx.fillStyle = AXIS_ENTRY_COLOR; ctx.fillText(entryTxt, tx, titleY); tx += twEntry;
      ctx.fillStyle = "#9ca3af"; ctx.fillText(arrowTxt, tx, titleY); tx += twArrow;
      ctx.fillStyle = AXIS_EXIT_COLOR; ctx.fillText(exitTxt, tx, titleY);

      ctx.fillStyle = AXIS_EXIT_COLOR; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("エグジット(手仕舞い)曜日 →", gridLeft + gridW / 2, gridTop - geom.headerH - 3);

      ctx.save();
      ctx.translate(subLeft + geom.axisLabelW / 2 + 2, gridTop + gridH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = AXIS_ENTRY_COLOR; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("↓ エントリー(建て)曜日", 0, 0);
      ctx.restore();
      ctx.textBaseline = "alphabetic";

      ctx.fillStyle = AXIS_EXIT_COLOR; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      for (let j = 0; j < 5; j++) ctx.fillText(dow[j], gridLeft + j * cellW + cellW / 2, gridTop - 4);

      for (let i = 0; i < 5; i++) {
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

    ctx.font = "bold 9px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    let lx = 2; const ly = totalH - 3;
    ctx.fillStyle = AXIS_ENTRY_COLOR; ctx.fillText("縦↓=エントリー(建て)曜日", lx, ly); lx += ctx.measureText("縦↓=エントリー(建て)曜日").width + 8;
    ctx.fillStyle = "#9ca3af"; ctx.fillText("/", lx, ly); lx += ctx.measureText("/").width + 8;
    ctx.fillStyle = AXIS_EXIT_COLOR; ctx.fillText("横→=エグジット(手仕舞い)曜日", lx, ly);
  }, []);

  // 表示中のエクイティ系列（B&H + 戦略 or 連結プラン or 逐次WF）をまとめる。
  const equitySeriesData = useMemo(() => {
    if (isWF) {
      const strategies = walkForward
        ? [{ label: "逐次WF(週次で再最適化)", color: "#059669", points: walkForward.equity }]
        : [];
      return { strategies };
    }
    const strategies = planMode
      ? [{ label: "週内プラン(連結)", color: "#059669", points: planResult.equity }]
      : tradeResults.map((res, i) => ({
          label: specLabel(specs[i]),
          color: STRAT_COLORS[i % STRAT_COLORS.length],
          points: res.equity,
        }));
    return { strategies };
  }, [isWF, walkForward, planMode, planResult, tradeResults, specs]);

  // === エクイティ曲線チャートの生成（コンテナ出現後に1度だけ） ===
  useEffect(() => {
    if (prices.length < 2 || !equityContainerRef.current) return;
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
  }, [prices.length]);

  // === エクイティ曲線のデータ更新（系列の増減に応じて張り替え） ===
  useEffect(() => {
    const chart = equityChartRef.current;
    if (!chart) return;
    for (const s of equitySeriesRef.current) chart.removeSeries(s);
    equitySeriesRef.current = [];

    if (bhEquity.length >= 2) {
      const bhs = chart.addSeries(LineSeries, {
        color: "#9ca3af", lineWidth: 1, title: "B&H",
        priceLineVisible: false, lastValueVisible: false,
      });
      bhs.setData(toEquityRows(bhEquity));
      equitySeriesRef.current.push(bhs);
    }
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

  // === Draw 全組合せヒートマップ ===
  useEffect(() => {
    if (tradeMatrixRef.current) drawTimingMatrices(tradeMatrixRef.current, tradeMatrices, matrixMetric);
  }, [tradeMatrices, matrixMetric, drawTimingMatrices]);
  useEffect(() => {
    const onResize = () => {
      if (tradeMatrixRef.current) drawTimingMatrices(tradeMatrixRef.current, tradeMatrices, matrixMetric);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [tradeMatrices, matrixMetric, drawTimingMatrices]);

  if (prices.length < 30) {
    return <div className="text-sm text-gray-500 p-4">データが不足しています（30営業日以上が必要）。</div>;
  }

  return (
    <div className="space-y-3">
      {/* ===== 曜日トレード・シミュレータ ===== */}
      <div className="border border-emerald-100 rounded-lg p-3 bg-emerald-50/30">
        <div className="text-sm font-medium text-gray-700 mb-2">
          曜日トレード・シミュレータ
          <span className="text-xs font-normal text-gray-400">（初期表示＝買+売を組合せた最大リターンの週内プラン。任意の曜日・注文タイミングで売買を編集でき、連結モードで複数レグを1本に繋いでB&Hと公平比較）</span>
        </div>

        {/* 評価方法 + 算出/学習期間 */}
        <div className="rounded border border-emerald-100 bg-white/70 p-2.5 space-y-1.5 mb-2">
          {/* 評価方法(3択) */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span className="text-gray-600 font-medium">評価方法</span>
            <div className="inline-flex rounded overflow-hidden border border-gray-200">
              {([["full", "全履歴 (固定プラン・OOS)"], ["window", "この期間のみ (固定プラン・IS)"], ["walkforward", "逐次WF (週次で再最適化)"]] as [typeof evalMode, string][]).map(([m, lbl]) => (
                <button key={m} type="button" onClick={() => switchEvalMode(m)}
                  className={`px-2 py-0.5 ${evalMode === m ? "bg-emerald-600 text-white" : "bg-white text-gray-600 hover:bg-gray-100"}`}>{lbl}</button>
              ))}
            </div>
          </div>

          {/* 算出期間(固定プラン) / 学習ルックバック(逐次WF) */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span className="text-gray-600 font-medium">{isWF ? "学習ルックバック窓長 L" : "★最適プランの算出期間"}</span>
            {!isWF && (
              <div className="inline-flex rounded overflow-hidden border border-gray-200">
                {([["latest", "最新起点"], ["rolling", "ローリング"]] as [typeof fitMode, string][]).map(([m, lbl]) => (
                  <button key={m} type="button" onClick={() => switchFitMode(m)}
                    className={`px-2 py-0.5 ${fitMode === m ? "bg-emerald-600 text-white" : "bg-white text-gray-600 hover:bg-gray-100"}`}>{lbl}</button>
                ))}
              </div>
            )}
            <span className="text-gray-500">
              {isWF
                ? <><span className="font-mono text-gray-700">{effFitLen.toLocaleString()}</span>本 ≈{(effFitLen / 252).toFixed(1)}年 を各週の学習に使用{isFullFit && <span className="text-gray-400"> ・全期間</span>}</>
                : <><span className="font-mono text-gray-700">{fitStartDate}</span> 〜 <span className="font-mono text-gray-700">{fitEndDate}</span>
                    <span className="text-gray-400">（{effFitLen.toLocaleString()}本 ≈{(effFitLen / 252).toFixed(1)}年）</span>
                    {isFullFit && <span className="text-gray-400"> ・全期間</span>}</>}
            </span>
          </div>

          {/* 窓長プリセット */}
          <div className="flex flex-wrap items-center gap-1 text-[11px]">
            <span className="text-gray-500 mr-0.5">窓長</span>
            {([["1M", 21], ["2M", 42], ["3M", 63], ["6M", 126], ["1Y", 252], ["2Y", 504], ["3Y", 756]] as [string, number][])
              .filter(([, n]) => n < prices.length)
              .map(([lbl, n]) => (
                <button key={lbl} type="button" onClick={() => setFitLenPreset(n)}
                  className={`px-1.5 py-0.5 rounded ${!isFullFit && effFitLen === n ? "bg-emerald-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}>{lbl}</button>
              ))}
            {fitMode === "latest" && (
              <button type="button" onClick={() => setFitLen(prices.length)}
                className={`px-1.5 py-0.5 rounded ${isFullFit ? "bg-emerald-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}>全期間</button>
            )}
          </div>

          {(!isWF && fitMode === "rolling") ? (
            <>
              {/* ローリング固定プラン: 窓の位置(右端)を手動で移動 */}
              <div className="flex items-center gap-2">
                <input type="range" min={effFitLen} max={prices.length} step={1} value={effFitEnd}
                  onChange={(e) => setFitEnd(Number(e.target.value))}
                  className="w-full accent-emerald-600" aria-label="窓の位置(右端)" />
                <button type="button" onClick={() => setFitEnd(prices.length)} disabled={fitBarsAfter === 0}
                  className={`px-1.5 py-0.5 rounded text-[11px] whitespace-nowrap ${fitBarsAfter === 0 ? "bg-gray-100 text-gray-400" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}>最新へ</button>
              </div>
              <p className="text-[10px] text-gray-400">窓長を固定したまま、スライダーで<span className="font-medium">窓の位置</span>を過去↔最新へ動かします（現在は最新から <span className="font-mono">{fitBarsAfter.toLocaleString()}</span> 本前で終了）。同じ窓長で位置だけずらして、★最適プランがどの時期に現れ・消えたかを確認できます。</p>
            </>
          ) : (
            <>
              {/* 最新起点(固定プラン) / 逐次WF: 窓長(=学習ルックバック)を変更 */}
              <input type="range" min={60} max={prices.length} step={1} value={effFitLen}
                onChange={(e) => { setFitLen(Number(e.target.value)); setFitEnd(prices.length); }}
                className="w-full accent-emerald-600" aria-label={isWF ? "学習ルックバック窓長" : "窓長"} />
              <p className="text-[10px] text-gray-400">
                {isWF
                  ? <>スライダーで<span className="font-medium">学習ルックバック窓長 L</span> を変更。各週この本数だけ遡って最適プランを組み直します。短い窓ほど直近の癖に素早く追随し、長い窓ほど安定します。</>
                  : <>スライダーで窓長を変更（右端は常に最新）。左に動かすほど新しい期間だけで★最適プランを組み直します。</>}
              </p>
            </>
          )}

          {/* 評価方法の説明 */}
          <div className="border-t border-emerald-100 pt-1.5 text-[10px] text-gray-400">
            {evalMode === "full" && (
              <>窓で選んだ<span className="font-medium">単一の最適プラン</span>を<span className="font-medium">全履歴</span>で評価（算出窓の外＝アウトオブサンプル）。過剰適合の頑健性チェック。
                {specsTouched && <span className="text-amber-700"> ※現在は手動編集プランを評価中（算出期間は★最適プランの参考表示）。</span>}</>
            )}
            {evalMode === "window" && (
              <>窓で選んだ<span className="font-medium">単一の最適プラン</span>を<span className="font-medium">その窓のみ</span>で評価（イン・サンプルの当てはまり）。{!isFullFit && <>対象 <span className="font-mono">{fitStartDate}〜{fitEndDate}</span>。</>}
                {specsTouched && <span className="text-amber-700"> ※現在は手動編集プランを評価中。</span>}</>
            )}
            {isWF && (
              walkForward && walkForward.firstTradeDate
                ? <>各週の<span className="font-medium">直前 {effFitLen.toLocaleString()}本(≈{(effFitLen / 252).toFixed(1)}年)</span>だけで最適プランを組み直し、その週を売買して積み上げる<span className="font-medium text-emerald-700">真のアウトオブサンプル運用</span>。売買開始 <span className="font-mono">{walkForward.firstTradeDate}</span>／全{walkForward.nWeeks.toLocaleString()}週中 {walkForward.nActiveWeeks.toLocaleString()}週を運用（学習不足の序盤は待機）。手仕舞い/建て替えのコストは下の「取引コスト」に従う。</>
                : <span className="text-amber-700">学習データが不足していて売買できる週がありません。ルックバック窓長を長く（3M以上を目安）してください。</span>
            )}
          </div>
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
              {!isFullFit && <span className="font-normal">・算出期間 {fitStartDate}〜{fitEndDate}</span>}
            </span>
          )}
          {onSendPlan && (
            <button onClick={() => onSendPlan(bestCombo.slots.map(s => s.side))} className="px-2 py-0.5 text-[11px] rounded bg-blue-600 text-white hover:bg-blue-700" title="この最適プラン(週内10スロットのサイド)を上のワークベンチ共有プランへ送り、税引後・レバ評価に使う">
              ② 共有プランへ送る
            </button>
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
        {((isWF && walkForward) || (!isWF && specs.length > 0)) && (
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
                {isWF && walkForward && (
                  <tr className="border-b border-gray-200 bg-emerald-50">
                    <td className="py-1 px-2 font-medium" style={{ color: "#059669" }}>逐次WF(前{effFitLen.toLocaleString()}本・{walkForward.nActiveWeeks.toLocaleString()}週){gapFill === "hold" ? "・隙間ロング" : ""}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600" title="ポジション変更回数(週次の建て替え含む)">{walkForward.nTurnovers}</td>
                    <td className={`py-1 px-2 text-center font-mono ${colorClass(walkForward.totalReturn)}`}>{pct2(walkForward.totalReturn)}</td>
                    <td className={`py-1 px-2 text-center font-mono ${colorClass(walkForward.annualized)}`}>{pct2(walkForward.annualized)}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{walkForward.sharpe.toFixed(2)}</td>
                    <td className="py-1 px-2 text-center font-mono text-red-600">{pct2(walkForward.maxDD)}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-400">-</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-400">-</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{pct2(walkForward.exposure)}</td>
                    <td className={`py-1 px-2 text-center font-mono ${colorClass(walkForward.exposure > 0 ? walkForward.totalReturn / walkForward.exposure : 0)}`}>{walkForward.exposure > 0 ? pct2(walkForward.totalReturn / walkForward.exposure) : "-"}</td>
                  </tr>
                )}
                {!isWF && planMode && (
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
                {!isWF && tradeResults.map((res, i) => (
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
            {isWF && walkForward && (
              <div className="text-[11px] text-gray-500 mt-1">
                グロス(コスト前) {pct2(walkForward.grossReturn)} − コスト {pct2(walkForward.totalCost)} = 純 {pct2(walkForward.totalReturn)}（週次の建て替えを含む回転 {walkForward.nTurnovers} 回 @ {costBps}bps/片道）。
                各週その週の<span className="font-medium">直前 {effFitLen.toLocaleString()}本のみ</span>で最適化するため、B&Hとの差＝<span className="font-medium">実運用可能な曜日エッジの正味価値</span>（後知恵なし）。序盤の学習待機は{gapFill === "hold" ? "常時ロング" : "ノーポジ(現金)"}。
              </div>
            )}
            {!isWF && planMode && (
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
            <li><span className="font-medium">評価方法（3択）:</span> 上部の<span className="font-medium">「評価方法」</span>で、最適プランのエクイティ/最大DD/コスト後の測り方を選べる。
              <ul className="list-[circle] pl-4 mt-0.5 space-y-0.5">
                <li><span className="font-medium">全履歴（固定プラン・OOS）:</span> 「★最適プランの算出期間」で選んだ<span className="font-medium">単一</span>の最適プランを全履歴に当てる。算出窓を直近に絞れば、窓の外＝アウトオブサンプルとして頑健性を見られる。算出期間は<span className="font-medium">「最新起点」</span>（右端最新・窓長可変）／<span className="font-medium">「ローリング」</span>（窓長固定・位置を過去↔最新へ手動移動）で任意のローリング期間を選択可。</li>
                <li><span className="font-medium">この期間のみ（固定プラン・IS）:</span> 同じ単一プランを算出窓の中だけで評価（イン・サンプルの当てはまり）。</li>
                <li><span className="font-medium">逐次WF（ウォークフォワード）:</span> <span className="font-medium">各週ごとに、その週の直前 L 本だけで最適プランを組み直し、その週を売買</span>して履歴を通して積み上げる。各週の建玉は「その時点までに観測できた情報」だけで決まるため、<span className="font-medium">後知恵を含まない真のアウトオブサンプル運用結果</span>になる（ルックバック窓長 L は下のスライダーで指定）。学習データが足りない序盤は待機。B&Hや上記の固定プラン(IS/OOS)と累積カーブを見比べれば、「過去最適の見かけ倒し」と「実際に運用できるエッジ」を切り分けられる。</li>
              </ul>
            </li>
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
    </div>
  );
}
