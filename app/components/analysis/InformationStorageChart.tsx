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
  activeInformationStorage,
  predictabilityIndex,
  infoRatioOfScales,
  rollingAIS,
  rollingPredictability,
  rollingInfoRatio,
} from "../../lib/complexity";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function InformationStorageChart({ prices, seriesMode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const { values, times } = extractSeries(prices, seriesMode);

  const ais = useMemo(() => activeInformationStorage(values), [prices, seriesMode]);
  const pred = useMemo(() => predictabilityIndex(values), [prices, seriesMode]);
  const infoRatio = useMemo(() => infoRatioOfScales(values), [prices, seriesMode]);

  const rAIS = useMemo(() => rollingAIS(values, times, 60), [prices, seriesMode]);
  const rPred = useMemo(() => rollingPredictability(values, times, 60), [prices, seriesMode]);
  const rInfoRatio = useMemo(() => rollingInfoRatio(values, times, 120), [prices, seriesMode]);

  useEffect(() => {
    if (!containerRef.current || rAIS.length === 0) return;
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

    const s1 = chart.addSeries(LineSeries, { color: "#8b5cf6", lineWidth: 1, title: "AIS", priceScaleId: "left" });
    s1.setData(rAIS.map((r) => ({ time: r.time as Time, value: r.value })));

    const s2 = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 1, title: "Predictability", priceScaleId: "right" });
    s2.setData(rPred.map((r) => ({ time: r.time as Time, value: r.value })));

    const s3 = chart.addSeries(LineSeries, { color: "#f97316", lineWidth: 1, title: "InfoRatio", priceScaleId: "right" });
    s3.setData(rInfoRatio.map((r) => ({ time: r.time as Time, value: r.value })));

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [rAIS, rPred, rInfoRatio]);

  const predInterp =
    pred > 0.3 ? "予測可能性あり" : pred > 0.1 ? "弱い予測可能性" : "ランダムに近い";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">情報蓄積 / 予測可能性</h3>

      <div className="grid grid-cols-3 gap-3 text-xs mb-3">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Active Info Storage</div>
          <div className="font-mono font-medium text-sm text-purple-600">{ais.toFixed(4)}</div>
          <div className="text-gray-400">過去→現在の自己情報</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Predictability</div>
          <div className={`font-mono font-medium text-sm ${pred > 0.3 ? "text-green-600" : ""}`}>
            {pred.toFixed(3)}
          </div>
          <div className="text-gray-400">{predInterp}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Info Ratio (短期/長期)</div>
          <div className={`font-mono font-medium text-sm ${infoRatio > 1.5 ? "text-orange-600" : infoRatio < 0.7 ? "text-blue-600" : ""}`}>
            {infoRatio.toFixed(3)}
          </div>
          <div className="text-gray-400">{infoRatio > 1.5 ? "短期ノイズ支配" : infoRatio < 0.7 ? "長期構造あり" : "バランス"}</div>
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-2">ローリング情報蓄積・予測可能性 (AIS: 60日, InfoRatio: 120日)</div>
      <div ref={containerRef} className="w-full rounded border border-gray-100" />

      <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-purple-500" /> AIS</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-blue-500" /> Predictability</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-orange-500" /> InfoRatio</span>
      </div>

      <AnalysisGuide title="情報蓄積と予測可能性の理論">
        <p className="font-medium text-gray-700">1. Active Information Storage (AIS)</p>
        <p>AIS = MI(X_past; X_t)。過去k時点の情報が現在にどれだけ「蓄積」されているかを測定します。値が大きいほど、過去の値から現在を予測できます。</p>

        <p className="font-medium text-gray-700 mt-3">2. Predictability Index</p>
        <p>1 - 正規化PE。順列エントロピーの裏返しで、0=完全ランダム、1=完全予測可能。0.3を超えると統計的に有意な予測可能性があります。</p>

        <p className="font-medium text-gray-700 mt-3">3. Information Ratio of Scales</p>
        <p>短期スケール(1-3)のMSE平均 / 長期スケール(8-12)のMSE平均。1より大きい=短期ノイズが支配、1未満=長期構造が支配。</p>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Predictability {"> 0.3"}: テクニカル分析が有効な局面</li>
          <li>AISの急上昇: 自己相関構造が強化 = モメンタム/ミーンリバージョンの機会</li>
          <li>InfoRatio {"< 0.7"}: 長期トレンドが支配 = スイングトレード向き</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
