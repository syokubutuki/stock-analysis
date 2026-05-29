"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  AreaSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeDrawdownSeries,
  detectDrawdownPeriods,
  computeDrawdownStats,
} from "../../lib/drawdown";
import AnalysisGuide from "./AnalysisGuide";
import { setInitialVisibleRange } from "../../lib/chart-visible-range";
import type { PeriodKey } from "../../hooks/useAnalysisData";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

export default function DrawdownChart({ prices, period }: Props) {
  const ddChartRef = useRef<HTMLDivElement>(null);
  const ddApiRef = useRef<IChartApi | null>(null);
  const uwChartRef = useRef<HTMLDivElement>(null);
  const uwApiRef = useRef<IChartApi | null>(null);

  const ddSeries = useMemo(() => computeDrawdownSeries(prices), [prices]);
  const periods = useMemo(
    () => detectDrawdownPeriods(prices, ddSeries, -0.03),
    [prices, ddSeries]
  );
  const stats = useMemo(
    () => computeDrawdownStats(prices, ddSeries, periods),
    [prices, ddSeries, periods]
  );

  // Drawdown chart
  useEffect(() => {
    if (!ddChartRef.current || ddSeries.length < 2) return;
    if (ddApiRef.current) ddApiRef.current.remove();

    const chart = createChart(ddChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: ddChartRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    ddApiRef.current = chart;

    const series = chart.addSeries(AreaSeries, {
      lineColor: "#ef4444",
      lineWidth: 1,
      topColor: "rgba(239, 68, 68, 0.0)",
      bottomColor: "rgba(239, 68, 68, 0.3)",
      title: "ドローダウン (%)",
    });
    series.setData(
      ddSeries.map((d) => ({
        time: d.time as Time,
        value: d.drawdown * 100,
      }))
    );

    if (period) { setInitialVisibleRange(chart, prices, period); } else { chart.timeScale().fitContent(); }
    const handleResize = () => {
      if (ddChartRef.current)
        chart.applyOptions({ width: ddChartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      ddApiRef.current = null;
    };
  }, [ddSeries, prices, period]);

  // Underwater equity chart (price vs peak)
  useEffect(() => {
    if (!uwChartRef.current || ddSeries.length < 2) return;
    if (uwApiRef.current) uwApiRef.current.remove();

    const chart = createChart(uwChartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: uwChartRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    uwApiRef.current = chart;

    const peakSeries = chart.addSeries(LineSeries, {
      color: "#d1d5db",
      lineWidth: 1,
      lineStyle: 2,
      title: "高値更新線",
    });
    peakSeries.setData(
      ddSeries.map((d) => ({ time: d.time as Time, value: d.peak }))
    );

    const priceSeries = chart.addSeries(LineSeries, {
      color: "#1e293b",
      lineWidth: 2,
      title: "株価",
    });
    priceSeries.setData(
      ddSeries.map((d) => ({ time: d.time as Time, value: d.price }))
    );

    if (period) { setInitialVisibleRange(chart, prices, period); } else { chart.timeScale().fitContent(); }
    const handleResize = () => {
      if (uwChartRef.current)
        chart.applyOptions({ width: uwChartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      uwApiRef.current = null;
    };
  }, [ddSeries, prices, period]);

  const pct = (v: number) => (v * 100).toFixed(2);
  const top5 = periods.slice(0, 5);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">ドローダウン分析</h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-4">
        <div className="p-2 bg-red-50 rounded border border-red-100">
          <div className="text-gray-500">最大ドローダウン</div>
          <div className="font-mono font-bold text-red-600">
            {pct(stats.maxDrawdown)}%
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">現在のドローダウン</div>
          <div className={`font-mono font-medium ${stats.currentDrawdown < -0.05 ? "text-red-600" : ""}`}>
            {pct(stats.currentDrawdown)}%
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">DD中の時間割合</div>
          <div className="font-mono font-medium">
            {pct(stats.timeInDrawdown)}%
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Calmar比率</div>
          <div className={`font-mono font-medium ${stats.calmarRatio >= 1 ? "text-green-600" : stats.calmarRatio < 0.5 ? "text-red-600" : ""}`}>
            {stats.calmarRatio.toFixed(2)}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">最長DD期間</div>
          <div className="font-mono font-medium">
            {stats.maxDrawdownDuration}日
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均DD期間</div>
          <div className="font-mono font-medium">
            {stats.avgDrawdownDuration.toFixed(0)}日
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">最長回復日数</div>
          <div className="font-mono font-medium">
            {stats.maxRecoveryDays !== null ? `${stats.maxRecoveryDays}日` : "未回復"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均ドローダウン</div>
          <div className="font-mono font-medium">
            {pct(stats.avgDrawdown)}%
          </div>
        </div>
      </div>

      {/* ドローダウンチャート */}
      <div className="mb-2 text-xs text-gray-500 font-medium">ドローダウン推移 (%)</div>
      <div ref={ddChartRef} className="w-full rounded border border-gray-100 mb-4" />

      {/* 株価 vs 高値更新線 */}
      <div className="mb-2 text-xs text-gray-500 font-medium">
        <span className="text-gray-800">株価</span> vs{" "}
        <span className="text-gray-400">高値更新線 (Running Peak)</span>
      </div>
      <div ref={uwChartRef} className="w-full rounded border border-gray-100 mb-4" />

      {/* Worst drawdown periods */}
      {top5.length > 0 && (
        <div>
          <div className="text-xs font-medium text-gray-700 mb-2">
            ワーストドローダウン Top {top5.length}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-1.5 pr-2 text-gray-500 font-medium">#</th>
                  <th className="text-left py-1.5 px-2 text-gray-500 font-medium">ピーク日</th>
                  <th className="text-left py-1.5 px-2 text-gray-500 font-medium">底値日</th>
                  <th className="text-right py-1.5 px-2 text-gray-500 font-medium">下落率</th>
                  <th className="text-right py-1.5 px-2 text-gray-500 font-medium">下落日数</th>
                  <th className="text-right py-1.5 pl-2 text-gray-500 font-medium">回復日数</th>
                </tr>
              </thead>
              <tbody>
                {top5.map((p, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="py-1.5 pr-2 font-medium text-gray-700">{i + 1}</td>
                    <td className="py-1.5 px-2 font-mono">{p.peakTime}</td>
                    <td className="py-1.5 px-2 font-mono">{p.troughTime}</td>
                    <td className="text-right py-1.5 px-2 font-mono text-red-600">
                      {pct(p.drawdown)}%
                    </td>
                    <td className="text-right py-1.5 px-2 font-mono">{p.duration}日</td>
                    <td className="text-right py-1.5 pl-2 font-mono">
                      {p.recoveryDays !== null ? `${p.recoveryDays}日` : "未回復"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <AnalysisGuide title="ドローダウン分析の読み方">
        <p>
          <span className="font-medium">ドローダウン:</span>{" "}
          直近の高値（ランニングピーク）からの下落率。リスク管理で最も重要な指標。
          投資の「最悪のシナリオ」を定量化する。
        </p>
        <p>
          <span className="font-medium">最大ドローダウン (MDD):</span>{" "}
          期間中に経験した最大の下落率。-30%以上は大きなリスク。
          過去のMDDは将来も同程度の下落が起こりうることを示唆する。
        </p>
        <p>
          <span className="font-medium">Calmar比率:</span>{" "}
          年率リターン / |最大ドローダウン|。1以上なら良好、2以上は優秀。
          リスクに見合ったリターンが得られているかを評価する。
        </p>
        <p>
          <span className="font-medium">回復日数:</span>{" "}
          ドローダウンから元の水準に戻るまでの日数。
          長い回復期間は投資家の忍耐力を試す。「未回復」は現在も高値を更新していないことを意味する。
        </p>
        <p>
          <span className="font-medium">DD中の時間割合:</span>{" "}
          期間中どれだけの時間ドローダウン状態にあったか。
          80%以上は構造的な弱さを示す場合がある。
        </p>
      </AnalysisGuide>
    </div>
  );
}
