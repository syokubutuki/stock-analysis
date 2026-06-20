"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { createChart, LineSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { upDownCapture, cointegration, rollingCorrBeta } from "../../lib/relative-strength-ext";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const PRESETS = [
  { ticker: "^N225", label: "日経225" },
  { ticker: "^GSPC", label: "S&P500" },
  { ticker: "^TPX", label: "TOPIX" },
];

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
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

export default function RelativeStrengthExtChart({ prices }: Props) {
  const spreadRef = useRef<HTMLDivElement>(null);
  const spreadApi = useRef<IChartApi | null>(null);
  const corrRef = useRef<HTMLDivElement>(null);
  const corrApi = useRef<IChartApi | null>(null);
  const llRef = useRef<HTMLCanvasElement>(null);

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

  const capture = useMemo(() => (benchPrices ? upDownCapture(prices, benchPrices) : null), [prices, benchPrices]);
  const coint = useMemo(() => (benchPrices ? cointegration(prices, benchPrices) : null), [prices, benchPrices]);
  const rolling = useMemo(() => (benchPrices ? rollingCorrBeta(prices, benchPrices, 63) : null), [prices, benchPrices]);

  useEffect(() => {
    if (!spreadRef.current || !coint) return;
    if (spreadApi.current) spreadApi.current.remove();
    const chart = createChart(spreadRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: spreadRef.current.clientWidth, height: 160, timeScale: { timeVisible: false },
    });
    spreadApi.current = chart;
    const z = chart.addSeries(LineSeries, { color: "#7c3aed", lineWidth: 1, title: "スプレッドZ" });
    z.setData(coint.spread.map((p) => ({ time: p.time as Time, value: p.z })));
    for (const lv of [2, 0, -2]) {
      const g = chart.addSeries(LineSeries, { color: lv === 0 ? "#9ca3af" : "#d1d5db", lineWidth: 1, lineStyle: 2 });
      g.setData(coint.spread.map((p) => ({ time: p.time as Time, value: lv })));
    }
    chart.timeScale().fitContent();
    const onResize = () => spreadRef.current && chart.applyOptions({ width: spreadRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); spreadApi.current = null; };
  }, [coint]);

  useEffect(() => {
    if (!corrRef.current || !rolling) return;
    if (corrApi.current) corrApi.current.remove();
    const chart = createChart(corrRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: corrRef.current.clientWidth, height: 160, timeScale: { timeVisible: false },
    });
    corrApi.current = chart;
    const c = chart.addSeries(LineSeries, { color: "#2563eb", lineWidth: 2, title: "相関(63日)" });
    c.setData(rolling.series.map((p) => ({ time: p.time as Time, value: p.corr })));
    const bt = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 1, title: "β", priceScaleId: "beta" });
    bt.setData(rolling.series.map((p) => ({ time: p.time as Time, value: p.beta })));
    chart.priceScale("beta").applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
    chart.timeScale().fitContent();
    const onResize = () => corrRef.current && chart.applyOptions({ width: corrRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); corrApi.current = null; };
  }, [rolling]);

  useEffect(() => {
    if (!llRef.current || !rolling) return;
    const init = initCanvas(llRef.current, 130);
    if (!init) return;
    const { ctx, width } = init;
    const ml = 30, mr = 10, mt = 20, mb = 24;
    const plotW = width - ml - mr, plotH = 130 - mt - mb;
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("相互相関（リードラグ, +ラグ=ベンチ先行）", ml, 13);
    const maxAbs = Math.max(0.05, ...rolling.leadLag.map((l) => Math.abs(l.corr)));
    const slot = plotW / rolling.leadLag.length;
    const zeroY = mt + plotH / 2;
    ctx.strokeStyle = "#e5e7eb"; ctx.beginPath(); ctx.moveTo(ml, zeroY); ctx.lineTo(ml + plotW, zeroY); ctx.stroke();
    rolling.leadLag.forEach((l, i) => {
      const h = (Math.abs(l.corr) / maxAbs) * (plotH / 2 - 2);
      ctx.fillStyle = l.lag === rolling.peakLag ? "#dc2626" : "#93c5fd";
      ctx.fillRect(ml + i * slot + 1, l.corr >= 0 ? zeroY - h : zeroY, slot - 2, h);
    });
    ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    [0, Math.floor(rolling.leadLag.length / 2), rolling.leadLag.length - 1].forEach((i) => ctx.fillText(`${rolling.leadLag[i].lag}`, ml + i * slot + slot / 2, mt + plotH + 12));
  }, [rolling]);

  if (prices.length < 80) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">相対力の拡張（キャプチャ比・共和分・リードラグ）</h3>
        <div className="flex gap-1 text-xs">
          {PRESETS.map((p) => (
            <button key={p.ticker} onClick={() => setBenchTicker(p.ticker)} className={`px-2 py-0.5 rounded ${benchTicker === p.ticker ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{p.label}</button>
          ))}
        </div>
      </div>
      {loading && <div className="text-xs text-gray-400">ベンチマーク読み込み中...</div>}
      {error && <div className="text-xs text-red-500">{error}</div>}

      {capture && (
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="p-2 rounded border border-green-200 bg-green-50"><div className="text-gray-500">アップ・キャプチャ</div><div className="font-mono font-bold">{(capture.upCapture * 100).toFixed(0)}%</div></div>
          <div className="p-2 rounded border border-red-200 bg-red-50"><div className="text-gray-500">ダウン・キャプチャ</div><div className="font-mono font-bold">{(capture.downCapture * 100).toFixed(0)}%</div></div>
          <div className="p-2 rounded border border-blue-200 bg-blue-50"><div className="text-gray-500">キャプチャ比</div><div className="font-mono font-bold">{capture.captureRatio.toFixed(2)}</div></div>
        </div>
      )}

      {coint && (
        <div className={`rounded-md border px-3 py-2 text-xs ${coint.cointegrated ? "border-green-200 bg-green-50 text-green-900" : "border-gray-200 bg-gray-50 text-gray-700"}`}>
          共和分: {coint.cointegrated ? "成立（ペア回帰トレード候補）" : "非成立"}（ADF {coint.adfStat.toFixed(2)} vs 5%臨界 {coint.adfCrit.toFixed(2)}）
          ／ 半減期 {isNaN(coint.halfLife) ? "—" : `${coint.halfLife.toFixed(0)}日`} ／ 現在Z {coint.currentZ.toFixed(2)}
          {Math.abs(coint.currentZ) > 2 && <span className="font-bold">（±2σ超＝回帰狙いの好機）</span>}
        </div>
      )}

      {coint && <div><div className="text-xs text-gray-500 mb-1">スプレッドZ（銘柄−β×ベンチ, ±2σ）</div><div ref={spreadRef} className="w-full rounded border border-gray-100" /></div>}
      {rolling && <div><div className="text-xs text-gray-500 mb-1">ローリング相関・β（青=相関/橙=β, 右第2軸）</div><div ref={corrRef} className="w-full rounded border border-gray-100" /></div>}
      {rolling && <div className="relative"><canvas ref={llRef} /></div>}
      {rolling && (
        <div className="text-xs text-gray-500">
          ピークラグ = {rolling.peakLag}（{rolling.peakLag > 0 ? "ベンチが先行" : rolling.peakLag < 0 ? "銘柄が先行" : "同時"}）
        </div>
      )}

      <AnalysisGuide title="相対力拡張の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"ベンチマーク（指数）との関係を3つの角度で見る: ①上げ相場/下げ相場でどれだけ取れているか(キャプチャ)、②長期的に同じ動きへ戻る関係か(共和分)、③相関・βの時間変化と、どちらが先に動くか(リードラグ)。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 各分析</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>アップ/ダウン・キャプチャ</strong>: ベンチ上昇日の平均リターン比/下落日の比。上100%超&下100%未満が理想。キャプチャ比=上/下。</li>
          <li><strong>共和分(Engle-Granger)</strong>: ln(銘柄)=α+β·ln(ベンチ)+残差。残差(スプレッド)が定常(ADF検定)なら共和分成立＝長期的に一定関係へ戻る。半減期＝行き過ぎが半分戻る日数。</li>
          <li><strong>リードラグ</strong>: 相互相関のピークラグ。正＝ベンチが先行（銘柄が後追い）。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>キャプチャ比＞1＝地合いに対し有利な非対称。コア候補。</li>
          <li>共和分成立＆現在Zが±2σ＝スプレッドの平均回帰を狙うペアトレード（割安側買い/割高側売り）。半減期で保有期間の目安。</li>
          <li>ベンチが先行（正のピークラグ）＝指数の動きを銘柄売買のシグナルに使える。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>共和分関係は崩れることがある（構造変化）。Zの戻りが来ない＝関係崩壊のリスク。</li>
          <li>ADFは標本・ラグに敏感。半減期が長すぎる/負＝回帰が弱い。</li>
          <li>キャプチャ・βは標本減で不安定。ベンチ選択で結論が変わる。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
