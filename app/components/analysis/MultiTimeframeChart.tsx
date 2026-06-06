"use client";

import { useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeMultiTimeframe, type TimeframeStats } from "../../lib/multi-timeframe";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; }

function StatCell({ value, fmt, green }: { value: number; fmt: (v: number) => string; green?: boolean }) {
  const color = green === undefined ? "text-gray-700" : value >= 0 ? "text-green-600" : "text-red-600";
  return <td className={`py-1.5 px-2 text-center font-mono ${color}`}>{fmt(value)}</td>;
}

export default function MultiTimeframeChart({ prices }: Props) {
  const result = useMemo(() => computeMultiTimeframe(prices), [prices]);

  if (result.stats.length === 0) return null;

  const pct = (v: number) => (v * 100).toFixed(2) + "%";
  const f3 = (v: number) => v.toFixed(3);
  const f2 = (v: number) => v.toFixed(2);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">マルチタイムフレーム分析</h3>
      <p className="text-xs text-gray-500">日足・週足・月足でのリターン統計を比較。時間集約による構造変化を検出。</p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead><tr className="border-b border-gray-300">
            <th className="py-2 px-2 text-left text-gray-500">時間軸</th>
            <th className="py-2 px-2 text-center text-gray-500">n</th>
            <th className="py-2 px-2 text-center text-gray-500">平均R</th>
            <th className="py-2 px-2 text-center text-gray-500">σ</th>
            <th className="py-2 px-2 text-center text-gray-500">Sharpe</th>
            <th className="py-2 px-2 text-center text-gray-500">歪度</th>
            <th className="py-2 px-2 text-center text-gray-500">尖度</th>
            <th className="py-2 px-2 text-center text-gray-500">Hurst</th>
            <th className="py-2 px-2 text-center text-gray-500">ACF(1)</th>
            <th className="py-2 px-2 text-center text-gray-500">MaxDD</th>
          </tr></thead>
          <tbody>
            {result.stats.map((s, i) => (
              <tr key={i} className={`border-b border-gray-100 ${i === 0 ? "bg-blue-50" : ""}`}>
                <td className="py-1.5 px-2 font-bold text-gray-700">{s.timeframe}</td>
                <td className="py-1.5 px-2 text-center font-mono text-gray-500">{s.n}</td>
                <StatCell value={s.meanReturn} fmt={pct} green />
                <td className="py-1.5 px-2 text-center font-mono text-gray-600">{pct(s.stdReturn)}</td>
                <StatCell value={s.sharpe} fmt={f3} green />
                <td className="py-1.5 px-2 text-center font-mono text-gray-600">{f3(s.skewness)}</td>
                <td className={`py-1.5 px-2 text-center font-mono ${s.kurtosis > 3 ? "text-red-600 font-medium" : "text-gray-600"}`}>{f2(s.kurtosis)}</td>
                <td className={`py-1.5 px-2 text-center font-mono ${s.hurst > 0.55 ? "text-blue-600" : s.hurst < 0.45 ? "text-orange-600" : "text-gray-600"}`}>{f3(s.hurst)}</td>
                <td className={`py-1.5 px-2 text-center font-mono ${Math.abs(s.acf1) > 0.1 ? "text-purple-600 font-medium" : "text-gray-600"}`}>{f3(s.acf1)}</td>
                <td className="py-1.5 px-2 text-center font-mono text-red-600">{pct(s.maxDrawdown)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result.stats.length >= 3 && (() => {
        const daily = result.stats[0];
        const weekly = result.stats[1];
        const monthly = result.stats[2];
        return (
          <div className="p-3 bg-blue-50 rounded text-xs text-gray-700">
            <div className="font-medium text-blue-800 mb-1">タイムフレーム比較の判定</div>
            <ul className="space-y-1">
              <li>
                尖度: 日足{f2(daily.kurtosis)} → 週足{f2(weekly.kurtosis)} → 月足{f2(monthly.kurtosis)}。
                {daily.kurtosis > weekly.kurtosis && weekly.kurtosis > monthly.kurtosis
                  ? "時間集約で尖度が低下 → 日次の極端なリターンは独立で、集約により正規分布に接近（CLTの効果）。"
                  : "時間集約でも尖度が低下しない → リターンの依存構造が強い。"}
              </li>
              <li>
                Hurst: 日足{f3(daily.hurst)} → 週足{f3(weekly.hurst)}。
                {Math.abs(daily.hurst - weekly.hurst) < 0.1
                  ? "時間スケールで安定 → フラクタル的な自己相似性。"
                  : "時間スケールで変化 → 特定のスケールに構造が集中。"}
              </li>
            </ul>
          </div>
        );
      })()}

      <AnalysisGuide title="マルチタイムフレーム分析の詳細理論">
        <p className="font-medium text-gray-700">1. マルチタイムフレーム分析とは</p>
        <p>同じ株価データを異なる時間スケール（日足・週足・月足）で集約し、時間スケールによって統計的性質がどう変化するかを分析する手法です。中心極限定理（CLT）の効果とフラクタル構造を同時に検証できます。</p>
        <p className="mt-1">カメラのズームに例えると、日足は「接写」で細かいノイズまで見え、月足は「引き」で大局的なトレンドが見えます。ズームレベルを変えても同じ模様が見えれば（フラクタル）、市場の構造が全スケールで自己相似であることを意味します。</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"時間集約: r_weekly = Σ_{i∈week} r_daily_i\n\nCLT予測（iid仮定）:\n  分散: σ²_n = n · σ²_1  (nは集約日数)\n  歪度: S_n = S_1 / √n\n  超過尖度: K_n = K_1 / n\n\nHurst安定性検定:\n  H_daily ≈ H_weekly ≈ H_monthly → スケール不変（真のフラクタル）\n  H値がスケールで変化 → マルチフラクタル性"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>n</strong>: 集約日数（週足≈5、月足≈21）</li>
          <li><strong>S_n, K_n</strong>: 集約後の歪度・尖度。iid仮定でのCLT予測値と実測値の差が依存構造を表す</li>
          <li><strong>H</strong>: 各スケールでのHurst指数。スケール間の安定性がフラクタル性の指標</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>中心極限定理（CLT）</strong>: iid（独立同一分布）な確率変数の和は、標本数が増えると正規分布に近づくという定理</li>
          <li><strong>ボラティリティクラスタリング</strong>: 大きな変動の後に大きな変動が続きやすい性質。iid仮定に反する典型的な現象</li>
          <li><strong>マルチフラクタル性</strong>: Hurst指数がスケールによって異なる性質。単一のフラクタル指数では記述できない複雑な構造</li>
          <li><strong>リサンプリング</strong>: 日足データを週足・月足に変換する処理。OHLCVそれぞれに適切な集約方法を適用する</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>尖度がCLT予測より遅く低下</strong>: ボラティリティクラスタリング等の正の依存関係がある。週足・月足でもファットテールが残存</li>
          <li><strong>尖度がCLT予測通りに低下</strong>: リターンが概ねiidに近い。短期的な依存構造が弱い</li>
          <li><strong>Hurstがスケールで安定</strong>: 真のフラクタル過程。どのスケールでも同じトレンド持続性/反持続性が見られる</li>
          <li><strong>Hurstがスケールで変化</strong>: マルチフラクタル性。短期と長期で異なる戦略が必要</li>
          <li><strong>日足ACF(1)≈0だが週足で正</strong>: 日足では見えない低周波モメンタムが存在。スイングトレード向き</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>保有期間の選択</strong>: Hurstが最も0.5から乖離するスケールが、最も予測可能性のある保有期間の目安となる</li>
          <li><strong>戦略の整合性確認</strong>: 短期戦略を採用する場合は日足の統計、中長期なら週足・月足の統計を基にリスク管理すべき</li>
          <li><strong>リスク計算のスケーリング</strong>: iid仮定が成り立たない場合、日次VaR × √nで月次VaRを推定すると過小評価になる</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>サンプル数の減少</strong>: 月足に集約すると標本数が約1/21になり、統計量の信頼性が低下する。最低3年以上のデータが望ましい</li>
          <li><strong>√n則の誤用</strong>: 日次ボラティリティから年次ボラティリティへのスケーリング（×√252）はiid仮定が必要。依存構造がある場合は過小評価になる</li>
          <li><strong>リサンプリングの恣意性</strong>: 週足の開始曜日や月足の区切り方で結果が若干変わる。ISO週基準で統一することが重要</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
