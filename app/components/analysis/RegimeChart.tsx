"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  AreaSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { fitHMM, detectChangePoints, kalmanFilter } from "../../lib/regime";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

const STATE_COLORS = ["#22c55e", "#eab308", "#ef4444"];

export default function RegimeChart({ prices, seriesMode }: Props) {
  const hmmRef = useRef<HTMLDivElement>(null);
  const cpRef = useRef<HTMLDivElement>(null);
  const kalmanRef = useRef<HTMLDivElement>(null);
  const transCanvasRef = useRef<HTMLCanvasElement>(null);
  const hmmChartRef = useRef<IChartApi | null>(null);
  const cpChartRef = useRef<IChartApi | null>(null);
  const kalmanChartRef = useRef<IChartApi | null>(null);

  const { values: lr, times: lrTimes } = extractSeries(prices, seriesMode);
  const closes = prices.map((p) => p.close);
  const times = prices.map((p) => p.time);

  const hmm = useMemo(() => fitHMM(lr, 3), [prices, seriesMode]);
  const cp = useMemo(() => detectChangePoints(lr), [prices, seriesMode]);
  const kalman = useMemo(() => kalmanFilter(closes), [prices, seriesMode]);

  // HMM state probability chart
  useEffect(() => {
    if (!hmmRef.current) return;
    if (hmmChartRef.current) hmmChartRef.current.remove();

    const chart = createChart(hmmRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: hmmRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    hmmChartRef.current = chart;

    // Stacked area for state probabilities
    for (let s = hmm.nStates - 1; s >= 0; s--) {
      const series = chart.addSeries(AreaSeries, {
        lineColor: STATE_COLORS[s],
        topColor: STATE_COLORS[s] + "80",
        bottomColor: STATE_COLORS[s] + "10",
        lineWidth: 1,
        title: hmm.stateLabels[s],
      });
      series.setData(
        hmm.stateProbabilities.map((probs, i) => ({
          time: lrTimes[i] as Time,
          value: probs[s],
        }))
      );
    }

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (hmmRef.current) chart.applyOptions({ width: hmmRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); hmmChartRef.current = null; };
  }, [prices, hmm]);

  // Transition matrix canvas
  useEffect(() => {
    const canvas = transCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const size = 180;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);

    const n = hmm.nStates;
    const cellSize = 40;
    const offset = 50;

    // Header
    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("遷移行列", size / 2, 12);

    // Labels
    ctx.font = "9px sans-serif";
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = STATE_COLORS[i];
      ctx.fillText(hmm.stateLabels[i].slice(0, 4), offset + i * cellSize + cellSize / 2, 28);
      ctx.fillText(hmm.stateLabels[i].slice(0, 4), 25, offset + i * cellSize + cellSize / 2 - 5 + 4);
    }

    // Cells
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const val = hmm.transitionMatrix[i][j];
        const intensity = Math.min(val * 1.5, 1);
        ctx.fillStyle = `rgba(59, 130, 246, ${intensity})`;
        ctx.fillRect(offset + j * cellSize + 2, offset + i * cellSize - 5, cellSize - 4, cellSize - 4);
        ctx.fillStyle = intensity > 0.5 ? "#fff" : "#374151";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(val.toFixed(2), offset + j * cellSize + cellSize / 2, offset + i * cellSize + cellSize / 2 - 5 + 2);
      }
    }
  }, [hmm]);

  // Change point chart
  useEffect(() => {
    if (!cpRef.current) return;
    if (cpChartRef.current) cpChartRef.current.remove();

    const chart = createChart(cpRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: cpRef.current.clientWidth,
      height: 120,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    cpChartRef.current = chart;

    // CUSUM series
    const cusumSeries = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 2,
      title: "CUSUM",
    });
    cusumSeries.setData(
      cp.cusumSeries.slice(1).map((v, i) => ({ time: lrTimes[Math.min(i, lrTimes.length - 1)] as Time, value: v }))
    );

    // Segment means
    const segSeries = chart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 2,
      title: "セグメント平均",
      lastValueVisible: false,
    });
    const segData: { time: Time; value: number }[] = [];
    for (const seg of cp.segments) {
      for (let i = seg.start; i < seg.end && i < lrTimes.length; i++) {
        segData.push({ time: lrTimes[i] as Time, value: seg.mean });
      }
    }
    segSeries.setData(segData);

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (cpRef.current) chart.applyOptions({ width: cpRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); cpChartRef.current = null; };
  }, [prices, cp]);

  // Kalman filter chart
  useEffect(() => {
    if (!kalmanRef.current) return;
    if (kalmanChartRef.current) kalmanChartRef.current.remove();

    const chart = createChart(kalmanRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: kalmanRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    kalmanChartRef.current = chart;

    // Observed
    const obsSeries = chart.addSeries(LineSeries, {
      color: "#94a3b8",
      lineWidth: 1,
      title: "観測値",
    });
    obsSeries.setData(
      closes.map((v, i) => ({ time: times[i] as Time, value: v }))
    );

    // Filtered state
    const filtSeries = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      title: "カルマンフィルタ推定",
    });
    filtSeries.setData(
      kalman.filteredState.map((v, i) => ({ time: times[i] as Time, value: v }))
    );

    // Confidence bands
    const upperSeries = chart.addSeries(LineSeries, {
      color: "#93c5fd",
      lineWidth: 1,
      title: "95%上限",
      lineStyle: 2,
    });
    upperSeries.setData(
      kalman.upperBand.map((v, i) => ({ time: times[i] as Time, value: v }))
    );

    const lowerSeries = chart.addSeries(LineSeries, {
      color: "#93c5fd",
      lineWidth: 1,
      title: "95%下限",
      lineStyle: 2,
    });
    lowerSeries.setData(
      kalman.lowerBand.map((v, i) => ({ time: times[i] as Time, value: v }))
    );

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (kalmanRef.current) chart.applyOptions({ width: kalmanRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); kalmanChartRef.current = null; };
  }, [prices, kalman]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">レジーム分析</h3>
      <p className="text-xs text-gray-500 mb-3">HMM状態遷移 / 変化点検出 / カルマンフィルタ</p>

      {/* HMM stats */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3 text-xs">
        {hmm.stateLabels.map((label, s) => (
          <div key={label} className="p-2 rounded" style={{ backgroundColor: STATE_COLORS[s] + "20" }}>
            <div className="font-medium" style={{ color: STATE_COLORS[s] }}>{label}</div>
            <div>μ: {(hmm.stateMeans[s] * 100).toFixed(3)}%</div>
            <div>σ: {(hmm.stateVols[s] * 100).toFixed(3)}%</div>
            <div>持続: {hmm.expectedDuration[s].toFixed(1)}日</div>
          </div>
        ))}
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">変化点数</div>
          <div className="font-bold text-lg">{cp.changePoints.length}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Kalman LL</div>
          <div className="font-bold">{kalman.logLikelihood.toFixed(1)}</div>
        </div>
      </div>

      {/* HMM chart + transition matrix */}
      <div className="flex flex-col sm:flex-row gap-3 mb-3">
        <div className="flex-1">
          <div className="text-xs text-gray-500 mb-1">HMM 状態確率 (Baum-Welch推定, 3状態)</div>
          <div ref={hmmRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <canvas ref={transCanvasRef} className="rounded border border-gray-100" />
        </div>
      </div>

      {/* Change point */}
      <div className="text-xs text-gray-500 mb-1">変化点検出 (CUSUM + Binary Segmentation)</div>
      <div ref={cpRef} className="w-full rounded border border-gray-100 mb-3" />

      {/* Kalman filter */}
      <div className="text-xs text-gray-500 mb-1">カルマンフィルタ (Local Level Model) — 推定トレンド + 95%信頼区間</div>
      <div ref={kalmanRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="レジーム分析の詳細理論">
        <p className="font-medium text-gray-700">1. この分析の概要</p>
        <p>市場には「穏やかな上昇期」「荒れた下落期」など異なる状態（レジーム）があり、それぞれで株価の振る舞いが大きく異なります。この分析では3つの手法で市場レジームを推定し、構造的な変化点を検出します。</p>
        <p className="mt-1">天気に例えると、HMMは「今日の天気から明日の天気（晴れ/曇り/雨）を確率的に予測するモデル」、変化点検出は「季節の変わり目（春→夏など）を特定する手法」、カルマンフィルタは「雲や霧の向こうにある太陽の位置（真のトレンド）を推定する手法」です。</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"HMM:\n  遷移確率: P(S_t=j | S_{t-1}=i) = a_ij\n  出力分布: r_t | S_t=k ~ N(μ_k, σ²_k)\n  推定法: Baum-Welch (EM法)\n\n変化点検出 (CUSUM):\n  C_t = Σ_{i=1}^{t} (r_i - r̄)\n  変化点 = argmax|C_t - 線形補間|\n  モデル選択: BIC = -2·logL + p·log(n)\n\nカルマンフィルタ (Local Level):\n  状態方程式: θ_t = θ_{t-1} + η_t,  η ~ N(0, σ²_η)\n  観測方程式: y_t = θ_t + ε_t,  ε ~ N(0, σ²_ε)"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>a_ij</strong>: 状態iから状態jへの遷移確率</li>
          <li><strong>μ_k, σ²_k</strong>: 状態kでのリターンの平均と分散</li>
          <li><strong>θ_t</strong>: カルマンフィルタが推定する「隠れたトレンド」</li>
          <li><strong>σ²_η / σ²_ε</strong>: トレンドの変動幅とノイズの大きさの比。シグナル/ノイズ比を決定する</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>HMM（隠れマルコフモデル）</strong>: 観測できないレジーム（隠れ状態）が確率的に遷移し、各レジームに応じた分布からリターンが生成されるモデル</li>
          <li><strong>Baum-Welchアルゴリズム</strong>: HMMのパラメータ（遷移確率・出力分布）を最尤推定するEM法の一種</li>
          <li><strong>遷移行列</strong>: レジーム間の移行確率をまとめた行列。対角要素が大きいほどレジームが持続しやすい</li>
          <li><strong>CUSUM（累積和）</strong>: リターンの累積偏差を計算し、構造変化の位置を特定する手法</li>
          <li><strong>Binary Segmentation</strong>: CUSUMで検出した変化点で系列を分割し、各部分で再帰的に変化点を探索する方法</li>
          <li><strong>カルマンフィルタ</strong>: ノイズを含む観測データから隠れた状態変数（真のトレンド）を逐次推定する手法</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>HMM状態確率のグラフ</strong>: 各時点でどのレジーム（低ボラ/中ボラ/高ボラ）に属するかの確率。色が濃いレジームが支配的</li>
          <li><strong>遷移行列の対角要素 {">"} 0.95</strong>: レジームが安定して持続する（平均滞在日数 = 1/(1-a_ii)）</li>
          <li><strong>変化点の赤い垂直線</strong>: リターンの構造が統計的に有意に変わった時点。セグメント間の平均の差がレジーム変化の大きさ</li>
          <li><strong>カルマンの青い線</strong>: ノイズを除去した推定トレンド。移動平均より適応的でラグが少ない</li>
          <li><strong>カルマンの点線（95%信頼区間）</strong>: 区間が広い時期はトレンドの不確実性が高い</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>戦略切替</strong>: 低ボラレジームではトレンドフォロー、高ボラレジームではポジション縮小・ヘッジ強化</li>
          <li><strong>エントリー/イグジット</strong>: 高ボラ→低ボラへのレジーム遷移はエントリーの好機、逆はリスクオフのシグナル</li>
          <li><strong>変化点前後の分析</strong>: 変化点直後はトレンドが形成されやすく、モメンタム戦略が有効になりやすい</li>
          <li><strong>カルマントレンドの方向</strong>: 推定トレンドが上向きなら中長期の上昇基調、下向きなら下降基調と判断</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>HMMの局所解問題</strong>: Baum-Welchは初期値に依存し、局所最適に陥る場合がある。複数の初期値で検証すべき</li>
          <li><strong>状態数の選択</strong>: 本実装は3状態固定。実際の市場はより多くのレジームを持つ可能性がある</li>
          <li><strong>事後的バイアス</strong>: 全期間のデータを使ってレジームを推定するため、リアルタイム判定より精度が高く見えるバイアスがある</li>
          <li><strong>変化点のラグ</strong>: 変化点検出は事後的な分析であり、リアルタイムでの検出には遅れが生じる</li>
          <li><strong>カルマンフィルタの仮定</strong>: Local Levelモデルは最も単純な状態空間モデルであり、トレンドの傾きの変化は捉えられない</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
