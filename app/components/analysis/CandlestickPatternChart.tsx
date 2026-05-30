"use client";

import { useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { detectCandlestickPatterns, type CandlestickPattern } from "../../lib/candlestick-patterns";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; }

export default function CandlestickPatternChart({ prices }: Props) {
  const patterns = useMemo(() => detectCandlestickPatterns(prices), [prices]);

  if (patterns.length === 0) return null;

  const bullish = patterns.filter(p => p.type === "bullish");
  const bearish = patterns.filter(p => p.type === "bearish");
  const neutral = patterns.filter(p => p.type === "neutral");

  const renderTable = (pats: CandlestickPattern[], title: string, color: string) => {
    if (pats.length === 0) return null;
    return (
      <div>
        <div className={`text-xs font-medium mb-1 ${color}`}>{title}</div>
        <table className="w-full text-xs border-collapse">
          <thead><tr className="border-b border-gray-200">
            <th className="py-1 px-2 text-left text-gray-500">パターン</th>
            <th className="py-1 px-2 text-center text-gray-500">検出数</th>
            <th className="py-1 px-2 text-center text-gray-500">1日後R</th>
            <th className="py-1 px-2 text-center text-gray-500">5日後R</th>
            <th className="py-1 px-2 text-center text-gray-500">1日勝率</th>
            <th className="py-1 px-2 text-center text-gray-500">5日勝率</th>
            <th className="py-1 px-2 text-center text-gray-500">t値</th>
            <th className="py-1 px-2 text-center text-gray-500">有意</th>
          </tr></thead>
          <tbody>
            {pats.map(p => (
              <tr key={p.name} className="border-b border-gray-100">
                <td className="py-1 px-2">
                  <div className="font-medium text-gray-700">{p.nameJa}</div>
                  <div className="text-gray-400 text-[10px]">{p.name}</div>
                </td>
                <td className="py-1 px-2 text-center font-mono">{p.stats.count}</td>
                <td className={`py-1 px-2 text-center font-mono ${p.stats.avgReturn1d >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {(p.stats.avgReturn1d * 100).toFixed(3)}%
                </td>
                <td className={`py-1 px-2 text-center font-mono ${p.stats.avgReturn5d >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {(p.stats.avgReturn5d * 100).toFixed(3)}%
                </td>
                <td className={`py-1 px-2 text-center font-mono ${p.stats.winRate1d >= 0.5 ? "text-green-600" : "text-red-600"}`}>
                  {(p.stats.winRate1d * 100).toFixed(0)}%
                </td>
                <td className={`py-1 px-2 text-center font-mono ${p.stats.winRate5d >= 0.5 ? "text-green-600" : "text-red-600"}`}>
                  {(p.stats.winRate5d * 100).toFixed(0)}%
                </td>
                <td className="py-1 px-2 text-center font-mono text-gray-600">{p.stats.tStat.toFixed(2)}</td>
                <td className={`py-1 px-2 text-center font-bold ${p.stats.significant ? "text-green-600" : "text-gray-400"}`}>
                  {p.stats.significant ? "Yes" : "No"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // Find recent patterns (last 20 days)
  const recentDays = 20;
  const startIdx = Math.max(0, prices.length - recentDays);
  const recentPatterns = patterns
    .filter(p => p.indices.some(idx => idx >= startIdx))
    .map(p => ({
      ...p,
      recentIndices: p.indices.filter(idx => idx >= startIdx),
    }))
    .filter(p => p.recentIndices.length > 0);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">ローソク足パターン認識</h3>

      {recentPatterns.length > 0 && (
        <div className="p-3 bg-amber-50 rounded border border-amber-200 text-xs">
          <div className="font-medium text-amber-800 mb-1">直近{recentDays}日で検出されたパターン</div>
          <div className="flex flex-wrap gap-2">
            {recentPatterns.map(p => (
              <span key={p.name} className={`px-2 py-0.5 rounded text-white text-[10px] font-medium ${
                p.type === "bullish" ? "bg-green-500" : p.type === "bearish" ? "bg-red-500" : "bg-gray-500"
              }`}>
                {p.nameJa} ({p.recentIndices.map(i => prices[i]?.time).join(", ")})
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        {renderTable(bullish, "強気パターン (Bullish)", "text-green-700")}
        {renderTable(bearish, "弱気パターン (Bearish)", "text-red-700")}
        {renderTable(neutral, "中立パターン (Neutral)", "text-gray-700")}
      </div>

      <div className="p-3 bg-blue-50 rounded text-xs text-gray-700">
        <div className="font-medium text-blue-800 mb-1">統計的有意性の判定</div>
        <p>{"t値 = mean(return) / (std(return) / √n)。|t| > 1.96 (5%水準) で有意と判定。有意なパターンは過去データにおいて統計的に意味のある予測力を持っていた可能性があります。ただし、サンプル数が少ない場合は信頼性が低いため注意。"}</p>
      </div>

      <AnalysisGuide title="ローソク足パターン認識の詳細理論">
        <p className="font-medium text-gray-700">1. 検出パターン一覧</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ドジ (Doji)</strong>: {"始値≈終値（実体が日中レンジの10%以下）。買い方と売り方の均衡。転換のシグナル。"}</li>
          <li><strong>ハンマー (Hammer)</strong>: 小さな実体が上部、下ヒゲが実体の2倍以上。下落トレンドでの底打ちシグナル。</li>
          <li><strong>流れ星 (Shooting Star)</strong>: 小さな実体が下部、上ヒゲが実体の2倍以上。上昇トレンドでの天井シグナル。</li>
          <li><strong>包み足 (Engulfing)</strong>: 当日の実体が前日の実体を完全に包み込む。強い転換シグナル。</li>
          <li><strong>はらみ足 (Harami)</strong>: 当日の実体が前日の実体に完全に収まる。トレンド弱化のシグナル。</li>
          <li><strong>明けの明星 (Morning Star)</strong>: 大陰線→小実体（ギャップダウン）→大陽線の3本組。底打ちの強い転換シグナル。</li>
          <li><strong>宵の明星 (Evening Star)</strong>: 大陽線→小実体（ギャップアップ）→大陰線の3本組。天井の強い転換シグナル。</li>
          <li><strong>赤三兵 (Three White Soldiers)</strong>: 3本連続の陽線、各足が前の足より高く引ける。強い上昇トレンド。</li>
          <li><strong>黒三兵 (Three Black Crows)</strong>: 3本連続の陰線、各足が前の足より低く引ける。強い下落トレンド。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">2. 有効性の検定</p>
        <p>{"各パターン検出後の1日および5日のフォワードリターンを計算し、t検定で帰無仮説「平均リターン=0」を検定します。t = x̄/(s/√n)、|t|>1.96で5%有意。"}</p>
        <p className="font-medium text-gray-700 mt-3">3. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>パターン認識は主観的な要素がある。閾値の設定で検出数が大きく変わる。</li>
          <li>多重検定問題: 10パターンを同時に検定すると、偶然有意になるリスクがある。Bonferroni補正を考慮すべき。</li>
          <li>市場環境（レジーム）によってパターンの有効性は変化する。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
