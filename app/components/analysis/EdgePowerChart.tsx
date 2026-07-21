"use client";

// 検出力の壁: このエッジは今の標本で「証明」できるか。できないなら時間かブレッドスか、
// それとも横断相関の天井に阻まれて原理的に不能か。t = SR·√T の帰結を正面から扱う。

import { useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { buildEdgeCatalog } from "../../lib/edge-trades";
import {
  computeEdgePower,
  DEFAULT_POWER_PARAMS,
  VERDICT_LABEL,
  type Verdict,
} from "../../lib/edge-power";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const VERDICT_STYLE: Record<Verdict, string> = {
  "provable-now": "bg-green-100 text-green-700 border-green-300",
  "needs-time": "bg-amber-100 text-amber-700 border-amber-300",
  "needs-breadth": "bg-blue-100 text-blue-700 border-blue-300",
  "unprovable-alone": "bg-red-100 text-red-700 border-red-300",
};

function fmtN(v: number): string {
  if (!isFinite(v)) return "∞";
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(0)}k`;
  return Math.round(v).toLocaleString();
}
function fmtYears(v: number): string {
  if (!isFinite(v)) return "∞";
  if (v >= 1000) return `${(v / 1000).toFixed(1)}千年`;
  if (v >= 1) return `${v.toFixed(0)}年`;
  return `${(v * 12).toFixed(0)}ヶ月`;
}
function fmtBreadth(v: number): string {
  if (!isFinite(v)) return "∞";
  return `${Math.ceil(v)}銘柄`;
}

export default function EdgePowerChart({ prices }: Props) {
  const [tStar, setTStar] = useState(DEFAULT_POWER_PARAMS.tStar);
  const [targetMuBp, setTargetMuBp] = useState(DEFAULT_POWER_PARAMS.targetMuBp);
  const [rhoCross, setRhoCross] = useState(DEFAULT_POWER_PARAMS.rhoCross);

  const catalog = useMemo(() => buildEdgeCatalog(prices), [prices]);
  const result = useMemo(
    () => computeEdgePower(prices, catalog, { ...DEFAULT_POWER_PARAMS, tStar, targetMuBp, rhoCross }),
    [prices, catalog, tStar, targetMuBp, rhoCross],
  );

  if (prices.length < 300) {
    return <div className="text-xs text-gray-400 p-3">データが不足しています(300営業日以上必要)。</div>;
  }
  if (!result.ok) {
    return <div className="text-xs text-gray-400 p-3">{result.reason ?? "計算できません。"}</div>;
  }

  const nProvable = result.rows.filter((r) => r.verdict === "provable-now").length;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">検出力の壁 — このエッジは今の標本で証明できるか</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          t = SR·√T。小さいエッジは単一銘柄・10年では原理的に有意化できません。各エッジについて
          「t*に必要な標本・年数・ブレッドス(銘柄数)」を出し、<span className="font-medium">横断相関の天井</span>で
          ブレッドスを増やしても届かない領域を明示します。
        </p>
      </div>

      {/* パラメータ */}
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-1">
          証明の閾値 t*
          <input type="range" min={2} max={5} step={0.5} value={tStar} onChange={(e) => setTStar(Number(e.target.value))} />
          <span className="font-mono w-6">{tStar.toFixed(1)}</span>
        </label>
        <label className="flex items-center gap-1">
          検出したい真エッジ
          <input type="range" min={1} max={30} step={1} value={targetMuBp} onChange={(e) => setTargetMuBp(Number(e.target.value))} />
          <span className="font-mono w-10">{targetMuBp}bp</span>
        </label>
        <label className="flex items-center gap-1">
          横断相関 ρ
          <input type="range" min={0} max={0.7} step={0.05} value={rhoCross} onChange={(e) => setRhoCross(Number(e.target.value))} />
          <span className="font-mono w-8">{rhoCross.toFixed(2)}</span>
        </label>
      </div>

      {/* 総合バナー */}
      <div className={`rounded-lg border p-3 text-sm ${nProvable > 0 ? "bg-green-50 border-green-300" : "bg-amber-50 border-amber-300"}`}>
        <span className="font-medium">現状: </span>
        カタログ{result.rows.length}本のうち<span className="font-bold">{nProvable}本</span>だけが今の標本で t≥{tStar.toFixed(1)} に達しています。
        残りは「まだ小さすぎて証明できない」。{" "}
        {targetMuBp}bp/取引 の真エッジを検出するには、代表エッジ({result.refEdgeLabel})の頻度で
        <span className="font-medium"> {fmtBreadth(result.frontier.find((f) => f.muBp >= targetMuBp)?.breadthReq ?? Infinity)} </span>
        相当のブレッドスが必要です。
      </div>

      {/* エッジ別 検出力テーブル */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 px-1.5">エッジ</th>
              <th className="text-right px-1">μ/取引</th>
              <th className="text-right px-1">年率SR</th>
              <th className="text-right px-1">|t|</th>
              <th className="text-right px-1">MDE</th>
              <th className="text-right px-1.5">t*に必要年数</th>
              <th className="text-right px-1.5">t*に必要銘柄</th>
              <th className="text-right px-1.5">{targetMuBp}bp検出力</th>
              <th className="text-center px-1.5">判定</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r) => (
              <tr key={r.id} className="border-b border-gray-100">
                <td className="py-1 px-1.5">
                  {r.label}
                  <span className={`ml-1 ${r.direction === "long" ? "text-green-600" : "text-red-600"}`}>{r.direction === "long" ? "買" : "売"}</span>
                </td>
                <td className="text-right px-1 font-mono">{r.muBp.toFixed(1)}bp</td>
                <td className="text-right px-1 font-mono">{r.srAnnual.toFixed(2)}</td>
                <td className={`text-right px-1 font-mono ${r.t >= tStar ? "text-green-700 font-bold" : r.t >= 2 ? "text-gray-700" : "text-gray-400"}`}>{r.t.toFixed(1)}</td>
                <td className="text-right px-1 font-mono text-gray-500">{r.mdeBp.toFixed(1)}bp</td>
                <td className="text-right px-1.5 font-mono text-gray-600">{fmtYears(r.yearsReqTStar)}</td>
                <td className={`text-right px-1.5 font-mono ${isFinite(r.breadthReqTStar) ? "text-gray-600" : "text-red-500"}`}>{fmtBreadth(r.breadthReqTStar)}</td>
                <td className={`text-right px-1.5 font-mono ${r.powerAtTarget >= 0.8 ? "text-green-700" : "text-gray-400"}`}>{(r.powerAtTarget * 100).toFixed(0)}%</td>
                <td className="text-center px-1.5">
                  <span className={`inline-block rounded border px-1 py-0.5 text-[10px] ${VERDICT_STYLE[r.verdict]}`}>{VERDICT_LABEL[r.verdict]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[10px] text-gray-400 mt-1">
          MDE=最小検出可能効果(このnで検出力80%になる最小の真エッジ)。μ&lt;MDEなら「見えなくて当然」。
          年数は同じエッジ頻度で標本を伸ばす場合、銘柄は同期間を横断プールする場合(相関ρで目減り)。
        </p>
      </div>

      {/* 検出フロンティア: μ → 必要ブレッドス(天井つき) */}
      <div>
        <div className="text-xs text-gray-600 mb-1">
          検出フロンティア（基準: {result.refEdgeLabel}・相関ρ={rhoCross.toFixed(2)}）
          — 実効標本の天井 n/ρ = {fmtN(result.nCeiling)}取引。これを要する小エッジは何銘柄でも証明不能。
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 px-1.5">目標エッジ</th>
                {result.frontier.map((f) => (
                  <th key={f.muBp} className="text-right px-1">{f.muBp}bp</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-600">必要ブレッドス</td>
                {result.frontier.map((f) => (
                  <td key={f.muBp} className={`text-right px-1 font-mono ${!isFinite(f.breadthReq) ? "text-red-500 font-bold" : f.reachable ? "text-blue-700" : "text-amber-600"}`}>
                    {fmtBreadth(f.breadthReq)}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="py-1 px-1.5 text-gray-600">単独での必要年数</td>
                {result.frontier.map((f) => (
                  <td key={f.muBp} className="text-right px-1 font-mono text-gray-500">{fmtYears(f.yearsReq)}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-gray-400 mt-1">
          青=現実的なブレッドスで到達 / 橙=多数銘柄が必要 / 赤(∞)=横断相関の天井を超え、銘柄をいくら足しても不能。
          これが「本当に小さいエッジは棲息域(クロスセクション)でしか捕まえられない」ことの定量的な根拠です。
        </p>
      </div>

      <AnalysisGuide title="検出力の壁の詳細理論">
        <p className="font-medium text-gray-700">1. なぜ小さいエッジは「証明」できないのか</p>
        <p>
          エッジの有意性は t 統計量で測ります。1取引あたりの効果量を e = μ/σ(平均÷標準偏差)とすると、
          n取引での t は t = e·√n。年率シャープ SR とは t = SR·√T(Tは年数)の関係です。たとえば年率シャープ0.2の
          エッジを t=3 にするには T = (3/0.2)² = 225年ぶんの標本が要ります。だから本当に小さいエッジは、
          単一銘柄・10年という標本では「あるのに見えない」——検出力が足りないのです。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          {"最小検出可能効果 MDE = (z_{1−α/2} + z_{1−β})·σ/√n。観測μがMDE未満なら、真にエッジがあっても有意化しなくて当然です。"}
          {"目標効果 e_t = μ_target/σ を (α, 検出力1−β) で検出する必要標本は n_req = ((z_{1−α/2}+z_{1−β})/e_t)²。"}
          {"観測効果を保ったまま t* に載せるなら n_req = (t*/e)²。"}
        </p>
        <p>
          {"ブレッドス(横断プール): B銘柄を同じ期間プールしても、同じ日は皆まとめて動くため独立標本はB倍になりません。"}
          {"平均相関ρのとき実効標本 n_eff(B) = n·B/(1+(B−1)ρ) で、B→∞ でも n_eff → n/ρ で頭打ち(天井)になります。"}
          {"n_eff(B)=n_req を解くと B = R(1−ρ)/(1−Rρ)(R=n_req/n)。Rρ≥1、つまり n_req > n/ρ のときは、"}
          {"どれだけ銘柄を足しても届きません。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">効果量 e:</span> 1取引あたりのシャープ。μ/σ。小さいほど検出に大量の標本が要る。</li>
          <li><span className="font-medium">検出力(power):</span> 真にエッジがあるとき、それを有意と判定できる確率。慣習で80%を目標にする。</li>
          <li><span className="font-medium">MDE:</span> 今の標本数で検出力80%に届く「最小の本物エッジ」。これ未満は原理的に見えない。</li>
          <li><span className="font-medium">ブレッドスの天井 n/ρ:</span> 横断プールで到達できる実効標本の上限。相関が高いほど低い。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          小さいエッジを聞き取るのは、雑踏(σ)の中の小さな囁き(μ)を聞くようなものです。長く聞けば(T=年数)少しずつ確かになりますが、
          囁きが小さすぎると一生かけても確信できません。そこで「同じ囁きをしている人を大勢(B銘柄)同時に聞く」のが横断プール。
          ただし全員が同じ雑踏(市場全体の動き=相関ρ)に晒されているので、人数を増やしても雑踏は消えず、聞き取れる限界(天井)が残ります。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方と活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">「現時点で証明可」(緑):</span> このエッジは単独で t*に達している。容量・減衰の検証に進んでよい。</li>
          <li><span className="font-medium">「時間で到達可」(橙):</span> 効果量は十分だが標本が足りないだけ。運用しつつ前向き検証台帳で追跡。</li>
          <li><span className="font-medium">「ブレッドスで到達可」(青):</span> 単独では無理だが、必要銘柄数を横断すれば有意化できる。→ クロスセクション分析へ。</li>
          <li><span className="font-medium">「証明不能」(赤):</span> 横断相関の天井を超えており、この設計では原理的に捕まらない。σを下げる(市場中立化)か、別の効果に移る。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>分散既知の正規近似です。厚い裾・自己相関があると実際の検出力はこれより低め(必要標本はさらに多い)。</li>
          <li>横断相関ρは単一のスカラー近似。実際は銘柄対ごとに違い、危機時に1へ跳ねるので天井はさらに低くなり得ます。</li>
          <li>「証明可」は統計的検出力の話で、経済的価値(コスト後・容量内)は別問題。SPA・容量分析と併せて判断してください。</li>
          <li>市場ベータを除いて残差σを下げる(市場中立化)と効果量が上がり、必要標本・ブレッドスが減ります。これがロングショートの検出力上の利点です。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
