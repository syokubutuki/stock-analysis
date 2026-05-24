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
import { computeIchimoku, judgeIchimoku } from "../../lib/ichimoku";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const SIGNAL_COLORS: Record<string, string> = {
  "三役好転": "bg-green-50 border-green-200 text-green-700",
  "三役逆転": "bg-red-50 border-red-200 text-red-700",
  "好転気配": "bg-emerald-50 border-emerald-200 text-emerald-700",
  "逆転気配": "bg-orange-50 border-orange-200 text-orange-700",
  "中立": "bg-gray-50 border-gray-200 text-gray-700",
};

export default function IchimokuChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);

  const { current, leading } = useMemo(() => computeIchimoku(prices), [prices]);
  const judgment = useMemo(() => judgeIchimoku(current), [current]);

  useEffect(() => {
    if (!chartRef.current || prices.length < 52) return;
    if (apiRef.current) apiRef.current.remove();

    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 350,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;

    // ローソク足
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
        open: p.open, high: p.high, low: p.low, close: p.close,
      }))
    );

    // 転換線
    const tenkanData = current.filter((p) => p.tenkan !== null);
    if (tenkanData.length > 0) {
      const s = chart.addSeries(LineSeries, {
        color: "#3b82f6", lineWidth: 1, title: "転換線(9)",
      });
      s.setData(tenkanData.map((p) => ({ time: p.time as Time, value: p.tenkan! })));
    }

    // 基準線
    const kijunData = current.filter((p) => p.kijun !== null);
    if (kijunData.length > 0) {
      const s = chart.addSeries(LineSeries, {
        color: "#ef4444", lineWidth: 1, title: "基準線(26)",
      });
      s.setData(kijunData.map((p) => ({ time: p.time as Time, value: p.kijun! })));
    }

    // 先行スパン1 (current part)
    const senkouAData = current.filter((p) => p.senkouA !== null);
    if (senkouAData.length > 0) {
      const s = chart.addSeries(LineSeries, {
        color: "rgba(34, 197, 94, 0.5)", lineWidth: 1, title: "先行1",
      });
      const data = senkouAData.map((p) => ({ time: p.time as Time, value: p.senkouA! }));
      // Add leading data
      for (const l of leading) {
        data.push({ time: l.time as Time, value: l.senkouA });
      }
      s.setData(data);
    }

    // 先行スパン2
    const senkouBData = current.filter((p) => p.senkouB !== null);
    if (senkouBData.length > 0) {
      const s = chart.addSeries(LineSeries, {
        color: "rgba(239, 68, 68, 0.5)", lineWidth: 1, title: "先行2",
      });
      const data = senkouBData.map((p) => ({ time: p.time as Time, value: p.senkouB! }));
      for (const l of leading) {
        data.push({ time: l.time as Time, value: l.senkouB });
      }
      s.setData(data);
    }

    // 遅行スパン
    const chikouData = current.filter((p) => p.chikou !== null);
    if (chikouData.length > 0) {
      const s = chart.addSeries(LineSeries, {
        color: "#a855f7", lineWidth: 1, lineStyle: 2, title: "遅行",
      });
      s.setData(chikouData.map((p) => ({ time: p.time as Time, value: p.chikou! })));
    }

    chart.timeScale().fitContent();
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
  }, [prices, current, leading]);

  const last = current.length > 0 ? current[current.length - 1] : null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">一目均衡表</h3>

      {/* 判定 */}
      <div className={`rounded-lg border p-3 mb-3 ${SIGNAL_COLORS[judgment.signal]}`}>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-lg font-bold">{judgment.signal}</span>
          <span className="text-xs">
            雲: {judgment.cloudStatus === "above" ? "上" : judgment.cloudStatus === "below" ? "下" : "内"}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {judgment.conditions.map((c, i) => (
            <span
              key={i}
              className={`text-xs rounded px-2 py-0.5 ${
                c.met ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
              }`}
            >
              {c.met ? "✓" : "✗"} {c.label}
            </span>
          ))}
        </div>
      </div>

      {/* 現在値 */}
      {last && (
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 text-xs mb-3">
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">転換線</div>
            <div className="font-mono font-medium">{last.tenkan?.toLocaleString() ?? "-"}</div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">基準線</div>
            <div className="font-mono font-medium">{last.kijun?.toLocaleString() ?? "-"}</div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">先行1</div>
            <div className="font-mono font-medium">{last.senkouA?.toLocaleString() ?? "-"}</div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">先行2</div>
            <div className="font-mono font-medium">{last.senkouB?.toLocaleString() ?? "-"}</div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">遅行スパン</div>
            <div className="font-mono font-medium">{last.chikou?.toLocaleString() ?? "-"}</div>
          </div>
        </div>
      )}

      <div ref={chartRef} className="w-full rounded border border-gray-100" />

      <div className="mt-2 flex gap-3 text-xs text-gray-500 flex-wrap">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-blue-500" /> 転換線</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-red-500" /> 基準線</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-green-400" /> 先行1</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-red-400" /> 先行2</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-purple-500" style={{ borderTop: "1px dashed" }} /> 遅行</span>
      </div>

      <AnalysisGuide title="一目均衡表の読み方">
        <p><span className="font-medium">転換線 (9日):</span> 過去9日間の高値と安値の中間値。短期的な均衡点。</p>
        <p><span className="font-medium">基準線 (26日):</span> 過去26日間の中間値。中期的な均衡点であり、トレンドの方向を示す。</p>
        <p><span className="font-medium">先行スパン1:</span> 転換線と基準線の中間値を26日先にプロット。雲の一辺。</p>
        <p><span className="font-medium">先行スパン2:</span> 過去52日間の中間値を26日先にプロット。雲のもう一辺。</p>
        <p><span className="font-medium">遅行スパン:</span> 当日の終値を26日前にプロット。現在の株価と過去の株価の位置関係を示す。</p>
        <p><span className="font-medium">雲 (先行1と先行2の間):</span> 支持帯/抵抗帯として機能。雲の厚さが厚いほど突破が困難。</p>
        <p><span className="font-medium">三役好転:</span> ①転換線{">"}基準線 ②遅行スパン{">"}26日前株価 ③株価{">"}雲上限。3条件全て満たすと強い買いシグナル。三役逆転はその逆。</p>
      </AnalysisGuide>
    </div>
  );
}
