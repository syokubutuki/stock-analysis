"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  CandlestickSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeStochastics, detectStochSignals } from "../../lib/stochastics";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function StochasticsChart({ prices }: Props) {
  const upperRef = useRef<HTMLDivElement>(null);
  const lowerRef = useRef<HTMLDivElement>(null);
  const upperApiRef = useRef<IChartApi | null>(null);
  const lowerApiRef = useRef<IChartApi | null>(null);

  const stochPoints = useMemo(() => computeStochastics(prices), [prices]);
  const signals = useMemo(() => detectStochSignals(stochPoints), [stochPoints]);

  useEffect(() => {
    if (!upperRef.current || !lowerRef.current) return;

    // Cleanup previous instances
    if (upperApiRef.current) {
      upperApiRef.current.remove();
      upperApiRef.current = null;
    }
    if (lowerApiRef.current) {
      lowerApiRef.current.remove();
      lowerApiRef.current = null;
    }

    const sharedOptions = {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    };

    // Upper chart: candlestick
    const upperChart = createChart(upperRef.current, {
      ...sharedOptions,
      width: upperRef.current.clientWidth,
      height: 220,
    });
    upperApiRef.current = upperChart;

    const candleSeries = upperChart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderUpColor: "#26a69a",
      borderDownColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });
    candleSeries.setData(
      prices.map((p) => ({
        time: p.time as Time,
        open: p.open,
        high: p.high,
        low: p.low,
        close: p.close,
      }))
    );
    upperChart.timeScale().fitContent();

    // Lower chart: stochastics
    const lowerChart = createChart(lowerRef.current, {
      ...sharedOptions,
      width: lowerRef.current.clientWidth,
      height: 180,
    });
    lowerApiRef.current = lowerChart;

    if (stochPoints.length > 0) {
      // Slow %K
      const slowKSeries = lowerChart.addSeries(LineSeries, {
        color: "#3b82f6",
        lineWidth: 2,
        title: "Slow %K",
      });
      slowKSeries.setData(
        stochPoints.map((p) => ({ time: p.time as Time, value: p.slowK }))
      );

      // Slow %D
      const slowDSeries = lowerChart.addSeries(LineSeries, {
        color: "#f59e0b",
        lineWidth: 1,
        title: "Slow %D",
      });
      slowDSeries.setData(
        stochPoints.map((p) => ({ time: p.time as Time, value: p.slowD }))
      );

      // 80 reference line
      const line80 = lowerChart.addSeries(LineSeries, {
        color: "rgba(239, 68, 68, 0.35)",
        lineWidth: 1,
        lineStyle: 2,
        title: "80",
      });
      line80.setData(
        stochPoints.map((p) => ({ time: p.time as Time, value: 80 }))
      );

      // 20 reference line
      const line20 = lowerChart.addSeries(LineSeries, {
        color: "rgba(34, 197, 94, 0.35)",
        lineWidth: 1,
        lineStyle: 2,
        title: "20",
      });
      line20.setData(
        stochPoints.map((p) => ({ time: p.time as Time, value: 20 }))
      );

      lowerChart.timeScale().fitContent();
    }

    const handleResize = () => {
      if (upperRef.current)
        upperChart.applyOptions({ width: upperRef.current.clientWidth });
      if (lowerRef.current)
        lowerChart.applyOptions({ width: lowerRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      upperChart.remove();
      lowerChart.remove();
      upperApiRef.current = null;
      lowerApiRef.current = null;
    };
  }, [prices, stochPoints]);

  const last = stochPoints.length > 0 ? stochPoints[stochPoints.length - 1] : null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">ストキャスティクス</h3>

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
              <span>{s.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Current values grid */}
      {last && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">Fast %K</div>
            <div
              className={`font-mono font-medium ${
                last.fastK > 80
                  ? "text-red-600"
                  : last.fastK < 20
                  ? "text-green-600"
                  : ""
              }`}
            >
              {last.fastK.toFixed(1)}
            </div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">Fast %D</div>
            <div
              className={`font-mono font-medium ${
                last.fastD > 80
                  ? "text-red-600"
                  : last.fastD < 20
                  ? "text-green-600"
                  : ""
              }`}
            >
              {last.fastD.toFixed(1)}
            </div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">Slow %K</div>
            <div
              className={`font-mono font-medium ${
                last.slowK > 80
                  ? "text-red-600"
                  : last.slowK < 20
                  ? "text-green-600"
                  : ""
              }`}
            >
              {last.slowK.toFixed(1)}
            </div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">Slow %D</div>
            <div
              className={`font-mono font-medium ${
                last.slowD > 80
                  ? "text-red-600"
                  : last.slowD < 20
                  ? "text-green-600"
                  : ""
              }`}
            >
              {last.slowD.toFixed(1)}
            </div>
          </div>
        </div>
      )}

      {/* Upper chart: candlestick */}
      <div ref={upperRef} className="w-full rounded border border-gray-100 mb-1" />

      {/* Lower chart: stochastics */}
      <div ref={lowerRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="ストキャスティクスの読み方">
        <p>
          <span className="font-medium">%K と %D:</span>{" "}
          %K は直近N日間の高値・安値レンジに対する現在終値の相対位置を0〜100で表します。
          %D は%Kの移動平均で、シグナル線として機能します。
          Fast Stochastic は%Kと%Dのペア、Slow Stochastic はFast%Dをさらに平滑化したものです。
        </p>
        <p>
          <span className="font-medium">買われすぎ・売られすぎ:</span>{" "}
          Slow%Kが80以上のゾーンは「買われすぎ」を示し、売り転換の可能性に注意します。
          20以下のゾーンは「売られすぎ」を示し、買い転換のチャンスを示唆します。
          ただし強いトレンド相場では長期間極端なゾーンに留まることがあります。
        </p>
        <p>
          <span className="font-medium">ゴールデンクロス・デッドクロス:</span>{" "}
          Slow%KがSlow%Dを下から上抜ける「ゴールデンクロス」は買いシグナル、
          特に売られすぎゾーン(20以下)での発生は信頼性が高いとされます。
          逆にSlow%KがSlow%Dを上から下抜ける「デッドクロス」は売りシグナルで、
          買われすぎゾーン(80以上)での発生に注目します。
        </p>
        <p>
          <span className="font-medium">ダイバージェンス:</span>{" "}
          価格が新高値を更新しているのに%Kが前回高値を下回る「弱気ダイバージェンス」は
          上昇トレンドの勢いが失われているサインです。
          逆に価格が新安値を更新しても%Kが前回安値を上回る「強気ダイバージェンス」は
          下落トレンドの勢いの減退を示し、反発の可能性を示唆します。
        </p>
      </AnalysisGuide>
    </div>
  );
}
