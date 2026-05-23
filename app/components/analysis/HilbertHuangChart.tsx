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
import { computeHHS, computeSTFT, rollingSpectralEntropy } from "../../lib/hilbert-huang-spectrum";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function HilbertHuangChart({ prices }: Props) {
  const hhsCanvasRef = useRef<HTMLCanvasElement>(null);
  const stftCanvasRef = useRef<HTMLCanvasElement>(null);
  const entropyRef = useRef<HTMLDivElement>(null);
  const entropyChartRef = useRef<IChartApi | null>(null);

  const closes = prices.map((p) => p.close);
  const times = prices.map((p) => p.time);
  const lr = logReturns(closes);
  const lrTimes = times.slice(1);

  const hhs = useMemo(() => computeHHS(lr, 35), [prices]);
  const stft = useMemo(() => computeSTFT(lr, 64, 4), [prices]);
  const specEntropy = useMemo(
    () => rollingSpectralEntropy(lr, Math.min(64, Math.floor(lr.length / 3))),
    [prices]
  );

  // HHS heatmap
  useEffect(() => {
    const canvas = hhsCanvasRef.current;
    if (!canvas || hhs.maxEnergy === 0) return;
    drawHeatmap(canvas, hhs.energy, hhs.periodAxis, hhs.timeAxis.length, "HHS");
  }, [hhs]);

  // STFT heatmap
  useEffect(() => {
    const canvas = stftCanvasRef.current;
    if (!canvas || stft.maxMag === 0) return;
    const mag2d = stft.magnitude;
    const maxVal = stft.maxMag;
    drawHeatmap(canvas, mag2d, stft.periodAxis, stft.timeIndices.length, "STFT", maxVal);
  }, [stft]);

  // Spectral entropy chart
  useEffect(() => {
    if (!entropyRef.current || specEntropy.entropy.length === 0) return;
    if (entropyChartRef.current) entropyChartRef.current.remove();

    const chart = createChart(entropyRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: entropyRef.current.clientWidth,
      height: 120,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    entropyChartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 2,
      title: "スペクトルエントロピー",
    });

    const data = specEntropy.indices
      .filter((idx) => idx < lrTimes.length)
      .map((idx, i) => ({
        time: lrTimes[idx] as Time,
        value: specEntropy.entropy[i],
      }));
    series.setData(data);
    chart.timeScale().fitContent();

    const handleResize = () => {
      if (entropyRef.current) chart.applyOptions({ width: entropyRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      entropyChartRef.current = null;
    };
  }, [prices, specEntropy]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">Hilbert-Huang Spectrum / STFT / スペクトルエントロピー</h3>
      <p className="text-xs text-gray-500 mb-3">
        適応的時間-周波数解析（HHS）と固定窓スペクトログラム（STFT）の比較 + 周波数複雑性
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <div>
          <div className="text-xs text-gray-500 mb-1">Hilbert-Huang Spectrum（適応的）</div>
          <canvas ref={hhsCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">STFT Spectrogram（固定窓=64日）</div>
          <canvas ref={stftCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-1">ローリング・スペクトルエントロピー (0=単一周波数, 1=白色雑音)</div>
      <div ref={entropyRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="HHS・STFT・スペクトルエントロピーの読み方">
        <p><span className="font-medium">Hilbert-Huang Spectrum (HHS):</span> EMDで分解した各IMFにHilbert変換を適用し、瞬時周波数と振幅を時間-周波数平面にマッピングした適応的スペクトル。CWTと異なり基底関数を仮定しないため、非線形・非定常な構造を忠実に捉えます。</p>
        <p><span className="font-medium">STFT:</span> 固定窓(64日)でFFTをスライドさせた古典的スペクトログラム。HHSとの比較で適応的分解の効果を確認できます。</p>
        <p><span className="font-medium">スペクトルエントロピー:</span> パワースペクトルを確率分布とみなしたShannon Entropy。0に近いほど特定周波数に集中(規則的振動)、1に近いほど周波数が分散(白色雑音的)。急落や急騰時にエントロピーが低下する傾向があります。</p>
      </AnalysisGuide>
    </div>
  );
}

function drawHeatmap(
  canvas: HTMLCanvasElement,
  data: number[][],
  periodAxis: number[],
  nTime: number,
  label: string,
  externalMax?: number
) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.parentElement?.clientWidth || 400;
  const height = 200;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const margin = { left: 40, right: 10, top: 10, bottom: 20 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const nPeriods = data.length;
  let maxVal = externalMax || 0;
  if (!externalMax) {
    for (let p = 0; p < nPeriods; p++) {
      for (let t = 0; t < data[p].length; t++) {
        if (data[p][t] > maxVal) maxVal = data[p][t];
      }
    }
  }
  if (maxVal === 0) maxVal = 1;

  const cellW = plotW / nTime;
  const cellH = plotH / nPeriods;

  for (let p = 0; p < nPeriods; p++) {
    for (let t = 0; t < Math.min(data[p].length, nTime); t++) {
      const intensity = Math.min(data[p][t] / maxVal, 1);
      const r = Math.round(intensity * 255);
      const g = Math.round(intensity * 80);
      const b = Math.round((1 - intensity) * 200 + intensity * 50);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(
        margin.left + t * cellW,
        margin.top + (nPeriods - 1 - p) * cellH,
        Math.ceil(cellW) + 1,
        Math.ceil(cellH) + 1
      );
    }
  }

  // Period axis labels
  ctx.fillStyle = "#6b7280";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i < nPeriods; i += Math.floor(nPeriods / 5)) {
    const y = margin.top + (nPeriods - 1 - i) * cellH + cellH / 2;
    ctx.fillText(`${periodAxis[i].toFixed(0)}d`, margin.left - 3, y + 3);
  }

  ctx.textAlign = "center";
  ctx.fillText(label, margin.left + plotW / 2, height - 2);
}
