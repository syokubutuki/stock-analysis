"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { analyzeRangeContraction, TriggerStat } from "../../lib/range-contraction";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

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

// トリガー別 翌日|変化| vs 基準
function drawBars(ctx: CanvasRenderingContext2D, width: number, height: number, stats: TriggerStat[], baseline: number) {
  const ml = 150, mr = 70, mt = 24, mb = 8;
  const plotW = width - ml - mr;
  const rows = stats.filter((s) => s.n > 0);
  const rowH = (height - mt - mb) / Math.max(1, rows.length);
  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("トリガー翌日の平均|変化率| （点線=全日平均）", ml - 140, 14);
  const maxV = Math.max(baseline, ...rows.map((s) => s.meanAbsNext), 1e-9);
  const xBase = ml + (baseline / maxV) * plotW;
  ctx.strokeStyle = "#9ca3af";
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(xBase, mt);
  ctx.lineTo(xBase, mt + rows.length * rowH);
  ctx.stroke();
  ctx.setLineDash([]);
  rows.forEach((s, i) => {
    const y = mt + i * rowH;
    const w = (s.meanAbsNext / maxV) * plotW;
    const bigger = s.meanAbsNext > baseline;
    ctx.fillStyle = bigger ? "#7c3aed" : "#9ca3af";
    ctx.fillRect(ml, y + rowH * 0.2, w, rowH * 0.5);
    ctx.fillStyle = "#374151";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`${s.label}(${s.n})`, ml - 4, y + rowH * 0.5);
    ctx.textAlign = "left";
    ctx.fillText(`${(s.meanAbsNext * 100).toFixed(2)}% / 上${(s.upRate * 100).toFixed(0)}%`, ml + w + 4, y + rowH * 0.5);
  });
}

const COLORS: Record<string, string> = { NR7: "#7c3aed", inside: "#0ea5e9", squeeze: "#f59e0b" };

export default function RangeContractionChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const barRef = useRef<HTMLCanvasElement>(null);

  const result = useMemo(() => analyzeRangeContraction(prices), [prices]);

  useEffect(() => {
    if (!chartRef.current || prices.length < 30) return;
    if (apiRef.current) apiRef.current.remove();
    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 260,
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a", downColor: "#ef5350",
      borderUpColor: "#26a69a", borderDownColor: "#ef5350",
      wickUpColor: "#26a69a", wickDownColor: "#ef5350",
    });
    candle.setData(prices.map((p) => ({ time: p.time as Time, open: p.open, high: p.high, low: p.low, close: p.close })));
    if (result.markers.length > 0) {
      createSeriesMarkers(
        candle,
        result.markers.map((m) => ({
          time: m.time as Time,
          position: "belowBar" as const,
          color: COLORS[m.type] ?? "#7c3aed",
          shape: "arrowUp" as const,
          text: m.type,
        }))
      );
    }
    chart.timeScale().fitContent();
    const onResize = () => chartRef.current && chart.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      apiRef.current = null;
    };
  }, [prices, result]);

  useEffect(() => {
    if (!barRef.current || result.stats.length === 0) return;
    const rows = result.stats.filter((s) => s.n > 0).length;
    const init = initCanvas(barRef.current, 40 + rows * 28);
    if (init) drawBars(init.ctx, init.width, init.height, result.stats, result.stats[0]?.baselineAbs ?? 0);
  }, [result]);

  if (prices.length < 30) return null;

  const g = result.gauge;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">レンジ収縮 → ブレイク（NR7・inside・スクイーズ）</h3>

      {/* スクイーズゲージ */}
      {g && (
        <div className={`rounded-md border px-3 py-2 text-xs ${g.isSqueeze ? "border-amber-300 bg-amber-50 text-amber-900" : "border-gray-200 bg-gray-50 text-gray-700"}`}>
          <span className="font-bold">{g.isSqueeze ? "⚠ 現在スクイーズ（ブレイク前夜の可能性）" : "現在は通常レンジ"}</span>
          {" "}— BB幅は過去の下位 <span className="font-bold">{(g.bbPctile * 100).toFixed(0)}%</span>・ATRは下位 <span className="font-bold">{(g.atrPctile * 100).toFixed(0)}%</span>
          （いずれも低いほど収縮）。
          <div className="mt-1 flex gap-3">
            {(["bbPctile", "atrPctile"] as const).map((k) => (
              <div key={k} className="flex items-center gap-1">
                <span className="text-gray-500">{k === "bbPctile" ? "BB幅" : "ATR"}</span>
                <div className="relative h-2 w-24 bg-gray-200 rounded-sm overflow-hidden">
                  <div className="absolute inset-y-0 left-0 bg-amber-500" style={{ width: `${g[k] * 100}%` }} />
                  <div className="absolute inset-y-0 left-[20%] w-px bg-red-500" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div ref={chartRef} className="w-full rounded border border-gray-100" />
      <div className="text-xs text-gray-500">
        マーカー: <span style={{ color: COLORS.NR7 }}>▲NR7</span> / <span style={{ color: COLORS.inside }}>▲inside</span> / <span style={{ color: COLORS.squeeze }}>▲squeeze</span>（直近{result.markers.length}件）
      </div>

      <div className="relative"><canvas ref={barRef} /></div>

      <AnalysisGuide title="レンジ収縮→ブレイクの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"ボラティリティはクラスタリングし、収縮（小動き）は拡張（大動き）に先行しやすい。値幅が極端に縮んだ日（NR7・inside day・BB幅スクイーズ）の翌日に、本当に大きな放れ（ブレイク）が起きるのかを統計で確かめる。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>NR7</strong>: 当日レンジ(H−L)が直近7日で最小。<strong>WR7</strong>: 最大。</li>
          <li><strong>inside day</strong>: 当日の高値&lt;前日高値 かつ 安値&gt;前日安値（前日に内包）。<strong>outside day</strong>: 逆（前日を包む）。</li>
          <li><strong>BB幅スクイーズ</strong>: ボリンジャーバンド幅 4σ(20)/SMA(20) が過去の下位20%。</li>
          <li><strong>放れの大きさ</strong>: トリガー翌日の|リターン|。<strong>追随率</strong>: 翌日終値が当日より上だった割合。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>棒が点線（全日平均）より<strong>右に長い＝そのトリガー後は平均より値幅が出る</strong>＝ブレイク戦略の根拠。</li>
          <li>上部ゲージが<strong>スクイーズ点灯＝ブレイク前夜</strong>。エントリー準備（ブレイクアウト注文）。</li>
          <li>「上率」が50%から大きく離れていれば方向の偏りも示唆。50%近辺なら方向は別シグナルで補う。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>収縮は「いつ・どちらに放れるか」までは保証しない。だまし（フェイクブレイク）も多い。</li>
          <li>値幅が出ても方向を取れなければ利益にならない。ストップを併用。</li>
          <li>翌日終値ベースの簡易集計。日中の経路は『高値・安値の時間帯分析』を併用。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
