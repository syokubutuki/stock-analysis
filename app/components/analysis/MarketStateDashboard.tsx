"use client";

import { useMemo, useRef, useEffect } from "react";
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
  kalmanFilter3State,
  kalmanSmoother,
  classifyMarketState,
  type MarketRegime,
} from "../../lib/regime";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

const REGIME_COLORS: Record<MarketRegime, string> = {
  uptrend: "#22c55e",
  downtrend: "#ef4444",
  high_volatility: "#f59e0b",
  low_volatility: "#94a3b8",
  accelerating: "#3b82f6",
  decelerating: "#f97316",
};

const REGIME_LABELS: Record<MarketRegime, string> = {
  uptrend: "上昇トレンド",
  downtrend: "下降トレンド",
  high_volatility: "高ボラティリティ",
  low_volatility: "低ボラティリティ",
  accelerating: "加速",
  decelerating: "減速",
};

export default function MarketStateDashboard({ prices, seriesMode }: Props) {
  const priceRef = useRef<HTMLDivElement>(null);
  const velAccRef = useRef<HTMLDivElement>(null);
  const smootherRef = useRef<HTMLDivElement>(null);
  const priceChartRef = useRef<IChartApi | null>(null);
  const velAccChartRef = useRef<IChartApi | null>(null);
  const smootherChartRef = useRef<IChartApi | null>(null);

  const { values, times } = extractSeries(prices, seriesMode);

  const k3 = useMemo(() => kalmanFilter3State(values), [values]);
  const smoother = useMemo(() => kalmanSmoother(values), [values]);
  const marketState = useMemo(() => classifyMarketState(values), [values]);

  const n = values.length;
  const latest = n > 0 ? {
    regime: marketState.regimes[n - 1],
    trend: marketState.trendStrength[n - 1],
    accel: marketState.acceleration[n - 1],
    conf: marketState.confidence[n - 1],
    vol: marketState.volatilityState[n - 1],
  } : null;

  // Price chart with regime background + 3-state Kalman + Smoother
  useEffect(() => {
    if (!priceRef.current || n === 0) return;
    if (priceChartRef.current) priceChartRef.current.remove();

    const chart = createChart(priceRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: priceRef.current.clientWidth,
      height: 300,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    priceChartRef.current = chart;

    // Regime background as histogram at bottom
    const regimeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "regime_bg",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("regime_bg").applyOptions({
      scaleMargins: { top: 0, bottom: 0 },
      visible: false,
    });
    regimeSeries.setData(
      times.map((t, i) => ({
        time: t as Time,
        value: 1,
        color: (REGIME_COLORS[marketState.regimes[i]] || "#94a3b8") + "30",
      }))
    );

    // Original price
    const priceLine = chart.addSeries(LineSeries, {
      color: "#9ca3af",
      lineWidth: 1,
      title: "実価格",
      priceScaleId: "right",
    });
    priceLine.setData(times.map((t, i) => ({ time: t as Time, value: values[i] })));

    // 3-state Kalman filtered price
    const k3Line = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      title: "3状態カルマン",
      priceScaleId: "right",
    });
    k3Line.setData(times.map((t, i) => ({ time: t as Time, value: k3.filteredPrice[i] })));

    // Smoother
    const smoothLine = chart.addSeries(LineSeries, {
      color: "#dc2626",
      lineWidth: 2,
      title: "スムーザー",
      priceScaleId: "right",
    });
    smoothLine.setData(times.map((t, i) => ({ time: t as Time, value: smoother.smoothedPrice[i] })));

    // Smoother bands
    const smoothUpper = chart.addSeries(LineSeries, {
      color: "#fca5a5",
      lineWidth: 1,
      lineStyle: 2,
      priceScaleId: "right",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    smoothUpper.setData(times.map((t, i) => ({ time: t as Time, value: smoother.smoothedUpperBand[i] })));

    const smoothLower = chart.addSeries(LineSeries, {
      color: "#fca5a5",
      lineWidth: 1,
      lineStyle: 2,
      priceScaleId: "right",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    smoothLower.setData(times.map((t, i) => ({ time: t as Time, value: smoother.smoothedLowerBand[i] })));

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (priceRef.current) chart.applyOptions({ width: priceRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); priceChartRef.current = null; };
  }, [values, times, k3, smoother, marketState, n]);

  // Velocity + Acceleration chart
  useEffect(() => {
    if (!velAccRef.current || n === 0) return;
    if (velAccChartRef.current) velAccChartRef.current.remove();

    const chart = createChart(velAccRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: velAccRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true, borderColor: "#3b82f6" },
      leftPriceScale: { visible: true, borderColor: "#f97316" },
      timeScale: { timeVisible: false },
    });
    velAccChartRef.current = chart;

    // Velocity histogram
    const velSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "right",
      title: "速度",
    });
    velSeries.setData(times.map((t, i) => ({
      time: t as Time,
      value: k3.filteredVelocity[i],
      color: k3.filteredVelocity[i] >= 0 ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)",
    })));

    // Acceleration line
    const accSeries = chart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 2,
      title: "加速度",
      priceScaleId: "left",
    });
    accSeries.setData(times.map((t, i) => ({ time: t as Time, value: k3.filteredAcceleration[i] })));

    // Zero line for acceleration
    const zeroLine = chart.addSeries(LineSeries, {
      color: "#d1d5db",
      lineWidth: 1,
      lineStyle: 2,
      priceScaleId: "left",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    zeroLine.setData(times.map((t) => ({ time: t as Time, value: 0 })));

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (velAccRef.current) chart.applyOptions({ width: velAccRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); velAccChartRef.current = null; };
  }, [values, times, k3, n]);

  // Smoother turning points chart
  useEffect(() => {
    if (!smootherRef.current || n === 0) return;
    if (smootherChartRef.current) smootherChartRef.current.remove();

    const chart = createChart(smootherRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: smootherRef.current.clientWidth,
      height: 160,
      rightPriceScale: { visible: true, borderColor: "#dc2626" },
      leftPriceScale: { visible: true, borderColor: "#3b82f6" },
      timeScale: { timeVisible: false },
    });
    smootherChartRef.current = chart;

    // Smoothed velocity
    const sVelSeries = chart.addSeries(LineSeries, {
      color: "#dc2626",
      lineWidth: 2,
      title: "平滑化速度",
      priceScaleId: "right",
    });
    sVelSeries.setData(times.map((t, i) => ({ time: t as Time, value: smoother.smoothedVelocity[i] })));

    // Confidence
    const confSeries = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 1,
      title: "信頼度",
      priceScaleId: "left",
    });
    confSeries.setData(times.map((t, i) => ({ time: t as Time, value: marketState.confidence[i] })));

    // Volatility state
    const volSeries = chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 1,
      title: "ボラ状態",
      priceScaleId: "right",
      lineStyle: 2,
    });
    volSeries.setData(times.map((t, i) => ({ time: t as Time, value: marketState.volatilityState[i] })));

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (smootherRef.current) chart.applyOptions({ width: smootherRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); smootherChartRef.current = null; };
  }, [values, times, smoother, marketState, n]);

  // Score gauge rendering
  const score = marketState.overallScore;
  const scoreColor = score > 30 ? "#22c55e" : score > 0 ? "#86efac" : score > -30 ? "#fbbf24" : "#ef4444";

  // Regime distribution
  const regimeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of marketState.regimes) {
      counts[r] = (counts[r] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([regime, count]) => ({
        regime: regime as MarketRegime,
        count,
        pct: (count / n * 100).toFixed(1),
      }))
      .sort((a, b) => b.count - a.count);
  }, [marketState.regimes, n]);

  // Turning point stats
  const recentTurningPoints = useMemo(() => {
    return smoother.turningPoints.slice(-5).reverse().map(tp => ({
      ...tp,
      time: times[tp.index] || "",
      price: values[tp.index]?.toFixed(0) || "",
    }));
  }, [smoother.turningPoints, times, values]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        市場状態ダッシュボード
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        3状態カルマンフィルタ + スムーザーによる統合的な市場分析
      </p>

      {/* Dashboard cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
        {/* Score gauge */}
        <div className="p-3 bg-gray-50 rounded border border-gray-100 text-center col-span-2 sm:col-span-1">
          <div className="text-[10px] text-gray-400 mb-1">総合スコア</div>
          <div className="text-3xl font-bold" style={{ color: scoreColor }}>
            {score > 0 ? "+" : ""}{score.toFixed(0)}
          </div>
          <div className="text-[10px] text-gray-400 mt-1">-100 〜 +100</div>
        </div>

        {/* Trend */}
        <div className="p-2 bg-gray-50 rounded border border-gray-100">
          <div className="text-[10px] text-gray-400">トレンド強度</div>
          <div className="flex items-center gap-1 mt-1">
            <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, Math.abs((latest?.trend || 0) * 30) + 10)}%`,
                  backgroundColor: (latest?.trend || 0) >= 0 ? "#22c55e" : "#ef4444",
                }}
              />
            </div>
            <span className="text-xs font-bold" style={{ color: (latest?.trend || 0) >= 0 ? "#22c55e" : "#ef4444" }}>
              {(latest?.trend || 0) > 0 ? "+" : ""}{(latest?.trend || 0).toFixed(1)}
            </span>
          </div>
          <div className="text-[10px] text-gray-400 mt-0.5">
            {(latest?.trend || 0) > 1 ? "強い上昇" : (latest?.trend || 0) > 0.3 ? "弱い上昇" : (latest?.trend || 0) > -0.3 ? "横ばい" : (latest?.trend || 0) > -1 ? "弱い下降" : "強い下降"}
          </div>
        </div>

        {/* Acceleration */}
        <div className="p-2 bg-gray-50 rounded border border-gray-100">
          <div className="text-[10px] text-gray-400">加速度</div>
          <div className="flex items-center gap-1 mt-1">
            <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, Math.abs((latest?.accel || 0) * 30) + 10)}%`,
                  backgroundColor: (latest?.accel || 0) >= 0 ? "#3b82f6" : "#f97316",
                }}
              />
            </div>
            <span className="text-xs font-bold" style={{ color: (latest?.accel || 0) >= 0 ? "#3b82f6" : "#f97316" }}>
              {(latest?.accel || 0) > 0 ? "+" : ""}{(latest?.accel || 0).toFixed(1)}
            </span>
          </div>
          <div className="text-[10px] text-gray-400 mt-0.5">
            {(latest?.accel || 0) > 0.5 ? "加速中" : (latest?.accel || 0) > -0.5 ? "安定" : "減速中"}
          </div>
        </div>

        {/* Volatility */}
        <div className="p-2 bg-gray-50 rounded border border-gray-100">
          <div className="text-[10px] text-gray-400">ボラティリティ</div>
          <div className="text-sm font-bold text-gray-700 mt-1">{(latest?.vol || 0).toFixed(2)}</div>
          <div className="text-[10px] text-gray-400 mt-0.5">
            {(latest?.vol || 0) > (marketState.volatilityState.reduce((a, v) => a + v, 0) / n) * 1.5 ? "高い" : "通常"}
          </div>
        </div>

        {/* Regime */}
        <div className="p-2 rounded border border-gray-100" style={{ backgroundColor: latest ? REGIME_COLORS[latest.regime] + "15" : "#f9fafb" }}>
          <div className="text-[10px] text-gray-400">現在のレジーム</div>
          <div className="text-sm font-bold mt-1" style={{ color: latest ? REGIME_COLORS[latest.regime] : "#374151" }}>
            {latest ? REGIME_LABELS[latest.regime] : "—"}
          </div>
          <div className="text-[10px] text-gray-400 mt-0.5">
            信頼度: {((latest?.conf || 0) * 100).toFixed(0)}%
          </div>
        </div>
      </div>

      {/* Interpretation */}
      <div className="bg-blue-50 rounded p-2 mb-3 text-xs">
        <span className="font-medium text-blue-700">判断: </span>
        <span className="text-blue-600">{marketState.interpretation}</span>
      </div>

      {/* Charts */}
      <div className="space-y-3 mb-3">
        <div>
          <div className="text-xs text-gray-500 mb-1">
            価格 + レジーム分類: <span className="text-gray-400">背景色=レジーム</span> /
            <span className="text-blue-500"> 3状態カルマン</span> /
            <span className="text-red-500"> スムーザー</span>
          </div>
          <div ref={priceRef} className="w-full rounded border border-gray-100" />
        </div>

        <div>
          <div className="text-xs text-gray-500 mb-1">
            <span className="text-green-500">速度 (トレンド) [右軸]</span> /
            <span className="text-orange-500"> 加速度 [左軸]</span>
          </div>
          <div ref={velAccRef} className="w-full rounded border border-gray-100" />
        </div>

        <div>
          <div className="text-xs text-gray-500 mb-1">
            <span className="text-red-500">平滑化速度 [右軸]</span> /
            <span className="text-blue-500"> 信頼度 [左軸]</span> /
            <span className="text-yellow-500"> ボラ状態 [右軸]</span>
          </div>
          <div ref={smootherRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      {/* Regime distribution & turning points */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <div className="text-xs">
          <div className="font-medium text-gray-600 mb-1">レジーム分布</div>
          <div className="space-y-1">
            {regimeCounts.map(({ regime, pct }) => (
              <div key={regime} className="flex items-center gap-2">
                <div className="w-3 h-3 rounded" style={{ backgroundColor: REGIME_COLORS[regime] }} />
                <span className="text-gray-600 w-24">{REGIME_LABELS[regime]}</span>
                <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: REGIME_COLORS[regime] }} />
                </div>
                <span className="text-gray-400 w-10 text-right">{pct}%</span>
              </div>
            ))}
          </div>
        </div>
        <div className="text-xs">
          <div className="font-medium text-gray-600 mb-1">直近の転換点 (スムーザー検出)</div>
          {recentTurningPoints.length > 0 ? (
            <div className="space-y-1">
              {recentTurningPoints.map((tp, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className={tp.type === "peak" ? "text-red-500" : "text-green-500"}>
                    {tp.type === "peak" ? "天井" : "底"}
                  </span>
                  <span className="text-gray-500">{tp.time}</span>
                  <span className="text-gray-700 font-medium">{tp.price}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-gray-400">転換点なし</div>
          )}
        </div>
      </div>

      <AnalysisGuide title="市場状態ダッシュボードの詳細理論">
        <div className="space-y-3">
          <div>
            <p className="font-medium text-gray-700 mb-1">1. 3状態カルマンフィルタとは</p>
            <p>状態ベクトルを [価格, 速度, 加速度] の3次元に拡張したカルマンフィルタです。2状態モデル（価格+速度）では捉えられなかった「トレンドの変化率」を加速度として推定します。</p>
            <div className="bg-gray-50 rounded p-2 my-2 font-mono text-xs">
              状態ベクトル: x = [価格, 速度, 加速度]<br/><br/>
              状態遷移行列 F:<br/>
              | 1  1  0.5 |   価格(t) = 価格(t-1) + 速度(t-1) + 0.5*加速度(t-1)<br/>
              | 0  1  1   |   速度(t) = 速度(t-1) + 加速度(t-1)<br/>
              | 0  0  1   |   加速度(t) = 加速度(t-1)<br/><br/>
              観測行列: H = [1, 0, 0]  → 観測できるのは価格だけ
            </div>
            <p>物理学の等加速度運動の方程式 x = x₀ + v₀t + ½at² と同じ構造です。「相場の物理法則」を仮定して、ノイズの中からトレンドの方向・強さ・変化を推定します。</p>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">2. カルマンスムーザー (RTS Smoother)</p>
            <p>通常のカルマンフィルタは「過去→現在」の片方向ですが、スムーザーは「未来の情報」も使って過去の推定を修正します。</p>
            <div className="bg-gray-50 rounded p-2 my-2 font-mono text-xs">
              Rauch-Tung-Striebel (RTS) Smoother:<br/><br/>
              1. Forward pass: 通常のカルマンフィルタ (フィルタリング)<br/>
              2. Backward pass: 未来から過去に遡って推定を修正<br/><br/>
              x_smooth(t) = x_filtered(t) + C_t * (x_smooth(t+1) - x_predicted(t+1))<br/>
              C_t = P_filtered(t) * F&apos; * inv(P_predicted(t+1))
            </div>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li>フィルタより滑らかな推定が得られる</li>
              <li>転換点の検出精度が向上（遅延なし）</li>
              <li>リアルタイム予測には使えないが、事後分析に最適</li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">3. レジーム分類の仕組み</p>
            <p>3状態カルマンの出力（速度・加速度）と適応型カルマンのイノベーションから、市場を6つのレジームに自動分類します。</p>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li><span className="font-medium" style={{color: "#22c55e"}}>上昇トレンド</span>: 速度が正で安定的</li>
              <li><span className="font-medium" style={{color: "#ef4444"}}>下降トレンド</span>: 速度が負で安定的</li>
              <li><span className="font-medium" style={{color: "#3b82f6"}}>加速</span>: トレンドが強まっている（加速度が大きい）</li>
              <li><span className="font-medium" style={{color: "#f97316"}}>減速</span>: トレンドが弱まっている（加速度が負）</li>
              <li><span className="font-medium" style={{color: "#f59e0b"}}>高ボラティリティ</span>: イノベーション分散が大きい</li>
              <li><span className="font-medium" style={{color: "#94a3b8"}}>低ボラティリティ</span>: 方向性なし・レンジ相場</li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">4. 総合スコアの計算</p>
            <div className="bg-gray-50 rounded p-2 my-2 font-mono text-xs">
              rawScore = (トレンド強度 × 60 + 加速度 × 30) × 信頼度<br/>
              totalScore = clamp(rawScore, -100, +100)
            </div>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li>+50以上: 強い買いシグナル</li>
              <li>+20〜+50: 弱い買いシグナル</li>
              <li>-20〜+20: 中立</li>
              <li>-50〜-20: 弱い売りシグナル</li>
              <li>-50以下: 強い売りシグナル</li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">5. 動的ボラティリティ推定</p>
            <p>適応型カルマンフィルタのイノベーション（予測誤差）系列のローリング標準偏差として推定します。GARCHに比べて計算が軽く、状態空間モデルと整合的です。</p>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">6. 投資判断への活用</p>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li>加速度がゼロクロス → トレンド転換のシグナル</li>
              <li>スムーザーの転換点 → 過去の天底を高精度で特定し、パターン学習に活用</li>
              <li>信頼度が低い → カルマンフィルタの予測が不安定 → ポジション縮小</li>
              <li>レジーム×戦略: 上昇加速→モメンタム、低ボラ→平均回帰、高ボラ→リスク管理</li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">7. 注意点</p>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li>スムーザーは未来の情報を使うため、リアルタイムの意思決定には直接使えない（事後分析用）</li>
              <li>状態数が増えるほどモデルの自由度が増えるが、過適合のリスクも高まる</li>
              <li>総合スコアは目安であり、他の分析と組み合わせて判断すべき</li>
              <li>急激な構造変化（ショック）には追従が遅れることがある</li>
            </ul>
          </div>
        </div>
      </AnalysisGuide>
    </div>
  );
}
