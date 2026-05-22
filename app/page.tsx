"use client";

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { useAnalysisData } from "./hooks/useAnalysisData";
import PeriodSelector from "./components/analysis/PeriodSelector";

const DiffSeriesChart = dynamic(
  () => import("./components/analysis/DiffSeriesChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={250} /> }
);
const VolumeAnalysis = dynamic(
  () => import("./components/analysis/VolumeAnalysis"),
  { ssr: false, loading: () => <ChartPlaceholder height={200} /> }
);
const TrendJudgment = dynamic(
  () => import("./components/analysis/TrendJudgment"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const TransformCharts = dynamic(
  () => import("./components/analysis/TransformCharts"),
  { ssr: false, loading: () => <ChartPlaceholder height={220} /> }
);
const PowerSpectrum = dynamic(
  () => import("./components/analysis/PowerSpectrum"),
  { ssr: false, loading: () => <ChartPlaceholder height={220} /> }
);
const WaveletChart = dynamic(
  () => import("./components/analysis/WaveletChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={250} /> }
);
const EMDChart = dynamic(
  () => import("./components/analysis/EMDChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const RecurrencePlot = dynamic(
  () => import("./components/analysis/RecurrencePlot"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const EntropyDisplay = dynamic(
  () => import("./components/analysis/EntropyDisplay"),
  { ssr: false, loading: () => <ChartPlaceholder height={250} /> }
);
const DFAChart = dynamic(
  () => import("./components/analysis/DFAChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const VisibilityGraphChart = dynamic(
  () => import("./components/analysis/VisibilityGraphChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const ReturnDistribution = dynamic(
  () => import("./components/analysis/ReturnDistribution"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const ACFChart = dynamic(
  () => import("./components/analysis/ACFChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const MultiscaleEntropyChart = dynamic(
  () => import("./components/analysis/MultiscaleEntropyChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={250} /> }
);
const OrdinalNetwork = dynamic(
  () => import("./components/analysis/OrdinalNetwork"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const SpiralHeatmap = dynamic(
  () => import("./components/analysis/SpiralHeatmap"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const VolatilityChart = dynamic(
  () => import("./components/analysis/VolatilityChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);

function ChartPlaceholder({ height }: { height: number }) {
  return (
    <div
      className="w-full bg-gray-50 rounded-lg border border-gray-200 flex items-center justify-center text-gray-400"
      style={{ height }}
    >
      読み込み中...
    </div>
  );
}

type SectionKey =
  | "basic"
  | "transform"
  | "distribution"
  | "volatility"
  | "frequency"
  | "nonlinear"
  | "entropy"
  | "fractal"
  | "network"
  | "calendar";

const SECTIONS: { key: SectionKey; label: string; description: string }[] = [
  { key: "basic", label: "基本分析", description: "差分系列・出来高・トレンド" },
  { key: "transform", label: "スケール変換", description: "対数リターン・順位変換・ボラ正規化" },
  { key: "distribution", label: "分布・相関", description: "リターン分布・QQプロット・ACF/PACF" },
  { key: "volatility", label: "ボラティリティ", description: "EWMA・レジーム検出・クラスタリング" },
  { key: "frequency", label: "周波数領域", description: "FFT・ウェーブレット・EMD" },
  { key: "nonlinear", label: "非線形動力学", description: "位相空間・Recurrence Plot・RQA・Lyapunov" },
  { key: "entropy", label: "情報理論", description: "エントロピー・マルチスケール・Fisher情報量" },
  { key: "fractal", label: "フラクタル", description: "DFA・Hurst指数・MF-DFA" },
  { key: "network", label: "ネットワーク", description: "Visibility Graph・Ordinal Pattern遷移" },
  { key: "calendar", label: "カレンダー", description: "曜日/月別アノマリー・ヒートマップ" },
];

export default function AnalysisPage() {
  const { data, filteredPrices, loading, error, fetchStock, period, setPeriod } =
    useAnalysisData();
  const [activeSection, setActiveSection] = useState<SectionKey>("basic");

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = e.currentTarget;
      const input = form.elements.namedItem("ticker") as HTMLInputElement;
      if (input.value.trim()) {
        fetchStock(input.value.trim());
      }
    },
    [fetchStock]
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-4">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-xl font-bold text-gray-900">株価構造分析</h1>
          <p className="text-sm text-gray-500 mt-1">
            市場の隠れた構造をデータから抽出する
          </p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        {/* 入力エリア */}
        <div className="flex items-center gap-3 flex-wrap">
          <form onSubmit={handleSubmit} className="flex items-center gap-3">
            <input
              name="ticker"
              type="text"
              placeholder="銘柄コード (例: 9984, 8306)"
              className="px-4 py-2 border border-gray-300 rounded-lg text-base w-56 focus:outline-none focus:ring-2 focus:ring-blue-500 uppercase"
            />
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "取得中..." : "分析開始"}
            </button>
          </form>
          {data && (
            <>
              <span className="text-gray-600 text-sm font-medium">
                {data.name}
              </span>
              <PeriodSelector current={period} onChange={setPeriod} />
            </>
          )}
        </div>

        {error && (
          <div className="bg-red-50 text-red-700 rounded-lg p-3 text-sm">
            {error}
          </div>
        )}

        {data && filteredPrices.length > 0 && (
          <>
            {/* サマリー */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <SummaryCard
                label="現在値"
                value={filteredPrices[filteredPrices.length - 1].close.toLocaleString()}
              />
              <SummaryCard
                label="期間始値"
                value={filteredPrices[0].close.toLocaleString()}
              />
              <SummaryCard
                label="期間変動"
                value={`${(
                  ((filteredPrices[filteredPrices.length - 1].close -
                    filteredPrices[0].close) /
                    filteredPrices[0].close) *
                  100
                ).toFixed(2)}%`}
                color={
                  filteredPrices[filteredPrices.length - 1].close >=
                  filteredPrices[0].close
                    ? "text-green-600"
                    : "text-red-600"
                }
              />
              <SummaryCard
                label="データ数"
                value={`${filteredPrices.length}日`}
              />
            </div>

            {/* セクションタブ */}
            <div className="flex gap-1 flex-wrap border-b border-gray-200 pb-2">
              {SECTIONS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setActiveSection(key)}
                  className={`px-3 py-1.5 text-sm rounded-t font-medium transition-colors ${
                    activeSection === key
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* セクション内容 */}
            <div className="space-y-6">
              {activeSection === "basic" && (
                <>
                  <TrendJudgment prices={filteredPrices} />
                  <DiffSeriesChart prices={filteredPrices} />
                  <VolumeAnalysis prices={filteredPrices} />
                </>
              )}

              {activeSection === "transform" && (
                <TransformCharts prices={filteredPrices} />
              )}

              {activeSection === "distribution" && (
                <>
                  <ReturnDistribution prices={filteredPrices} />
                  <ACFChart prices={filteredPrices} />
                </>
              )}

              {activeSection === "volatility" && (
                <VolatilityChart prices={filteredPrices} />
              )}

              {activeSection === "frequency" && (
                <>
                  <PowerSpectrum prices={filteredPrices} />
                  <WaveletChart prices={filteredPrices} />
                  <EMDChart prices={filteredPrices} />
                </>
              )}

              {activeSection === "nonlinear" && (
                <RecurrencePlot prices={filteredPrices} />
              )}

              {activeSection === "entropy" && (
                <>
                  <EntropyDisplay prices={filteredPrices} />
                  <MultiscaleEntropyChart prices={filteredPrices} />
                </>
              )}

              {activeSection === "fractal" && (
                <DFAChart prices={filteredPrices} />
              )}

              {activeSection === "network" && (
                <>
                  <VisibilityGraphChart prices={filteredPrices} />
                  <OrdinalNetwork prices={filteredPrices} />
                </>
              )}

              {activeSection === "calendar" && (
                <SpiralHeatmap prices={filteredPrices} />
              )}
            </div>
          </>
        )}

        {!data && !loading && !error && (
          <div className="text-center py-16 text-gray-400">
            <p className="text-lg mb-4">銘柄コードを入力して分析開始</p>
            <p className="text-sm mb-8">
              日本株4桁コード (例: 9984 ソフトバンクG, 8306 三菱UFJ, 7203 トヨタ)
            </p>
            <div className="max-w-2xl mx-auto grid grid-cols-1 sm:grid-cols-2 gap-3 text-left text-sm text-gray-500">
              {SECTIONS.map(({ label, description }) => (
                <div key={label} className="p-3 bg-white rounded-lg border border-gray-100">
                  <div className="font-medium text-gray-700">{label}</div>
                  <div>{description}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      <footer className="text-center text-xs text-gray-400 py-8">
        株価データはYahoo Financeより取得。投資判断の参考としてご利用ください。
      </footer>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-bold ${color || "text-gray-800"}`}>
        {value}
      </div>
    </div>
  );
}
