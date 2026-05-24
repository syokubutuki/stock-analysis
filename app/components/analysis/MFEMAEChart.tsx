"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeMFEMAE, computeMFEMAEStats } from "../../lib/mfe-mae";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function MFEMAEChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const scatterRef = useRef<HTMLCanvasElement>(null);
  const apiRef = useRef<IChartApi | null>(null);

  const points = useMemo(() => computeMFEMAE(prices), [prices]);
  const stats = useMemo(() => computeMFEMAEStats(points), [points]);

  // MFE/MAE 時系列 (20日MA)
  useEffect(() => {
    if (!chartRef.current || points.length < 21) return;
    if (apiRef.current) apiRef.current.remove();

    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;

    const maWindow = 20;
    const maData: { time: string; mfe: number; mae: number }[] = [];
    for (let i = maWindow - 1; i < points.length; i++) {
      const slice = points.slice(i - maWindow + 1, i + 1);
      maData.push({
        time: points[i].time,
        mfe: slice.reduce((a, p) => a + p.mfe, 0) / maWindow,
        mae: slice.reduce((a, p) => a + p.mae, 0) / maWindow,
      });
    }

    const mfeSeries = chart.addSeries(LineSeries, {
      color: "#22c55e",
      lineWidth: 2,
      title: "MFE (20日MA)",
    });
    mfeSeries.setData(
      maData.map((d) => ({ time: d.time as Time, value: d.mfe * 100 }))
    );

    const maeSeries = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 2,
      title: "MAE (20日MA)",
    });
    maeSeries.setData(
      maData.map((d) => ({ time: d.time as Time, value: d.mae * 100 }))
    );

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (chartRef.current)
        chart.applyOptions({ width: chartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      apiRef.current = null;
    };
  }, [points]);

  // 散布図 (Canvas)
  useEffect(() => {
    const canvas = scatterRef.current;
    if (!canvas || points.length < 2) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const mfes = points.map((p) => p.mfe * 100);
    const maes = points.map((p) => p.mae * 100);
    const maxVal = Math.max(
      ...mfes.map(Math.abs),
      ...maes.map(Math.abs),
      0.1
    ) * 1.1;

    const margin = 40;
    const plotW = w - margin * 2;
    const plotH = h - margin * 2;
    const scaleX = (v: number) => margin + (v / maxVal) * plotW;
    const scaleY = (v: number) => margin + plotH - (v / maxVal) * plotH;

    // 軸
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin, margin);
    ctx.lineTo(margin, margin + plotH);
    ctx.lineTo(margin + plotW, margin + plotH);
    ctx.stroke();

    // 対角線
    ctx.strokeStyle = "#d1d5db";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(scaleX(0), scaleY(0));
    ctx.lineTo(scaleX(maxVal), scaleY(maxVal));
    ctx.stroke();
    ctx.setLineDash([]);

    // ラベル
    ctx.fillStyle = "#9ca3af";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("MAE (%)", margin + plotW / 2, h - 5);
    ctx.save();
    ctx.translate(12, margin + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("MFE (%)", 0, 0);
    ctx.restore();

    // 点
    for (let i = 0; i < points.length; i++) {
      const x = scaleX(maes[i]);
      const y = scaleY(mfes[i]);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = points[i].realized >= 0
        ? "rgba(34, 197, 94, 0.5)"
        : "rgba(239, 68, 68, 0.5)";
      ctx.fill();
    }

    // 軸の数値
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("0", margin - 4, margin + plotH + 3);
    ctx.fillText(`${maxVal.toFixed(1)}`, margin - 4, margin + 4);
    ctx.textAlign = "center";
    ctx.fillText(`${maxVal.toFixed(1)}`, margin + plotW, margin + plotH + 14);
  }, [points]);

  const pct = (v: number) => (v * 100).toFixed(3);
  const pct1 = (v: number) => (v * 100).toFixed(1);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">
        MFE/MAE分析 (最大順行/逆行幅)
      </h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-4">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均MFE</div>
          <div className="font-mono font-medium text-green-600">
            +{pct(stats.avgMFE)}%
          </div>
          <div className="text-gray-400">中央値: +{pct(stats.medianMFE)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均MAE</div>
          <div className="font-mono font-medium text-red-600">
            -{pct(stats.avgMAE)}%
          </div>
          <div className="text-gray-400">中央値: -{pct(stats.medianMAE)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">MFE/MAE比</div>
          <div className={`font-mono font-medium ${stats.riskReward >= 1 ? "text-green-600" : "text-red-600"}`}>
            {stats.riskReward.toFixed(2)}
          </div>
          <div className="text-gray-400">
            {stats.riskReward >= 1 ? "上方向優勢" : "下方向優勢"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">勝率 / MFE利用率</div>
          <div className="font-mono font-medium">
            {pct1(stats.winRate)}% / {pct1(stats.avgMFECapture)}%
          </div>
          <div className="text-gray-400">MFE↔MAE相関: {stats.correlation.toFixed(2)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="mb-2 text-xs text-gray-500 font-medium">
            <span className="text-green-500">MFE</span> /{" "}
            <span className="text-red-500">MAE</span> 20日移動平均 (%)
          </div>
          <div ref={chartRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <div className="mb-2 text-xs text-gray-500 font-medium">
            MFE vs MAE 散布図 (
            <span className="text-green-500">陽線</span> /{" "}
            <span className="text-red-500">陰線</span>)
          </div>
          <canvas
            ref={scatterRef}
            className="w-full rounded border border-gray-100"
            style={{ height: 200 }}
          />
        </div>
      </div>

      <AnalysisGuide title="MFE/MAE分析の読み方">
        <p>
          <span className="font-medium">MFE (Maximum Favorable Excursion):</span>{" "}
          始値から高値までの最大上昇幅 (high-open)/open。「始値で買った場合、日中最大でどこまで含み益が出たか」。
        </p>
        <p>
          <span className="font-medium">MAE (Maximum Adverse Excursion):</span>{" "}
          始値から安値までの最大下落幅 (open-low)/open。「始値で買った場合、日中最大でどこまで含み損が出たか」。
        </p>
        <p>
          <span className="font-medium">MFE/MAE比:</span>{" "}
          1より大きければ上方向への動きが大きい傾向。ストップロスと利確の水準設計に直結する指標。
        </p>
        <p>
          <span className="font-medium">MFE利用率:</span>{" "}
          陽線日における realized/MFE。100%なら高値引け。低い場合は日中に利益を吐き出している。
        </p>
        <p>
          <span className="font-medium">散布図:</span>{" "}
          対角線より上の点はMFE{">"}MAE（上方向への動きが大きい日）。対角線上に集まる場合は上下対称な動き。
        </p>
      </AnalysisGuide>
    </div>
  );
}
