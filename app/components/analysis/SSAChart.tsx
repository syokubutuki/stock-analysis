"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { computeSSA } from "../../lib/ssa";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function SSAChart({ prices, seriesMode }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);
  const screeRef = useRef<HTMLCanvasElement>(null);

  const { values, times } = extractSeries(prices, seriesMode);
  const result = useMemo(() => computeSSA(values), [values]);

  // Time series decomposition chart
  useEffect(() => {
    if (!chartRef.current || result.trend.length === 0) return;
    if (chartApiRef.current) chartApiRef.current.remove();

    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 250,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartApiRef.current = chart;

    // Original
    const origSeries = chart.addSeries(LineSeries, {
      color: "#9ca3af",
      lineWidth: 1,
      title: "原系列",
    });
    origSeries.setData(
      times.map((t, i) => ({ time: t as Time, value: result.original[i] }))
    );

    // Trend
    const trendSeries = chart.addSeries(LineSeries, {
      color: "#2563eb",
      lineWidth: 2,
      title: "トレンド",
    });
    trendSeries.setData(
      times.map((t, i) => ({ time: t as Time, value: result.trend[i] }))
    );

    // Periodic
    if (result.periodic.some((v) => Math.abs(v) > 1e-10)) {
      const periodicSeries = chart.addSeries(LineSeries, {
        color: "#059669",
        lineWidth: 1,
        title: "周期成分",
      });
      // Shift periodic to trend level for visibility
      const trendMean = result.trend.reduce((a, b) => a + b, 0) / result.trend.length;
      periodicSeries.setData(
        times.map((t, i) => ({ time: t as Time, value: result.periodic[i] + trendMean }))
      );
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth });
    });
    ro.observe(chartRef.current);
    return () => {
      ro.disconnect();
      chart.remove();
      chartApiRef.current = null;
    };
  }, [result, times]);

  // Scree plot
  useEffect(() => {
    const canvas = screeRef.current;
    if (!canvas || result.components.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const width = parent.clientWidth;
    const height = 140;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, width, height);

    const pad = { top: 20, right: 15, bottom: 30, left: 50 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const comps = result.components;
    const maxContrib = Math.max(...comps.map((c) => c.contribution));

    const barW = plotW / comps.length * 0.6;
    const gap = plotW / comps.length;

    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      const x = pad.left + i * gap + gap * 0.2;
      const h = (c.contribution / maxContrib) * plotH;
      const y = pad.top + plotH - h;

      ctx.fillStyle =
        c.category === "trend" ? "#2563eb" :
        c.category === "periodic" ? "#059669" : "#d1d5db";
      ctx.fillRect(x, y, barW, h);

      // Label
      ctx.fillStyle = "#374151";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${c.contribution.toFixed(1)}%`, x + barW / 2, y - 3);
      ctx.fillStyle = "#6b7280";
      ctx.fillText(`#${i + 1}`, x + barW / 2, height - pad.bottom + 12);
    }

    ctx.fillStyle = "#374151";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("スクリープロット（成分寄与率）", width / 2, 14);

    // Legend
    ctx.textAlign = "left";
    const ly = height - 5;
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(pad.left, ly - 6, 8, 8);
    ctx.fillStyle = "#374151";
    ctx.font = "9px sans-serif";
    ctx.fillText("トレンド", pad.left + 11, ly);
    ctx.fillStyle = "#059669";
    ctx.fillRect(pad.left + 55, ly - 6, 8, 8);
    ctx.fillStyle = "#374151";
    ctx.fillText("周期", pad.left + 66, ly);
    ctx.fillStyle = "#d1d5db";
    ctx.fillRect(pad.left + 98, ly - 6, 8, 8);
    ctx.fillStyle = "#374151";
    ctx.fillText("ノイズ", pad.left + 109, ly);
  }, [result]);

  if (result.components.length === 0) return null;

  const trendComps = result.components.filter((c) => c.category === "trend");
  const periodicComps = result.components.filter((c) => c.category === "periodic");

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">
        特異スペクトル分析 (SSA)
      </h3>

      <div className="flex flex-wrap gap-2 mb-3">
        <span className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700">
          トレンド: {trendComps.reduce((s, c) => s + c.contribution, 0).toFixed(1)}%
        </span>
        <span className="text-xs px-2 py-1 rounded bg-green-100 text-green-700">
          周期: {periodicComps.reduce((s, c) => s + c.contribution, 0).toFixed(1)}%
        </span>
        <span className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-600">
          成分数: {result.components.length}
        </span>
      </div>

      <div ref={chartRef} />
      <canvas ref={screeRef} className="mt-3" />

      <p className="text-xs text-gray-600 mt-2">{result.interpretation}</p>

      <AnalysisGuide title="特異スペクトル分析(SSA)の詳細理論">
        <p className="font-medium text-gray-700">1. SSAとは</p>
        <p>
          時系列をトレンド・周期成分・ノイズに分解する手法です。
          EMD（経験的モード分解）と似ていますが、SSAは行列の特異値分解(SVD)に基づく
          数学的に厳密な手法です。音楽に例えると、曲を「メロディ（トレンド）」
          「リズム（周期）」「ノイズ（雑音）」に分離するようなものです。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>{"1. トラジェクトリ行列: T[i][j] = x[i+j], i=0..L-1, j=0..K-1"}</p>
        <p>{"2. SVD: T = Sigma_k sigma_k * U_k * V_k^T"}</p>
        <p>{"3. 対角平均: 各rank-1成分を元の時系列長に逆変換"}</p>
        <p>{"窓幅 L ≈ min(N/3, 100), 成分数 = min(L, K)の上位r個"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>青線（トレンド）: 長期的な方向性。第1特異値が大きいほどトレンドが明確</li>
          <li>緑線（周期成分）: ペアの特異値（類似の大きさ）が周期的振動を表す</li>
          <li>スクリープロット: 各成分の寄与率。「肘」の位置がシグナルとノイズの境界</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>トレンド成分の方向: 長期投資のポジション方向の参考</li>
          <li>周期成分: サイクルトレードのタイミング（周期の谷で買い、山で売り）</li>
          <li>ノイズ比率が高い場合: 短期予測は困難、中長期に焦点を当てる</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>窓幅Lの選択が結果に影響。大きすぎると計算コスト増、小さすぎると分解精度低下</li>
          <li>Power iteration SVDは近似的であり、精度はモード数に依存</li>
          <li>非定常な時系列では分解結果の解釈に注意が必要</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
