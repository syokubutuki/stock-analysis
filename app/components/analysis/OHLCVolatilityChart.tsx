"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { createChart, LineSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { rollingOHLCVol, wholePeriodVol, VolEstimates } from "../../lib/ohlc-volatility";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const WINDOWS = [10, 20, 60];

const EST_META: { key: keyof VolEstimates; label: string; color: string }[] = [
  { key: "close", label: "終値間(CC)", color: "#9ca3af" },
  { key: "yangZhang", label: "Yang-Zhang", color: "#dc2626" },
  { key: "gk", label: "Garman-Klass", color: "#2563eb" },
  { key: "parkinson", label: "Parkinson", color: "#16a34a" },
  { key: "rs", label: "Rogers-Satchell", color: "#d97706" },
];

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;

export default function OHLCVolatilityChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const effRef = useRef<HTMLCanvasElement>(null);
  const [window_, setWindow] = useState(20);
  const [shown, setShown] = useState<Set<keyof VolEstimates>>(
    new Set<keyof VolEstimates>(["close", "yangZhang", "gk"])
  );

  const series = useMemo(() => rollingOHLCVol(prices, window_), [prices, window_]);
  const eff = useMemo(() => wholePeriodVol(prices), [prices]);
  const latest = series.length ? series[series.length - 1].est : null;

  // ローリングσ系列（lightweight-charts）
  useEffect(() => {
    if (!chartRef.current || series.length === 0) return;
    if (apiRef.current) apiRef.current.remove();
    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 240,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;
    for (const m of EST_META) {
      if (!shown.has(m.key)) continue;
      const s = chart.addSeries(LineSeries, {
        color: m.color,
        lineWidth: m.key === "yangZhang" ? 2 : 1,
        title: m.label,
      });
      s.setData(series.map((p) => ({ time: p.time as Time, value: p.est[m.key] * 100 })));
    }
    chart.timeScale().fitContent();
    const onResize = () => chartRef.current && chart.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      apiRef.current = null;
    };
  }, [series, shown]);

  // 効率比バー（終値間法に対するσ²比。短いほど効率的）
  useEffect(() => {
    if (!effRef.current || !eff) return;
    const init = initCanvas(effRef.current, 150);
    if (!init) return;
    const { ctx, width } = init;
    const ml = 110, mr = 50, mt = 24, mb = 8;
    const plotW = width - ml - mr;
    const rows = EST_META.filter((m) => m.key !== "close");
    const rowH = (150 - mt - mb) / rows.length;
    ctx.fillStyle = "#374151";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("終値間法に対する分散(σ²)比 — 短いほど効率的", ml - 100, 14);
    // 基準線 1.0
    const maxR = Math.max(1, ...rows.map((m) => eff.varRatio[m.key]));
    const x1 = ml + (1 / maxR) * plotW;
    ctx.strokeStyle = "#9ca3af";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, mt);
    ctx.lineTo(x1, mt + rows.length * rowH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#9ca3af";
    ctx.font = "8px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("CC=1.0", x1, mt - 2);
    rows.forEach((m, i) => {
      const y = mt + i * rowH;
      const ratio = eff.varRatio[m.key];
      const w = (ratio / maxR) * plotW;
      ctx.fillStyle = m.color;
      ctx.fillRect(ml, y + rowH * 0.2, w, rowH * 0.55);
      ctx.fillStyle = "#374151";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(m.label, ml - 4, y + rowH * 0.55);
      ctx.textAlign = "left";
      ctx.fillText(`${ratio.toFixed(2)}×`, ml + w + 4, y + rowH * 0.55);
    });
  }, [eff]);

  if (prices.length < 30) return null;

  const toggle = (k: keyof VolEstimates) => {
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">OHLCボラティリティ推定量の比較（Yang-Zhang ほか）</h3>
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span>窓:</span>
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`px-2 py-0.5 rounded ${window_ === w ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
            >
              {w}日
            </button>
          ))}
        </div>
      </div>

      {/* 現在ボラのカード */}
      {latest && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 text-xs">
          {EST_META.map((m) => (
            <div
              key={m.key}
              className={`p-2 rounded border ${m.key === "yangZhang" ? "border-red-300 bg-red-50" : "border-gray-200 bg-gray-50"}`}
            >
              <div className="text-gray-500 flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-sm" style={{ background: m.color }} />
                {m.label}
              </div>
              <div className="font-mono font-medium text-gray-800">年率 {fmtPct(latest[m.key])}</div>
              <div className="font-mono text-gray-400 text-[10px]">日次 {(latest[m.key] / Math.sqrt(252) * 100).toFixed(2)}%</div>
            </div>
          ))}
        </div>
      )}

      {/* 系列トグル */}
      <div className="flex gap-1 flex-wrap">
        {EST_META.map((m) => (
          <button
            key={m.key}
            onClick={() => toggle(m.key)}
            className={`px-2 py-0.5 text-xs rounded border ${shown.has(m.key) ? "text-white" : "text-gray-500 bg-white"}`}
            style={shown.has(m.key) ? { background: m.color, borderColor: m.color } : { borderColor: "#e5e7eb" }}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div>
        <div className="text-xs text-gray-500 mb-1">ローリング年率ボラティリティ（%, 窓{window_}日）</div>
        <div ref={chartRef} className="w-full rounded border border-gray-100" />
      </div>

      <div className="relative"><canvas ref={effRef} /></div>

      <AnalysisGuide title="OHLCボラティリティ推定量の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"ボラティリティ（変動の大きさ）を、終値だけでなく高値・安値・始値も使って推定する。終値間（close-to-close）法は1日に終値1点しか使わないため推定の分散が大きい。レンジ（高安）や窓を取り込むことで、同じ“真のσ”をより少ない誤差で・少ない日数で推定できる。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 各推定量の数式（O,H,L,C＝始/高/安/終、年率化は×√252）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>終値間(CC)</strong>: σ² = Var(ln(C_t/C_t−1))。基準。窓もレンジも使わない。</li>
          <li><strong>Parkinson</strong>: σ² = mean((ln(H/L))²) / (4ln2)。レンジのみ。ドリフト0・窓無視を仮定。</li>
          <li><strong>Garman-Klass</strong>: σ² = mean(0.5(ln(H/L))² − (2ln2−1)(ln(C/O))²)。OHLC全部。窓は無視。</li>
          <li><strong>Rogers-Satchell</strong>: σ² = mean(ln(H/C)ln(H/O)+ln(L/C)ln(L/O))。ドリフト（トレンド）があっても不偏。</li>
          <li><strong>Yang-Zhang</strong>: σ² = σ²夜間 + k·σ²日中 + (1−k)·σ²RS、k=0.34/(1.34+(n+1)/(n−1))。<strong>窓（オーバーナイト）を含む</strong>唯一の推定量で、日足では最も効率的かつバイアスが小さい。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>効率</strong>: 同じ精度を得るのに必要な標本の少なさ。下段の「σ²比」が小さいほど、終値間法より少ない誤差で測れている＝効率的。</li>
          <li>例え: 1日の値動きを「終値1枚の写真」で測るか「高安を含む動画」で測るかの違い。動画（OHLC）の方が変動を正確に捉えられる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>カードの<strong>Yang-Zhang年率σ</strong>が現在の最良のリスク推定。ポジションサイズ＝資金リスク/（σ×価格）の分母に使う。</li>
          <li>YZが終値間法より高い＝窓（持ち越しギャップ）でリスクを取っている銘柄。持ち越し管理を厚く。</li>
          <li>ローリング系列でσが急上昇＝レジーム転換。ストップ幅拡大・サイズ縮小の合図。</li>
          <li>下段のσ²比でOHLC系が0.2〜0.5×＝終値間法の2〜5倍効率的、という底上げ効果が読める。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Parkinson/GKは窓を無視するため、窓の大きい銘柄ではリスクを過小評価する。</li>
          <li>レンジ推定量は高安が日中の経路を反映するため、ストップ狩りや一瞬の極値に影響されうる。</li>
          <li>窓が極端に小さい標本ではYZのkが不安定。窓は十分な日数（n≥10程度）で。</li>
          <li>年率化は独立同分布を仮定（√時間則）。強い自己相関下では近似。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
