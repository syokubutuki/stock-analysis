"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { createChart, LineSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeRelativeStrength } from "../../lib/relative-strength";
import GuideEntryPanel from "./GuideEntryPanel";

interface Props {
  prices: PricePoint[];
}

const PRESETS = [
  { ticker: "^N225", label: "日経225" },
  { ticker: "^GSPC", label: "S&P500" },
  { ticker: "1306.T", label: "TOPIX(ETF)" },
];
const WINDOWS = [21, 63, 126];

export default function RelativeStrengthChart({ prices }: Props) {
  const ratioRef = useRef<HTMLDivElement>(null);
  const momRef = useRef<HTMLDivElement>(null);
  const ratioApi = useRef<IChartApi | null>(null);
  const momApi = useRef<IChartApi | null>(null);

  const [benchTicker, setBenchTicker] = useState("^N225");
  const [benchPrices, setBenchPrices] = useState<PricePoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [window_, setWindow] = useState(63);
  const [input, setInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/stock?ticker=${encodeURIComponent(benchTicker)}&range=10y`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.prices) {
          setError("ベンチマーク取得失敗");
          setBenchPrices(null);
        } else {
          setBenchPrices(json.prices);
        }
      } catch {
        if (!cancelled) {
          setError("通信エラー");
          setBenchPrices(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [benchTicker]);

  const result = useMemo(() => {
    if (!benchPrices) return null;
    return computeRelativeStrength(prices, benchPrices, window_);
  }, [prices, benchPrices, window_]);

  useEffect(() => {
    if (!ratioRef.current || !result) return;
    if (ratioApi.current) ratioApi.current.remove();
    const chart = createChart(ratioRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: ratioRef.current.clientWidth, height: 220,
      timeScale: { timeVisible: false },
    });
    ratioApi.current = chart;
    const line = chart.addSeries(LineSeries, { color: "#7c3aed", lineWidth: 2, title: "相対力(比率, 100基準)" });
    line.setData(result.points.map((p) => ({ time: p.time as Time, value: p.ratio })));
    chart.timeScale().fitContent();
    const onResize = () => ratioRef.current && chart.applyOptions({ width: ratioRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); ratioApi.current = null; };
  }, [result]);

  useEffect(() => {
    if (!momRef.current || !result) return;
    if (momApi.current) momApi.current.remove();
    const chart = createChart(momRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: momRef.current.clientWidth, height: 140,
      timeScale: { timeVisible: false },
    });
    momApi.current = chart;
    const line = chart.addSeries(LineSeries, { color: "#0ea5e9", lineWidth: 1, title: `RSモメンタム(${window_}日変化%)` });
    line.setData(result.points.map((p) => ({ time: p.time as Time, value: p.momentum })));
    chart.timeScale().fitContent();
    const onResize = () => momRef.current && chart.applyOptions({ width: momRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); momApi.current = null; };
  }, [result, window_]);

  if (prices.length < 30) return null;

  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">相対力（対ベンチマーク）と RSモメンタム</h3>
        <div className="flex items-center gap-1 text-xs">
          {PRESETS.map((p) => (
            <button
              key={p.ticker}
              onClick={() => setBenchTicker(p.ticker)}
              className={`px-2 py-0.5 rounded ${benchTicker === p.ticker ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
            >
              {p.label}
            </button>
          ))}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && input.trim()) setBenchTicker(input.trim()); }}
            placeholder="ﾃｨｯｶｰ"
            className="w-16 px-1 py-0.5 border border-gray-200 rounded"
          />
        </div>
      </div>

      <div className="flex items-center gap-1 text-xs text-gray-600">
        <span>モメンタム窓:</span>
        {WINDOWS.map((w) => (
          <button key={w} onClick={() => setWindow(w)} className={`px-2 py-0.5 rounded ${window_ === w ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{w}日</button>
        ))}
      </div>

      {loading && <div className="text-xs text-fg-muted">ベンチマーク読み込み中...</div>}
      {error && <div className="text-xs text-red-500">{error}</div>}

      {result && (
        <div className="rounded-md border border-purple-200 bg-purple-50 px-3 py-2 text-xs text-purple-900">
          期間中の対ベンチ相対パフォーマンス <span className="font-bold">{fmtPct(result.relPerf)}</span>
          （銘柄 {fmtPct(result.stockTotal)} vs ベンチ {fmtPct(result.benchTotal)}）。
          現在のRSモメンタム <span className="font-bold">{result.latestMomentum >= 0 ? "+" : ""}{result.latestMomentum.toFixed(1)}%</span>
          {result.latestMomentum >= 0 ? "（市場より強い）" : "（市場より弱い）"}
        </div>
      )}

      <div>
        <div className="text-xs text-gray-500 mb-1">相対力（比率, 上昇＝アウトパフォーム）</div>
        <div ref={ratioRef} className="w-full rounded border border-gray-100" />
      </div>
      <div>
        <div className="text-xs text-gray-500 mb-1">RSモメンタム（ゼロ上＝相対的に強い）</div>
        <div ref={momRef} className="w-full rounded border border-gray-100" />
      </div>

      {/* 解説本文は app/lib/analysis-guides.ts の唯一のソースから描く。
          ここに散文を書き戻すと /guide/relative-strength と二重管理になる。 */}
      <GuideEntryPanel slug="relative-strength" title="相対力・RSモメンタムの詳細理論" />
    </div>
  );
}
