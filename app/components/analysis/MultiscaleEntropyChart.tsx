"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { logReturns } from "../../lib/transforms";
import { multiscaleEntropy, fisherInformation } from "../../lib/multiscale-entropy";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function MultiscaleEntropyChart({ prices }: Props) {
  const mseCanvasRef = useRef<HTMLCanvasElement>(null);
  const fisherRef = useRef<HTMLDivElement>(null);
  const fisherChartRef = useRef<IChartApi | null>(null);

  const closes = prices.map((p) => p.close);
  const times = prices.map((p) => p.time);
  const lr = logReturns(closes);
  const lrTimes = times.slice(1);

  const mse = useMemo(() => multiscaleEntropy(lr, 20, 2), [prices]);
  const fisher = useMemo(() => fisherInformation(lr, lrTimes, 60, 20), [prices]);

  // MSE曲線
  useEffect(() => {
    const canvas = mseCanvasRef.current;
    if (!canvas || mse.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 200;
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

    const margin = { top: 15, right: 15, bottom: 25, left: 45 };
    const pw = width - margin.left - margin.right;
    const ph = height - margin.top - margin.bottom;

    const maxScale = mse[mse.length - 1].scale;
    const validMse = mse.filter((m) => isFinite(m.entropy) && m.entropy > 0);
    if (validMse.length < 2) return;

    const maxE = Math.max(...validMse.map((m) => m.entropy));
    const minE = Math.min(...validMse.map((m) => m.entropy));
    const rangeE = maxE - minE || 1;

    const toX = (s: number) => margin.left + ((s - 1) / (maxScale - 1)) * pw;
    const toY = (e: number) => margin.top + ph - ((e - minE) / rangeE) * ph;

    // グリッド
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = margin.top + (ph * i) / 4;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(width - margin.right, y);
      ctx.stroke();
    }

    // 線
    ctx.strokeStyle = "#8b5cf6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (const m of validMse) {
      const x = toX(m.scale);
      const y = toY(m.entropy);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 点
    ctx.fillStyle = "#8b5cf6";
    for (const m of validMse) {
      ctx.beginPath();
      ctx.arc(toX(m.scale), toY(m.entropy), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.fillText("スケール", width / 2 - 15, height - 4);
    ctx.save();
    ctx.translate(10, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("SampEn", -15, 0);
    ctx.restore();
    ctx.fillStyle = "#333";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText("Multiscale Entropy", margin.left + 5, margin.top - 2);
  }, [mse]);

  // Fisher Information時系列
  useEffect(() => {
    if (!fisherRef.current || fisher.length === 0) return;
    if (fisherChartRef.current) fisherChartRef.current.remove();

    const chart = createChart(fisherRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: fisherRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    fisherChartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#dc2626",
      lineWidth: 1,
      title: "Fisher Information",
    });
    series.setData(
      fisher.map((f) => ({ time: f.time as Time, value: f.value }))
    );
    chart.timeScale().fitContent();

    const handleResize = () => {
      if (fisherRef.current)
        chart.applyOptions({ width: fisherRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      fisherChartRef.current = null;
    };
  }, [fisher]);

  // MSEの傾向分析
  const mseSlope = useMemo(() => {
    const valid = mse.filter((m) => isFinite(m.entropy) && m.entropy > 0);
    if (valid.length < 3) return 0;
    const n = valid.length;
    const xs = valid.map((m) => m.scale);
    const ys = valid.map((m) => m.entropy);
    const sumX = xs.reduce((a, b) => a + b, 0);
    const sumY = ys.reduce((a, b) => a + b, 0);
    const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
    const sumX2 = xs.reduce((a, x) => a + x * x, 0);
    return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  }, [mse]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">マルチスケール解析</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="w-full rounded border border-gray-100 overflow-hidden">
            <canvas ref={mseCanvasRef} />
          </div>
          <div className="mt-2 text-xs p-2 bg-gray-50 rounded">
            <span className="text-gray-500">MSE傾き: </span>
            <span className={`font-mono font-medium ${mseSlope > 0 ? "text-orange-600" : "text-green-600"}`}>
              {mseSlope.toFixed(4)}
            </span>
            <span className="text-gray-500 ml-2">
              {mseSlope < -0.01 ? "→ 単調減少(ランダム的)" : mseSlope > 0.01 ? "→ 増加傾向(隠れた構造)" : "→ 横ばい(中間的)"}
            </span>
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">Fisher Information (60日窓) — スパイク = レジーム変化</div>
          <div ref={fisherRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      <AnalysisGuide title="マルチスケール解析の読み方">
        <p><span className="font-medium">Multiscale Entropy (MSE):</span> 時系列を様々なスケール(粗視化レベル)でSample Entropyを計算し、スケールに対する複雑性の変化を見ます。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">スケールとともに単調減少:</span> ランダムノイズ的。大きなスケールではパターンが消失 = 構造は短期ノイズだけ。</li>
          <li><span className="font-medium">スケールとともに増加または一定:</span> 大きなスケールにも構造が存在。長期的なパターンやフラクタル的な性質を示唆。トレード可能な構造がある可能性。</li>
          <li><span className="font-medium">特定スケールでピーク:</span> そのスケールに対応する時間幅で最も複雑な(=豊かな)構造がある。</li>
        </ul>
        <p><span className="font-medium">Fisher Information:</span> 確率分布の変化の鋭敏さを測る指標です。分布が急速に変化しているほど高い値を取ります。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">スパイク(急上昇):</span> リターンの統計的性質が急変 = レジーム変化(相場環境の転換)。ボラティリティの急変、トレンド転換、ショックなど。</li>
          <li><span className="font-medium">安定して低い:</span> 市場が安定した統計的性質を維持 = 現在のモデルや戦略が引き続き有効な可能性。</li>
        </ul>
        <p><span className="font-medium">トレードへの活用:</span> MSEが大きなスケールで高い値を保つ銘柄は、中長期の構造が豊かであり、トレンドフォロー等の戦略が機能しやすい可能性があります。Fisher Informationのスパイクは、既存ポジションのリスクを再評価すべきシグナルです。</p>
      </AnalysisGuide>
    </div>
  );
}
