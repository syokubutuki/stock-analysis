"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeVWTechnical } from "../../lib/volume-price-dynamics";
import GuideEntryPanel from "./GuideEntryPanel";
import DirectionValue from "./DirectionValue";

interface Props { prices: PricePoint[]; }

export default function VolumeWeightedTechChart({ prices }: Props) {
  const rsiRef = useRef<HTMLDivElement>(null);
  const macdRef = useRef<HTMLDivElement>(null);
  const rsiApi = useRef<IChartApi | null>(null);
  const macdApi = useRef<IChartApi | null>(null);
  const result = useMemo(() => computeVWTechnical(prices), [prices]);

  useEffect(() => {
    if (!rsiRef.current || result.dates.length === 0) return;
    const chart = createChart(rsiRef.current, {
      width: rsiRef.current.clientWidth, height: 250,
      layout: { textColor: "#374151", fontSize: 11 },
      grid: { vertLines: { color: "#f3f4f6" }, horzLines: { color: "#f3f4f6" } },
      rightPriceScale: { borderColor: "#e5e7eb" }, timeScale: { borderColor: "#e5e7eb" },
    });
    rsiApi.current = chart;

    const rsiSeries = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 1, title: "RSI(14)" });
    const vwRsiSeries = chart.addSeries(LineSeries, { color: "#ef4444", lineWidth: 2, title: "VW-RSI(14)" });

    rsiSeries.setData(result.dates.map((t, i) => ({ time: t as Time, value: result.rsi[i] })).filter(d => d.value > 0));
    vwRsiSeries.setData(result.dates.map((t, i) => ({ time: t as Time, value: result.vwRsi[i] })).filter(d => d.value > 0));
    chart.timeScale().fitContent();

    const h = () => { if (rsiRef.current) chart.applyOptions({ width: rsiRef.current.clientWidth }); };
    window.addEventListener("resize", h);
    return () => { window.removeEventListener("resize", h); chart.remove(); rsiApi.current = null; };
  }, [result]);

  useEffect(() => {
    if (!macdRef.current || result.dates.length === 0) return;
    const chart = createChart(macdRef.current, {
      width: macdRef.current.clientWidth, height: 250,
      layout: { textColor: "#374151", fontSize: 11 },
      grid: { vertLines: { color: "#f3f4f6" }, horzLines: { color: "#f3f4f6" } },
      rightPriceScale: { borderColor: "#e5e7eb" }, timeScale: { borderColor: "#e5e7eb" },
    });
    macdApi.current = chart;

    const macdSeries = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 1, title: "MACD" });
    const vwMacdSeries = chart.addSeries(LineSeries, { color: "#ef4444", lineWidth: 2, title: "VW-MACD" });

    macdSeries.setData(result.dates.map((t, i) => ({ time: t as Time, value: result.macd[i] })));
    vwMacdSeries.setData(result.dates.map((t, i) => ({ time: t as Time, value: result.vwMacd[i] })));
    chart.timeScale().fitContent();

    const h = () => { if (macdRef.current) chart.applyOptions({ width: macdRef.current.clientWidth }); };
    window.addEventListener("resize", h);
    return () => { window.removeEventListener("resize", h); chart.remove(); macdApi.current = null; };
  }, [result]);

  if (result.dates.length === 0) return null;

  const divs = result.divergence.slice(0, 10);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">出来高加重テクニカル指標</h3>
      <p className="text-xs text-gray-500">通常のRSI/MACDと出来高で加重した版を比較。乖離は出来高を伴わない動きを示唆。</p>

      <div className="text-xs text-gray-600 font-medium">RSI vs 出来高加重RSI</div>
      <div ref={rsiRef} />
      <div className="text-xs text-gray-600 font-medium">MACD vs 出来高加重MACD</div>
      <div ref={macdRef} />

      {divs.length > 0 && (
        <div>
          <div className="text-xs text-gray-600 font-medium mb-1">直近の乖離ポイント (上位10)</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead><tr className="border-b border-gray-200">
                <th className="py-1 px-2 text-left text-gray-500">日付</th>
                <th className="py-1 px-2 text-center text-gray-500">指標</th>
                <th className="py-1 px-2 text-center text-gray-500">通常</th>
                <th className="py-1 px-2 text-center text-gray-500">出来高加重</th>
                <th className="py-1 px-2 text-center text-gray-500">乖離</th>
              </tr></thead>
              <tbody>
                {divs.map((d, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    <td className="py-1 px-2 font-mono text-gray-600">{d.date}</td>
                    <td className="py-1 px-2 text-center font-medium">{d.type.toUpperCase()}</td>
                    <td className="py-1 px-2 text-center font-mono">{d.standard.toFixed(2)}</td>
                    <td className="py-1 px-2 text-center font-mono">{d.vw.toFixed(2)}</td>
                    <td className="py-1 px-2 text-center font-mono font-medium"><DirectionValue value={d.diff}>{d.diff > 0 ? "+" : ""}{d.diff.toFixed(2)}</DirectionValue></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 解説本文は app/lib/analysis-guides.ts の唯一のソースから描く。
          ここに散文を書き戻すと /guide/volume-weighted-technical と二重管理になる。 */}
      <GuideEntryPanel slug="volume-weighted-technical" title="出来高加重テクニカル指標の詳細理論" />
    </div>
  );
}
