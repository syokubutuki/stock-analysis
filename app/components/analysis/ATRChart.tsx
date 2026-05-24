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
import { computeATR, computeKeltnerChannel } from "../../lib/atr";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function ATRChart({ prices }: Props) {
  const priceChartRef = useRef<HTMLDivElement>(null);
  const atrChartRef = useRef<HTMLDivElement>(null);
  const priceApiRef = useRef<IChartApi | null>(null);
  const atrApiRef = useRef<IChartApi | null>(null);

  const atrPoints = useMemo(() => computeATR(prices), [prices]);
  const keltnerPoints = useMemo(() => computeKeltnerChannel(prices), [prices]);

  const latest = atrPoints.length > 0 ? atrPoints[atrPoints.length - 1] : null;

  useEffect(() => {
    if (!priceChartRef.current || prices.length < 15) return;
    if (priceApiRef.current) priceApiRef.current.remove();

    const chart = createChart(priceChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: priceChartRef.current.clientWidth,
      height: 250,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    priceApiRef.current = chart;

    // Candlestick series
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

    if (keltnerPoints.length > 0) {
      // Upper band
      const upper = chart.addSeries(LineSeries, {
        color: "rgba(239,68,68,0.5)",
        lineWidth: 1,
        title: "Upper",
      });
      upper.setData(
        keltnerPoints.map((k) => ({ time: k.time as Time, value: k.upper }))
      );

      // Middle EMA
      const middle = chart.addSeries(LineSeries, {
        color: "#6b7280",
        lineWidth: 1,
        title: "EMA(20)",
      });
      middle.setData(
        keltnerPoints.map((k) => ({ time: k.time as Time, value: k.middle }))
      );

      // Lower band
      const lower = chart.addSeries(LineSeries, {
        color: "rgba(34,197,94,0.5)",
        lineWidth: 1,
        title: "Lower",
      });
      lower.setData(
        keltnerPoints.map((k) => ({ time: k.time as Time, value: k.lower }))
      );
    }

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (priceChartRef.current)
        chart.applyOptions({ width: priceChartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      priceApiRef.current = null;
    };
  }, [prices, keltnerPoints]);

  useEffect(() => {
    if (!atrChartRef.current || atrPoints.length === 0) return;
    if (atrApiRef.current) atrApiRef.current.remove();

    const chart = createChart(atrChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: atrChartRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      leftPriceScale: { visible: false },
      timeScale: { timeVisible: false },
    });
    atrApiRef.current = chart;

    // ATR line (right scale)
    const atrLine = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      title: "ATR(14)",
      priceScaleId: "right",
    });
    atrLine.setData(
      atrPoints.map((a) => ({ time: a.time as Time, value: a.atr }))
    );

    // ATR% line (overlay on left scale — use a separate right scale id)
    const atrPctScale = chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 1,
      lineStyle: 2, // dashed
      title: "ATR%",
      priceScaleId: "atrpct",
    });
    chart.priceScale("atrpct").applyOptions({
      scaleMargins: { top: 0.1, bottom: 0.1 },
      visible: true,
    });
    atrPctLine: {
      atrPctScale.setData(
        atrPoints.map((a) => ({ time: a.time as Time, value: a.atrPercent }))
      );
    }

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (atrChartRef.current)
        chart.applyOptions({ width: atrChartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      atrApiRef.current = null;
    };
  }, [atrPoints]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">ATR / ケルトナーチャネル</h3>

      {/* Current values grid */}
      {latest && (
        <div className="grid grid-cols-3 gap-2 text-xs mb-3">
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">ATR (14)</div>
            <div className="font-mono font-medium">{latest.atr.toFixed(2)}</div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">ATR%</div>
            <div className="font-mono font-medium">{latest.atrPercent.toFixed(2)}%</div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">TR (最新)</div>
            <div className="font-mono font-medium">{latest.tr.toFixed(2)}</div>
          </div>
        </div>
      )}

      {/* Price + Keltner Channel chart */}
      <div className="mb-1">
        <div className="text-xs text-gray-500 mb-1">価格 + ケルトナーチャネル</div>
        <div ref={priceChartRef} className="w-full rounded border border-gray-100" />
      </div>

      {/* Legend */}
      <div className="flex gap-3 text-xs text-gray-500 flex-wrap mb-3">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-red-400" /> Upper (EMA+2×ATR)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-gray-500" /> EMA (20)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-green-400" /> Lower (EMA-2×ATR)
        </span>
      </div>

      {/* ATR chart */}
      <div className="mb-1">
        <div className="text-xs text-gray-500 mb-1">ATR / ATR%</div>
        <div ref={atrChartRef} className="w-full rounded border border-gray-100" />
      </div>

      {/* ATR chart legend */}
      <div className="flex gap-3 text-xs text-gray-500 flex-wrap mb-2">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-blue-500" /> ATR (14) — 右軸
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-amber-400" style={{ borderTop: "1px dashed" }} /> ATR% — 右第2軸
        </span>
      </div>

      <AnalysisGuide title="ATR・ケルトナーチャネルの読み方">
        <p>
          <span className="font-medium">ATR (Average True Range):</span>{" "}
          ボラティリティ（価格変動の大きさ）を示す指標です。トレンドの方向性は持たず、純粋に値幅の激しさを測定します。
        </p>
        <p>
          <span className="font-medium">True Range の計算:</span>{" "}
          TR = max( 高値-安値、|高値-前日終値|、|安値-前日終値| )。前日の終値を考慮することで、窓（ギャップ）開けも適切に反映されます。
        </p>
        <p>
          <span className="font-medium">Wilder のスムージング:</span>{" "}
          最初のATRは期間内のTRの単純平均。以降は ATR = (前ATR × (period-1) + TR) / period で平滑化されます（デフォルト14日）。
        </p>
        <p>
          <span className="font-medium">ケルトナーチャネル:</span>{" "}
          EMAを中心線とし、上下に ATR の倍数（デフォルト2倍）を加減したバンドです。ボリンジャーバンドと異なりATRベースのため、価格の絶対的な値幅に連動します。
        </p>
        <p>
          <span className="font-medium">ATR% による銘柄間比較:</span>{" "}
          ATR% = ATR ÷ 終値 × 100。株価水準が異なる銘柄同士のボラティリティを相対的に比較するときに使います。
        </p>
        <p>
          <span className="font-medium">ストップロスへの活用:</span>{" "}
          例: エントリー価格 − 2 × ATR を損切りラインとして設定することで、通常の価格変動に振り回されず、異常な動きのみで損切りできます。
        </p>
      </AnalysisGuide>
    </div>
  );
}
