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
import { meanReversionAnalysis, simulateOU } from "../../lib/mean-reversion";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function MeanReversionChart({ prices, seriesMode }: Props) {
  const hlChartRef = useRef<HTMLDivElement>(null);
  const simCanvasRef = useRef<HTMLCanvasElement>(null);
  const hlApiRef = useRef<IChartApi | null>(null);

  const { values, times } = extractSeries(prices, seriesMode);
  const result = useMemo(
    () => meanReversionAnalysis(values, times, 60),
    [prices, seriesMode]
  );

  // Rolling half-life chart
  useEffect(() => {
    if (!hlChartRef.current) return;
    if (hlApiRef.current) hlApiRef.current.remove();

    const chart = createChart(hlChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: hlChartRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    hlApiRef.current = chart;

    if (result.rollingHL.length > 0) {
      const hlSeries = chart.addSeries(LineSeries, {
        color: "#8b5cf6",
        lineWidth: 1,
        title: "半減期(日)",
      });
      hlSeries.setData(
        result.rollingHL.map((d) => ({
          time: d.time as Time,
          value: d.halfLife,
        }))
      );
      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver(() => {
      if (hlChartRef.current) chart.applyOptions({ width: hlChartRef.current.clientWidth });
    });
    ro.observe(hlChartRef.current);
    return () => { ro.disconnect(); chart.remove(); hlApiRef.current = null; };
  }, [result]);

  // OU simulation on canvas
  useEffect(() => {
    const canvas = simCanvasRef.current;
    if (!canvas || result.ou.params.theta <= 0) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 160;
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

    const steps = 200;
    const numPaths = 5;
    const mu = result.ou.params.mu;
    const lastVal = values[values.length - 1];

    // Simulate paths
    const paths: number[][] = [];
    let allMin = Infinity, allMax = -Infinity;
    for (let s = 0; s < numPaths; s++) {
      const path = simulateOU(result.ou.params, lastVal, steps, 1, 42 + s * 137);
      paths.push(path);
      for (const v of path) {
        if (v < allMin) allMin = v;
        if (v > allMax) allMax = v;
      }
    }

    const pad = { top: 15, right: 10, bottom: 20, left: 50 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const range = allMax - allMin || 1;

    const toX = (i: number) => pad.left + (i / steps) * plotW;
    const toY = (v: number) => pad.top + (1 - (v - allMin) / range) * plotH;

    // μ line
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, toY(mu));
    ctx.lineTo(width - pad.right, toY(mu));
    ctx.stroke();
    ctx.setLineDash([]);

    // Paths
    const colors = ["#2563eb", "#059669", "#d97706", "#7c3aed", "#db2777"];
    for (let s = 0; s < numPaths; s++) {
      ctx.strokeStyle = colors[s];
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const x = toX(i);
        const y = toY(paths[s][i]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Labels
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(allMax.toFixed(2), pad.left - 4, pad.top + 8);
    ctx.fillText(allMin.toFixed(2), pad.left - 4, height - pad.bottom);
    ctx.fillText(`μ=${mu.toFixed(2)}`, pad.left - 4, toY(mu) - 3);
    ctx.textAlign = "center";
    ctx.fillText("0", pad.left, height - 5);
    ctx.fillText(`${steps}日`, width - pad.right, height - 5);
    ctx.fillText("OUシミュレーション (5パス)", width / 2, 12);
  }, [result, values]);

  const ou = result.ou;
  const vrLabel =
    result.vrRatio < 0.8 ? "平均回帰的" :
    result.vrRatio > 1.2 ? "モメンタム的" : "ランダムウォーク的";
  const hurstLabel =
    result.hurst < 0.4 ? "反持続的（平均回帰）" :
    result.hurst > 0.6 ? "持続的（トレンド）" : "ランダム";

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        平均回帰分析 (Ornstein-Uhlenbeck)
      </h3>

      {/* パラメータテーブル */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">回帰速度 θ</div>
          <div className="font-mono text-sm font-semibold">{ou.params.theta.toFixed(4)}</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">長期平均 μ</div>
          <div className="font-mono text-sm font-semibold">{ou.params.mu.toFixed(4)}</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">半減期</div>
          <div className="font-mono text-sm font-semibold">
            {ou.params.halfLife === Infinity ? "∞" : `${ou.params.halfLife.toFixed(1)}日`}
          </div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">R²</div>
          <div className="font-mono text-sm font-semibold">{ou.rSquared.toFixed(4)}</div>
        </div>
      </div>

      {/* 補助指標 */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="border rounded p-2">
          <div className="text-xs text-gray-500">Variance Ratio(q=5)</div>
          <div className="font-mono text-sm">{result.vrRatio.toFixed(4)} <span className="text-xs text-gray-400">({vrLabel})</span></div>
        </div>
        <div className="border rounded p-2">
          <div className="text-xs text-gray-500">Hurst指数 (R/S)</div>
          <div className="font-mono text-sm">{result.hurst.toFixed(4)} <span className="text-xs text-gray-400">({hurstLabel})</span></div>
        </div>
      </div>

      <div className="text-xs text-gray-600 mb-3">{ou.interpretation}</div>

      {/* ローリング半減期 */}
      <div className="text-xs text-gray-500 mb-1">ローリング半減期 (60日窓)</div>
      <div ref={hlChartRef} />

      {/* OUシミュレーション */}
      <div className="mt-3">
        <canvas ref={simCanvasRef} />
      </div>

      <AnalysisGuide title="Ornstein-Uhlenbeck平均回帰の詳細理論">
        <p className="font-medium text-gray-700">1. OUプロセスとは</p>
        <p>
          OUプロセスは「ゴムバンドで引っ張られた粒子」の動きに例えられます。
          価格が長期平均μから離れると、θの速さでμに引き戻される確率過程です。
          {"SDE: dX_t = θ(μ - X_t)dt + σdW_t"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. パラメータの意味</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>θ (回帰速度): 大きいほど速くμに戻る。θ=0ならランダムウォーク</li>
          <li>μ (長期平均): 系列が回帰する先の値</li>
          <li>σ (ボラティリティ): ランダムな変動の大きさ</li>
          <li>半減期 = ln(2)/θ: 乖離が半分になるまでの日数</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 推定方法</p>
        <p>
          {"離散化: X_{t+1} - X_t = θ(μ - X_t)Δt + σ√Δt·ε"}
          <br />
          {"ΔX = a + bX_t + ε と回帰し、θ = -b/Δt、μ = -a/b で推定します。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 補助指標</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"Variance Ratio: VR(q) = Var(r_q)/(q·Var(r_1))。1未満→平均回帰、1超→モメンタム"}</li>
          <li>Hurst指数: 0.5未満→反持続的（平均回帰）、0.5超→持続的（トレンド）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>半減期が短い（5-20日）→ 対数リターンの平均回帰でペアトレードや逆張りが有効</li>
          <li>半減期が長い → ランダムウォークに近く、平均回帰戦略は非推奨</li>
          <li>μからの乖離が大きい時がエントリーチャンス</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>株価水準にはOUは不適切（価格は非定常）。対数リターンやスプレッドに適用</li>
          <li>レジーム変化があるとθが時変する → ローリング推定で確認</li>
          <li>R²が低い場合、OUモデルのフィットが不良でパラメータは信頼性が低い</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
