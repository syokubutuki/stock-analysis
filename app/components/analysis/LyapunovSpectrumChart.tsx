"use client";

import { useMemo, useRef, useEffect, useState } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { autoMutualInformation } from "../../lib/attractor-investment";
import {
  computeLyapunovSpectrum,
  rollingKaplanYorke,
  lyapunovVectorDecomposition,
  type LyapunovSpectrumResult,
  type RollingKYResult,
  type LyapunovVectorResult,
} from "../../lib/lyapunov-spectrum";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

const SPECTRUM_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280", "#14b8a6",
];

export default function LyapunovSpectrumChart({ prices, seriesMode }: Props) {
  const spectrumRef = useRef<HTMLDivElement>(null);
  const kyRef = useRef<HTMLDivElement>(null);
  const vectorRef = useRef<HTMLDivElement>(null);
  const spectrumChartRef = useRef<IChartApi | null>(null);
  const kyChartRef = useRef<IChartApi | null>(null);
  const vectorChartRef = useRef<IChartApi | null>(null);
  const [dim, setDim] = useState(5);
  const [windowSize, setWindowSize] = useState(150);

  const { values, times } = extractSeries(prices, seriesMode);

  const tau = useMemo(
    () => autoMutualInformation(values, 20).optimalTau,
    [values]
  );

  // Full spectrum (static)
  const spectrum = useMemo(
    () => computeLyapunovSpectrum(values, tau, dim),
    [values, tau, dim]
  );

  // Rolling KY dimension
  const rollingKY = useMemo(
    () => rollingKaplanYorke(values, times, tau, dim, windowSize, 5),
    [values, times, tau, dim, windowSize]
  );

  // Lyapunov vector decomposition
  const vectorResult = useMemo(
    () => lyapunovVectorDecomposition(values, times, tau, dim, windowSize, 5),
    [values, times, tau, dim, windowSize]
  );

  // ---- Spectrum bar chart (static) ----
  const spectrumCanvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = spectrumCanvasRef.current;
    if (!canvas || spectrum.exponents.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);

    const exps = spectrum.exponents;
    const maxAbs = Math.max(...exps.map(Math.abs), 0.01);
    const barW = Math.min(40, (w - 60) / exps.length - 4);
    const startX = 50;
    const midY = h / 2;
    const scale = (midY - 20) / maxAbs;

    // Grid
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(startX - 5, midY);
    ctx.lineTo(w - 10, midY);
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = "#6b7280";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    const steps = 4;
    for (let i = -steps; i <= steps; i++) {
      const val = (maxAbs / steps) * i;
      const y = midY - val * scale;
      if (y > 5 && y < h - 5) {
        ctx.fillText(val.toFixed(3), startX - 8, y + 4);
        ctx.strokeStyle = "#f3f4f6";
        ctx.beginPath();
        ctx.moveTo(startX - 3, y);
        ctx.lineTo(w - 10, y);
        ctx.stroke();
      }
    }

    // Zero line
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(startX, midY);
    ctx.lineTo(w - 10, midY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Bars
    for (let i = 0; i < exps.length; i++) {
      const x = startX + i * (barW + 4) + 2;
      const barH = Math.abs(exps[i]) * scale;
      const y = exps[i] >= 0 ? midY - barH : midY;
      const color = exps[i] > 0.001 ? "#ef4444" : exps[i] < -0.001 ? "#3b82f6" : "#9ca3af";

      ctx.fillStyle = color;
      ctx.fillRect(x, y, barW, barH);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, barW, barH);

      // Label
      ctx.fillStyle = "#374151";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`λ${i + 1}`, x + barW / 2, h - 4);
      ctx.fillStyle = "#6b7280";
      ctx.fillText(exps[i].toFixed(4), x + barW / 2, exps[i] >= 0 ? y - 4 : y + barH + 12);
    }
  }, [spectrum]);

  // ---- Rolling KY dimension chart ----
  useEffect(() => {
    if (!kyRef.current || rollingKY.times.length === 0) return;
    if (kyChartRef.current) kyChartRef.current.remove();

    const chart = createChart(kyRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: kyRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    kyChartRef.current = chart;

    // KY dimension
    const kySeries = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 2,
      title: "D_KY",
    });
    kySeries.setData(rollingKY.times.map((t, i) => ({
      time: t as Time,
      value: rollingKY.kyDimension[i],
    })));

    // Max Lyapunov on secondary scale
    const maxLSeries = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 1,
      title: "λ_max",
      priceScaleId: "left",
    });
    chart.priceScale("left").applyOptions({ visible: true });
    maxLSeries.setData(rollingKY.times.map((t, i) => ({
      time: t as Time,
      value: rollingKY.maxLyapunov[i],
    })));

    // Zero line for max Lyapunov
    const zeroSeries = chart.addSeries(LineSeries, {
      color: "#d1d5db",
      lineWidth: 1,
      lineStyle: 2,
      title: "",
      priceScaleId: "left",
    });
    zeroSeries.setData(rollingKY.times.map(t => ({
      time: t as Time,
      value: 0,
    })));

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (kyRef.current) chart.applyOptions({ width: kyRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); kyChartRef.current = null; };
  }, [rollingKY]);

  // ---- Lyapunov vector decomposition (stacked area via canvas) ----
  const vectorCanvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = vectorCanvasRef.current;
    if (!canvas || vectorResult.times.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);

    const nT = vectorResult.contributions.length;
    const nD = dim;
    const marginL = 40;
    const marginR = 80;
    const marginT = 10;
    const marginB = 25;
    const plotW = w - marginL - marginR;
    const plotH = h - marginT - marginB;

    // Stacked area chart
    for (let d = nD - 1; d >= 0; d--) {
      ctx.beginPath();
      const color = SPECTRUM_COLORS[d % SPECTRUM_COLORS.length];

      for (let t = 0; t < nT; t++) {
        const x = marginL + (t / (nT - 1 || 1)) * plotW;
        let ySum = 0;
        for (let dd = 0; dd <= d; dd++) {
          ySum += vectorResult.contributions[t][dd] || 0;
        }
        const y = marginT + plotH * (1 - ySum);
        if (t === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      // Close path to bottom of stack
      for (let t = nT - 1; t >= 0; t--) {
        const x = marginL + (t / (nT - 1 || 1)) * plotW;
        let ySum = 0;
        for (let dd = 0; dd < d; dd++) {
          ySum += vectorResult.contributions[t][dd] || 0;
        }
        const y = marginT + plotH * (1 - ySum);
        ctx.lineTo(x, y);
      }

      ctx.closePath();
      ctx.fillStyle = color + "80";
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    // Legend
    ctx.font = "10px sans-serif";
    for (let d = 0; d < nD; d++) {
      const y = marginT + 14 * d + 10;
      ctx.fillStyle = SPECTRUM_COLORS[d % SPECTRUM_COLORS.length];
      ctx.fillRect(w - marginR + 8, y - 8, 10, 10);
      ctx.fillStyle = "#374151";
      ctx.textAlign = "left";
      ctx.fillText(
        `t-${d * tau} (${(vectorResult.instabilityProfile[d] * 100).toFixed(1)}%)`,
        w - marginR + 22,
        y
      );
    }

    // Time axis labels
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    const labelCount = Math.min(6, nT);
    for (let i = 0; i < labelCount; i++) {
      const tIdx = Math.floor((i / (labelCount - 1 || 1)) * (nT - 1));
      const x = marginL + (tIdx / (nT - 1 || 1)) * plotW;
      const label = vectorResult.times[tIdx];
      if (label) {
        ctx.fillText(label.slice(5), x, h - 4);
      }
    }

    // Y-axis labels
    ctx.textAlign = "right";
    for (let p = 0; p <= 4; p++) {
      const val = p * 25;
      const y = marginT + plotH * (1 - val / 100);
      ctx.fillText(`${val}%`, marginL - 4, y + 3);
    }
  }, [vectorResult, dim, tau]);

  // Stats
  const recentKY = rollingKY.kyDimension.length > 0
    ? rollingKY.kyDimension[rollingKY.kyDimension.length - 1] : 0;
  const avgKY = rollingKY.kyDimension.length > 0
    ? rollingKY.kyDimension.reduce((a, b) => a + b, 0) / rollingKY.kyDimension.length : 0;
  const positiveCount = spectrum.exponents.filter(e => e > 0.001).length;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        リアプノフスペクトル / カプラン-ヨーク次元 / ベクトル分解
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        全リアプノフ指数の同時計算・アトラクタ次元の時間変化・不安定方向の要因分解
      </p>

      {/* Controls */}
      <div className="flex gap-4 mb-3 text-xs flex-wrap">
        <label className="flex items-center gap-2">
          <span className="text-gray-500">埋め込み次元:</span>
          <select
            value={dim}
            onChange={e => setDim(Number(e.target.value))}
            className="border border-gray-300 rounded px-2 py-1"
          >
            {[3, 4, 5, 6, 7, 8].map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-gray-500">ローリング窓幅:</span>
          <input
            type="range" min={80} max={300} step={10} value={windowSize}
            onChange={e => setWindowSize(Number(e.target.value))}
            className="w-24 accent-purple-600"
          />
          <span className="text-gray-700 font-medium w-12">{windowSize}日</span>
        </label>
        <span className="text-gray-400">τ = {tau} (AMI自動選択)</span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">最大 λ</div>
          <div className={`font-bold ${spectrum.exponents[0] > 0 ? "text-red-600" : "text-green-600"}`}>
            {spectrum.exponents[0]?.toFixed(4) ?? "N/A"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">正の λ 数</div>
          <div className="font-bold">{positiveCount} / {dim}</div>
        </div>
        <div className="p-2 bg-purple-50 rounded">
          <div className="text-purple-600">KY次元 (現在)</div>
          <div className="font-bold">{recentKY.toFixed(2)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">KY次元 (平均)</div>
          <div className="font-bold">{avgKY.toFixed(2)}</div>
        </div>
        <div className="p-2 bg-orange-50 rounded">
          <div className="text-orange-600">KS エントロピー</div>
          <div className="font-bold">{spectrum.kolmogorovSinaiEntropy.toFixed(4)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">体積収縮率</div>
          <div className={`font-bold ${spectrum.attractorVolume < 0 ? "text-blue-600" : "text-red-600"}`}>
            {spectrum.attractorVolume.toFixed(4)}
          </div>
        </div>
      </div>

      {/* Charts */}
      <div className="space-y-4 mb-3">
        {/* 1. Lyapunov Spectrum (bar chart) */}
        <div>
          <div className="text-xs text-gray-500 mb-1">
            リアプノフスペクトル — <span className="text-red-600">正: 不安定方向</span> / <span className="text-blue-600">負: 安定方向</span>
          </div>
          <canvas
            ref={spectrumCanvasRef}
            className="w-full border border-gray-100 rounded"
            style={{ height: 180 }}
          />
        </div>

        {/* 2. Rolling KY dimension */}
        <div>
          <div className="text-xs text-gray-500 mb-1">
            ローリング・カプラン-ヨーク次元 D<sub>KY</sub>(t) (紫) / 最大リアプノフ指数 λ<sub>max</sub>(t) (赤)
          </div>
          <div ref={kyRef} className="w-full rounded border border-gray-100" />
        </div>

        {/* 3. Lyapunov vector decomposition */}
        <div>
          <div className="text-xs text-gray-500 mb-1">
            リアプノフベクトル変動要因分解 — 各埋め込み次元の不安定方向への寄与率
          </div>
          <canvas
            ref={vectorCanvasRef}
            className="w-full border border-gray-100 rounded"
            style={{ height: 200 }}
          />
        </div>
      </div>

      {/* Interpretation */}
      <div className="bg-gray-50 rounded p-3 text-xs text-gray-700 mb-3 space-y-1">
        <p className="font-medium">解釈:</p>
        <p>
          {positiveCount === 0
            ? "全リアプノフ指数が負 → 系は安定。アトラクタに収束しており予測可能性が高い。"
            : positiveCount === 1
            ? `正のリアプノフ指数が1つ → 低次元カオス。KY次元 ≈ ${recentKY.toFixed(1)} の奇妙なアトラクタ上を運動。`
            : `正のリアプノフ指数が${positiveCount}つ → 高次元カオス(ハイパーカオス)。複数の不安定方向が存在し予測が困難。`
          }
        </p>
        <p>
          {recentKY > avgKY * 1.3
            ? "直近でKY次元が増加 → 市場の複雑さが増大。多様な要因が影響しており、単純なモデルでは捉えにくい。"
            : recentKY < avgKY * 0.7
            ? "直近でKY次元が減少 → 市場構造が単純化。少数の要因に支配されトレンドが発生しやすい。"
            : "KY次元は安定 → 市場の複雑さに大きな変化なし。"
          }
        </p>
        <p>
          {vectorResult.instabilityProfile[0] > 0.4
            ? `最も直近の時間スケール(t-0)が不安定性の${(vectorResult.instabilityProfile[0] * 100).toFixed(0)}%を占める → 短期変動が市場の不安定性を支配。`
            : `不安定性は複数の時間スケールに分散 → 中長期的な構造変化も重要。`
          }
        </p>
      </div>

      <AnalysisGuide title="リアプノフスペクトル・KY次元・ベクトル分解の詳細解説">
        <div className="space-y-3">
          <div>
            <p className="font-medium text-gray-700 mb-1">1. リアプノフスペクトル</p>
            <p>N次元力学系にはN個のリアプノフ指数 λ⁽¹⁾ ≥ λ⁽²⁾ ≥ ... ≥ λ⁽ᴺ⁾ が存在します。
            従来の局所リアプノフ指数は最大指数のみを計算しますが、スペクトル全体を見ることで系の完全な動力学的特性が分かります。</p>
            <div className="bg-white rounded p-2 my-2 font-mono text-xs">
              λ⁽ⁱ⁾ = lim(T→∞) (1/T) ln σᵢ(T)<br/>
              σᵢ: ヤコビ行列の積のi番目の特異値<br/><br/>
              QR分解法: J(t)·Q(t-1) = Q(t)·R(t)<br/>
              λᵢ = (1/N) Σₜ ln|Rᵢᵢ(t)|
            </div>
            <ul className="list-disc pl-4 space-y-1">
              <li><span className="text-red-600">正の指数</span>: 不安定方向の数 → カオスの次元</li>
              <li><span className="text-blue-600">負の指数</span>: 安定方向の数 → 引力の強さ</li>
              <li>正の指数の和 = <span className="font-medium">コルモゴロフ-シナイエントロピー</span> (情報生成率)</li>
              <li>全指数の和 = <span className="font-medium">位相空間体積の収縮率</span> (散逸率)</li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">2. カプラン-ヨーク次元 D<sub>KY</sub></p>
            <p>リアプノフスペクトルからアトラクタの情報次元を推定する公式です。</p>
            <div className="bg-white rounded p-2 my-2 font-mono text-xs">
              D_KY = j + (Σᵢ₌₁ʲ λᵢ) / |λⱼ₊₁|<br/>
              j: Σᵢ₌₁ʲ λᵢ ≥ 0 を満たす最大の整数
            </div>
            <ul className="list-disc pl-4 space-y-1">
              <li>D_KY ≈ 1: 単純な周期運動(固定点付近)</li>
              <li>D_KY ≈ 2-3: 低次元カオス → パターン認識ベースの予測が有効</li>
              <li>D_KY {">"} 4: 高次元カオス → 多要因が絡み予測困難</li>
              <li><span className="font-medium">D_KYの急減</span>: 市場の自由度が減少 → 少数のファクターに支配 → トレンド発生</li>
              <li><span className="font-medium">D_KYの急増</span>: 複雑化 → レジーム転換・クラッシュの前兆</li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">3. リアプノフベクトル変動要因分解</p>
            <p>最大リアプノフ指数に対応する固有ベクトル(リアプノフベクトル)を計算し、
            各埋め込み次元(時間遅れ成分)がどの程度「不安定方向」に寄与しているかを分解します。</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><span className="font-medium">t-0 支配</span>: 直近の価格変動が不安定性を決定 → 短期モメンタムが重要</li>
              <li><span className="font-medium">t-kτ 支配</span>: k日前の変動が不安定性を決定 → 中期のサイクル構造が存在</li>
              <li><span className="font-medium">均等分散</span>: 複数時間スケールが等しく寄与 → 複合的な要因</li>
            </ul>
            <p className="mt-2">竹内研究室の研究では、大自由度系のリアプノフベクトルが「集団挙動モード」と
            「微視的モード」に分離することが発見されました。金融市場では、集団モードの不安定化が
            市場全体の暴落リスクに対応する可能性があります。</p>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">4. 投資判断への活用</p>
            <div className="overflow-x-auto">
              <table className="text-xs border-collapse w-full">
                <thead>
                  <tr className="bg-white">
                    <th className="border p-1">指標</th>
                    <th className="border p-1">状態</th>
                    <th className="border p-1">示唆</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="border p-1">正のλの数</td>
                    <td className="border p-1">0個</td>
                    <td className="border p-1 bg-green-50">安定。平均回帰戦略が有効</td>
                  </tr>
                  <tr>
                    <td className="border p-1">正のλの数</td>
                    <td className="border p-1">1個</td>
                    <td className="border p-1 bg-yellow-50">低次元カオス。非線形予測モデルが有効</td>
                  </tr>
                  <tr>
                    <td className="border p-1">正のλの数</td>
                    <td className="border p-1">2個以上</td>
                    <td className="border p-1 bg-red-50">ハイパーカオス。リスク管理を最優先</td>
                  </tr>
                  <tr>
                    <td className="border p-1">D_KY急減</td>
                    <td className="border p-1">直近 {"<"} 平均×0.7</td>
                    <td className="border p-1 bg-blue-50">構造単純化。トレンドフォロー有効</td>
                  </tr>
                  <tr>
                    <td className="border p-1">D_KY急増</td>
                    <td className="border p-1">直近 {">"} 平均×1.3</td>
                    <td className="border p-1 bg-orange-50">複雑化。ポジション縮小推奨</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </AnalysisGuide>
    </div>
  );
}
