"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { createChart, LineSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { alignReturns } from "../../lib/portfolio-risk";
import { computeDCC } from "../../lib/dcc";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  ticker?: string;
}

const PRESETS = [
  { ticker: "^N225", label: "日経225" },
  { ticker: "^GSPC", label: "S&P500" },
  { ticker: "^TPX", label: "TOPIX" },
];

export default function BenchmarkDCCChart({ prices, ticker = "銘柄" }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const [benchTicker, setBenchTicker] = useState("^N225");
  const [benchPrices, setBenchPrices] = useState<PricePoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true); setError(null);
      try {
        const res = await fetch(`/api/stock?ticker=${encodeURIComponent(benchTicker)}&range=10y`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.prices) { setError("ベンチマーク取得失敗"); setBenchPrices(null); }
        else setBenchPrices(json.prices);
      } catch { if (!cancelled) { setError("通信エラー"); setBenchPrices(null); } }
      finally { if (!cancelled) setLoading(false); }
    };
    run();
    return () => { cancelled = true; };
  }, [benchTicker]);

  const dcc = useMemo(() => {
    if (!benchPrices) return null;
    const aligned = alignReturns([{ ticker, prices }, { ticker: benchTicker, prices: benchPrices }], 60);
    if (aligned.returns.length < 2 || aligned.dates.length < 60) return null;
    const res = computeDCC(aligned);
    return res.ok ? { res, dates: aligned.dates } : null;
  }, [prices, benchPrices, benchTicker, ticker]);

  useEffect(() => {
    if (!chartRef.current || !dcc) return;
    if (apiRef.current) apiRef.current.remove();
    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth, height: 220, timeScale: { timeVisible: false },
    });
    apiRef.current = chart;
    const c = chart.addSeries(LineSeries, { color: "#dc2626", lineWidth: 2, title: "DCC相関" });
    c.setData(dcc.res.avgCorrSeries.map((v, i) => ({ time: dcc.dates[i] as Time, value: v })));
    const u = chart.addSeries(LineSeries, { color: "#9ca3af", lineWidth: 1, lineStyle: 2, title: "平時(無条件)" });
    u.setData(dcc.res.avgCorrSeries.map((_, i) => ({ time: dcc.dates[i] as Time, value: dcc.res.uncondAvgCorr })));
    chart.timeScale().fitContent();
    const onResize = () => chartRef.current && chart.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); apiRef.current = null; };
  }, [dcc]);

  if (prices.length < 80) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">時変相関 DCC（対ベンチマーク）</h3>
        <div className="flex gap-1 text-xs">
          {PRESETS.map((p) => (
            <button key={p.ticker} onClick={() => setBenchTicker(p.ticker)} className={`px-2 py-0.5 rounded ${benchTicker === p.ticker ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{p.label}</button>
          ))}
        </div>
      </div>
      {loading && <div className="text-xs text-gray-400">ベンチマーク読み込み中...</div>}
      {error && <div className="text-xs text-red-500">{error}</div>}

      {dcc && (
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="p-2 rounded border border-gray-200 bg-gray-50"><div className="text-gray-500">平時相関</div><div className="font-mono font-bold">{dcc.res.uncondAvgCorr.toFixed(2)}</div></div>
          <div className="p-2 rounded border border-red-200 bg-red-50"><div className="text-gray-500">現在相関</div><div className="font-mono font-bold">{dcc.res.currentAvgCorr.toFixed(2)}</div></div>
          <div className="p-2 rounded border border-amber-200 bg-amber-50"><div className="text-gray-500">期間ピーク</div><div className="font-mono font-bold">{dcc.res.peakAvgCorr.toFixed(2)}</div></div>
        </div>
      )}

      <div ref={chartRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="時変相関DCCの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"銘柄とベンチの相関は一定ではなく、暴落時に1へ近づく（分散投資が効かなくなる）。DCC-GARCHで時間変化する相関を推定し、平時と現在を比べる。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>各系列をGARCH(1,1)の条件付きボラで標準化 → 標準化残差 z。</li>
          <li>Q_t=(1−a−b)Q̄ + a·z_{"{t-1}"}z_{"{t-1}"}ᵀ + b·Q_{"{t-1}"} を更新し、相関行列 R_t に正規化。</li>
          <li>平時＝無条件相関 Q̄、現在＝最新 R_T。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>現在相関が平時より高い＝分散効果が劣化。ヘッジ・現金比率を上げる判断に。</li>
          <li>相関が急上昇＝リスクオフ（一斉売り）。個別の独自性が消える局面。</li>
          <li>相関が低下＝銘柄固有の材料が効く局面。アルファ追求に向く。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>GARCH/DCCの推定は標本・初期値に依存。短期間では不安定。</li>
          <li>2資産の相関なので避難先の選定には複数ベンチで確認を。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
