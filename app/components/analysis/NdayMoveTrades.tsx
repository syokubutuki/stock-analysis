"use client";

// ② 当時の情報だけで実行できる、買いのみの売買検証。

import { useMemo } from "react";
import type { PricePoint } from "../../lib/types";
import type { AnalysisRange, MoveCondition } from "../../lib/nday-move";
import type { CapitalModel, SkipReason, TradeAnalysis } from "../../lib/nday-move-trades";
import NdayMovePriceChart, { type PriceFocus, type PriceMarker } from "./NdayMovePriceChart";
import NdayMoveEquityChart from "./NdayMoveEquityChart";
import { BarHistogram, Notice, StatCard, binValues, num, pctPlain, pctSigned, pctPointsSigned, yen, yenSigned } from "./ndayMoveShared";

interface Props {
  prices: PricePoint[];
  range: AnalysisRange;
  condition: MoveCondition;
  analysis: TradeAnalysis;
  holdDays: number;
  capital: CapitalModel;
  selected: number | null;
  onSelect: (tradeIndex: number) => void;
}

const SKIP_LABEL: Record<SkipReason, string> = {
  holding: "保有中のため無視",
  "entry-no-trade": "翌営業日が約定できない日（出来高0の行）",
  "no-next-bar": "期間末のため翌営業日が無い",
  "insufficient-capital": "資金が1単元に足りない",
  purged: "期間の境界をまたぐため建てない",
};

export default function NdayMoveTrades({ prices, range, condition, analysis: a, holdDays, capital, selected, onSelect }: Props) {
  const sel = selected !== null ? a.trades[selected] ?? null : null;
  // 取引が多いと全期間表示で文字が重なって読めないので、20回を超えたら矢印だけにする（凡例で補う）
  const markers = useMemo<PriceMarker[]>(() => {
    const labeled = a.trades.length <= 20;
    return a.trades.flatMap((t, i) => [
      { id: `t${i}`, index: t.entryIndex, kind: "entry" as const, text: labeled ? "買" : undefined },
      t.status === "closed"
        ? { id: `t${i}`, index: t.exitIndex, kind: "exit" as const, text: labeled ? "売" : undefined }
        : { id: `t${i}`, index: t.exitIndex, kind: "open" as const, text: "未決済" },
    ]);
  }, [a.trades]);
  const focus = useMemo<PriceFocus | null>(() => (sel ? {
    from: sel.signalIndex - condition.lookback,
    to: sel.exitIndex,
    bands: [
      { from: sel.signalIndex - condition.lookback, to: sel.signalIndex, tone: "lookback" },
      { from: sel.entryIndex, to: sel.exitIndex, tone: "holding" },
    ],
    label: `選択: シグナル ${sel.signalDate} → 買い ${sel.entryDate} 寄り → ${sel.status === "closed" ? "売り" : "期末評価"} ${sel.exitDate} 引け（${pctSigned(sel.netReturn)}、費用込み）`,
  } : null), [sel, condition.lookback]);

  if (a.error) return <p role="alert" className="rounded bg-amber-50 p-3 text-sm text-amber-900">{a.error}</p>;
  const s = a.stats;
  const st = a.strategy;
  const bh = a.buyHold;
  const closed = a.trades.filter((t) => t.status === "closed");
  const skippedBy = a.skipped.reduce<Partial<Record<SkipReason, number>>>((acc, x) => ({ ...acc, [x.reason]: (acc[x.reason] ?? 0) + 1 }), {});
  const hist = binValues(closed.map((t) => t.netReturn * 100), 16, (v) => `${v.toFixed(1)}`);
  const zeroAt = hist.bins.length > 0 ? (0 - hist.lo) / hist.width : null;
  const p = a.predictive;
  const placebo = a.placebo;
  const placeboHist = placebo ? binValues(placebo.totals.map((v) => 100 * Math.expm1(v)), 20, (v) => `${v.toFixed(0)}`) : null;

  return (
    <div className="space-y-4">
      <Notice>
        <strong>当時の情報だけで実行できる規則：</strong>t日の終値で条件を判定 → t+1営業日の<strong>始値で買い</strong>（保有1日目）→ 保有{holdDays}日目の<strong>終値で売り</strong>。
        同じ銘柄で建玉は1つ（保有中に出たシグナルは無視）。初期資金{yen(capital.initialCapital)}のうち毎回{capital.allocationPct}%を投入（{capital.lotSize > 0 ? `${capital.lotSize}株単位` : "端数株を許す"}）、待機資金の利息は0%。
        価格は配当・分割の調整後なので<strong>配当込み・税引前</strong>です（配当を別に足すと二重計上になるため足していません。税引後は計算していません）。
      </Notice>
      <NdayMovePriceChart
        prices={prices}
        range={range}
        markers={markers}
        focus={focus}
        onSelect={(id) => { if (id.startsWith("t")) onSelect(Number(id.slice(1))); }}
        ariaLabel={`終値の推移と売買（買い${a.trades.length}回）。${focus ? focus.label : "取引は未選択"}`}
      />
      <p className="text-xs text-gray-600">緑の▲＝買い（翌営業日の寄り）、赤の▼＝売り（保有{holdDays}日目の引け）、灰色の■＝期末に未決済。選んだ取引は青＝判定区間、緑＝保有期間の帯で示します。</p>
      {a.trades.length === 0 ? (
        <p role="status" className="rounded bg-gray-50 p-4 text-sm text-gray-600">この期間には約定した取引がありません（シグナル{a.signals}件）。</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <StatCard label="取引回数" value={`${s.closed}回`} note={`未決済${s.open}件・シグナル${a.signals}件`} />
            <StatCard label="1回の平均 / 中央値（費用込み）" value={`${pctSigned(s.meanNet)} / ${pctSigned(s.medianNet)}`} note={`費用前の平均 ${pctSigned(s.meanGross)}`} />
            <StatCard label="勝率" value={pctPlain(s.winRate)} note={`平均利益 ${pctSigned(s.avgWin)} / 平均損失 ${pctSigned(s.avgLoss)}`} />
            <StatCard label="投資していた期間の割合" value={pctPlain(st?.timeInMarket)} note={`平均保有 ${num(s.meanHoldingBars, 1)}営業日`} />
            <StatCard label="最終資産（戦略）" value={yen(st?.finalValue)} note={`期末清算・年率 ${pctSigned(st?.cagr)}（資産曲線から）`} />
            <StatCard label="最終資産（買い持ち）" value={yen(bh?.finalValue)} note={`同じ日・同じ初期資金・年率 ${pctSigned(bh?.cagr)}`} />
            <StatCard label="最大ドローダウン" value={`${pctPlain(st?.maxDrawdown)} / ${pctPlain(bh?.maxDrawdown)}`} note="戦略 / 買い持ち（時価評価）" />
            <StatCard label="シャープレシオ（年率）" value={`${num(st?.sharpe)} / ${num(bh?.sharpe)}`} note="戦略 / 買い持ち（日次・待機日0）" />
          </div>
          <p className="text-xs text-gray-600">取引1回あたりの平均を年間の回数倍して年率とはしていません。年率は待機期間を含む資産曲線の幾何成長です（{st?.years.toFixed(1)}年）。買い持ちとの差の大半は「市場にいた日数」の差で説明がつくことが多いので、タイミングの価値は下の「無作為タイミング」で測ります。</p>

          <div>
            <h4 className="mb-1 text-sm font-medium">日次の資産曲線（待機資金を含む）</h4>
            <NdayMoveEquityChart points={a.equity} strategyLabel="条件で売買" ariaLabel={`資産曲線。戦略の最終資産${yen(st?.finalValue)}、買い持ち${yen(bh?.finalValue)}。`} />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <h4 className="mb-1 text-sm font-medium">1回ごとの損益の分布（確定取引・費用込み・破線＝0%）</h4>
              <BarHistogram bins={hist.bins.map((b) => ({ ...b, tone: Number(b.label) < 0 ? "down" as const : "up" as const }))} xLabel="1回の損益（%）" description={`確定取引${s.closed}回の損益の分布。平均${pctSigned(s.meanNet)}、中央値${pctSigned(s.medianNet)}、勝率${pctPlain(s.winRate)}。`} marker={zeroAt !== null && zeroAt >= 0 && zeroAt <= hist.bins.length ? { at: zeroAt, label: "0%" } : null} />
            </div>
            <div className="min-w-0 space-y-2 text-xs">
              <h4 className="text-sm font-medium">費用と損益分岐</h4>
              <p>片道の費用 {(a.cost * 100).toFixed(3)}%（手数料＋スリッページ）を、買いと売りのそれぞれに掛けています（1往復で資産×(1−c)²）。買い持ちも期首と期末で1往復分を払います。</p>
              <p>1回の平均が0になる片道費用：<strong>{a.breakEven.tradeOneWayPct === null ? "なし（費用前で既に平均が0以下）" : `${a.breakEven.tradeOneWayPct.toFixed(3)}%`}</strong></p>
              <p>買い持ちと最終資産が並ぶ片道費用：<strong>{a.breakEven.versusBuyHoldOneWayPct === null ? (a.breakEven.note ?? "なし（費用ゼロでも買い持ちに届かない）") : `${a.breakEven.versusBuyHoldOneWayPct.toFixed(3)}%`}</strong></p>
              <p>年間の往復回数（回転率）：{st && st.years > 0 ? (a.trades.length / st.years).toFixed(1) : "—"}回（買い持ちは期間全体で1回）</p>
              <h4 className="pt-2 text-sm font-medium">建てなかったシグナル</h4>
              {a.skipped.length === 0 ? <p>ありません。</p> : <ul className="list-disc pl-4">{Object.entries(skippedBy).map(([k, v]) => <li key={k}>{SKIP_LABEL[k as SkipReason]}：{v}件</li>)}</ul>}
              {a.trades.some((t) => t.exitDelayed) && <p>予定の決済日が約定できない日だったため、次の立会日の終値へ延ばした取引：{a.trades.filter((t) => t.exitDelayed).length}件</p>}
              {a.trades.some((t) => t.suspectFill) && <p>約定日の4本値が同値（値幅制限の張り付きの疑い）の取引：{a.trades.filter((t) => t.suspectFill).length}件。その値で約定できたかは日足では分かりません。</p>}
              {s.open > 0 && <p>期間末に保有中の取引1件は「未決済」として最終日の終値の清算価値で評価し、確定取引の統計には入れていません。</p>}
            </div>
          </div>

          <div>
            <h4 className="mb-1 text-sm font-medium">イベントの予測力：同じ保有日数の「無条件」との比較（資金制約なし）</h4>
            <p className="mb-2 text-xs text-gray-600">シグナルが出た全日（保有中かどうかを問わない）と、期間内の全営業日を起点に、同じく「翌日寄りで買い{holdDays}日目の引けで売る」1回分を比べます。資金制約のある上の戦略成績とは別の物差しです。</p>
            {p ? (
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-right text-xs tabular-nums">
                  <thead><tr className="border-b text-gray-600"><th className="p-2 text-left">起点</th><th className="p-2">件数</th><th className="p-2">平均</th><th className="p-2">中央値</th><th className="p-2">勝率</th></tr></thead>
                  <tbody>
                    <tr className="border-t border-gray-100"><th className="p-2 text-left font-normal">シグナルの日</th><td className="p-2">{p.signal.n}</td><td className="p-2">{pctSigned(p.signal.mean)}</td><td className="p-2">{pctSigned(p.signal.median)}</td><td className="p-2">{pctPlain(p.signal.winRate)}</td></tr>
                    <tr className="border-t border-gray-100"><th className="p-2 text-left font-normal">無条件（全営業日・重なりあり）</th><td className="p-2">{p.unconditional.n}</td><td className="p-2">{pctSigned(p.unconditional.mean)}</td><td className="p-2">{pctSigned(p.unconditional.median)}</td><td className="p-2">{pctPlain(p.unconditional.winRate)}</td></tr>
                    <tr className="border-t border-gray-300 font-medium"><th className="p-2 text-left">差（シグナル − 無条件）</th><td className="p-2" /><td className="p-2">{pctSigned(p.diffMean)}</td><td className="p-2">{pctSigned(p.diffMedian)}</td><td className="p-2" /></tr>
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-gray-700">
                  平均の差の95%区間（営業日の並びを{p.blockLength}日ずつ束ねた移動ブロック・ブートストラップ、{p.draws}回）：
                  <strong>{p.ci95 ? `${pctSigned(p.ci95[0])} 〜 ${pctSigned(p.ci95[1])}` : "件数が足りず計算しない"}</strong>
                  {p.ci95 && (p.ci95[0] <= 0 && p.ci95[1] >= 0 ? " — 0 を含むので、この期間の標本では差を見分けられません。" : " — 0 を含みませんが、ほかの条件も試しているなら偶然でもこの程度は出ます（③を参照）。")}
                </p>
                {p.requiredN !== null && <p className="mt-1 text-xs text-gray-700">この大きさの差を2標準誤差で見分けるのに要るシグナルの数の目安：<strong>{p.requiredN.toLocaleString("ja-JP")}件</strong>（手元 {p.signal.n}件。独立を仮定した下限で、実際はもっと必要）。</p>}
              </div>
            ) : <p className="text-xs text-gray-600">比較できる標本がありません。</p>}
          </div>

          <div>
            <h4 className="mb-1 text-sm font-medium">無作為タイミングとの比較（同じ回数・同じ保有日数・重ならない。破線＝実際の成績）</h4>
            {placebo && placeboHist ? (
              <>
                <BarHistogram
                  bins={placeboHist.bins}
                  xLabel="無作為に建てた場合の累積損益（%、確定取引の複利）"
                  description={`無作為タイミング${placebo.completed}回の累積損益の分布。実際の成績${pctSigned(Math.expm1(placebo.actualTotal))}は下から${pctPlain(placebo.percentile)}の位置。`}
                  marker={{ at: (100 * Math.expm1(placebo.actualTotal) - placeboHist.lo) / placeboHist.width, label: `実際 ${pctSigned(Math.expm1(placebo.actualTotal))}` }}
                />
                <p className="mt-1 text-xs text-gray-700">
                  実際の成績は、建てる日だけを無作為にした{placebo.completed}回のうち<strong>下から{pctPlain(placebo.percentile)}</strong>の位置です
                  （{placebo.trades}回・各{placebo.holdDays}営業日。市場にいた日数を揃えた対照）。
                  95%を超えれば「無作為より良い」、5%を下回れば「無作為より悪い」目安ですが、条件を何通りも試した後の値は割り引いて読んでください。
                </p>
              </>
            ) : <p className="text-xs text-gray-600">確定取引が無いか、期間が短く対照を作れません。</p>}
          </div>

          <details className="rounded border border-gray-200 p-3" open>
            <summary className="cursor-pointer text-xs font-medium">全取引一覧（新しい順・{a.trades.length}件）— 日付を押すと上のチャートで確認できます</summary>
            <div className="mt-2 max-h-80 overflow-auto">
              <table className="w-full whitespace-nowrap text-right text-xs tabular-nums">
                <thead className="sticky top-0 bg-white"><tr className="border-b text-gray-600">
                  <th className="p-2 text-left">シグナル日</th><th className="p-2">{condition.lookback}日騰落</th><th className="p-2">買い（寄り）</th><th className="p-2">売り（引け）</th>
                  <th className="p-2">保有</th><th className="p-2">損益（費用込み）</th><th className="p-2">最大含み損 / 益</th><th className="p-2">損益（円）</th><th className="p-2">状態</th>
                </tr></thead>
                <tbody>{a.trades.map((t, i) => ({ t, i })).reverse().map(({ t, i }) => (
                  <tr key={t.id} className={`border-t border-gray-100 ${selected === i ? "bg-emerald-50" : ""}`}>
                    <td className="p-2 text-left"><button type="button" className="text-blue-700 underline" aria-pressed={selected === i} onClick={() => onSelect(i)}>{t.signalDate}</button></td>
                    <td className="p-2">{pctPointsSigned(t.movePct)}</td>
                    <td className="p-2">{t.entryDate}<span className="block text-[11px] text-gray-500">{t.entryPrice.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}</span></td>
                    <td className="p-2">{t.exitDate}<span className="block text-[11px] text-gray-500">{t.exitPrice.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}</span></td>
                    <td className="p-2">{t.holdingBars}日{t.exitDelayed ? "（延長）" : ""}</td>
                    <td className="p-2">{pctSigned(t.netReturn)}</td>
                    <td className="p-2">{pctSigned(t.maeClose)} / {pctSigned(t.mfeClose)}</td>
                    <td className="p-2">{yenSigned(t.cashIn - t.cashOut)}</td>
                    <td className="p-2">{t.status === "closed" ? "確定" : "未決済（期末評価）"}{t.suspectFill ? "・約定に疑義" : ""}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-gray-500">価格は配当・分割の調整後の値で、当時の板の値段そのものではありません。新しい権利落ちがあると過去の水準が遡って変わります（損益率は変わりません）。最大含み損・益は保有中の終値ベース（日中の安値・高値ではない）。</p>
          </details>
        </>
      )}
    </div>
  );
}
