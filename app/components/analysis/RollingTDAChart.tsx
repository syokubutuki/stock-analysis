"use client";

import { useMemo, useRef, useEffect, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  rollingTDA,
  autoMutualInformation,
} from "../../lib/attractor-investment";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function RollingTDAChart({ prices, seriesMode }: Props) {
  const bettiRef = useRef<HTMLDivElement>(null);
  const persistRef = useRef<HTMLDivElement>(null);
  const bettiChartRef = useRef<IChartApi | null>(null);
  const persistChartRef = useRef<IChartApi | null>(null);
  const [windowSize, setWindowSize] = useState(120);

  const { values, times } = extractSeries(prices, seriesMode);

  const tau = useMemo(
    () => autoMutualInformation(values, 20).optimalTau,
    [values]
  );

  const result = useMemo(
    () => rollingTDA(values, times, windowSize, tau, 3, 8),
    [values, times, windowSize, tau]
  );

  // Betti curves chart
  useEffect(() => {
    if (!bettiRef.current || result.data.length === 0) return;
    if (bettiChartRef.current) bettiChartRef.current.remove();

    const chart = createChart(bettiRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: bettiRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    bettiChartRef.current = chart;

    const beta0Series = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      title: "β₀ (成分数)",
    });
    const beta1Series = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 2,
      title: "β₁ (ループ数)",
    });

    beta0Series.setData(result.data.map(d => ({ time: d.time as Time, value: d.beta0 })));
    beta1Series.setData(result.data.map(d => ({ time: d.time as Time, value: d.beta1 })));
    chart.timeScale().fitContent();

    const handleResize = () => {
      if (bettiRef.current) chart.applyOptions({ width: bettiRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); bettiChartRef.current = null; };
  }, [result]);

  // Total persistence chart
  useEffect(() => {
    if (!persistRef.current || result.data.length === 0) return;
    if (persistChartRef.current) persistChartRef.current.remove();

    const chart = createChart(persistRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: persistRef.current.clientWidth,
      height: 140,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    persistChartRef.current = chart;

    const persistSeries = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 2,
      title: "Total Persistence",
    });
    persistSeries.setData(result.data.map(d => ({ time: d.time as Time, value: d.totalPersistence })));
    chart.timeScale().fitContent();

    const handleResize = () => {
      if (persistRef.current) chart.applyOptions({ width: persistRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); persistChartRef.current = null; };
  }, [result]);

  const latest = result.data.length > 0 ? result.data[result.data.length - 1] : null;
  const avgBeta1 = result.data.length > 0
    ? result.data.reduce((a, d) => a + d.beta1, 0) / result.data.length : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        ローリングTDA (位相的データ解析)
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        ベッティ数の時間変化から周期的構造やレジーム数の変遷を追跡
      </p>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-xs">
        <div className="p-2 bg-blue-50 rounded">
          <div className="text-blue-600">β₀ (現在)</div>
          <div className="font-bold">{latest?.beta0 ?? "—"}</div>
          <div className="text-blue-500">連結成分数</div>
        </div>
        <div className="p-2 bg-red-50 rounded">
          <div className="text-red-600">β₁ (現在)</div>
          <div className="font-bold">{latest?.beta1 ?? "—"}</div>
          <div className="text-red-500">ループ数</div>
        </div>
        <div className="p-2 bg-purple-50 rounded">
          <div className="text-purple-600">Persistence</div>
          <div className="font-bold">{latest?.totalPersistence.toFixed(2) ?? "—"}</div>
          <div className="text-purple-500">構造の頑健さ</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">解釈</div>
          <div className="font-bold text-xs leading-tight">{result.interpretation || "—"}</div>
        </div>
      </div>

      {/* Window control */}
      <div className="flex gap-4 mb-3 text-xs">
        <label className="flex items-center gap-2">
          <span className="text-gray-500">窓幅:</span>
          <input
            type="range" min={60} max={200} step={10} value={windowSize}
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
            ベッティ数の時間変化: <span className="text-blue-600">β₀ (成分数)</span> / <span className="text-red-600">β₁ (ループ数)</span>
          </div>
          <div ref={bettiRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">Total Persistence (位相的構造の総頑健さ)</div>
          <div ref={persistRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      <AnalysisGuide title="ローリングTDA (位相的データ解析) の詳細解説">
        <div className="space-y-3">
          <div>
            <p className="font-medium text-gray-700 mb-1">1. パーシステントホモロジーとは</p>
            <p>点群データの「形」(トポロジー)を、スケールを変えながら調べる手法です。Takens埋め込みで得られたアトラクタの点群に適用し、そのトポロジカルな特徴を抽出します。</p>
            <div className="bg-gray-50 rounded p-2 my-2 font-mono text-xs">
              Vietoris-Rips複体: 距離ε以下の点対を辺で結ぶ<br/>
              εを0から∞まで増やす → 位相的特徴が「生まれ」「死ぬ」<br/><br/>
              ベッティ数:<br/>
              　β₀ = 連結成分の数 (独立したクラスターの数)<br/>
              　β₁ = 1次元の穴の数 (ループ・サイクルの数)<br/><br/>
              Persistence = death - birth (長いほど頑健な構造)
            </div>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">2. ベッティ数の解釈と投資判断</p>
            <ul className="list-disc pl-4 space-y-2 text-xs">
              <li>
                <span className="font-medium text-blue-600">β₀ (連結成分数) の変化</span>
                <ul className="list-disc pl-4 mt-1">
                  <li><span className="font-medium">β₀の増加</span> → アトラクタが複数のクラスターに分裂 → レジーム数の増加 → 市場の不確実性増大</li>
                  <li><span className="font-medium">β₀の減少</span> → クラスターの統合 → レジームが一本化 → 市場のコンセンサス形成</li>
                  <li>β₀=1が理想的 → 単一のアトラクタ → 安定した力学系</li>
                </ul>
              </li>
              <li>
                <span className="font-medium text-red-600">β₁ (ループ数) の変化</span>
                <ul className="list-disc pl-4 mt-1">
                  <li><span className="font-medium">β₁の増加</span> → 周期的パターンの出現 → <span className="text-green-600">オシレーター系戦略(RSI等)が有効化</span></li>
                  <li><span className="font-medium">β₁の減少</span> → 周期性の消失 → トレンドフォローまたはランダムウォーク</li>
                  <li>β₁が安定して高い → 持続的な周期性 → 平均回帰戦略の根拠</li>
                </ul>
              </li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">3. Total Persistence</p>
            <p>全ての位相的特徴のpersistence (death - birth) の合計。位相的構造の総量を表します。</p>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li><span className="font-medium">Persistenceが高い</span> → 頑健な幾何学的構造 → アトラクタがはっきり存在 → 予測の手がかりが多い</li>
              <li><span className="font-medium">Persistenceが低い</span> → ノイズ的 → 明確な構造なし → ランダム性が支配的</li>
              <li><span className="font-medium">Persistenceの急変</span> → アトラクタの形状が変化 → レジーム転換のシグナル</li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">4. 通常のTDA (全期間) との違い</p>
            <p>本コンポーネントは、ローリングウィンドウでTDAを繰り返し計算することで、トポロジカルな特徴の<span className="font-medium">時間変化</span>を追跡します。全期間のTDAは「この時系列全体の特徴」を教えますが、ローリングTDAは「今の局所的な特徴はどう変化しているか」を教えます。</p>
          </div>
        </div>
      </AnalysisGuide>
    </div>
  );
}
