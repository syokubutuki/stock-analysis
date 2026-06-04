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
import { fitAsymmetricGarch } from "../../lib/gjr-egarch";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function AsymmetricGarchChart({ prices, seriesMode }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);

  const { values, times } = extractSeries(prices, seriesMode);
  const result = useMemo(() => fitAsymmetricGarch(values), [prices, seriesMode]);

  useEffect(() => {
    if (!chartRef.current) return;
    if (chartApiRef.current) chartApiRef.current.remove();

    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartApiRef.current = chart;

    // GJR conditional vol
    if (result.gjr.conditionalVol.length > 0) {
      const gjrSeries = chart.addSeries(LineSeries, {
        color: "#dc2626",
        lineWidth: 1,
        title: "GJR-GARCH",
      });
      gjrSeries.setData(
        result.gjr.conditionalVol.map((v, i) => ({
          time: times[i] as Time,
          value: v,
        }))
      );

      const egarchSeries = chart.addSeries(LineSeries, {
        color: "#2563eb",
        lineWidth: 1,
        title: "EGARCH",
      });
      egarchSeries.setData(
        result.egarch.conditionalVol.map((v, i) => ({
          time: times[i] as Time,
          value: v,
        }))
      );

      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver(() => {
      if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth });
    });
    ro.observe(chartRef.current);
    return () => { ro.disconnect(); chart.remove(); };
  }, [result, times]);

  const bestColor =
    result.bestModel === "GJR" ? "text-red-700 bg-red-50" :
    result.bestModel === "EGARCH" ? "text-blue-700 bg-blue-50" :
    "text-gray-700 bg-gray-50";

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        非対称GARCHモデル (GJR / EGARCH)
      </h3>

      <div className={`rounded p-2 text-xs mb-3 ${bestColor}`}>
        <span className="font-semibold">最適: {result.bestModel}</span>
        <span className="ml-2">(LL: GJR={result.gjr.logLikelihood.toFixed(1)}, EGARCH={result.egarch.logLikelihood.toFixed(1)}, GARCH={result.standardGarch.logLikelihood.toFixed(1)})</span>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="border rounded p-2">
          <div className="text-xs font-medium text-gray-600 mb-1">GJR-GARCH(1,1)</div>
          <table className="text-xs w-full">
            <tbody>
              <tr><td className="text-gray-500">ω</td><td className="text-right font-mono">{result.gjr.omega.toExponential(3)}</td></tr>
              <tr><td className="text-gray-500">α</td><td className="text-right font-mono">{result.gjr.alpha.toFixed(4)}</td></tr>
              <tr><td className="text-gray-500">β</td><td className="text-right font-mono">{result.gjr.beta.toFixed(4)}</td></tr>
              <tr><td className="text-gray-500">γ (非対称)</td><td className="text-right font-mono font-semibold">{result.gjr.gamma.toFixed(4)}</td></tr>
              <tr><td className="text-gray-500">レバレッジ倍率</td><td className="text-right font-mono">{result.gjr.leverageRatio.toFixed(2)}x</td></tr>
            </tbody>
          </table>
        </div>
        <div className="border rounded p-2">
          <div className="text-xs font-medium text-gray-600 mb-1">EGARCH(1,1)</div>
          <table className="text-xs w-full">
            <tbody>
              <tr><td className="text-gray-500">ω</td><td className="text-right font-mono">{result.egarch.omega.toExponential(3)}</td></tr>
              <tr><td className="text-gray-500">α</td><td className="text-right font-mono">{result.egarch.alpha.toFixed(4)}</td></tr>
              <tr><td className="text-gray-500">β</td><td className="text-right font-mono">{result.egarch.beta.toFixed(4)}</td></tr>
              <tr><td className="text-gray-500">γ (非対称)</td><td className="text-right font-mono font-semibold">{result.egarch.gamma.toFixed(4)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-xs text-gray-600 mb-3">{result.interpretation}</div>

      <div className="text-xs text-gray-500 mb-1">条件付きボラティリティ比較</div>
      <div ref={chartRef} />

      <AnalysisGuide title="非対称GARCHモデルの詳細理論">
        <p className="font-medium text-gray-700">1. 非対称GARCHとは</p>
        <p>
          標準的なGARCH(1,1)はリターンの符号に関係なく同じボラティリティ反応を仮定します。
          しかし実際の株式市場では「下落時にボラティリティが上昇しやすい」（レバレッジ効果）という非対称性があります。
          GJR-GARCHとEGARCHはこの非対称性を明示的にモデル化します。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          {"GJR-GARCH: σ²_t = ω + (α + γ·I_{ε<0})ε²_{t-1} + βσ²_{t-1}"}
          <br />
          {"  γ>0 → 下落時にα+γが適用され、ボラ反応が増大"}
          <br /><br />
          {"EGARCH: ln(σ²_t) = ω + α|z_{t-1}| + γz_{t-1} + β·ln(σ²_{t-1})"}
          <br />
          {"  γ<0 → 負のショック(z<0)でln(σ²)が上昇"}
          <br />
          {"  対数モデルなのでσ²>0が自動的に保証される"}
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>GJR γ {">"} 0: 下落時のボラ反応増大。レバレッジ倍率が大きいほど非対称性が強い</li>
          <li>EGARCH γ {"<"} 0: 同様に非対称効果。符号が逆なので注意</li>
          <li>対数尤度が高いモデルがデータへの当てはまりが良い</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>非対称性が強い → 下落局面ではプットオプションが急騰しやすい</li>
          <li>VaR計算にGJR/EGARCHを使うことで、下落時のリスクをより正確に捕捉</li>
          <li>ボラティリティ戦略（ストラドル等）の方向バイアスの参考に</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>パラメータ推定は局所解に陥りやすい（グリッドサーチ+座標降下法で対応）</li>
          <li>サンプル数が少ないとGJRとEGARCHの差が不明確になる</li>
          <li>EGARCHはσ²の正値制約が不要だが、パラメータの解釈がやや複雑</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
