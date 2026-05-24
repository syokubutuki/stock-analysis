"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  LineSeries,
  CandlestickSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeOBV,
  computeVWAP,
  detectOBVDivergence,
} from "../../lib/obv-vwap";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function OBVVWAPChart({ prices }: Props) {
  const priceChartRef = useRef<HTMLDivElement>(null);
  const obvChartRef = useRef<HTMLDivElement>(null);
  const priceChartApi = useRef<IChartApi | null>(null);
  const obvChartApi = useRef<IChartApi | null>(null);

  const obvData = computeOBV(prices);
  const vwapData = computeVWAP(prices);
  const divergence = detectOBVDivergence(prices, obvData);

  const latestVWAP = vwapData.at(-1);
  const latestOBV = obvData.at(-1);
  const latestPrice = prices.at(-1);

  useEffect(() => {
    if (!priceChartRef.current || !obvChartRef.current) return;

    // --- Price Chart ---
    const priceChart = createChart(priceChartRef.current, {
      height: 250,
      layout: { background: { color: "#ffffff" }, textColor: "#374151" },
      grid: {
        vertLines: { color: "#f3f4f6" },
        horzLines: { color: "#f3f4f6" },
      },
      timeScale: { borderColor: "#e5e7eb" },
      rightPriceScale: { borderColor: "#e5e7eb" },
    });
    priceChartApi.current = priceChart;

    const candleSeries = priceChart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
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

    const vwapSeries = priceChart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 2,
      title: "VWAP",
    });
    vwapSeries.setData(
      vwapData.map((v) => ({ time: v.time as Time, value: v.vwap }))
    );

    priceChart.timeScale().fitContent();

    // --- OBV Chart ---
    const obvChart = createChart(obvChartRef.current, {
      height: 180,
      layout: { background: { color: "#ffffff" }, textColor: "#374151" },
      grid: {
        vertLines: { color: "#f3f4f6" },
        horzLines: { color: "#f3f4f6" },
      },
      timeScale: { borderColor: "#e5e7eb" },
      rightPriceScale: { borderColor: "#e5e7eb" },
    });
    obvChartApi.current = obvChart;

    const obvSeries = obvChart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      title: "OBV",
    });
    obvSeries.setData(
      obvData.map((o) => ({ time: o.time as Time, value: o.obv }))
    );

    const obvMASeries = obvChart.addSeries(LineSeries, {
      color: "#9ca3af",
      lineWidth: 1,
      title: "OBV MA20",
    });
    obvMASeries.setData(
      obvData.map((o) => ({ time: o.time as Time, value: o.obvMA }))
    );

    obvChart.timeScale().fitContent();

    // --- Resize handler ---
    const handleResize = () => {
      if (priceChartRef.current) {
        priceChart.applyOptions({
          width: priceChartRef.current.clientWidth,
        });
      }
      if (obvChartRef.current) {
        obvChart.applyOptions({
          width: obvChartRef.current.clientWidth,
        });
      }
    };

    window.addEventListener("resize", handleResize);
    handleResize();

    return () => {
      window.removeEventListener("resize", handleResize);
      priceChart.remove();
      obvChart.remove();
      priceChartApi.current = null;
      obvChartApi.current = null;
    };
  }, [prices, obvData, vwapData]);

  const obvVsMA =
    latestOBV && latestOBV.obv > latestOBV.obvMA
      ? { label: "MA上回り", className: "text-green-600" }
      : { label: "MA下回り", className: "text-red-600" };

  return (
    <div className="space-y-3">
      {/* Divergence Alert */}
      {divergence.type !== null && (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            divergence.type === "bullish"
              ? "bg-green-50 border-green-300 text-green-800"
              : "bg-red-50 border-red-300 text-red-800"
          }`}
        >
          <span className="font-semibold mr-2">
            {divergence.type === "bullish" ? "強気シグナル" : "弱気シグナル"}
          </span>
          {divergence.message}
        </div>
      )}

      {/* Current Values Grid */}
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="bg-purple-50 rounded-md px-3 py-2">
          <div className="text-xs text-gray-500 mb-0.5">VWAP</div>
          <div className="font-semibold text-purple-700">
            {latestVWAP ? latestVWAP.vwap.toFixed(2) : "—"}
          </div>
          {latestVWAP && latestPrice && (
            <div
              className={`text-xs mt-0.5 ${
                latestPrice.close >= latestVWAP.vwap
                  ? "text-green-600"
                  : "text-red-600"
              }`}
            >
              {latestPrice.close >= latestVWAP.vwap ? "価格 > VWAP" : "価格 < VWAP"}
            </div>
          )}
        </div>

        <div className="bg-blue-50 rounded-md px-3 py-2">
          <div className="text-xs text-gray-500 mb-0.5">OBV</div>
          <div className="font-semibold text-blue-700">
            {latestOBV
              ? latestOBV.obv >= 0
                ? `+${latestOBV.obv.toLocaleString()}`
                : latestOBV.obv.toLocaleString()
              : "—"}
          </div>
        </div>

        <div className="bg-gray-50 rounded-md px-3 py-2">
          <div className="text-xs text-gray-500 mb-0.5">OBV vs MA20</div>
          <div className={`font-semibold ${obvVsMA.className}`}>
            {obvVsMA.label}
          </div>
          {latestOBV && (
            <div className="text-xs text-gray-400 mt-0.5">
              MA: {latestOBV.obvMA.toFixed(0)}
            </div>
          )}
        </div>
      </div>

      {/* Price + VWAP Chart */}
      <div>
        <div className="text-xs text-gray-500 mb-1 font-medium">
          価格 / VWAP
        </div>
        <div ref={priceChartRef} className="w-full rounded border border-gray-100" />
      </div>

      {/* OBV Chart */}
      <div>
        <div className="text-xs text-gray-500 mb-1 font-medium">
          OBV / OBV MA20
        </div>
        <div ref={obvChartRef} className="w-full rounded border border-gray-100" />
      </div>

      {/* Analysis Guide */}
      <AnalysisGuide title="OBV・VWAPの見方">
        <p>
          <span className="font-semibold">OBV (On-Balance Volume)</span>
          は出来高の累積で、価格トレンドの裏付けを確認する指標です。
          価格上昇時に出来高が増加していれば、トレンドの信頼性が高いと判断できます。
        </p>
        <p>
          <span className="font-semibold">VWAP (出来高加重平均価格)</span>
          は出来高加重平均価格で、機関投資家が売買コストの基準として参照します。
          価格がVWAPを上回っている場合は強気、下回っている場合は弱気の目安となります。
        </p>
        <p>
          <span className="font-semibold">ダイバージェンス</span>
          とは価格とOBVの乖離のことです。
          価格が高値を更新してもOBVが低下している場合(弱気ダイバージェンス)や、
          価格が安値を更新してもOBVが上昇している場合(強気ダイバージェンス)は、
          トレンド転換の兆候として注目されます。
        </p>
      </AnalysisGuide>
    </div>
  );
}
