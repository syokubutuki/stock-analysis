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
import { logReturns } from "../../lib/transforms";
import { rsAnalysis, computeDCCA, correlationDimension } from "../../lib/fractal-ext";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function FractalExtChart({ prices, seriesMode }: Props) {
  const rsCanvasRef = useRef<HTMLCanvasElement>(null);
  const dccaCanvasRef = useRef<HTMLCanvasElement>(null);
  const corrDimCanvasRef = useRef<HTMLCanvasElement>(null);

  const { values: extracted } = extractSeries(prices, seriesMode);
  const needsTransform = seriesMode === "close" || seriesMode === "open";
  const lr = needsTransform ? logReturns(extracted) : extracted;
  const allVols = prices.map((p) => p.volume);
  const volumes = allVols.slice(allVols.length - lr.length);
  const volReturns = logReturns(volumes.map((v) => v || 1));

  const rs = useMemo(() => rsAnalysis(lr), [prices, seriesMode]);
  const dcca = useMemo(() => computeDCCA(lr, volReturns), [prices, seriesMode]);
  const corrDim = useMemo(() => correlationDimension(lr), [prices, seriesMode]);

  // R/S plot
  useEffect(() => {
    const canvas = rsCanvasRef.current;
    if (!canvas || rs.scales.length === 0) return;
    drawLogLogPlot(canvas, rs.scales.map(Math.log), rs.rsValues.map((v) => Math.log(v + 1e-20)),
      `R/S解析 — H=${rs.hurst.toFixed(3)} [${rs.confidence[0].toFixed(2)}, ${rs.confidence[1].toFixed(2)}]`,
      "log(s)", "log(R/S)", "#3b82f6");
  }, [rs]);

  // DCCA plot
  useEffect(() => {
    const canvas = dccaCanvasRef.current;
    if (!canvas || dcca.scales.length === 0) return;
    drawLogLogPlot(canvas, dcca.scales.map(Math.log), dcca.rho,
      `DCCA相関 (価格×出来高) — Cross-H=${dcca.crossHurst.toFixed(3)}`,
      "log(s)", "ρ_DCCA(s)", "#22c55e");
  }, [dcca]);

  // Correlation dimension plot
  useEffect(() => {
    const canvas = corrDimCanvasRef.current;
    if (!canvas || corrDim.logR.length === 0) return;
    drawLogLogPlot(canvas, corrDim.logR, corrDim.logC,
      `相関次元 — D₂=${corrDim.dimension.toFixed(3)}`,
      "log(r)", "log(C(r))", "#ef4444",
      corrDim.scalingRegion);
  }, [corrDim]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">フラクタル拡張解析</h3>
      <p className="text-xs text-gray-500 mb-3">R/S解析 / DCCA / 相関次元</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">R/S Hurst指数</div>
          <div className="font-bold">{rs.hurst.toFixed(3)}</div>
          <div className="text-gray-400">{rs.interpretation}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Cross-Hurst</div>
          <div className="font-bold">{dcca.crossHurst.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">相関次元 D₂</div>
          <div className="font-bold">{corrDim.dimension.toFixed(3)}</div>
          <div className="text-gray-400">{corrDim.dimension < 3 ? "低次元構造あり" : "高次元 (ノイズ的)"}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">95%CI (R/S)</div>
          <div className="font-bold">[{rs.confidence[0].toFixed(2)}, {rs.confidence[1].toFixed(2)}]</div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <canvas ref={rsCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <canvas ref={dccaCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <canvas ref={corrDimCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      <AnalysisGuide title="フラクタル拡張分析の詳細理論">
        <p className="font-medium text-gray-700">1. この分析の概要</p>
        <p>DFA（既存）に加え、R/S解析・DCCA・相関次元の3手法でフラクタル構造を多角的に評価します。異なるアルゴリズムで同じ性質（長期記憶・トレンド持続性）を測定し、結果の一致度で信頼性を判断します。</p>
        <p className="mt-1">海岸線の長さに例えると、定規の長さ（スケール）を変えると測定値が変わるのがフラクタルです。株価も見る時間スケールによって振る舞いが変わり、そのスケーリング則がHurst指数として定量化されます。</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"R/S解析: (R/S)_n ∝ n^H\n  R_n = max(累積偏差) - min(累積偏差), S_n = 標準偏差\n\nDCCA相関係数: ρ_DCCA(s) = F²_XY(s) / [F_XX(s) · F_YY(s)]\n  F²_XY(s) = DFA共分散関数\n\n相関次元: C(r) ∝ r^D₂ (r→0)\n  C(r) = (2/N(N-1)) Σ Θ(r - ||x_i - x_j||)"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>H（Hurst指数）</strong>: log-logプロットの傾きから推定。0〜1の値をとる</li>
          <li><strong>ρ_DCCA(s)</strong>: スケールsでの価格-出来高のフラクタル相関。-1〜1の範囲</li>
          <li><strong>D₂（相関次元）</strong>: アトラクタの複雑さ。Θはヘヴィサイドの階段関数</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>R/S解析（Rescaled Range）</strong>: Hurstが1950年代にナイル川の水位予測のために開発した古典的手法。累積偏差のレンジを標準偏差で正規化する</li>
          <li><strong>DCCA（Detrended Cross-Correlation Analysis）</strong>: DFAの2変数版。異なる時系列間のスケール依存的な相関を測定する</li>
          <li><strong>Cross-Hurst指数</strong>: DCCAのスケーリング指数。2系列間の長期記憶の相互作用を表す</li>
          <li><strong>相関次元（Grassberger-Procaccia法）</strong>: 位相空間に再構成したアトラクタの「実効的な次元」。決定論的構造の複雑さを測る</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>H {"<"} 0.5</strong>: 反持続性（平均回帰）。上がった後に下がりやすい。平均回帰戦略向き</li>
          <li><strong>H ≈ 0.5</strong>: ランダムウォーク。過去の動きが将来を予測しない</li>
          <li><strong>H {">"} 0.5</strong>: 持続性（トレンド継続）。上がった後にさらに上がりやすい。モメンタム戦略向き</li>
          <li><strong>R/SとDFAのH値が近い</strong>: Hurst推定の信頼性が高い</li>
          <li><strong>ρ_DCCA(s)が特定スケールで高い</strong>: そのスケール（日数）で価格と出来高の連動が特に強い</li>
          <li><strong>相関次元 {"<"} 3</strong>: 低次元の決定論的構造がある可能性。予測モデルが有効かもしれない</li>
          <li><strong>相関次元 {">"} 5</strong>: ノイズ支配的。統計的予測が困難</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>戦略選択</strong>: H {">"} 0.5ならトレンドフォロー、H {"<"} 0.5なら逆張り・平均回帰戦略が理論的に整合する</li>
          <li><strong>スケール別連動性</strong>: ρ_DCCAが高いスケールに合わせた保有期間設定。例えば20日スケールで高ければスイングトレード向き</li>
          <li><strong>予測可能性の評価</strong>: 相関次元が低い銘柄は、非線形モデル（ニューラルネットなど）による予測が有効な候補</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>有限データバイアス</strong>: R/S解析は短期依存（ARMA成分）の影響でHを過大推定する傾向がある。DFAとの比較が重要</li>
          <li><strong>非定常性</strong>: トレンドや構造変化があるとH推定が歪む。リターン系列への適用が基本</li>
          <li><strong>相関次元の収束</strong>: 埋め込み次元を上げてもD₂が収束しない場合、決定論的構造がないか、データが不足している</li>
          <li><strong>時変性</strong>: Hurst指数は時間とともに変化する。ローリング推定で現在の状態を確認すべき</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function drawLogLogPlot(
  canvas: HTMLCanvasElement,
  x: number[], y: number[],
  title: string, xLabel: string, yLabel: string,
  color: string,
  highlightRegion?: [number, number]
) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.parentElement?.clientWidth || 300;
  const height = 220;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx || x.length === 0) return;
  ctx.scale(dpr, dpr);

  const margin = { left: 45, right: 10, top: 20, bottom: 30 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);

  const xMin = Math.min(...x), xMax = Math.max(...x);
  const yMin = Math.min(...y), yMax = Math.max(...y);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const toX = (v: number) => margin.left + ((v - xMin) / xRange) * plotW;
  const toY = (v: number) => margin.top + plotH - ((v - yMin) / yRange) * plotH;

  // Grid
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const yy = margin.top + (i / 4) * plotH;
    ctx.beginPath(); ctx.moveTo(margin.left, yy); ctx.lineTo(margin.left + plotW, yy); ctx.stroke();
  }

  // Highlight scaling region
  if (highlightRegion) {
    ctx.fillStyle = color + "15";
    const x1 = toX(x[highlightRegion[0]]);
    const x2 = toX(x[highlightRegion[1]]);
    ctx.fillRect(x1, margin.top, x2 - x1, plotH);
  }

  // Data points
  ctx.fillStyle = color;
  for (let i = 0; i < x.length; i++) {
    ctx.beginPath();
    ctx.arc(toX(x[i]), toY(y[i]), 3, 0, 2 * Math.PI);
    ctx.fill();
  }

  // Line
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < x.length; i++) {
    const px = toX(x[i]), py = toY(y[i]);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Labels
  ctx.fillStyle = "#374151";
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(title, margin.left + plotW / 2, 12);
  ctx.font = "9px sans-serif";
  ctx.fillStyle = "#6b7280";
  ctx.fillText(xLabel, margin.left + plotW / 2, height - 5);
  ctx.save();
  ctx.translate(10, margin.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}
