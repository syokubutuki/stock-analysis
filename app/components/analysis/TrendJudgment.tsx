"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeTrendSeries, judgeTrend, type TrendJudgment as TrendResult } from "../../lib/trend-analysis";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const DIRECTION_LABEL: Record<string, string> = {
  up: "上昇トレンド",
  down: "下降トレンド",
  range: "レンジ",
};

const DIRECTION_COLOR: Record<string, string> = {
  up: "text-green-600",
  down: "text-red-600",
  range: "text-yellow-600",
};

const DIRECTION_BG: Record<string, string> = {
  up: "bg-green-50 border-green-200",
  down: "bg-red-50 border-red-200",
  range: "bg-yellow-50 border-yellow-200",
};

export default function TrendJudgment({ prices }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const trend = judgeTrend(prices);
  const trendSeries = computeTrendSeries(prices);

  useEffect(() => {
    if (!containerRef.current || prices.length === 0) return;

    if (chartRef.current) {
      chartRef.current.remove();
    }

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: {
        vertLines: { color: "#f0f0f0" },
        horzLines: { color: "#f0f0f0" },
      },
      width: containerRef.current.clientWidth,
      height: 300,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    // ローソク足
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderUpColor: "#26a69a",
      borderDownColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      title: "株価",
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

    // SMA5
    const sma5Data = trendSeries.filter((p) => p.sma5 !== null);
    if (sma5Data.length > 0) {
      const sma5Line = chart.addSeries(LineSeries, {
        color: "#f59e0b",
        lineWidth: 1,
        title: "SMA5",
      });
      sma5Line.setData(
        sma5Data.map((p) => ({ time: p.time as Time, value: p.sma5! }))
      );
    }

    // SMA25
    const sma25Data = trendSeries.filter((p) => p.sma25 !== null);
    if (sma25Data.length > 0) {
      const sma25Line = chart.addSeries(LineSeries, {
        color: "#3b82f6",
        lineWidth: 1,
        title: "SMA25",
      });
      sma25Line.setData(
        sma25Data.map((p) => ({ time: p.time as Time, value: p.sma25! }))
      );
    }

    // SMA75
    const sma75Data = trendSeries.filter((p) => p.sma75 !== null);
    if (sma75Data.length > 0) {
      const sma75Line = chart.addSeries(LineSeries, {
        color: "#a855f7",
        lineWidth: 1,
        title: "SMA75",
      });
      sma75Line.setData(
        sma75Data.map((p) => ({ time: p.time as Time, value: p.sma75! }))
      );
    }

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [prices]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">トレンド判断</h3>

      <div className={`rounded-lg border p-3 mb-3 ${DIRECTION_BG[trend.direction]}`}>
        <div className="flex items-center justify-between">
          <div>
            <span className={`text-lg font-bold ${DIRECTION_COLOR[trend.direction]}`}>
              {DIRECTION_LABEL[trend.direction]}
            </span>
            <span className="text-sm text-gray-500 ml-2">
              強度: {trend.strength}/100
            </span>
          </div>
          <div className="text-xs text-gray-600">{trend.smaAlignment}</div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {trend.reasons.map((r, i) => (
            <span
              key={i}
              className="text-xs bg-white/70 rounded px-2 py-0.5 text-gray-700"
            >
              {r}
            </span>
          ))}
        </div>
      </div>

      <div ref={containerRef} className="w-full rounded border border-gray-100" />

      <div className="mt-2 flex gap-3 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-gray-700" /> 株価
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-amber-500" /> SMA5
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-blue-500" /> SMA25
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-purple-500" /> SMA75
        </span>
      </div>

      <AnalysisGuide title="トレンド判断の読み方">
        <p><span className="font-medium">SMA(単純移動平均線):</span> 過去N日間の終値の平均。期間が短いほど直近の値動きに敏感に反応し、長いほど大きなトレンドを反映します。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">SMA5(黄):</span> 約1週間の超短期トレンド。日々のノイズを若干平滑化。</li>
          <li><span className="font-medium">SMA25(青):</span> 約1ヶ月の短期トレンド。スイングトレードの判断基準に使われる。</li>
          <li><span className="font-medium">SMA75(紫):</span> 約3ヶ月の中期トレンド。大きな方向感を把握する。</li>
        </ul>
        <p><span className="font-medium">パーフェクトオーダー:</span> 短期 &gt; 中期 &gt; 長期 の順に並んでいる状態を「上昇パーフェクトオーダー」と呼びます。全ての時間軸で上昇トレンドが一致していることを意味し、強い上昇相場を示唆します。逆順は「下降パーフェクトオーダー」で、強い下落相場です。</p>
        <p><span className="font-medium">強度スコア(0〜100)の構成:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li>パーフェクトオーダー: ±40点</li>
          <li>株価とSMA75の位置関係: ±20点</li>
          <li>SMA25の傾き(直近20日): ±20点</li>
          <li>直近20日の高値/安値圏: ±10点</li>
        </ul>
        <p><span className="font-medium">トレードへの活用:</span> 上昇トレンド判定(スコア30以上)では押し目買い戦略、下降トレンド(−30以下)では戻り売り戦略が有効な可能性があります。レンジ判定時は、ブレイクアウト待ちまたはレンジ内逆張りが候補になります。ただし、この判断はSMAのみに基づく簡易的なものであり、他の分析と組み合わせて使うことを推奨します。</p>
      </AnalysisGuide>
    </div>
  );
}
