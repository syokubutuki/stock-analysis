"use client";

import { useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { runsTest, bdsTest } from "../../lib/distribution-extended";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

function pFmt(p: number): string {
  if (p < 0.001) return "<0.001";
  return p.toFixed(4);
}

export default function IndependenceTestsChart({ prices, seriesMode }: Props) {
  const { values: lr } = extractSeries(prices, seriesMode);

  const runs = useMemo(() => runsTest(lr), [prices, seriesMode]);
  const bds = useMemo(() => bdsTest(lr, 5), [prices, seriesMode]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">独立性・ランダム性検定</h3>

      {/* Runs検定 */}
      <div>
        <div className="text-xs text-gray-500 font-medium mb-2">Runs検定 (連の検定)</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">実際の連の数</div>
            <div className="font-mono font-medium">{runs.nRuns}</div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">期待連数 (H₀下)</div>
            <div className="font-mono font-medium">{runs.expectedRuns.toFixed(1)}</div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">Z統計量</div>
            <div className={`font-mono font-medium ${Math.abs(runs.zStatistic) > 1.96 ? "text-red-600" : ""}`}>
              {runs.zStatistic.toFixed(3)}
            </div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">p値</div>
            <div className={`font-mono font-medium ${runs.pValue < 0.05 ? "text-red-600" : "text-green-600"}`}>
              {pFmt(runs.pValue)}
            </div>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">正の値の数 / 負の値の数</div>
            <div className="font-mono">{runs.nPositive} / {runs.nNegative}</div>
          </div>
          <div className={`p-2 rounded ${runs.pValue < 0.05 ? "bg-red-50" : "bg-green-50"}`}>
            <div className="text-gray-500">判定</div>
            <div className={`font-mono font-medium ${runs.pValue < 0.05 ? "text-red-600" : "text-green-600"}`}>
              {runs.interpretation}
            </div>
          </div>
        </div>
      </div>

      {/* BDS検定 */}
      <div>
        <div className="text-xs text-gray-500 font-medium mb-2">BDS検定 (iid性の検定, ε={bds.epsilon.toFixed(6)})</div>
        {bds.dimensions.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="py-1 px-2 text-left text-gray-500 font-medium">埋め込み次元 m</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">BDS統計量</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">Z統計量</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">p値</th>
                  <th className="py-1 px-2 text-center text-gray-500 font-medium">判定</th>
                </tr>
              </thead>
              <tbody>
                {bds.dimensions.map(d => (
                  <tr key={d.m} className="border-b border-gray-100">
                    <td className="py-1 px-2 text-gray-600 font-medium">m = {d.m}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-600">{d.bds.toFixed(6)}</td>
                    <td className={`py-1 px-2 text-center font-mono ${Math.abs(d.zStat) > 1.96 ? "text-red-600 font-medium" : "text-gray-600"}`}>
                      {d.zStat.toFixed(3)}
                    </td>
                    <td className={`py-1 px-2 text-center font-mono ${d.pValue < 0.05 ? "text-red-600 font-medium" : "text-green-600"}`}>
                      {pFmt(d.pValue)}
                    </td>
                    <td className={`py-1 px-2 text-center ${d.pValue < 0.05 ? "text-red-600" : "text-green-600"}`}>
                      {d.pValue < 0.05 ? "iid棄却" : "棄却せず"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-xs text-gray-400 p-2">データが不足しています (最低50データポイント必要)</div>
        )}
      </div>

      {/* 総合判定 */}
      <div className="p-3 bg-blue-50 rounded text-xs text-gray-700">
        <div className="font-medium text-blue-800 mb-1">総合判定</div>
        <ul className="space-y-1">
          <li>
            Runs検定: {runs.pValue < 0.05
              ? `ランダム性が棄却 (p=${pFmt(runs.pValue)})。${runs.nRuns < runs.expectedRuns ? "連が少なく、トレンド持続（モメンタム）の兆候。" : "連が多く、反転傾向（ミーンリバージョン）の兆候。"}`
              : `ランダム性を棄却できない (p=${pFmt(runs.pValue)})。符号の並びは統計的にランダム。`}
          </li>
          <li>
            BDS検定: {bds.dimensions.some(d => d.pValue < 0.05)
              ? `iid性が棄却。${bds.dimensions.filter(d => d.pValue < 0.05).length}/${bds.dimensions.length}の次元で有意。何らかの依存構造（線形or非線形）が存在。`
              : bds.dimensions.length > 0
                ? "iid性を棄却できない。データは独立同一分布に近い。"
                : "データ不足で検定不可。"}
          </li>
          {runs.pValue >= 0.05 && bds.dimensions.some(d => d.pValue < 0.05) && (
            <li className="text-purple-700 font-medium">
              Runs検定は非有意だがBDSは有意 → 符号の並びはランダムだが、変動の大きさに依存構造がある（ボラティリティクラスタリングの可能性大）。
            </li>
          )}
        </ul>
      </div>

      <AnalysisGuide title="独立性・ランダム性検定の詳細理論">
        <p className="font-medium text-gray-700">1. Runs検定（Wald-Wolfowitz検定）</p>
        <p>Runs検定は系列の「連（run）」の数からランダム性を検定するノンパラメトリック手法です。連とは、同じ符号の値が連続する部分列です。例えば系列 (+,+,-,+,-,-,-) には4つの連があります。</p>
        <p>帰無仮説 H₀: 「系列はランダムに生成されている」のもとで、連の数Rの期待値と分散は:</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"E[R] = 1 + 2n₊n₋/n（ここで n₊ = 正の値の数、n₋ = 負の値の数、n = 全体）"}</li>
          <li>{"Var[R] = 2n₊n₋(2n₊n₋ - n) / (n²(n-1))"}</li>
          <li>{"Z = (R - E[R]) / √Var[R] は漸近的に標準正規分布に従う"}</li>
        </ul>
        <p>連が少なすぎる場合（Z &lt; 0）は同じ符号が連続しやすい（トレンド持続/モメンタム）、連が多すぎる場合（Z &gt; 0）は符号が交互に変わりやすい（ミーンリバージョン）を示唆します。</p>
        <p>ACFとの違い: Runs検定は符号のみを使い、値の大きさを無視するノンパラメトリック手法です。ACFは値の大きさも考慮する線形相関の測定です。Runs検定は外れ値に頑健で、符号レベルの規則性（勝ち負けのパターン）を直接検出します。</p>

        <p className="font-medium text-gray-700 mt-3">2. BDS検定（Brock-Dechert-Scheinkman検定）</p>
        <p>BDS検定は時系列がiid（独立同一分布）であるかを検定します。線形・非線形の両方の依存構造を検出できる強力な検定です。</p>
        <p>{"相関積分 C_m(ε) = (2/(n_m(n_m-1))) Σ I(||x_i^m - x_j^m|| < ε) を定義します。ここで x_i^m = (x_i, x_{i+1}, ..., x_{i+m-1}) はm次元埋め込みベクトルです。"}</p>
        <p>{"iidのもとでは C_m(ε) = C_1(ε)^m が成立します。BDS統計量はこの差を正規化したものです:"}</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"BDS_m = C_m(ε) - C_1(ε)^m"}</li>
          <li>{"W_m = √n × BDS_m / σ_m は漸近的に N(0,1) に従う"}</li>
          <li>εの選択: 標準偏差の0.5~1.5倍が一般的。ここでは0.75σを使用</li>
          <li>mの選択: m = 2~5を検定。大きいmほど高次の依存構造を検出できるが、検出力は低下</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">BDS検定の解釈の注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>BDSが有意 → iidが棄却。ただし「何が原因か」は特定しない（線形相関、ARCH効果、構造変化など）</li>
          <li>GARCHフィルタリング後の残差にBDSを適用 → GARCHで捉えられない追加の非線形依存の有無を検証</li>
          <li>Runs検定は非有意だがBDSは有意 → 符号はランダムだが大きさに依存構造あり。典型的にはボラティリティクラスタリング</li>
          <li>Runs検定もBDSも非有意 → 系列は（少なくとも統計的に検出可能な範囲で）iidに近い</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">実務への示唆</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>iidが棄却されない → リターンの予測は困難。パッシブ運用（インデックス投資）が合理的</li>
          <li>Runs検定のみ有意 → 方向性（符号）に予測可能なパターン。トレンドフォローまたはミーンリバージョン戦略を検討</li>
          <li>BDSのみ有意 → ボラティリティに予測可能なパターン。オプション戦略やボラティリティトレードが有効</li>
          <li>両方有意 → 方向性とボラティリティの両方に予測可能性。包括的な予測モデルを構築する価値がある</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
