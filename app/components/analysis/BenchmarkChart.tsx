"use client";

import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  alignSeries,
  computeBenchmarkSeries,
  computeBenchmarkStats,
  rollingBeta,
  generateComparisonSummary,
  type BenchmarkStats,
  type RollingBetaPoint,
  type BenchmarkPoint,
} from "../../lib/benchmark";
import { setInitialVisibleRange } from "../../lib/chart-visible-range";
import type { PeriodKey } from "../../hooks/useAnalysisData";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

const MAX_COMPARE = 10;

const PALETTE = [
  "#9ca3af", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444",
  "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#6366f1",
];

interface CompareEntry {
  ticker: string;
  label: string;
  color: string;
  prices: PricePoint[] | null;
  loading: boolean;
  error: string | null;
}

interface ComputedEntry {
  entry: CompareEntry;
  series: BenchmarkPoint[];
  stats: BenchmarkStats;
  rolling: RollingBetaPoint[];
}

export default function BenchmarkChart({ prices, period }: Props) {
  const perfChartRef = useRef<HTMLDivElement>(null);
  const betaChartRef = useRef<HTMLDivElement>(null);
  const perfApiRef = useRef<IChartApi | null>(null);
  const betaApiRef = useRef<IChartApi | null>(null);

  const [entries, setEntries] = useState<CompareEntry[]>([
    { ticker: "^N225", label: "日経225", color: PALETTE[0], prices: null, loading: false, error: null },
  ]);
  const [inputTicker, setInputTicker] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Date range for comparison period
  const [rangeFrom, setRangeFrom] = useState<string>("");
  const [rangeTo, setRangeTo] = useState<string>("");

  const fetchPrices = useCallback(async (ticker: string): Promise<{ prices: PricePoint[]; name: string } | null> => {
    const res = await fetch(`/api/stock?ticker=${encodeURIComponent(ticker)}&range=10y`);
    const json = await res.json();
    if (!res.ok) return null;
    return { prices: json.prices, name: json.name || ticker };
  }, []);

  // Fetch initial default entry
  useEffect(() => {
    const init = async () => {
      setEntries((prev) =>
        prev.map((e) => (e.ticker === "^N225" ? { ...e, loading: true } : e))
      );
      const result = await fetchPrices("^N225");
      setEntries((prev) =>
        prev.map((e) =>
          e.ticker === "^N225"
            ? {
                ...e,
                prices: result?.prices ?? null,
                loading: false,
                error: result ? null : "取得失敗",
              }
            : e
        )
      );
    };
    init();
  }, [fetchPrices]);

  const handleAdd = useCallback(async () => {
    const raw = inputTicker.trim();
    if (!raw) return;
    if (entries.length >= MAX_COMPARE) {
      setAddError(`最大${MAX_COMPARE}銘柄まで`);
      return;
    }

    // Normalize: 4-digit numbers and special tickers
    const normalizedTicker = /^\d{4}$/.test(raw) ? raw : raw.toUpperCase();
    if (entries.some((e) => e.ticker === normalizedTicker || e.ticker === raw)) {
      setAddError("既に追加済み");
      return;
    }

    setAddLoading(true);
    setAddError(null);
    try {
      const result = await fetchPrices(raw);
      if (!result) {
        setAddError("銘柄データを取得できません");
        return;
      }
      const colorIndex = entries.length % PALETTE.length;
      const label =
        result.name && result.name !== raw
          ? `${raw} ${result.name}`
          : raw;
      setEntries((prev) => [
        ...prev,
        {
          ticker: normalizedTicker,
          label,
          color: PALETTE[colorIndex],
          prices: result.prices,
          loading: false,
          error: null,
        },
      ]);
      setInputTicker("");
    } catch {
      setAddError("ネットワークエラー");
    } finally {
      setAddLoading(false);
    }
  }, [inputTicker, entries, fetchPrices]);

  const handleRemove = useCallback((ticker: string) => {
    setEntries((prev) => prev.filter((e) => e.ticker !== ticker));
  }, []);

  // Filter prices by selected date range
  const rangedPrices = useMemo(() => {
    let filtered = prices;
    if (rangeFrom) filtered = filtered.filter((p) => p.time >= rangeFrom);
    if (rangeTo) filtered = filtered.filter((p) => p.time <= rangeTo);
    return filtered;
  }, [prices, rangeFrom, rangeTo]);

  const filterByRange = useCallback(
    (pts: PricePoint[]) => {
      let filtered = pts;
      if (rangeFrom) filtered = filtered.filter((p) => p.time >= rangeFrom);
      if (rangeTo) filtered = filtered.filter((p) => p.time <= rangeTo);
      return filtered;
    },
    [rangeFrom, rangeTo]
  );

  // Date range boundaries for the date inputs
  const dateMin = useMemo(() => (prices.length > 0 ? prices[0].time : ""), [prices]);
  const dateMax = useMemo(() => (prices.length > 0 ? prices[prices.length - 1].time : ""), [prices]);

  // Compute aligned data for all loaded entries
  const computed = useMemo((): ComputedEntry[] => {
    return entries
      .filter((e) => e.prices && e.prices.length > 0)
      .map((entry) => {
        const aligned = alignSeries(rangedPrices, filterByRange(entry.prices!));
        return {
          entry,
          series: computeBenchmarkSeries(aligned.stock, aligned.bench),
          stats: computeBenchmarkStats(aligned.stock, aligned.bench),
          rolling: rollingBeta(aligned.stock, aligned.bench, 60),
        };
      });
  }, [rangedPrices, entries, filterByRange]);

  // Performance chart
  useEffect(() => {
    if (!perfChartRef.current || computed.length === 0) return;
    if (perfApiRef.current) perfApiRef.current.remove();

    const chart = createChart(perfChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: perfChartRef.current.clientWidth,
      height: 240,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    perfApiRef.current = chart;

    // Stock line (always blue, thick)
    if (computed.length > 0 && computed[0].series.length > 0) {
      const stockLine = chart.addSeries(LineSeries, {
        color: "#3b82f6",
        lineWidth: 2,
      });
      stockLine.setData(
        computed[0].series.map((s) => ({ time: s.time as Time, value: s.stockNorm }))
      );
    }

    // Each compare entry
    for (const c of computed) {
      const line = chart.addSeries(LineSeries, {
        color: c.entry.color,
        lineWidth: 1,
      });
      line.setData(
        c.series.map((s) => ({ time: s.time as Time, value: s.benchNorm }))
      );
    }

    const hasCustomRange = rangeFrom || rangeTo;
    if (!hasCustomRange && period) {
      setInitialVisibleRange(chart, rangedPrices, period);
    } else {
      chart.timeScale().fitContent();
    }
    const handleResize = () => {
      if (perfChartRef.current)
        chart.applyOptions({ width: perfChartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      perfApiRef.current = null;
    };
  }, [computed, period, rangedPrices, rangeFrom, rangeTo]);

  // Rolling beta/correlation chart
  useEffect(() => {
    if (!betaChartRef.current || computed.length === 0) return;
    if (betaApiRef.current) betaApiRef.current.remove();

    const hasRolling = computed.some((c) => c.rolling.length > 1);
    if (!hasRolling) return;

    const chart = createChart(betaChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: betaChartRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    betaApiRef.current = chart;

    for (const c of computed) {
      if (c.rolling.length < 2) continue;
      const betaLine = chart.addSeries(LineSeries, {
        color: c.entry.color,
        lineWidth: 2,
      });
      betaLine.setData(
        c.rolling.map((r) => ({ time: r.time as Time, value: r.beta }))
      );
    }

    // Beta=1 reference
    const anyRolling = computed.find((c) => c.rolling.length > 1);
    if (anyRolling) {
      const refLine = chart.addSeries(LineSeries, {
        color: "rgba(107, 114, 128, 0.3)",
        lineWidth: 1,
        lineStyle: 2,
      });
      refLine.setData(
        anyRolling.rolling.map((r) => ({ time: r.time as Time, value: 1 }))
      );
    }

    const hasCustomRange = rangeFrom || rangeTo;
    if (!hasCustomRange && period) {
      setInitialVisibleRange(chart, rangedPrices, period);
    } else {
      chart.timeScale().fitContent();
    }
    const handleResize = () => {
      if (betaChartRef.current)
        chart.applyOptions({ width: betaChartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      betaApiRef.current = null;
    };
  }, [computed, period, rangedPrices, rangeFrom, rangeTo]);

  const pct = (v: number) => (v * 100).toFixed(2);
  const fmt = (v: number) => v.toFixed(3);

  const anyLoading = entries.some((e) => e.loading);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">ベンチマーク比較</h3>

      {/* Tags */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {entries.map((e) => (
          <span
            key={e.ticker}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border"
            style={{
              borderColor: e.color,
              color: e.color,
              backgroundColor: e.color + "10",
            }}
          >
            <span
              className="w-2 h-2 rounded-full inline-block"
              style={{ backgroundColor: e.color }}
            />
            {e.label}
            {e.loading && <span className="text-gray-400 ml-1">...</span>}
            {e.error && <span className="text-red-400 ml-1">!</span>}
            <button
              onClick={() => handleRemove(e.ticker)}
              className="ml-0.5 hover:text-red-500 transition-colors"
              title="削除"
            >
              x
            </button>
          </span>
        ))}

        {/* Add input */}
        {entries.length < MAX_COMPARE && (
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              handleAdd();
            }}
            className="inline-flex items-center gap-1"
          >
            <input
              type="text"
              value={inputTicker}
              onChange={(ev) => {
                setInputTicker(ev.target.value);
                setAddError(null);
              }}
              placeholder="銘柄コード"
              className="w-24 px-1.5 py-0.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-400"
              disabled={addLoading}
            />
            <button
              type="submit"
              disabled={addLoading || !inputTicker.trim()}
              className="px-2 py-0.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              {addLoading ? "..." : "+ 追加"}
            </button>
          </form>
        )}
      </div>
      {addError && (
        <div className="text-xs text-red-500 mb-2">{addError}</div>
      )}

      {/* Date range selector */}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
        <span className="text-gray-500 font-medium">比較期間:</span>
        <input
          type="date"
          value={rangeFrom}
          min={dateMin}
          max={rangeTo || dateMax}
          onChange={(e) => setRangeFrom(e.target.value)}
          className="px-1.5 py-0.5 border border-gray-300 rounded text-xs focus:outline-none focus:border-blue-400"
        />
        <span className="text-gray-400">〜</span>
        <input
          type="date"
          value={rangeTo}
          min={rangeFrom || dateMin}
          max={dateMax}
          onChange={(e) => setRangeTo(e.target.value)}
          className="px-1.5 py-0.5 border border-gray-300 rounded text-xs focus:outline-none focus:border-blue-400"
        />
        {(rangeFrom || rangeTo) && (
          <button
            onClick={() => { setRangeFrom(""); setRangeTo(""); }}
            className="px-1.5 py-0.5 text-xs rounded border border-gray-300 text-gray-500 hover:bg-gray-100 transition-colors"
          >
            全期間に戻す
          </button>
        )}
        {rangeFrom && rangeTo && (
          <span className="text-gray-400">
            ({rangedPrices.length}営業日)
          </span>
        )}
      </div>

      {anyLoading && (
        <div className="text-sm text-gray-400 py-6 text-center">
          データ取得中...
        </div>
      )}

      {computed.length > 0 && !anyLoading && (
        <>
          {/* Stats comparison table */}
          <div className="overflow-x-auto mb-3">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-1.5 px-2 text-gray-500 font-medium">比較先</th>
                  <th className="text-right py-1.5 px-2 text-gray-500 font-medium">Beta</th>
                  <th className="text-right py-1.5 px-2 text-gray-500 font-medium">Alpha(年率)</th>
                  <th className="text-right py-1.5 px-2 text-gray-500 font-medium">相関</th>
                  <th className="text-right py-1.5 px-2 text-gray-500 font-medium">IR</th>
                  <th className="text-right py-1.5 px-2 text-gray-500 font-medium">TE</th>
                  <th className="text-right py-1.5 px-2 text-gray-500 font-medium">銘柄</th>
                  <th className="text-right py-1.5 px-2 text-gray-500 font-medium">比較先</th>
                  <th className="text-right py-1.5 px-2 text-gray-500 font-medium">超過</th>
                </tr>
              </thead>
              <tbody>
                {computed.map((c) => (
                  <tr key={c.entry.ticker} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-1.5 px-2 font-medium" style={{ color: c.entry.color }}>
                      <span
                        className="inline-block w-2 h-2 rounded-full mr-1"
                        style={{ backgroundColor: c.entry.color }}
                      />
                      {c.entry.label}
                    </td>
                    <td className={`text-right py-1.5 px-2 font-mono ${c.stats.beta > 1.2 ? "text-red-600" : c.stats.beta < 0.8 ? "text-blue-600" : ""}`}>
                      {fmt(c.stats.beta)}
                    </td>
                    <td className={`text-right py-1.5 px-2 font-mono ${c.stats.alpha >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {pct(c.stats.alpha)}%
                    </td>
                    <td className="text-right py-1.5 px-2 font-mono">
                      {fmt(c.stats.correlation)}
                    </td>
                    <td className={`text-right py-1.5 px-2 font-mono ${c.stats.informationRatio >= 0.5 ? "text-green-600" : c.stats.informationRatio <= -0.5 ? "text-red-600" : ""}`}>
                      {fmt(c.stats.informationRatio)}
                    </td>
                    <td className="text-right py-1.5 px-2 font-mono text-gray-500">
                      {pct(c.stats.trackingError)}%
                    </td>
                    <td className={`text-right py-1.5 px-2 font-mono ${c.stats.stockReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {pct(c.stats.stockReturn)}%
                    </td>
                    <td className={`text-right py-1.5 px-2 font-mono ${c.stats.benchReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {pct(c.stats.benchReturn)}%
                    </td>
                    <td className={`text-right py-1.5 px-2 font-mono ${c.stats.excessReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {pct(c.stats.excessReturn)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Performance chart */}
          <div className="mb-2 text-xs text-gray-500 font-medium">
            相対パフォーマンス (基準日=100){rangeFrom && <span className="ml-1 text-blue-500">({rangeFrom}〜{rangeTo || dateMax})</span>}
            <span className="ml-2 text-blue-500">-- 分析銘柄</span>
            {computed.map((c) => (
              <span key={c.entry.ticker} className="ml-2" style={{ color: c.entry.color }}>
                -- {c.entry.label}
              </span>
            ))}
          </div>
          <div ref={perfChartRef} className="w-full rounded border border-gray-100 mb-4" />

          {/* Rolling beta chart */}
          <div className="mb-2 text-xs text-gray-500 font-medium">
            ローリングBeta (60日)
            {computed.map((c) => (
              <span key={c.entry.ticker} className="ml-2" style={{ color: c.entry.color }}>
                -- {c.entry.label}
              </span>
            ))}
          </div>
          <div ref={betaChartRef} className="w-full rounded border border-gray-100 mb-4" />

          {/* Auto summaries */}
          <div className="space-y-1.5 mb-3">
            {computed.map((c) => (
              <div
                key={c.entry.ticker}
                className="text-xs p-2 rounded border-l-2"
                style={{ borderColor: c.entry.color, backgroundColor: c.entry.color + "08" }}
              >
                <span className="font-medium" style={{ color: c.entry.color }}>
                  vs {c.entry.label}:
                </span>{" "}
                <span className="text-gray-700">
                  {generateComparisonSummary(c.entry.label, c.stats)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {computed.length === 0 && !anyLoading && entries.length > 0 && entries.every(e => !e.loading && !e.prices) && (
        <div className="text-sm text-gray-400 py-6 text-center">
          比較データがありません
        </div>
      )}

      <AnalysisGuide title="ベンチマーク比較の読み方">
        <p><span className="font-medium">Beta:</span> 比較先に対する感応度。1なら同じ動き、{">"}1なら比較先以上に変動（攻撃的）、{"<"}1なら比較先より安定（防御的）。</p>
        <p><span className="font-medium">Alpha (年率):</span> 比較先対比の超過リターン。正のAlphaは比較先を上回るパフォーマンス。</p>
        <p><span className="font-medium">TE (トラッキングエラー):</span> 超過リターンの標準偏差（年率）。比較先からの乖離度合い。</p>
        <p><span className="font-medium">IR (情報レシオ):</span> Alpha / TE。リスク調整済み超過リターン。0.5以上で良好。</p>
        <p><span className="font-medium">複数銘柄の比較:</span> 日経225以外にも任意の銘柄コードを追加して、分析対象との関係性を比較できます。相関が低い銘柄同士は分散投資効果が期待できます。</p>
      </AnalysisGuide>
    </div>
  );
}
