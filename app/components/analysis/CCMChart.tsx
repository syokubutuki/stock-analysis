"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { fullCCMAnalysis, type CCMPoint, type CCMResult } from "../../lib/ccm";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: string;
}

const CURVES = [
  { key: "returnToVol" as const, color: "#2563eb", label: "Return→Vol" },
  { key: "volToReturn" as const, color: "#dc2626", label: "Vol→Return" },
  { key: "returnToVolume" as const, color: "#059669", label: "Return→Volume" },
  { key: "volumeToReturn" as const, color: "#f59e0b", label: "Volume→Return" },
] as const;

type CurveKey = (typeof CURVES)[number]["key"];

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

/** Main convergence plot with per-trial scatter */
function drawConvergencePlot(canvas: HTMLCanvasElement, result: CCMResult) {
  const setup = initCanvas(canvas, 300);
  if (!setup) return;
  const { ctx, width, height } = setup;

  const pad = { top: 25, right: 15, bottom: 35, left: 55 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const allCurves = CURVES.map((c) => ({
    ...c,
    pts: result[c.key],
    trials: result.detailed[c.key].trials,
  }));

  // Axes ranges
  let maxL = 0, maxRho = 0, minRho = 0;
  for (const c of allCurves) {
    for (const t of c.trials) {
      if (t.librarySize > maxL) maxL = t.librarySize;
      for (const r of t.trialRhos) {
        if (r > maxRho) maxRho = r;
        if (r < minRho) minRho = r;
      }
    }
  }
  maxRho = Math.max(maxRho, 0.5);
  minRho = Math.min(minRho, -0.1);

  const toX = (l: number) => pad.left + (l / maxL) * plotW;
  const toY = (r: number) =>
    pad.top + (1 - (r - minRho) / (maxRho - minRho)) * plotH;

  // Grid
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 0.5;
  for (let r = Math.ceil(minRho * 5) / 5; r <= maxRho; r += 0.2) {
    ctx.beginPath();
    ctx.moveTo(pad.left, toY(r));
    ctx.lineTo(width - pad.right, toY(r));
    ctx.stroke();
  }

  // Zero line
  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(pad.left, toY(0));
  ctx.lineTo(width - pad.right, toY(0));
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw per-trial dots + mean line
  for (const curve of allCurves) {
    if (curve.pts.length === 0) continue;

    // Trial dots (small, transparent)
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = curve.color;
    for (const t of curve.trials) {
      for (const rho of t.trialRhos) {
        ctx.beginPath();
        ctx.arc(toX(t.librarySize), toY(rho), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Mean line
    ctx.strokeStyle = curve.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < curve.pts.length; i++) {
      const x = toX(curve.pts[i].librarySize);
      const y = toY(curve.pts[i].rho);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Mean dots
    ctx.fillStyle = curve.color;
    for (const pt of curve.pts) {
      ctx.beginPath();
      ctx.arc(toX(pt.librarySize), toY(pt.rho), 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Legend
  ctx.font = "10px sans-serif";
  let ly = pad.top + 5;
  for (const curve of allCurves) {
    if (curve.pts.length === 0) continue;
    ctx.fillStyle = curve.color;
    ctx.fillRect(width - pad.right - 130, ly - 4, 10, 3);
    ctx.fillStyle = "#374151";
    ctx.textAlign = "left";
    ctx.fillText(
      `${curve.label} (${curve.pts[curve.pts.length - 1]?.rho.toFixed(3) ?? ""})`,
      width - pad.right - 116,
      ly
    );
    ly += 14;
  }

  // Axis labels
  ctx.fillStyle = "#6b7280";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("ライブラリサイズ L", width / 2, height - 5);
  ctx.textAlign = "right";
  for (let r = Math.ceil(minRho * 5) / 5; r <= maxRho; r += 0.2) {
    ctx.fillText(r.toFixed(1), pad.left - 5, toY(r) + 3);
  }
  ctx.save();
  ctx.translate(12, pad.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("Cross-map ρ", 0, 0);
  ctx.restore();

  ctx.fillStyle = "#374151";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(
    "収束プロット（大点=平均, 小点=各試行）",
    width / 2,
    14
  );
}

/** Prediction vs Actual scatter for selected curve */
function drawScatterPlot(
  canvas: HTMLCanvasElement,
  result: CCMResult,
  selectedKey: CurveKey
) {
  const setup = initCanvas(canvas, 260);
  if (!setup) return;
  const { ctx, width, height } = setup;

  const detail = result.detailed[selectedKey];
  const curveInfo = CURVES.find((c) => c.key === selectedKey)!;
  const { predicted, actual, rho } = detail.scatter;

  if (predicted.length === 0) {
    ctx.fillStyle = "#9ca3af";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("散布図データなし", width / 2, height / 2);
    return;
  }

  const pad = { top: 25, right: 15, bottom: 35, left: 55 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  let minV = Infinity, maxV = -Infinity;
  for (const v of predicted) { if (v < minV) minV = v; if (v > maxV) maxV = v; }
  for (const v of actual) { if (v < minV) minV = v; if (v > maxV) maxV = v; }
  const range = maxV - minV || 1;
  minV -= range * 0.05;
  maxV += range * 0.05;

  const toX = (v: number) => pad.left + ((v - minV) / (maxV - minV)) * plotW;
  const toY = (v: number) => pad.top + (1 - (v - minV) / (maxV - minV)) * plotH;

  // 45-degree line
  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(toX(minV), toY(minV));
  ctx.lineTo(toX(maxV), toY(maxV));
  ctx.stroke();
  ctx.setLineDash([]);

  // Scatter dots
  ctx.fillStyle = curveInfo.color;
  ctx.globalAlpha = 0.4;
  for (let i = 0; i < predicted.length; i++) {
    ctx.beginPath();
    ctx.arc(toX(predicted[i]), toY(actual[i]), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Axis labels
  ctx.fillStyle = "#6b7280";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Cross-map 予測値", width / 2, height - 5);
  ctx.save();
  ctx.translate(12, pad.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("実測値", 0, 0);
  ctx.restore();

  // Tick labels
  ctx.textAlign = "center";
  const nTicks = 5;
  for (let i = 0; i <= nTicks; i++) {
    const v = minV + (i / nTicks) * (maxV - minV);
    ctx.fillText(v.toFixed(3), toX(v), height - pad.bottom + 15);
  }
  ctx.textAlign = "right";
  for (let i = 0; i <= nTicks; i++) {
    const v = minV + (i / nTicks) * (maxV - minV);
    ctx.fillText(v.toFixed(3), pad.left - 5, toY(v) + 3);
  }

  // Title
  ctx.fillStyle = "#374151";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(
    `${curveInfo.label} 予測 vs 実測 (ρ=${rho.toFixed(3)}, N=${predicted.length})`,
    width / 2,
    14
  );
}

/** Input series sparklines */
function drawInputSeries(canvas: HTMLCanvasElement, result: CCMResult) {
  const setup = initCanvas(canvas, 200);
  if (!setup) return;
  const { ctx, width, height } = setup;

  const series = [
    { data: result.inputSeries.returns, color: "#2563eb", label: "Log Return" },
    { data: result.inputSeries.absReturns, color: "#dc2626", label: "|Return| (Vol proxy)" },
    { data: result.inputSeries.volumeChanges, color: "#059669", label: "Volume Change" },
  ];

  const rowH = Math.floor((height - 15) / 3);
  const pad = { left: 100, right: 10 };
  const plotW = width - pad.left - pad.right;

  ctx.fillStyle = "#374151";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("入力系列（分析に使用されたデータ）", width / 2, 12);

  for (let si = 0; si < series.length; si++) {
    const s = series[si];
    const data = s.data;
    if (data.length === 0) continue;

    const y0 = 18 + si * rowH;
    const midY = y0 + rowH / 2;

    // Label
    ctx.fillStyle = s.color;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(s.label, pad.left - 8, midY + 3);

    // Stats
    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    const std = Math.sqrt(
      data.reduce((a, b) => a + (b - mean) ** 2, 0) / data.length
    );
    ctx.fillStyle = "#9ca3af";
    ctx.font = "8px sans-serif";
    ctx.fillText(`μ=${mean.toFixed(4)} σ=${std.toFixed(4)}`, pad.left - 8, midY + 14);

    // Sparkline
    let minV = Infinity, maxV = -Infinity;
    for (const v of data) { if (v < minV) minV = v; if (v > maxV) maxV = v; }
    const range = maxV - minV || 1;

    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(data.length / plotW));
    let px = 0;
    for (let i = 0; i < data.length; i += step) {
      const x = pad.left + (i / (data.length - 1)) * plotW;
      const y = y0 + 5 + (1 - (data[i] - minV) / range) * (rowH - 10);
      px === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      px++;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Separator
    if (si < series.length - 1) {
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.left, y0 + rowH);
      ctx.lineTo(width - pad.right, y0 + rowH);
      ctx.stroke();
    }
  }
}

export default function CCMChart({ prices }: Props) {
  const convergenceRef = useRef<HTMLCanvasElement>(null);
  const scatterRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLCanvasElement>(null);
  const [selectedCurve, setSelectedCurve] = useState<CurveKey>("returnToVol");

  const result = useMemo(() => fullCCMAnalysis(prices), [prices]);

  useEffect(() => {
    if (convergenceRef.current) drawConvergencePlot(convergenceRef.current, result);
    if (inputRef.current) drawInputSeries(inputRef.current, result);
  }, [result]);

  useEffect(() => {
    if (scatterRef.current) drawScatterPlot(scatterRef.current, result, selectedCurve);
  }, [result, selectedCurve]);

  const hasData =
    result.returnToVol.length > 0 || result.returnToVolume.length > 0;
  if (!hasData) return null;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">
        収束交差写像 (CCM) - 非線形因果分析
      </h3>

      <div className="flex flex-wrap gap-2 mb-3">
        {CURVES.map((c) => {
          const pts = result[c.key];
          const conv =
            pts.length >= 3 &&
            pts[pts.length - 1].rho > pts[0].rho + 0.05 &&
            pts[pts.length - 1].rho > 0.1;
          return (
            <span
              key={c.key}
              className={`text-xs px-2 py-1 rounded ${
                conv
                  ? "bg-blue-100 text-blue-700"
                  : "bg-gray-100 text-gray-500"
              }`}
            >
              {c.label}: {conv ? "因果あり" : "因果なし"}
            </span>
          );
        })}
      </div>

      {/* Main convergence plot */}
      <canvas ref={convergenceRef} />

      {/* Scatter plot selector */}
      <div className="mt-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-gray-500 font-medium">
            予測 vs 実測:
          </span>
          {CURVES.map((c) => (
            <button
              key={c.key}
              onClick={() => setSelectedCurve(c.key)}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${
                selectedCurve === c.key
                  ? "text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
              style={
                selectedCurve === c.key
                  ? { backgroundColor: c.color }
                  : undefined
              }
            >
              {c.label}
            </button>
          ))}
        </div>
        <canvas ref={scatterRef} />
      </div>

      {/* Input series */}
      <div className="mt-4">
        <canvas ref={inputRef} />
      </div>

      <p className="text-xs text-gray-600 mt-2">{result.interpretation}</p>

      {/* Trial detail table */}
      <details className="mt-3">
        <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
          試行別ρ値テーブル
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-1 px-2 text-gray-500">L</th>
                {CURVES.map((c) => (
                  <th
                    key={c.key}
                    className="text-right py-1 px-2"
                    style={{ color: c.color }}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.detailed.returnToVol.trials.map((t, i) => (
                <tr key={t.librarySize} className="border-b border-gray-100">
                  <td className="py-1 px-2 text-gray-600">{t.librarySize}</td>
                  {CURVES.map((c) => {
                    const trial = result.detailed[c.key].trials[i];
                    if (!trial) return <td key={c.key} className="py-1 px-2 text-right">-</td>;
                    return (
                      <td key={c.key} className="py-1 px-2 text-right text-gray-700">
                        <span className="font-medium">{trial.meanRho.toFixed(3)}</span>
                        <span className="text-gray-400 ml-1">
                          [{trial.trialRhos.map((r) => r.toFixed(2)).join(", ")}]
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <AnalysisGuide title="CCM非線形因果分析の詳細理論">
        <p className="font-medium text-gray-700">1. CCMとは</p>
        <p>
          Sugihara et al. (2012)が提案した非線形因果推論手法です。
          Granger因果が線形モデルに基づくのに対し、CCMはTakens埋め込み定理を利用して
          非線形な動的システムの因果関係を検出します。
          「XがYに影響しているなら、Xの影子多様体からYを予測できるはず」という
          逆説的な論理に基づいています。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>{"1. Takens埋め込み: M_X = {(x_t, x_{t-τ}, ..., x_{t-(E-1)·τ})}"}</p>
        <p>{"2. 最近傍E+1点の距離重み付き予測: Ŷ = Σ w_i · y_i / Σ w_i"}</p>
        <p>{"   重み: w_i = exp(-d_i / d_1), d_1は最近傍距離"}</p>
        <p>{"3. ρ = Pearson(Ŷ, Y_actual)"}</p>
        <p>{"4. 収束性チェック: ρがライブラリサイズLの増加とともに増加すれば因果"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 中間結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>収束プロット: 大きい点は5回試行の平均ρ、小さい点は各試行のρ。散らばりが小さいほど結果が安定</li>
          <li>予測vs実測散布図: 45度線に沿うほど予測精度が高い＝因果関係の証拠が強い</li>
          <li>入力系列: CCMに入力された3つの時系列（対数リターン・絶対リターン・出来高変化率）</li>
          <li>試行別テーブル: 各ライブラリサイズでの5回のρ値を確認し、結果の安定性を検証可能</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 仮定と前提条件</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>埋め込み次元 E=3: Takens定理では元システムの次元dに対しE≥2d+1が理論的に必要。E=3は経験的デフォルト</li>
          <li>遅延 τ=1: 1日ラグ。自己相関構造により最適値は異なり得る</li>
          <li>ボラティリティ代理変数: |log return|を使用。GARCH推定値など他の選択肢もある</li>
          <li>サブサンプリング: N{">"}1000の場合は等間隔間引きで計算量を制限</li>
          <li>収束判定閾値: Δρ{">"}0.05 かつ 最終ρ{">"}0.1。これは経験的基準であり、統計検定ではない</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Return→Vol因果あり: レバレッジ効果（下落→ボラ上昇）の非線形構造を確認</li>
          <li>Volume→Return因果あり: 出来高が価格変動の先行指標として利用可能</li>
          <li>Granger因果と結果が異なる場合: 非線形な因果メカニズムの存在を示唆</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>計算量 O(L·N·E) のため、N≤1000にサブサンプリングしている</li>
          <li>CCMは決定論的システムを仮定しており、純粋に確率的な過程には適さない</li>
          <li>5回の試行平均は統計的検定としては不十分。サロゲートデータ検定が理想的</li>
          <li>ノイズが多い場合、収束パターンが不明瞭になる</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
