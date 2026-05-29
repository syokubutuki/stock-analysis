"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeRSI,
  computeMACD,
  computeBollinger,
  detectSignals,
} from "../../lib/technical-indicators";
import { setInitialVisibleRange } from "../../lib/chart-visible-range";
import type { PeriodKey } from "../../hooks/useAnalysisData";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

type IndicatorTab = "rsi" | "macd" | "bollinger";

export default function TechnicalIndicators({ prices, period }: Props) {
  const [tab, setTab] = useState<IndicatorTab>("rsi");
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);

  const rsi = useMemo(() => computeRSI(prices, 14), [prices]);
  const macd = useMemo(() => computeMACD(prices), [prices]);
  const bollinger = useMemo(() => computeBollinger(prices, 20, 2), [prices]);
  const signals = useMemo(
    () => detectSignals(prices, rsi, macd, bollinger),
    [prices, rsi, macd, bollinger]
  );

  useEffect(() => {
    if (!chartRef.current) return;
    if (apiRef.current) apiRef.current.remove();

    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 280,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;

    if (tab === "rsi" && rsi.length > 0) {
      const series = chart.addSeries(LineSeries, {
        color: "#8b5cf6",
        lineWidth: 2,
        title: "RSI (14)",
      });
      series.setData(
        rsi.map((r) => ({ time: r.time as Time, value: r.value }))
      );

      // 70/30 lines using additional series
      const line70 = chart.addSeries(LineSeries, {
        color: "rgba(239, 68, 68, 0.4)",
        lineWidth: 1,
        lineStyle: 2,
        title: "70",
      });
      line70.setData(
        rsi.map((r) => ({ time: r.time as Time, value: 70 }))
      );

      const line30 = chart.addSeries(LineSeries, {
        color: "rgba(34, 197, 94, 0.4)",
        lineWidth: 1,
        lineStyle: 2,
        title: "30",
      });
      line30.setData(
        rsi.map((r) => ({ time: r.time as Time, value: 30 }))
      );
    }

    if (tab === "macd" && macd.length > 0) {
      const macdSeries = chart.addSeries(LineSeries, {
        color: "#3b82f6",
        lineWidth: 2,
        title: "MACD",
      });
      macdSeries.setData(
        macd.map((m) => ({ time: m.time as Time, value: m.macd }))
      );

      const signalSeries = chart.addSeries(LineSeries, {
        color: "#f59e0b",
        lineWidth: 1,
        title: "Signal",
      });
      signalSeries.setData(
        macd.map((m) => ({ time: m.time as Time, value: m.signal }))
      );

      const histSeries = chart.addSeries(HistogramSeries, {
        title: "Histogram",
      });
      histSeries.setData(
        macd.map((m) => ({
          time: m.time as Time,
          value: m.histogram,
          color:
            m.histogram >= 0
              ? "rgba(38, 166, 154, 0.5)"
              : "rgba(239, 83, 80, 0.5)",
        }))
      );
    }

    if (tab === "bollinger" && bollinger.length > 0) {
      const upperSeries = chart.addSeries(LineSeries, {
        color: "rgba(239, 68, 68, 0.6)",
        lineWidth: 1,
        title: "Upper Band",
      });
      upperSeries.setData(
        bollinger.map((b) => ({ time: b.time as Time, value: b.upper }))
      );

      const middleSeries = chart.addSeries(LineSeries, {
        color: "#6b7280",
        lineWidth: 1,
        title: "SMA(20)",
      });
      middleSeries.setData(
        bollinger.map((b) => ({ time: b.time as Time, value: b.middle }))
      );

      const lowerSeries = chart.addSeries(LineSeries, {
        color: "rgba(34, 197, 94, 0.6)",
        lineWidth: 1,
        title: "Lower Band",
      });
      lowerSeries.setData(
        bollinger.map((b) => ({ time: b.time as Time, value: b.lower }))
      );

      const closeSeries = chart.addSeries(LineSeries, {
        color: "#1e293b",
        lineWidth: 2,
        title: "Close",
      });
      closeSeries.setData(
        bollinger.map((b) => ({ time: b.time as Time, value: b.close }))
      );
    }

    if (period) { setInitialVisibleRange(chart, prices, period); } else { chart.timeScale().fitContent(); }

    const handleResize = () => {
      if (chartRef.current)
        chart.applyOptions({ width: chartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      apiRef.current = null;
    };
  }, [tab, rsi, macd, bollinger, prices, period]);

  // Current values
  const lastRSI = rsi.length > 0 ? rsi[rsi.length - 1].value : null;
  const lastMACD = macd.length > 0 ? macd[macd.length - 1] : null;
  const lastBB = bollinger.length > 0 ? bollinger[bollinger.length - 1] : null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">テクニカル指標</h3>
        <div className="flex gap-1">
          {([
            ["rsi", "RSI"],
            ["macd", "MACD"],
            ["bollinger", "ボリンジャー"],
          ] as [IndicatorTab, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                tab === key
                  ? "bg-violet-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Signal alerts */}
      {signals.length > 0 && (
        <div className="mb-3 space-y-1">
          {signals.map((s, i) => (
            <div
              key={i}
              className={`text-xs px-3 py-1.5 rounded flex items-center gap-2 ${
                s.type === "buy"
                  ? "bg-green-50 text-green-700 border border-green-200"
                  : s.type === "sell"
                  ? "bg-red-50 text-red-700 border border-red-200"
                  : "bg-blue-50 text-blue-700 border border-blue-200"
              }`}
            >
              <span className="font-bold">
                {s.type === "buy" ? "BUY" : s.type === "sell" ? "SELL" : "INFO"}
              </span>
              <span className="font-medium">[{s.indicator}]</span>
              <span>{s.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Current values */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
        {lastRSI !== null && (
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">RSI (14)</div>
            <div className={`font-mono font-medium ${
              lastRSI > 70 ? "text-red-600" : lastRSI < 30 ? "text-green-600" : ""
            }`}>
              {lastRSI.toFixed(1)}
            </div>
          </div>
        )}
        {lastMACD && (
          <>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">MACD</div>
              <div className={`font-mono font-medium ${lastMACD.macd >= 0 ? "text-green-600" : "text-red-600"}`}>
                {lastMACD.macd.toFixed(2)}
              </div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-500">MACD Histogram</div>
              <div className={`font-mono font-medium ${lastMACD.histogram >= 0 ? "text-green-600" : "text-red-600"}`}>
                {lastMACD.histogram.toFixed(2)}
              </div>
            </div>
          </>
        )}
        {lastBB && (
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">%B</div>
            <div className={`font-mono font-medium ${
              lastBB.percentB > 1 ? "text-red-600" : lastBB.percentB < 0 ? "text-green-600" : ""
            }`}>
              {(lastBB.percentB * 100).toFixed(1)}%
            </div>
            <div className="text-gray-400">帯域幅: {(lastBB.bandwidth * 100).toFixed(1)}%</div>
          </div>
        )}
      </div>

      <div ref={chartRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="テクニカル指標の読み方">
        <p>
          <span className="font-medium">RSI (Relative Strength Index):</span>{" "}
          直近14日間の値上がり幅と値下がり幅の比率から算出。0〜100の値を取り、
          70以上で「買われすぎ」、30以下で「売られすぎ」と判断。
          ただし強いトレンドでは長期間70以上/30以下に滞在することがある。
        </p>
        <p>
          <span className="font-medium">MACD:</span>{" "}
          短期EMA(12日)と長期EMA(26日)の差。シグナル線はMACDの9日EMA。
          MACD線がシグナル線を上抜ける「ゴールデンクロス」は買いシグナル、
          下抜ける「デッドクロス」は売りシグナル。ヒストグラムの増減でモメンタムの変化を確認。
        </p>
        <p>
          <span className="font-medium">ボリンジャーバンド:</span>{" "}
          SMA(20日)±2σの価格帯。統計的に約95%の確率でバンド内に収まるとされる。
          バンド幅が狭まる「スクイーズ」はブレイクアウトの前兆。
          %Bは現在価格がバンド内のどの位置にあるかを示す（0%=下限, 100%=上限）。
        </p>
        <p>
          <span className="font-medium">シグナル判定:</span>{" "}
          上部に表示されるBUY/SELLシグナルは単純な条件判定に基づくものであり、
          必ずしもエントリーポイントを意味しません。他の分析と組み合わせてご判断ください。
        </p>
      </AnalysisGuide>
    </div>
  );
}
