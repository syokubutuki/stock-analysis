"use client";

import { useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  scanExecutionEdges,
  EdgeSort,
  EdgeStat,
} from "../../lib/open-close-edge";
import { representativeSpread } from "../../lib/spread-estimator";
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
  // 既定でコストを控除する。RMultipleChart 等は既定オフだが、この表は
  // cadence 1〜21日（年252往復〜年12往復）の型を**同じ順位表に並べる**ので、
  // グロスのままだと高回転の型に systematic な下駄を履かせた比較になる。
  // 実測（8306.T・往復0.30%）で「夜間持ち越し」はグロス +22.5% → ネット −42.1%。
  const [deduct, setDeduct] = useState(true);
  const [feeBps, setFeeBps] = useState(0);

  const spreadRT = useMemo(() => (prices.length < 260 ? 0 : representativeSpread(prices)), [prices]);

  const result = useMemo(() => {
    if (prices.length < 250) return null;
    return scanExecutionEdges(prices, { sort, cost: { enabled: deduct, spreadRT, feeBps } });
  }, [prices, sort, deduct, spreadRT, feeBps]);

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

      {/* コスト操作子。回転率が型ごとに 252倍違うので、既定で控除して並べる */}
      <div className="flex items-center flex-wrap gap-2 text-xs">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={deduct} onChange={(e) => setDeduct(e.target.checked)} />
          <span className="text-gray-700">往復コストを控除する</span>
        </label>
        <span className="text-gray-500">
          代表スプレッド <span className="font-mono">{(spreadRT * 100).toFixed(2)}%</span>（高安から推定）
        </span>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">＋片道手数料</span>
          <input
            type="number"
            min={0}
            step={1}
            value={feeBps}
            onChange={(e) => setFeeBps(Math.max(0, Number(e.target.value)))}
            className="w-14 border border-gray-300 rounded px-1 py-0.5 font-mono"
          />
          <span className="text-gray-500">bps</span>
        </label>
        <span className="text-gray-500">
          → 1往復 <span className="font-mono font-bold">{(result.costRT * 100).toFixed(2)}%</span>
        </span>
      </div>

      {/* コストで消えたエッジの件数。これがこのパネルの主役 */}
      {deduct && result.nFlippedByCost > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 leading-relaxed">
          <strong>コスト控除で {result.nFlippedByCost}/{result.stats.length} 種の期待値が非正に落ちました。</strong>
          落ちたのはほぼ高回転の型です。コストの総額は「1往復あたり × 往復回数」で決まるので、
          年252往復の型（夜間持ち越し・日中デイトレ・1日保有）は 1往復{(result.costRT * 100).toFixed(2)}% でも
          年 <span className="font-mono">−{((1 - Math.pow(1 - result.costRT, 252)) * 100).toFixed(0)}%</span> を払います。
          <strong>グロスの順位は、回転率の違う型を比べる用途には使えません。</strong>
        </div>
      )}

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

      <div className="text-[11px] text-fg-muted">
        検定したトレード型 {result.nTested} 種 / 最小取引数 {result.minTrades}。方向は平均の符号で自動選択（買い=ロング, 売り=ショート）。
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 px-2">トレード型</th>
              <th className="text-center px-2">方向</th>
              <th className="text-right px-2">n</th>
              <th className="text-right px-2" title="年間往復回数 252/cadence">往復/年</th>
              <th className="text-right px-2">1取引平均</th>
              <th className="text-right px-2">年率</th>
              <th className="text-right px-2" title="コストが年率で削った量">うちコスト</th>
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
                <td className="text-right px-2 text-gray-500 tabular-nums">{s.roundTripsPerYear.toFixed(0)}</td>
                <td className="text-right px-2 text-gray-600 tabular-nums">{fmtPct(s.meanTrade)}</td>
                <td className="text-right px-2 font-medium tabular-nums" style={{ background: annBg(s.annualized, maxAbsAnn) }}>
                  {fmtPct1(s.annualized)}
                  {s.flippedByCost && (
                    <span className="ml-1 text-[9px] font-bold text-red-700" title={`コスト控除前は ${fmtPct1(s.grossAnnualized)}`}>
                      消滅
                    </span>
                  )}
                </td>
                <td className="text-right px-2 text-red-700 tabular-nums">
                  {s.costDrag > 0 ? `−${(s.costDrag * 100).toFixed(1)}%` : "—"}
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
                <td className="px-2">
                  {/*
                    コスト控除後は「有意に負ける型」が現れる（両側検定なので大きく負の平均も
                    有意に出る）。StatBadge は有意を緑で描く共有部品なので、そのまま使うと
                    年率 −49% の行に緑の「有意」が並び、推奨に見えてしまう。ここだけ出し分ける。
                  */}
                  {s.significant && s.meanTrade <= 0 ? (
                    <span
                      className="inline-flex items-center gap-1 rounded border border-red-300 bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700"
                      title={`n=${s.n} / p(FDR)=${s.pAdj < 0.001 ? "<0.001" : s.pAdj.toFixed(3)}｜期待値が有意に負`}
                    >
                      有意に負け
                      <span className="opacity-70">p={s.pAdj < 0.001 ? "<.001" : s.pAdj.toFixed(3)}</span>
                    </span>
                  ) : (
                    <StatBadge n={s.n} p={s.pAdj} significant={s.significant} />
                  )}
                </td>
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
          <li>
            保有日数が短い型ほど年間の取引回数が多く、コスト負けしやすい。
            <strong>「往復/年」の列を必ず年率と一緒に読むこと。</strong>
            年252往復の型は 1往復0.3% でも年 −53%、1.0% なら年 −92% を払う。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>往復コストは既定で控除している</strong>（2026-08-31 以降）。控除を有効にすると
            t・p・FDR・CI・Sharpe・最大DD・年次符号の<strong>すべてがネットで再計算される</strong>。
            「エッジがあるか」ではなく「取り出せるエッジがあるか」を検定するため。
            チェックを外せば従来どおりのグロス表示に戻る。
          </li>
          <li>
            コストは高安から推定した代表スプレッド（Corwin-Schultz）で、板情報は使っていない。
            実際の手数料体系が分かるなら片道手数料の欄に入れること。
            <strong>スリッページと市場インパクトは依然として未考慮</strong>なので、
            ここでのネット値もまだ楽観側である。
          </li>
          <li>窓が重なるため t 値はやや過大評価。CIと年次安定性で補完しているが、過信は禁物。</li>
          <li>始値は寄り付き気配で歪むことがあり、流動性の薄い銘柄では誤差が出る。</li>
          <li>統計的有意≠実用的有意。平均リターンの大きさ（経済的意味）も併せて判断する。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
