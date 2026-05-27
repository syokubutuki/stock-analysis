"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  computeRecurrencePlot,
  estimateLyapunov,
} from "../../lib/nonlinear";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function RecurrencePlotChart({ prices, seriesMode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lyapCanvasRef = useRef<HTMLCanvasElement>(null);

  const { values: lr } = extractSeries(prices, seriesMode);

  const rp = useMemo(() => computeRecurrencePlot(lr, 1, 3), [prices, seriesMode]);
  const lyap = useMemo(() => estimateLyapunov(lr, 1, 3, 20), [prices, seriesMode]);

  // Recurrence Plot描画
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || rp.n === 0) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const totalSize = Math.min(parent.clientWidth, 450);
    const dpr = window.devicePixelRatio || 1;

    canvas.width = totalSize * dpr;
    canvas.height = totalSize * dpr;
    canvas.style.width = `${totalSize}px`;
    canvas.style.height = `${totalSize}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, totalSize, totalSize);

    const margin = { l: 40, r: 10, t: 10, b: 32 };
    const plotW = totalSize - margin.l - margin.r;
    const plotH = totalSize - margin.t - margin.b;
    const cellW = plotW / rp.n;
    const cellH = plotH / rp.n;

    // RP dots
    ctx.fillStyle = "#1e40af";
    for (let i = 0; i < rp.n; i++) {
      for (let j = 0; j < rp.n; j++) {
        if (rp.matrix[i * rp.n + j] === 1) {
          ctx.fillRect(
            margin.l + Math.floor(j * cellW),
            margin.t + Math.floor(i * cellH),
            Math.max(1, Math.ceil(cellW)),
            Math.max(1, Math.ceil(cellH))
          );
        }
      }
    }

    // Ticks
    ctx.fillStyle = "#9ca3af";
    ctx.strokeStyle = "#d1d5db";
    ctx.font = "9px monospace";
    ctx.lineWidth = 0.5;
    const tickCount = 5;
    for (let i = 0; i <= tickCount; i++) {
      const frac = i / tickCount;
      const val = Math.round(frac * rp.n);

      // X-axis
      const xPx = margin.l + frac * plotW;
      ctx.beginPath();
      ctx.moveTo(xPx, margin.t + plotH);
      ctx.lineTo(xPx, margin.t + plotH + 4);
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillText(`${val}`, xPx, margin.t + plotH + 14);

      // Y-axis
      const yPx = margin.t + frac * plotH;
      ctx.beginPath();
      ctx.moveTo(margin.l - 4, yPx);
      ctx.lineTo(margin.l, yPx);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(`${val}`, margin.l - 6, yPx + 3);
    }

    // Axis labels
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("t", margin.l + plotW / 2, totalSize - 4);
    ctx.save();
    ctx.translate(10, margin.t + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("t", 0, 0);
    ctx.restore();
  }, [rp]);

  // Lyapunov 発散曲線描画
  useEffect(() => {
    const canvas = lyapCanvasRef.current;
    if (!canvas || lyap.divergence.length === 0) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const w = Math.min(parent.clientWidth, 450);
    const h = 160;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { l: 50, r: 16, t: 12, b: 28 };
    const pw = w - margin.l - margin.r;
    const ph = h - margin.t - margin.b;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    const data = lyap.divergence;
    const n = data.length;
    if (n < 2) return;

    const minY = Math.min(...data);
    const maxY = Math.max(...data);
    const rangeY = maxY - minY || 1;

    // Grid + ticks
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const y = margin.t + (i / yTicks) * ph;
      ctx.beginPath();
      ctx.moveTo(margin.l, y);
      ctx.lineTo(margin.l + pw, y);
      ctx.stroke();
    }
    const xTicks = 5;
    for (let i = 0; i <= xTicks; i++) {
      const x = margin.l + (i / xTicks) * pw;
      ctx.beginPath();
      ctx.moveTo(x, margin.t);
      ctx.lineTo(x, margin.t + ph);
      ctx.stroke();
    }

    // Data line
    ctx.strokeStyle = lyap.exponent > 0.01 ? "#dc2626" : lyap.exponent < -0.01 ? "#16a34a" : "#d97706";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = margin.l + (i / (n - 1)) * pw;
      const y = margin.t + (1 - (data[i] - minY) / rangeY) * ph;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Linear fit line (slope = Lyapunov exponent)
    if (n > 2) {
      ctx.strokeStyle = "rgba(100,100,100,0.4)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      const y0 = data[0];
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const fitVal = y0 + lyap.exponent * i;
        const x = margin.l + (i / (n - 1)) * pw;
        const y = margin.t + (1 - (fitVal - minY) / rangeY) * ph;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Y-axis labels
    ctx.fillStyle = "#6b7280";
    ctx.font = "9px monospace";
    ctx.textAlign = "right";
    for (let i = 0; i <= yTicks; i++) {
      const val = maxY - (i / yTicks) * rangeY;
      ctx.fillText(val.toFixed(2), margin.l - 4, margin.t + (i / yTicks) * ph + 3);
    }

    // X-axis labels
    ctx.textAlign = "center";
    for (let i = 0; i <= xTicks; i++) {
      const val = Math.round((i / xTicks) * (n - 1));
      const x = margin.l + (i / xTicks) * pw;
      ctx.fillText(`${val}`, x, h - 6);
    }

    // X-axis title
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px sans-serif";
    ctx.fillText("step", margin.l + pw / 2, h - 16);
    ctx.textAlign = "left";

    // Title
    ctx.fillStyle = "#374151";
    ctx.font = "10px sans-serif";
    ctx.fillText("ln|divergence|", margin.l + 2, margin.t + 10);
  }, [lyap]);

  // RQA判定
  const rqaInterpretation = useMemo(() => {
    const hints: string[] = [];
    if (rp.recurrenceRate > 0.15) hints.push("再帰率が高い: パターンの反復が多い");
    else if (rp.recurrenceRate < 0.03) hints.push("再帰率が低い: ほぼ非反復的な動き");
    if (rp.determinism > 0.7) hints.push("決定性が高い: 予測可能な構造あり");
    else if (rp.determinism < 0.3) hints.push("決定性が低い: ランダム性が支配的");
    if (rp.laminarity > 0.5) hints.push("層流性が高い: レンジ相場の傾向");
    if (rp.trappingTime > 5) hints.push("滞留時間が長い: 状態が固着しやすい");
    if (rp.diagEntropy > 2) hints.push("対角線エントロピー高: 複雑な動力学");
    return hints;
  }, [rp]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">Recurrence Plot & Lyapunov指数</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Recurrence Plot */}
        <div>
          <div className="text-sm font-medium text-gray-700 mb-2">
            Recurrence Plot
          </div>
          <div className="flex justify-center">
            <canvas ref={canvasRef} className="rounded border border-gray-100" />
          </div>
        </div>

        {/* RQA Metrics */}
        <div>
          <div className="text-sm font-medium text-gray-700 mb-2">
            RQA メトリクス
          </div>
          <div className="text-xs space-y-1.5">
            <div className="flex justify-between border-b border-gray-100 pb-1">
              <span>回帰率 (RR)</span>
              <span className="font-mono font-medium">{(rp.recurrenceRate * 100).toFixed(2)}%</span>
            </div>
            <div className="flex justify-between border-b border-gray-100 pb-1">
              <span>決定性 (DET)</span>
              <span className="font-mono font-medium">{(rp.determinism * 100).toFixed(2)}%</span>
            </div>
            <div className="flex justify-between border-b border-gray-100 pb-1">
              <span>層流性 (LAM)</span>
              <span className="font-mono font-medium">{(rp.laminarity * 100).toFixed(2)}%</span>
            </div>
            <div className="flex justify-between border-b border-gray-100 pb-1">
              <span>滞留時間 (TT)</span>
              <span className="font-mono font-medium">{rp.trappingTime.toFixed(2)}</span>
            </div>
            <div className="flex justify-between border-b border-gray-100 pb-1">
              <span>対角線エントロピー</span>
              <span className="font-mono font-medium">{rp.diagEntropy.toFixed(3)}</span>
            </div>
            <div className="flex justify-between border-b border-gray-100 pb-1">
              <span>最長対角線</span>
              <span className="font-mono font-medium">{rp.maxDiagLength}</span>
            </div>
            <div className="flex justify-between pb-1">
              <span>最長垂直線</span>
              <span className="font-mono font-medium">{rp.maxVertLength}</span>
            </div>
          </div>

          {/* Interpretation */}
          {rqaInterpretation.length > 0 && (
            <div className="mt-3 p-2 bg-blue-50 rounded text-xs text-blue-800 space-y-0.5">
              {rqaInterpretation.map((h, i) => <div key={i}>{h}</div>)}
            </div>
          )}
        </div>
      </div>

      {/* Lyapunov指数 + 発散曲線 */}
      <div className="mt-4">
        <div className="text-sm font-medium text-gray-700 mb-2">Lyapunov指数</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          <div>
            <div className="flex justify-center">
              <canvas ref={lyapCanvasRef} className="rounded border border-gray-100" />
            </div>
            <div className="mt-1 text-[10px] text-gray-400 text-center">
              実線: 近傍軌道の対数発散 / 破線: 線形フィット(傾き = {"\u03BB"})
            </div>
          </div>
          <div className="p-3 bg-gray-50 rounded">
            <div className="text-xs space-y-2">
              <div className="flex justify-between">
                <span>最大Lyapunov指数 ({"\u03BB"})</span>
                <span className={`font-mono font-bold ${lyap.exponent > 0.01 ? "text-red-600" : lyap.exponent < -0.01 ? "text-green-600" : "text-amber-600"}`}>
                  {lyap.exponent.toFixed(4)}
                </span>
              </div>
              <div className={`p-2 rounded text-xs ${
                lyap.exponent > 0.01 ? "bg-red-50 text-red-700" :
                lyap.exponent < -0.01 ? "bg-green-50 text-green-700" :
                "bg-amber-50 text-amber-700"
              }`}>
                {lyap.exponent > 0.01
                  ? "正: カオス的挙動。初期値鋭敏性により長期予測は困難。ポジションサイズの縮小・短期売買を推奨。"
                  : lyap.exponent < -0.01
                  ? "負: 安定的。軌道が収束しており、テクニカル分析の信頼性が比較的高い。"
                  : "境界的(≈0)。周期的またはクリティカルな状態。レジーム転換の兆候の可能性。"}
              </div>
              <div className="text-[10px] text-gray-500 space-y-0.5">
                <div>予測ホライズン ≈ 1/{"\u03BB"} = {lyap.exponent > 0.001 ? (1 / lyap.exponent).toFixed(1) + " ステップ" : "\u221E"}</div>
                <div>DET={rp.determinism > 0.5 ? "高" : "低"} + {"\u03BB"}={lyap.exponent > 0.01 ? "正" : lyap.exponent < -0.01 ? "負" : "≈0"}
                  {" → "}
                  {rp.determinism > 0.5 && lyap.exponent <= 0.01 ? "予測しやすい局面" : "予測が難しい局面"}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <AnalysisGuide title="Recurrence Plot & Lyapunov指数の読み方">
        <p><span className="font-medium">Recurrence Plot(再帰プロット):</span> 位相空間(dim=3, τ=1)上で2時点の状態が近い場合に点を打つプロットです。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">対角線パターン:</span> 周期性(同じ軌道の繰り返し)。</li>
          <li><span className="font-medium">対角線の断片:</span> 一時的な類似パターン。長いほど持続性が高い。</li>
          <li><span className="font-medium">水平・垂直の線:</span> 状態の「滞留」(レンジ相場)。</li>
          <li><span className="font-medium">白い領域:</span> 以前と異なる状態 = レジーム変化の可能性。</li>
        </ul>
        <p><span className="font-medium">RQAメトリクス:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">回帰率(RR):</span> 再帰ペアの割合。高いほどパターンが反復されている。</li>
          <li><span className="font-medium">決定性(DET):</span> 対角線に含まれる再帰点の割合。高いほど決定論的(予測可能)。</li>
          <li><span className="font-medium">層流性(LAM):</span> 垂直線に含まれる再帰点の割合。高いほどレンジ相場傾向。</li>
          <li><span className="font-medium">滞留時間(TT):</span> 垂直線の平均長。長いほど同じ状態に留まりやすい。</li>
          <li><span className="font-medium">対角線エントロピー:</span> 対角線長のShannon Entropy。高いほど複雑な動力学。</li>
        </ul>
        <p><span className="font-medium">Lyapunov指数:</span> 近傍軌道の発散速度。正ならカオス的(予測困難)、負なら安定(予測しやすい)。</p>
        <p><span className="font-medium">発散曲線の見方:</span> 実線が右上がり(正の傾き)ならカオス、水平や右下がりなら安定。破線は線形フィットで、その傾きがLyapunov指数。</p>
        <p><span className="font-medium">投資判断:</span> DETが高く{"\u03BB"}が負〜0の期間はテクニカル分析の信頼性が高い。{"\u03BB"}が大きく正の場合はリスク管理を強化。予測ホライズン(≈1/{"\u03BB"})を超える予測は本質的に困難。</p>
      </AnalysisGuide>
    </div>
  );
}
