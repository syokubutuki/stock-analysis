"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeADX, judgeADX } from "../../lib/adx";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const STRENGTH_COLORS: Record<string, string> = {
  "強いトレンド": "bg-blue-50 border-blue-200 text-blue-700",
  "弱いトレンド": "bg-yellow-50 border-yellow-200 text-yellow-700",
  "レンジ相場": "bg-gray-50 border-gray-200 text-gray-700",
};

const TREND_COLORS: Record<string, string> = {
  "上昇": "text-green-600",
  "下降": "text-red-600",
};

export default function ADXChart({ prices }: Props) {
  const upperRef = useRef<HTMLDivElement>(null);
  const lowerRef = useRef<HTMLDivElement>(null);
  const upperApiRef = useRef<IChartApi | null>(null);
  const lowerApiRef = useRef<IChartApi | null>(null);

  const adxPoints = useMemo(() => computeADX(prices), [prices]);
  const judgment = useMemo(() => judgeADX(adxPoints), [adxPoints]);

  // Upper chart: candlestick
  useEffect(() => {
    if (!upperRef.current || prices.length < 2) return;
    if (upperApiRef.current) upperApiRef.current.remove();

    const chart = createChart(upperRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: upperRef.current.clientWidth,
      height: 220,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    upperApiRef.current = chart;

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderUpColor: "#26a69a",
      borderDownColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });
    candle.setData(
      prices.map((p) => ({
        time: p.time as Time,
        open: p.open,
        high: p.high,
        low: p.low,
        close: p.close,
      }))
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (upperRef.current)
        chart.applyOptions({ width: upperRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      upperApiRef.current = null;
    };
  }, [prices]);

  // Lower chart: +DI, -DI, ADX
  useEffect(() => {
    if (!lowerRef.current || adxPoints.length === 0) return;
    if (lowerApiRef.current) lowerApiRef.current.remove();

    const chart = createChart(lowerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: lowerRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    lowerApiRef.current = chart;

    const plusDISeries = chart.addSeries(LineSeries, {
      color: "#22c55e",
      lineWidth: 1,
      title: "+DI",
    });
    plusDISeries.setData(
      adxPoints.map((p) => ({ time: p.time as Time, value: p.plusDI }))
    );

    const minusDISeries = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 1,
      title: "-DI",
    });
    minusDISeries.setData(
      adxPoints.map((p) => ({ time: p.time as Time, value: p.minusDI }))
    );

    const adxSeries = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      title: "ADX",
    });
    adxSeries.setData(
      adxPoints.map((p) => ({ time: p.time as Time, value: p.adx }))
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (lowerRef.current)
        chart.applyOptions({ width: lowerRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      lowerApiRef.current = null;
    };
  }, [adxPoints]);

  const last = adxPoints.length > 0 ? adxPoints[adxPoints.length - 1] : null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">ADX (Average Directional Index)</h3>

      {/* Judgment badge */}
      {last && (
        <div
          className={`rounded-lg border p-3 mb-3 ${
            STRENGTH_COLORS[judgment.strength] ?? "bg-gray-50 border-gray-200 text-gray-700"
          }`}
        >
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-lg font-bold">{judgment.strength}</span>
            <span className={`text-sm font-medium ${TREND_COLORS[judgment.trend] ?? ""}`}>
              {judgment.trend}トレンド
            </span>
          </div>
          <div className="mt-1 text-xs">{judgment.signal}</div>
        </div>
      )}

      {/* Current values grid */}
      {last && (
        <div className="grid grid-cols-3 gap-2 text-xs mb-3">
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">ADX</div>
            <div
              className={`font-mono font-medium ${
                last.adx > 25
                  ? "text-blue-600"
                  : last.adx >= 20
                  ? "text-yellow-600"
                  : "text-gray-600"
              }`}
            >
              {last.adx.toFixed(2)}
            </div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">+DI</div>
            <div className="font-mono font-medium text-green-600">
              {last.plusDI.toFixed(2)}
            </div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">-DI</div>
            <div className="font-mono font-medium text-red-600">
              {last.minusDI.toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {/* Upper chart: price */}
      <div ref={upperRef} className="w-full rounded border border-gray-100" />

      {/* Lower chart: ADX / +DI / -DI */}
      <div ref={lowerRef} className="w-full rounded border border-gray-100 mt-1" />

      {/* Legend */}
      <div className="mt-2 flex gap-3 text-xs text-gray-500 flex-wrap">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-green-500" /> +DI
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-red-500" /> -DI
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-1 bg-blue-500" style={{ height: "2px" }} /> ADX
        </span>
      </div>

      <AnalysisGuide title="ADXの読み方">
        <p>
          <span className="font-medium">ADX (Average Directional Index):</span>{" "}
          ワイルダーが考案したトレンドの強さを示す指標です。方向は示さず、トレンドの強弱のみを表します。
          ADX &gt; 25 で強いトレンド、20〜25 で弱いトレンド、20 未満はレンジ相場と判断します。
        </p>
        <p>
          <span className="font-medium">+DI / -DI (方向性指標):</span>{" "}
          +DI は上昇方向のトレンドの強さ、-DI は下降方向の強さを示します。
          +DI が -DI を上回っている間は上昇トレンド優勢、下回れば下降トレンド優勢です。
        </p>
        <p>
          <span className="font-medium">ゴールデンクロス / デッドクロス:</span>{" "}
          +DI が -DI を下から上にクロスすれば買いシグナル、上から下にクロスすれば売りシグナルとされます。
          ただし ADX が 20 以上の局面でのクロスほど信頼性が高まります。
        </p>
        <p>
          <span className="font-medium">Wilder&apos;s Smoothing:</span>{" "}
          True Range・+DM・-DM をワイルダーの平滑化（EMAの一種、α=1/period）で平滑化してから
          +DI、-DI を算出し、さらにその差の比率 DX を平滑化して ADX を求めます。デフォルト期間は 14 日です。
        </p>
        <p>
          <span className="font-medium">活用方法:</span>
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ADX が上昇中 → トレンドが強まっている。トレンドフォロー戦略が有効。</li>
          <li>ADX が低下中 → トレンドが弱まっている。逆張りやレンジ戦略を検討。</li>
          <li>ADX が低水準から急騰し始めたら、新しいトレンド発生の兆候。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
