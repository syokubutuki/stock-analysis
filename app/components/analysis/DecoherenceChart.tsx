"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeDecoherence } from "../../lib/decoherence";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function DecoherenceChart({ prices }: Props) {
  const mainRef = useRef<HTMLDivElement>(null);
  const compRef = useRef<HTMLDivElement>(null);
  const mainChartRef = useRef<IChartApi | null>(null);
  const compChartRef = useRef<IChartApi | null>(null);

  const result = useMemo(() => computeDecoherence(prices), [prices]);

  // Main chart: total coherence line + histogram
  useEffect(() => {
    if (!mainRef.current || result.data.length === 0) return;
    if (mainChartRef.current) mainChartRef.current.remove();

    const chart = createChart(mainRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: mainRef.current.clientWidth,
      height: 250,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    mainChartRef.current = chart;

    // Histogram with per-bar coloring
    const histSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "right",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    histSeries.setData(
      result.data.map((d) => ({
        time: d.time as Time,
        value: d.coherence,
        color:
          d.coherence > 0.5
            ? "#22c55e80"
            : d.coherence > 0.3
              ? "#eab30880"
              : "#ef444480",
      }))
    );

    // Coherence line
    const lineSeries = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      title: "Total Coherence",
      priceScaleId: "right",
    });
    lineSeries.setData(
      result.data.map((d) => ({
        time: d.time as Time,
        value: d.coherence,
      }))
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (mainRef.current)
        chart.applyOptions({ width: mainRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      mainChartRef.current = null;
    };
  }, [result]);

  // Component chart: ACF / Vol / Trend stability
  useEffect(() => {
    if (!compRef.current || result.data.length === 0) return;
    if (compChartRef.current) compChartRef.current.remove();

    const chart = createChart(compRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: compRef.current.clientWidth,
      height: 250,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    compChartRef.current = chart;

    const acfSeries = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 1,
      title: "ACF Stability",
    });
    acfSeries.setData(
      result.data.map((d) => ({
        time: d.time as Time,
        value: d.acfStability,
      }))
    );

    const volSeries = chart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 1,
      title: "Vol Stability",
    });
    volSeries.setData(
      result.data.map((d) => ({
        time: d.time as Time,
        value: d.volStability,
      }))
    );

    const trendSeries = chart.addSeries(LineSeries, {
      color: "#22c55e",
      lineWidth: 1,
      title: "Trend Stability",
    });
    trendSeries.setData(
      result.data.map((d) => ({
        time: d.time as Time,
        value: d.trendStability,
      }))
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (compRef.current)
        chart.applyOptions({ width: compRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      compChartRef.current = null;
    };
  }, [result]);

  const coherenceColor =
    result.currentCoherence > 0.6
      ? "text-green-600"
      : result.currentCoherence > 0.3
        ? "text-yellow-600"
        : "text-red-600";

  const coherenceBg =
    result.currentCoherence > 0.6
      ? "bg-green-50"
      : result.currentCoherence > 0.3
        ? "bg-yellow-50"
        : "bg-red-50";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        デコヒーレンス検出 (パターン崩壊)
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        市場パターンの信頼度推定とパターン崩壊イベントの検知
      </p>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均コヒーレンス</div>
          <div className="font-bold text-lg">
            {result.meanCoherence.toFixed(3)}
          </div>
        </div>
        <div className={`p-2 rounded ${coherenceBg}`}>
          <div className="text-gray-500">現在コヒーレンス</div>
          <div className={`font-bold text-lg ${coherenceColor}`}>
            {result.currentCoherence.toFixed(3)}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">崩壊回数</div>
          <div className="font-bold text-lg text-red-600">
            {result.breakdownCount}
          </div>
        </div>
      </div>

      {/* Main coherence chart */}
      <div className="text-xs text-gray-500 mb-1">
        総合コヒーレンス (0=崩壊, 1=安定)
      </div>
      <div
        ref={mainRef}
        className="w-full rounded border border-gray-100 mb-3"
      />

      {/* Component stability chart */}
      <div className="text-xs text-gray-500 mb-1">
        構成要素の安定性 (紫: ACF / 橙: ボラティリティ / 緑: トレンド)
      </div>
      <div ref={compRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="デコヒーレンス分析の詳細理論">
        <p className="font-medium text-gray-700">1. デコヒーレンスとは</p>
        <p>
          量子力学における「デコヒーレンス」とは、量子系が環境と相互作用することで量子的な重ね合わせ状態が崩壊し、古典的な状態に移行する現象です。
          この概念を金融市場に応用すると、トレンドやレンジといった「市場パターン」が安定して維持されている状態を「コヒーレント」、
          パターンが崩壊して予測不能になる瞬間を「デコヒーレンス」と捉えます。
          日常的な例えでは、「氷が溶けて水になる」ような相転移に似ています。安定した構造(氷=パターン)が外部の変化(温度=市場ショック)によって崩れる瞬間を検出します。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          対数リターン: r_t = ln(P_t / P_{"{t-1}"})
        </p>
        <p>
          (A) ACF安定性: ACF_stability = 1 - min(1, |ACF1_long - ACF1_short| * 3)
          <br />
          ここで ACF1 は lag-1 自己相関係数。長期窓(60日)と短期窓(10日)の ACF1 の差が大きいほど不安定。
        </p>
        <p>
          (B) ボラティリティ安定性: Vol_stability = 1 - min(1, |sigma_short/sigma_long - 1| * 2)
          <br />
          短期ボラティリティと長期ボラティリティの比が1から乖離するほど不安定。
        </p>
        <p>
          (C) トレンド安定性: Trend_stability = sign_match * (1 - |mu_short - mu_long| / sigma_long)
          <br />
          短期・長期の平均リターンの方向一致度と大きさの乖離度を組み合わせ。
        </p>
        <p>
          総合コヒーレンス: C_t = 0.3 * ACF_stability + 0.4 * Vol_stability + 0.3 * Trend_stability
        </p>
        <p>
          崩壊イベント: C_t {"<"} 0.3 かつ C_{"{t-1}"} {">"} 0.5 (急激なコヒーレンス低下)
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 各構成要素の意味</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>ACF安定性 (紫):</strong>{" "}
            自己相関構造が安定しているか。トレンドフォロー型の戦略が機能する前提条件。急変はモメンタム崩壊を意味する。
          </li>
          <li>
            <strong>ボラティリティ安定性 (橙):</strong>{" "}
            ボラティリティレジームが一定か。急変はリスクパリティやオプション戦略のリバランス契機。最も重みが大きい(40%)。
          </li>
          <li>
            <strong>トレンド安定性 (緑):</strong>{" "}
            短期と長期のトレンド方向・強度が一致しているか。乖離はトレンド転換の予兆。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>コヒーレンス 0.6以上 (緑): パターンが安定。既存の戦略を継続してよい</li>
          <li>コヒーレンス 0.3〜0.6 (黄): パターンが不安定化。ポジションサイズの縮小を検討</li>
          <li>コヒーレンス 0.3未満 (赤): パターン崩壊。戦略の一時停止やヘッジを検討</li>
          <li>赤い矢印マーカー: 崩壊イベント発生点。前回安定状態から急激に崩壊した瞬間</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>トレンドフォロー戦略: コヒーレンスが高い時期のみエントリー。崩壊時は手仕舞い</li>
          <li>リスク管理: コヒーレンス低下に応じてポジションサイズを動的調整(Kelly基準の修正)</li>
          <li>レジーム切替: 崩壊イベント後は新しいレジームへの移行を待ってから再エントリー</li>
          <li>ボラティリティ戦略: Vol安定性の低下はオプションのIV上昇の先行指標になりうる</li>
          <li>構成要素の分解: どの要素が崩壊の主因かを特定し、対応する戦略を調整</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>コヒーレンス:</strong> 市場パターンの「一貫性」や「信頼度」を0〜1で表す指標</li>
          <li><strong>デコヒーレンス:</strong> コヒーレンスの崩壊、すなわち既存パターンの破綻</li>
          <li><strong>ACF (自己相関関数):</strong> 時系列データが過去の自分自身とどの程度相関するかの指標</li>
          <li><strong>ボラティリティレジーム:</strong> 変動の大きさ(ボラティリティ)の状態。低ボラ・高ボラなど</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>窓幅(60日/10日)はパラメータであり、銘柄や時間軸に応じて調整が必要</li>
          <li>コヒーレンスは遅行指標であり、崩壊の「検出」はできるが「予測」は困難</li>
          <li>3つの構成要素の重み(0.3/0.4/0.3)は経験的な値であり、最適とは限らない</li>
          <li>急激なギャップダウン/アップでは瞬間的に崩壊検出されるが、すぐ回復する偽陽性がありうる</li>
          <li>量子デコヒーレンスとの類推はあくまでアナロジーであり、市場が量子系であることを意味しない</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
