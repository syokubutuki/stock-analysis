"use client";

import { useEffect, useRef, useMemo } from "react";
import { createChart, LineSeries, createSeriesMarkers, IChartApi } from "lightweight-charts";
import type { Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { computeLombScargle } from "../../lib/lomb-scargle";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function LombScargleChart({ prices, seriesMode }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);

  const { values, times } = extractSeries(prices, seriesMode);

  const result = useMemo(() => computeLombScargle(values, times), [values, times]);

  useEffect(() => {
    if (!chartRef.current || result.spectrum.length === 0) return;
    if (chartApiRef.current) chartApiRef.current.remove();

    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: {
        vertLines: { color: "#f0f0f0" },
        horzLines: { color: "#f0f0f0" },
      },
      width: chartRef.current.clientWidth,
      height: 250,
      rightPriceScale: { autoScale: true },
      timeScale: {
        rightOffset: 5,
        tickMarkFormatter: (t: number) => `${Math.round(t)}d`,
      },
    });
    chartApiRef.current = chart;

    // スペクトルデータ（周期降順→横軸が周期の短い方から長い方へ）
    const sorted = [...result.spectrum]
      .filter((s) => s.period >= 2 && s.period <= 500)
      .sort((a, b) => a.period - b.period);

    const series = chart.addSeries(LineSeries, {
      color: "#7c3aed",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    series.setData(
      sorted.map((s) => ({
        time: Math.round(s.period) as unknown as Time,
        value: s.power,
      }))
    );

    // ピークマーカー
    if (result.peakPeriods.length > 0) {
      const markers = result.peakPeriods
        .filter((p) => p.period >= 2 && p.period <= 500)
        .map((p) => ({
          time: Math.round(p.period) as unknown as Time,
          position: "aboveBar" as const,
          shape: "circle" as const,
          color: p.fap < 0.01 ? "#dc2626" : p.fap < 0.05 ? "#f59e0b" : "#9ca3af",
          text: `${Math.round(p.period)}d`,
          size: 1.5,
        }));
      createSeriesMarkers(series, markers);
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth });
    });
    ro.observe(chartRef.current);
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [result]);

  if (result.spectrum.length === 0) return null;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">
        Lomb-Scargle ペリオドグラム
      </h3>

      {result.peakPeriods.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {result.peakPeriods.slice(0, 5).map((p, i) => (
            <span
              key={i}
              className={`text-xs px-2 py-1 rounded font-mono ${
                p.fap < 0.01
                  ? "bg-red-100 text-red-700"
                  : p.fap < 0.05
                  ? "bg-yellow-100 text-yellow-700"
                  : "bg-gray-100 text-gray-600"
              }`}
            >
              {Math.round(p.period)}日 (power={p.power.toFixed(1)}, FAP=
              {p.fap < 0.001 ? "<0.001" : p.fap.toFixed(3)})
            </span>
          ))}
        </div>
      )}

      <div ref={chartRef} />

      <p className="text-xs text-gray-500 mt-1 mb-1">
        横軸: 周期（営業日）、縦軸: Lomb-Scargleパワー
      </p>
      <p className="text-xs text-gray-600">{result.interpretation}</p>

      <AnalysisGuide title="Lomb-Scargleペリオドグラムの詳細理論">
        <p className="font-medium text-gray-700">1. Lomb-Scargle法とは</p>
        <p>
          不等間隔で観測されたデータの周期成分を検出するスペクトル推定手法です。
          標準的なFFT（高速フーリエ変換）は等間隔データを前提としますが、
          株式市場には休場日（土日・祝日）があり、厳密には不等間隔です。
          Lomb-Scargle法はこの問題を解決し、より正確な周期検出を可能にします。
          天文学で星の光度変動の周期を検出するために開発された手法です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>{"P(omega) = (1/2){[Sigma(x_j cos(omega(t_j-tau)))^2 / Sigma cos^2] + [Sigma(x_j sin(omega(t_j-tau)))^2 / Sigma sin^2]}"}</p>
        <p>{"tau = arctan(Sigma sin(2omega*t_j) / Sigma cos(2omega*t_j)) / (2omega)"}</p>
        <p>tauは位相補正項で、時間シフトに対する不変性を保証します。</p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>パワーのピーク: その周期の成分が強いことを示す</li>
          <li>FAP (False Alarm Probability): ピークがノイズで偶然生じる確率。小さいほど有意</li>
          <li>赤マーカー: FAP &lt; 1%（高度に有意）</li>
          <li>黄マーカー: FAP &lt; 5%（有意）</li>
          <li>灰マーカー: FAP &gt; 5%（有意でない）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>有意な周期が検出された場合、その周期でのサイクルトレードを検討</li>
          <li>約5日(1週間)の周期: 週次パターン（曜日効果）の存在を示唆</li>
          <li>約20日(1ヶ月)の周期: 月次オプション満期やリバランスの影響</li>
          <li>約63日(四半期)の周期: 決算サイクルの影響</li>
          <li>FFTの結果と比較し、一致する周期はより信頼性が高い</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>株式データの休場日は月に数日程度であり、FFTとの差は小さい場合が多い</li>
          <li>非定常な時系列では周期成分が時変的であり、固定的な周期の仮定は限定的</li>
          <li>FAP計算は独立周波数数Mの推定に依存し、近似的な値である</li>
          <li>ウェーブレット解析と併用すると、周期の時変性も把握できる</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
