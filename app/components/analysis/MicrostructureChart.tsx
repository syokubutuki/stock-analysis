"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { microstructureAnalysis } from "../../lib/microstructure";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function MicrostructureChart({ prices }: Props) {
  const rollRef = useRef<HTMLDivElement>(null);
  const amihudRef = useRef<HTMLDivElement>(null);
  const rollApiRef = useRef<IChartApi | null>(null);
  const amihudApiRef = useRef<IChartApi | null>(null);

  const result = useMemo(() => microstructureAnalysis(prices), [prices]);

  // Roll spread chart
  useEffect(() => {
    if (!rollRef.current) return;
    if (rollApiRef.current) rollApiRef.current.remove();

    const chart = createChart(rollRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: rollRef.current.clientWidth,
      height: 150,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    rollApiRef.current = chart;

    if (result.roll.rollingSpread.length > 0) {
      const series = chart.addSeries(LineSeries, {
        color: "#8b5cf6",
        lineWidth: 1,
        title: "Roll Spread (bps)",
      });
      series.setData(
        result.roll.rollingSpread.map(d => ({
          time: d.time as Time,
          value: d.spread,
        }))
      );
      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver(() => {
      if (rollRef.current) chart.applyOptions({ width: rollRef.current.clientWidth });
    });
    ro.observe(rollRef.current);
    return () => { ro.disconnect(); chart.remove(); };
  }, [result]);

  // Amihud chart
  useEffect(() => {
    if (!amihudRef.current) return;
    if (amihudApiRef.current) amihudApiRef.current.remove();

    const chart = createChart(amihudRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: amihudRef.current.clientWidth,
      height: 150,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    amihudApiRef.current = chart;

    if (result.amihud.rollingAmihud.length > 0) {
      const series = chart.addSeries(LineSeries, {
        color: "#d97706",
        lineWidth: 1,
        title: "Amihud (×10⁻⁶)",
      });
      series.setData(
        result.amihud.rollingAmihud.map(d => ({
          time: d.time as Time,
          value: d.amihud,
        }))
      );
      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver(() => {
      if (amihudRef.current) chart.applyOptions({ width: amihudRef.current.clientWidth });
    });
    ro.observe(amihudRef.current);
    return () => { ro.disconnect(); chart.remove(); };
  }, [result]);

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        マイクロストラクチャー（Roll Spread / Amihud）
      </h3>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="border rounded p-2">
          <div className="text-xs font-medium text-gray-600 mb-1">Roll スプレッド推定</div>
          <div className="font-mono text-sm">{result.roll.spreadBps.toFixed(1)} bps</div>
          <div className="text-xs text-gray-500">Cov = {result.roll.autoCovariance.toExponential(3)}</div>
        </div>
        <div className="border rounded p-2">
          <div className="text-xs font-medium text-gray-600 mb-1">Amihud 非流動性比率</div>
          <div className="font-mono text-sm">{result.amihud.illiquidity.toFixed(4)} ×10⁻⁶</div>
          <div className="text-xs text-gray-500">log₁₀ = {result.amihud.logAmihud.toFixed(2)}</div>
        </div>
      </div>

      <div className="text-xs text-gray-600 mb-2">{result.roll.interpretation}</div>
      <div className="text-xs text-gray-600 mb-3">{result.amihud.interpretation}</div>

      <div className="text-xs text-gray-500 mb-1">ローリング Roll Spread (60日窓)</div>
      <div ref={rollRef} />

      <div className="text-xs text-gray-500 mb-1 mt-3">ローリング Amihud 比率 (60日窓)</div>
      <div ref={amihudRef} />

      <AnalysisGuide title="マイクロストラクチャー指標の詳細理論">
        <p className="font-medium text-gray-700">1. Roll (1984) スプレッド推定</p>
        <p>
          日次終値データからビッド・アスクスプレッドを推定する手法。
          {"Spread = 2√(-Cov(Δp_t, Δp_{t-1}))"}
          <br />
          ビッド・アスクの間で価格がバウンスすると、隣接するリターンに負の自己共分散が生じます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. Amihud (2002) 非流動性比率</p>
        <p>
          {"ILLIQ = (1/D)Σ|r_t|/Volume_t"}
          <br />
          「1単位の出来高あたりの価格変動」を測定。
          高い値は「少しの取引で大きく動く」＝非流動的を意味します。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>スプレッドが広い → 取引コストが高い → 頻繁な売買は不利</li>
          <li>Amihudが高い → 大口注文が市場を動かしやすい → スリッページに注意</li>
          <li>流動性が低下するとリスクプレミアムが上昇（流動性リスク）</li>
          <li>ローリング指標の急上昇は市場ストレスの兆候</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>日次データでのRollスプレッド推定は精度が低い（本来は高頻度データ用）</li>
          <li>正の自己共分散（モメンタム）があるとRollスプレッドは推定不可</li>
          <li>Amihudは出来高の通貨単位に依存するため、銘柄間比較にはlog変換を使用</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
