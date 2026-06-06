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
import { computeHVG } from "../../lib/hvg";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function HVGChart({ prices, seriesMode }: Props) {
  const degreeRef = useRef<HTMLDivElement>(null);
  const degreeChartRef = useRef<IChartApi | null>(null);
  const distCanvasRef = useRef<HTMLCanvasElement>(null);

  const { values, times } = extractSeries(prices, seriesMode);
  const needsTransform = seriesMode === "close" || seriesMode === "open";
  const lr = needsTransform ? logReturns(values) : values;
  const lrTimes = needsTransform ? times.slice(1) : times;

  const hvg = useMemo(() => computeHVG(lr, 50), [prices, seriesMode]);

  // Degree time series
  useEffect(() => {
    if (!degreeRef.current) return;
    if (degreeChartRef.current) degreeChartRef.current.remove();

    const chart = createChart(degreeRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: degreeRef.current.clientWidth,
      height: 160,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    degreeChartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 1,
      title: "HVG degree",
    });
    series.setData(
      hvg.degreeSeries.map((v, i) => ({
        time: lrTimes[Math.min(i, lrTimes.length - 1)] as Time,
        value: v,
      }))
    );

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (degreeRef.current) chart.applyOptions({ width: degreeRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); degreeChartRef.current = null; };
  }, [prices, hvg]);

  // Degree distribution
  useEffect(() => {
    const canvas = distCanvasRef.current;
    if (!canvas || hvg.degreeDistribution.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = 280;
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

    const dist = hvg.degreeDistribution.filter((d) => d.count > 0);
    const maxK = Math.max(...dist.map((d) => d.degree));
    const minLogP = Math.min(...dist.map((d) => d.logCount));
    const maxLogP = 0;
    const kRange = maxK || 1;
    const logRange = maxLogP - minLogP || 1;

    // Points
    ctx.fillStyle = "#8b5cf6";
    for (const d of dist) {
      const x = margin.left + (d.degree / kRange) * plotW;
      const y = margin.top + plotH - ((d.logCount - minLogP) / logRange) * plotH;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, 2 * Math.PI);
      ctx.fill();
    }

    // Theoretical line (exponential with λ = ln(3/2))
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (let k = 1; k <= maxK; k++) {
      const logP = -hvg.theoreticalLambda * k;
      const x = margin.left + (k / kRange) * plotW;
      const y = margin.top + plotH - ((logP - minLogP) / logRange) * plotH;
      if (k === 1) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Labels
    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("HVG 次数分布", width / 2, 12);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("degree k", margin.left + plotW / 2, height - 5);
    ctx.fillStyle = "#ef4444";
    ctx.textAlign = "left";
    ctx.fillText(`理論値 λ=${hvg.theoreticalLambda.toFixed(3)}`, margin.left + 5, margin.top + 15);
    ctx.fillStyle = "#8b5cf6";
    ctx.fillText(`実測 λ=${hvg.lambda.toFixed(3)}`, margin.left + 5, margin.top + 28);
  }, [hvg]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">Horizontal Visibility Graph (HVG)</h3>
      <p className="text-xs text-gray-500 mb-3">水平可視性グラフ — ランダム性の理論的ベースラインとの比較</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均次数</div>
          <div className="font-bold">{hvg.meanDegree.toFixed(2)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">λ (実測)</div>
          <div className="font-bold">{hvg.lambda.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">λ (理論: ランダム)</div>
          <div className="font-bold">{hvg.theoreticalLambda.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">非線形性</div>
          <div className="font-bold">{hvg.isNonlinear ? "検出" : "なし"}</div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <div className="text-xs text-gray-500 mb-1">HVG次数の時系列</div>
          <div ref={degreeRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <canvas ref={distCanvasRef} className="rounded border border-gray-100" />
        </div>
      </div>

      <AnalysisGuide title="HVG（水平可視グラフ）の詳細理論">
        <p className="font-medium text-gray-700">1. HVGとは</p>
        <p>HVG（Horizontal Visibility Graph）は、時系列データをネットワーク（グラフ）に変換する手法です。NVG（Natural Visibility Graph）の簡略版で、計算が高速かつ理論的な基準値が既知であるという利点があります。</p>
        <p className="mt-1">日常的な例えでいうと、一列に並んだ高さの異なるビルを想像してください。あるビル同士が「水平に見通せる」（間にあるビルが両方より低い）場合に線で結びます。こうしてできた「見通しネットワーク」が HVG です。ランダムな高さのビル群と、規則的に並んだビル群ではネットワークの形が大きく異なります。</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"2点 i, j (i < j) が接続される条件:\n∀k (i < k < j): x_k < min(x_i, x_j)\n\n次数分布の指数減衰フィット:\nP(k) ∝ exp(-λk)\n\nランダム系列の理論値: λ_random = ln(3/2) ≈ 0.405"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>x_i, x_j</strong>: 時刻 i, j のデータ値（対数リターン）</li>
          <li><strong>k</strong>: ノードの次数（接続されている辺の数）</li>
          <li><strong>λ</strong>: 次数分布の指数減衰率。小さいほど長距離接続が多い</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>次数（degree）</strong>: あるノードに接続されているエッジの数。次数が高いノードは多くの過去・未来のデータ点と「見通せる」状態にある</li>
          <li><strong>次数分布</strong>: ネットワーク全体での次数の出現頻度。ランダム系列では指数分布、長期記憶のある系列ではべき乗則に近づく</li>
          <li><strong>指数減衰率 λ</strong>: 次数分布がどれだけ急速に減衰するかを表すパラメータ。ランダムウォークの理論値 ln(3/2)≈0.405 との比較が鍵</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>λ ≈ 0.405（理論値付近）</strong>: 系列はランダムウォークに近い。価格変動に特別な構造がない</li>
          <li><strong>λ {">"} 0.405</strong>: 次数分布がより急速に減衰。短距離接続が支配的で、相関の減衰が速い（反平均回帰的）</li>
          <li><strong>λ {"<"} 0.405</strong>: 長距離接続が多い。持続的な構造（トレンドや周期性）が存在する</li>
          <li><strong>次数時系列のスパイク</strong>: その時点のデータが多くの他の時点から「見通せる」＝局所的な極値（高値・安値）である可能性</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>トレンド持続性の判定</strong>: λが理論値より明確に小さい場合、価格にトレンド持続性があり、モメンタム戦略が有効な可能性</li>
          <li><strong>レジーム変化の検出</strong>: ローリングでλを計算し、理論値を跨ぐ変化はランダム↔トレンドのレジーム転換を示唆</li>
          <li><strong>DFA Hurst指数との併用</strong>: HVGのλとDFAのHurst指数が共にトレンド持続性を示す場合、信頼度が高まる</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>データ長依存</strong>: 短い系列（100点未満）ではλの推定が不安定。少なくとも500点以上が望ましい</li>
          <li><strong>NVGとの違い</strong>: HVGはNVGより接続条件が緩く、情報量はやや少ない。両者を比較することでより堅牢な結論が得られる</li>
          <li><strong>非定常性への感度</strong>: トレンドの存在自体がλを変化させるため、リターン系列（定常化済み）に適用するのが基本</li>
          <li><strong>理論値の前提</strong>: λ=ln(3/2)はiid（独立同分布）の理論値であり、実際の金融データは厳密にはiidでない点に注意</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
