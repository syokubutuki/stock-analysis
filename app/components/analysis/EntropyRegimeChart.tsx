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
import { permutationEntropy } from "../../lib/entropy";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

interface RegimePoint {
  time: string;
  pe: number;
  regime: "structured" | "random" | "transition";
}

function detectRegimes(values: number[], times: string[], window: number = 30): RegimePoint[] {
  const result: RegimePoint[] = [];
  const peValues: number[] = [];

  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    const pe = permutationEntropy(slice, 3, 1);
    peValues.push(pe);

    let regime: RegimePoint["regime"];
    if (peValues.length >= 5) {
      const recent = peValues.slice(-5);
      const trend = recent[recent.length - 1] - recent[0];
      if (pe < 0.75) {
        regime = "structured";
      } else if (Math.abs(trend) > 0.05) {
        regime = "transition";
      } else {
        regime = "random";
      }
    } else {
      regime = pe < 0.75 ? "structured" : "random";
    }

    result.push({ time: times[i], pe, regime });
  }
  return result;
}

export default function EntropyRegimeChart({ prices, seriesMode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const { values: closes, times: closeTimes } = extractSeries(prices, "close");
  const { values, times } = extractSeries(prices, seriesMode);

  const regimes = useMemo(() => detectRegimes(values, times, 30), [prices, seriesMode]);

  // Build a time→close lookup for price overlay (handles length mismatch across modes)
  const closeMap = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < closeTimes.length; i++) m.set(closeTimes[i], closes[i]);
    return m;
  }, [closes, closeTimes]);

  // 統計
  const stats = useMemo(() => {
    if (regimes.length === 0) return { structured: 0, random: 0, transition: 0 };
    const total = regimes.length;
    return {
      structured: regimes.filter((r) => r.regime === "structured").length / total,
      random: regimes.filter((r) => r.regime === "random").length / total,
      transition: regimes.filter((r) => r.regime === "transition").length / total,
    };
  }, [regimes]);

  useEffect(() => {
    if (!containerRef.current || regimes.length === 0) return;
    if (chartRef.current) chartRef.current.remove();

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 300,
      rightPriceScale: { visible: true },
      leftPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    // 価格 (regimeのtimeに合わせて対応するclose値を取得)
    const priceData = regimes
      .map((r) => ({ time: r.time as Time, value: closeMap.get(r.time) }))
      .filter((d): d is { time: Time; value: number } => d.value !== undefined);
    const priceSeries = chart.addSeries(LineSeries, {
      color: "#333",
      lineWidth: 1,
      title: "価格",
      priceScaleId: "right",
    });
    priceSeries.setData(priceData);

    // PE
    const peSeries = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 1,
      title: "PE (30日)",
      priceScaleId: "left",
    });
    peSeries.setData(
      regimes.map((r) => ({ time: r.time as Time, value: r.pe }))
    );

    // レジーム背景: HistogramSeriesで可視化
    const regimeHist = chart.addSeries(HistogramSeries, {
      priceScaleId: "regime",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("regime").applyOptions({ visible: false });
    regimeHist.setData(
      regimes.map((r) => ({
        time: r.time as Time,
        value: 1,
        color: r.regime === "structured" ? "rgba(34,197,94,0.25)"
          : r.regime === "transition" ? "rgba(234,179,8,0.2)"
          : "rgba(156,163,175,0.1)",
      }))
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
  }, [regimes, closeMap]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">エントロピーレジーム検出</h3>

      <div className="grid grid-cols-3 gap-3 text-xs mb-3">
        <div className="p-2 bg-green-50 rounded border border-green-200">
          <div className="text-green-700">構造化レジーム</div>
          <div className="font-mono font-medium text-sm text-green-600">
            {(stats.structured * 100).toFixed(1)}%
          </div>
          <div className="text-green-500">PE {"<"} 0.75</div>
        </div>
        <div className="p-2 bg-gray-50 rounded border border-gray-200">
          <div className="text-gray-700">ランダムレジーム</div>
          <div className="font-mono font-medium text-sm">
            {(stats.random * 100).toFixed(1)}%
          </div>
          <div className="text-gray-500">PE ≥ 0.75, 安定</div>
        </div>
        <div className="p-2 bg-yellow-50 rounded border border-yellow-200">
          <div className="text-yellow-700">遷移レジーム</div>
          <div className="font-mono font-medium text-sm text-yellow-600">
            {(stats.transition * 100).toFixed(1)}%
          </div>
          <div className="text-yellow-500">PE急変中</div>
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-2">
        価格(右軸) + ローリングPE(左軸, 30日窓) — 緑マーカー=構造化レジーム
      </div>
      <div ref={containerRef} className="w-full rounded border border-gray-100" />

      <div className="mt-2 flex gap-3 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-gray-800" /> 価格</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-purple-500" /> PE</span>
        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-green-400 rounded-sm" /> 構造化</span>
      </div>

      <AnalysisGuide title="エントロピーレジーム検出の理論">
        <p className="font-medium text-gray-700">1. レジーム分類</p>
        <p>ローリングPE(30日)の値と変化率からレジームを3分類します:</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="text-green-600 font-medium">構造化 (PE {"<"} 0.75):</span> パターンが明確。テクニカル分析やアルゴリズム戦略が有効。</li>
          <li><span className="text-gray-600 font-medium">ランダム (PE ≥ 0.75, 安定):</span> 効率的市場。アルファの獲得が困難。</li>
          <li><span className="text-yellow-600 font-medium">遷移 (PE急変中):</span> レジームが変化中。リスク管理を強化すべき。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">2. 直感的な例え</p>
        <p>サイコロを想像してください。構造化レジームは偏ったサイコロ(特定の目が出やすい)、ランダムレジームは公平なサイコロ、遷移は重りが移動中のサイコロです。</p>

        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>構造化レジームの開始: トレンドフォロー/モメンタム戦略のエントリー</li>
          <li>ランダムレジーム: ポジションサイズ縮小、パッシブ運用</li>
          <li>遷移レジーム: ストップロス厳格化、ヘッジ強化</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
