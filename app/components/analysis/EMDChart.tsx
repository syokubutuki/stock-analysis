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
import { computeEMD, hilbertTransform } from "../../lib/emd";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const IMF_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6",
];

export default function EMDChart({ prices }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const residueRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const residueChartRef = useRef<IChartApi | null>(null);

  const closes = prices.map((p) => p.close);
  const times = prices.map((p) => p.time);
  const lr = logReturns(closes);
  const lrTimes = times.slice(1);

  const emdResult = useMemo(() => computeEMD(lr, 5), [prices]);

  // 各IMFのヒルベルト変換情報
  const hilbertInfo = useMemo(() => {
    return emdResult.imfs.map((imf) => {
      const h = hilbertTransform(imf.data);
      const avgAmp =
        h.amplitude.reduce((a, b) => a + b, 0) / h.amplitude.length;
      // 平均周期の推定（ゼロクロッシングから）
      let crossings = 0;
      for (let i = 1; i < imf.data.length; i++) {
        if (imf.data[i - 1] * imf.data[i] < 0) crossings++;
      }
      const avgPeriod = crossings > 0 ? (2 * imf.data.length) / crossings : 0;
      return { avgAmp, avgPeriod };
    });
  }, [emdResult]);

  useEffect(() => {
    if (!containerRef.current || emdResult.imfs.length === 0) return;

    if (chartRef.current) chartRef.current.remove();

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    emdResult.imfs.forEach((imf, idx) => {
      const series = chart.addSeries(LineSeries, {
        color: IMF_COLORS[idx % IMF_COLORS.length],
        lineWidth: 1,
        title: imf.label,
      });
      series.setData(
        imf.data.map((v, i) => ({
          time: lrTimes[i] as Time,
          value: v,
        }))
      );
    });

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
  }, [prices, emdResult]);

  // 残差チャート
  useEffect(() => {
    if (!residueRef.current || emdResult.residue.length === 0) return;

    if (residueChartRef.current) residueChartRef.current.remove();

    const chart = createChart(residueRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: residueRef.current.clientWidth,
      height: 100,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    residueChartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#6b7280",
      lineWidth: 1,
      title: "残差(トレンド)",
    });
    series.setData(
      emdResult.residue.map((v, i) => ({
        time: lrTimes[i] as Time,
        value: v,
      }))
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (residueRef.current)
        chart.applyOptions({ width: residueRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      residueChartRef.current = null;
    };
  }, [prices, emdResult]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        EMD (経験的モード分解) / Hilbert-Huang
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        対数リターンを非線形・非定常な内在モード(IMF)に分解
      </p>

      <div ref={containerRef} className="w-full rounded border border-gray-100" />

      <div className="mt-2">
        <div className="text-xs text-gray-500 mb-1">残差成分 (長期トレンド)</div>
        <div ref={residueRef} className="w-full rounded border border-gray-100" />
      </div>

      {emdResult.imfs.length > 0 && (
        <div className="mt-3 grid grid-cols-3 sm:grid-cols-5 gap-2 text-xs">
          {emdResult.imfs.map((imf, i) => (
            <div key={imf.label} className="p-2 bg-gray-50 rounded">
              <div
                className="font-medium"
                style={{ color: IMF_COLORS[i % IMF_COLORS.length] }}
              >
                {imf.label}
              </div>
              <div>周期: ~{hilbertInfo[i]?.avgPeriod.toFixed(1) || "?"}日</div>
              <div>振幅: {(hilbertInfo[i]?.avgAmp * 100).toFixed(3) || "?"}%</div>
            </div>
          ))}
        </div>
      )}

      <AnalysisGuide title="EMD / Hilbert-Huang変換の読み方">
        <p><span className="font-medium">EMD(経験的モード分解)とは:</span> 信号を「内在モード関数(IMF)」と呼ばれる振動成分に分解する手法です。フーリエ変換やウェーブレットと異なり、基底関数(sin/cosなど)を仮定せず、データ自身から振動成分を抽出します。非線形・非定常な金融時系列に適しています。</p>
        <p><span className="font-medium">各IMFの意味:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">IMF1:</span> 最も高周波(短周期)の成分。日々のノイズや短期的な投機的動きを反映。</li>
          <li><span className="font-medium">IMF2〜3:</span> 中周期の成分。数日〜数週間のスイングを反映。デイトレード〜スイングトレードに関連。</li>
          <li><span className="font-medium">IMF4〜5:</span> 低周期の成分。数週間〜数ヶ月のサイクル。セクターローテーションや決算サイクルなどを反映する可能性。</li>
          <li><span className="font-medium">残差(Residue):</span> 全IMFを差し引いた後に残る成分。長期的なトレンドや構造的な変化を表す。</li>
        </ul>
        <p><span className="font-medium">周期と振幅:</span> 各IMFの「周期」はゼロクロッシング(値が0を横切る回数)から推定しています。「振幅」はヒルベルト変換による瞬時振幅の平均で、その成分がリターン全体にどれだけ寄与しているかを示します。</p>
        <p><span className="font-medium">トレードへの活用:</span> 低次IMF(IMF1-2)の振幅が大きい時期はノイズが支配的で、テクニカル分析の信頼性が下がります。高次IMF(IMF4-5)や残差の方向を見ることで、中長期のトレンド方向を把握できます。残差が上向きなら構造的な上昇トレンド、下向きなら下降トレンドです。</p>
      </AnalysisGuide>
    </div>
  );
}
