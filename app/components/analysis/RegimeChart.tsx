"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  AreaSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { fitHMM, detectChangePoints, kalmanFilter } from "../../lib/regime";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

const STATE_COLORS = ["#22c55e", "#eab308", "#ef4444"];

export default function RegimeChart({ prices, seriesMode }: Props) {
  const hmmRef = useRef<HTMLDivElement>(null);
  const cpRef = useRef<HTMLDivElement>(null);
  const kalmanRef = useRef<HTMLDivElement>(null);
  const transCanvasRef = useRef<HTMLCanvasElement>(null);
  const hmmChartRef = useRef<IChartApi | null>(null);
  const cpChartRef = useRef<IChartApi | null>(null);
  const kalmanChartRef = useRef<IChartApi | null>(null);

  const { values: lr, times: lrTimes } = extractSeries(prices, seriesMode);
  const closes = prices.map((p) => p.close);
  const times = prices.map((p) => p.time);

  const hmm = useMemo(() => fitHMM(lr, 3), [prices, seriesMode]);
  const cp = useMemo(() => detectChangePoints(lr), [prices, seriesMode]);
  const kalman = useMemo(() => kalmanFilter(closes), [prices, seriesMode]);

  // HMM state probability chart
  useEffect(() => {
    if (!hmmRef.current) return;
    if (hmmChartRef.current) hmmChartRef.current.remove();

    const chart = createChart(hmmRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: hmmRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    hmmChartRef.current = chart;

    // Stacked area for state probabilities
    for (let s = hmm.nStates - 1; s >= 0; s--) {
      const series = chart.addSeries(AreaSeries, {
        lineColor: STATE_COLORS[s],
        topColor: STATE_COLORS[s] + "80",
        bottomColor: STATE_COLORS[s] + "10",
        lineWidth: 1,
        title: hmm.stateLabels[s],
      });
      series.setData(
        hmm.stateProbabilities.map((probs, i) => ({
          time: lrTimes[i] as Time,
          value: probs[s],
        }))
      );
    }

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (hmmRef.current) chart.applyOptions({ width: hmmRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); hmmChartRef.current = null; };
  }, [prices, hmm]);

  // Transition matrix canvas
  useEffect(() => {
    const canvas = transCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const size = 180;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);

    const n = hmm.nStates;
    const cellSize = 40;
    const offset = 50;

    // Header
    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("遷移行列", size / 2, 12);

    // Labels
    ctx.font = "9px sans-serif";
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = STATE_COLORS[i];
      ctx.fillText(hmm.stateLabels[i].slice(0, 4), offset + i * cellSize + cellSize / 2, 28);
      ctx.fillText(hmm.stateLabels[i].slice(0, 4), 25, offset + i * cellSize + cellSize / 2 - 5 + 4);
    }

    // Cells
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const val = hmm.transitionMatrix[i][j];
        const intensity = Math.min(val * 1.5, 1);
        ctx.fillStyle = `rgba(59, 130, 246, ${intensity})`;
        ctx.fillRect(offset + j * cellSize + 2, offset + i * cellSize - 5, cellSize - 4, cellSize - 4);
        ctx.fillStyle = intensity > 0.5 ? "#fff" : "#374151";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(val.toFixed(2), offset + j * cellSize + cellSize / 2, offset + i * cellSize + cellSize / 2 - 5 + 2);
      }
    }
  }, [hmm]);

  // Change point chart
  useEffect(() => {
    if (!cpRef.current) return;
    if (cpChartRef.current) cpChartRef.current.remove();

    const chart = createChart(cpRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: cpRef.current.clientWidth,
      height: 120,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    cpChartRef.current = chart;

    // CUSUM series
    const cusumSeries = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 2,
      title: "CUSUM",
    });
    cusumSeries.setData(
      cp.cusumSeries.slice(1).map((v, i) => ({ time: lrTimes[Math.min(i, lrTimes.length - 1)] as Time, value: v }))
    );

    // Segment means
    const segSeries = chart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 2,
      title: "セグメント平均",
      lastValueVisible: false,
    });
    const segData: { time: Time; value: number }[] = [];
    for (const seg of cp.segments) {
      for (let i = seg.start; i < seg.end && i < lrTimes.length; i++) {
        segData.push({ time: lrTimes[i] as Time, value: seg.mean });
      }
    }
    segSeries.setData(segData);

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (cpRef.current) chart.applyOptions({ width: cpRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); cpChartRef.current = null; };
  }, [prices, cp]);

  // Kalman filter chart
  useEffect(() => {
    if (!kalmanRef.current) return;
    if (kalmanChartRef.current) kalmanChartRef.current.remove();

    const chart = createChart(kalmanRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: kalmanRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    kalmanChartRef.current = chart;

    // Observed
    const obsSeries = chart.addSeries(LineSeries, {
      color: "#94a3b8",
      lineWidth: 1,
      title: "観測値",
    });
    obsSeries.setData(
      closes.map((v, i) => ({ time: times[i] as Time, value: v }))
    );

    // Filtered state
    const filtSeries = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      title: "カルマンフィルタ推定",
    });
    filtSeries.setData(
      kalman.filteredState.map((v, i) => ({ time: times[i] as Time, value: v }))
    );

    // Confidence bands
    const upperSeries = chart.addSeries(LineSeries, {
      color: "#93c5fd",
      lineWidth: 1,
      title: "95%上限",
      lineStyle: 2,
    });
    upperSeries.setData(
      kalman.upperBand.map((v, i) => ({ time: times[i] as Time, value: v }))
    );

    const lowerSeries = chart.addSeries(LineSeries, {
      color: "#93c5fd",
      lineWidth: 1,
      title: "95%下限",
      lineStyle: 2,
    });
    lowerSeries.setData(
      kalman.lowerBand.map((v, i) => ({ time: times[i] as Time, value: v }))
    );

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (kalmanRef.current) chart.applyOptions({ width: kalmanRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); kalmanChartRef.current = null; };
  }, [prices, kalman]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">レジーム分析</h3>
      <p className="text-xs text-gray-500 mb-3">HMM状態遷移 / 変化点検出 / カルマンフィルタ</p>

      {/* HMM stats */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3 text-xs">
        {hmm.stateLabels.map((label, s) => (
          <div key={label} className="p-2 rounded" style={{ backgroundColor: STATE_COLORS[s] + "20" }}>
            <div className="font-medium" style={{ color: STATE_COLORS[s] }}>{label}</div>
            <div>μ: {(hmm.stateMeans[s] * 100).toFixed(3)}%</div>
            <div>σ: {(hmm.stateVols[s] * 100).toFixed(3)}%</div>
            <div>持続: {hmm.expectedDuration[s].toFixed(1)}日</div>
          </div>
        ))}
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">変化点数</div>
          <div className="font-bold text-lg">{cp.changePoints.length}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Kalman LL</div>
          <div className="font-bold">{kalman.logLikelihood.toFixed(1)}</div>
        </div>
      </div>

      {/* HMM chart + transition matrix */}
      <div className="flex flex-col sm:flex-row gap-3 mb-3">
        <div className="flex-1">
          <div className="text-xs text-gray-500 mb-1">HMM 状態確率 (Baum-Welch推定, 3状態)</div>
          <div ref={hmmRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <canvas ref={transCanvasRef} className="rounded border border-gray-100" />
        </div>
      </div>

      {/* Change point */}
      <div className="text-xs text-gray-500 mb-1">変化点検出 (CUSUM + Binary Segmentation)</div>
      <div ref={cpRef} className="w-full rounded border border-gray-100 mb-3" />

      {/* Kalman filter */}
      <div className="text-xs text-gray-500 mb-1">カルマンフィルタ (Local Level Model) — 推定トレンド + 95%信頼区間</div>
      <div ref={kalmanRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="レジーム分析の読み方">
        <p><span className="font-medium">HMM (隠れマルコフモデル):</span> リターン系列を3つの隠れ状態(低ボラ/中ボラ/高ボラ)でモデル化。Baum-Welchアルゴリズム(EM法)で遷移確率と各状態のパラメータを同時推定します。グラフは各時点の状態確率を示し、遷移行列は状態間の移行しやすさを表します。</p>
        <p><span className="font-medium">変化点検出:</span> CUSUM(累積和)の最大偏差点をBinary Segmentationで再帰的に分割。BIC基準で有意な変化点のみを採用します。セグメント平均の段差がリターンの構造的変化を示します。</p>
        <p><span className="font-medium">カルマンフィルタ:</span> Local Levelモデル(ランダムウォーク+ノイズ)で株価の隠れたトレンドを推定。青い線が推定トレンド、点線が95%信頼区間です。状態空間モデルの最も基本的な形であり、量子力学的アプローチとの対応が深いです。</p>
      </AnalysisGuide>
    </div>
  );
}
