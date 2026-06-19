"use client";

import { useCallback, useState, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useAnalysisData, PeriodKey } from "./hooks/useAnalysisData";
import PeriodSelector from "./components/analysis/PeriodSelector";
import SeriesModeSelector from "./components/analysis/SeriesModeSelector";
import WatchlistPanel from "./components/WatchlistPanel";
import TickerSearchInput from "./components/TickerSearchInput";
import { SeriesMode } from "./lib/series-mode";

const DiffSeriesChart = dynamic(
  () => import("./components/analysis/DiffSeriesChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={250} /> }
);
const VolumeAnalysis = dynamic(
  () => import("./components/analysis/VolumeAnalysis"),
  { ssr: false, loading: () => <ChartPlaceholder height={200} /> }
);
const UnifiedChart = dynamic(
  () => import("./components/analysis/UnifiedChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const GapAnalysisChart = dynamic(
  () => import("./components/analysis/GapAnalysisChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const CustomReturnChart = dynamic(
  () => import("./components/analysis/CustomReturnChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const DistributionShapeChart = dynamic(
  () => import("./components/analysis/DistributionShapeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const ACFExtendedChart = dynamic(
  () => import("./components/analysis/ACFExtendedChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const RollingMomentsChart = dynamic(
  () => import("./components/analysis/RollingMomentsChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const LagDependenceChart = dynamic(
  () => import("./components/analysis/LagDependenceChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const ConditionalViolinChart = dynamic(
  () => import("./components/analysis/ConditionalViolinChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const CrossCorrelogramChart = dynamic(
  () => import("./components/analysis/CrossCorrelogramChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const IndependenceTestsChart = dynamic(
  () => import("./components/analysis/IndependenceTestsChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={200} /> }
);
const DistributionSurfaceChart = dynamic(
  () => import("./components/analysis/DistributionSurfaceChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
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
const WaveletCoherenceChart = dynamic(
  () => import("./components/analysis/WaveletCoherenceChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={280} /> }
);
const EMDChart = dynamic(
  () => import("./components/analysis/EMDChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const AnalyticSignalChart = dynamic(
  () => import("./components/analysis/AnalyticSignalChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RecurrencePlot = dynamic(
  () => import("./components/analysis/RecurrencePlot"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const AttractorExplorer = dynamic(
  () => import("./components/analysis/AttractorExplorer"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const WeeklyPhaseAttractorChart = dynamic(
  () => import("./components/analysis/WeeklyPhaseAttractorChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const PeriodicPhaseAttractorChart = dynamic(
  () => import("./components/analysis/PeriodicPhaseAttractorChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const WeeklyPhaseSyncChart = dynamic(
  () => import("./components/analysis/WeeklyPhaseSyncChart"),
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
const EntropyExtendedChart = dynamic(
  () => import("./components/analysis/EntropyExtendedChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const ConditionalEntropyChart = dynamic(
  () => import("./components/analysis/ConditionalEntropyChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const RollingTransferEntropyChart = dynamic(
  () => import("./components/analysis/RollingTransferEntropyChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const InformationStorageChart = dynamic(
  () => import("./components/analysis/InformationStorageChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const ComplexityEntropyChart = dynamic(
  () => import("./components/analysis/ComplexityEntropyChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const SymbolicInfoFlowChart = dynamic(
  () => import("./components/analysis/SymbolicInfoFlowChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const EntropyHeatmapChart = dynamic(
  () => import("./components/analysis/EntropyHeatmapChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const EntropyRegimeChart = dynamic(
  () => import("./components/analysis/EntropyRegimeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const OrdinalNetwork = dynamic(
  () => import("./components/analysis/OrdinalNetwork"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const SpiralHeatmap = dynamic(
  () => import("./components/analysis/SpiralHeatmap"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const WeekdayEdgeScanChart = dynamic(
  () => import("./components/analysis/WeekdayEdgeScanChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const VolatilityChart = dynamic(
  () => import("./components/analysis/VolatilityChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const HilbertHuangChart = dynamic(
  () => import("./components/analysis/HilbertHuangChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const GarchChart = dynamic(
  () => import("./components/analysis/GarchChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RegimeChart = dynamic(
  () => import("./components/analysis/RegimeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const CausalChart = dynamic(
  () => import("./components/analysis/CausalChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const FractalExtChart = dynamic(
  () => import("./components/analysis/FractalExtChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const RollingHurstChart = dynamic(
  () => import("./components/analysis/RollingHurstChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={240} /> }
);
const HVGChart = dynamic(
  () => import("./components/analysis/HVGChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={250} /> }
);
const RecurrenceNetworkChart = dynamic(
  () => import("./components/analysis/RecurrenceNetworkChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const TailRiskChart = dynamic(
  () => import("./components/analysis/TailRiskChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const TDAChart = dynamic(
  () => import("./components/analysis/TDAChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const KramersMoyalChart = dynamic(
  () => import("./components/analysis/KramersMoyalChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RangeVolatilityChart = dynamic(
  () => import("./components/analysis/RangeVolatilityChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const CandleStructureChart = dynamic(
  () => import("./components/analysis/CandleStructureChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const MFEMAEChart = dynamic(
  () => import("./components/analysis/MFEMAEChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const GapScatterChart = dynamic(
  () => import("./components/analysis/GapScatterChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const IntradayRangeChart = dynamic(
  () => import("./components/analysis/IntradayRangeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const TechnicalIndicators = dynamic(
  () => import("./components/analysis/TechnicalIndicators"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const DrawdownChart = dynamic(
  () => import("./components/analysis/DrawdownChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RiskMetricsPanel = dynamic(
  () => import("./components/analysis/RiskMetricsPanel"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const BenchmarkChart = dynamic(
  () => import("./components/analysis/BenchmarkChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const EventStudyChart = dynamic(
  () => import("./components/analysis/EventStudyChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const ADXChart = dynamic(
  () => import("./components/analysis/ADXChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const StochasticsChart = dynamic(
  () => import("./components/analysis/StochasticsChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const OBVVWAPChart = dynamic(
  () => import("./components/analysis/OBVVWAPChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={430} /> }
);
const ATRChart = dynamic(
  () => import("./components/analysis/ATRChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={430} /> }
);
const CopulaChart = dynamic(
  () => import("./components/analysis/CopulaChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const EmbeddingOptimizer = dynamic(
  () => import("./components/analysis/EmbeddingOptimizer"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RollingRQAChart = dynamic(
  () => import("./components/analysis/RollingRQAChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const LocalLyapunovChart = dynamic(
  () => import("./components/analysis/LocalLyapunovChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const SimplexPredictionChart = dynamic(
  () => import("./components/analysis/SimplexPredictionChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const RollingTDAChart = dynamic(
  () => import("./components/analysis/RollingTDAChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const AttractorSignalDashboard = dynamic(
  () => import("./components/analysis/AttractorSignalDashboard"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const LyapunovSpectrumChart = dynamic(
  () => import("./components/analysis/LyapunovSpectrumChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={600} /> }
);
const StructureScorecardChart = dynamic(
  () => import("./components/analysis/StructureScorecardChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={200} /> }
);
const VolumeProfileChart = dynamic(
  () => import("./components/analysis/VolumeProfileChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const HoldingPeriodChart = dynamic(
  () => import("./components/analysis/HoldingPeriodChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const VolTermStructureChart = dynamic(
  () => import("./components/analysis/VolTermStructureChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={520} /> }
);
const RegimeTechnicalChart = dynamic(
  () => import("./components/analysis/RegimeTechnicalChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const VolumeReturnChart = dynamic(
  () => import("./components/analysis/VolumeReturnChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={320} /> }
);
const VolumeLeadChart = dynamic(
  () => import("./components/analysis/VolumeLeadChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={280} /> }
);
const VolumeWeightedTechChart = dynamic(
  () => import("./components/analysis/VolumeWeightedTechChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const IntradayPathChart = dynamic(
  () => import("./components/analysis/IntradayPathChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const ClosePositionChart = dynamic(
  () => import("./components/analysis/ClosePositionChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={280} /> }
);
const TrueRangeDecompChart = dynamic(
  () => import("./components/analysis/TrueRangeDecompChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const CandlestickPatternChart = dynamic(
  () => import("./components/analysis/CandlestickPatternChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const MarketStateDashboard = dynamic(
  () => import("./components/analysis/MarketStateDashboard"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const RegimeDistributionChart = dynamic(
  () => import("./components/analysis/RegimeDistributionChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={320} /> }
);
const RegimeTransitionChart = dynamic(
  () => import("./components/analysis/RegimeTransitionChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={440} /> }
);
const PredictionAccuracyChart = dynamic(
  () => import("./components/analysis/PredictionAccuracyChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const InfoRatioDashboard = dynamic(
  () => import("./components/analysis/InfoRatioDashboard"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const SimpleBacktestChart = dynamic(
  () => import("./components/analysis/SimpleBacktestChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const MultiTimeframeChart = dynamic(
  () => import("./components/analysis/MultiTimeframeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={200} /> }
);
const PriceForecastChart = dynamic(
  () => import("./components/analysis/PriceForecastChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={450} /> }
);
const GarchVarChart = dynamic(
  () => import("./components/analysis/GarchVarChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const PropagatorChart = dynamic(
  () => import("./components/analysis/PropagatorChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const PathIntegralChart = dynamic(
  () => import("./components/analysis/PathIntegralChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={420} /> }
);
const DMDChart = dynamic(
  () => import("./components/analysis/DMDChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const DecoherenceChart = dynamic(
  () => import("./components/analysis/DecoherenceChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const MarketTimeChart = dynamic(
  () => import("./components/analysis/MarketTimeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const DensityMatrixChart = dynamic(
  () => import("./components/analysis/DensityMatrixChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const UnitRootChart = dynamic(
  () => import("./components/analysis/UnitRootChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const StylizedFactsChart = dynamic(
  () => import("./components/analysis/StylizedFactsChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const MeanReversionChart = dynamic(
  () => import("./components/analysis/MeanReversionChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const ArimaChart = dynamic(
  () => import("./components/analysis/ArimaChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const AsymmetricGarchChart = dynamic(
  () => import("./components/analysis/AsymmetricGarchChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const CornishFisherChart = dynamic(
  () => import("./components/analysis/CornishFisherChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const ForecastRangeChart = dynamic(
  () => import("./components/analysis/ForecastRangeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const VolConeChart = dynamic(
  () => import("./components/analysis/VolConeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const JumpDiffusionChart = dynamic(
  () => import("./components/analysis/JumpDiffusionChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const HestonChart = dynamic(
  () => import("./components/analysis/HestonChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={450} /> }
);
const MicrostructureChart = dynamic(
  () => import("./components/analysis/MicrostructureChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const CrashSurgeStreakChart = dynamic(
  () => import("./components/analysis/CrashSurgeStreakChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const BehavioralChart = dynamic(
  () => import("./components/analysis/BehavioralChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const FinanceTheoryChart = dynamic(
  () => import("./components/analysis/FinanceTheoryChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={450} /> }
);
const HillEstimatorChart = dynamic(
  () => import("./components/analysis/HillEstimatorChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const StructuralBreakChart = dynamic(
  () => import("./components/analysis/StructuralBreakChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const ExtraTechnicalChart = dynamic(
  () => import("./components/analysis/ExtraTechnicalChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const VarianceRatioChart = dynamic(
  () => import("./components/analysis/VarianceRatioChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const LombScargleChart = dynamic(
  () => import("./components/analysis/LombScargleChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const VolSmileChart = dynamic(
  () => import("./components/analysis/VolSmileChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const OptimalStoppingChart = dynamic(
  () => import("./components/analysis/OptimalStoppingChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const VarianceGammaChart = dynamic(
  () => import("./components/analysis/VarianceGammaChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const FBMChart = dynamic(
  () => import("./components/analysis/FBMChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const SSAChart = dynamic(
  () => import("./components/analysis/SSAChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const BOCPDChart = dynamic(
  () => import("./components/analysis/BOCPDChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const CCMChart = dynamic(
  () => import("./components/analysis/CCMChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const HighLowTimingChart = dynamic(
  () => import("./components/analysis/HighLowTimingChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
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
  | "technical"
  | "ohlc"
  | "risk"
  | "transform"
  | "distribution"
  | "volatility"
  | "frequency"
  | "nonlinear"
  | "entropy"
  | "fractal"
  | "network"
  | "calendar"
  | "regime"
  | "causal"
  | "tailrisk"
  | "simulation"
  | "quantum";

const SECTIONS: { key: SectionKey; label: string; description: string }[] = [
  { key: "basic", label: "基本分析", description: "ローソク足・一目均衡表・支持/抵抗線・フィボナッチ・ベンチマーク比較" },
  { key: "technical", label: "テクニカル", description: "RSI・MACD・BB・ADX・ストキャスティクス・OBV/VWAP" },
  { key: "ohlc", label: "OHLC分析", description: "ローソク足構造・MFE/MAE・レンジ・ギャップ散布図・レンジベースVol" },
  { key: "risk", label: "リスク指標", description: "ドローダウン・VaR/CVaR・シャープ/ソルティノ比率・ボラティリティスマイル" },
  { key: "transform", label: "スケール変換", description: "対数リターン・順位変換・ボラ正規化・累積リターン・差分・Box-Cox・ドローダウン・Zスコア" },
  { key: "distribution", label: "分布・相関", description: "リターン分布・QQプロット・ACF/PACF・分散比検定" },
  { key: "volatility", label: "ボラティリティ", description: "EWMA・GARCH・ATR・ケルトナーチャネル" },
  { key: "frequency", label: "周波数領域", description: "FFT・ウェーブレット・コヒーレンス・EMD・解析信号・HHS・STFT・SSA・Lomb-Scargle" },
  { key: "nonlinear", label: "非線形動力学", description: "アトラクタ・RQA・Lyapunov・位相空間予測・KM係数・TDA・投資シグナル" },
  { key: "entropy", label: "情報理論", description: "エントロピー拡張・複雑度・情報フロー・レジーム検出・予測可能性" },
  { key: "fractal", label: "フラクタル", description: "DFA・Hurst指数・ローリングHurst+サロゲート帯・MF-DFA・R/S・DCCA・相関次元" },
  { key: "network", label: "ネットワーク", description: "NVG・HVG・Ordinal・Recurrence Network" },
  { key: "regime", label: "レジーム分析", description: "市場状態ダッシュボード・3状態カルマン・スムーザー・HMM・変化点検出・ベイズ変化点検出" },
  { key: "causal", label: "因果・情報", description: "イベントスタディ・Transfer Entropy・Granger因果・相互情報量・CCM非線形因果" },
  { key: "tailrisk", label: "テイルリスク", description: "極値統計・高次キュムラント・テイル依存性・Copula分析" },
  { key: "calendar", label: "カレンダー", description: "曜日/月別アノマリー・ヒートマップ・高値/安値の時間帯分布(日中足)" },
  { key: "simulation", label: "シミュレーション", description: "カスタム売買・GBDT予測・株価予測(モンテカルロ)・バックテスト・分数BM・VG過程・最適停止" },
  { key: "quantum", label: "量子力学的", description: "プロパゲータ・経路積分・DMD・デコヒーレンス・市場時間・密度行列" },
];

// 入力系列(seriesMode)を実際に消費するセクション。これ以外のセクション
// (基礎・テクニカル・OHLC・リスク・カレンダー)はチャートが OHLC ベースで
// 系列変換が効かないため、SeriesModeSelector をグレーアウト表示にする。
// 将来コンポーネントを seriesMode 対応化した際は、ここにキーを追加すること。
const SERIES_AWARE_SECTIONS = new Set<SectionKey>([
  "transform", "distribution", "volatility", "frequency", "nonlinear",
  "entropy", "fractal", "network", "regime", "causal", "tailrisk",
  "simulation", "quantum",
]);

export default function AnalysisPage() {
  const { data, allPrices, filteredPrices, loading, error, fetchStock, period, setPeriod } =
    useAnalysisData();
  const [activeSection, setActiveSection] = useState<SectionKey>("basic");
  const [seriesMode, setSeriesMode] = useState<SeriesMode>("close");
  const [tickerInput, setTickerInput] = useState("");

  // 初回マウント時に前回の状態（銘柄・セクション・系列モード・期間）を復元する
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const savedSection = localStorage.getItem("sa:section") as SectionKey | null;
      const savedMode = localStorage.getItem("sa:seriesMode") as SeriesMode | null;
      const savedPeriod = localStorage.getItem("sa:period") as PeriodKey | null;
      const savedTicker = localStorage.getItem("sa:lastTicker");
      if (savedSection) setActiveSection(savedSection);
      if (savedMode) setSeriesMode(savedMode);
      if (savedPeriod) setPeriod(savedPeriod);
      if (savedTicker) {
        setTickerInput(savedTicker);
        fetchStock(savedTicker);
      }
    } catch {
      // localStorage 利用不可（プライベートモード等）の場合は無視
    }
  }, [fetchStock, setPeriod]);

  // 取得成功した銘柄・現在の表示状態を保存する
  useEffect(() => {
    if (data?.ticker) {
      try {
        localStorage.setItem("sa:lastTicker", data.ticker);
      } catch {}
    }
  }, [data?.ticker]);
  useEffect(() => {
    try {
      localStorage.setItem("sa:section", activeSection);
    } catch {}
  }, [activeSection]);
  useEffect(() => {
    try {
      localStorage.setItem("sa:seriesMode", seriesMode);
    } catch {}
  }, [seriesMode]);
  useEffect(() => {
    try {
      localStorage.setItem("sa:period", period);
    } catch {}
  }, [period]);

  // Series Explorer の系列グループから対応する詳細分析セクションへジャンプする。
  // タブを切り替えた後、保留中のアンカー DOM を探してスクロール＆ハイライトする。
  const pendingScrollRef = useRef<string | null>(null);
  const navigateToSection = useCallback((section: string, anchor?: string) => {
    pendingScrollRef.current = anchor ?? null;
    setActiveSection(section as SectionKey);
  }, []);
  useEffect(() => {
    const id = pendingScrollRef.current;
    if (!id) return;
    pendingScrollRef.current = null;
    // セクション切替→再レンダリング→要素出現のタイミング差を rAF リトライで吸収する
    let tries = 0;
    const tick = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.classList.add("sa-flash");
        setTimeout(() => el.classList.remove("sa-flash"), 1200);
        return;
      }
      if (tries++ < 10) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [activeSection]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-4">
        <div className="max-w-7xl mx-auto flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">株価構造分析</h1>
            <p className="text-sm text-gray-500 mt-1">
              市場の隠れた構造をデータから抽出する
            </p>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <Link
              href="/portfolio"
              className="text-sm text-blue-600 hover:text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50"
            >
              ポートフォリオ
            </Link>
            <Link
              href="/feedback"
              className="text-sm text-blue-600 hover:text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50"
            >
              ご意見・ご要望
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        {/* 入力エリア */}
        <div className="flex items-center gap-3 flex-wrap">
          <TickerSearchInput
            value={tickerInput}
            onChange={setTickerInput}
            onSubmit={fetchStock}
            loading={loading}
          />
          <WatchlistPanel
            currentTicker={data?.ticker ?? null}
            currentName={data?.name ?? null}
            onSelect={(ticker) => {
              setTickerInput(ticker);
              fetchStock(ticker);
            }}
          />
          {data && (
            <>
              <span className="text-gray-600 text-sm font-medium">
                {data.name}
              </span>
              <PeriodSelector current={period} onChange={setPeriod} />
              <SeriesModeSelector
                current={seriesMode}
                onChange={setSeriesMode}
                disabled={!SERIES_AWARE_SECTIONS.has(activeSection)}
              />
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
              {SECTIONS.map(({ key, label, description }) => (
                <button
                  key={key}
                  onClick={() => setActiveSection(key)}
                  title={description}
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
            <div className="text-xs text-gray-400 mt-1">
              {SECTIONS.find(s => s.key === activeSection)?.description}
            </div>

            {/* セクション内容 */}
            <div className="space-y-6">
              {activeSection === "basic" && (
                <>
                  <UnifiedChart prices={allPrices} period={period} onNavigate={navigateToSection} />
                  <StructureScorecardChart prices={filteredPrices} />
                  <BenchmarkChart prices={allPrices} period={period} />
                  <DiffSeriesChart prices={allPrices} period={period} />
                  <VolumeAnalysis prices={allPrices} period={period} />
                  <VolumeProfileChart prices={filteredPrices} />
                  <VolumeReturnChart prices={filteredPrices} />
                  <VolumeLeadChart prices={filteredPrices} />
                  <GapAnalysisChart prices={allPrices} period={period} />
                  <HoldingPeriodChart prices={filteredPrices} />
                  <MultiTimeframeChart prices={filteredPrices} />
                  <BehavioralChart prices={filteredPrices} />
                </>
              )}

              {activeSection === "technical" && (
                <>
                  <div id="sa-technical" className="scroll-mt-20">
                    <TechnicalIndicators prices={allPrices} period={period} />
                  </div>
                  <ADXChart prices={allPrices} period={period} />
                  <StochasticsChart prices={allPrices} period={period} />
                  <OBVVWAPChart prices={allPrices} period={period} />
                  <VolumeWeightedTechChart prices={filteredPrices} />
                  <ExtraTechnicalChart prices={filteredPrices} />
                </>
              )}

              {activeSection === "ohlc" && (
                <>
                  <div id="sa-ohlc" className="scroll-mt-20">
                    <CandleStructureChart prices={allPrices} period={period} />
                  </div>
                  <CrashSurgeStreakChart prices={filteredPrices} />
                  <CandlestickPatternChart prices={filteredPrices} />
                  <IntradayPathChart prices={filteredPrices} />
                  <ClosePositionChart prices={filteredPrices} />
                  <TrueRangeDecompChart prices={filteredPrices} />
                  <MFEMAEChart prices={allPrices} period={period} />
                  <div id="sa-ohlc-gap" className="scroll-mt-20">
                    <GapScatterChart prices={allPrices} period={period} />
                  </div>
                  <div id="sa-ohlc-range" className="scroll-mt-20">
                    <IntradayRangeChart prices={allPrices} period={period} />
                  </div>
                  <RangeVolatilityChart prices={allPrices} period={period} />
                  <div id="sa-ohlc-micro" className="scroll-mt-20">
                    <MicrostructureChart prices={filteredPrices} />
                  </div>
                </>
              )}

              {activeSection === "risk" && (
                <>
                  <div id="sa-risk" className="scroll-mt-20">
                    <RiskMetricsPanel prices={allPrices} period={period} />
                  </div>
                  <ForecastRangeChart prices={filteredPrices} />
                  <DrawdownChart prices={allPrices} period={period} />
                  <GarchVarChart prices={filteredPrices} />
                  <CornishFisherChart prices={filteredPrices} />
                  <FinanceTheoryChart prices={filteredPrices} />
                  <VolSmileChart prices={filteredPrices} />
                </>
              )}

              {activeSection === "transform" && (
                <div id="sa-transform" className="scroll-mt-20">
                  <TransformCharts prices={filteredPrices} seriesMode={seriesMode} />
                </div>
              )}

              {activeSection === "distribution" && (
                <>
                  <div id="sa-distribution" className="scroll-mt-20">
                    <ReturnDistribution prices={filteredPrices} seriesMode={seriesMode} />
                  </div>
                  <DistributionShapeChart prices={filteredPrices} seriesMode={seriesMode} />
                  <ACFChart prices={filteredPrices} seriesMode={seriesMode} />
                  <ACFExtendedChart prices={filteredPrices} seriesMode={seriesMode} />
                  <RollingMomentsChart prices={filteredPrices} seriesMode={seriesMode} />
                  <LagDependenceChart prices={filteredPrices} seriesMode={seriesMode} />
                  <ConditionalViolinChart prices={filteredPrices} seriesMode={seriesMode} />
                  <CrossCorrelogramChart prices={filteredPrices} />
                  <IndependenceTestsChart prices={filteredPrices} seriesMode={seriesMode} />
                  <DistributionSurfaceChart prices={filteredPrices} seriesMode={seriesMode} />
                  <PredictionAccuracyChart prices={filteredPrices} />
                  <InfoRatioDashboard prices={filteredPrices} />
                  <UnitRootChart prices={filteredPrices} seriesMode={seriesMode} />
                  <StylizedFactsChart prices={filteredPrices} seriesMode={seriesMode} />
                  <VarianceRatioChart prices={filteredPrices} seriesMode={seriesMode} />
                </>
              )}

              {activeSection === "volatility" && (
                <>
                  <div id="sa-volatility" className="scroll-mt-20">
                    <VolatilityChart prices={filteredPrices} seriesMode={seriesMode} />
                  </div>
                  <GarchChart prices={filteredPrices} seriesMode={seriesMode} />
                  <ATRChart prices={filteredPrices} />
                  <VolTermStructureChart prices={filteredPrices} />
                  <AsymmetricGarchChart prices={filteredPrices} seriesMode={seriesMode} />
                  <VolConeChart prices={filteredPrices} />
                  <HestonChart prices={filteredPrices} />
                </>
              )}

              {activeSection === "frequency" && (
                <>
                  <PowerSpectrum prices={filteredPrices} seriesMode={seriesMode} />
                  <WaveletChart prices={filteredPrices} seriesMode={seriesMode} />
                  <div id="sa-frequency-coherence" className="scroll-mt-20">
                    <WaveletCoherenceChart prices={filteredPrices} seriesMode={seriesMode} />
                  </div>
                  <EMDChart prices={filteredPrices} seriesMode={seriesMode} />
                  <AnalyticSignalChart prices={filteredPrices} seriesMode={seriesMode} />
                  <HilbertHuangChart prices={filteredPrices} seriesMode={seriesMode} />
                  <LombScargleChart prices={filteredPrices} seriesMode={seriesMode} />
                  <div id="sa-frequency-ssa" className="scroll-mt-20">
                    <SSAChart prices={filteredPrices} seriesMode={seriesMode} />
                  </div>
                </>
              )}

              {activeSection === "nonlinear" && (
                <>
                  <div id="sa-nonlinear" className="scroll-mt-20">
                    <AttractorSignalDashboard prices={filteredPrices} seriesMode={seriesMode} />
                  </div>
                  <EmbeddingOptimizer prices={filteredPrices} seriesMode={seriesMode} />
                  <AttractorExplorer prices={filteredPrices} seriesMode={seriesMode} />
                  <WeeklyPhaseAttractorChart prices={filteredPrices} seriesMode={seriesMode} />
                  <PeriodicPhaseAttractorChart prices={filteredPrices} seriesMode={seriesMode} />
                  <WeeklyPhaseSyncChart />
                  <RollingRQAChart prices={filteredPrices} seriesMode={seriesMode} />
                  <LocalLyapunovChart prices={filteredPrices} seriesMode={seriesMode} />
                  <LyapunovSpectrumChart prices={filteredPrices} seriesMode={seriesMode} />
                  <SimplexPredictionChart prices={filteredPrices} seriesMode={seriesMode} />
                  <RecurrencePlot prices={filteredPrices} seriesMode={seriesMode} />
                  <KramersMoyalChart prices={filteredPrices} seriesMode={seriesMode} />
                  <div id="sa-nonlinear-tda" className="scroll-mt-20">
                    <TDAChart prices={filteredPrices} seriesMode={seriesMode} />
                  </div>
                  <RollingTDAChart prices={filteredPrices} seriesMode={seriesMode} />
                </>
              )}

              {activeSection === "entropy" && (
                <>
                  <div id="sa-entropy" className="scroll-mt-20">
                    <EntropyDisplay prices={filteredPrices} seriesMode={seriesMode} />
                  </div>
                  <EntropyExtendedChart prices={filteredPrices} seriesMode={seriesMode} />
                  <ConditionalEntropyChart prices={filteredPrices} seriesMode={seriesMode} />
                  <MultiscaleEntropyChart prices={filteredPrices} seriesMode={seriesMode} />
                  <EntropyHeatmapChart prices={filteredPrices} seriesMode={seriesMode} />
                  <ComplexityEntropyChart prices={filteredPrices} seriesMode={seriesMode} />
                  <InformationStorageChart prices={filteredPrices} seriesMode={seriesMode} />
                  <RollingTransferEntropyChart prices={filteredPrices} seriesMode={seriesMode} />
                  <SymbolicInfoFlowChart prices={filteredPrices} seriesMode={seriesMode} />
                  <EntropyRegimeChart prices={filteredPrices} seriesMode={seriesMode} />
                </>
              )}

              {activeSection === "fractal" && (
                <>
                  <div id="sa-fractal" className="scroll-mt-20">
                    <DFAChart prices={filteredPrices} seriesMode={seriesMode} />
                  </div>
                  <RollingHurstChart prices={filteredPrices} seriesMode={seriesMode} />
                  <FractalExtChart prices={filteredPrices} seriesMode={seriesMode} />
                </>
              )}

              {activeSection === "network" && (
                <>
                  <div id="sa-network" className="scroll-mt-20">
                    <VisibilityGraphChart prices={filteredPrices} seriesMode={seriesMode} />
                  </div>
                  <HVGChart prices={filteredPrices} seriesMode={seriesMode} />
                  <OrdinalNetwork prices={filteredPrices} seriesMode={seriesMode} />
                  <RecurrenceNetworkChart prices={filteredPrices} seriesMode={seriesMode} />
                </>
              )}

              {activeSection === "regime" && (
                <>
                  <div id="sa-regime" className="scroll-mt-20">
                    <MarketStateDashboard prices={filteredPrices} seriesMode={seriesMode} />
                  </div>
                  <RegimeChart prices={filteredPrices} seriesMode={seriesMode} />
                  <RegimeTechnicalChart prices={filteredPrices} />
                  <RegimeDistributionChart prices={filteredPrices} />
                  <RegimeTransitionChart prices={filteredPrices} />
                  <div id="sa-regime-break" className="scroll-mt-20">
                    <StructuralBreakChart prices={filteredPrices} seriesMode={seriesMode} />
                  </div>
                  <BOCPDChart prices={filteredPrices} seriesMode={seriesMode} />
                </>
              )}

              {activeSection === "causal" && (
                <>
                  <EventStudyChart prices={allPrices} />
                  <div id="sa-causal" className="scroll-mt-20">
                    <CausalChart prices={filteredPrices} seriesMode={seriesMode} />
                  </div>
                  <CCMChart prices={filteredPrices} seriesMode={seriesMode} />
                </>
              )}

              {activeSection === "tailrisk" && (
                <>
                  <TailRiskChart prices={filteredPrices} seriesMode={seriesMode} />
                  <CopulaChart prices={filteredPrices} seriesMode={seriesMode} />
                  <HillEstimatorChart prices={filteredPrices} />
                </>
              )}

              {activeSection === "calendar" && (
                <>
                  <SpiralHeatmap prices={filteredPrices} period={period} />
                  <WeekdayEdgeScanChart prices={filteredPrices} />
                  <HighLowTimingChart ticker={data.ticker} />
                </>
              )}

              {activeSection === "simulation" && (
                <>
                  <CustomReturnChart prices={allPrices} />
                  <PriceForecastChart prices={filteredPrices} />
                  <SimpleBacktestChart prices={filteredPrices} />
                  <div id="sa-sim-meanrev" className="scroll-mt-20">
                    <MeanReversionChart prices={filteredPrices} seriesMode={seriesMode} />
                  </div>
                  <div id="sa-sim-arima" className="scroll-mt-20">
                    <ArimaChart prices={filteredPrices} seriesMode={seriesMode} />
                  </div>
                  <JumpDiffusionChart prices={filteredPrices} />
                  <OptimalStoppingChart prices={filteredPrices} />
                  <VarianceGammaChart prices={filteredPrices} />
                  <FBMChart prices={filteredPrices} />
                </>
              )}

              {activeSection === "quantum" && (
                <>
                  <PropagatorChart prices={filteredPrices} />
                  <PathIntegralChart prices={filteredPrices} />
                  <DMDChart prices={filteredPrices} seriesMode={seriesMode} />
                  <DecoherenceChart prices={filteredPrices} />
                  <MarketTimeChart prices={filteredPrices} />
                  <DensityMatrixChart prices={filteredPrices} />
                </>
              )}
            </div>
          </>
        )}

        {!data && !loading && !error && (
          <div className="py-12">
            <div className="max-w-4xl mx-auto">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 text-sm">
                {SECTIONS.map(({ key, label, description }) => (
                  <div key={key} className="p-3 rounded-lg border border-gray-200">
                    <div className="font-medium text-gray-700 mb-0.5">{label}</div>
                    <div className="text-xs text-gray-400">{description}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="text-center text-xs text-gray-400 py-8 space-y-1">
        <p>株価データはYahoo Financeより取得。投資判断の参考としてご利用ください。</p>
        <p>
          <Link href="/feedback" className="text-blue-500 hover:text-blue-600 underline">
            機能改善のご意見・ご要望はこちら
          </Link>
        </p>
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
