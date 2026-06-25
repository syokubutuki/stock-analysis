"use client";

import { useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  scanExecutionEdges,
  EdgeSort,
  EdgeStat,
} from "../../lib/open-close-edge";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const fmtPct1 = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

const SORTS: { value: EdgeSort; label: string }[] = [
  { value: "pAdj", label: "有意性(FDR)" },
  { value: "absT", label: "|t|" },
  { value: "annualized", label: "年率" },
  { value: "sharpe", label: "Sharpe" },
];

function annBg(v: number, maxAbs: number): string {
  const t = maxAbs > 0 ? Math.min(1, Math.abs(v) / maxAbs) : 0;
  if (v >= 0) return `rgba(22, 163, 74, ${0.08 + t * 0.5})`;
  return `rgba(220, 38, 38, ${0.08 + t * 0.5})`;
}

export default function ExecutionTimingScanChart({ prices }: Props) {
  const [sort, setSort] = useState<EdgeSort>("pAdj");

  const result = useMemo(() => {
    if (prices.length < 250) return null;
    return scanExecutionEdges(prices, { sort });
  }, [prices, sort]);

  if (prices.length < 250) return null;
  if (!result || result.stats.length === 0) return null;

  const maxAbsAnn = Math.max(1e-9, ...result.stats.map((s) => Math.abs(s.annualized)));
  const dirJp = (s: EdgeStat) => (s.direction === "long" ? "買い" : "売り");

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">売買時刻スキャン（始値/終値・保有日数の最適エッジ探索）</h3>
        <div className="flex items-center gap-1 text-xs">
          <span className="text-gray-500">並べ替え:</span>
          {SORTS.map((s) => (
            <button
              key={s.value}
              onClick={() => setSort(s.value)}
              className={`px-2 py-0.5 rounded font-medium ${sort === s.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* 現在地サマリー */}
      {result.best ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">
          <span className="font-bold">最も信頼できる時刻エッジ: 「{result.best.def.label}」を{dirJp(result.best)}</span>
          {" → "}1取引平均 <span className="font-bold">{fmtPct(result.best.meanTrade)}</span>、
          年率 <span className="font-bold">{fmtPct1(result.best.annualized)}</span>、
          勝率 {(result.best.winRate * 100).toFixed(0)}%、
          年次プラス率 {(result.best.yearsPositive * 100).toFixed(0)}%（n={result.best.n}）{" "}
          <StatBadge n={result.best.n} p={result.best.pAdj} significant={result.best.significant} />
        </div>
      ) : (
        <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          FDR補正後に有意かつ年次安定なエッジは見つからなかった（＝始値/終値の執行タイミングに頑健な優位性が乏しい）。
        </div>
      )}

      <div className="text-[11px] text-gray-400">
        検定したトレード型 {result.nTested} 種 / 最小取引数 {result.minTrades}。方向は平均の符号で自動選択（買い=ロング, 売り=ショート）。
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 px-2">トレード型</th>
              <th className="text-center px-2">方向</th>
              <th className="text-right px-2">n</th>
              <th className="text-right px-2">1取引平均</th>
              <th className="text-right px-2">年率</th>
              <th className="text-right px-2">Sharpe</th>
              <th className="text-left px-2">勝率</th>
              <th className="text-right px-2">最大DD</th>
              <th className="text-center px-2">年次+</th>
              <th className="text-left px-2">95%CI</th>
              <th className="text-left px-2">有意性</th>
            </tr>
          </thead>
          <tbody>
            {result.stats.map((s) => (
              <tr key={s.def.id} className="border-b border-gray-100">
                <td className="py-1 px-2 font-medium text-gray-700 whitespace-nowrap">{s.def.label}</td>
                <td className="text-center px-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${s.direction === "long" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                    {dirJp(s)}
                  </span>
                </td>
                <td className="text-right px-2 text-gray-600">{s.n}</td>
                <td className="text-right px-2 text-gray-600 tabular-nums">{fmtPct(s.meanTrade)}</td>
                <td className="text-right px-2 font-medium tabular-nums" style={{ background: annBg(s.annualized, maxAbsAnn) }}>
                  {fmtPct1(s.annualized)}
                </td>
                <td className="text-right px-2 text-gray-600 tabular-nums">{s.sharpe.toFixed(2)}</td>
                <td className="px-2">
                  <div className="flex items-center gap-1">
                    <div className="relative h-3 w-12 bg-gray-100 rounded-sm overflow-hidden">
                      <div
                        className={`absolute inset-y-0 left-0 ${s.winRate >= 0.5 ? "bg-green-400" : "bg-red-400"}`}
                        style={{ width: `${s.winRate * 100}%` }}
                      />
                      <div className="absolute inset-y-0 left-1/2 w-px bg-gray-400" />
                    </div>
                    <span className="text-gray-600 tabular-nums">{(s.winRate * 100).toFixed(0)}%</span>
                  </div>
                </td>
                <td className="text-right px-2 text-gray-500 tabular-nums">{fmtPct1(s.maxDD)}</td>
                <td className="text-center px-2 text-gray-500 tabular-nums">
                  {(s.yearsPositive * 100).toFixed(0)}%
                </td>
                <td className="px-2 text-gray-500 whitespace-nowrap tabular-nums">
                  {s.ciLo !== null && s.ciHi !== null ? `${fmtPct(s.ciLo)}〜${fmtPct(s.ciHi)}` : "—"}
                </td>
                <td className="px-2"><StatBadge n={s.n} p={s.pAdj} significant={s.significant} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AnalysisGuide title="売買時刻スキャンの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"日足では1日に約定できる価格は始値(寄り)と終値(引け)の2点しかない。ここから組める基本トレード——日中(寄→引のデイトレ)、夜間(引→翌寄の持ち越し)、引→引/寄→寄/寄→引/引→寄のN日保有——を総当たりし、『どの売買時刻・保有日数に統計的に意味のある優位性(エッジ)があるか』を、偽陽性を抑えながら順位付けする。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>1取引リターン</strong>: r = 出口価格 / 入口価格 − 1。入口・出口は各トレード型の始値/終値。始点 i は1日刻みで全採用（窓は重なる）。</li>
          <li><strong>方向</strong>: 平均の符号で買い(ロング)/売り(ショート)を自動選択し、以降は方向調整後で評価。</li>
          <li><strong>年率</strong>: (1+平均)^(252/保有日数) − 1。同じ型を繰り返し執行した理論値。<strong>Sharpe</strong> = 平均/σ×√(252/保有日数)。</li>
          <li><strong>最大DD</strong>: 重複を除いた非重複サンプル（保有日数刻み）で組んだ累積エクイティの最大ドローダウン。</li>
          <li><strong>有意性</strong>: 平均=0 の1標本t検定 → 全トレード型を Benjamini-Hochberg <strong>FDR</strong> で多重比較補正。pAdj&lt;0.05 を「有意」。</li>
          <li><strong>95%CI / 年次+</strong>: 移動ブロックブートストラップ95%信頼区間（系列相関に頑健、|t|上位のみ）と、各年の平均が正だった年の割合。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>日中(intraday)</strong>: 寄りで買って引けで売る。取引時間中の値動きだけを取る。</li>
          <li><strong>夜間(overnight)</strong>: 引けで買って翌朝の寄りで売る。取引時間外（窓・ギャップ）の値動きを取る。多くの指数で上昇が夜間に集中する「オーバーナイト・ドリフト」が知られる。</li>
          <li><strong>FDR(偽発見率)</strong>: 何十通りも同時に検定すると偶然の「当たり」が紛れ込む。コインを何百回投げれば連勝も出るのと同じ。その偽の当たりの割合を抑える補正。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>上部バナー＝<strong>最も信頼できる型</strong>（有意かつ年次過半数プラス）。まずここを起点に検討。</li>
          <li>「年率が高い」だけでなく<strong>有意バッジが緑</strong>・<strong>年次+が高い</strong>・<strong>CIが0をまたがない</strong>の3点が揃う型を重視。1つでも欠けると過学習を疑う。</li>
          <li>日中が優位＝デイトレ向き／夜間が優位＝引け買い→寄り売りの持ち越し向き。N日保有が優位＝スイング向き。</li>
          <li>保有日数が短い型ほど年間の取引回数が多く、コスト負けしやすい（年率は理論上限）。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>取引コスト・スリッページ未控除</strong>。短い保有・高頻度の型は実際には大きく目減りする。</li>
          <li>窓が重なるため t 値はやや過大評価。CIと年次安定性で補完しているが、過信は禁物。</li>
          <li>始値は寄り付き気配で歪むことがあり、流動性の薄い銘柄では誤差が出る。</li>
          <li>統計的有意≠実用的有意。平均リターンの大きさ（経済的意味）も併せて判断する。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
