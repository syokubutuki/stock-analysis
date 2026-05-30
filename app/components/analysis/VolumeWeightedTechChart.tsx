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
import AnalysisGuide from "./AnalysisGuide";

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
                    <td className={`py-1 px-2 text-center font-mono font-medium ${d.diff > 0 ? "text-green-600" : "text-red-600"}`}>{d.diff > 0 ? "+" : ""}{d.diff.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <AnalysisGuide title="出来高加重テクニカル指標の詳細理論">
        <p className="font-medium text-gray-700">1. 出来高加重RSI (VW-RSI)</p>
        <p>{"通常のRSIは各日の上昇幅/下落幅を均等に扱いますが、VW-RSIは出来高で重み付けします: VW_gain_t = max(0, ΔP_t) × V_t / V_avg、VW_loss_t = max(0, -ΔP_t) × V_t / V_avg。大出来高の日の価格変動をより重視します。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 出来高加重MACD (VW-MACD)</p>
        <p>{"VWAP的な考え方で出来高加重価格 VWP_t = Σ(P_i × V_i) / Σ(V_i) をEMAの入力に使用します。出来高が集中した価格帯の影響が強調されます。"}</p>
        <p className="font-medium text-gray-700 mt-3">3. 乖離の意味</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>VW-RSI &gt; RSI</strong>: 上昇時に出来高が伴っている。買い圧力が強い確認シグナル。</li>
          <li><strong>VW-RSI &lt; RSI</strong>: 上昇が出来高を伴っていない。トレンドの脆弱性を示唆。</li>
          <li>大きな乖離は「出来高を伴わない動き」を検出し、トレンドの信頼性評価に有用。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
