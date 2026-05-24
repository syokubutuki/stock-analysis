"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { powerSpectrum, estimateSpectralSlope } from "../../lib/frequency";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function PowerSpectrum({ prices, seriesMode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const { values: lr } = extractSeries(prices, seriesMode);
  const spectrum = powerSpectrum(lr);
  const { slope } = estimateSpectralSlope(spectrum);

  useEffect(() => {
    if (!containerRef.current || spectrum.length === 0) return;

    if (chartRef.current) chartRef.current.remove();

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 220,
      rightPriceScale: { visible: true, mode: 1 },
      timeScale: { timeVisible: false, visible: false },
    });
    chartRef.current = chart;

    // パワースペクトルをlog-logで表示
    // x軸: 周期(大→小 = 低周波→高周波) として表示
    // lightweight-charts はtime seriesなので、indexを使う
    const sorted = [...spectrum].sort((a, b) => b.period - a.period);
    const series = chart.addSeries(LineSeries, {
      color: "#2563eb",
      lineWidth: 1,
      title: "パワースペクトル(log)",
    });

    // 連番のダミー日付を使用
    const baseDate = new Date(2000, 0, 1);
    series.setData(
      sorted.map((s, i) => {
        const d = new Date(baseDate.getTime() + i * 86400000);
        const time = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return {
          time: time as Time,
          value: Math.log10(s.power + 1e-20),
        };
      })
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current)
        chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [prices]);

  // 主要周期の検出（パワー上位5）
  const topPeriods = [...spectrum]
    .filter((s) => s.period >= 3)
    .sort((a, b) => b.power - a.power)
    .slice(0, 5);

  let noiseType: string;
  if (slope > -0.5) noiseType = "ホワイトノイズ寄り (ランダム)";
  else if (slope > -1.5) noiseType = "ピンクノイズ (1/f) — 長期記憶あり";
  else noiseType = "レッドノイズ (1/f²) — 強い低周波成分";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">パワースペクトル (FFT)</h3>
      <div ref={containerRef} className="w-full rounded border border-gray-100" />

      <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">スペクトル傾き</div>
          <div className="font-mono font-medium text-sm">{slope.toFixed(3)}</div>
          <div className="text-gray-500 mt-1">{noiseType}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500 mb-1">卓越周期 (日)</div>
          {topPeriods.map((p, i) => (
            <div key={i} className="font-mono">
              {p.period.toFixed(1)}日
              <span className="text-gray-400 ml-1">
                (P={p.power.toExponential(1)})
              </span>
            </div>
          ))}
        </div>
      </div>

      <AnalysisGuide title="パワースペクトルの読み方">
        <p><span className="font-medium">パワースペクトルとは:</span> 時系列データをFFT(高速フーリエ変換)で周波数領域に変換し、「どの周期の成分がどれだけの強さ(パワー)を持つか」を示したものです。横軸が周期(日数)、縦軸がパワー(対数スケール)です。</p>
        <p><span className="font-medium">スペクトル傾き(log-logでの回帰直線の傾き):</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">傾き ≈ 0 (ホワイトノイズ):</span> 全ての周波数に均等なパワー。完全にランダムな系列。予測は困難。</li>
          <li><span className="font-medium">傾き ≈ −1 (ピンクノイズ / 1/f):</span> 低周波ほどパワーが大きい。長期記憶(過去の動きが将来に影響)を示唆。多くの金融時系列はこの付近。</li>
          <li><span className="font-medium">傾き ≈ −2 (レッドノイズ / 1/f²):</span> ランダムウォークのスペクトル。ブラウン運動に相当。強い低周波成分があり、長期トレンドが支配的。</li>
        </ul>
        <p><span className="font-medium">卓越周期:</span> パワーが特に大きい周期です。もし特定の周期にピークがあれば、その銘柄に周期的なパターンが存在する可能性があります。ただし、金融データではノイズが大きいため、ピークが統計的に有意かどうかは慎重に判断する必要があります。</p>
        <p><span className="font-medium">トレードへの活用:</span> 傾きが−1付近(ピンクノイズ)であれば、トレンドフォロー戦略が有効な可能性があります。0に近ければ平均回帰戦略が候補になります。卓越周期が明確にあれば、そのサイクルに合わせた売買タイミングの参考になりえます。</p>
      </AnalysisGuide>
    </div>
  );
}
