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
import { computePersistentHomology, fisherRaoDistance } from "../../lib/tda";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function TDAChart({ prices, seriesMode }: Props) {
  const diagramCanvasRef = useRef<HTMLCanvasElement>(null);
  const bettiCanvasRef = useRef<HTMLCanvasElement>(null);
  const frRef = useRef<HTMLDivElement>(null);
  const frChartRef = useRef<IChartApi | null>(null);

  const { values: lr, times } = extractSeries(prices, seriesMode);

  const tda = useMemo(() => computePersistentHomology(lr), [prices, seriesMode]);
  const fr = useMemo(() => fisherRaoDistance(lr, Math.min(60, Math.floor(lr.length / 4))), [prices, seriesMode]);

  // Persistence diagram
  useEffect(() => {
    const canvas = diagramCanvasRef.current;
    if (!canvas || tda.diagram.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const size = 250;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { left: 40, right: 10, top: 20, bottom: 30 };
    const plotW = size - margin.left - margin.right;
    const plotH = size - margin.top - margin.bottom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);

    const maxVal = tda.maxPersistence * 1.1 || 1;

    // Diagonal line (birth = death)
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top + plotH);
    ctx.lineTo(margin.left + plotW, margin.top);
    ctx.stroke();

    // Points
    for (const p of tda.diagram) {
      const x = margin.left + (p.birth / maxVal) * plotW;
      const y = margin.top + plotH - (Math.min(p.death, maxVal) / maxVal) * plotH;
      ctx.fillStyle = p.dimension === 0 ? "#3b82f6" : "#ef4444";
      ctx.beginPath();
      ctx.arc(x, y, p.persistence > tda.maxPersistence * 0.3 ? 5 : 3, 0, 2 * Math.PI);
      ctx.fill();
    }

    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Persistence Diagram", size / 2, 12);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("birth", size / 2, size - 5);
    ctx.save();
    ctx.translate(10, margin.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("death", 0, 0);
    ctx.restore();

    // Legend
    ctx.fillStyle = "#3b82f6";
    ctx.fillRect(margin.left + 5, margin.top + 5, 8, 8);
    ctx.fillStyle = "#374151";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("H₀ (成分)", margin.left + 16, margin.top + 13);
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(margin.left + 5, margin.top + 18, 8, 8);
    ctx.fillStyle = "#374151";
    ctx.fillText("H₁ (ループ)", margin.left + 16, margin.top + 26);
  }, [tda]);

  // Betti curves
  useEffect(() => {
    const canvas = bettiCanvasRef.current;
    if (!canvas || tda.thresholds.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = 300;
    const height = 180;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { left: 40, right: 10, top: 20, bottom: 25 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const maxBetti = Math.max(...tda.bettiCurve0, ...tda.bettiCurve1, 1);
    const nT = tda.thresholds.length;

    // β₀
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    tda.bettiCurve0.forEach((v, i) => {
      const x = margin.left + (i / (nT - 1)) * plotW;
      const y = margin.top + plotH - (v / maxBetti) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // β₁
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 2;
    ctx.beginPath();
    tda.bettiCurve1.forEach((v, i) => {
      const x = margin.left + (i / (nT - 1)) * plotW;
      const y = margin.top + plotH - (v / maxBetti) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Betti Curves", width / 2, 12);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("ε (threshold)", width / 2, height - 5);

    // Legend
    ctx.fillStyle = "#3b82f6";
    ctx.fillText("β₀", margin.left + 30, margin.top + 15);
    ctx.fillStyle = "#ef4444";
    ctx.fillText("β₁", margin.left + 60, margin.top + 15);
  }, [tda]);

  // Fisher-Rao distance
  useEffect(() => {
    if (!frRef.current || fr.distances.length === 0) return;
    if (frChartRef.current) frChartRef.current.remove();

    const chart = createChart(frRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: frRef.current.clientWidth,
      height: 130,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    frChartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 2,
      title: "Fisher-Rao距離",
    });
    series.setData(
      fr.times
        .filter((t) => t < times.length)
        .map((t, i) => ({
          time: times[t] as Time,
          value: fr.distances[i],
        }))
    );
    chart.timeScale().fitContent();
    const handleResize = () => {
      if (frRef.current) chart.applyOptions({ width: frRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); frChartRef.current = null; };
  }, [prices, fr]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">位相的データ解析 (TDA) / Fisher-Rao距離</h3>
      <p className="text-xs text-gray-500 mb-3">パーシステントホモロジーと情報幾何学的レジーム検出</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">H₀特徴数</div>
          <div className="font-bold">{tda.diagram.filter((p) => p.dimension === 0).length}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">H₁特徴数 (ループ)</div>
          <div className="font-bold">{tda.diagram.filter((p) => p.dimension === 1).length}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">最大persistence</div>
          <div className="font-bold">{tda.maxPersistence.toFixed(4)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">FR変化点</div>
          <div className="font-bold">{fr.changePoints.length}箇所</div>
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-1">{tda.interpretation}</div>

      <div className="flex flex-col sm:flex-row gap-3 mb-3">
        <canvas ref={diagramCanvasRef} className="rounded border border-gray-100" />
        <canvas ref={bettiCanvasRef} className="rounded border border-gray-100" />
      </div>

      <div className="text-xs text-gray-500 mb-1">Fisher-Rao距離 — リターン分布の変化速度 (スパイク=レジーム変化)</div>
      <div ref={frRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="TDA・Fisher-Rao分析の詳細理論">
        <p className="font-medium text-gray-700">1. この分析の概要</p>
        <p>位相的データ解析（TDA）は、データの「形」を数学的に分析する手法です。株価の時系列を高次元空間に埋め込み、そこに現れる「穴」や「ループ」の構造を検出します。Fisher-Rao距離はリターン分布の形状変化を測定し、レジーム転換を検出します。</p>
        <p className="mt-1">地図の等高線に例えると、水位を上げていったときに「島が合体する」（H₀：接続成分の消滅）や「湖ができる」（H₁：ループの出現）タイミングを記録するのがパーシステントホモロジーです。長く残る島や湖は「本物の地形」、すぐ消えるものは「ノイズ」です。</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"パーシステントホモロジー:\n  Vietoris-Rips複体: σ ∈ VR(ε) ⟺ d(x_i,x_j) ≤ ε, ∀ x_i,x_j ∈ σ\n  各特徴の寿命: persistence = death - birth\n\nBetti数: β_k = rank(H_k) (k次ホモロジー群のランク)\n  β₀: 連結成分の数, β₁: 独立なループの数\n\nFisher-Rao距離 (Hellinger近似):\n  d_H(p,q) = √(1 - Σ √(p_i · q_i))"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>ε</strong>: 閾値パラメータ。点間の距離がε以下なら接続される</li>
          <li><strong>birth / death</strong>: 位相的特徴が「生まれる」εと「消える」εの値</li>
          <li><strong>persistence</strong>: 特徴の寿命（death - birth）。大きいほど頑健な構造</li>
          <li><strong>d_H</strong>: Hellinger距離。2つの確率分布の類似度を測る</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>パーシステントホモロジー</strong>: 閾値εを連続的に変化させたときに現れる位相的特徴（穴やループ）の「出現と消滅」を追跡する手法</li>
          <li><strong>Persistence Diagram</strong>: 各位相的特徴を(birth, death)の座標にプロットした図。対角線から遠いほど頑健な構造</li>
          <li><strong>H₀（0次ホモロジー）</strong>: 接続成分の数。「独立した島の数」に相当</li>
          <li><strong>H₁（1次ホモロジー）</strong>: 独立なループの数。周期的構造やサイクルの存在を示す</li>
          <li><strong>Betti曲線</strong>: εの関数としてBetti数をプロットした曲線。位相的特徴の変化を1次元で可視化</li>
          <li><strong>Fisher-Rao距離</strong>: 情報幾何学に基づく確率分布間の距離。分布の「形の違い」を測定する</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>Persistence Diagramの対角線から遠い点</strong>: 消えにくい頑健な構造。株価の力学系に本質的なトポロジー</li>
          <li><strong>対角線近傍の点</strong>: ノイズ。短命な位相的特徴で、分析上は無視してよい</li>
          <li><strong>β₀の急減</strong>: 複数のクラスター（独立した状態群）が1つに統合される閾値。アトラクタのスケールを示す</li>
          <li><strong>β₁のピーク</strong>: ループ（周期的構造）が最も多く存在する閾値。市場に周期的パターンがある証拠</li>
          <li><strong>Fisher-Rao距離のスパイク</strong>: リターン分布の形状が急変した時点。レジーム転換（ボラティリティシフト、トレンド反転）を示唆</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>構造変化の早期検出</strong>: Fisher-Rao距離のスパイクは、移動平均クロスなど遅行指標より早くレジーム変化を検出できる場合がある</li>
          <li><strong>周期構造の確認</strong>: β₁が有意に高い場合、周期戦略（サイクル投資）が有効な可能性。Betti曲線のピーク位置から周期のスケールを読み取れる</li>
          <li><strong>異常検知</strong>: Persistence Diagramに通常と異なるパターン（異常に長命な特徴）が現れた場合、市場構造の変化を警戒</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>埋め込みパラメータ依存</strong>: Takens埋め込みの次元と遅延時間の選択で結果が変わる。最適パラメータの事前選定が重要</li>
          <li><strong>計算コスト</strong>: パーシステントホモロジーの計算量はデータ点数に対して超線形に増加。大規模データでは近似が必要</li>
          <li><strong>解釈の難しさ</strong>: 位相的特徴と経済的意味の対応は直感的でない場合がある。他の分析と併用して判断すべき</li>
          <li><strong>Fisher-Rao距離の窓長</strong>: 比較する分布の推定窓長によって感度が変わる。短すぎると推定が不安定、長すぎると変化の検出が遅れる</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
