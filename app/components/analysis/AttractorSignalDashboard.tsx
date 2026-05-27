"use client";

import { useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  autoMutualInformation,
  falseNearestNeighbors,
  rollingLyapunov,
  phaseSpaceDensity,
  rollingRQA,
  simplexProjection,
  testNonlinearity,
  generateInvestmentSignals,
  type InvestmentSignal,
  type SignalDirection,
} from "../../lib/attractor-investment";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

const directionStyles: Record<SignalDirection, { bg: string; text: string; icon: string }> = {
  bullish:  { bg: "bg-green-50 border-green-200", text: "text-green-700", icon: "▲" },
  bearish:  { bg: "bg-red-50 border-red-200",     text: "text-red-700",   icon: "▼" },
  caution:  { bg: "bg-amber-50 border-amber-200", text: "text-amber-700", icon: "⚠" },
  neutral:  { bg: "bg-blue-50 border-blue-200",   text: "text-blue-700",  icon: "●" },
};

const strengthBadge: Record<string, string> = {
  strong:   "bg-red-100 text-red-700",
  moderate: "bg-orange-100 text-orange-700",
  weak:     "bg-gray-100 text-gray-600",
  neutral:  "bg-gray-50 text-gray-500",
};

export default function AttractorSignalDashboard({ prices, seriesMode }: Props) {
  const { values, times } = extractSeries(prices, seriesMode);

  const tau = useMemo(() => autoMutualInformation(values, 20).optimalTau, [values]);
  const fnn = useMemo(() => falseNearestNeighbors(values, tau, 8), [values, tau]);
  const dim = fnn.optimalDim;

  const lyap = useMemo(() => rollingLyapunov(values, times, tau, dim, 100), [values, times, tau, dim]);
  const density = useMemo(() => phaseSpaceDensity(values, times, tau, dim), [values, times, tau, dim]);
  const rqa = useMemo(() => rollingRQA(values, times, 100, tau, dim, 3), [values, times, tau, dim]);
  const simplex = useMemo(() => simplexProjection(values, times, tau, dim), [values, times, tau, dim]);
  const nlTest = useMemo(() => testNonlinearity(values, times, tau, dim), [values, times, tau, dim]);

  const signals = useMemo(
    () => generateInvestmentSignals(rqa, lyap, density, simplex, nlTest),
    [rqa, lyap, density, simplex, nlTest]
  );

  // Overall assessment
  const cautionCount = signals.filter(s => s.direction === "caution").length;
  const strongCount = signals.filter(s => s.strength === "strong").length;
  const overallRisk = cautionCount >= 2 || strongCount >= 2 ? "high" : cautionCount >= 1 ? "moderate" : "low";

  const recentLyap = lyap.exponents.length > 0 ? lyap.exponents[lyap.exponents.length - 1] : 0;
  const recentDensity = density.density.length > 0 ? density.density[density.density.length - 1] : 0;
  const recentDet = rqa.data.length > 0 ? rqa.data[rqa.data.length - 1].det : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        アトラクタ投資シグナル統合ダッシュボード
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        非線形動力学の全指標を統合し、投資判断に直結するシグナルを生成
      </p>

      {/* Overall Risk Level */}
      <div className={`mb-4 p-3 rounded-lg border-2 ${
        overallRisk === "high" ? "bg-red-50 border-red-300" :
        overallRisk === "moderate" ? "bg-amber-50 border-amber-300" :
        "bg-green-50 border-green-300"
      }`}>
        <div className="flex items-center gap-3">
          <div className={`text-2xl font-bold ${
            overallRisk === "high" ? "text-red-600" :
            overallRisk === "moderate" ? "text-amber-600" :
            "text-green-600"
          }`}>
            {overallRisk === "high" ? "⚠ HIGH RISK" :
             overallRisk === "moderate" ? "△ MODERATE" :
             "○ LOW RISK"}
          </div>
          <div className="text-xs text-gray-600">
            {overallRisk === "high" && "複数の強いシグナルが注意を促しています。ポジション縮小・リスク管理を優先してください。"}
            {overallRisk === "moderate" && "一部注意シグナルがあります。通常の戦略を継続しつつ注視してください。"}
            {overallRisk === "low" && "特段のリスクシグナルはありません。通常の分析に基づき判断してください。"}
          </div>
        </div>
      </div>

      {/* Key Metrics Grid */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-4 text-xs">
        <div className="p-2 bg-gray-50 rounded text-center">
          <div className="text-gray-400">τ (AMI)</div>
          <div className="font-bold text-lg">{tau}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded text-center">
          <div className="text-gray-400">d (FNN)</div>
          <div className="font-bold text-lg">{dim}</div>
        </div>
        <div className={`p-2 rounded text-center ${recentLyap > 0 ? "bg-red-50" : "bg-green-50"}`}>
          <div className={recentLyap > 0 ? "text-red-500" : "text-green-500"}>λ (Lyapunov)</div>
          <div className="font-bold">{recentLyap.toFixed(3)}</div>
        </div>
        <div className={`p-2 rounded text-center ${recentDensity < 0.3 ? "bg-red-50" : "bg-purple-50"}`}>
          <div className={recentDensity < 0.3 ? "text-red-500" : "text-purple-500"}>密度</div>
          <div className="font-bold">{recentDensity.toFixed(2)}</div>
        </div>
        <div className="p-2 bg-blue-50 rounded text-center">
          <div className="text-blue-500">DET</div>
          <div className="font-bold">{(recentDet * 100).toFixed(0)}%</div>
        </div>
        <div className={`p-2 rounded text-center ${simplex.correlation > 0.3 ? "bg-green-50" : "bg-gray-50"}`}>
          <div className={simplex.correlation > 0.3 ? "text-green-500" : "text-gray-500"}>予測ρ</div>
          <div className="font-bold">{simplex.correlation.toFixed(2)}</div>
        </div>
      </div>

      {/* Signal List */}
      <div className="mb-3">
        <div className="text-sm font-medium text-gray-700 mb-2">投資シグナル一覧</div>
        <div className="space-y-2">
          {signals.length === 0 && (
            <div className="text-xs text-gray-400 p-3 bg-gray-50 rounded">シグナルなし</div>
          )}
          {signals.map((sig, i) => {
            const style = directionStyles[sig.direction];
            return (
              <div key={i} className={`p-3 rounded-lg border ${style.bg} flex items-start gap-3`}>
                <div className={`text-lg ${style.text}`}>{style.icon}</div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`text-xs font-bold ${style.text}`}>{sig.source}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${strengthBadge[sig.strength]}`}>
                      {sig.strength === "strong" ? "強" : sig.strength === "moderate" ? "中" : "弱"}
                    </span>
                  </div>
                  <div className="text-xs text-gray-600">{sig.message}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Strategy Matrix */}
      <div className="mb-3 p-3 bg-gray-50 rounded">
        <div className="text-xs font-medium text-gray-700 mb-2">現在の状態による推奨戦略</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          <div className={`p-2 rounded border ${
            recentLyap <= 0 && recentDensity > 0.5 ? "bg-green-50 border-green-200" : "bg-white border-gray-200 opacity-50"
          }`}>
            <div className="font-medium">安定 × 既知</div>
            <div className="text-gray-500 mt-1">通常のテクニカル分析が有効。トレンドフォローまたは平均回帰を状況に応じて使い分け。</div>
          </div>
          <div className={`p-2 rounded border ${
            recentLyap > 0 && recentDensity > 0.5 ? "bg-orange-50 border-orange-200" : "bg-white border-gray-200 opacity-50"
          }`}>
            <div className="font-medium">不安定 × 既知</div>
            <div className="text-gray-500 mt-1">過去のボラティリティパターンを参照。ストップ幅を拡大し、方向性に注視。</div>
          </div>
          <div className={`p-2 rounded border ${
            recentDensity <= 0.5 ? "bg-red-50 border-red-200" : "bg-white border-gray-200 opacity-50"
          }`}>
            <div className="font-medium">未知の領域</div>
            <div className="text-gray-500 mt-1">過去パターンが無効化。ポジション最小化、リスク管理を最優先。</div>
          </div>
        </div>
      </div>

      <AnalysisGuide title="投資シグナル統合ダッシュボードの解説">
        <div className="space-y-3">
          <div>
            <p className="font-medium text-gray-700 mb-1">統合の仕組み</p>
            <p>本ダッシュボードは、以下の非線形動力学指標を統合して投資判断を支援するシグナルを自動生成します:</p>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li><span className="font-medium">AMI + FNN</span>: 最適パラメータ(τ, d)の自動選択 → 全解析の基盤</li>
              <li><span className="font-medium">ローリングRQA</span>: DET/LAMの急変 → レジーム転換シグナル</li>
              <li><span className="font-medium">局所Lyapunov指数</span>: λの符号遷移 → 安定/不安定の変化</li>
              <li><span className="font-medium">位相空間密度</span>: 既知/未知の判定 → リスク管理レベル</li>
              <li><span className="font-medium">Simplex予測</span>: 予測スキル → 系統的戦略の信頼性</li>
              <li><span className="font-medium">非線形性テスト</span>: θの最適値 → 線形/非線形モデルの選択</li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">リスクレベルの判定基準</p>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li><span className="font-medium text-red-600">HIGH RISK</span>: 「注意」シグナルが2つ以上、または「強」シグナルが2つ以上</li>
              <li><span className="font-medium text-amber-600">MODERATE</span>: 「注意」シグナルが1つ</li>
              <li><span className="font-medium text-green-600">LOW RISK</span>: 「注意」シグナルなし</li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">重要な注意事項</p>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li>本シグナルは<span className="font-medium">参考情報</span>であり、投資の最終判断は他の分析と合わせて総合的に行ってください</li>
              <li>非線形動力学の手法は<span className="font-medium">非定常な金融市場への適用に限界</span>があります</li>
              <li>特に短いデータ({"<"}200日)では統計的信頼性が低下します</li>
              <li>シグナルの「方向」は売買推奨ではなく、<span className="font-medium">市場の力学的状態の診断結果</span>です</li>
            </ul>
          </div>
        </div>
      </AnalysisGuide>
    </div>
  );
}
