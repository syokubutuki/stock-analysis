"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { createChart, LineSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeRelativeStrength } from "../../lib/relative-strength";
import AnalysisGuide from "./AnalysisGuide";

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

      {loading && <div className="text-xs text-gray-400">ベンチマーク読み込み中...</div>}
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

      <AnalysisGuide title="相対力・RSモメンタムの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"銘柄の値動きを“市場（ベンチマーク指数）”で割って、市場に勝っているか負けているかを見る。絶対リターンが同じでも、市場全体が上げている中での上昇か、下げ相場での健闘かで意味は全く違う。相対力はその文脈を与える。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>相対力（RSライン）</strong>: ratio_t = C_銘柄 / C_ベンチ。初日を100に正規化。</li>
          <li><strong>RSモメンタム</strong>: (ratio_t / ratio_t−w − 1)×100（w日変化率）。</li>
          <li><strong>RS新高値</strong>: ratio_t が過去最高を更新。価格より先に相対力が新高値を取ると先行性のサイン。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>RSラインが<strong>右肩上がり＝アウトパフォーム</strong>。買い候補の選別、保有継続の根拠に。</li>
          <li>RSモメンタムの<strong>ゼロクロス</strong>＝市場に対する優位の転換点。マイナス転換で乗り換え検討。</li>
          <li>下げ相場でRSが上向き＝ディフェンシブに強い。地合い悪化局面の逃げ場銘柄。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ベンチマークの選択で結論が変わる。日本株なら日経/TOPIX、米株ならS&P500等、適切な比較対象を選ぶ。</li>
          <li>相対力が強くても絶対値が下落していれば含み損にはなる（相対と絶対は別物）。</li>
          <li>取引時間・通貨が異なる指数との比較は、時差・為替の影響に注意。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
