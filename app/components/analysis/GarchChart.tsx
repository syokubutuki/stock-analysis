"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { fitGarch, analyzeLeverage, detectJumps } from "../../lib/garch";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function GarchChart({ prices, seriesMode }: Props) {
  const volRef = useRef<HTMLDivElement>(null);
  const leverageCanvasRef = useRef<HTMLCanvasElement>(null);
  const jumpRef = useRef<HTMLDivElement>(null);
  const volChartRef = useRef<IChartApi | null>(null);
  const jumpChartRef = useRef<IChartApi | null>(null);

  const { values: lr, times: lrTimes } = extractSeries(prices, seriesMode);

  const garch = useMemo(() => fitGarch(lr), [prices, seriesMode]);
  const leverage = useMemo(() => analyzeLeverage(lr), [prices, seriesMode]);
  const jumps = useMemo(() => detectJumps(lr), [prices, seriesMode]);

  // GARCH conditional volatility chart
  useEffect(() => {
    if (!volRef.current) return;
    if (volChartRef.current) volChartRef.current.remove();

    const chart = createChart(volRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: volRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    volChartRef.current = chart;

    const retSeries = chart.addSeries(HistogramSeries, {
      color: "#94a3b8",
      title: "log return",
    });
    retSeries.setData(
      lr.map((v, i) => ({
        time: lrTimes[i] as Time,
        value: v,
        color: v >= 0 ? "#22c55e40" : "#ef444440",
      }))
    );

    const volSeries = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 2,
      title: "GARCH σ(t)",
    });
    volSeries.setData(
      garch.conditionalVol.map((v, i) => ({ time: lrTimes[i] as Time, value: v }))
    );

    const negVolSeries = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 2,
      title: "-σ(t)",
    });
    negVolSeries.setData(
      garch.conditionalVol.map((v, i) => ({ time: lrTimes[i] as Time, value: -v }))
    );

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (volRef.current) chart.applyOptions({ width: volRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); volChartRef.current = null; };
  }, [prices, garch]);

  // News Impact Curve (leverage effect)
  useEffect(() => {
    const canvas = leverageCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = 300;
    const height = 200;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { left: 45, right: 10, top: 15, bottom: 25 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const curve = leverage.newsImpactCurve;
    if (curve.length === 0) return;

    const xMin = Math.min(...curve.map((c) => c.ret));
    const xMax = Math.max(...curve.map((c) => c.ret));
    const yMax = Math.max(...curve.map((c) => c.vol));
    const xRange = xMax - xMin || 1;
    const yRange = yMax || 1;

    // Axes
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top);
    ctx.lineTo(margin.left, margin.top + plotH);
    ctx.lineTo(margin.left + plotW, margin.top + plotH);
    ctx.stroke();

    // Zero line
    const zeroX = margin.left + (-xMin / xRange) * plotW;
    ctx.strokeStyle = "#e5e7eb";
    ctx.beginPath();
    ctx.moveTo(zeroX, margin.top);
    ctx.lineTo(zeroX, margin.top + plotH);
    ctx.stroke();

    // Curve
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    curve.forEach((c, i) => {
      const x = margin.left + ((c.ret - xMin) / xRange) * plotW;
      const y = margin.top + plotH - (c.vol / yRange) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Labels
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("r(t) →", margin.left + plotW / 2, height - 3);
    ctx.save();
    ctx.translate(10, margin.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("E[|r(t+1)|]", 0, 0);
    ctx.restore();
    ctx.fillText("News Impact Curve", margin.left + plotW / 2, 10);
  }, [leverage]);

  // Jump detection chart
  useEffect(() => {
    if (!jumpRef.current) return;
    if (jumpChartRef.current) jumpChartRef.current.remove();

    const chart = createChart(jumpRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: jumpRef.current.clientWidth,
      height: 150,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    jumpChartRef.current = chart;

    const retSeries = chart.addSeries(HistogramSeries, {
      title: "リターン (ジャンプ検出)",
    });

    const jumpSet = new Set(jumps.jumpDays);
    retSeries.setData(
      lr.map((v, i) => ({
        time: lrTimes[i] as Time,
        value: v,
        color: jumpSet.has(i) ? (v >= 0 ? "#22c55e" : "#ef4444") : "#d1d5db",
      }))
    );

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (jumpRef.current) chart.applyOptions({ width: jumpRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); jumpChartRef.current = null; };
  }, [prices, jumps]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">GARCH / レバレッジ効果 / ジャンプ検出</h3>
      <p className="text-xs text-gray-500 mb-3">条件付きボラティリティの推定とリスク構造の分解</p>

      {/* GARCH params */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">α (ARCH)</div>
          <div className="font-bold">{garch.alpha.toFixed(4)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">β (GARCH)</div>
          <div className="font-bold">{garch.beta.toFixed(4)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">持続性 α+β</div>
          <div className="font-bold">{garch.persistence.toFixed(4)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">半減期</div>
          <div className="font-bold">{garch.halfLife < 1000 ? `${garch.halfLife.toFixed(1)}日` : "∞"}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">非対称性</div>
          <div className="font-bold">{leverage.asymmetryCoeff.toFixed(3)}</div>
          <div className="text-gray-400">{leverage.asymmetryCoeff > 1.1 ? "レバレッジ効果あり" : "対称的"}</div>
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-1">GARCH(1,1) 条件付きボラティリティ σ(t)</div>
      <div ref={volRef} className="w-full rounded border border-gray-100" />

      <div className="mt-3 flex flex-col sm:flex-row gap-3 items-start">
        <div>
          <canvas ref={leverageCanvasRef} className="rounded border border-gray-100" />
          <div className="text-xs text-gray-400 mt-1">
            非対称性: 負リターン後vol {(leverage.negativeVolMean * 100).toFixed(3)}%
            / 正リターン後vol {(leverage.positiveVolMean * 100).toFixed(3)}%
          </div>
        </div>
        <div className="flex-1">
          <div className="text-xs text-gray-500 mb-1">
            ジャンプ検出 (BNS test, 閾値=3σ) — 検出数: {jumps.jumpDays.length}件,
            ジャンプ比率: {(jumps.jumpRatio * 100).toFixed(1)}%
          </div>
          <div ref={jumpRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      <AnalysisGuide title="GARCH・レバレッジ・ジャンプの読み方">
        <p><span className="font-medium">GARCH(1,1):</span> σ²(t) = ω + α·r²(t-1) + β·σ²(t-1)。EWMAの一般化で、α,βをデータから最尤推定します。α+βが1に近いほどボラティリティショックが持続します(IGARCH)。半減期はショックが半分に減衰するまでの日数です。</p>
        <p><span className="font-medium">レバレッジ効果:</span> 株価下落後にボラティリティが上昇しやすい非対称性。News Impact Curveは「今日のリターンが明日のボラに与える影響」を可視化。左側(負リターン)が右側より高ければレバレッジ効果あり。</p>
        <p><span className="font-medium">ジャンプ検出:</span> Bipower Variationで連続成分のボラティリティを推定し、それを大きく超えるリターンを「ジャンプ」として検出します。ジャンプ比率は全分散に占めるジャンプ成分の割合です。</p>
      </AnalysisGuide>
    </div>
  );
}
