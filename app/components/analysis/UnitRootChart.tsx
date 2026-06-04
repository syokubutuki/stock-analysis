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
import { unitRootTest } from "../../lib/unit-root";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function UnitRootChart({ prices, seriesMode }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);

  const { values, times } = extractSeries(prices, seriesMode);
  const result = useMemo(() => unitRootTest(values, times, 252), [prices, seriesMode]);

  useEffect(() => {
    if (!chartRef.current) return;
    if (chartApiRef.current) chartApiRef.current.remove();

    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 220,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartApiRef.current = chart;

    if (result.rollingADF.length > 0) {
      const statSeries = chart.addSeries(LineSeries, {
        color: "#2563eb",
        lineWidth: 1,
        title: "ADF統計量",
      });
      statSeries.setData(
        result.rollingADF.map((d) => ({
          time: d.time as Time,
          value: d.stat,
        }))
      );

      const critSeries = chart.addSeries(LineSeries, {
        color: "#ef4444",
        lineWidth: 1,
        lineStyle: 2,
        title: "5%臨界値",
      });
      critSeries.setData(
        result.rollingADF.map((d) => ({
          time: d.time as Time,
          value: d.critical5,
        }))
      );

      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver(() => {
      if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth });
    });
    ro.observe(chartRef.current);
    return () => { ro.disconnect(); chart.remove(); };
  }, [result]);

  const conclusionColor =
    result.conclusion === "stationary" ? "text-green-700 bg-green-50" :
    result.conclusion === "unit_root" ? "text-red-700 bg-red-50" :
    "text-yellow-700 bg-yellow-50";
  const conclusionText =
    result.conclusion === "stationary" ? "定常 (Stationary)" :
    result.conclusion === "unit_root" ? "単位根あり (Unit Root)" :
    "判定不明 (Ambiguous)";

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        単位根検定 (ADF / KPSS)
      </h3>

      {/* 総合判定 */}
      <div className={`rounded-lg p-3 mb-4 ${conclusionColor}`}>
        <div className="font-semibold text-sm mb-1">総合判定: {conclusionText}</div>
        <div className="text-xs">
          ADF: {result.adf.isStationary ? "定常" : "非定常"} / KPSS: {result.kpss.isStationary ? "定常" : "非定常"}
        </div>
      </div>

      {/* ADF / KPSS 結果テーブル */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="border rounded p-2">
          <div className="text-xs font-medium text-gray-600 mb-1">ADF検定</div>
          <table className="text-xs w-full">
            <tbody>
              <tr><td className="text-gray-500">統計量</td><td className="text-right font-mono">{result.adf.testStat.toFixed(4)}</td></tr>
              <tr><td className="text-gray-500">p値</td><td className="text-right font-mono">{result.adf.pValue.toFixed(4)}</td></tr>
              <tr><td className="text-gray-500">ラグ数</td><td className="text-right font-mono">{result.adf.lags}</td></tr>
              <tr><td className="text-gray-500">1%臨界値</td><td className="text-right font-mono">{result.adf.criticalValues["1%"]}</td></tr>
              <tr><td className="text-gray-500">5%臨界値</td><td className="text-right font-mono">{result.adf.criticalValues["5%"]}</td></tr>
              <tr><td className="text-gray-500">10%臨界値</td><td className="text-right font-mono">{result.adf.criticalValues["10%"]}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="border rounded p-2">
          <div className="text-xs font-medium text-gray-600 mb-1">KPSS検定</div>
          <table className="text-xs w-full">
            <tbody>
              <tr><td className="text-gray-500">統計量</td><td className="text-right font-mono">{result.kpss.testStat.toFixed(4)}</td></tr>
              <tr><td className="text-gray-500">1%臨界値</td><td className="text-right font-mono">{result.kpss.criticalValues["1%"]}</td></tr>
              <tr><td className="text-gray-500">5%臨界値</td><td className="text-right font-mono">{result.kpss.criticalValues["5%"]}</td></tr>
              <tr><td className="text-gray-500">10%臨界値</td><td className="text-right font-mono">{result.kpss.criticalValues["10%"]}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* 解釈 */}
      <div className="text-xs text-gray-600 space-y-1 mb-3">
        <p>{result.adf.interpretation}</p>
        <p>{result.kpss.interpretation}</p>
      </div>

      {/* ローリングADFチャート */}
      <div className="text-xs text-gray-500 mb-1">ローリングADF統計量 (252日窓)</div>
      <div ref={chartRef} />

      <AnalysisGuide title="単位根検定の詳細理論">
        <p className="font-medium text-gray-700">1. 単位根検定とは</p>
        <p>
          時系列データが「定常（一定の平均・分散に回帰する）」か「非定常（ランダムウォークのように漂流する）」かを判定する統計検定です。
          株価は通常非定常（単位根あり）ですが、対数リターンは定常になることが多いです。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. ADF検定 (Augmented Dickey-Fuller)</p>
        <p>
          {"帰無仮説 H₀: 単位根が存在する（非定常）"}
          <br />
          {"回帰式: ΔY_t = α + γY_{t-1} + Σδ_iΔY_{t-i} + ε_t"}
          <br />
          {"検定統計量 = γ / SE(γ)。この値が臨界値より小さい（より負）なら帰無仮説を棄却→定常と判定。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">3. KPSS検定 (Kwiatkowski-Phillips-Schmidt-Shin)</p>
        <p>
          {"帰無仮説 H₀: 定常である"}
          <br />
          {"ADFとは逆の帰無仮説を持つため、両方を組み合わせることで頑健な判定ができます。"}
          <br />
          {"統計量が臨界値より大きければ帰無仮説を棄却→非定常と判定。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ADF棄却 + KPSS非棄却 → 定常（最も確実）</li>
          <li>ADF非棄却 + KPSS棄却 → 単位根あり（最も確実）</li>
          <li>両方棄却 or 両方非棄却 → 判定困難（差分や変換を検討）</li>
          <li>ローリングADF: 青線が赤線（5%臨界値）を下回る区間は局所的に定常</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>定常系列 → 平均回帰戦略（移動平均からの乖離で売買）が有効</li>
          <li>非定常系列 → トレンドフォロー戦略（モメンタム）が有効</li>
          <li>差分を取って定常化 → ARIMA等の時系列モデルで予測可能</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>構造変化（レジームスイッチ）があるとADFの検出力が低下する</li>
          <li>サンプルサイズが小さいと検出力不足で判定が不安定になる</li>
          <li>ラグ次数の選択により結果が変わることがある（BICで自動選択）</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
