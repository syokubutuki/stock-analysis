"use client";

import { useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeStructureScorecard, type StructureScore } from "../../lib/cross-analysis";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

function ScoreBar({ score, color }: { score: number; color: StructureScore["color"] }) {
  const pct = Math.abs(score) * 100;
  const isNeg = score < 0;
  const colorMap = {
    red: "bg-red-500",
    orange: "bg-orange-500",
    green: "bg-green-500",
    blue: "bg-blue-500",
    gray: "bg-gray-400",
  };
  return (
    <div className="relative h-3 bg-gray-100 rounded-full overflow-hidden">
      <div className="absolute inset-0 flex items-center">
        <div className="w-1/2" />
        <div className="w-px h-full bg-gray-300" />
        <div className="w-1/2" />
      </div>
      <div
        className={`absolute top-0 h-full ${colorMap[color]} rounded-full transition-all`}
        style={
          isNeg
            ? { right: "50%", width: `${pct / 2}%` }
            : { left: "50%", width: `${pct / 2}%` }
        }
      />
    </div>
  );
}

function ScoreCard({ s }: { s: StructureScore }) {
  const colorMap = {
    red: "border-red-200 bg-red-50",
    orange: "border-orange-200 bg-orange-50",
    green: "border-green-200 bg-green-50",
    blue: "border-blue-200 bg-blue-50",
    gray: "border-gray-200 bg-gray-50",
  };
  const textMap = {
    red: "text-red-700",
    orange: "text-orange-700",
    green: "text-green-700",
    blue: "text-blue-700",
    gray: "text-gray-600",
  };
  return (
    <div className={`rounded-lg border p-3 ${colorMap[s.color]}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500 font-medium">{s.category}</span>
        <span className={`text-sm font-bold font-mono ${textMap[s.color]}`}>{s.value}</span>
      </div>
      <div className="text-xs text-gray-600 font-medium mb-1.5">{s.label}</div>
      <ScoreBar score={s.score} color={s.color} />
      <div className={`text-xs mt-1.5 ${textMap[s.color]}`}>{s.detail}</div>
    </div>
  );
}

export default function StructureScorecardChart({ prices }: Props) {
  const scores = useMemo(() => computeStructureScorecard(prices), [prices]);

  if (scores.length === 0) {
    return <div className="text-sm text-gray-400 p-4">データが不足しています (最低30日必要)</div>;
  }

  // 総合判定の生成
  const trend = scores.find(s => s.category === "トレンド");
  const vol = scores.find(s => s.category === "ボラティリティ");
  const norm = scores.find(s => s.category === "分布");
  const eff = scores.find(s => s.category === "効率性");
  const hurst = scores.find(s => s.category === "記憶性");
  const sharpe = scores.find(s => s.category === "リスク調整");

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div>
        <h3 className="font-bold text-gray-800">構造スコアカード</h3>
        <p className="text-xs text-gray-500 mt-0.5">全分析セクションの要約を一目で把握</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {scores.map((s, i) => (
          <ScoreCard key={i} s={s} />
        ))}
      </div>

      {/* 総合判定 */}
      <div className="p-3 bg-blue-50 rounded text-xs text-gray-700 space-y-1">
        <div className="font-medium text-blue-800 mb-1">総合判定</div>
        <ul className="space-y-1">
          {trend && vol && (
            <li>
              {trend.score > 0.3
                ? `上昇トレンド中 (年率${trend.value})。`
                : trend.score < -0.3
                ? `下落トレンド中 (年率${trend.value})。`
                : "明確なトレンドなし。"}
              ボラティリティは{vol.value}で
              {vol.color === "red" ? "非常に高い" : vol.color === "orange" ? "中程度" : "低い"}水準。
            </li>
          )}
          {norm && eff && (
            <li>
              リターン分布は{norm.color === "red" ? "正規分布から有意に乖離" : "正規分布に近い"}。
              {eff.color === "green"
                ? "有意な自己相関なし → 短期予測は困難。"
                : eff.detail + "。"}
            </li>
          )}
          {hurst && sharpe && (
            <li>
              {hurst.detail}。
              シャープレシオ{sharpe.value}は
              {sharpe.color === "green" ? "優秀" : sharpe.color === "blue" ? "正" : "負"}。
            </li>
          )}
        </ul>
      </div>

      <AnalysisGuide title="構造スコアカードの詳細理論">
        <p className="font-medium text-gray-700">1. 各指標の意味</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>年率リターン</strong>: 日次対数リターンの平均 x 252。トレンドの方向と強さを示す。</li>
          <li><strong>年率ボラティリティ</strong>: 日次リターンの標準偏差 x sqrt(252)。リスク水準を示す。20%以下は低ボラ、40%超は高ボラ。</li>
          <li><strong>Jarque-Bera検定</strong>: {"JB = (n/6)(S² + K²/4) でS=歪度、K=超過尖度。χ²(2)分布で検定。正規分布からの乖離を測定。"}</li>
          <li><strong>ACF(1)</strong>: {"1次自己相関。|ACF(1)| > 1.96/√n で有意。正=モメンタム、負=ミーンリバージョン、ゼロ近傍=効率的市場。"}</li>
          <li><strong>{"ACF(r², lag1)"}</strong>: 二乗リターンの自己相関。ボラティリティクラスタリング（ARCH効果）の検出。正の値が大きいほどボラティリティが持続する。</li>
          <li><strong>Hurst指数 (R/S法)</strong>: {"H > 0.5: トレンド持続性（長期記憶）、H ≈ 0.5: ランダムウォーク、H < 0.5: 反持続性（ミーンリバージョン）。R/S = (max(累積偏差) - min(累積偏差)) / σ を異なるブロックサイズで計算し、log-log回帰でHを推定。"}</li>
          <li><strong>最大ドローダウン</strong>: 累積リターンのピークからの最大下落幅。過去の最悪シナリオを示す。</li>
          <li><strong>シャープレシオ</strong>: (年率リターン) / (年率ボラティリティ)。リスク1単位当たりのリターン。1超で優秀、0.5超で良好。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">2. スコアバーの読み方</p>
        <p>中央が0（中立）、右が正のスコア、左が負のスコアを示します。色は判定結果を表し、緑=良好、赤=警告、オレンジ=注意、青=特徴的（方向性あり）、灰=中立です。</p>

        <p className="font-medium text-gray-700 mt-3">3. 実務への示唆</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ACF(1)が有意 + Hurst {">"} 0.6 → トレンドフォロー戦略が有効な可能性</li>
          <li>ACF(r²)が高い → ボラティリティ予測モデル（GARCH等）が有効</li>
          <li>JB棄却 + 高尖度 → ファットテールリスクに注意。VaRは過小評価の恐れ</li>
          <li>シャープレシオが負 → 当該期間のバイ&ホールドは不適。別戦略を検討</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
