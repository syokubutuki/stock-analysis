"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeRiskMetrics, rollingRiskMetrics } from "../../lib/risk-metrics";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function RiskMetricsPanel({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);

  const metrics = useMemo(() => computeRiskMetrics(prices), [prices]);
  const rolling = useMemo(() => rollingRiskMetrics(prices, 60), [prices]);

  useEffect(() => {
    if (!chartRef.current || rolling.length < 2) return;
    if (apiRef.current) apiRef.current.remove();

    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 220,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;

    const sharpeSeries = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      title: "Sharpe (60日)",
      priceScaleId: "left",
    });
    sharpeSeries.setData(
      rolling.map((r) => ({ time: r.time as Time, value: r.sharpe }))
    );

    const volSeries = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 1,
      title: "Vol年率 (60日)",
      priceScaleId: "right",
    });
    volSeries.setData(
      rolling.map((r) => ({ time: r.time as Time, value: r.vol * 100 }))
    );

    const zeroLine = chart.addSeries(LineSeries, {
      color: "rgba(107, 114, 128, 0.3)",
      lineWidth: 1,
      lineStyle: 2,
      title: "",
      priceScaleId: "left",
    });
    zeroLine.setData(
      rolling.map((r) => ({ time: r.time as Time, value: 0 }))
    );

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (chartRef.current)
        chart.applyOptions({ width: chartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      apiRef.current = null;
    };
  }, [rolling]);

  const pct = (v: number) => (v * 100).toFixed(2);
  const fmt = (v: number) => v.toFixed(2);

  const ratingColor = (v: number, thresholds: [number, number]) =>
    v >= thresholds[1]
      ? "text-green-600"
      : v <= thresholds[0]
      ? "text-red-600"
      : "";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">リスク指標</h3>

      {/* Return metrics */}
      <div className="text-xs font-medium text-gray-500 mb-1">リターン</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
        <MetricBox
          label="累積リターン"
          value={`${pct(metrics.totalReturn)}%`}
          color={metrics.totalReturn >= 0 ? "text-green-600" : "text-red-600"}
        />
        <MetricBox
          label="年率リターン"
          value={`${pct(metrics.annualizedReturn)}%`}
          color={metrics.annualizedReturn >= 0 ? "text-green-600" : "text-red-600"}
        />
        <MetricBox
          label="最良日"
          value={`+${pct(metrics.bestDay)}%`}
          color="text-green-600"
        />
        <MetricBox
          label="最悪日"
          value={`${pct(metrics.worstDay)}%`}
          color="text-red-600"
        />
      </div>

      {/* Risk metrics */}
      <div className="text-xs font-medium text-gray-500 mb-1">リスク</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
        <MetricBox label="日次ボラティリティ" value={`${pct(metrics.dailyVol)}%`} />
        <MetricBox label="年率ボラティリティ" value={`${pct(metrics.annualizedVol)}%`} />
        <MetricBox
          label="最大ドローダウン"
          value={`${pct(metrics.maxDrawdown)}%`}
          color="text-red-600"
        />
        <MetricBox label="歪度 / 尖度" value={`${fmt(metrics.skewness)} / ${fmt(metrics.kurtosis)}`} />
      </div>

      {/* Risk-adjusted */}
      <div className="text-xs font-medium text-gray-500 mb-1">リスク調整済み</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
        <MetricBox
          label="シャープレシオ"
          value={fmt(metrics.sharpeRatio)}
          color={ratingColor(metrics.sharpeRatio, [0, 1])}
          sub={
            metrics.sharpeRatio >= 2
              ? "優秀"
              : metrics.sharpeRatio >= 1
              ? "良好"
              : metrics.sharpeRatio >= 0
              ? "普通"
              : "不良"
          }
        />
        <MetricBox
          label="ソルティノレシオ"
          value={fmt(metrics.sortinoRatio)}
          color={ratingColor(metrics.sortinoRatio, [0, 1.5])}
        />
        <MetricBox
          label="Calmar比率"
          value={fmt(metrics.calmarRatio)}
          color={ratingColor(metrics.calmarRatio, [0.5, 1])}
        />
        <MetricBox
          label="プロフィットファクター"
          value={fmt(metrics.profitFactor)}
          color={ratingColor(metrics.profitFactor, [0.8, 1.2])}
        />
      </div>

      {/* VaR / CVaR */}
      <div className="text-xs font-medium text-gray-500 mb-1">VaR / CVaR (日次)</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
        <MetricBox
          label="VaR 95%"
          value={`${pct(metrics.var95)}%`}
          color="text-red-600"
          sub="20日に1日の最大損失"
        />
        <MetricBox
          label="VaR 99%"
          value={`${pct(metrics.var99)}%`}
          color="text-red-600"
          sub="100日に1日の最大損失"
        />
        <MetricBox
          label="CVaR 95%"
          value={`${pct(metrics.cvar95)}%`}
          color="text-red-600"
          sub="VaR超過時の平均損失"
        />
        <MetricBox
          label="CVaR 99%"
          value={`${pct(metrics.cvar99)}%`}
          color="text-red-600"
          sub="VaR超過時の平均損失"
        />
      </div>

      {/* Win/Loss */}
      <div className="text-xs font-medium text-gray-500 mb-1">勝敗統計</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-4">
        <MetricBox
          label="勝率"
          value={`${pct(metrics.winRate)}%`}
          color={metrics.winRate >= 0.5 ? "text-green-600" : "text-red-600"}
        />
        <MetricBox
          label="平均利益日"
          value={`+${pct(metrics.avgWin)}%`}
          color="text-green-600"
        />
        <MetricBox
          label="平均損失日"
          value={`${pct(metrics.avgLoss)}%`}
          color="text-red-600"
        />
        <MetricBox
          label="利益/損失比"
          value={metrics.avgLoss !== 0 ? fmt(Math.abs(metrics.avgWin / metrics.avgLoss)) : "-"}
          sub="ペイオフレシオ"
        />
      </div>

      {/* Rolling chart */}
      <div className="mb-2 text-xs text-gray-500 font-medium">
        <span className="text-blue-500">Sharpe比率</span> (左軸) /{" "}
        <span className="text-red-500">ボラティリティ年率%</span> (右軸) — 60日ローリング
      </div>
      <div ref={chartRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="リスク指標の読み方">
        <p>
          <span className="font-medium">シャープレシオ:</span>{" "}
          (リターン - 無リスク金利) / ボラティリティ。リスク1単位あたりのリターン。
          1以上で良好、2以上で優秀。負の値はリスクに見合わないリターン。
        </p>
        <p>
          <span className="font-medium">ソルティノレシオ:</span>{" "}
          シャープレシオの改良版。下落リスク（下方偏差）のみを考慮。
          上昇方向のボラティリティはリスクとみなさないため、より実態に即した評価。
        </p>
        <p>
          <span className="font-medium">VaR (Value at Risk):</span>{" "}
          指定した信頼水準での最大損失額。VaR 95%=-2%なら「20日に1日は2%以上下落する可能性がある」。
          ヒストリカルシミュレーション法で計算。
        </p>
        <p>
          <span className="font-medium">CVaR (Conditional VaR / Expected Shortfall):</span>{" "}
          VaRを超える損失が発生した場合の平均損失。VaRより保守的なリスク指標。
          テイルリスクの大きさを測定する。
        </p>
        <p>
          <span className="font-medium">プロフィットファクター:</span>{" "}
          総利益 / 総損失。1以上なら利益が損失を上回る。
          1.5以上が望ましいとされる。
        </p>
      </AnalysisGuide>
    </div>
  );
}

function MetricBox({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string;
  color?: string;
  sub?: string;
}) {
  return (
    <div className="p-2 bg-gray-50 rounded">
      <div className="text-gray-500">{label}</div>
      <div className={`font-mono font-medium ${color || ""}`}>{value}</div>
      {sub && <div className="text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}
