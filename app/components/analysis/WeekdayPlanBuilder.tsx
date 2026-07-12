"use client";

// 曜日トレード・ワークベンチ ②プラン化ステージ。
// 共有の週内スロット・プラン(sides)を編集し、computePlan で累積エクイティ(戦略 vs バイ&ホールド)と
// 主要指標を即座に見せる。ここで作ったプランがそのまま ③評価(対B&H・対NISA)へ流れる。
// 螺旋ヒートマップ内に埋没していた曜日トレードシミュレータの「正規版・独立版」に相当する。

import { useEffect, useMemo, useRef } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computePlan,
  bestCombination,
  legsFromSlotSides,
  type PlanGapFill,
  type PlanResult,
} from "../../lib/weekday-trade";
import WeekSlotGrid, { type SlotSide } from "./WeekSlotGrid";

interface Props {
  prices: PricePoint[];
  sides: SlotSide[];
  onChange: (sides: SlotSide[]) => void;
  gapFill: PlanGapFill;
  onGapFill: (g: PlanGapFill) => void;
  costBps: number;
  onCostBps: (v: number) => void;
}

const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const num2 = (v: number) => v.toFixed(2);
const cls = (v: number) => (v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500");
const toRows = (pts: { t: number; v: number }[]): { time: Time; value: number }[] => {
  const out: { time: Time; value: number }[] = [];
  let prev = -Infinity;
  for (const p of pts) {
    const t = Math.floor(p.t / 86400000) * 86400;
    if (t <= prev) continue;
    out.push({ time: t as unknown as Time, value: p.v });
    prev = t;
  }
  return out;
};

export default function WeekdayPlanBuilder({ prices, sides, onChange, gapFill, onGapFill, costBps, onCostBps }: Props) {
  const best = useMemo(() => (prices.length > 60 ? bestCombination(prices, true) : null), [prices]);
  const legs = useMemo(() => legsFromSlotSides(sides), [sides]);

  const plan = useMemo<PlanResult | null>(() => (prices.length > 30 ? computePlan(prices, legs, gapFill, costBps, true) : null), [prices, legs, gapFill, costBps]);
  const bh = useMemo<PlanResult | null>(() => (prices.length > 30 ? computePlan(prices, [], "hold", 0, true) : null), [prices]);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const hasData = plan !== null;

  useEffect(() => {
    if (!hasData || !containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 240,
      crosshair: { mode: 0 },
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(0)}%` },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    chartRef.current = chart;
    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }); };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); chartRef.current = null; seriesRef.current = []; };
  }, [hasData]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !plan) return;
    for (const s of seriesRef.current) chart.removeSeries(s);
    seriesRef.current = [];
    if (bh) {
      const bhS = chart.addSeries(LineSeries, { color: "#9ca3af", lineWidth: 1, title: "B&H", priceLineVisible: false });
      bhS.setData(toRows(bh.equity));
      seriesRef.current.push(bhS);
    }
    const stS = chart.addSeries(LineSeries, { color: "#2563eb", lineWidth: 2, title: "プラン", priceLineVisible: false });
    stS.setData(toRows(plan.equity));
    seriesRef.current.push(stS);
    if (containerRef.current && containerRef.current.clientWidth > 0) chart.applyOptions({ width: containerRef.current.clientWidth });
    chart.timeScale().fitContent();
  }, [plan, bh]);

  return (
    <div className="space-y-3">
      <WeekSlotGrid
        sides={sides}
        onChange={onChange}
        best={best}
        title="② プラン構築：週内どの区間を持つか"
        hint={<>クリックで 無→買→売。<span className="font-medium">最適プラン</span>=過去データで各区間の富を最大化する組合せ。このプランが下の評価（対B&H・対NISA）へそのまま流れます。</>}
      />

      {/* プラン設定 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <div className="flex items-center gap-1">
          <span className="text-gray-500">隙間:</span>
          {([["cash", "現金"], ["hold", "常時ロング上書き"]] as [PlanGapFill, string][]).map(([g, label]) => (
            <button key={g} onClick={() => onGapFill(g)} className={`px-2 py-0.5 rounded border ${gapFill === g ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-gray-600 border-gray-300"}`}>{label}</button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-gray-500">
          片道コスト
          <input type="number" min={0} max={50} step={1} value={costBps} onChange={(e) => onCostBps(Math.max(0, Number(e.target.value) || 0))} className="w-14 border border-gray-200 rounded px-1 py-0.5 bg-white text-right" />bps
        </label>
      </div>

      {/* エクイティ */}
      <div>
        <div className="text-xs text-gray-500 mb-1">累積リターン（青=プラン / 灰=B&H, ホイールでズーム）</div>
        <div ref={containerRef} className="w-full" />
      </div>

      {/* 指標 */}
      {plan && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2 text-sm">
          <Metric label="総リターン" value={pct(plan.totalReturn)} color={cls(plan.totalReturn)} />
          <Metric label="年率" value={pct(plan.annualized)} color={cls(plan.annualized)} />
          <Metric label="Sharpe" value={num2(plan.sharpe)} color={cls(plan.sharpe)} />
          <Metric label="最大DD" value={pct(plan.maxDD)} color={cls(plan.maxDD)} />
          <Metric label="市場滞在率" value={`${(plan.exposure * 100).toFixed(0)}%`} />
          <Metric label="コスト" value={`−${(plan.totalCost * 100).toFixed(2)}%`} color="text-gray-500" />
        </div>
      )}
      {plan && bh && (
        <p className="text-xs text-gray-400">
          プラン年率 {pct(plan.annualized)} vs B&H年率 {pct(bh.annualized)}（差 <span className={cls(plan.annualized - bh.annualized)}>{pct(plan.annualized - bh.annualized)}</span>）。
          滞在率が低いプランは総リターンよりSharpeで比較するのが公平です。厳密な優位性検定と税引後は下の③で。
        </p>
      )}
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 p-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-base font-bold ${color ?? "text-gray-800"}`}>{value}</div>
    </div>
  );
}
