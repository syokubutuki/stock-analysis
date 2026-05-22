"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { logReturns } from "../../lib/transforms";
import { ewmaVolatility, detectVolRegimes, volClustering } from "../../lib/volatility";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const REGIME_COLORS: Record<string, string> = {
  low: "rgba(34, 197, 94, 0.15)",
  medium: "rgba(234, 179, 8, 0.15)",
  high: "rgba(239, 68, 80, 0.15)",
};

const REGIME_LABELS: Record<string, string> = {
  low: "低ボラ",
  medium: "中ボラ",
  high: "高ボラ",
};

export default function VolatilityChart({ prices }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const closes = prices.map((p) => p.close);
  const times = prices.map((p) => p.time);
  const lr = logReturns(closes);
  const lrTimes = times.slice(1);

  const volData = useMemo(
    () => ewmaVolatility(lr, lrTimes, 0.94, 20),
    [prices]
  );
  const { regimes, thresholds } = useMemo(
    () => detectVolRegimes(volData),
    [volData]
  );
  const clustering = useMemo(() => volClustering(lr), [prices]);

  // 年率換算
  const annualizeFactor = Math.sqrt(252);
  const currentVol = volData.length > 0 ? volData[volData.length - 1].ewma * annualizeFactor * 100 : 0;

  useEffect(() => {
    if (!containerRef.current || volData.length === 0) return;
    if (chartRef.current) chartRef.current.remove();

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 250,
      rightPriceScale: { visible: true },
      leftPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    // EWMA
    const ewmaSeries = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 2,
      title: "EWMA Vol",
      priceScaleId: "right",
    });
    ewmaSeries.setData(
      volData.map((v) => ({
        time: v.time as Time,
        value: v.ewma * annualizeFactor * 100, // 年率%
      }))
    );

    // 実現ボラティリティ
    const realizedSeries = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 1,
      title: "Realized Vol (20d)",
      priceScaleId: "right",
    });
    realizedSeries.setData(
      volData.map((v) => ({
        time: v.time as Time,
        value: v.realized * annualizeFactor * 100,
      }))
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current)
        chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [volData]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">ボラティリティ分析</h3>

      <div ref={containerRef} className="w-full rounded border border-gray-100" />

      <div className="mt-2 flex gap-3 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-red-500" /> EWMA (λ=0.94)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-blue-500" /> 実現Vol (20日)
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">現在のEWMA Vol (年率)</div>
          <div className={`font-mono font-medium text-sm ${currentVol > 30 ? "text-red-600" : currentVol > 20 ? "text-orange-600" : "text-green-600"}`}>
            {currentVol.toFixed(1)}%
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">ボラクラスタリング</div>
          <div className={`font-mono font-medium text-sm ${clustering > 0.3 ? "text-orange-600" : ""}`}>
            {clustering.toFixed(3)}
          </div>
          <div className="text-gray-400">{clustering > 0.3 ? "強い" : clustering > 0.1 ? "中程度" : "弱い"}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">低ボラ閾値 (年率)</div>
          <div className="font-mono font-medium">{(thresholds.low * annualizeFactor * 100).toFixed(1)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">高ボラ閾値 (年率)</div>
          <div className="font-mono font-medium">{(thresholds.high * annualizeFactor * 100).toFixed(1)}%</div>
        </div>
      </div>

      {/* レジーム履歴 */}
      <div className="mt-3">
        <div className="text-xs text-gray-500 mb-1">ボラティリティレジーム推移</div>
        <div className="flex h-6 rounded overflow-hidden border border-gray-200">
          {regimes.map((r, i) => {
            const startIdx = volData.findIndex((v) => v.time >= r.start);
            const endIdx = volData.findIndex((v) => v.time > r.end);
            const span = (endIdx > 0 ? endIdx : volData.length) - (startIdx > 0 ? startIdx : 0);
            const widthPct = (span / volData.length) * 100;
            return (
              <div
                key={i}
                className="flex items-center justify-center text-[9px] font-medium"
                style={{
                  width: `${widthPct}%`,
                  backgroundColor: REGIME_COLORS[r.regime],
                  color: r.regime === "high" ? "#dc2626" : r.regime === "low" ? "#16a34a" : "#ca8a04",
                }}
                title={`${r.start} 〜 ${r.end}: ${REGIME_LABELS[r.regime]}`}
              >
                {widthPct > 5 ? REGIME_LABELS[r.regime] : ""}
              </div>
            );
          })}
        </div>
      </div>

      <AnalysisGuide title="ボラティリティ分析の読み方">
        <p><span className="font-medium">EWMA (Exponentially Weighted Moving Average):</span> {"σ²_t = λσ²_{t-1} + (1-λ)r²_t"} で計算される指数加重ボラティリティです。λ=0.94はRiskMetrics標準。直近のデータに多くのウェイトを置くため、ボラティリティの変化に素早く反応します。</p>
        <p><span className="font-medium">実現ボラティリティ (20日):</span> 直近20営業日のリターンの標準偏差。EWMAより遅延がありますが安定的です。</p>
        <p><span className="font-medium">年率換算:</span> {"日次ボラティリティ × √252"} で年率に換算しています。日経平均の年率ボラティリティは通常15〜25%程度です。</p>
        <p><span className="font-medium">ボラティリティクラスタリング:</span> 絶対リターンのlag-1自己相関です。0.3以上は強いクラスタリング(大きな変動が続きやすい)を意味します。</p>
        <p><span className="font-medium">レジーム帯:</span> ボラティリティを3分位(低/中/高)に分け、時間推移を色帯で表示。レジーム転換のタイミングが一目で分かります。</p>
        <p><span className="font-medium">トレードへの活用:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li>低ボラ→高ボラへの転換初期は、大きなトレンド発生の兆候。ブレイクアウト戦略のチャンス。</li>
          <li>高ボラ期間中は、ポジションサイズをボラティリティに応じて縮小(リスクパリティ)。</li>
          <li>EWMAが実現Volを大きく上回っている場合、直近にショックがあり過剰反応している可能性。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
