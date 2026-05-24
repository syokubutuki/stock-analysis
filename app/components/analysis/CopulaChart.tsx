"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode } from "../../lib/series-mode";
import { alignSeries } from "../../lib/benchmark";
import { computeCopulaAnalysis, type CopulaResult } from "../../lib/copula";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

type BenchmarkKey = "nikkei" | "topix";

const BENCHMARKS: Record<BenchmarkKey, { ticker: string; label: string }> = {
  nikkei: { ticker: "^N225", label: "日経225" },
  topix: { ticker: "^TPX", label: "TOPIX" },
};

// ---- Canvas drawing helpers ------------------------------------------------

function drawReturnScatter(
  canvas: HTMLCanvasElement,
  stockReturns: number[],
  benchReturns: number[],
  benchLabel: string
) {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  const cssHeight = 300;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const pad = { top: 20, right: 20, bottom: 40, left: 50 };
  const plotW = cssWidth - pad.left - pad.right;
  const plotH = cssHeight - pad.top - pad.bottom;

  // Value extents
  const allX = benchReturns;
  const allY = stockReturns;
  const minX = Math.min(...allX);
  const maxX = Math.max(...allX);
  const minY = Math.min(...allY);
  const maxY = Math.max(...allY);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const toCanvasX = (v: number) => pad.left + ((v - minX) / rangeX) * plotW;
  const toCanvasY = (v: number) =>
    pad.top + plotH - ((v - minY) / rangeY) * plotH;

  // Background
  ctx.fillStyle = "#f9fafb";
  ctx.fillRect(pad.left, pad.top, plotW, plotH);

  // Zero axes
  const cx0 = toCanvasX(0);
  const cy0 = toCanvasY(0);

  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);

  if (cx0 >= pad.left && cx0 <= pad.left + plotW) {
    ctx.beginPath();
    ctx.moveTo(cx0, pad.top);
    ctx.lineTo(cx0, pad.top + plotH);
    ctx.stroke();
  }
  if (cy0 >= pad.top && cy0 <= pad.top + plotH) {
    ctx.beginPath();
    ctx.moveTo(pad.left, cy0);
    ctx.lineTo(pad.left + plotW, cy0);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Quadrant shading (subtle)
  const q2Color = "rgba(239,68,68,0.06)"; // lower-left: both down
  const q1Color = "rgba(34,197,94,0.06)"; // upper-right: both up
  ctx.fillStyle = q2Color;
  ctx.fillRect(pad.left, cy0, cx0 - pad.left, pad.top + plotH - cy0);
  ctx.fillStyle = q1Color;
  ctx.fillRect(cx0, pad.top, pad.left + plotW - cx0, cy0 - pad.top);

  // Dots
  const n = stockReturns.length;
  for (let i = 0; i < n; i++) {
    const bx = benchReturns[i];
    const sy = stockReturns[i];
    const px = toCanvasX(bx);
    const py = toCanvasY(sy);

    // Color by quadrant
    let color: string;
    if (bx >= 0 && sy >= 0) color = "rgba(34,197,94,0.6)"; // both up — green
    else if (bx < 0 && sy < 0) color = "rgba(239,68,68,0.6)"; // both down — red
    else color = "rgba(148,163,184,0.5)"; // diverging — grey

    ctx.beginPath();
    ctx.arc(px, py, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Border
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.left, pad.top, plotW, plotH);

  // Axis labels
  ctx.fillStyle = "#6b7280";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(benchLabel + " リターン", pad.left + plotW / 2, cssHeight - 6);

  ctx.save();
  ctx.translate(14, pad.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("銘柄 リターン", 0, 0);
  ctx.restore();

  // Title
  ctx.fillStyle = "#374151";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("リターン散布図", pad.left, pad.top - 6);
}

function drawCopulaScatter(
  canvas: HTMLCanvasElement,
  stockRanks: number[],
  benchRanks: number[],
  benchLabel: string,
  threshold: number
) {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  const cssHeight = 300;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const pad = { top: 20, right: 20, bottom: 40, left: 50 };
  const plotW = cssWidth - pad.left - pad.right;
  const plotH = cssHeight - pad.top - pad.bottom;

  const toX = (u: number) => pad.left + u * plotW;
  const toY = (v: number) => pad.top + plotH - v * plotH;

  // Background
  ctx.fillStyle = "#f9fafb";
  ctx.fillRect(pad.left, pad.top, plotW, plotH);

  // Tail threshold regions
  const q = threshold;
  ctx.fillStyle = "rgba(239,68,68,0.08)";
  // lower-left tail box
  ctx.fillRect(pad.left, toY(q), q * plotW, plotH - (plotH - (toY(q) - pad.top)));
  // Actually compute properly:
  // lower-left: x in [0,q], y in [0,q] -> canvas y from toY(q) to toY(0)=bottom
  ctx.fillRect(pad.left, toY(q), q * plotW, toY(0) - toY(q));

  ctx.fillStyle = "rgba(34,197,94,0.08)";
  // upper-right: x in [1-q,1], y in [1-q,1]
  ctx.fillRect(toX(1 - q), toY(1), q * plotW, toY(1 - q) - toY(1));

  // Diagonal reference line
  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top + plotH);
  ctx.lineTo(pad.left + plotW, pad.top);
  ctx.stroke();
  ctx.setLineDash([]);

  // Threshold dashed lines
  ctx.strokeStyle = "#fca5a5";
  ctx.lineWidth = 0.8;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(toX(q), pad.top);
  ctx.lineTo(toX(q), pad.top + plotH);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(pad.left, toY(q));
  ctx.lineTo(pad.left + plotW, toY(q));
  ctx.stroke();

  ctx.strokeStyle = "#86efac";
  ctx.beginPath();
  ctx.moveTo(toX(1 - q), pad.top);
  ctx.lineTo(toX(1 - q), pad.top + plotH);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(pad.left, toY(1 - q));
  ctx.lineTo(pad.left + plotW, toY(1 - q));
  ctx.stroke();
  ctx.setLineDash([]);

  // Dots
  const n = stockRanks.length;
  for (let i = 0; i < n; i++) {
    const u = benchRanks[i];
    const v = stockRanks[i];
    const px = toX(u);
    const py = toY(v);

    let color: string;
    if (u <= q && v <= q) color = "rgba(239,68,68,0.7)";
    else if (u > 1 - q && v > 1 - q) color = "rgba(34,197,94,0.7)";
    else color = "rgba(96,165,250,0.45)";

    ctx.beginPath();
    ctx.arc(px, py, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Border
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.left, pad.top, plotW, plotH);

  // Axis labels
  ctx.fillStyle = "#6b7280";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(benchLabel + " 順位", pad.left + plotW / 2, cssHeight - 6);

  ctx.save();
  ctx.translate(14, pad.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("銘柄 順位", 0, 0);
  ctx.restore();

  // Axis tick labels at 0 and 1
  ctx.fillStyle = "#9ca3af";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("0", pad.left, pad.top + plotH + 12);
  ctx.fillText("1", pad.left + plotW, pad.top + plotH + 12);
  ctx.textAlign = "right";
  ctx.fillText("0", pad.left - 4, pad.top + plotH + 3);
  ctx.fillText("1", pad.left - 4, pad.top + 4);

  // Title
  ctx.fillStyle = "#374151";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("コピュラ散布図（順位変換後）", pad.left, pad.top - 6);
}

// ---- Component -------------------------------------------------------------

export default function CopulaChart({ prices }: Props) {
  const returnCanvasRef = useRef<HTMLCanvasElement>(null);
  const copulaCanvasRef = useRef<HTMLCanvasElement>(null);

  const [benchKey, setBenchKey] = useState<BenchmarkKey>("nikkei");
  const [benchPrices, setBenchPrices] = useState<PricePoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBenchmark = useCallback(async (key: BenchmarkKey) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/stock?ticker=${encodeURIComponent(BENCHMARKS[key].ticker)}&range=3y`
      );
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "ベンチマーク取得失敗");
        setBenchPrices(null);
        return;
      }
      setBenchPrices(json.prices);
    } catch {
      setError("ネットワークエラー");
      setBenchPrices(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBenchmark(benchKey);
  }, [benchKey, fetchBenchmark]);

  const result = useMemo<CopulaResult | null>(() => {
    if (!benchPrices) return null;
    const aligned = alignSeries(prices, benchPrices);
    const stockCloses = aligned.stock.map((p) => p.close);
    const benchCloses = aligned.bench.map((p) => p.close);
    return computeCopulaAnalysis(stockCloses, benchCloses);
  }, [prices, benchPrices]);

  // Draw return scatter
  useEffect(() => {
    if (!returnCanvasRef.current || !result) return;
    drawReturnScatter(
      returnCanvasRef.current,
      result.stockReturns,
      result.benchReturns,
      BENCHMARKS[benchKey].label
    );
  }, [result, benchKey]);

  // Draw copula scatter
  useEffect(() => {
    if (!copulaCanvasRef.current || !result) return;
    drawCopulaScatter(
      copulaCanvasRef.current,
      result.stockRanks,
      result.benchRanks,
      BENCHMARKS[benchKey].label,
      0.1
    );
  }, [result, benchKey]);

  const fmt3 = (v: number) => v.toFixed(3);
  const fmtPct = (v: number) => (v * 100).toFixed(1) + "%";

  const tailMessage = result
    ? result.upperTail > result.lowerTail
      ? "上側テール依存が強い（同時上昇）"
      : result.lowerTail > result.upperTail
      ? "下側テール依存が強い（同時暴落リスク）"
      : "テール依存は対称的"
    : null;

  const tailMessageColor = result
    ? result.upperTail > result.lowerTail
      ? "text-green-700 bg-green-50"
      : result.lowerTail > result.upperTail
      ? "text-red-700 bg-red-50"
      : "text-gray-700 bg-gray-50"
    : "";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">コピュラ分析</h3>
        <div className="flex gap-1">
          {(Object.keys(BENCHMARKS) as BenchmarkKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setBenchKey(key)}
              className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                benchKey === key
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {BENCHMARKS[key].label}
            </button>
          ))}
        </div>
      </div>

      {/* Loading / Error */}
      {loading && (
        <div className="text-sm text-gray-400 py-8 text-center">
          ベンチマークデータ取得中...
        </div>
      )}
      {error && (
        <div className="text-sm text-red-500 py-4 text-center">{error}</div>
      )}

      {result && !loading && (
        <>
          {/* Stats grid */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs mb-4">
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">Kendall τ</div>
              <div className="font-mono font-medium text-gray-800">
                {fmt3(result.kendallTau)}
              </div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">Spearman ρ</div>
              <div className="font-mono font-medium text-gray-800">
                {fmt3(result.spearmanRho)}
              </div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">Pearson r</div>
              <div className="font-mono font-medium text-gray-800">
                {fmt3(result.pearson)}
              </div>
            </div>
            <div className="p-2 bg-red-50 rounded">
              <div className="text-gray-500">
                下側テール λ<sub>L</sub>
              </div>
              <div className="font-mono font-medium text-red-700">
                {fmtPct(result.lowerTail)}
              </div>
            </div>
            <div className="p-2 bg-green-50 rounded">
              <div className="text-gray-500">
                上側テール λ<sub>U</sub>
              </div>
              <div className="font-mono font-medium text-green-700">
                {fmtPct(result.upperTail)}
              </div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">テール非対称</div>
              <div
                className={`font-mono font-medium ${
                  result.tailAsymmetry > 0
                    ? "text-green-700"
                    : result.tailAsymmetry < 0
                    ? "text-red-700"
                    : "text-gray-700"
                }`}
              >
                {result.tailAsymmetry >= 0 ? "+" : ""}
                {fmtPct(result.tailAsymmetry)}
              </div>
            </div>
          </div>

          {/* Tail interpretation badge */}
          {tailMessage && (
            <div
              className={`text-xs px-3 py-1.5 rounded font-medium mb-4 inline-block ${tailMessageColor}`}
            >
              {tailMessage}
            </div>
          )}

          {/* Return scatter */}
          <div className="mb-2 text-xs text-gray-500 font-medium">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-400 mr-1" />
            同時上昇 &nbsp;
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-400 mr-1" />
            同時下落 &nbsp;
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-slate-300 mr-1" />
            逆方向
          </div>
          <canvas
            ref={returnCanvasRef}
            className="w-full rounded border border-gray-100 mb-4 block"
          />

          {/* Copula scatter */}
          <div className="mb-2 text-xs text-gray-500 font-medium">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-400 mr-1" />
            通常領域 &nbsp;
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-400 mr-1" />
            下側テール（上位10%暴落） &nbsp;
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-400 mr-1" />
            上側テール（上位10%急騰）
          </div>
          <canvas
            ref={copulaCanvasRef}
            className="w-full rounded border border-gray-100 block"
          />
        </>
      )}

      <AnalysisGuide title="コピュラ分析の読み方">
        <p>
          <span className="font-medium">コピュラ:</span>{" "}
          2変数の相関構造（特にテール部分）をモデル化する手法。単純なピアソン相関では捉えられない非線形な依存関係を分析できる。
        </p>
        <p>
          <span className="font-medium">テール依存:</span>{" "}
          極端な値（大暴落・大急騰）が同時に起きやすいかどうかの指標。下側テール依存（λL）が高いほど、暴落時に連動しやすい。
        </p>
        <p>
          <span className="font-medium">下側テール依存が高い:</span>{" "}
          ベンチマークが急落するとき、この銘柄も急落しやすい。分散投資の効果が薄れる（相関は危機時に高くなる）。
        </p>
        <p>
          <span className="font-medium">Kendall τ / Spearman ρ:</span>{" "}
          順位に基づく相関係数。非線形な関連も捉え、外れ値の影響を受けにくい。ピアソン相関 r と比べて、分布の仮定が不要。
        </p>
        <p>
          <span className="font-medium">コピュラ散布図:</span>{" "}
          横軸・縦軸ともに[0,1]に順位変換したデータ。左下（赤）・右上（緑）の点が多いほどテール依存が強い。
        </p>
      </AnalysisGuide>
    </div>
  );
}
