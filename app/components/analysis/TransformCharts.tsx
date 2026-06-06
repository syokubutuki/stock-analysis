"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  logReturns,
  rankTransform,
  volNormalizedReturns,
} from "../../lib/transforms";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

type TransformMode = "logReturn" | "rank" | "volNorm";

const MODE_LABELS: Record<TransformMode, string> = {
  logReturn: "対数リターン",
  rank: "順位変換",
  volNorm: "ボラ正規化",
};

export default function TransformCharts({ prices, seriesMode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [mode, setMode] = useState<TransformMode>("logReturn");

  const { values: closes, times } = extractSeries(prices, seriesMode);
  const needsTransform = seriesMode === "close" || seriesMode === "open";

  useEffect(() => {
    if (!containerRef.current || closes.length < 2) return;

    if (chartRef.current) chartRef.current.remove();

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 220,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    let data: number[] = [];
    let dataTimesArr: string[] = [];

    if (mode === "logReturn") {
      data = needsTransform ? logReturns(closes) : closes;
      dataTimesArr = needsTransform ? times.slice(1) : times;
    } else if (mode === "rank") {
      const lr = needsTransform ? logReturns(closes) : closes;
      data = rankTransform(lr);
      dataTimesArr = needsTransform ? times.slice(1) : times;
    } else {
      data = needsTransform ? volNormalizedReturns(closes, 20) : closes;
      dataTimesArr = needsTransform ? times.slice(1) : times;
    }

    if (mode === "logReturn" || mode === "volNorm") {
      const series = chart.addSeries(HistogramSeries, {
        title: MODE_LABELS[mode],
      });
      series.setData(
        data.map((v, i) => ({
          time: dataTimesArr[i] as Time,
          value: v,
          color: v >= 0 ? "rgba(38, 166, 154, 0.6)" : "rgba(239, 83, 80, 0.6)",
        }))
      );
    } else {
      const series = chart.addSeries(LineSeries, {
        color: "#6366f1",
        lineWidth: 1,
        title: MODE_LABELS[mode],
      });
      series.setData(
        data.map((v, i) => ({
          time: dataTimesArr[i] as Time,
          value: v,
        }))
      );
    }

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
  }, [prices, mode, seriesMode]);

  // 統計情報
  const lr = needsTransform ? logReturns(closes) : closes;
  const mean = lr.length > 0 ? lr.reduce((a, b) => a + b, 0) / lr.length : 0;
  const std = lr.length > 0
    ? Math.sqrt(lr.reduce((a, v) => a + (v - mean) ** 2, 0) / lr.length)
    : 0;
  const skew = lr.length > 0 && std > 0
    ? lr.reduce((a, v) => a + ((v - mean) / std) ** 3, 0) / lr.length
    : 0;
  const kurt = lr.length > 0 && std > 0
    ? lr.reduce((a, v) => a + ((v - mean) / std) ** 4, 0) / lr.length - 3
    : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">スケール・変換</h3>
        <div className="flex gap-1">
          {(Object.keys(MODE_LABELS) as TransformMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2 py-1 text-xs rounded font-medium transition-colors ${
                mode === m
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      <div ref={containerRef} className="w-full rounded border border-gray-100" />

      <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均リターン</div>
          <div className="font-mono font-medium">{(mean * 100).toFixed(4)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">標準偏差</div>
          <div className="font-mono font-medium">{(std * 100).toFixed(4)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">歪度</div>
          <div className={`font-mono font-medium ${Math.abs(skew) > 0.5 ? "text-orange-600" : ""}`}>
            {skew.toFixed(3)}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">尖度(超過)</div>
          <div className={`font-mono font-medium ${kurt > 1 ? "text-red-600" : ""}`}>
            {kurt.toFixed(3)}
          </div>
        </div>
      </div>

      <AnalysisGuide title="スケール変換分析の詳細理論">
        <p className="font-medium text-gray-700">1. スケール変換とは</p>
        <p>株価の生データを分析に適した形に変換する前処理です。変換方法によって異なる側面が可視化され、各変換の統計量を比較することで、データの構造的な特徴を把握できます。</p>
        <p className="mt-1">地図に例えると、対数リターンは「標高差の地図」、順位変換は「標高の順位地図」、ボラ正規化は「その地域の平均的な起伏で割った相対地図」です。同じ地形でも異なる地図を使うと異なる情報が得られます。</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"対数リターン: r_t = ln(P_t / P_{t-1})\n  性質: r_{t→t+n} = Σ r_i（加法的）\n\n順位変換: R_t = rank(r_t) / (N+1)\n  R_t ∈ (0, 1)、一様分布に従う\n\nボラティリティ正規化: z_t = r_t / σ_{t,20}\n  σ_{t,20} = std(r_{t-19}, ..., r_t)  (20日ローリング標準偏差)"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>r_t</strong>: 対数リターン。連続複利ベースの収益率</li>
          <li><strong>R_t</strong>: 順位変換値。外れ値の影響を完全に排除した相対位置</li>
          <li><strong>z_t</strong>: 正規化リターン。局所的なボラティリティで標準化したもの</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>対数リターン</strong>: {"ln(P_t/P_{t-1})"}で計算。算術リターン（ΔP/P）と異なり、加法的に積み上がる。金融工学の標準的な尺度</li>
          <li><strong>順位変換</strong>: データを順位に変換し0〜1に正規化。ノンパラメトリック分析の基盤。外れ値に完全にロバスト</li>
          <li><strong>ボラティリティ正規化</strong>: 局所的なボラティリティで割ることで、異なるボラティリティ環境下のリターンを同一尺度で比較可能にする</li>
          <li><strong>超過尖度</strong>: 尖度から3を引いた値。正規分布なら0。正ならファットテール（極端な値動きが多い）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>対数リターンの平均</strong>: 日次平均 × 252 ≈ 年率リターン。正なら期間中に上昇トレンド</li>
          <li><strong>標準偏差 × √252 {">"} 30%</strong>: 高ボラティリティ銘柄。リスク管理を厳格にすべき</li>
          <li><strong>歪度の絶対値 {">"} 0.5</strong>: 有意な非対称性。負ならダウンサイドリスクが大きい</li>
          <li><strong>超過尖度 {">"} 3</strong>: 強いファットテール。正規分布ベースのリスク計算は不適切</li>
          <li><strong>ボラ正規化で |z_t| {">"} 2</strong>: その時点でのボラ環境を考慮しても異常な動き（約5%の確率）</li>
          <li><strong>ボラ正規化で |z_t| {">"} 3</strong>: 極めて稀な動き（約0.3%の確率）。イベント駆動の可能性</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>異常検知</strong>: ボラ正規化リターンが±3を超えた日は、通常では説明できない動き。ニュースの確認や一時的なポジション調整を検討</li>
          <li><strong>リスク指標の補正</strong>: 超過尖度が大きい銘柄では、正規分布ベースのVaRにCornish-Fisher補正を適用して過小評価を防ぐ</li>
          <li><strong>相関分析の前処理</strong>: 順位変換を使えば、外れ値に頑健なSpearman相関やKendall相関の基盤が得られる</li>
          <li><strong>ボラ環境の比較</strong>: ボラ正規化により、異なる時期のリターンを公平に比較でき、銘柄間の比較にも使える</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>対数リターンと算術リターンの差</strong>: 大きな変動（±10%超）では両者の乖離が無視できない。レバレッジ計算では算術リターンが適切な場合がある</li>
          <li><strong>順位変換の情報損失</strong>: 値の大きさの情報が失われるため、「どれだけ大きく動いたか」は把握できない</li>
          <li><strong>ボラ正規化の遅延</strong>: 20日ローリング標準偏差は過去のボラティリティに基づくため、ボラティリティの急変時には正規化が不完全</li>
          <li><strong>定常性の前提</strong>: 各変換は暗黙的に定常性（統計的性質が時間で変わらない）を仮定するが、実際の株価は非定常であることが多い</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
