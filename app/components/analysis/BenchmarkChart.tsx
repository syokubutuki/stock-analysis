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
} from "../../lib/benchmark";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

type BenchmarkKey = "nikkei" | "topix";

const BENCHMARKS: Record<BenchmarkKey, { ticker: string; label: string }> = {
  nikkei: { ticker: "^N225", label: "日経225" },
  topix: { ticker: "^TPX", label: "TOPIX" },
};

export default function BenchmarkChart({ prices }: Props) {
  const perfChartRef = useRef<HTMLDivElement>(null);
  const betaChartRef = useRef<HTMLDivElement>(null);
  const perfApiRef = useRef<IChartApi | null>(null);
  const betaApiRef = useRef<IChartApi | null>(null);

  const [benchKey, setBenchKey] = useState<BenchmarkKey>("nikkei");
  const [benchPrices, setBenchPrices] = useState<PricePoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBenchmark = useCallback(async (key: BenchmarkKey) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/stock?ticker=${encodeURIComponent(BENCHMARKS[key].ticker)}&range=3y`
      );
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "ベンチマーク取得失敗");
        setBenchPrices(null);
        return;
      }
      setBenchPrices(json.prices);
    } catch {
      setError("ネットワークエラー");
      setBenchPrices(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBenchmark(benchKey);
  }, [benchKey, fetchBenchmark]);

  const aligned = useMemo(() => {
    if (!benchPrices) return null;
    return alignSeries(prices, benchPrices);
  }, [prices, benchPrices]);

  const series = useMemo(() => {
    if (!aligned) return [];
    return computeBenchmarkSeries(aligned.stock, aligned.bench);
  }, [aligned]);

  const stats = useMemo(() => {
    if (!aligned) return null;
    return computeBenchmarkStats(aligned.stock, aligned.bench);
  }, [aligned]);

  const rolling = useMemo(() => {
    if (!aligned) return [];
    return rollingBeta(aligned.stock, aligned.bench, 60);
  }, [aligned]);

  // Performance chart
  useEffect(() => {
    if (!perfChartRef.current || series.length < 2) return;
    if (perfApiRef.current) perfApiRef.current.remove();

    const chart = createChart(perfChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: perfChartRef.current.clientWidth,
      height: 220,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    perfApiRef.current = chart;

    const stockLine = chart.addSeries(LineSeries, {
      color: "#3b82f6", lineWidth: 2, title: "銘柄",
    });
    stockLine.setData(
      series.map((s) => ({ time: s.time as Time, value: s.stockNorm }))
    );

    const benchLine = chart.addSeries(LineSeries, {
      color: "#9ca3af", lineWidth: 1, title: BENCHMARKS[benchKey].label,
    });
    benchLine.setData(
      series.map((s) => ({ time: s.time as Time, value: s.benchNorm }))
    );

    chart.timeScale().fitContent();
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
  }, [series, benchKey]);

  // Rolling beta/correlation chart
  useEffect(() => {
    if (!betaChartRef.current || rolling.length < 2) return;
    if (betaApiRef.current) betaApiRef.current.remove();

    const chart = createChart(betaChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: betaChartRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    betaApiRef.current = chart;

    const betaLine = chart.addSeries(LineSeries, {
      color: "#8b5cf6", lineWidth: 2, title: "β (60日)",
    });
    betaLine.setData(
      rolling.map((r) => ({ time: r.time as Time, value: r.beta }))
    );

    const corrLine = chart.addSeries(LineSeries, {
      color: "#f59e0b", lineWidth: 1, title: "相関 (60日)",
    });
    corrLine.setData(
      rolling.map((r) => ({ time: r.time as Time, value: r.correlation }))
    );

    // β=1 reference line
    const refLine = chart.addSeries(LineSeries, {
      color: "rgba(107, 114, 128, 0.3)", lineWidth: 1, lineStyle: 2, title: "",
    });
    refLine.setData(
      rolling.map((r) => ({ time: r.time as Time, value: 1 }))
    );

    chart.timeScale().fitContent();
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
  }, [rolling]);

  const pct = (v: number) => (v * 100).toFixed(2);
  const fmt = (v: number) => v.toFixed(3);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">ベンチマーク比較</h3>
        <div className="flex gap-1">
          {(Object.keys(BENCHMARKS) as BenchmarkKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setBenchKey(key)}
              className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                benchKey === key
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {BENCHMARKS[key].label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="text-sm text-gray-400 py-8 text-center">
          ベンチマークデータ取得中...
        </div>
      )}
      {error && (
        <div className="text-sm text-red-500 py-4 text-center">{error}</div>
      )}

      {stats && !loading && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">β (ベータ)</div>
              <div className={`font-mono font-medium ${stats.beta > 1.2 ? "text-red-600" : stats.beta < 0.8 ? "text-blue-600" : ""}`}>
                {fmt(stats.beta)}
              </div>
              <div className="text-gray-400">
                {stats.beta > 1.2 ? "高ベータ(攻撃的)" : stats.beta < 0.8 ? "低ベータ(防御的)" : "中程度"}
              </div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">α (年率)</div>
              <div className={`font-mono font-medium ${stats.alpha >= 0 ? "text-green-600" : "text-red-600"}`}>
                {pct(stats.alpha)}%
              </div>
              <div className="text-gray-400">ベンチマーク対比の超過収益</div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">相関係数</div>
              <div className="font-mono font-medium">{fmt(stats.correlation)}</div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">情報レシオ</div>
              <div className={`font-mono font-medium ${stats.informationRatio >= 0.5 ? "text-green-600" : ""}`}>
                {fmt(stats.informationRatio)}
              </div>
              <div className="text-gray-400">TE: {pct(stats.trackingError)}%</div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 text-xs mb-3">
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">銘柄リターン</div>
              <div className={`font-mono font-medium ${stats.stockReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                {pct(stats.stockReturn)}%
              </div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">{BENCHMARKS[benchKey].label}リターン</div>
              <div className={`font-mono font-medium ${stats.benchReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                {pct(stats.benchReturn)}%
              </div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">超過リターン</div>
              <div className={`font-mono font-medium ${stats.excessReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                {pct(stats.excessReturn)}%
              </div>
            </div>
          </div>

          <div className="mb-2 text-xs text-gray-500 font-medium">
            相対パフォーマンス (基準日=100)
          </div>
          <div ref={perfChartRef} className="w-full rounded border border-gray-100 mb-4" />

          <div className="mb-2 text-xs text-gray-500 font-medium">
            <span className="text-purple-500">β</span> /{" "}
            <span className="text-amber-500">相関</span> (60日ローリング)
          </div>
          <div ref={betaChartRef} className="w-full rounded border border-gray-100" />
        </>
      )}

      <AnalysisGuide title="ベンチマーク比較の読み方">
        <p><span className="font-medium">β (ベータ):</span> 市場全体に対する感応度。β=1なら市場と同じ動き、β{">"}1なら市場以上に変動（攻撃的）、β{"<"}1なら市場より安定（防御的）。</p>
        <p><span className="font-medium">α (アルファ):</span> ベンチマーク対比の超過リターン（年率）。正のαは市場を上回るパフォーマンス。CAPMにおける「市場では説明できないリターン」。</p>
        <p><span className="font-medium">トラッキングエラー (TE):</span> 超過リターンの標準偏差（年率）。ベンチマークからのリターンの乖離度合い。</p>
        <p><span className="font-medium">情報レシオ (IR):</span> α / TE。リスク調整済みの超過リターン。0.5以上で良好とされる。</p>
        <p><span className="font-medium">ローリングβ:</span> 60日ごとのβの推移。βが安定していればリスク特性が一貫しており、変動が大きければ市場環境によってリスク特性が変わる銘柄。</p>
      </AnalysisGuide>
    </div>
  );
}
