"use client";

// NISA(非課税・持ち切り) vs 現物(課税・曜日タイミング戦略) の税引後 最終リターン比較。
// 「年初に全枠使い切って売らずに持つNISA」と「期待値が負の区間(例: 金曜引け→月曜)は
// 持たず良い区間だけ現物で回す戦略」を、税・コスト控除後で公平に比較する。
// 詳しい理論・税式・損益分岐は末尾の AnalysisGuide を参照。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { bestCombination, legsFromSlotSides, type TradeSpec } from "../../lib/weekday-trade";
import {
  compareNisaVsTaxable,
  rollingComparison,
  yenComparison,
  leverageSweep,
  TAX_RATE,
  GROWTH_QUOTA,
  ANNUAL_QUOTA,
  MAX_LEVERAGE,
  DEFAULT_MARGIN_RATE_LONG,
  DEFAULT_SHORT_FEE_RATE,
  DEFAULT_MAINTENANCE,
  type TaxModel,
  type Comparison,
  type SimResult,
  type ComparisonInput,
  type LeverageSweep,
} from "../../lib/nisa-vs-taxable";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";
import WeekSlotGrid, { type SlotSide, AVOID_WEEKEND } from "./WeekSlotGrid";

interface Props {
  prices: PricePoint[];
  // workbench 連携: プランを外部制御する場合(指定時は内部グリッドを隠す)
  plan?: SlotSide[];
}

type ViewMode = "single" | "rolling" | "leverage";

const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const num2 = (v: number) => v.toFixed(2);
const cls = (v: number) => (v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500");
const yen = (v: number) => `${Math.round(v).toLocaleString()}円`;

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
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

export default function NisaVsTaxableChart({ prices, plan }: Props) {
  const controlled = plan !== undefined; // workbench からプランを渡された場合は内部グリッドを隠す
  const [taxModel, setTaxModel] = useState<TaxModel>("yearEnd");
  const [taxRatePct, setTaxRatePct] = useState(TAX_RATE * 100);
  const [costBps, setCostBps] = useState(5);
  const [view, setView] = useState<ViewMode>("rolling");
  const [yenMode, setYenMode] = useState(false);
  const [capital, setCapital] = useState(3_000_000);
  const [quota, setQuota] = useState(GROWTH_QUOTA);
  // 信用取引パラメータ(戦略シナリオにのみ適用。NISA/現物BHは現物lev1)
  const [leverage, setLeverage] = useState(1);
  const [marginRatePct, setMarginRatePct] = useState(DEFAULT_MARGIN_RATE_LONG * 100);
  const [shortFeePct, setShortFeePct] = useState(DEFAULT_SHORT_FEE_RATE * 100);
  const [maintPct, setMaintPct] = useState(DEFAULT_MAINTENANCE * 100);

  // 戦略スロット。制御時は外部プラン、非制御時は内部state(初期値=bestCombの最適プラン)。
  const best = useMemo(() => (prices.length > 60 ? bestCombination(prices, true) : null), [prices]);
  const [sides, setSides] = useState<SlotSide[] | null>(null);
  const effSides: SlotSide[] = useMemo(() => {
    if (controlled) return plan!;
    if (sides) return sides;
    if (best) return best.slots.map((s) => s.side);
    return AVOID_WEEKEND;
  }, [controlled, plan, sides, best]);

  const legs: TradeSpec[] = useMemo(() => legsFromSlotSides(effSides), [effSides]);
  const taxRate = taxRatePct / 100;

  // 戦略シナリオに渡す信用パラメータ(単年/ローリングは選択レバ、スイープは内部でk可変)
  const baseInput: Omit<ComparisonInput, "prices"> = useMemo(() => ({
    legs, gapFill: "cash", taxModel, taxRate, costBps,
    leverage,
    marginRateLong: marginRatePct / 100,
    shortFeeRate: shortFeePct / 100,
    maintenanceMargin: maintPct / 100,
  }), [legs, taxModel, taxRate, costBps, leverage, marginRatePct, shortFeePct, maintPct]);

  const cmp = useMemo<Comparison | null>(() => {
    if (prices.length < 60) return null;
    return compareNisaVsTaxable({ prices, ...baseInput });
  }, [prices, baseInput]);

  const rolling = useMemo(() => {
    if (view !== "rolling" || prices.length < 300) return null;
    return rollingComparison({ prices, ...baseInput }, 252, 5);
  }, [view, prices, baseInput]);

  // レバレッジ探索: 1.0〜MAX_LEVERAGE を 0.1 刻みでスイープ
  const sweep = useMemo<LeverageSweep | null>(() => {
    if (view !== "leverage" || prices.length < 300) return null;
    const levs: number[] = [];
    for (let k = 1; k <= MAX_LEVERAGE + 1e-9; k += 0.1) levs.push(Math.round(k * 10) / 10);
    return leverageSweep({ prices, ...baseInput }, levs, 252, 5);
  }, [view, prices, baseInput]);

  const yenRes = useMemo(() => (cmp && yenMode ? yenComparison(cmp, capital, quota) : null), [cmp, yenMode, capital, quota]);

  // === 単年エクイティ(税引後清算価値) — 横軸=日付なので lightweight-charts ===
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const showChart = view === "single" && cmp !== null;

  useEffect(() => {
    if (!showChart || !containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 280,
      crosshair: { mode: 0 },
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(0)}%` },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    chartRef.current = chart;
    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
    };
  }, [showChart]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !cmp || !showChart) return;
    for (const s of seriesRef.current) chart.removeSeries(s);
    seriesRef.current = [];
    const toRows = (r: SimResult) => r.path.map((p) => ({ time: (Math.floor(p.t / 86400000) * 86400) as unknown as Time, value: p.post - 1 }));
    const nisaS = chart.addSeries(LineSeries, { color: "#059669", lineWidth: 2, title: "NISA(非課税)", priceLineVisible: false });
    nisaS.setData(dedupe(toRows(cmp.nisa)));
    const bhS = chart.addSeries(LineSeries, { color: "#9ca3af", lineWidth: 1, title: "現物B&H(課税)", priceLineVisible: false });
    bhS.setData(dedupe(toRows(cmp.taxableBH)));
    const stS = chart.addSeries(LineSeries, { color: "#2563eb", lineWidth: 2, title: "現物 曜日戦略", priceLineVisible: false });
    stS.setData(dedupe(toRows(cmp.strategy)));
    seriesRef.current = [nisaS, bhS, stS];
    if (containerRef.current && containerRef.current.clientWidth > 0) chart.applyOptions({ width: containerRef.current.clientWidth });
    chart.timeScale().fitContent();
  }, [cmp, showChart]);

  // === ローリング差の分布(Canvas2D ヒストグラム) ===
  const histRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (view !== "rolling" || !rolling || !histRef.current || rolling.points.length === 0) return;
    const c = initCanvas(histRef.current, 200);
    if (!c) return;
    const { ctx, width, height } = c;
    const edges = rolling.points.map((p) => p.edge);
    const lo = Math.min(...edges, -0.01), hi = Math.max(...edges, 0.01);
    const nBins = 41;
    const bins = new Array(nBins).fill(0);
    for (const e of edges) {
      const idx = Math.min(nBins - 1, Math.max(0, Math.floor(((e - lo) / (hi - lo)) * nBins)));
      bins[idx]++;
    }
    const maxCount = Math.max(...bins);
    const padL = 8, padR = 8, padT = 12, padB = 24;
    const plotW = width - padL - padR, plotH = height - padT - padB;
    const x0 = padL + ((0 - lo) / (hi - lo)) * plotW; // edge=0 の位置
    // バー
    for (let i = 0; i < nBins; i++) {
      const binLo = lo + (i / nBins) * (hi - lo);
      const bh = (bins[i] / maxCount) * plotH;
      const bx = padL + (i / nBins) * plotW;
      const bw = plotW / nBins - 1;
      ctx.fillStyle = binLo >= 0 ? "#2563eb" : "#f87171"; // 正=戦略勝ち(青) / 負=NISA勝ち(赤)
      ctx.fillRect(bx, padT + plotH - bh, bw, bh);
    }
    // 0 の縦線
    ctx.strokeStyle = "#374151"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, padT); ctx.lineTo(x0, padT + plotH); ctx.stroke();
    ctx.fillStyle = "#374151"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("差=0", x0, padT + plotH + 12);
    // 中央値マーカー
    const xm = padL + ((rolling.medianEdge - lo) / (hi - lo)) * plotW;
    ctx.strokeStyle = "#f59e0b"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(xm, padT); ctx.lineTo(xm, padT + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#b45309"; ctx.textAlign = xm > width / 2 ? "right" : "left";
    ctx.fillText(`中央値 ${pct(rolling.medianEdge)}`, xm + (xm > width / 2 ? -4 : 4), padT + 10);
    // 軸ラベル
    ctx.fillStyle = "#9ca3af"; ctx.textAlign = "left";
    ctx.fillText(`←NISA有利 ${pct(lo)}`, padL, height - 4);
    ctx.textAlign = "right";
    ctx.fillText(`${pct(hi)} 戦略有利→`, width - padR, height - 4);
  }, [view, rolling]);

  // === レバレッジ探索: リターン曲線 + リスク曲線(Canvas2D) ===
  const retCanvasRef = useRef<HTMLCanvasElement>(null);
  const riskCanvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (view !== "leverage" || !sweep || sweep.points.length === 0) return;
    const pts = sweep.points;
    const kMin = pts[0].leverage, kMax = pts[pts.length - 1].leverage;
    const xAt = (k: number, padL: number, plotW: number) => padL + ((k - kMin) / (kMax - kMin || 1)) * plotW;

    // --- Panel A: 税引後リターン(中央値) vs レバ ---
    if (retCanvasRef.current) {
      const c = initCanvas(retCanvasRef.current, 200);
      if (c) {
        const { ctx, width, height } = c;
        const padL = 44, padR = 10, padT = 12, padB = 22;
        const plotW = width - padL - padR, plotH = height - padT - padB;
        const vals = pts.map((p) => p.afterTaxReturn).concat([sweep.nisaAfterTax, 0]);
        const lo = Math.min(...vals), hi = Math.max(...vals);
        const yAt = (v: number) => padT + (1 - (v - lo) / (hi - lo || 1)) * plotH;
        // 0ライン
        ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, yAt(0)); ctx.lineTo(padL + plotW, yAt(0)); ctx.stroke();
        // NISA水平線
        ctx.strokeStyle = "#059669"; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(padL, yAt(sweep.nisaAfterTax)); ctx.lineTo(padL + plotW, yAt(sweep.nisaAfterTax)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#059669"; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
        ctx.fillText(`NISA ${pct(sweep.nisaAfterTax)}`, padL + 2, yAt(sweep.nisaAfterTax) - 3);
        // 戦略リターン曲線
        ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2; ctx.beginPath();
        pts.forEach((p, i) => { const x = xAt(p.leverage, padL, plotW), y = yAt(p.afterTaxReturn); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.stroke();
        // k* 縦線
        if (sweep.kStar !== null && sweep.kStar <= kMax) {
          const xk = xAt(sweep.kStar, padL, plotW);
          ctx.strokeStyle = "#f59e0b"; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(xk, padT); ctx.lineTo(xk, padT + plotH); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "#b45309"; ctx.textAlign = "center";
          ctx.fillText(`k*=${sweep.kStar.toFixed(2)}`, xk, padT + 9);
        }
        // y軸ラベル
        ctx.fillStyle = "#9ca3af"; ctx.textAlign = "right";
        ctx.fillText(pct(hi), padL - 4, padT + 8);
        ctx.fillText(pct(lo), padL - 4, padT + plotH);
        ctx.textAlign = "center";
        ctx.fillText(`レバ ${kMin}×`, padL, height - 5);
        ctx.fillText(`${kMax}×`, padL + plotW, height - 5);
        ctx.fillStyle = "#2563eb"; ctx.fillText("戦略 税引後(中央値)", padL + plotW / 2, height - 5);
      }
    }

    // --- Panel B: リスク vs レバ(|MaxDD|・ボラ・追証確率・破産確率, すべて%) ---
    if (riskCanvasRef.current) {
      const c = initCanvas(riskCanvasRef.current, 200);
      if (c) {
        const { ctx, width, height } = c;
        const padL = 40, padR = 10, padT = 12, padB = 22;
        const plotW = width - padL - padR, plotH = height - padT - padB;
        const series: { key: keyof (typeof pts)[0]; color: string; label: string; abs?: boolean }[] = [
          { key: "maxDD", color: "#ef4444", label: "|最大DD|", abs: true },
          { key: "volAnnual", color: "#8b5cf6", label: "年率ボラ" },
          { key: "marginCallProb", color: "#f59e0b", label: "追証確率" },
          { key: "ruinProb", color: "#111827", label: "破産確率" },
        ];
        let hi = 0.01;
        for (const s of series) for (const p of pts) { const v = Math.abs(p[s.key] as number); if (v > hi) hi = v; }
        hi = Math.min(hi, 2); // 極端値のクリップ
        const yAt = (v: number) => padT + (1 - v / hi) * plotH;
        // グリッド
        ctx.strokeStyle = "#f3f4f6"; ctx.lineWidth = 1;
        for (let g = 0; g <= 4; g++) { const y = padT + (g / 4) * plotH; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke(); }
        for (const s of series) {
          ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.beginPath();
          pts.forEach((p, i) => { const v = s.abs ? Math.abs(p[s.key] as number) : (p[s.key] as number); const x = xAt(p.leverage, padL, plotW), y = yAt(Math.min(v, hi)); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
          ctx.stroke();
        }
        // k* 縦線
        if (sweep.kStar !== null && sweep.kStar <= kMax) {
          const xk = xAt(sweep.kStar, padL, plotW);
          ctx.strokeStyle = "#fbbf24"; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(xk, padT); ctx.lineTo(xk, padT + plotH); ctx.stroke();
          ctx.setLineDash([]);
        }
        // 軸・凡例
        ctx.fillStyle = "#9ca3af"; ctx.font = "10px sans-serif"; ctx.textAlign = "right";
        ctx.fillText(`${(hi * 100).toFixed(0)}%`, padL - 4, padT + 8);
        ctx.fillText("0%", padL - 4, padT + plotH);
        ctx.textAlign = "center";
        ctx.fillText(`レバ ${kMin}×`, padL, height - 5);
        ctx.fillText(`${kMax}×`, padL + plotW, height - 5);
        let lx = padL + 30;
        for (const s of series) { ctx.fillStyle = s.color; ctx.textAlign = "left"; ctx.fillText(`■${s.label}`, lx, height - 5); lx += 74; }
      }
    }
  }, [view, sweep]);

  if (prices.length < 60) {
    return <div className="text-sm text-gray-500 p-4">データが不足しています（60営業日以上が必要）。</div>;
  }
  if (!cmp) return null;

  const winnerLabel = cmp.winner === "strategy" ? "現物 曜日戦略" : cmp.winner === "nisa" ? "NISA(非課税・持ち切り)" : "引き分け";
  const winnerColor = cmp.winner === "strategy" ? "bg-blue-50 border-blue-300" : cmp.winner === "nisa" ? "bg-emerald-50 border-emerald-300" : "bg-gray-50 border-gray-300";

  const rows: { label: string; get: (r: SimResult) => string; color?: (r: SimResult) => string }[] = [
    { label: "税引前リターン", get: (r) => pct(r.preTaxReturn), color: (r) => cls(r.preTaxReturn) },
    { label: "税引後リターン", get: (r) => pct(r.afterTaxReturn), color: (r) => cls(r.afterTaxReturn) },
    { label: "支払税(富比)", get: (r) => `−${(r.taxPaid * 100).toFixed(2)}%`, color: () => "text-rose-500" },
    { label: "取引コスト", get: (r) => `−${(r.cost * 100).toFixed(2)}%`, color: () => "text-gray-500" },
    { label: "市場滞在率", get: (r) => `${(r.exposure * 100).toFixed(0)}%` },
    { label: "往復回数", get: (r) => `${r.nRoundTrips}` },
    { label: "年率ボラ", get: (r) => `${(r.volAnnual * 100).toFixed(1)}%` },
    { label: "最大DD", get: (r) => pct(r.maxDD), color: (r) => cls(r.maxDD) },
    { label: "Sharpe", get: (r) => num2(r.sharpe), color: (r) => cls(r.sharpe) },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        <span className="font-medium">NISA（年初に全枠使い切り、売らずに持ち切り・非課税）</span>と、
        <span className="font-medium">現物で曜日タイミング戦略（期待値が負の区間は現金・実現益に課税）</span>を回した場合の、
        <span className="font-medium">税・コスト控除後の最終リターン</span>を同一エンジンで比較します。各営業日の
        「今すべて売って税を精算したら手元にいくら残るか（清算価値）」を税引後エクイティとしています。
      </p>

      {/* 勝者バナー */}
      <div className={`rounded-lg border p-3 text-sm ${winnerColor}`}>
        <span className="font-medium">税引後で上回るのは: </span>
        <span className="font-bold">{winnerLabel}</span>
        <span className="text-gray-600">
          （NISA {pct(cmp.nisa.afterTaxReturn)} / 戦略 {pct(cmp.strategy.afterTaxReturn)} / 差{" "}
          <span className={cls(cmp.edge)}>{pct(cmp.edge)}</span>）
        </span>
        {rolling && (
          <span className="ml-1 text-gray-600">
            — ローリング1年窓では戦略が <span className="font-medium">{(rolling.winRate * 100).toFixed(0)}%</span> の年でNISAを上回り（中央値差 {pct(rolling.medianEdge)}）。
          </span>
        )}
      </div>

      {/* コントロール */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <div className="flex items-center gap-1">
          <span className="text-gray-500">表示:</span>
          {([["rolling", "ローリング分布"], ["single", "単年エクイティ"], ["leverage", "レバレッジ探索"]] as [ViewMode, string][]).map(([m, label]) => (
            <button key={m} onClick={() => setView(m)} className={`px-2 py-0.5 rounded border ${view === m ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-600 border-gray-300"}`}>{label}</button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-500">税モデル:</span>
          {([["yearEnd", "源泉なし(年末一括)"], ["withholding", "源泉あり(都度)"]] as [TaxModel, string][]).map(([m, label]) => (
            <button key={m} onClick={() => setTaxModel(m)} className={`px-2 py-0.5 rounded border ${taxModel === m ? "bg-rose-600 text-white border-rose-600" : "bg-white text-gray-600 border-gray-300"}`}>{label}</button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-gray-500">
          税率
          <input type="number" min={0} max={55} step={0.1} value={taxRatePct} onChange={(e) => setTaxRatePct(Math.max(0, Number(e.target.value) || 0))} className="w-16 border border-gray-200 rounded px-1 py-0.5 bg-white text-right" />%
        </label>
        <label className="flex items-center gap-1 text-gray-500">
          片道コスト
          <input type="number" min={0} max={50} step={1} value={costBps} onChange={(e) => setCostBps(Math.max(0, Number(e.target.value) || 0))} className="w-14 border border-gray-200 rounded px-1 py-0.5 bg-white text-right" />bps
        </label>
        <label className="flex items-center gap-1 text-gray-500">
          <input type="checkbox" checked={yenMode} onChange={(e) => setYenMode(e.target.checked)} /> 円建て
        </label>
        {yenMode && (
          <>
            <label className="flex items-center gap-1 text-gray-500">
              資本
              <input type="number" min={0} step={100000} value={capital} onChange={(e) => setCapital(Math.max(0, Number(e.target.value) || 0))} className="w-28 border border-gray-200 rounded px-1 py-0.5 bg-white text-right" />円
            </label>
            <label className="flex items-center gap-1 text-gray-500">
              NISA枠
              <select value={quota} onChange={(e) => setQuota(Number(e.target.value))} className="border border-gray-200 rounded px-1 py-0.5 bg-white">
                <option value={GROWTH_QUOTA}>成長枠 240万</option>
                <option value={ANNUAL_QUOTA}>年間合計 360万</option>
                <option value={1e12}>上限なし</option>
              </select>
            </label>
          </>
        )}
      </div>

      {/* 信用取引パラメータ(戦略シナリオにのみ適用。NISA/現物BHは現物lev1) */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm rounded-lg border border-purple-200 bg-purple-50/40 p-2">
        <span className="text-xs font-medium text-purple-800">信用取引（戦略のみ）</span>
        <label className="flex items-center gap-1.5 text-gray-600">
          レバ {leverage.toFixed(1)}×
          <input type="range" min={1} max={MAX_LEVERAGE} step={0.1} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className="w-32" />
        </label>
        <label className="flex items-center gap-1 text-gray-500">
          買い方金利
          <input type="number" min={0} max={20} step={0.1} value={marginRatePct} onChange={(e) => setMarginRatePct(Math.max(0, Number(e.target.value) || 0))} className="w-14 border border-gray-200 rounded px-1 py-0.5 bg-white text-right" />%
        </label>
        <label className="flex items-center gap-1 text-gray-500">
          貸株料
          <input type="number" min={0} max={20} step={0.1} value={shortFeePct} onChange={(e) => setShortFeePct(Math.max(0, Number(e.target.value) || 0))} className="w-14 border border-gray-200 rounded px-1 py-0.5 bg-white text-right" />%
        </label>
        <label className="flex items-center gap-1 text-gray-500">
          追証維持率
          <input type="number" min={0} max={100} step={1} value={maintPct} onChange={(e) => setMaintPct(Math.max(0, Number(e.target.value) || 0))} className="w-14 border border-gray-200 rounded px-1 py-0.5 bg-white text-right" />%
        </label>
        <span className="text-[11px] text-gray-400">レバ1×＝現物相当（買いは金利0、売りは貸株料のみ）。NISAは信用不可。</span>
      </div>

      {/* 戦略スロット・グリッド(workbench制御時は上流で編集するので隠す) */}
      {!controlled && (
        <WeekSlotGrid
          sides={effSides}
          onChange={setSides}
          best={best}
          title="現物戦略：週内どの区間を持つか"
          hint={<>各区間をクリックで 無（現金）→ 買 → 売 を切替。緑=買・赤=売・灰=現金。右端「金→月」が週末ギャップ。ユーザー例「金→月は持たず月曜から保有」は<span className="font-medium">週末回避</span>プリセット。</>}
        />
      )}

      {view === "single" && (
        <>
          <div>
            <div className="text-xs text-gray-500 mb-1">税引後 清算価値の推移（緑=NISA / 灰=現物B&H / 青=現物戦略, ホイールでズーム）</div>
            <div ref={containerRef} className="w-full" />
          </div>

          {/* 3シナリオ指標表 */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-300 text-gray-500 text-xs">
                  <th className="text-left py-1 px-2">指標</th>
                  <th className="text-right py-1 px-2 text-emerald-700">NISA(非課税)</th>
                  <th className="text-right py-1 px-2">現物B&H(課税)</th>
                  <th className="text-right py-1 px-2 text-blue-700">現物 曜日戦略</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label} className="border-b border-gray-100">
                    <td className="py-1 px-2 text-gray-600">{row.label}</td>
                    {[cmp.nisa, cmp.taxableBH, cmp.strategy].map((r, i) => (
                      <td key={i} className={`text-right px-2 ${row.color ? row.color(r) : "text-gray-700"}`}>{row.get(r)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view === "rolling" && rolling && (
        <>
          <div>
            <div className="text-xs text-gray-500 mb-1">ローリング1年窓での「戦略 − NISA」税引後リターン差の分布（青=戦略勝ち / 赤=NISA勝ち, {rolling.points.length}窓）</div>
            <canvas ref={histRef} />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <Stat label="戦略の勝率" value={`${(rolling.winRate * 100).toFixed(0)}%`} sub="NISAを上回った窓" color={rolling.winRate > 0.5 ? "text-blue-600" : "text-emerald-600"} />
            <Stat label="差の中央値" value={pct(rolling.medianEdge)} sub="戦略 − NISA" color={cls(rolling.medianEdge)} />
            <Stat label="差の平均" value={pct(rolling.meanEdge)} sub="戦略 − NISA" color={cls(rolling.meanEdge)} />
            <Stat label="差の5–95%" value={`${pct(rolling.p5)} 〜 ${pct(rolling.p95)}`} sub="ばらつき" />
          </div>
          <p className="text-xs text-gray-400">
            単年は誤差が大きいため、10年履歴を1年窓でずらして分布を見るのが頑健です。分布が全体的に0より左（赤側）なら、税・コストを踏まえると
            この戦略はNISA持ち切りに負けやすいことを意味します。
          </p>
        </>
      )}

      {view === "leverage" && sweep && (
        <>
          {/* k* ヘッドライン */}
          <div className="rounded-lg border border-purple-300 bg-purple-50 p-3 text-sm">
            <span className="font-medium text-purple-800">NISAを上回るのに必要な最小レバ k*: </span>
            {sweep.kStar === null ? (
              <span className="font-bold text-purple-900">上限 {MAX_LEVERAGE}× でも届かず</span>
            ) : sweep.kStar <= 1.0001 ? (
              <span className="font-bold text-blue-700">レバ不要（現物1×で既にNISA超え）</span>
            ) : (
              <span className="font-bold text-purple-900">約 {sweep.kStar.toFixed(2)}×</span>
            )}
            <span className="ml-1 text-gray-600">
              （NISA税引後 中央値 {pct(sweep.nisaAfterTax)} を基準・ローリング1年窓の中央値で比較）
            </span>
            {sweep.kStar !== null && sweep.kStar > 1.0001 && (() => {
              const nearK = sweep.points.reduce((a, b) => (Math.abs(b.leverage - (sweep.kStar as number)) < Math.abs(a.leverage - (sweep.kStar as number)) ? b : a));
              return (
                <span className="ml-1 text-rose-600">
                  ただし k* 近傍では 追証確率 {(nearK.marginCallProb * 100).toFixed(0)}% / 破産確率 {(nearK.ruinProb * 100).toFixed(0)}% / |最大DD| {(Math.abs(nearK.maxDD) * 100).toFixed(0)}% ——期待値は並んでもリスクは別物です。
                </span>
              );
            })()}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-gray-500 mb-1">① 税引後リターン（中央値） vs レバ（緑破線=NISA / 橙=k*）</div>
              <canvas ref={retCanvasRef} />
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">② リスクの代償 vs レバ（レバに比例して拡大）</div>
              <canvas ref={riskCanvasRef} />
            </div>
          </div>

          {/* 選択レバでのキャリーコスト内訳 */}
          <div className="rounded-lg border border-gray-200 p-3 text-sm space-y-1">
            <div className="font-medium text-gray-700">選択レバ {leverage.toFixed(1)}× での摩擦内訳（全期間・戦略, 富比）</div>
            <div className="flex justify-between"><span className="text-gray-500">取引コスト（往復 {cmp.strategy.nRoundTrips}回 @ {costBps}bps×レバ）</span><span className="text-gray-600">−{(cmp.strategy.cost * 100).toFixed(2)}%</span></div>
            <div className="flex justify-between"><span className="text-gray-500">信用 買い方金利（{marginRatePct}%/年 × 借入{Math.max(0, leverage - 1).toFixed(1)}×）</span><span className="text-purple-600">−{(cmp.strategy.carryLong * 100).toFixed(2)}%</span></div>
            <div className="flex justify-between"><span className="text-gray-500">貸株料（{shortFeePct}%/年 × 売り建て）</span><span className="text-purple-600">−{(cmp.strategy.carryShort * 100).toFixed(2)}%</span></div>
            <div className="flex justify-between"><span className="text-gray-500">支払税</span><span className="text-rose-500">−{(cmp.strategy.taxPaid * 100).toFixed(2)}%</span></div>
            <div className="flex justify-between border-t border-gray-100 pt-1"><span className="text-gray-500">→ 税引後リターン（この全期間）</span><span className={`font-medium ${cls(cmp.strategy.afterTaxReturn)}`}>{pct(cmp.strategy.afterTaxReturn)}</span></div>
            <p className="text-[11px] text-gray-400">キャリーは持ち越し日数比例（金→月の週末は3日分）。逆日歩（品貸料）は変動のため未計上——実際はさらに不利になり得ます。</p>
          </div>

          <p className="text-xs text-gray-400">
            レバkで期待リターンは概ねk倍に伸びますが、ボラ・最大DD・追証/破産確率も比例〜非線形に拡大し、キャリーコストも増えます。
            k*は「期待値でNISAに並ぶ点」であって「合理的な点」ではありません。追証・破産確率とMaxDDを見て、リスクに見合うかを判断してください。
          </p>
        </>
      )}

      {/* 損益分岐カード */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
        <span className="font-medium text-amber-800">税の損益分岐: </span>
        現物戦略が<span className="font-medium">非課税のNISA持ち切り（税引後 {pct(cmp.nisa.afterTaxReturn)}）</span>に並ぶには、
        税引前で <span className="font-bold">{pct(cmp.breakEvenGross)}</span> 稼ぐ必要があります
        （税率 {taxRatePct.toFixed(3)}% ぶんの上乗せハードル <span className={cls(cmp.requiredEdge)}>{pct(cmp.requiredEdge)}</span>）。
        現状の戦略は税引前 {pct(cmp.strategy.preTaxReturn)} なので、
        <span className={cmp.strategy.preTaxReturn >= cmp.breakEvenGross ? "text-blue-600 font-medium" : "text-emerald-600 font-medium"}>
          {cmp.strategy.preTaxReturn >= cmp.breakEvenGross ? " ハードルを越えています。" : " ハードルに届いていません。"}
        </span>
      </div>

      {/* 円建てカード */}
      {yenRes && (
        <div className="rounded-lg border border-gray-200 p-3 text-sm space-y-1">
          <div className="font-medium text-gray-700">円建て（資本 {yen(yenRes.capital)}）</div>
          <div className="flex justify-between"><span className="text-gray-500">NISA運用（枠内 {yen(yenRes.quotaUsed)}{yenRes.overflow > 0 ? ` + 超過 ${yen(yenRes.overflow)} は課税BH` : ""}）</span><span className="font-medium text-emerald-700">{yen(yenRes.nisaTotalYen)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">現物 曜日戦略（全額）</span><span className="font-medium text-blue-700">{yen(yenRes.strategyFinalYen)}</span></div>
          <div className="flex justify-between border-t border-gray-100 pt-1"><span className="text-gray-500">差（戦略 − NISA運用）</span><span className={`font-bold ${cls(yenRes.strategyFinalYen - yenRes.nisaTotalYen)}`}>{yen(yenRes.strategyFinalYen - yenRes.nisaTotalYen)}</span></div>
          {yenRes.overflow > 0 && <p className="text-xs text-gray-400">NISA枠を超えた分は課税口座でのバイ&ホールド（清算時課税）として計上しています。</p>}
        </div>
      )}

      <AnalysisGuide title="NISA vs 現物（税引後）比較の詳細理論">
        <p className="font-medium text-gray-700">1. 何を比較しているか</p>
        <p>
          同じ銘柄・同じ資本を1年運用したとき、(A)年初にNISAで全枠買って売らずに持ち切る（非課税）のと、
          (B)現物口座で曜日タイミング戦略（期待値が負の区間は現金にして、良い区間だけ保有）を回すのとで、
          <span className="font-medium">税・取引コストを引いた後の最終リターン</span>がどちらが上回るかを判定します。
          比較を公平にするため、両者を「価格イベント間の区間（セグメント）×目標ポジション」という同一エンジンで評価し、
          さらに中間ベースラインとして (C)現物のバイ&ホールド（課税）も並べます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 税引後リターンの定義（清算価値）</p>
        <p>
          各営業日の終値時点で「いま全部売って税を精算したら手元にいくら残るか」を清算価値とし、これを税引後の富とします。
          税率は τ（既定 20.315% ＝ 所得税15% + 復興特別 + 住民税5%）。年内の実現損益は<span className="font-medium">損益通算</span>し、
          プラスのぶんにのみ課税、マイナスなら課税されません（翌年への繰越は無視）。
        </p>
        <p className="pl-2">{"税引後リターン = 税引前リターン − τ × max(0, 年内実現純益)"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 税の損益分岐（この分析の核心）</p>
        <p>
          NISAは非課税なので税引後リターンは税引前と同じ R。現物戦略は実現益に課税されるので、益が出る前提では税引後 = R<sub>strat</sub>·(1−τ)。
          戦略がNISAに並ぶ条件は次式で、これが「税というハンデ」の正体です。
        </p>
        <p className="pl-2">{"R_strat·(1−τ) > R  ⟺  R_strat > R / (1−τ)"}</p>
        <p>
          τ=20.315% なら R/(1−τ) ≈ R×1.255。<span className="font-medium">つまり現物戦略は、NISA持ち切りより約25.5%多く税引前で稼いで初めて同点</span>になります。
          さらに戦略は市場滞在率が1未満（週末などは現金）なので、原資産が上昇ドリフトしている限り「持たない区間の取り逃し」も背負います。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 2つの税モデル</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">源泉なし（年末一括, Model A）</span>: 年内はプレタックスで複利し、清算（＝年末）に実現純益へ一括課税。一般口座／特定口座（源泉徴収なし）に対応。複利が最も効く有利なケース。</li>
          <li><span className="font-medium">源泉あり（都度, Model B）</span>: 往復ごとに源泉徴収して再投資元本を削り、年内の負けトレードで通算還付。勝ちトレードが多いほど「税の先払い」で複利が削られ、Aよりわずかに不利になります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 週内スロットと戦略定義</p>
        <p>
          1週間を10区間に分解します：各曜日の「日中（始値→終値）」5つと「オーバーナイト（終値→翌始値）」5つ。
          右端「金→月」が週末ギャップです。各区間に 買（+1）/売（−1）/現金（0）を割り当てたものが戦略で、
          <span className="font-medium">最適プラン</span>ボタンは過去データで各区間の富を最大化する組合せ（買・売・現金を独立選択）を入れます。
          ユーザー例「金→月は持たず月曜から保有」は<span className="font-medium">週末回避</span>プリセット（金→月だけ現金）です。
        </p>

        <p className="font-medium text-gray-700 mt-3">6. 信用取引・レバレッジ探索</p>
        <p>
          NISAは信用取引ができないため、レバレッジ戦略は必ず課税口座になります。戦略シナリオにのみレバkを掛け、
          「レバレッジ探索」タブで k=1〜{MAX_LEVERAGE}（委託保証金率30%の逆数≒現実的上限）をスイープします。
          目玉は<span className="font-medium">NISA税引後（中央値）を上回る最小レバ k*</span>。ただし k* は「期待値で並ぶ点」であって「割に合う点」ではありません。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">レバ後リターン</span>: 建玉中は口座が原資産×kで動きます（equity ×= 1 + k·pos·r）。期待リターンは概ねk倍。</li>
          <li><span className="font-medium">キャリーコスト（保有日数比例）</span>: 買い建ては借入(k−1)分に<span className="font-medium">買い方金利</span>、売り建ては建玉k分に<span className="font-medium">貸株料</span>を日割りで控除。金→月の週末は3日分乗ります。これらは経費なので課税損益からも差し引かれます。</li>
          <li><span className="font-medium">追証・破産の判定</span>: 静的建玉の維持率＝純資産/建玉評価額 = (1+k·x)/(k·(1+u)) が<span className="font-medium">追証維持率</span>を割ると追証、純資産≤0（原資産が約 −1/k 逆行）で破産。確率は分布仮定を置かず、ローリング1年窓での発生頻度で推定します。</li>
          <li><span className="font-medium">リスクの比例拡大</span>: レバはリターンだけでなくボラ・最大DD・追証/破産確率も拡大します。②のリスク曲線と k* を必ず一緒に見てください。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">勝者バナー</span>: 選択期間1本での税引後の勝敗と差。</li>
          <li><span className="font-medium">ローリング分布</span>: 10年を1年窓でずらした各年の「戦略−NISA」差のヒストグラム。青が右に厚い＝戦略が勝ちやすい、赤が左に厚い＝NISAが勝ちやすい。<span className="font-medium">勝率と中央値差</span>が単年の運より頑健な結論です。</li>
          <li><span className="font-medium">損益分岐カード</span>: 戦略がNISAに並ぶのに必要な税引前リターンと、現状が届いているか。</li>
          <li><span className="font-medium">レバレッジ探索</span>: k* とその近傍の追証/破産確率。「2倍で並ぶが破産確率○%」のように、期待値とリスクを対で読みます。</li>
          <li>現物B&H（課税）とNISAの差＝<span className="font-medium">NISAの税優位</span>、現物B&Hと戦略の差＝<span className="font-medium">タイミングαの寄与</span>と読めます。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">8. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>戦略のタイミングαが「税ハードル R×τ/(1−τ)」を超えるほど強いか、ローリング勝率で確かめる。多くの場合、税と往復コストが強力な逆風になります。</li>
          <li>NISA枠には上限（成長投資枠240万/年）があるため、円建てモードで枠超過分を課税BHに回す前提での実額比較も可能です。</li>
          <li>戦略が滞在率を下げて浮かせた現金を別の非課税枠・他資産に回せるなら、比較の前提が変わります（ここでは現金=無利子と仮定）。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">9. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">配当を含まない</span>: 終値ベースのため配当が抜けています。配当もNISAは非課税なので、本来のNISA優位はここで示すより<span className="font-medium">さらに大きい</span>可能性があります。</li>
          <li><span className="font-medium">過剰適合</span>: 「最適プラン」を同じ期間で評価すると戦略が過大評価されます。ローリングでの安定性や、期間を変えた再現性を必ず確認してください。</li>
          <li><span className="font-medium">コスト・スリッページ</span>: 往復コストは片道bpsで近似。実際は板の薄さ・スプレッドでさらに削られます。</li>
          <li><span className="font-medium">信用の簡略化</span>: 逆日歩（品貸料）は変動のため未計上。追証は静的建玉近似で判定し、追証後の強制決済・建替えコストや金利の日々変動は省略。実際の信用取引はここで示すより不利になり得ます。</li>
          <li><span className="font-medium">レバはリスクを解決しない</span>: k* は期待値でNISAに並ぶ点にすぎず、ボラ・最大DD・破産確率が同時に膨らみます。リスク調整後（Sharpe）ではむしろ悪化しがちです。</li>
          <li><span className="font-medium">繰越・他口座通算の無視</span>: 年内損益通算のみ考慮し、翌年への損失繰越や他口座との通算は無視しています。</li>
          <li><span className="font-medium">現金は無利子</span>: 市場外の資金は0%と仮定。短期金利で運用できる環境ではNISA側の相対優位がわずかに縮みます。</li>
        </ul>
      </AnalysisGuide>

      <AxiomPlacement corollaryId="C23" />
      <AxiomPlacement corollaryId="C22" />
    </div>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 p-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-bold ${color ?? "text-gray-800"}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400">{sub}</div>}
    </div>
  );
}

// lightweight-charts は同一時刻の重複・逆順を嫌うため、時刻昇順で重複を除去。
function dedupe(rows: { time: Time; value: number }[]): { time: Time; value: number }[] {
  const out: { time: Time; value: number }[] = [];
  let prev: number | null = null;
  for (const r of rows) {
    const t = r.time as unknown as number;
    if (prev !== null && t <= prev) continue;
    out.push(r);
    prev = t;
  }
  return out;
}
