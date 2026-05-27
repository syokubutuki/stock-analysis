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
import {
  rollingLyapunov,
  phaseSpaceDensity,
  autoMutualInformation,
} from "../../lib/attractor-investment";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function LocalLyapunovChart({ prices, seriesMode }: Props) {
  const lyapRef = useRef<HTMLDivElement>(null);
  const densityRef = useRef<HTMLDivElement>(null);
  const lyapChartRef = useRef<IChartApi | null>(null);
  const densityChartRef = useRef<IChartApi | null>(null);
  const [windowSize, setWindowSize] = useState(100);

  const { values, times } = extractSeries(prices, seriesMode);

  const tau = useMemo(
    () => autoMutualInformation(values, 20).optimalTau,
    [values]
  );

  const lyapResult = useMemo(
    () => rollingLyapunov(values, times, tau, 3, windowSize),
    [values, times, tau, windowSize]
  );

  const densityResult = useMemo(
    () => phaseSpaceDensity(values, times, tau, 3),
    [values, times, tau]
  );

  // Lyapunov chart
  useEffect(() => {
    if (!lyapRef.current || lyapResult.times.length === 0) return;
    if (lyapChartRef.current) lyapChartRef.current.remove();

    const chart = createChart(lyapRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: lyapRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    lyapChartRef.current = chart;

    // Histogram with color coding
    const histSeries = chart.addSeries(HistogramSeries, {
      title: "局所λ",
    });
    histSeries.setData(lyapResult.times.map((t, i) => ({
      time: t as Time,
      value: lyapResult.exponents[i],
      color: lyapResult.exponents[i] > 0 ? "rgba(239,68,68,0.6)" : "rgba(34,197,94,0.6)",
    })));

    // Smoothed line
    const smoothWindow = 10;
    const smoothed: { time: Time; value: number }[] = [];
    for (let i = smoothWindow - 1; i < lyapResult.exponents.length; i++) {
      const slice = lyapResult.exponents.slice(i - smoothWindow + 1, i + 1);
      const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
      smoothed.push({ time: lyapResult.times[i] as Time, value: avg });
    }
    const smoothSeries = chart.addSeries(LineSeries, {
      color: "#1d4ed8",
      lineWidth: 2,
      title: "平滑化λ",
    });
    smoothSeries.setData(smoothed);

    // Zero line
    const zeroSeries = chart.addSeries(LineSeries, {
      color: "#9ca3af",
      lineWidth: 1,
      lineStyle: 2,
      title: "",
    });
    zeroSeries.setData(lyapResult.times.map(t => ({ time: t as Time, value: 0 })));

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (lyapRef.current) chart.applyOptions({ width: lyapRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); lyapChartRef.current = null; };
  }, [lyapResult]);

  // Density chart
  useEffect(() => {
    if (!densityRef.current || densityResult.times.length === 0) return;
    if (densityChartRef.current) densityChartRef.current.remove();

    const chart = createChart(densityRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: densityRef.current.clientWidth,
      height: 160,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    densityChartRef.current = chart;

    const densitySeries = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 2,
      title: "位相空間密度",
    });
    densitySeries.setData(densityResult.times.map((t, i) => ({
      time: t as Time,
      value: densityResult.density[i],
    })));

    const noveltySeries = chart.addSeries(LineSeries, {
      color: "#f43f5e",
      lineWidth: 2,
      title: "新奇度",
    });
    noveltySeries.setData(densityResult.times.map((t, i) => ({
      time: t as Time,
      value: densityResult.novelty[i],
    })));

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (densityRef.current) chart.applyOptions({ width: densityRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); densityChartRef.current = null; };
  }, [densityResult]);

  const recentLyap = lyapResult.exponents.length > 0
    ? lyapResult.exponents[lyapResult.exponents.length - 1] : 0;
  const recentDensity = densityResult.density.length > 0
    ? densityResult.density[densityResult.density.length - 1] : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        局所Lyapunov指数 / 位相空間密度
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        予測可能性と市場状態の既知性をリアルタイム追跡
      </p>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3 text-xs">
        <div className={`p-2 rounded ${recentLyap > 0 ? "bg-red-50" : "bg-green-50"}`}>
          <div className={recentLyap > 0 ? "text-red-600" : "text-green-600"}>現在のλ</div>
          <div className="font-bold">{recentLyap.toFixed(4)}</div>
          <div className={recentLyap > 0 ? "text-red-500" : "text-green-500"}>
            {recentLyap > 0 ? "不安定(カオス的)" : "安定(収束的)"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均λ</div>
          <div className="font-bold">{lyapResult.mean.toFixed(4)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">λ{">"}0 の割合</div>
          <div className="font-bold">{(lyapResult.positiveRatio * 100).toFixed(1)}%</div>
        </div>
        <div className={`p-2 rounded ${recentDensity < 0.3 ? "bg-red-50" : "bg-purple-50"}`}>
          <div className={recentDensity < 0.3 ? "text-red-600" : "text-purple-600"}>現在の密度</div>
          <div className="font-bold">{recentDensity.toFixed(3)}</div>
          <div className={recentDensity < 0.3 ? "text-red-500" : "text-purple-500"}>
            {recentDensity < 0.3 ? "未知の領域" : "既知の領域"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">レジーム転換数</div>
          <div className="font-bold">{lyapResult.regimeChanges.length}</div>
          <div className="text-gray-400">λ符号変化</div>
        </div>
      </div>

      {/* Window control */}
      <div className="flex gap-4 mb-3 text-xs">
        <label className="flex items-center gap-2">
          <span className="text-gray-500">Lyapunov窓幅:</span>
          <input
            type="range" min={50} max={200} step={10} value={windowSize}
            onChange={e => setWindowSize(Number(e.target.value))}
            className="w-24 accent-blue-600"
          />
          <span className="text-gray-700 font-medium w-10">{windowSize}日</span>
        </label>
        <span className="text-gray-400">τ = {tau} (AMI自動選択)</span>
      </div>

      {/* Charts */}
      <div className="space-y-3 mb-3">
        <div>
          <div className="text-xs text-gray-500 mb-1">
            局所Lyapunov指数 λ(t) — <span className="text-green-600">緑: 安定(λ{"<"}0)</span> / <span className="text-red-600">赤: 不安定(λ{">"}0)</span>
          </div>
          <div ref={lyapRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">
            位相空間密度 (紫) / 新奇度 (赤) — 高新奇度 = 未知の市場状態
          </div>
          <div ref={densityRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      <AnalysisGuide title="局所Lyapunov指数・位相空間密度の詳細解説">
        <div className="space-y-3">
          <div>
            <p className="font-medium text-gray-700 mb-1">1. 局所Lyapunov指数 λ(t)</p>
            <p>力学系における軌道の発散率を測定する指標です。ローリングウィンドウで時系列化することで、「今この瞬間の予測可能性」を追跡します。</p>
            <div className="bg-gray-50 rounded p-2 my-2 font-mono text-xs">
              λ = lim(t→∞) (1/t) · ln(|δx(t)| / |δx(0)|)<br/><br/>
              近傍軌道の初期微小距離 δx(0) が時間とともにどう変化するかの指数関数的増加率:<br/>
              |δx(t)| ≈ |δx(0)| · exp(λ · t)
            </div>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li><span className="font-medium text-green-600">λ {"<"} 0 (安定・収束的)</span>: 近傍の軌道が収束する → アトラクタの引力圏内にいる → <span className="font-medium">平均回帰的な振る舞い</span>。短期予測が比較的容易。</li>
              <li><span className="font-medium text-red-600">λ {">"} 0 (不安定・カオス的)</span>: 近傍の軌道が指数関数的に発散 → 微小な違いが急速に拡大 → <span className="font-medium">予測困難</span>。ブレイクアウトやボラティリティ拡大の前兆。</li>
              <li><span className="font-medium text-gray-600">λ ≈ 0 (臨界状態)</span>: 安定と不安定の境界 → <span className="font-medium">レジーム転換の前兆</span>。次にどちらに動くか注視。</li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">2. λの符号遷移と投資判断</p>
            <div className="bg-gray-50 rounded p-2 my-2 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="font-medium">負 → 正 への遷移</p>
                  <p>安定した引力圏から離脱</p>
                  <p className="text-red-600">→ ボラ拡大・ブレイクアウト</p>
                  <p>→ リスク管理強化</p>
                </div>
                <div>
                  <p className="font-medium">正 → 負 への遷移</p>
                  <p>カオスから新しい安定状態へ</p>
                  <p className="text-green-600">→ 新トレンド確立・ボラ収縮</p>
                  <p>→ トレンドフォロー開始</p>
                </div>
              </div>
            </div>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">3. 位相空間密度 ρ(t)</p>
            <p>Takens埋め込み空間上で、現在の状態ベクトルの周辺に過去の状態がどれだけ集中しているかを測定します。</p>
            <div className="bg-gray-50 rounded p-2 my-2 font-mono text-xs">
              ρ(t) = (半径ε内の過去の状態ベクトル数) / (全ベクトル数)<br/>
              新奇度 = 1 - ρ(t)
            </div>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li><span className="font-medium text-purple-600">高密度</span>: よく訪れる領域 → 過去のパターンが参考になる → 統計的に安定した判断が可能</li>
              <li><span className="font-medium text-red-600">低密度(高新奇度)</span>: 未知の領域 → 過去の経験則が通用しない → <span className="font-medium">リスク管理を最優先</span></li>
              <li><span className="font-medium">密度の急減</span>: アトラクタからの逸脱 = レジーム転換の可能性</li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">4. λと密度の組み合わせ解釈</p>
            <div className="overflow-x-auto">
              <table className="text-xs border-collapse w-full">
                <thead>
                  <tr className="bg-gray-100">
                    <th className="border p-1"></th>
                    <th className="border p-1">高密度 (既知)</th>
                    <th className="border p-1">低密度 (未知)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="border p-1 font-medium">λ{"<"}0 (安定)</td>
                    <td className="border p-1 bg-green-50">最も安全: 既知の安定域。通常戦略を適用</td>
                    <td className="border p-1 bg-yellow-50">新しい安定域の形成中。様子見して判断</td>
                  </tr>
                  <tr>
                    <td className="border p-1 font-medium">λ{">"}0 (不安定)</td>
                    <td className="border p-1 bg-orange-50">既知だが不安定。過去のボラパターンを参照</td>
                    <td className="border p-1 bg-red-50">最も危険: 未知×不安定。ポジション最小化</td>
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
