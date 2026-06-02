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
import {
  conditionalEntropy,
  entropyRate,
  excessEntropy,
  rollingConditionalEntropy,
} from "../../lib/entropy-extended";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
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

export default function ConditionalEntropyChart({ prices, seriesMode }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const lwChartRef = useRef<IChartApi | null>(null);
  const rateCanvasRef = useRef<HTMLCanvasElement>(null);

  const { values, times } = extractSeries(prices, seriesMode);
  const volumes = useMemo(() => {
    const vols = prices.map((p) => p.volume);
    return vols.slice(vols.length - values.length);
  }, [prices, seriesMode]);

  const condEnt = useMemo(() => conditionalEntropy(values, volumes), [prices, seriesMode]);
  const rates = useMemo(() => entropyRate(values, 8), [prices, seriesMode]);
  const excess = useMemo(() => excessEntropy(values, 8), [prices, seriesMode]);

  const rollingCond = useMemo(
    () => rollingConditionalEntropy(values, volumes, times, 60),
    [prices, seriesMode]
  );

  // ローリングH(X|Y)チャート
  useEffect(() => {
    if (!chartRef.current || rollingCond.length === 0) return;
    if (lwChartRef.current) lwChartRef.current.remove();

    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    lwChartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 1,
      title: "H(Price|Volume)",
    });
    series.setData(rollingCond.map((r) => ({ time: r.time as Time, value: r.value })));
    chart.timeScale().fitContent();

    const handleResize = () => {
      if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      lwChartRef.current = null;
    };
  }, [rollingCond]);

  // エントロピー率曲線
  useEffect(() => {
    const canvas = rateCanvasRef.current;
    if (!canvas || rates.length < 2) return;
    const result = initCanvas(canvas, 200);
    if (!result) return;
    const { ctx, width, height } = result;

    const margin = { top: 20, right: 15, bottom: 30, left: 50 };
    const pw = width - margin.left - margin.right;
    const ph = height - margin.top - margin.bottom;

    const maxBlock = rates[rates.length - 1].blockSize;
    const maxRate = Math.max(...rates.map((r) => r.rate));
    const minRate = Math.min(...rates.map((r) => r.rate));
    const rangeRate = maxRate - minRate || 1;

    const toX = (b: number) => margin.left + ((b - 1) / (maxBlock - 1)) * pw;
    const toY = (r: number) => margin.top + ph - ((r - minRate) / rangeRate) * ph;

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
    ctx.strokeStyle = "#0ea5e9";
    ctx.lineWidth = 2;
    ctx.beginPath();
    rates.forEach((r, i) => {
      const x = toX(r.blockSize);
      const y = toY(r.rate);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 点
    ctx.fillStyle = "#0ea5e9";
    for (const r of rates) {
      ctx.beginPath();
      ctx.arc(toX(r.blockSize), toY(r.rate), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // ラベル
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("ブロック長 k", width / 2, height - 4);
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const val = minRate + (rangeRate * (4 - i)) / 4;
      ctx.fillText(val.toFixed(2), margin.left - 4, margin.top + (ph * i) / 4 + 3);
    }
    ctx.fillStyle = "#333";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("エントロピー率 H(k)/k", margin.left + 5, margin.top - 5);
  }, [rates]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">条件付きエントロピー / エントロピー率</h3>

      <div className="grid grid-cols-3 gap-3 text-xs mb-3">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">H(Price|Volume)</div>
          <div className="font-mono font-medium text-sm text-purple-600">{condEnt.toFixed(3)}</div>
          <div className="text-gray-400">出来高を知った後の不確実性</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">過剰エントロピー</div>
          <div className="font-mono font-medium text-sm text-cyan-600">{excess.toFixed(3)}</div>
          <div className="text-gray-400">過去-未来の相互情報量</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">漸近率 h∞</div>
          <div className="font-mono font-medium text-sm">
            {rates.length > 0 ? rates[rates.length - 1].rate.toFixed(3) : "N/A"}
          </div>
          <div className="text-gray-400">最長ブロックでの率</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-gray-500 mb-1">ローリング条件付きエントロピー (60日窓)</div>
          <div ref={chartRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <div className="w-full rounded border border-gray-100 overflow-hidden">
            <canvas ref={rateCanvasRef} />
          </div>
        </div>
      </div>

      <AnalysisGuide title="条件付きエントロピーとエントロピー率の理論">
        <p className="font-medium text-gray-700">1. 条件付きエントロピー H(X|Y)</p>
        <p>H(X|Y) = H(X,Y) - H(Y)。Yを知った後にXに残る不確実性です。H(Price|Volume)が低いほど、出来高が価格変動の情報を多く含んでいます。</p>

        <p className="font-medium text-gray-700 mt-3">2. エントロピー率 h(k)</p>
        <p>ブロック長kで系列を分割し、H(k)/kを計算します。kが大きくなるほど、長期依存性を考慮したエントロピー率に収束します。収束が遅い = 長期的な構造がある。</p>

        <p className="font-medium text-gray-700 mt-3">3. 過剰エントロピー (Excess Entropy)</p>
        <p>過去と未来のブロック間の相互情報量の総和。系列全体に含まれる構造の「量」を一つの数値で表します。値が大きいほど、過去が未来をよく予測できます。</p>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>H(Price|Volume)が低下中: 出来高が価格の先行指標として機能 → 出来高ベースの戦略が有効</li>
          <li>過剰エントロピーが高い: 系列に長期記憶がある → トレンドフォロー有効</li>
          <li>エントロピー率がk=1で既に低い: 短期予測が容易</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
