"use client";

import { useCallback, useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { track } from "@vercel/analytics";
import { useAnalysisData, PeriodKey } from "./hooks/useAnalysisData";
import PeriodSelector from "./components/analysis/PeriodSelector";
import SeriesModeSelector from "./components/analysis/SeriesModeSelector";
import WatchlistPanel from "./components/WatchlistPanel";
import TickerSearchInput from "./components/TickerSearchInput";
import AccordionSection, {
  AnalysisAvailabilityProvider,
} from "./components/analysis/AccordionSection";
import DataQualityNotice from "./components/analysis/DataQualityNotice";
import CollapsibleAnalysis from "./components/analysis/CollapsibleAnalysis";
import DirectionValue from "./components/analysis/DirectionValue";
import { formatSummaryPrice } from "./lib/format";
import { SeriesMode } from "./lib/series-mode";
import { sectionForPanel } from "./lib/panel-sections";
import {
  CLOSE_ONLY_CAUTION_PANEL_IDS,
  CLOSE_ONLY_UNAVAILABLE_PANEL_IDS,
} from "./lib/panel-data-requirements";
import { OPEN_PANEL_EVENT, type OpenPanelDetail } from "./lib/panel-nav";
import { recordTicker } from "./lib/test-ledger";

const DiffSeriesChart = dynamic(
  () => import("./components/analysis/DiffSeriesChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={250} /> }
);
const BlackScholesLabChart = dynamic(
  () => import("./components/analysis/BlackScholesLabChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RealizedVolVrpChart = dynamic(
  () => import("./components/analysis/RealizedVolVrpChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const FuturesCarryChart = dynamic(
  () => import("./components/analysis/FuturesCarryChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const DeltaHedgeSimChart = dynamic(
  () => import("./components/analysis/DeltaHedgeSimChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const VolumeAnalysis = dynamic(
  () => import("./components/analysis/VolumeAnalysis"),
  { ssr: false, loading: () => <ChartPlaceholder height={200} /> }
);
const UnifiedChart = dynamic(
  () => import("./components/analysis/UnifiedChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const DataQualityPanel = dynamic(
  () => import("./components/analysis/DataQualityPanel"),
  { ssr: false, loading: () => <ChartPlaceholder height={200} /> }
);
const GapAnalysisChart = dynamic(
  () => import("./components/analysis/GapAnalysisChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const CustomReturnChart = dynamic(
  () => import("./components/analysis/CustomReturnChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={300} /> }
);
const DiscretionaryLab = dynamic(
  () => import("./components/analysis/DiscretionaryLab"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
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
const ComplexPlaneChart = dynamic(
  () => import("./components/analysis/ComplexPlaneChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const ZPlanePoleChart = dynamic(
  () => import("./components/analysis/ZPlanePoleChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const PhaseClockChart = dynamic(
  () => import("./components/analysis/PhaseClockChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const PotentialLandscapeChart = dynamic(
  () => import("./components/analysis/PotentialLandscapeChart"),
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
const WeekdayTradeSimulator = dynamic(
  () => import("./components/analysis/WeekdayTradeSimulator"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const NullCalibrationChart = dynamic(
  () => import("./components/analysis/NullCalibrationChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const NullAnatomyChart = dynamic(
  () => import("./components/analysis/NullAnatomyChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const WeekdayUsInteractionChart = dynamic(
  () => import("./components/analysis/WeekdayUsInteractionChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const WeekendPremiumChart = dynamic(
  () => import("./components/analysis/WeekendPremiumChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const TimingValueChart = dynamic(
  () => import("./components/analysis/TimingValueChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const WeekdayBarrierChart = dynamic(
  () => import("./components/analysis/WeekdayBarrierChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const OptimalExitChart = dynamic(
  () => import("./components/analysis/OptimalExitChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const EventCalendarChart = dynamic(
  () => import("./components/analysis/EventCalendarChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const WeekdayVsBuyHoldChart = dynamic(
  () => import("./components/analysis/WeekdayVsBuyHoldChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const NisaVsTaxableChart = dynamic(
  () => import("./components/analysis/NisaVsTaxableChart"),
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
const OHLCVolatilityChart = dynamic(
  () => import("./components/analysis/OHLCVolatilityChart"),
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
const VolTargetingChart = dynamic(
  () => import("./components/analysis/VolTargetingChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
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
const InvestorBiasCoach = dynamic(
  () => import("./components/analysis/InvestorBiasCoach"),
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
const CandleSeasonalityChart = dynamic(
  () => import("./components/analysis/CandleSeasonalityChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const WeekClockChart = dynamic(
  () => import("./components/analysis/WeekClockChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const IntradayProfileChart = dynamic(
  () => import("./components/analysis/IntradayProfileChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const VwapDeviationChart = dynamic(
  () => import("./components/analysis/VwapDeviationChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const ExecutionTimingChart = dynamic(
  () => import("./components/analysis/ExecutionTimingChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const SignalExecutionChart = dynamic(
  () => import("./components/analysis/SignalExecutionChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const EdgeDiscountChart = dynamic(
  () => import("./components/analysis/EdgeDiscountChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const SlicedExecutionChart = dynamic(
  () => import("./components/analysis/SlicedExecutionChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const IntradayRegimeChart = dynamic(
  () => import("./components/analysis/IntradayRegimeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const IntradayExcursionChart = dynamic(
  () => import("./components/analysis/IntradayExcursionChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RealizedVolChart = dynamic(
  () => import("./components/analysis/RealizedVolChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const GapIntradayChart = dynamic(
  () => import("./components/analysis/GapIntradayChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const SignalIntradayChart = dynamic(
  () => import("./components/analysis/SignalIntradayChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const ConditionalForwardChart = dynamic(
  () => import("./components/analysis/ConditionalForwardChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const ReturnBinHeatmapChart = dynamic(
  () => import("./components/analysis/ReturnBinHeatmapChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const ConditionMarkerChart = dynamic(
  () => import("./components/analysis/ConditionMarkerChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const CustomBucketChart = dynamic(
  () => import("./components/analysis/CustomBucketChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const IntradayWindowChart = dynamic(
  () => import("./components/analysis/IntradayWindowChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const UsBetaChart = dynamic(
  () => import("./components/analysis/UsBetaChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const UsPathChart = dynamic(
  () => import("./components/analysis/UsPathChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const WeekdayIntradayPathChart = dynamic(
  () => import("./components/analysis/WeekdayIntradayPathChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const TurnOfMonthPathChart = dynamic(
  () => import("./components/analysis/TurnOfMonthPathChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const WeekdayUsPathChart = dynamic(
  () => import("./components/analysis/WeekdayUsPathChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const TodayVsExpectedPathChart = dynamic(
  () => import("./components/analysis/TodayVsExpectedPathChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const IntradayAnalogPathChart = dynamic(
  () => import("./components/analysis/IntradayAnalogPathChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const UsJpLinkedPathChart = dynamic(
  () => import("./components/analysis/UsJpLinkedPathChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const UsBinEventStudyChart = dynamic(
  () => import("./components/analysis/UsBinEventStudyChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RegimeUsPathChart = dynamic(
  () => import("./components/analysis/RegimeUsPathChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const MondayGapChart = dynamic(
  () => import("./components/analysis/MondayGapChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const WeekdayIntradayEdgeChart = dynamic(
  () => import("./components/analysis/WeekdayIntradayEdgeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const SectorBasketWeekdayChart = dynamic(
  () => import("./components/analysis/SectorBasketWeekdayChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const UsAbsorptionChart = dynamic(
  () => import("./components/analysis/UsAbsorptionChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const UsVolSpilloverChart = dynamic(
  () => import("./components/analysis/UsVolSpilloverChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const UsTimingEdgeChart = dynamic(
  () => import("./components/analysis/UsTimingEdgeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const UsLeadLagChart = dynamic(
  () => import("./components/analysis/UsLeadLagChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const UsDriverChart = dynamic(
  () => import("./components/analysis/UsDriverChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const UsHoldingPeriodChart = dynamic(
  () => import("./components/analysis/UsHoldingPeriodChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const UsDigestionBoundaryChart = dynamic(
  () => import("./components/analysis/UsDigestionBoundaryChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const UsEventTimeChart = dynamic(
  () => import("./components/analysis/UsEventTimeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const ShortTermReversalChart = dynamic(
  () => import("./components/analysis/ShortTermReversalChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const OvernightIntradayChart = dynamic(
  () => import("./components/analysis/OvernightIntradayChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const ExecutionTimingScanChart = dynamic(
  () => import("./components/analysis/ExecutionTimingScanChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const ConditionalSegmentEdgeChart = dynamic(
  () => import("./components/analysis/ConditionalSegmentEdgeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const SpreadEstimatorChart = dynamic(
  () => import("./components/analysis/SpreadEstimatorChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RangeContractionChart = dynamic(
  () => import("./components/analysis/RangeContractionChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RelativeStrengthChart = dynamic(
  () => import("./components/analysis/RelativeStrengthChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const HistoricalAnalogChart = dynamic(
  () => import("./components/analysis/HistoricalAnalogChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const WeeklyAnalogChart = dynamic(
  () => import("./components/analysis/WeeklyAnalogChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const WeeklyAnalogOosChart = dynamic(
  () => import("./components/analysis/WeeklyAnalogOosChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const WeekEmbeddingChart = dynamic(
  () => import("./components/analysis/WeekEmbeddingChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const TpSlOptimizerChart = dynamic(
  () => import("./components/analysis/TpSlOptimizerChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const CandlePatternEdgeChart = dynamic(
  () => import("./components/analysis/CandlePatternEdgeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const GapClassificationChart = dynamic(
  () => import("./components/analysis/GapClassificationChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const HARChart = dynamic(
  () => import("./components/analysis/HARChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const VolLeverageChart = dynamic(
  () => import("./components/analysis/VolLeverageChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RangeVolConeChart = dynamic(
  () => import("./components/analysis/RangeVolConeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RelativeVolumeChart = dynamic(
  () => import("./components/analysis/RelativeVolumeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const VolumeIndicatorsChart = dynamic(
  () => import("./components/analysis/VolumeIndicatorsChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const SignedVolumeChart = dynamic(
  () => import("./components/analysis/SignedVolumeChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const VolumeProfileExtChart = dynamic(
  () => import("./components/analysis/VolumeProfileExtChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const CandleRunChart = dynamic(
  () => import("./components/analysis/CandleRunChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const WickPressureChart = dynamic(
  () => import("./components/analysis/WickPressureChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const TrendMomentumChart = dynamic(
  () => import("./components/analysis/TrendMomentumChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RollingVarianceRatioChart = dynamic(
  () => import("./components/analysis/RollingVarianceRatioChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const BreakoutStatsChart = dynamic(
  () => import("./components/analysis/BreakoutStatsChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RiskRatiosChart = dynamic(
  () => import("./components/analysis/RiskRatiosChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RollingVaRChart = dynamic(
  () => import("./components/analysis/RollingVaRChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const DrawdownDistChart = dynamic(
  () => import("./components/analysis/DrawdownDistChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const DownsideDecompChart = dynamic(
  () => import("./components/analysis/DownsideDecompChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const ConditionalBetaChart = dynamic(
  () => import("./components/analysis/ConditionalBetaChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const WeekdayDecompChart = dynamic(
  () => import("./components/analysis/WeekdayDecompChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const TwoFactorHeatmapChart = dynamic(
  () => import("./components/analysis/TwoFactorHeatmapChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const StatePredictabilityChart = dynamic(
  () => import("./components/analysis/StatePredictabilityChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
// エッジ探索セクション
const InteractionScanChart = dynamic(
  () => import("./components/analysis/InteractionScanChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RegimeEdgeMapChart = dynamic(
  () => import("./components/analysis/RegimeEdgeMapChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const WalkForwardChart = dynamic(
  () => import("./components/analysis/WalkForwardChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const SignalStackingChart = dynamic(
  () => import("./components/analysis/SignalStackingChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const EdgePowerChart = dynamic(
  () => import("./components/analysis/EdgePowerChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);
const EdgeCapacityChart = dynamic(
  () => import("./components/analysis/EdgeCapacityChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const EdgeBookChart = dynamic(
  () => import("./components/analysis/EdgeBookChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const EdgeDecayChart = dynamic(
  () => import("./components/analysis/EdgeDecayChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const ProspectiveLedgerChart = dynamic(
  () => import("./components/analysis/ProspectiveLedgerChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const AsOfSnapshotChart = dynamic(
  () => import("./components/analysis/AsOfSnapshotChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={520} /> }
);
const AsOfScorecardChart = dynamic(
  () => import("./components/analysis/AsOfScorecardChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={600} /> }
);
const AsOfAnalogReplayChart = dynamic(
  () => import("./components/analysis/AsOfAnalogReplayChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const TestRegistryChart = dynamic(
  () => import("./components/analysis/TestRegistryChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const WeekdayConditionalChart = dynamic(
  () => import("./components/analysis/WeekdayConditionalChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const CalendarEffectChart = dynamic(
  () => import("./components/analysis/CalendarEffectChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const SessionGapChart = dynamic(
  () => import("./components/analysis/SessionGapChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const TodayBinChart = dynamic(
  () => import("./components/analysis/TodayBinChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RelativeStrengthExtChart = dynamic(
  () => import("./components/analysis/RelativeStrengthExtChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const BenchmarkDCCChart = dynamic(
  () => import("./components/analysis/BenchmarkDCCChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RegimeClusteringChart = dynamic(
  () => import("./components/analysis/RegimeClusteringChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const MultivarSimplexChart = dynamic(
  () => import("./components/analysis/MultivarSimplexChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const StopComparisonChart = dynamic(
  () => import("./components/analysis/StopComparisonChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RMultipleChart = dynamic(
  () => import("./components/analysis/RMultipleChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const BlockBootstrapChart = dynamic(
  () => import("./components/analysis/BlockBootstrapChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const KellyChart = dynamic(
  () => import("./components/analysis/KellyChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const PersistenceChart = dynamic(
  () => import("./components/analysis/PersistenceChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const RollingAnimationChart = dynamic(
  () => import("./components/analysis/RollingAnimationChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
const ConsolidatedScorecardChart = dynamic(
  () => import("./components/analysis/ConsolidatedScorecardChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> }
);
function ChartPlaceholder({ height }: { height: number }) {
  return (
    <div
      className="w-full bg-gray-50 rounded-lg border border-gray-200 flex items-center justify-center text-gray-500"
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
  | "derivatives"
  | "transform"
  | "distribution"
  | "volatility"
  | "frequency"
  | "nonlinear"
  | "entropy"
  | "fractal"
  | "network"
  | "conditional"
  | "edge"
  | "asof"
  | "calendar"
  | "regime"
  | "causal"
  | "tailrisk"
  | "simulation"
  | "discretionary"
  | "quantum";

const SECTIONS: { key: SectionKey; label: string; method: string; description: string }[] = [
  { key: "basic", label: "値動きの全体像を見る", method: "基本分析", description: "ローソク足・一目均衡表・支持/抵抗線・フィボナッチ・ベンチマーク比較" },
  { key: "technical", label: "売買タイミングを探す", method: "テクニカル", description: "RSI・MACD・BB・ADX・ストキャスティクス・OBV/VWAP" },
  { key: "ohlc", label: "値動きの内訳を見る", method: "OHLC分析", description: "ローソク足構造・MFE/MAE・レンジ・ギャップ散布図・レンジベースVol" },
  { key: "risk", label: "損失とリスクを測る", method: "リスク指標", description: "ドローダウン・VaR/CVaR・シャープ/ソルティノ比率・ボラティリティスマイル" },
  { key: "derivatives", label: "派生商品の条件を試す", method: "デリバティブ", description: "Black-Scholesラボ(ペイオフ/Greeks)・実現Vol/VRP・先物カーブ/ロールイールド・デルタヘッジ" },
  { key: "transform", label: "比べやすい形に整える", method: "スケール変換", description: "対数リターン・順位変換・ボラ正規化・累積リターン・差分・Box-Cox・ドローダウン・Zスコア" },
  { key: "distribution", label: "値動きの癖を確かめる", method: "分布・相関", description: "リターン分布・QQプロット・ACF/PACF・分散比検定" },
  { key: "volatility", label: "変動の大きさを読む", method: "ボラティリティ", description: "EWMA・GARCH・ATR・ケルトナーチャネル" },
  { key: "frequency", label: "繰り返す周期を探す", method: "周波数領域", description: "FFT・ウェーブレット・コヒーレンス・EMD・解析信号・HHS・STFT・SSA・Lomb-Scargle" },
  { key: "nonlinear", label: "複雑な変化を捉える", method: "非線形動力学", description: "アトラクタ・RQA・Lyapunov・位相空間予測・KM係数・TDA・投資シグナル" },
  { key: "entropy", label: "予測しやすさを測る", method: "情報理論", description: "エントロピー拡張・複雑度・情報フロー・レジーム検出・予測可能性" },
  { key: "fractal", label: "傾向の持続性を見る", method: "フラクタル", description: "DFA・Hurst指数・ローリングHurst+サロゲート帯・MF-DFA・R/S・DCCA・相関次元" },
  { key: "network", label: "値動きのつながりを見る", method: "ネットワーク", description: "NVG・HVG・Ordinal・Recurrence Network" },
  { key: "conditional", label: "今の条件から先を読む", method: "条件付き分析", description: "状態→先行きリターン表（RSI/ボラ/トレンド別の条件付き期待値・有意性・年次持続性）" },
  { key: "edge", label: "その優位性は本物か", method: "エッジ探索", description: "条件ペア交互作用スキャン・レジーム別エッジマップ・ウォークフォワード頑健性・シグナル合成・エッジ容量推定・減衰検知(SPRT/CUSUM)・前向き検証台帳・多重検定台帳" },
  { key: "asof", label: "過去の判断を採点する", method: "as-of検証", description: "過去の時点に戻り、その時点で分かる情報だけで出した判断がその後に適切だったかを採点（スナップショット再現・型別スコアカード・アナログ経路リプレイ）" },
  { key: "regime", label: "今の相場環境を見極める", method: "レジーム分析", description: "市場状態ダッシュボード・3状態カルマン・スムーザー・HMM・変化点検出・ベイズ変化点検出" },
  { key: "causal", label: "何が値動きに先行するか", method: "因果・情報", description: "イベントスタディ・Transfer Entropy・Granger因果・相互情報量・CCM非線形因果" },
  { key: "tailrisk", label: "どれだけ下がりうるか", method: "テイルリスク", description: "極値統計・高次キュムラント・テイル依存性・Copula分析" },
  { key: "calendar", label: "いつ買って、いつ降りるか", method: "カレンダー", description: "曜日/月別アノマリー・ヒートマップ・ローソク足の季節性・高値/安値の時間帯分布(日中足)" },
  { key: "simulation", label: "将来シナリオを試す", method: "シミュレーション", description: "カスタム売買・GBDT予測・株価予測(モンテカルロ)・バックテスト・分数BM・VG過程・最適停止" },
  { key: "discretionary", label: "自分の売買を検証する", method: "裁量トレード", description: "クリックで任意タイミング売買・Buy&Hold比較・裁量基準の逆算・期間適用バックテスト(シナリオ保存可)" },
  { key: "quantum", label: "値動きの癖を見る（上級）", method: "量子力学的", description: "プロパゲータ・経路積分・DMD・デコヒーレンス・市場時間・密度行列" },
];

// 投信の基準価額系列（OHLCがすべて同値・出来高0）で解釈できないパネルの台帳は
// app/lib/panel-data-requirements.ts にある。ここに直接書くと、新しいパネルを
// 足したときの分類漏れを検出できない（fail-open）。同ファイルの3分類が page.tsx の
// 全IDを覆っていることを __tests__/page-wiring.test.ts が検査する。

// 入力系列(seriesMode)を実際に消費するセクション。これ以外のセクション
// (基礎・テクニカル・OHLC・リスク・カレンダー)はチャートが OHLC ベースで
// 系列変換が効かないため、SeriesModeSelector の中身を表示しない。
// 将来コンポーネントを seriesMode 対応化した際は、ここにキーを追加すること。
const SERIES_AWARE_SECTIONS = new Set<SectionKey>([
  "transform", "distribution", "volatility", "frequency", "nonlinear",
  "entropy", "fractal", "network", "regime", "causal", "tailrisk",
  "simulation", "quantum",
]);

const SECTION_KEYS = new Set<SectionKey>(SECTIONS.map(({ key }) => key));
const PERIOD_KEYS = new Set<PeriodKey>(["1m", "3m", "6m", "1y", "2y", "3y", "5y", "10y"]);
const SERIES_MODES = new Set<SeriesMode>([
  "close", "diff", "logReturn", "open", "overnightReturn", "intradayReturn",
]);
const DEFAULT_TICKER = "7203.T";
const PANEL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

function replacePanelParam(panel: string | null) {
  const url = new URL(window.location.href);
  if (panel) url.searchParams.set("panel", panel);
  else url.searchParams.delete("panel");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export default function AnalysisPage() {
  const { data, allPrices, filteredPrices, loading, error, fetchStock, period, setPeriod } =
    useAnalysisData();
  const [activeSection, setActiveSection] = useState<SectionKey>("basic");
  const [seriesMode, setSeriesMode] = useState<SeriesMode>("close");
  const [tickerInput, setTickerInput] = useState("");
  const [restored, setRestored] = useState(false);
  // 折りたたみ節: 一括開閉（アクティブ節で共有）
  const [sectionBulk, setSectionBulk] = useState<{ nonce: number; open: boolean }>({
    nonce: 0,
    open: false,
  });
  const bumpBulk = useCallback(
    (open: boolean) => setSectionBulk((b) => ({ nonce: b.nonce + 1, open })),
    []
  );
  // ヘッダー本体は通常フローに置き、ページと一緒に自然にスクロールアウトさせる。
  // 本体が画面外に出た状態で上スクロールしたときだけ、検索窓のみの浮動バーを出す。
  const [showFloat, setShowFloat] = useState(false);
  const headerBarRef = useRef<HTMLDivElement>(null);

  // 初回マウント時は共有URLを最優先し、不足する項目だけ前回状態で補う。
  // 初回利用者には既定銘柄を読み込み、空の分析画面を見せない。
  const restoredRef = useRef(false);
  const initialPanelRef = useRef<string | null>(null);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const urlSection = params.get("sec") as SectionKey | null;
    const urlMode = params.get("mode") as SeriesMode | null;
    const urlPeriod = params.get("period") as PeriodKey | null;
    const urlTicker = params.get("ticker")?.trim() || null;
    const urlPanel = params.get("panel");

    let savedSection: SectionKey | null = null;
    let savedMode: SeriesMode | null = null;
    let savedPeriod: PeriodKey | null = null;
    let savedTicker: string | null = null;
    try {
      savedSection = localStorage.getItem("sa:section") as SectionKey | null;
      savedMode = localStorage.getItem("sa:seriesMode") as SeriesMode | null;
      savedPeriod = localStorage.getItem("sa:period") as PeriodKey | null;
      savedTicker = localStorage.getItem("sa:lastTicker");
    } catch {
      // localStorage 利用不可（プライベートモード等）の場合は無視
    }

    // `panel` は所属セクションが決まっているので、`sec` より優先する。
    // 両者が食い違う共有URL（節をまたぐジャンプの後にコピーされた等）では、以前は
    // 指定された節にそのパネルが無く、60フレーム探して無言で諦めていた。
    const panelSection = urlPanel ? sectionForPanel(urlPanel) : null;
    const nextSection = SECTION_KEYS.has(panelSection as SectionKey)
      ? (panelSection as SectionKey)
      : SECTION_KEYS.has(urlSection as SectionKey)
      ? urlSection
      : SECTION_KEYS.has(savedSection as SectionKey) ? savedSection : "basic";
    const nextMode = SERIES_MODES.has(urlMode as SeriesMode)
      ? urlMode
      : SERIES_MODES.has(savedMode as SeriesMode) ? savedMode : "close";
    const nextPeriod = PERIOD_KEYS.has(urlPeriod as PeriodKey)
      ? urlPeriod
      : PERIOD_KEYS.has(savedPeriod as PeriodKey) ? savedPeriod : "6m";
    const nextTicker = urlTicker ?? savedTicker?.trim() ?? DEFAULT_TICKER;

    setActiveSection(nextSection ?? "basic");
    setSeriesMode(nextMode ?? "close");
    setPeriod(nextPeriod ?? "6m");
    setTickerInput(nextTicker);

    if (urlPanel && PANEL_ID_PATTERN.test(urlPanel)) {
      initialPanelRef.current = urlPanel;
      try { localStorage.setItem(`sa:open:${urlPanel}`, "1"); } catch {}
    }
    fetchStock(nextTicker);
    setRestored(true);
  }, [fetchStock, setPeriod]);

  // 現在の分析状態を共有可能なURLへ反映する。パネルIDは共通ラッパーが管理するため、
  // ここでは既存の panel パラメータを保ったまま他の状態だけを同期する。
  useEffect(() => {
    if (!restored || !data?.ticker) return;
    const url = new URL(window.location.href);
    url.searchParams.set("ticker", data.ticker);
    url.searchParams.set("sec", activeSection);
    url.searchParams.set("period", period);
    url.searchParams.set("mode", seriesMode);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [activeSection, data?.ticker, period, restored, seriesMode]);

  // 共有URLで指定されたパネルを、データ取得とセクション描画の完了後に表示する。
  useEffect(() => {
    const panel = initialPanelRef.current;
    if (!panel || !data?.ticker) return;
    let tries = 0;
    const tick = () => {
      const el = document.getElementById(`panel-${panel}`);
      if (el) {
        initialPanelRef.current = null;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.classList.add("sa-flash");
        setTimeout(() => el.classList.remove("sa-flash"), 1200);
        return;
      }
      if (tries++ < 60) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [activeSection, data?.ticker]);

  const submitTicker = useCallback((ticker: string) => {
    const normalized = ticker.trim();
    if (!normalized) return;
    track("search_ticker", { ticker: normalized });
    fetchStock(normalized);
  }, [fetchStock]);

  const changeSection = useCallback((section: SectionKey) => {
    replacePanelParam(null);
    setActiveSection(section);
    track("section_change", { section });
  }, []);

  // 取得成功した銘柄・現在の表示状態を保存する
  useEffect(() => {
    if (data?.ticker) {
      try {
        localStorage.setItem("sa:lastTicker", data.ticker);
      } catch {}
      // 多重検定台帳(実測): 閲覧した銘柄を記録し、家族サイズに反映する。
      recordTicker(data.ticker);
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

  // 浮動検索バーの表示制御。ヘッダー本体が見えている間は出さず、
  // 画面外に出た後の上スクロールでスライドイン / 下スクロールでスライドアウトする。
  // ±6px の閾値はスクロール量の揺れによるちらつき防止。
  useEffect(() => {
    let lastY = window.scrollY;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        const dy = y - lastY;
        const bar = headerBarRef.current;
        const barBottom = bar ? bar.offsetTop + bar.offsetHeight : 200;
        if (y <= barBottom) {
          setShowFloat(false); // ヘッダー本体が見えている → 浮動バー不要
        } else if (dy > 6) {
          setShowFloat(false); // 下スクロール → スライドアウト
        } else if (dy < -6) {
          setShowFloat(true); // 上スクロール → 検索窓だけスライドイン
        }
        lastY = y;
        ticking = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Series Explorer の系列グループから対応する詳細分析セクションへジャンプする。
  // タブを切り替えた後、保留中のアンカー DOM を探してスクロール＆ハイライトする。
  const pendingScrollRef = useRef<string | null>(null);
  const navigateToSection = useCallback((section: string, anchor?: string) => {
    // 折りたたみ化した節では、ジャンプ先パネルを開いた状態でマウントさせるため
    // 事前に localStorage の開閉フラグを立てておく（CollapsibleAnalysis が遅延初期化で読む）。
    if (anchor) {
      try { localStorage.setItem(`sa:open:${anchor}`, "1"); } catch {}
    }
    replacePanelParam(anchor ?? null);
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
      // 従来の素の div アンカー(sa-*) と、折りたたみパネル(panel-sa-*) の両方に対応
      const el = document.getElementById(id) || document.getElementById(`panel-${id}`);
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

  // 別の分析からの「このパネルを開いて」（openAnalysisPanel）が節をまたぐ場合を受ける。
  // CollapsibleAnalysis 側の購読はマウント済みのパネルにしか届かないため、他の節の
  // パネルを指すと誰も応答せず**無言で何も起きない**。ここで節を切り替えて拾う。
  // 同じ節なら CollapsibleAnalysis が処理するので何もしない（二重スクロールを避ける）。
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenPanelDetail>).detail;
      if (!detail?.id) return;
      const target = sectionForPanel(detail.id);
      if (!target || target === activeSection || !SECTION_KEYS.has(target as SectionKey)) return;
      navigateToSection(target, detail.id);
    };
    window.addEventListener(OPEN_PANEL_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(OPEN_PANEL_EVENT, onOpen as EventListener);
  }, [activeSection, navigateToSection]);

  const hasDataQualityIssues =
    (data?.dataQuality?.repaired.length ?? 0) > 0 ||
    (data?.dataQuality?.suspects.length ?? 0) > 0;
  const hasCloseOnlyMarketData = useMemo(
    () => allPrices.length > 0 && allPrices.every((price) =>
      price.volume === 0 &&
      price.open === price.close &&
      price.high === price.close &&
      price.low === price.close
    ),
    [allPrices],
  );

  // 破損点検は「どこをどう直したか」の詳細（表＋修復前後チャート）。
  // 報告は10年の全期間に対するものなので、表示期間ではなく allPrices を渡す。
  // 問題がある場合はサマリーより先に、問題がなければサマリーの後に開示する。
  //
  // 配置は「基本」節の1か所だけにする。以前は全セクションの共通ヘッダ部に置いていたため、
  // どの節へ切り替えてもその節の分析本体の手前に点検パネルが挟まり、破損ゼロの銘柄でも
  // 毎回最上段を占めていた。CLAUDE.md の「手を入れたことは画面に開示する」規約は、
  // 全ページ共通の DataQualityNotice バナー（破損・疑いがあるときだけ描画）が担保する。
  // バナーからは他節にいても onOpenPanel でこのパネルへ戻れる。
  const dataQualityPanel = data ? (
    <CollapsibleAnalysis
      id="data-quality"
      title="価格データの破損点検"
      subtitle="配信元のスケール破損を検出・修復した記録。修復した日の配信値と修復値・年率σの膨張・修復前後を重ねたチャート・ベンチマーク指数の点検"
      defaultOpen={hasDataQualityIssues}
    >
      <DataQualityPanel
        ticker={data.ticker}
        prices={allPrices}
        report={data.dataQuality}
      />
    </CollapsibleAnalysis>
  ) : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-4">
        <div className="max-w-7xl mx-auto flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-gray-900">株価構造分析</h1>
            <p className="text-sm text-gray-500 mt-1">
              市場の隠れた構造をデータから抽出する
            </p>
          </div>
          <div className="shrink-0 flex items-center flex-wrap gap-2">
            <Link
              href="/guide"
              className="text-sm text-blue-600 hover:text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50"
            >
              分析ガイド
            </Link>
            <Link
              href="/axioms"
              className="text-sm text-indigo-600 hover:text-indigo-700 border border-indigo-200 rounded-lg px-3 py-1.5 hover:bg-indigo-50"
            >
              株式原論
            </Link>
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
        {/* ヘッダー本体: 検索 + 期間/系列 + セクションタブ。通常フローに置き、
            下スクロールではページと一緒に自然にスクロールアウトする。 */}
        <div
          ref={headerBarRef}
          className="-mx-4 px-4 py-3 border-b border-gray-200 space-y-2"
        >
          <div className="flex items-center gap-3 flex-wrap">
            <TickerSearchInput
              value={tickerInput}
              onChange={setTickerInput}
              onSubmit={submitTicker}
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
                {/* セレクタ用の行高は常に確保し、セクション切替時のレイアウトシフトを防ぐ。 */}
                <div className="basis-full min-h-7 min-w-0 w-full">
                  <SeriesModeSelector
                    current={seriesMode}
                    onChange={setSeriesMode}
                    disabled={!SERIES_AWARE_SECTIONS.has(activeSection)}
                  />
                </div>
              </>
            )}
          </div>

          {/* セクションタブ。全幅で横1行のスクロール帯にして、項目数が多くても
              ファーストビューを縦に押し下げない。 */}
          {data && filteredPrices.length > 0 && (
            <div className="flex gap-1 overflow-x-auto pb-1" aria-label="分析の目的を選ぶ">
              {SECTIONS.map(({ key, label, method }) => (
                <button
                  key={key}
                  onClick={() => changeSection(key)}
                  aria-pressed={activeSection === key}
                  className={`shrink-0 whitespace-nowrap px-3 py-1.5 text-left text-sm rounded font-medium leading-tight transition-colors ${
                    activeSection === key
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  <span className="block">{label}</span>
                  <span className={`block text-[11px] font-normal ${
                    activeSection === key ? "text-blue-100" : "text-gray-500"
                  }`}>
                    {method}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 浮動検索バー: ヘッダー本体が画面外のとき、上スクロールで検索窓だけが現れる。
            fixed なのでレイアウトに影響せず、非表示時は transform で画面外に退避。 */}
        <div
          className={`fixed top-0 left-0 right-0 z-30 bg-gray-50/95 backdrop-blur-sm border-b border-gray-200 transition-transform duration-200 ${
            showFloat ? "translate-y-0" : "-translate-y-full"
          }`}
        >
          <div className="max-w-7xl mx-auto px-4 py-2">
            <TickerSearchInput
              value={tickerInput}
              onChange={setTickerInput}
              onSubmit={submitTicker}
              loading={loading}
            />
          </div>
        </div>

        {error && (
          <div className="bg-red-50 text-red-700 rounded-lg p-3 text-sm">
            {error}
          </div>
        )}

        <DataQualityNotice
          report={data?.dataQuality}
          onOpenPanel={() => navigateToSection("basic", "data-quality")}
        />

        {data && filteredPrices.length > 0 && (
          <>
            <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600">
              <span className="font-medium text-gray-800">
                {SECTIONS.find(s => s.key === activeSection)?.label}
              </span>
              <span className="ml-1 text-gray-500">
                （{SECTIONS.find(s => s.key === activeSection)?.method}）
              </span>
              <span className="mt-1 block">
                {SECTIONS.find(s => s.key === activeSection)?.description}
              </span>
            </div>

            <div className="flex flex-col gap-4">
              {activeSection === "basic" && (
                <div className={hasDataQualityIssues ? "order-1" : "order-2"}>
                  {dataQualityPanel}
                </div>
              )}

              {/* サマリー */}
              <div
                className={`grid grid-cols-2 sm:grid-cols-4 gap-3 ${
                  hasDataQualityIssues ? "order-2" : "order-1"
                }`}
              >
                <SummaryCard
                  label="現在値"
                  value={formatSummaryPrice(
                    filteredPrices[filteredPrices.length - 1].close,
                    data.currency
                  )}
                />
                <SummaryCard
                  label="期間始値"
                  value={formatSummaryPrice(filteredPrices[0].close, data.currency)}
                />
                <SummaryCard
                  label="期間変動"
                  value={(() => {
                    const change =
                      ((filteredPrices[filteredPrices.length - 1].close -
                        filteredPrices[0].close) /
                        filteredPrices[0].close) *
                      100;
                    return (
                      <DirectionValue value={change}>
                        {`${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
                      </DirectionValue>
                    );
                  })()}
                />
                <SummaryCard
                  label="データ数"
                  value={`${filteredPrices.length}日`}
                />
              </div>
            </div>

            {/* セクション内容 */}
            <AnalysisAvailabilityProvider
              active={hasCloseOnlyMarketData}
              unavailableItemIds={CLOSE_ONLY_UNAVAILABLE_PANEL_IDS}
              cautionItemIds={CLOSE_ONLY_CAUTION_PANEL_IDS}
              summaryScope={`${data.ticker}:${period}:${filteredPrices.at(-1)?.time ?? "empty"}:${filteredPrices.at(-1)?.close ?? "empty"}`}
            >
              <div className="space-y-6">
              {activeSection === "basic" && (
                <>
                  {/* Series Explorer は常時表示のヒーローチャート（ジャンプの起点） */}
                  {hasCloseOnlyMarketData ? (
                    <div
                      className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
                      role="note"
                    >
                      この銘柄は基準価額だけが配信され、始値・高値・安値は終値と同一、出来高は0です。
                      Series Explorerの価格推移は利用できますが、ローソク足の形や出来高は解釈できません。
                    </div>
                  ) : null}
                  <UnifiedChart prices={allPrices} period={period} onNavigate={navigateToSection} />
                  <AccordionSection
                    bulk={sectionBulk}
                    onBulk={bumpBulk}
                    groups={[
                      {
                        group: "スコア・サマリー",
                        items: [
                          { id: "basic-structure-score", title: "構造スコアカード", node: <StructureScorecardChart prices={filteredPrices} /> },
                          { id: "basic-consolidated-score", title: "総合スコアカード（多分析の所見を1枚に集約）", node: <ConsolidatedScorecardChart prices={filteredPrices} /> },
                          { id: "basic-rolling-anim", title: "ローリング・アニメーション（リスク/リターンの遷移）", node: <RollingAnimationChart prices={filteredPrices} /> },
                        ],
                      },
                      {
                        group: "ベンチマーク・相対力",
                        items: [
                          { id: "basic-benchmark", title: "ベンチマーク比較", node: <BenchmarkChart prices={allPrices} period={period} /> },
                          { id: "basic-relstrength", title: "相対力（対ベンチマーク）と RSモメンタム", node: <RelativeStrengthChart prices={filteredPrices} /> },
                          { id: "basic-relstrength-ext", title: "相対力の拡張（キャプチャ比・共和分・リードラグ）", node: <RelativeStrengthExtChart prices={filteredPrices} /> },
                          { id: "basic-dcc", title: "時変相関 DCC（対ベンチマーク）", node: <BenchmarkDCCChart prices={filteredPrices} ticker={data.ticker} /> },
                        ],
                      },
                      {
                        group: "出来高",
                        items: [
                          { id: "basic-volume", title: "出来高分析", node: <VolumeAnalysis prices={allPrices} period={period} /> },
                          { id: "basic-rvol", title: "相対出来高 RVOL（出来高の枯渇/急増）", node: <RelativeVolumeChart prices={filteredPrices} /> },
                          { id: "basic-vol-indicators", title: "出来高系指標の拡張（VPT/A-D/MFI/Force/EOM）", node: <VolumeIndicatorsChart prices={filteredPrices} /> },
                          { id: "basic-signed-volume", title: "出来高×リターンの符号付き分析（買い需要/売り需要の質）", node: <SignedVolumeChart prices={filteredPrices} /> },
                          { id: "basic-volume-profile", title: "出来高プロファイル (Volume at Price)", node: <VolumeProfileChart prices={filteredPrices} /> },
                          { id: "basic-volume-profile-ext", title: "期間ボリュームプロファイル拡張（POC・バリューエリア・HVN/LVN）", node: <VolumeProfileExtChart prices={filteredPrices} /> },
                          { id: "basic-volume-return", title: "出来高-リターン同時分析", node: <VolumeReturnChart prices={filteredPrices} /> },
                          { id: "basic-volume-lead", title: "出来高先行性分析", node: <VolumeLeadChart prices={filteredPrices} /> },
                        ],
                      },
                      {
                        group: "価格系列・その他",
                        items: [
                          { id: "basic-diff", title: "差分系列", node: <DiffSeriesChart prices={allPrices} period={period} /> },
                          { id: "basic-gap", title: "ギャップ・日中/夜間リターン分解", node: <GapAnalysisChart prices={allPrices} period={period} /> },
                          { id: "basic-holding", title: "最適保有期間分析", node: <HoldingPeriodChart prices={filteredPrices} /> },
                          { id: "basic-mtf", title: "マルチタイムフレーム分析", node: <MultiTimeframeChart prices={filteredPrices} /> },
                          { id: "basic-behavioral", title: "行動ファイナンス指標", node: <BehavioralChart prices={filteredPrices} /> },
                          { id: "basic-bias-coach", title: "投資家バイアス・コーチ（癖と対策）", node: <InvestorBiasCoach prices={filteredPrices} /> },
                        ],
                      },
                    ]}
                  />
                </>
              )}

              {activeSection === "technical" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      items: [
                        { id: "sa-technical", title: "テクニカル指標（RSI/MACD/BB ほか）", node: <TechnicalIndicators prices={allPrices} period={period} /> },
                        { id: "tech-adx", title: "ADX（Average Directional Index）", node: <ADXChart prices={allPrices} period={period} /> },
                        { id: "tech-stoch", title: "ストキャスティクス", node: <StochasticsChart prices={allPrices} period={period} /> },
                        { id: "tech-obvvwap", title: "OBV・VWAP", node: <OBVVWAPChart prices={allPrices} period={period} /> },
                        { id: "tech-vw", title: "出来高加重テクニカル指標", node: <VolumeWeightedTechChart prices={filteredPrices} /> },
                        { id: "tech-extra", title: "追加テクニカル指標", node: <ExtraTechnicalChart prices={filteredPrices} /> },
                        { id: "tech-breakout", title: "ブレイクアウト統計（ドンチャン・前日高安）", node: <BreakoutStatsChart prices={filteredPrices} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "ohlc" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      group: "ローソク足の構造・パターン",
                      items: [
                        { id: "sa-ohlc", title: "ローソク足構造分析", node: <CandleStructureChart prices={allPrices} period={period} /> },
                        { id: "ohlc-crash-surge", title: "連続暴落・暴騰ラン分析", node: <CrashSurgeStreakChart prices={filteredPrices} /> },
                        { id: "ohlc-pattern", title: "ローソク足パターン認識", node: <CandlestickPatternChart prices={filteredPrices} /> },
                        { id: "ohlc-pattern-edge", title: "ローソク足パターンの統計的エッジ", node: <CandlePatternEdgeChart prices={filteredPrices} /> },
                        { id: "ohlc-candle-run", title: "連続ローソク（陽連/陰連）の先行きリターン", node: <CandleRunChart prices={filteredPrices} /> },
                        { id: "ohlc-wick", title: "髭非対称・圧力指標の時系列（買い圧/売り圧）", node: <WickPressureChart prices={filteredPrices} /> },
                      ],
                    },
                    {
                      group: "日中パス・引け・含み損益",
                      items: [
                        { id: "ohlc-intra-path", title: "日中パス推定", node: <IntradayPathChart prices={filteredPrices} /> },
                        { id: "ohlc-close-position", title: "Close Position分析（引け方分析）", node: <ClosePositionChart prices={filteredPrices} /> },
                        { id: "ohlc-true-range", title: "True Range分解", node: <TrueRangeDecompChart prices={filteredPrices} /> },
                        { id: "ohlc-mfemae", title: "MFE/MAE 分析（含み益・含み損の到達分布）", node: <MFEMAEChart prices={allPrices} period={period} /> },
                        { id: "ohlc-tpsl", title: "最適 TP/SL（保有期間別 MFE/MAE）", node: <TpSlOptimizerChart prices={filteredPrices} /> },
                      ],
                    },
                    {
                      group: "ギャップ・レンジ・ボラティリティ",
                      items: [
                        { id: "sa-ohlc-gap", title: "ギャップ散布図（夜間→日中の関係）", node: <GapScatterChart prices={allPrices} period={period} /> },
                        { id: "ohlc-gap-class", title: "窓の分類と窓埋め統計（gap-and-go vs fade）", node: <GapClassificationChart prices={filteredPrices} /> },
                        { id: "sa-ohlc-range", title: "日中レンジ分析", node: <IntradayRangeChart prices={allPrices} period={period} /> },
                        { id: "ohlc-range-vol", title: "レンジベース・ボラティリティ推定", node: <RangeVolatilityChart prices={allPrices} period={period} /> },
                        { id: "ohlc-ohlc-vol", title: "OHLCボラティリティ推定量の比較（Yang-Zhang ほか）", node: <OHLCVolatilityChart prices={filteredPrices} /> },
                        { id: "sa-ohlc-micro", title: "マイクロストラクチャー指標（スプレッド/インパクト）", node: <MicrostructureChart prices={filteredPrices} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "risk" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      group: "指標・ドローダウン",
                      items: [
                        { id: "sa-risk", title: "リスク指標", node: <RiskMetricsPanel prices={allPrices} period={period} /> },
                        { id: "risk-forecast-range", title: "短期予測レンジ（1〜3日）", node: <ForecastRangeChart prices={filteredPrices} /> },
                        { id: "risk-drawdown", title: "ドローダウン分析", node: <DrawdownChart prices={allPrices} period={period} /> },
                        { id: "risk-dd-dist", title: "ドローダウン期間・回復時間の分布", node: <DrawdownDistChart prices={filteredPrices} /> },
                      ],
                    },
                    {
                      group: "VaR・テイル・裾",
                      items: [
                        { id: "risk-garch-var", title: "GARCH VaR予測", node: <GarchVarChart prices={filteredPrices} /> },
                        { id: "risk-cornish", title: "Cornish-Fisher VaR / オメガレシオ", node: <CornishFisherChart prices={filteredPrices} /> },
                        { id: "risk-rolling-var", title: "ローリング VaR / CVaR（historical / EVT / Cornish-Fisher）", node: <RollingVaRChart prices={filteredPrices} /> },
                        { id: "risk-volsmile", title: "ボラティリティスマイル", node: <VolSmileChart prices={filteredPrices} /> },
                      ],
                    },
                    {
                      group: "調整指標・下方リスク・その他",
                      items: [
                        { id: "risk-finance-theory", title: "Kelly基準 / Black-Scholes / Variance Swap", node: <FinanceTheoryChart prices={filteredPrices} /> },
                        { id: "risk-ratios", title: "リスク調整指標の拡充", node: <RiskRatiosChart prices={filteredPrices} /> },
                        { id: "risk-downside", title: "下方リスク分解（半偏差・損失寄与・連敗分布）", node: <DownsideDecompChart prices={filteredPrices} /> },
                        { id: "risk-cond-beta", title: "条件付きベータ・下方ベータ（地合い別の感応度）", node: <ConditionalBetaChart prices={filteredPrices} /> },
                        { id: "risk-spread", title: "高安スプレッド推定（取引コスト・流動性の代理）", node: <SpreadEstimatorChart prices={filteredPrices} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "derivatives" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      group: "オプション（Black-Scholes）",
                      items: [
                        { id: "deriv-bs-lab", title: "Black-Scholes ラボ（ペイオフ・Greeks・パリティ）", node: <BlackScholesLabChart prices={filteredPrices} /> },
                        { id: "deriv-delta-hedge", title: "デルタヘッジ・シミュレータ（ガンマ・スキャルピング）", node: <DeltaHedgeSimChart prices={filteredPrices} /> },
                      ],
                    },
                    {
                      group: "ボラティリティ商品",
                      items: [
                        { id: "deriv-rv-vrp", title: "実現ボラティリティ・分散リスクプレミアム(VRP)", node: <RealizedVolVrpChart prices={filteredPrices} /> },
                      ],
                    },
                    {
                      group: "先物・フォワード",
                      items: [
                        { id: "deriv-futures-carry", title: "先物カーブ・コスト/キャリー・ロールイールド・ヘッジ比率", node: <FuturesCarryChart prices={filteredPrices} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "transform" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      items: [
                        { id: "sa-transform", title: "スケール・変換（対数/順位/ボラ正規化 ほか）", node: <TransformCharts prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "transform-overnight", title: "オーバーナイト vs 日中エクイティ（リターンの時間帯分解）", node: <OvernightIntradayChart prices={filteredPrices} /> },
                        { id: "transform-exec-scan", title: "売買時刻スキャン（始値/終値・保有日数の最適エッジ探索）", node: <ExecutionTimingScanChart prices={filteredPrices} /> },
                        { id: "transform-weekday-decomp", title: "曜日別 夜間/日中エクイティ分解", node: <WeekdayDecompChart prices={filteredPrices} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "distribution" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      group: "分布形状",
                      items: [
                        { id: "sa-distribution", title: "リターン分布", node: <ReturnDistribution prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "dist-shape", title: "分布形状の詳細分析", node: <DistributionShapeChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "dist-rolling-moments", title: "ローリング高次モーメント", node: <RollingMomentsChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "dist-violin", title: "条件付き分布・バイオリンプロット", node: <ConditionalViolinChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "dist-surface", title: "分布のダイナミクス（ローリング密度サーフェス）", node: <DistributionSurfaceChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "dist-stylized", title: "Stylized Facts（定型化された事実）", node: <StylizedFactsChart prices={filteredPrices} seriesMode={seriesMode} /> },
                      ],
                    },
                    {
                      group: "自己相関・依存性・独立性",
                      items: [
                        { id: "dist-acf", title: "自己相関分析", node: <ACFChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "dist-acf-ext", title: "自己相関分析（拡張）", node: <ACFExtendedChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "dist-lag", title: "ラグ構造・非線形依存性分析", node: <LagDependenceChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "dist-crosscorr", title: "クロスコレログラム（夜間↔日中）", node: <CrossCorrelogramChart prices={filteredPrices} /> },
                        { id: "dist-independence", title: "独立性・ランダム性検定", node: <IndependenceTestsChart prices={filteredPrices} seriesMode={seriesMode} /> },
                      ],
                    },
                    {
                      group: "予測可能性・単位根・分散比",
                      items: [
                        { id: "dist-pred-accuracy", title: "ローリング予測精度", node: <PredictionAccuracyChart prices={filteredPrices} /> },
                        { id: "dist-inforatio", title: "情報比率ダッシュボード", node: <InfoRatioDashboard prices={filteredPrices} /> },
                        { id: "dist-unitroot", title: "単位根検定", node: <UnitRootChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "dist-vr", title: "分散比検定", node: <VarianceRatioChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "dist-rolling-vr", title: "分散比のローリングと有意性（トレンド/回帰の切替監視）", node: <RollingVarianceRatioChart prices={filteredPrices} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "volatility" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      group: "推定・モデル",
                      items: [
                        { id: "sa-volatility", title: "ボラティリティ分析", node: <VolatilityChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "vol-garch", title: "GARCH / レバレッジ効果 / ジャンプ検出", node: <GarchChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "vol-agarch", title: "非対称GARCHモデル", node: <AsymmetricGarchChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "vol-heston", title: "Hestonモデル", node: <HestonChart prices={filteredPrices} /> },
                        { id: "vol-har", title: "HARモデル（日/週/月の実現ボラでボラ予測）", node: <HARChart prices={filteredPrices} /> },
                      ],
                    },
                    {
                      group: "期間構造・コーン・レンジ",
                      items: [
                        { id: "vol-atr", title: "ATR / ケルトナーチャネル", node: <ATRChart prices={filteredPrices} /> },
                        { id: "vol-term", title: "ボラティリティ期間構造", node: <VolTermStructureChart prices={filteredPrices} /> },
                        { id: "vol-cone", title: "ボラティリティ・コーン", node: <VolConeChart prices={filteredPrices} /> },
                        { id: "vol-range-cone", title: "レンジ由来ボラコーン（Yang-Zhang）", node: <RangeVolConeChart prices={filteredPrices} /> },
                        { id: "vol-range-contract", title: "レンジ収縮 → ブレイク（NR7・inside・スクイーズ）", node: <RangeContractionChart prices={filteredPrices} /> },
                        { id: "vol-leverage", title: "ボラのレバレッジ効果（下落→翌日ボラ拡大の非対称性）", node: <VolLeverageChart prices={filteredPrices} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "frequency" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      group: "スペクトル・ウェーブレット",
                      items: [
                        { id: "freq-power", title: "パワースペクトル（FFT）", node: <PowerSpectrum prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "freq-wavelet", title: "ウェーブレットスカログラム（Morlet CWT）", node: <WaveletChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "sa-frequency-coherence", title: "ウェーブレットコヒーレンス", node: <WaveletCoherenceChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "freq-lombscargle", title: "Lomb-Scargleペリオドグラム", node: <LombScargleChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "sa-frequency-ssa", title: "特異スペクトル分析（SSA）", node: <SSAChart prices={filteredPrices} seriesMode={seriesMode} /> },
                      ],
                    },
                    {
                      group: "EMD・解析信号・位相",
                      items: [
                        { id: "freq-emd", title: "EMD / Hilbert-Huang変換", node: <EMDChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "freq-analytic", title: "解析信号と瞬時周波数", node: <AnalyticSignalChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "freq-complex", title: "複素平面表現", node: <ComplexPlaneChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "freq-zplane", title: "z平面ポールマップ（AR極）", node: <ZPlanePoleChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "freq-phaseclock", title: "位相時計（Cycle Phase Clock）", node: <PhaseClockChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "freq-hhs", title: "Hilbert-Huang Spectrum / STFT / スペクトルエントロピー", node: <HilbertHuangChart prices={filteredPrices} seriesMode={seriesMode} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "nonlinear" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      group: "アトラクタ・埋め込み・位相",
                      items: [
                        { id: "sa-nonlinear", title: "アトラクタ指標の統合ビュー（条件の該当状況）", node: <AttractorSignalDashboard prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "nl-embedding", title: "埋め込みパラメータ最適化", node: <EmbeddingOptimizer prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "nl-attractor", title: "アトラクタ探索（Takens埋め込み）", node: <AttractorExplorer prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "nl-weekly-phase", title: "週内位相アトラクタ（動力学的週内アノマリー）", node: <WeeklyPhaseAttractorChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "nl-periodic-phase", title: "一般周期 位相アトラクタ（月内・四半期内）", node: <PeriodicPhaseAttractorChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "nl-phase-sync", title: "週次位相同期（マルチ銘柄 Kuramoto）", node: <WeeklyPhaseSyncChart /> },
                      ],
                    },
                    {
                      group: "RQA・Lyapunov・予測",
                      items: [
                        { id: "nl-rqa", title: "ローリングRQA", node: <RollingRQAChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "nl-local-lyap", title: "局所Lyapunov指数・位相空間密度", node: <LocalLyapunovChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "nl-lyap-spectrum", title: "リアプノフスペクトル・KY次元・ベクトル分解", node: <LyapunovSpectrumChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "nl-simplex", title: "位相空間予測（Simplex / S-map）", node: <SimplexPredictionChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "nl-recurrence", title: "Recurrence Plot & Lyapunov指数", node: <RecurrencePlot prices={filteredPrices} seriesMode={seriesMode} /> },
                      ],
                    },
                    {
                      group: "ポテンシャル・TDA",
                      items: [
                        { id: "nl-km", title: "Kramers-Moyal係数 / ポテンシャル関数", node: <KramersMoyalChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "nl-potential", title: "ポテンシャル地形（Potential / Drift Landscape）", node: <PotentialLandscapeChart prices={filteredPrices} /> },
                        { id: "sa-nonlinear-tda", title: "位相的データ解析（TDA）/ Fisher-Rao距離", node: <TDAChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "nl-rolling-tda", title: "ローリングTDA", node: <RollingTDAChart prices={filteredPrices} seriesMode={seriesMode} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "entropy" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      group: "エントロピー指標",
                      items: [
                        { id: "sa-entropy", title: "情報理論 / エントロピー", node: <EntropyDisplay prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "ent-extended", title: "拡張エントロピー指標", node: <EntropyExtendedChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "ent-conditional", title: "条件付きエントロピー / エントロピー率", node: <ConditionalEntropyChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "ent-multiscale", title: "マルチスケール解析", node: <MultiscaleEntropyChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "ent-heatmap", title: "エントロピーヒートマップ / パターン分布", node: <EntropyHeatmapChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "ent-complexity", title: "複雑度-エントロピー平面", node: <ComplexityEntropyChart prices={filteredPrices} seriesMode={seriesMode} /> },
                      ],
                    },
                    {
                      group: "情報フロー・レジーム",
                      items: [
                        { id: "ent-storage", title: "情報蓄積 / 予測可能性", node: <InformationStorageChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "ent-rolling-te", title: "ローリング移転エントロピー / 相互情報量", node: <RollingTransferEntropyChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "ent-symbolic", title: "シンボル情報フロー / 情報分解", node: <SymbolicInfoFlowChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "ent-regime", title: "エントロピーレジーム検出", node: <EntropyRegimeChart prices={filteredPrices} seriesMode={seriesMode} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "fractal" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      items: [
                        { id: "sa-fractal", title: "フラクタル / スケーリング（DFA・Hurst）", node: <DFAChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "frac-rolling-hurst", title: "ローリングHurst指数 + サロゲート帯", node: <RollingHurstChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "frac-ext", title: "フラクタル拡張解析（MF-DFA・R/S・DCCA ほか）", node: <FractalExtChart prices={filteredPrices} seriesMode={seriesMode} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "network" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      items: [
                        { id: "sa-network", title: "Visibility Graph（NVG）", node: <VisibilityGraphChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "net-hvg", title: "Horizontal Visibility Graph（HVG）", node: <HVGChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "net-ordinal", title: "Ordinal Pattern Transition Network", node: <OrdinalNetwork prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "net-recurrence", title: "Recurrence Network", node: <RecurrenceNetworkChart prices={filteredPrices} seriesMode={seriesMode} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "regime" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      items: [
                        { id: "sa-regime", title: "市場状態ダッシュボード", node: <MarketStateDashboard prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "regime-main", title: "レジーム分析（3状態カルマン・スムーザー・HMM）", node: <RegimeChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "regime-technical", title: "レジーム別テクニカル指標有効性", node: <RegimeTechnicalChart prices={filteredPrices} /> },
                        { id: "regime-distribution", title: "レジーム別分布特性", node: <RegimeDistributionChart prices={filteredPrices} /> },
                        { id: "regime-transition", title: "レジーム遷移分析", node: <RegimeTransitionChart prices={filteredPrices} /> },
                        { id: "sa-regime-break", title: "構造変化検定", node: <StructuralBreakChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "regime-bocpd", title: "ベイズ変化点検出（BOCPD）", node: <BOCPDChart prices={filteredPrices} seriesMode={seriesMode} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "causal" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      items: [
                        { id: "causal-event", title: "条件付きイベントスタディ（始点重ね描き）", node: <EventStudyChart prices={allPrices} /> },
                        { id: "sa-causal", title: "因果・情報伝達解析（Transfer Entropy・Granger）", node: <CausalChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "causal-ccm", title: "CCM非線形因果分析", node: <CCMChart prices={filteredPrices} seriesMode={seriesMode} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "tailrisk" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      items: [
                        { id: "tail-main", title: "テイルリスク解析（極値統計・高次キュムラント）", node: <TailRiskChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "tail-copula", title: "コピュラ分析", node: <CopulaChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "tail-hill", title: "Hillテール指数推定", node: <HillEstimatorChart prices={filteredPrices} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "conditional" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      group: "状態 → 先行きリターン",
                      items: [
                        { id: "cond-forward", title: "状態→先行きリターン表（RSI/ボラ/トレンド別）", node: <ConditionalForwardChart prices={filteredPrices} /> },
                        { id: "cond-segment-edge", title: "条件付きエッジ：日中 vs 夜間（状態別にどちらの執行が有利か）", node: <ConditionalSegmentEdgeChart prices={filteredPrices} /> },
                        { id: "cond-custom-bucket", title: "カスタム条件ビルダー（任意の指標・閾値・分位）", node: <CustomBucketChart prices={filteredPrices} /> },
                        { id: "cond-return-bin", title: "状態 × 先行きリターンビン 分布ヒートマップ", node: <ReturnBinHeatmapChart prices={filteredPrices} /> },
                        { id: "cond-marker", title: "条件発生マーカー & 区間クロスフィルタ", node: <ConditionMarkerChart prices={filteredPrices} /> },
                      ],
                    },
                    {
                      group: "順張り/逆張り・複合・持続性",
                      items: [
                        { id: "cond-trend-momentum", title: "トレンド・モメンタムの先行きリターン（順張りアノマリー検証）", node: <TrendMomentumChart prices={filteredPrices} /> },
                        { id: "cond-reversal", title: "短期リバーサル・エッジ（押し目買い/戻り売りの定量化）", node: <ShortTermReversalChart prices={filteredPrices} /> },
                        { id: "cond-2factor", title: "2変数コンディショニング・ヒートマップ（複合エッジ）", node: <TwoFactorHeatmapChart prices={filteredPrices} /> },
                        { id: "cond-state-pred", title: "状態別の予測可能性（方向的中率・情報係数IC）", node: <StatePredictabilityChart prices={filteredPrices} /> },
                        { id: "cond-persistence", title: "持続性・サンプル外検証（前半/後半の再現性）", node: <PersistenceChart prices={filteredPrices} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "edge" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      group: "探索（エッジを見つける）",
                      items: [
                        { id: "edge-interaction", title: "条件ペア交互作用スキャナ", node: <InteractionScanChart prices={filteredPrices} /> },
                        { id: "edge-regime-map", title: "レジーム別エッジマップ", node: <RegimeEdgeMapChart prices={filteredPrices} /> },
                        { id: "edge-walkforward", title: "ウォークフォワード頑健性（DSR + PBO）", node: <WalkForwardChart prices={filteredPrices} /> },
                        { id: "edge-signal-stack", title: "シグナル合成", node: <SignalStackingChart prices={filteredPrices} /> },
                      ],
                    },
                    {
                      group: "規律（信じてよいか・いくらまでか・まだ生きているか）",
                      items: [
                        { id: "edge-power", title: "検出力の壁（今の標本で証明できるか・必要なブレッドス）", node: <EdgePowerChart prices={allPrices} /> },
                        { id: "edge-capacity", title: "エッジ容量推定（このエッジは何円まで運用できるか）", node: <EdgeCapacityChart prices={filteredPrices} /> },
                        { id: "edge-book", title: "合成ブック（弱いエッジN本を束ねる・テール相関・容量の食い合い）", node: <EdgeBookChart prices={allPrices} /> },
                        { id: "edge-decay", title: "エッジ減衰・死亡検知（SPRT + CUSUM 逐次監視）", node: <EdgeDecayChart prices={allPrices} /> },
                        { id: "edge-ledger", title: "前向き検証台帳（凍結→未来のデータだけで採点）", node: <ProspectiveLedgerChart prices={allPrices} ticker={data.ticker} /> },
                        { id: "edge-test-registry", title: "グローバル多重検定台帳（アプリ全体の偽発見の床）", node: <TestRegistryChart /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "asof" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      group: "その時点の判断を再現する",
                      items: [
                        { id: "asof-snapshot", title: "as-of スナップショット（あの日の画面を再現して、その後と突き合わせる）", node: <AsOfSnapshotChart prices={allPrices} ticker={data.ticker} /> },
                        { id: "asof-analog", title: "as-of アナログ経路リプレイ（過去の各週末の予測を畳まずに並べる）", node: <AsOfAnalogReplayChart prices={allPrices} ticker={data.ticker} /> },
                      ],
                    },
                    {
                      group: "多数の時点でまとめて採点する",
                      items: [
                        { id: "asof-scorecard", title: "as-of スコアカード（方向PT検定／確率Brier・較正／区間被覆／ボラMZ回帰／IC）", node: <AsOfScorecardChart prices={allPrices} ticker={data.ticker} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "calendar" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                  {
                    group: "曜日・カレンダー（日足）",
                    items: [
                      { id: "cal-weekday-edge", title: "曜日タイミング好機スキャン", node: <WeekdayEdgeScanChart prices={filteredPrices} /> },
                      { id: "cal-weekday-sim", title: "曜日トレード・シミュレータ", node: <WeekdayTradeSimulator prices={filteredPrices} /> },
                      { id: "cal-null-calib", title: "ヌル較正：曜日最適化の「偽発見の床」（採用前の門番）", node: <NullCalibrationChart prices={filteredPrices} /> },
                      { id: "cal-null-anatomy", title: "曜日構造の解剖：どこに・どんな構造か（maxT／F分解／頑健性／層別／分散・週末ギャップ込み）", node: <NullAnatomyChart prices={filteredPrices} /> },
                      { id: "cal-weekday-us-interaction", title: "曜日 × 前夜米国：交互作用の解剖（曜日別スピルオーバーβ・上下非対称・セルmaxT）", node: <WeekdayUsInteractionChart prices={filteredPrices} /> },
                      { id: "cal-timing-value", title: "タイミング判断の価値検定（SPA：カレンダー戦略一族 vs B&H・スヌーピング補正）", node: <TimingValueChart prices={allPrices} /> },
                      { id: "cal-weekday-vs-bh", title: "月→金戦略 vs バイ&ホールド 統計的優位性検定", node: <WeekdayVsBuyHoldChart prices={filteredPrices} /> },
                      { id: "cal-weekend-premium", title: "週末プレミアム μ_w：週末保有の有無によるリターン差（区間分解）", node: <WeekendPremiumChart prices={filteredPrices} /> },
                      { id: "cal-optimal-exit", title: "状態依存の最適手仕舞い（月曜Open建玉→いつ降りるか・後退帰納法）", node: <OptimalExitChart prices={filteredPrices} /> },
                      { id: "cal-weekday-barrier", title: "曜日別 TP/SL：バリアで何が測れて何が測れないか（系C28・σ正規化／逸脱／ヌル較正）", node: <WeekdayBarrierChart prices={allPrices} ticker={data.ticker} /> },
                      { id: "cal-nisa-vs-taxable", title: "NISA(非課税・持ち切り) vs 現物(課税・曜日戦略) 税引後・レバレッジ比較", node: <NisaVsTaxableChart prices={allPrices} /> },
                      { id: "cal-spiral", title: "カレンダー螺旋ヒートマップ", node: <SpiralHeatmap prices={filteredPrices} period={period} /> },
                      { id: "cal-candle-season", title: "ローソク足の季節性（足の中身×カレンダー）", node: <CandleSeasonalityChart prices={filteredPrices} /> },
                      { id: "cal-weekclock", title: "週内クロック（月曜始値基準の累積OHLC）", node: <WeekClockChart prices={filteredPrices} ticker={data.ticker} /> },
                      { id: "cal-event-effect", title: "カレンダー・イベント効果（月末/SQ/連休/季節の先行きリターン）", node: <CalendarEffectChart prices={filteredPrices} /> },
                      { id: "cal-event-calendar", title: "イベントカレンダー条件付け（FOMC/CPI/雇用統計/日銀/SQ の先行きリターン）", node: <EventCalendarChart prices={filteredPrices} /> },
                      { id: "cal-session-gap", title: "休場コンテキスト別 曜日値動き（連休・祝日の歪み検出）", node: <SessionGapChart prices={filteredPrices} /> },
                      { id: "cal-today-bin", title: "今日の値動きが該当するリターンビン：同条件の過去分布（曜日非依存）", node: <TodayBinChart prices={filteredPrices} /> },
                      { id: "cal-weekly-analog", title: "今週の軌跡アナログ比較（似た形／前夜米国ビンで絞って先読み）", node: <WeeklyAnalogChart prices={allPrices} ticker={data.ticker} /> },
                      { id: "cal-weekly-analog-oos", title: "今週の軌跡アナログ 予測力OOS検証（IC・方向的中率・多重比較補正）", node: <WeeklyAnalogOosChart prices={allPrices} /> },
                      { id: "cal-week-embed", title: "週内Embedding（週の関数PCA・固有週アトラス／形→翌週リターンの予測力を大域検定）", node: <WeekEmbeddingChart prices={allPrices} /> },
                      { id: "cal-weekday-cond", title: "曜日 × 値動きビン 条件付き分析（インタラクティブ）", node: <WeekdayConditionalChart prices={filteredPrices} /> },
                      { id: "cal-monday-gap", title: "月曜ギャップ解剖（週初めの「下げて始まる」を層別）", node: <MondayGapChart prices={allPrices} /> },
                      { id: "cal-us-bin-event", title: "曜日 × 前夜米国ビン のイベントスタディ（−5日〜+5日の日足経路・効果は持続するか巻き戻るか）", node: <UsBinEventStudyChart prices={allPrices} /> },
                    ],
                  },
                  {
                    group: "曜日×日内 累積パス・エッジ（日中足）",
                    items: [
                      { id: "cal-weekday-intra-path", title: "曜日 × 当日日内 平均累積パス", node: <WeekdayIntradayPathChart ticker={data.ticker} /> },
                      { id: "cal-tom-path", title: "月内位置（月初/中旬/月末）× 当日日内 平均累積パス", node: <TurnOfMonthPathChart ticker={data.ticker} /> },
                      { id: "cal-weekday-us-path", title: "曜日 × 前夜米国ビン 交互作用：日内平均累積パス", node: <WeekdayUsPathChart ticker={data.ticker} /> },
                      { id: "cal-today-vs-expected", title: "当日の実測 vs 条件付き期待パス（台本どおりか／乖離は続くか）", node: <TodayVsExpectedPathChart ticker={data.ticker} /> },
                      { id: "cal-intraday-analog", title: "寄り前情報アナログ（似た経路をたどった過去日の日内パスを重ねる／OOS検証つき）", node: <IntradayAnalogPathChart ticker={data.ticker} /> },
                      { id: "cal-us-jp-linked", title: "前夜米国の日中経路 → 当日日本の連続パス（終値1点でなく“形”で条件付け）", node: <UsJpLinkedPathChart ticker={data.ticker} /> },
                      { id: "cal-regime-us-path", title: "相場基調 × 前夜米国 交互作用：日内平均累積パス", node: <RegimeUsPathChart ticker={data.ticker} /> },
                      { id: "cal-weekday-intra-edge", title: "曜日 × 日内タイミング エッジスキャン", node: <WeekdayIntradayEdgeChart ticker={data.ticker} /> },
                      { id: "cal-sector-basket", title: "業種バスケット 曜日×日内（標本プール）", node: <SectorBasketWeekdayChart ticker={data.ticker} /> },
                    ],
                  },
                  {
                    group: "日中プロファイル・約定タイミング（日中足）",
                    items: [
                      { id: "cal-highlow-timing", title: "高値・安値の時間帯分析", node: <HighLowTimingChart ticker={data.ticker} /> },
                      { id: "cal-exec-timing", title: "寄り/引け 近傍 約定タイミング最適化", node: <ExecutionTimingChart ticker={data.ticker} /> },
                      { id: "cal-edge-discount", title: "エッジ割引（公式マーク vs 約定可能価格）", node: <EdgeDiscountChart prices={allPrices} ticker={data.ticker} /> },
                      { id: "cal-sliced-exec", title: "TWAP/VWAP 分割約定の効果", node: <SlicedExecutionChart ticker={data.ticker} /> },
                      { id: "cal-intra-window", title: "任意時刻ウィンドウ × 曜日 クロス集計", node: <IntradayWindowChart ticker={data.ticker} /> },
                      { id: "cal-intra-profile", title: "時間帯プロファイル（いつ動くか）", node: <IntradayProfileChart ticker={data.ticker} /> },
                      { id: "cal-vwap-dev", title: "VWAP乖離分析（回帰か継続か）", node: <VwapDeviationChart ticker={data.ticker} /> },
                      { id: "cal-intra-regime", title: "当日内の状態（どういう日か）", node: <IntradayRegimeChart ticker={data.ticker} /> },
                      { id: "cal-intra-excursion", title: "当日内 MFE/MAE と TP/SL最適化", node: <IntradayExcursionChart ticker={data.ticker} /> },
                      { id: "cal-realized-vol", title: "マイクロ構造の代理（実現ボラ・夜間/日中・出来高クロック）", node: <RealizedVolChart ticker={data.ticker} /> },
                      { id: "cal-gap-intra", title: "ギャップ後の日中挙動（窓埋め vs gap-and-go）", node: <GapIntradayChart ticker={data.ticker} /> },
                      { id: "cal-signal-intra", title: "日足シグナル翌日の日中エントリー最適化", node: <SignalIntradayChart ticker={data.ticker} /> },
                      { id: "cal-signal-exec", title: "日足シグナル × 最適約定時刻", node: <SignalExecutionChart prices={allPrices} ticker={data.ticker} /> },
                    ],
                  },
                  {
                    group: "前夜米国 → 当日日中 スピルオーバー",
                    items: [
                      { id: "cal-us-driver", title: "支配ドライバ指数の特定 と 乖離日分析", node: <UsDriverChart ticker={data.ticker} /> },
                      { id: "cal-us-beta", title: "前夜米国 → 当日スピルオーバーβ（ギャップ織り込み分解）", node: <UsBetaChart ticker={data.ticker} /> },
                      { id: "cal-us-path", title: "前夜米国ビン × 当日日内 平均累積パス", node: <UsPathChart ticker={data.ticker} /> },
                      { id: "cal-us-absorption", title: "前夜米国の織り込み速度と日中の反転確率", node: <UsAbsorptionChart ticker={data.ticker} /> },
                      { id: "cal-us-leadlag", title: "前夜米国 → 日中相関の減衰（米国の記憶は何時まで効くか）", node: <UsLeadLagChart ticker={data.ticker} /> },
                      { id: "cal-us-vol", title: "ボラティリティ・スピルオーバー（米国の荒れ → 当日の荒れ）", node: <UsVolSpilloverChart ticker={data.ticker} /> },
                      { id: "cal-us-timing", title: "米国方向別 最適エントリー/エグジット時刻スキャン", node: <UsTimingEdgeChart ticker={data.ticker} /> },
                    ],
                  },
                  {
                    group: "消化時間エッジ（保有期間・消化境界・イベント時間）",
                    items: [
                      { id: "cal-us-holding", title: "米国方向別 保有期間の最適化（IR×Δ / MFE・MAE）", node: <UsHoldingPeriodChart ticker={data.ticker} /> },
                      { id: "cal-us-digestion", title: "消化完了点(τ)とレジーム反転・反転ハザード", node: <UsDigestionBoundaryChart ticker={data.ticker} /> },
                      { id: "cal-us-eventtime", title: "消化イベント時間分析（進捗率軸のエッジ / 消化速度層別）", node: <UsEventTimeChart ticker={data.ticker} /> },
                    ],
                  },
                  ]}
                />
              )}

              {activeSection === "simulation" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      group: "売買シミュレーション・予測",
                      items: [
                        { id: "sim-custom-return", title: "カスタム売買タイミング累積リターン", node: <CustomReturnChart prices={allPrices} ticker={data.ticker} /> },
                        { id: "sim-analog", title: "ヒストリカル・アナログ（類似局面検索）", node: <HistoricalAnalogChart prices={filteredPrices} /> },
                        { id: "sim-regime-cluster", title: "特徴量クラスタリングによるレジーム分類（k-means）", node: <RegimeClusteringChart prices={filteredPrices} /> },
                        { id: "sim-multivar-simplex", title: "多変量埋め込みでの近傍予測（multivariate simplex）", node: <MultivarSimplexChart prices={filteredPrices} /> },
                        { id: "sim-forecast", title: "株価予測シミュレーター（モンテカルロ）", node: <PriceForecastChart prices={filteredPrices} /> },
                        { id: "sim-backtest", title: "シンプルバックテスト", node: <SimpleBacktestChart prices={filteredPrices} /> },
                        { id: "sim-vol-target", title: "ボラティリティ・ターゲティング（信用レバ可変） vs バイ&ホールド 統計検定", node: <VolTargetingChart prices={allPrices} /> },
                      ],
                    },
                    {
                      group: "時系列モデル",
                      items: [
                        { id: "sa-sim-meanrev", title: "平均回帰（Ornstein-Uhlenbeck）", node: <MeanReversionChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "sa-sim-arima", title: "SARIMA モデル（予測・診断）", node: <ArimaChart prices={filteredPrices} seriesMode={seriesMode} /> },
                      ],
                    },
                    {
                      group: "資金管理・頑健性",
                      items: [
                        { id: "sim-stop-compare", title: "ストップ方式の比較（固定%/ATR/シャンデリア/トレーリング）", node: <StopComparisonChart prices={filteredPrices} /> },
                        { id: "sim-rmultiple", title: "トレード期待値・R倍数分布", node: <RMultipleChart prices={filteredPrices} /> },
                        { id: "sim-block-boot", title: "ブロック・ブートストラップでの頑健性", node: <BlockBootstrapChart prices={filteredPrices} /> },
                        { id: "sim-kelly", title: "ケリー基準・最適f とサイズ曲線", node: <KellyChart prices={filteredPrices} /> },
                      ],
                    },
                    {
                      group: "確率過程モデル",
                      items: [
                        { id: "sim-jump", title: "Merton ジャンプ拡散モデル", node: <JumpDiffusionChart prices={filteredPrices} /> },
                        { id: "sim-optstop", title: "最適停止問題：閾値の理論解", node: <OptimalStoppingChart prices={filteredPrices} /> },
                        { id: "sim-vg", title: "Variance Gamma 過程", node: <VarianceGammaChart prices={filteredPrices} /> },
                        { id: "sim-fbm", title: "分数ブラウン運動（fBM）", node: <FBMChart prices={filteredPrices} /> },
                      ],
                    },
                  ]}
                />
              )}

              {activeSection === "discretionary" && (
                <DiscretionaryLab
                  prices={allPrices}
                  ticker={data.ticker}
                  currency={data.currency}
                />
              )}

              {activeSection === "quantum" && (
                <AccordionSection
                  bulk={sectionBulk}
                  onBulk={bumpBulk}
                  groups={[
                    {
                      items: [
                        { id: "quantum-propagator", title: "価格伝播関数（プロパゲータ）", node: <PropagatorChart prices={filteredPrices} /> },
                        { id: "quantum-pathintegral", title: "経路積分シミュレーション", node: <PathIntegralChart prices={filteredPrices} /> },
                        { id: "quantum-dmd", title: "動的モード分解（DMD）", node: <DMDChart prices={filteredPrices} seriesMode={seriesMode} /> },
                        { id: "quantum-decoherence", title: "デコヒーレンス分析", node: <DecoherenceChart prices={filteredPrices} /> },
                        { id: "quantum-markettime", title: "市場時間の再定義", node: <MarketTimeChart prices={filteredPrices} /> },
                        { id: "quantum-density", title: "密度行列分析", node: <DensityMatrixChart prices={filteredPrices} /> },
                      ],
                    },
                  ]}
                />
              )}
              </div>
            </AnalysisAvailabilityProvider>
          </>
        )}

        {restored && !data && !loading && !error && (
          <div className="py-12">
            <div className="max-w-4xl mx-auto">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 text-sm">
                {SECTIONS.map(({ key, label, method, description }) => (
                  <div key={key} className="p-3 rounded-lg border border-gray-200">
                    <div className="font-medium text-gray-700 mb-0.5">{label}</div>
                    <div className="text-xs text-gray-500 mb-1">{method}</div>
                    <div className="text-xs text-gray-500">{description}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="text-center text-xs text-gray-500 py-8 space-y-1">
        <p>株価データはYahoo Financeより取得。投資判断の参考としてご利用ください。</p>
        <p>
          <Link href="/guide" className="text-blue-500 hover:text-blue-600 underline">
            分析手法の数式・読み方はこちら
          </Link>
          <span aria-hidden="true"> ・ </span>
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
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-bold text-gray-800">
        {value}
      </div>
    </div>
  );
}
