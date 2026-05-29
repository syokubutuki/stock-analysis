"use client";

import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";

interface Props {
  prices: PricePoint[];
}

// エントリー/エグジットの価格ポイント定義
type PriceSelector =
  | "prevClose"  // 前日終値
  | "open"       // 当日始値
  | "high"       // 当日高値
  | "low"        // 当日安値
  | "close";     // 当日終値

const ENTRY_OPTIONS: { value: PriceSelector; label: string }[] = [
  { value: "prevClose", label: "前日終値" },
  { value: "open", label: "当日始値" },
  { value: "high", label: "当日高値" },
  { value: "low", label: "当日安値" },
  { value: "close", label: "当日終値" },
];

const EXIT_OPTIONS: { value: PriceSelector; label: string }[] = [
  { value: "prevClose", label: "前日終値" },
  { value: "open", label: "当日始値" },
  { value: "high", label: "当日高値" },
  { value: "low", label: "当日安値" },
  { value: "close", label: "当日終値" },
];

// プリセット戦略
const PRESETS: { label: string; entry: PriceSelector; exit: PriceSelector }[] = [
  { label: "夜間リターン (前日終値→当日始値)", entry: "prevClose", exit: "open" },
  { label: "日中リターン (当日始値→当日終値)", entry: "open", exit: "close" },
  { label: "日次リターン (前日終値→当日終値)", entry: "prevClose", exit: "close" },
  { label: "逆日中 (当日終値→当日始値 = 日中ショート)", entry: "close", exit: "open" },
  { label: "逆夜間 (当日始値→前日終値 = 夜間ショート)", entry: "open", exit: "prevClose" },
  { label: "高値買い→終値売り", entry: "high", exit: "close" },
  { label: "安値買い→終値売り", entry: "low", exit: "close" },
  { label: "始値買い→高値売り (理想)", entry: "open", exit: "high" },
  { label: "安値買い→高値売り (理想)", entry: "low", exit: "high" },
];

function getPrice(
  prices: PricePoint[],
  index: number,
  selector: PriceSelector
): number | null {
  if (selector === "prevClose") {
    if (index <= 0) return null;
    return prices[index - 1].close;
  }
  const p = prices[index];
  switch (selector) {
    case "open": return p.open;
    case "high": return p.high;
    case "low": return p.low;
    case "close": return p.close;
  }
}

interface ReturnPoint {
  time: string;
  dailyReturn: number;
  cumReturn: number;
}

function computeCustomReturns(
  prices: PricePoint[],
  entry: PriceSelector,
  exit: PriceSelector,
  startDate: string,
  endDate: string
): ReturnPoint[] {
  const result: ReturnPoint[] = [];
  let cumReturn = 0;

  for (let i = 0; i < prices.length; i++) {
    const t = prices[i].time;
    if (t < startDate || t > endDate) continue;

    const entryPrice = getPrice(prices, i, entry);
    const exitPrice = getPrice(prices, i, exit);
    if (entryPrice == null || exitPrice == null || entryPrice <= 0 || exitPrice <= 0) continue;

    const dailyReturn = Math.log(exitPrice / entryPrice);
    cumReturn += dailyReturn;
    result.push({ time: t, dailyReturn, cumReturn });
  }
  return result;
}

function pctFmt(v: number, d = 2): string {
  return (v * 100).toFixed(d) + "%";
}

export default function CustomReturnChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);

  const [entry, setEntry] = useState<PriceSelector>("prevClose");
  const [exit, setExit] = useState<PriceSelector>("open");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  // 初期日付の設定
  useEffect(() => {
    if (prices.length > 0 && !startDate) {
      setStartDate(prices[0].time);
      setEndDate(prices[prices.length - 1].time);
    }
  }, [prices, startDate]);

  const effectiveStart = startDate || (prices.length > 0 ? prices[0].time : "");
  const effectiveEnd = endDate || (prices.length > 0 ? prices[prices.length - 1].time : "");

  const returns = useMemo(
    () => computeCustomReturns(prices, entry, exit, effectiveStart, effectiveEnd),
    [prices, entry, exit, effectiveStart, effectiveEnd]
  );

  // 統計
  const stats = useMemo(() => {
    if (returns.length === 0) return null;
    const daily = returns.map((r) => r.dailyReturn);
    const n = daily.length;
    const sum = daily.reduce((a, b) => a + b, 0);
    const avg = sum / n;
    const variance = daily.reduce((a, v) => a + (v - avg) ** 2, 0) / n;
    const stdev = Math.sqrt(variance);
    const winCount = daily.filter((d) => d > 0).length;
    const lossCount = daily.filter((d) => d < 0).length;
    const avgWin = winCount > 0 ? daily.filter((d) => d > 0).reduce((a, b) => a + b, 0) / winCount : 0;
    const avgLoss = lossCount > 0 ? daily.filter((d) => d < 0).reduce((a, b) => a + b, 0) / lossCount : 0;

    // 最大ドローダウン
    let peak = -Infinity;
    let maxDD = 0;
    for (const r of returns) {
      if (r.cumReturn > peak) peak = r.cumReturn;
      const dd = peak - r.cumReturn;
      if (dd > maxDD) maxDD = dd;
    }

    // 年率換算 (252営業日)
    const totalReturn = returns[returns.length - 1].cumReturn;
    const years = n / 252;
    const annualReturn = years > 0 ? totalReturn / years : 0;
    const annualVol = stdev * Math.sqrt(252);
    const sharpe = annualVol > 0 ? annualReturn / annualVol : 0;

    return {
      n,
      totalReturn,
      annualReturn,
      annualVol,
      sharpe,
      avg,
      stdev,
      winRate: winCount / n,
      avgWin,
      avgLoss,
      maxDD,
      profitFactor: avgLoss !== 0 ? Math.abs((avgWin * winCount) / (avgLoss * lossCount)) : Infinity,
    };
  }, [returns]);

  // チャート描画
  useEffect(() => {
    if (!chartRef.current || returns.length < 2) return;
    if (chartApiRef.current) chartApiRef.current.remove();

    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 300,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartApiRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#2563eb",
      lineWidth: 2,
      priceFormat: { type: "custom", formatter: (v: number) => (v).toFixed(2) + "%" },
    });
    series.setData(
      returns.map((r) => ({ time: r.time as Time, value: r.cumReturn * 100 }))
    );

    // ゼロライン
    const zeroSeries = chart.addSeries(LineSeries, {
      color: "#d1d5db",
      lineWidth: 1,
      lineStyle: 2,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    zeroSeries.setData(
      returns.map((r) => ({ time: r.time as Time, value: 0 }))
    );

    chart.timeScale().fitContent();
    const h = () => {
      if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth });
    };
    window.addEventListener("resize", h);
    return () => {
      window.removeEventListener("resize", h);
      chart.remove();
      chartApiRef.current = null;
    };
  }, [returns]);

  const applyPreset = useCallback((preset: typeof PRESETS[number]) => {
    setEntry(preset.entry);
    setExit(preset.exit);
  }, []);

  const entryLabel = ENTRY_OPTIONS.find((o) => o.value === entry)?.label ?? entry;
  const exitLabel = EXIT_OPTIONS.find((o) => o.value === exit)?.label ?? exit;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">カスタム売買タイミング累積リターン</h3>

      {/* プリセット */}
      <div>
        <div className="text-xs text-gray-500 mb-1.5">プリセット戦略</div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => applyPreset(p)}
              className={`px-2 py-1 text-xs rounded border transition-colors ${
                entry === p.entry && exit === p.exit
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* カスタム設定 */}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">エントリー (買い)</label>
          <select
            value={entry}
            onChange={(e) => setEntry(e.target.value as PriceSelector)}
            className="px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {ENTRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="text-gray-400 text-lg pb-1">→</div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">エグジット (売り)</label>
          <select
            value={exit}
            onChange={(e) => setExit(e.target.value as PriceSelector)}
            className="px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {EXIT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">開始日</label>
          <input
            type="date"
            value={effectiveStart}
            onChange={(e) => setStartDate(e.target.value)}
            className="px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">終了日</label>
          <input
            type="date"
            value={effectiveEnd}
            onChange={(e) => setEndDate(e.target.value)}
            className="px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* 戦略説明 */}
      <div className="text-xs text-gray-500">
        毎日「{entryLabel}」で買い →「{exitLabel}」で売りを繰り返した場合の累積対数リターン (%)
      </div>

      {/* チャート */}
      {returns.length >= 2 ? (
        <div ref={chartRef} className="w-full rounded border border-gray-100" />
      ) : (
        <div className="text-sm text-gray-400 py-8 text-center">データが不足しています</div>
      )}

      {/* 統計 */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 text-xs">
          <StatCell label="累積リターン" value={pctFmt(stats.totalReturn)} positive={stats.totalReturn > 0} />
          <StatCell label="年率リターン" value={pctFmt(stats.annualReturn)} positive={stats.annualReturn > 0} />
          <StatCell label="年率ボラティリティ" value={pctFmt(stats.annualVol)} />
          <StatCell label="シャープレシオ" value={stats.sharpe.toFixed(3)} positive={stats.sharpe > 0} />
          <StatCell label="勝率" value={pctFmt(stats.winRate)} />
          <StatCell label="取引日数" value={`${stats.n}日`} />
          <StatCell label="平均日次リターン" value={pctFmt(stats.avg, 4)} positive={stats.avg > 0} />
          <StatCell label="日次標準偏差" value={pctFmt(stats.stdev, 4)} />
          <StatCell label="平均利益" value={pctFmt(stats.avgWin, 4)} />
          <StatCell label="平均損失" value={pctFmt(stats.avgLoss, 4)} />
          <StatCell label="最大ドローダウン" value={pctFmt(stats.maxDD)} negative />
          <StatCell label="プロフィットファクター" value={stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)} positive={stats.profitFactor > 1} />
        </div>
      )}
    </div>
  );
}

function StatCell({ label, value, positive, negative }: { label: string; value: string; positive?: boolean; negative?: boolean }) {
  const color = positive ? "text-green-600" : negative ? "text-red-600" : "";
  return (
    <div className="p-2 bg-gray-50 rounded">
      <div className="text-gray-500">{label}</div>
      <div className={`font-mono font-medium ${color}`}>{value}</div>
    </div>
  );
}
