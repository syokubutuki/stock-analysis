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
import {
  computeIntradayRange,
  rollingRange,
  computeRangeStats,
} from "../../lib/intraday-range";
import AnalysisGuide from "./AnalysisGuide";
import { setInitialVisibleRange } from "../../lib/chart-visible-range";
import type { PeriodKey } from "../../hooks/useAnalysisData";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

export default function IntradayRangeChart({ prices, period }: Props) {
  const histRef = useRef<HTMLDivElement>(null);
  const maRef = useRef<HTMLDivElement>(null);
  const histApiRef = useRef<IChartApi | null>(null);
  const maApiRef = useRef<IChartApi | null>(null);

  const points = useMemo(() => computeIntradayRange(prices), [prices]);
  const rolling20 = useMemo(() => rollingRange(points, 20), [points]);
  const stats = useMemo(() => computeRangeStats(points), [points]);

  // レンジヒストグラム
  useEffect(() => {
    if (!histRef.current || points.length < 2) return;
    if (histApiRef.current) histApiRef.current.remove();

    const chart = createChart(histRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: histRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    histApiRef.current = chart;

    const median = stats.medianRange;
    const series = chart.addSeries(HistogramSeries, { title: "日中レンジ (%)" });
    series.setData(
      points.map((p) => ({
        time: p.time as Time,
        value: p.normalizedRange * 100,
        color:
          p.normalizedRange > median * 2
            ? "rgba(239, 68, 68, 0.6)"
            : p.normalizedRange > median
            ? "rgba(249, 115, 22, 0.5)"
            : "rgba(59, 130, 246, 0.4)",
      }))
    );

    if (period) { setInitialVisibleRange(chart, prices, period); } else { chart.timeScale().fitContent(); }
    const handleResize = () => {
      if (histRef.current)
        chart.applyOptions({ width: histRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      histApiRef.current = null;
    };
  }, [points, stats.medianRange, prices, period]);

  // ローリングMA
  useEffect(() => {
    if (!maRef.current || rolling20.length < 2) return;
    if (maApiRef.current) maApiRef.current.remove();

    const chart = createChart(maRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: maRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    maApiRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 2,
      title: "レンジ 20日MA (%)",
    });
    series.setData(
      rolling20.map((r) => ({
        time: r.time as Time,
        value: r.rangeMA * 100,
      }))
    );

    if (period) { setInitialVisibleRange(chart, prices, period); } else { chart.timeScale().fitContent(); }
    const handleResize = () => {
      if (maRef.current)
        chart.applyOptions({ width: maRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      maApiRef.current = null;
    };
  }, [rolling20, prices, period]);

  const pct = (v: number) => (v * 100).toFixed(3);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">日中レンジ分析</h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-4">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均レンジ</div>
          <div className="font-mono font-medium">{pct(stats.meanRange)}%</div>
          <div className="text-gray-400">中央値: {pct(stats.medianRange)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">標準偏差</div>
          <div className="font-mono font-medium">{pct(stats.stdRange)}%</div>
          <div className="text-gray-400">
            最大: {pct(stats.maxRange)}%
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">レンジ自己相関 (lag=1)</div>
          <div className={`font-mono font-medium ${stats.rangeAutocorr > 0.3 ? "text-orange-600" : ""}`}>
            {stats.rangeAutocorr.toFixed(3)}
          </div>
          <div className="text-gray-400">
            {stats.rangeAutocorr > 0.3
              ? "強いクラスタリング"
              : stats.rangeAutocorr > 0.1
              ? "弱いクラスタリング"
              : "クラスタリングなし"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">レンジ↔出来高 相関</div>
          <div className={`font-mono font-medium ${Math.abs(stats.rangeVolumeCorr) > 0.3 ? "text-blue-600" : ""}`}>
            {stats.rangeVolumeCorr.toFixed(3)}
          </div>
          <div className="text-gray-400">
            {stats.rangeVolumeCorr > 0.3
              ? "正の相関 (出来高↑→レンジ↑)"
              : stats.rangeVolumeCorr < -0.3
              ? "負の相関"
              : "弱い相関"}
          </div>
        </div>
      </div>

      <div className="mb-2 text-xs text-gray-500 font-medium">
        日中レンジ (high-low)/open (
        <span className="text-blue-400">通常</span> /{" "}
        <span className="text-orange-400">中央値超</span> /{" "}
        <span className="text-red-400">中央値2倍超</span>)
      </div>
      <div ref={histRef} className="w-full rounded border border-gray-100 mb-4" />

      <div className="mb-2 text-xs text-gray-500 font-medium">
        レンジ 20日移動平均 (%)
      </div>
      <div ref={maRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="日中レンジ分析の読み方">
        <p>
          <span className="font-medium">正規化レンジ:</span>{" "}
          (high-low)/open。1日の中で価格がどれだけ動いたかを始値基準で表す。
          ログリターンの標準偏差では捉えられない「日中の全幅」を測定する。
        </p>
        <p>
          <span className="font-medium">レンジの自己相関:</span>{" "}
          正の値はボラティリティクラスタリング（大きなレンジの後に大きなレンジが続く傾向）を示す。
          0.3以上で有意なクラスタリング。
        </p>
        <p>
          <span className="font-medium">レンジ↔出来高の相関:</span>{" "}
          正の相関が一般的（出来高が増えると値幅も広がる）。
          相関が低い場合は、出来高なしに値幅が動く（流動性の低さ）可能性がある。
        </p>
        <p>
          <span className="font-medium">レンジの色分け:</span>{" "}
          中央値の2倍を超える赤い日は「異常に大きな値動き」。決算・イベントなどの確認推奨。
        </p>
      </AnalysisGuide>
    </div>
  );
}
