"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  rollingTransferEntropy,
  rollingMutualInformation,
} from "../../lib/information-flow";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function RollingTransferEntropyChart({ prices, seriesMode }: Props) {
  const teRef = useRef<HTMLDivElement>(null);
  const miRef = useRef<HTMLDivElement>(null);
  const teChartRef = useRef<IChartApi | null>(null);
  const miChartRef = useRef<IChartApi | null>(null);

  const { values, times } = extractSeries(prices, seriesMode);
  // Align volumes to extracted series (strip leading elements for diff/logReturn modes)
  const volumes = useMemo(() => {
    const vols = prices.map((p) => p.volume);
    return vols.slice(vols.length - values.length);
  }, [prices, seriesMode]);
  const absReturns = useMemo(() => values.map((v) => Math.abs(v)), [prices, seriesMode]);

  // TE: vol→price, price→vol
  const teVolToPrice = useMemo(
    () => rollingTransferEntropy(volumes, values, times, 120, 1, 5),
    [prices, seriesMode]
  );
  const tePriceToVol = useMemo(
    () => rollingTransferEntropy(values, volumes, times, 120, 1, 5),
    [prices, seriesMode]
  );

  // MI
  const miCloseVol = useMemo(
    () => rollingMutualInformation(values, volumes, times, 60),
    [prices, seriesMode]
  );
  const miCloseAbsRet = useMemo(
    () => rollingMutualInformation(values, absReturns, times, 60),
    [prices, seriesMode]
  );

  // TE chart
  useEffect(() => {
    if (!teRef.current || teVolToPrice.length === 0) return;
    if (teChartRef.current) teChartRef.current.remove();

    const chart = createChart(teRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: teRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    teChartRef.current = chart;

    const s1 = chart.addSeries(LineSeries, { color: "#ef4444", lineWidth: 1, title: "TE(Vol→Price)" });
    s1.setData(teVolToPrice.map((r) => ({ time: r.time as Time, value: r.value })));

    const s2 = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 1, title: "TE(Price→Vol)" });
    s2.setData(tePriceToVol.map((r) => ({ time: r.time as Time, value: r.value })));

    // Net flow
    const netFlow = teVolToPrice.map((r, i) => {
      const match = tePriceToVol.find((p) => p.time === r.time);
      return { time: r.time as Time, value: r.value - (match?.value || 0) };
    });
    const s3 = chart.addSeries(LineSeries, { color: "#22c55e", lineWidth: 1, title: "Net Flow", lineStyle: 2 });
    s3.setData(netFlow);

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (teRef.current) chart.applyOptions({ width: teRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      teChartRef.current = null;
    };
  }, [teVolToPrice, tePriceToVol]);

  // MI chart
  useEffect(() => {
    if (!miRef.current || miCloseVol.length === 0) return;
    if (miChartRef.current) miChartRef.current.remove();

    const chart = createChart(miRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: miRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    miChartRef.current = chart;

    const s1 = chart.addSeries(LineSeries, { color: "#8b5cf6", lineWidth: 1, title: "MI(Close,Vol)" });
    s1.setData(miCloseVol.map((r) => ({ time: r.time as Time, value: r.value })));

    const s2 = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 1, title: "MI(Close,|Ret|)" });
    s2.setData(miCloseAbsRet.map((r) => ({ time: r.time as Time, value: r.value })));

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (miRef.current) chart.applyOptions({ width: miRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      miChartRef.current = null;
    };
  }, [miCloseVol, miCloseAbsRet]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">ローリング移転エントロピー / 相互情報量</h3>

      <div className="text-xs text-gray-500 mb-2">Transfer Entropy (120日窓, step=5) — 情報フローの方向性</div>
      <div ref={teRef} className="w-full rounded border border-gray-100 mb-3" />
      <div className="flex flex-wrap gap-3 text-xs text-gray-500 mb-4">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-red-500" /> Vol→Price</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-blue-500" /> Price→Vol</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-green-500" /> Net Flow</span>
      </div>

      <div className="text-xs text-gray-500 mb-2">Mutual Information (60日窓) — 非線形相関</div>
      <div ref={miRef} className="w-full rounded border border-gray-100" />
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-purple-500" /> MI(Close,Volume)</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-amber-500" /> MI(Close,|Return|)</span>
      </div>

      <AnalysisGuide title="ローリング情報フローの理論">
        <p className="font-medium text-gray-700">1. Transfer Entropy (TE)</p>
        <p>TE(X→Y)は、Xの過去がYの未来予測をどれだけ改善するかを測る因果的情報フロー指標です。シンボル化TEを使用し、高速に計算しています。</p>

        <p className="font-medium text-gray-700 mt-3">2. Net Flow</p>
        <p>TE(Vol→Price) - TE(Price→Vol)。正の値は出来高が価格を先導、負は逆方向の情報フローを示します。</p>

        <p className="font-medium text-gray-700 mt-3">3. 相互情報量 (MI)</p>
        <p>MI(X,Y)は2変数間の非線形な依存度。相関係数と異なり、あらゆる関数関係を検出できます。MI(Close,|Return|)はボラティリティクラスタリングの強さに対応します。</p>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>TE(Vol→Price)のスパイク: 出来高に基づく価格予測が一時的に有効化</li>
          <li>Net Flowの反転: 情報フローの方向が変わる = レジーム変化の兆候</li>
          <li>MI(Close,Vol)の上昇: 出来高と価格の連動性が高まる = トレンド相場</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
