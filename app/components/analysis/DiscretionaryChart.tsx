"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  LineSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
  type SeriesMarker,
  type ISeriesMarkersPluginApi,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";

export interface OverlayLine {
  id: string;
  title: string;
  color: string;
  priceScaleId: "left" | "right";
  data: { time: string; value: number }[];
}

export interface ChartMarker {
  date: string;
  action: "buy" | "sell";
}

interface Props {
  prices: PricePoint[];
  overlays: OverlayLine[];
  markers: ChartMarker[];
  selectedDate?: string | null;
  onDateClick?: (date: string, price: number) => void;
  height?: number;
}

// 裁量トレード用のクリック式チャート。
// 株価(右軸)＋任意のオーバーレイ線(左/右軸)＋売買マーカー＋選択マーカー。
export default function DiscretionaryChart({
  prices,
  overlays,
  markers,
  selectedDate,
  onDateClick,
  height = 400,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const overlaySeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const selectionRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const onDateClickRef = useRef(onDateClick);
  useEffect(() => {
    onDateClickRef.current = onDateClick;
  }, [onDateClick]);
  const pricesRef = useRef(prices);
  useEffect(() => {
    pricesRef.current = prices;
  }, [prices]);

  // チャート初期化 (一度だけ)
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: {
        vertLines: { color: "#f0f0f0" },
        horzLines: { color: "#f0f0f0" },
      },
      width: containerRef.current.clientWidth,
      height,
      crosshair: { mode: 0 },
      rightPriceScale: { visible: true },
      leftPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    const priceSeries = chart.addSeries(LineSeries, {
      color: "#334155",
      lineWidth: 2,
      title: "株価",
      priceScaleId: "right",
    });
    priceSeriesRef.current = priceSeries;
    markersRef.current = createSeriesMarkers(priceSeries, []);
    selectionRef.current = createSeriesMarkers(priceSeries, []);

    chart.subscribeClick((param) => {
      if (!param.time) return;
      const timeStr = param.time as string;
      const point = pricesRef.current.find((p) => p.time === timeStr);
      if (point && onDateClickRef.current) {
        onDateClickRef.current(point.time, point.close);
      }
    });

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);
    const overlays = overlaySeriesRef.current;
    return () => {
      window.removeEventListener("resize", handleResize);
      overlays.clear();
      chart.remove();
      chartRef.current = null;
      priceSeriesRef.current = null;
      markersRef.current = null;
      selectionRef.current = null;
    };
  }, [height]);

  // 株価データ
  useEffect(() => {
    if (!priceSeriesRef.current) return;
    const data: LineData<Time>[] = prices.map((p) => ({
      time: p.time as Time,
      value: p.close,
    }));
    priceSeriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [prices]);

  // オーバーレイ線 (追加/更新/削除)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const existing = overlaySeriesRef.current;
    const seen = new Set<string>();

    for (const ov of overlays) {
      seen.add(ov.id);
      let series = existing.get(ov.id);
      if (!series) {
        series = chart.addSeries(LineSeries, {
          color: ov.color,
          lineWidth: 2,
          title: ov.title,
          priceScaleId: ov.priceScaleId,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
        });
        existing.set(ov.id, series);
      } else {
        series.applyOptions({ color: ov.color, title: ov.title });
      }
      series.setData(
        ov.data.map((d) => ({ time: d.time as Time, value: d.value }))
      );
    }
    // 不要になった系列を削除
    for (const [id, series] of existing) {
      if (!seen.has(id)) {
        chart.removeSeries(series);
        existing.delete(id);
      }
    }
  }, [overlays]);

  // 売買マーカー
  useEffect(() => {
    if (!markersRef.current) return;
    const ms: SeriesMarker<Time>[] = markers.map((m) => ({
      time: m.date as Time,
      position: m.action === "buy" ? "belowBar" : "aboveBar",
      color: m.action === "buy" ? "#16a34a" : "#dc2626",
      shape: m.action === "buy" ? "arrowUp" : "arrowDown",
      text: m.action === "buy" ? "買" : "売",
    }));
    markersRef.current.setMarkers(ms);
  }, [markers]);

  // 選択マーカー
  useEffect(() => {
    if (!selectionRef.current) return;
    if (!selectedDate) {
      selectionRef.current.setMarkers([]);
      return;
    }
    const point = prices.find((p) => p.time === selectedDate);
    if (!point) {
      selectionRef.current.setMarkers([]);
      return;
    }
    selectionRef.current.setMarkers([
      {
        time: point.time as Time,
        position: "inBar",
        color: "#6366f1",
        shape: "circle",
        text: selectedDate,
      },
    ]);
  }, [selectedDate, prices]);

  return (
    <div
      ref={containerRef}
      className="w-full rounded-lg border border-gray-200"
    />
  );
}
