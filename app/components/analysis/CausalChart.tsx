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
import { logReturns } from "../../lib/transforms";
import { mutualInformation, timeLaggedMI, transferEntropy, grangerTest } from "../../lib/causal";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function CausalChart({ prices }: Props) {
  const miRef = useRef<HTMLDivElement>(null);
  const miChartRef = useRef<IChartApi | null>(null);
  const flowCanvasRef = useRef<HTMLCanvasElement>(null);

  const closes = prices.map((p) => p.close);
  const volumes = prices.map((p) => p.volume);
  const lr = logReturns(closes);
  const volReturns = logReturns(volumes.map((v) => v || 1));

  const autoMI = useMemo(() => timeLaggedMI(lr, 30), [prices]);
  const te = useMemo(() => transferEntropy(volReturns, lr, 1, 8), [prices]);
  const granger = useMemo(() => grangerTest(volReturns, lr, 5), [prices]);
  const miPriceVol = useMemo(() => mutualInformation(lr, volReturns.slice(0, lr.length)), [prices]);

  // Auto-MI chart (nonlinear ACF)
  useEffect(() => {
    if (!miRef.current) return;
    if (miChartRef.current) miChartRef.current.remove();

    const chart = createChart(miRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: miRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    miChartRef.current = chart;

    const series = chart.addSeries(HistogramSeries, {
      color: "#3b82f6",
      title: "自己MI (非線形ACF)",
    });
    series.setData(
      autoMI.map((v, i) => ({
        time: `2000-01-${String(i + 1).padStart(2, "0")}` as Time,
        value: v,
      }))
    );

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (miRef.current) chart.applyOptions({ width: miRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); miChartRef.current = null; };
  }, [prices, autoMI]);

  // Information flow diagram (canvas)
  useEffect(() => {
    const canvas = flowCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = 400;
    const height = 200;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    // Two nodes: Price, Volume
    const cx1 = 100, cy1 = 100; // Volume
    const cx2 = 300, cy2 = 100; // Price
    const nodeR = 35;

    // Nodes
    ctx.fillStyle = "#dbeafe";
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx1, cy1, nodeR, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#fef3c7";
    ctx.strokeStyle = "#eab308";
    ctx.beginPath(); ctx.arc(cx2, cy2, nodeR, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();

    ctx.fillStyle = "#374151";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("出来高", cx1, cy1 + 4);
    ctx.fillText("価格", cx2, cy2 + 4);

    // Arrows
    const arrowY1 = cy1 - 15;
    const arrowY2 = cy1 + 15;
    const maxTE = Math.max(te.te_xy, te.te_yx, 0.001);

    // Volume → Price (top arrow)
    const w1 = Math.max(1, (te.te_xy / maxTE) * 5);
    ctx.strokeStyle = te.significance.te_xy_p < 0.05 ? "#22c55e" : "#d1d5db";
    ctx.lineWidth = w1;
    ctx.beginPath();
    ctx.moveTo(cx1 + nodeR + 5, arrowY1);
    ctx.lineTo(cx2 - nodeR - 15, arrowY1);
    ctx.stroke();
    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(cx2 - nodeR - 5, arrowY1);
    ctx.lineTo(cx2 - nodeR - 15, arrowY1 - 5);
    ctx.lineTo(cx2 - nodeR - 15, arrowY1 + 5);
    ctx.fill();

    // Price → Volume (bottom arrow)
    const w2 = Math.max(1, (te.te_yx / maxTE) * 5);
    ctx.strokeStyle = te.significance.te_yx_p < 0.05 ? "#22c55e" : "#d1d5db";
    ctx.lineWidth = w2;
    ctx.beginPath();
    ctx.moveTo(cx2 - nodeR - 5, arrowY2);
    ctx.lineTo(cx1 + nodeR + 15, arrowY2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx1 + nodeR + 5, arrowY2);
    ctx.lineTo(cx1 + nodeR + 15, arrowY2 - 5);
    ctx.lineTo(cx1 + nodeR + 15, arrowY2 + 5);
    ctx.fill();

    // Labels
    ctx.fillStyle = "#374151";
    ctx.font = "10px sans-serif";
    ctx.fillText(`TE: ${te.te_xy.toFixed(4)} (p=${te.significance.te_xy_p.toFixed(3)})`, 200, arrowY1 - 8);
    ctx.fillText(`TE: ${te.te_yx.toFixed(4)} (p=${te.significance.te_yx_p.toFixed(3)})`, 200, arrowY2 + 16);
    ctx.fillText(`Net: ${te.netFlow > 0 ? "出来高→価格" : "価格→出来高"} (${Math.abs(te.netFlow).toFixed(4)})`, 200, 175);

    // Granger result
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText(`Granger: ${granger.direction} (F=${granger.fStatistic.toFixed(2)}, p=${granger.pValue.toFixed(3)}, lag=${granger.optimalLag})`, 200, 195);
  }, [te, granger]);

  // Find optimal tau from auto-MI
  const optimalTau = useMemo(() => {
    for (let i = 1; i < autoMI.length - 1; i++) {
      if (autoMI[i] < autoMI[i - 1] && autoMI[i] < autoMI[i + 1]) return i;
    }
    return 1;
  }, [autoMI]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">因果・情報伝達解析</h3>
      <p className="text-xs text-gray-500 mb-3">相互情報量 / Transfer Entropy / Granger因果性</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">MI (価格↔出来高)</div>
          <div className="font-bold">{miPriceVol.toFixed(4)} bits</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">最適埋め込み遅延 τ</div>
          <div className="font-bold">{optimalTau} 日</div>
          <div className="text-gray-400">auto-MIの最初の極小</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Granger方向</div>
          <div className="font-bold">{granger.direction}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">TE net flow</div>
          <div className="font-bold">{te.netFlow > 0 ? "出来高→価格" : "価格→出来高"}</div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <div className="text-xs text-gray-500 mb-1">自己相互情報量 (非線形ACF) — lag(日)</div>
          <div ref={miRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">情報フローダイアグラム</div>
          <canvas ref={flowCanvasRef} className="rounded border border-gray-100" />
        </div>
      </div>

      <AnalysisGuide title="因果・情報伝達の読み方">
        <p><span className="font-medium">相互情報量 (MI):</span> 2変数間の非線形依存性の測定。ピアソン相関が線形関係のみを捉えるのに対し、MIはあらゆる依存関係を捕捉します。自己MIのラグプロット(非線形ACF)で最初の極小値が非線形力学の最適埋め込み遅延τです。</p>
        <p><span className="font-medium">Transfer Entropy:</span> X→Yの方向性のある情報の流れを測定。Granger因果性の非線形一般化です。出来高→価格のTEが大きければ「出来高が価格変動を予測する情報を持っている」ことを意味します。サロゲートテスト(シャッフル検定)でp値を算出しています。</p>
        <p><span className="font-medium">Granger因果性:</span> 線形VAR(p)モデルに基づく古典的因果検定。BICでラグ次数を選択し、F検定で有意性を判定します。Transfer Entropyと方向が一致するかで線形/非線形の情報伝達を区別できます。</p>
      </AnalysisGuide>
    </div>
  );
}
