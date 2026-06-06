"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { logReturns } from "../../lib/transforms";
import { computeBOCPD } from "../../lib/bocpd";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function BOCPDChart({ prices, seriesMode }: Props) {
  const probChartRef = useRef<HTMLDivElement>(null);
  const probApiRef = useRef<IChartApi | null>(null);
  const heatmapRef = useRef<HTMLCanvasElement>(null);

  const { values, times } = extractSeries(prices, seriesMode);
  const needsTransform = seriesMode === "close" || seriesMode === "open";
  const lr = needsTransform ? logReturns(values) : values;
  const lrTimes = needsTransform ? times.slice(1) : times;

  const result = useMemo(
    () => computeBOCPD(lr, lrTimes),
    [prices, seriesMode]
  );

  // Change probability chart
  useEffect(() => {
    if (!probChartRef.current || result.changeProbability.length === 0) return;
    if (probApiRef.current) probApiRef.current.remove();

    const chart = createChart(probChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: probChartRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    probApiRef.current = chart;

    // Change probability as histogram
    const histSeries = chart.addSeries(HistogramSeries, {
      color: "rgba(239, 68, 68, 0.5)",
      priceLineVisible: false,
      lastValueVisible: false,
    });

    histSeries.setData(
      lrTimes.map((t, i) => ({
        time: t as Time,
        value: result.changeProbability[i],
        color: result.changeProbability[i] > 0.3
          ? "rgba(239, 68, 68, 0.8)"
          : "rgba(239, 68, 68, 0.2)",
      }))
    );

    // Max run length as line
    const rlSeries = chart.addSeries(LineSeries, {
      color: "#2563eb",
      lineWidth: 1,
      priceScaleId: "left",
      title: "Run Length",
      lastValueVisible: false,
      priceLineVisible: false,
    });

    chart.applyOptions({
      leftPriceScale: { visible: true },
    });

    rlSeries.setData(
      lrTimes.map((t, i) => ({
        time: t as Time,
        value: result.maxRunLength[i],
      }))
    );

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (probChartRef.current) chart.applyOptions({ width: probChartRef.current.clientWidth });
    });
    ro.observe(probChartRef.current);
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [result, lrTimes]);

  // Run-length posterior heatmap
  useEffect(() => {
    const canvas = heatmapRef.current;
    if (!canvas || result.runLengthPosterior.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const width = parent.clientWidth;
    const height = 180;
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

    const pad = { top: 20, right: 15, bottom: 25, left: 50 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const posterior = result.runLengthPosterior;
    const nTime = posterior.length;
    const nRL = posterior[0]?.length ?? 0;
    if (nTime === 0 || nRL === 0) return;

    // Find max probability for color scaling
    let maxProb = 0;
    for (const row of posterior) {
      for (const p of row) {
        if (p > maxProb) maxProb = p;
      }
    }
    if (maxProb === 0) return;

    const cellW = plotW / nTime;
    const cellH = plotH / Math.min(nRL, 50);
    const maxRL = Math.min(nRL, 50);

    for (let tx = 0; tx < nTime; tx++) {
      for (let rl = 0; rl < maxRL; rl++) {
        const prob = posterior[tx][rl] || 0;
        if (prob < 1e-6) continue;
        const intensity = Math.min(1, prob / maxProb);
        const r = Math.floor(255 * (1 - intensity));
        const g = Math.floor(255 * (1 - intensity * 0.7));
        const b = 255;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(
          pad.left + tx * cellW,
          pad.top + plotH - (rl + 1) * cellH,
          Math.ceil(cellW) + 1,
          Math.ceil(cellH) + 1
        );
      }
    }

    // Labels
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Run-Length Posterior ヒートマップ", width / 2, 14);
    ctx.textAlign = "right";
    ctx.fillText("0", pad.left - 4, pad.top + plotH);
    ctx.fillText(`${maxRL}`, pad.left - 4, pad.top + 8);
    ctx.save();
    ctx.translate(12, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("Run Length", 0, 0);
    ctx.restore();
  }, [result]);

  if (result.changeProbability.length === 0) return null;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">
        ベイズ変化点検出 (BOCPD)
      </h3>

      {result.changePoints.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {result.changePoints.slice(0, 5).map((cp, i) => (
            <span key={i} className="text-xs px-2 py-1 rounded bg-red-100 text-red-700">
              {cp.time} ({(cp.probability * 100).toFixed(0)}%)
            </span>
          ))}
        </div>
      )}

      <div ref={probChartRef} />
      <p className="text-xs text-gray-500 mt-1 mb-2">
        赤: 変化確率 P(r=0)、青線: MAP run length（右軸）
      </p>

      <canvas ref={heatmapRef} />

      <p className="text-xs text-gray-600 mt-2">{result.interpretation}</p>

      <AnalysisGuide title="ベイズ変化点検出(BOCPD)の詳細理論">
        <p className="font-medium text-gray-700">1. BOCPDとは</p>
        <p>
          Adams-MacKay(2007)のベイズオンライン変化点検出は、時系列の各時点で
          「今この瞬間に構造変化が起きている確率」を逐次的にベイズ推定します。
          CUSUM法と異なり、変化の確率を定量化できるのが特徴です。
          「天気が変わった確率」をリアルタイムで更新し続けるようなイメージです。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>{"Run length posterior: P(r_t | x_{1:t})"}</p>
        <p>{"Growth: P(r_t=r+1) ∝ P(r_{t-1}=r) * pi(x_t|r) * (1-H)"}</p>
        <p>{"Change: P(r_t=0) ∝ Sigma P(r_{t-1}=r) * pi(x_t|r) * H"}</p>
        <p>{"pi(x_t|r): Student-t予測分布（共役事前分布から導出）"}</p>
        <p>{"H: ハザード率（変化の事前確率 ≈ 1/250）"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>赤ヒストグラム: P(r=0) - その時点で構造変化が起きている確率</li>
          <li>0.3以上: 有意な変化点の候補</li>
          <li>青線: MAP run length - 現在のレジームの長さの推定値</li>
          <li>ヒートマップ: 全run length分布の時間推移（明るいほど確率が高い）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>変化点検出 → レジーム変化に対応したポートフォリオ調整のトリガー</li>
          <li>Run lengthが短い → 不安定な市場。ポジションサイズを縮小</li>
          <li>CUSUM法の結果と比較し、両者が一致する変化点はより信頼性が高い</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ハザード率Hの設定が結果に影響（デフォルト: 1/250 ≈ 年1回の変化を想定）</li>
          <li>Run lengthはmax 300で打ち切り、P &lt; 1e-8はpruning</li>
          <li>Normal-Inverse-Gamma事前分布を使用。実際の分布がこれから大きく逸脱する場合、検出力が低下</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
