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
import { detectStructuralBreaks } from "../../lib/structural-break";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function StructuralBreakChart({ prices, seriesMode }: Props) {
  const cusumRef = useRef<HTMLDivElement>(null);
  const cusumApiRef = useRef<IChartApi | null>(null);

  const { values, times } = extractSeries(prices, seriesMode);
  const result = useMemo(
    () => detectStructuralBreaks(values, times, 5, 30),
    [prices, seriesMode]
  );

  useEffect(() => {
    if (!cusumRef.current) return;
    if (cusumApiRef.current) cusumApiRef.current.remove();

    const chart = createChart(cusumRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: cusumRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    cusumApiRef.current = chart;

    if (result.cusum.length > 0) {
      const series = chart.addSeries(LineSeries, {
        color: "#2563eb",
        lineWidth: 1,
        title: "CUSUM",
      });
      series.setData(
        result.cusum.map(d => ({
          time: d.time as Time,
          value: d.value,
        }))
      );

      // Mark break points with vertical markers via additional series
      for (const bp of result.breaks) {
        const marker = chart.addSeries(LineSeries, {
          color: "#ef4444",
          lineWidth: 2,
          lineStyle: 1,
          lastValueVisible: false,
          priceLineVisible: false,
        });
        // Draw a vertical indicator by placing extreme values
        const cusumAtBreak = result.cusum.find(c => c.time === bp.time);
        if (cusumAtBreak) {
          marker.setData([
            { time: bp.time as Time, value: cusumAtBreak.value },
          ]);
        }
      }

      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver(() => {
      if (cusumRef.current) chart.applyOptions({ width: cusumRef.current.clientWidth });
    });
    ro.observe(cusumRef.current);
    return () => { ro.disconnect(); chart.remove(); cusumApiRef.current = null; };
  }, [result]);

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        構造変化検定 (CUSUM + Binary Segmentation)
      </h3>

      <div className="bg-gray-50 rounded p-2 text-xs text-gray-600 mb-3">
        検出された変化点: <span className="font-bold">{result.breaks.length}個</span>
        （{result.nSegments}セグメント）
      </div>

      {result.breaks.length > 0 && (
        <div className="mb-3">
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr className="border-b">
                <th className="text-left py-1 text-gray-500">時点</th>
                <th className="text-right py-1 text-gray-500">統計量</th>
                <th className="text-right py-1 text-gray-500">前平均</th>
                <th className="text-right py-1 text-gray-500">後平均</th>
                <th className="text-right py-1 text-gray-500">変化</th>
              </tr>
            </thead>
            <tbody>
              {result.breaks.map((bp, i) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="py-1">{bp.time}</td>
                  <td className="text-right font-mono">{bp.stat.toFixed(3)}</td>
                  <td className="text-right font-mono">{bp.meanBefore.toFixed(5)}</td>
                  <td className="text-right font-mono">{bp.meanAfter.toFixed(5)}</td>
                  <td className={`text-right font-mono ${bp.meanAfter > bp.meanBefore ? "text-green-700" : "text-red-700"}`}>
                    {((bp.meanAfter - bp.meanBefore) * 100).toFixed(3)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-xs text-gray-600 mb-3">{result.interpretation}</div>

      <div className="text-xs text-gray-500 mb-1">CUSUM統計量</div>
      <div ref={cusumRef} />

      <AnalysisGuide title="構造変化検定の詳細理論">
        <p className="font-medium text-gray-700">1. 構造変化検定とは</p>
        <p>
          時系列データの統計的性質（平均・分散）が途中で変化する「構造変化点」を検出します。
          例えば、コロナショックの前後でリターンの性質が変わるようなケースです。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. CUSUM統計量</p>
        <p>
          {"CUSUM_t = Σ_{i=1}^{t}(x_i - x̄) / (s√n)"}
          <br />
          累積和が大きく変動する時点が構造変化点の候補。Binary Segmentationで再帰的に分割。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>変化点を跨ぐバックテストは結果を歪める</li>
          <li>直近の変化点以降のデータでモデルを再推定すべき</li>
          <li>変化点の検出は「レジーム分析」の補完情報</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Binary Segmentationは計算効率は良いが最適分割を保証しない</li>
          <li>最小セグメント長が結果に影響する（デフォルト30日）</li>
          <li>真のBai-Perron検定はF検定に基づくが、ここではCUSUM近似を使用</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
