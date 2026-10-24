"use client";

// ストレス退避規則の横断版（/portfolio `pf-derisk`）— ウォッチリストの各銘柄を、次の立会日の寄りで持つか現金か。
// 計算は app/lib/derisk-cross.ts（純粋関数）→ 1銘柄版と同じ computeDerisk。設計は docs/derisk-rule-design.md §6 P3。
//
// 画面の約束（1銘柄版と同じ）:
//   ・パラメータは研究値固定。横断では編集させない（銘柄ごとに都合のよい設定を選ぶ経路を塞ぐ）
//   ・成績（年率・最大DD）は出さない。横断に並べると「成績の良い銘柄だけ従う」誘惑が生まれ、保険の意味が壊れる
//   ・市場共通の2灯（VIX 比・KRE dd60）は1回だけ見せ、銘柄の行には固有の2灯だけを置く

import { useMemo, useState } from "react";
import Link from "next/link";
import type { PricePoint } from "../../lib/types";
import { RESEARCH_PARAMS, type Light } from "../../lib/derisk-rule";
import { buildDeriskCross, type CrossKind, type DeriskCrossRow } from "../../lib/derisk-cross";
import { useBenchmarkSet } from "../../hooks/useBenchmarkSet";
import { describeSanityReport } from "../../lib/price-sanity";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";

const BENCH = ["^VIX", "KRE"] as const;

interface Props {
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
  /** 保有 or 狙い（effectiveKind）。無ければ狙い扱い */
  kinds?: Record<string, CrossKind>;
}

const pct = (v: number, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : "—");
const num = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const isRatio = (key: Light["key"]) => key === "vixRatio" || key === "volRatio";
const fmtValue = (l: Light) => (isRatio(l.key) ? num(l.value) : pct(l.value));
const fmtThreshold = (l: Light) => (isRatio(l.key) ? `> ${l.threshold.toFixed(2)}` : `< ${pct(l.threshold, 0)}`);
const fmtMargin = (l: Light) => (!Number.isFinite(l.margin) ? "—" : isRatio(l.key) ? `${(l.margin * 100).toFixed(0)}%` : `${(l.margin * 100).toFixed(1)}pt`);
/** 閾値に近い（比率型 10% 未満・下落型 2pt 未満）。1銘柄版と同じ基準。 */
const isNear = (l: Light) => !l.lit && (isRatio(l.key) ? l.margin < 0.1 : l.margin < 0.02);

function LightCell({ l }: { l: Light }) {
  const cls = l.lit ? "bg-red-50 text-red-700" : isNear(l) ? "bg-amber-50 text-amber-700" : "text-gray-700";
  return (
    <td className={`text-right py-1 px-2 font-mono whitespace-nowrap ${cls}`} title={`${fmtThreshold(l)}・余裕 ${fmtMargin(l)}`}>
      {fmtValue(l)}
      <span className="ml-1 text-[10px] text-gray-400">{l.lit ? "点灯" : isNear(l) ? "近い" : fmtMargin(l)}</span>
    </td>
  );
}

function StateBadge({ row }: { row: DeriskCrossRow }) {
  const s = row.state!;
  if (!s.holding) return <span className="inline-block rounded bg-red-600 px-1.5 py-0.5 text-white">現金</span>;
  if (s.stress > 0) return <span className="inline-block rounded bg-amber-500 px-1.5 py-0.5 text-white">保有・警戒</span>;
  return <span className="inline-block rounded bg-emerald-600 px-1.5 py-0.5 text-white">保有</span>;
}

export default function DeriskCrossChart({ tickers, pricesByTicker, names, kinds }: Props) {
  const bench = useBenchmarkSet(BENCH);
  const vix = bench.entries.get("^VIX")?.prices ?? null;
  const kre = bench.entries.get("KRE")?.prices ?? null;
  const [heldOnly, setHeldOnly] = useState(false);

  const res = useMemo(() => {
    if (!vix || !kre) return null;
    const items = tickers
      .filter((t) => (pricesByTicker[t]?.length ?? 0) > 0)
      .map((t) => ({ ticker: t, name: names?.[t] ?? t, kind: kinds?.[t] ?? ("target" as CrossKind), prices: pricesByTicker[t] }));
    return buildDeriskCross(items, vix, kre, RESEARCH_PARAMS);
  }, [tickers, pricesByTicker, names, kinds, vix, kre]);

  const repaired = useMemo(() => {
    const out: string[] = [];
    for (const [t, e] of bench.entries) {
      const msg = describeSanityReport(e.dataQuality);
      if (msg && e.dataQuality && (e.dataQuality.repaired.length > 0 || e.dataQuality.suspects.length > 0)) out.push(`${t}: ${msg}`);
    }
    return out;
  }, [bench.entries]);

  const p = RESEARCH_PARAMS;
  const hasHeld = (res?.summary.held ?? 0) > 0;
  const visible = res ? res.rows.filter((r) => !heldOnly || r.kind === "held") : [];

  return (
    <div className="space-y-3 text-sm">
      <div className="text-xs text-gray-600">
        <p>
          4つのストレス指標のうち <b>{p.kIn}</b> つ以上が点灯したらその日の寄りから全額現金、全指標が <b>{p.calmN}</b> 営業日連続で消灯したら復帰。
          銘柄ごとに独立した状態機械で、パラメータは研究値固定（調整は1銘柄版で）。
          <b>これは保険です</b>: 最大DDを浅くするが年率の上積みは有意でなく、V字型の急落では買い持ちより悪化します。成績はここに出しません（横断で並べると「成績の良い銘柄だけ従う」誘惑が生まれ、保険の意味が壊れるため）。
        </p>
      </div>

      {bench.loading && <p className="text-xs text-gray-500">参照系列（^VIX・KRE）を取得中… {bench.done}/{bench.total}</p>}
      {bench.failed.length > 0 && <p className="text-xs text-red-600">参照系列の取得に失敗: {bench.failed.join("・")}。4灯のうち市場側が計算できません。</p>}

      {res && res.common && (
        <div className="rounded border border-gray-200 bg-gray-50 p-3 text-xs">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-gray-500">判断日</span>
            <span className="font-semibold text-gray-800">{res.nextTime ?? "—"}</span>
            {res.nextTimeDiffers && <span className="text-amber-700">銘柄で判断日が異なります（暦またはデータ最終日の違い。各行の日付を見てください）</span>}
            <span className="text-gray-500">米国データ</span>
            <span className="text-gray-800">
              VIX {res.common.vixAsOf}・KRE {res.common.kreAsOf}
              {res.common.usStale ? "（その日の米国終値は未着。朝6〜7時に更新されます）" : "（最新）"}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
            <span className="text-gray-500">市場共通の2灯（全銘柄で同じ値）</span>
            {[res.common.vix, res.common.kre].map((l) => (
              <span key={l.key} className={l.lit ? "text-red-700 font-semibold" : isNear(l) ? "text-amber-700" : "text-gray-800"}>
                {l.label}: <span className="font-mono">{fmtValue(l)}</span> <span className="text-gray-500">{fmtThreshold(l)}・余裕 {fmtMargin(l)}</span> {l.lit ? "点灯" : isNear(l) ? "閾値に近い" : "消灯"}
              </span>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-gray-800">
            <span>
              {hasHeld ? (
                <>保有 <b>{res.summary.held}</b> 銘柄のうち、現金 <b className={res.summary.heldCash > 0 ? "text-red-700" : ""}>{res.summary.heldCash}</b>・保有で警戒（1灯以上） <b className={res.summary.heldWarn > 0 ? "text-amber-700" : ""}>{res.summary.heldWarn}</b></>
              ) : (
                <>保有銘柄の登録がありません（ウォッチリストの「保有」で登録すると集計が出ます）</>
              )}
            </span>
            <span className="text-gray-600">全 {res.summary.computed}/{res.summary.total} 銘柄: 現金 {res.summary.cash}・警戒 {res.summary.warn}</span>
          </div>
        </div>
      )}

      {repaired.length > 0 && (
        <p className="text-xs text-amber-700">参照系列の修復: {repaired.join(" / ")}</p>
      )}

      {res && (
        <div className="space-y-1">
          {hasHeld && (
            <label className="flex items-center gap-1 text-xs text-gray-600">
              <input type="checkbox" checked={heldOnly} onChange={(e) => setHeldOnly(e.target.checked)} />
              保有銘柄だけ表示
            </label>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse min-w-[720px]">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 pr-2 font-normal">銘柄</th>
                  <th className="text-left py-1 px-2 font-normal">区分</th>
                  <th className="text-left py-1 px-2 font-normal">次の立会日の建玉</th>
                  <th className="text-right py-1 px-2 font-normal">点灯</th>
                  <th className="text-right py-1 px-2 font-normal">5日ボラ ÷ 60日ボラ</th>
                  <th className="text-right py-1 px-2 font-normal">60日高値からの下落</th>
                  <th className="text-right py-1 px-2 font-normal">復帰カウント</th>
                  <th className="text-left py-1 px-2 font-normal">判断日</th>
                  <th className="text-left py-1 pl-2 font-normal">履歴の開始</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const s = r.state;
                  const vol = s?.lights.find((l) => l.key === "volRatio");
                  const dd = s?.lights.find((l) => l.key === "dd60");
                  return (
                    <tr key={r.ticker} className="border-b border-gray-100">
                      <td className="py-1 pr-2 whitespace-nowrap">
                        <Link href={`/?ticker=${encodeURIComponent(r.ticker)}&panel=regime-derisk`} className="text-blue-700 hover:underline" title="1銘柄版（成績・エピソード・頑健性）を開く">
                          {r.name}
                        </Link>
                        <span className="ml-1 text-gray-400 font-mono">{r.ticker}</span>
                        {r.closeOnly && <span className="ml-1 text-amber-700" title="終値のみの系列。4灯は出せるが寄り約定は仮定できない">終値のみ</span>}
                      </td>
                      <td className="py-1 px-2 text-gray-600">{r.kind === "held" ? "保有" : "狙い"}</td>
                      {s ? (
                        <>
                          <td className="py-1 px-2"><StateBadge row={r} /></td>
                          <td className={`text-right py-1 px-2 font-mono ${s.stress >= p.kIn ? "text-red-700" : s.stress > 0 ? "text-amber-700" : "text-gray-700"}`}>{s.stress}/4</td>
                          {vol ? <LightCell l={vol} /> : <td />}
                          {dd ? <LightCell l={dd} /> : <td />}
                          <td className="text-right py-1 px-2 font-mono text-gray-700">{s.holding ? "—" : `${s.calm}/${p.calmN}`}</td>
                          <td className="py-1 px-2 font-mono text-gray-600 whitespace-nowrap">{s.time}{r.isNext ? "" : "（最終行）"}</td>
                          <td className="py-1 pl-2 font-mono text-gray-500 whitespace-nowrap">{r.historyStart ?? "—"}</td>
                        </>
                      ) : (
                        <td colSpan={7} className="py-1 px-2 text-gray-500">計算できません: {r.skipped}</td>
                      )}
                    </tr>
                  );
                })}
                {visible.length === 0 && (
                  <tr><td colSpan={9} className="py-2 text-gray-500">表示する銘柄がありません。</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-500">
            固有2灯のセル: 値と余裕（正＝安全側。比率型は閾値に対する割合、下落型は閾値までの pt）。赤＝点灯、橙＝閾値に近い（翌日点灯しうる）。
            復帰カウントは現金中の連続消灯日数（{p.calmN} で保有に戻る）。状態機械は経路依存なので、履歴の開始日が違えば途中の判定も違いえます。
          </p>
        </div>
      )}

      <AnalysisGuide title="ストレス退避規則（横断）の詳細理論">
        <p className="font-medium text-gray-700">1. 手法の概要</p>
        <p>
          1銘柄版「ストレス退避規則」をウォッチリスト全体に同時に適用し、「明日の寄りでどの銘柄を持ち、どれを現金にするか」を一覧にします。
          4灯のうち VIX 比と米地銀 KRE の下落は市場共通（全銘柄で同じ値）、短期ボラの拡大と自銘柄の60日高値からの下落は銘柄固有です。
          状態機械は銘柄ごとに独立に走ります（ある銘柄の退避が別の銘柄に波及することはありません）。
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          銘柄 i の点灯数 k_i(t) = 1[VIX_t/MA20 &gt; {p.vixRatio}] + 1[σ5_i/σ60_i &gt; {p.volRatio}] + 1[dd60_i &lt; {pct(p.dd60, 0)}] + 1[dd60_KRE &lt; {pct(p.kreDd60, 0)}]。
          状態 w_i(t) ∈ {"{0, 1}"}: 保有中に k_i ≥ {p.kIn} なら現金、現金中に k_i ≤ {p.kOut} が {p.calmN} 日連続で保有。
          指標はすべて前日までの確定値（日本側は t−1 の終値まで、米国側は日付が t より小さい最新の行）。定義の詳細は1銘柄版のガイドにあります。
        </p>
        <p className="font-medium text-gray-700 mt-3">3. 専門用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>市場共通の灯</b>: 全銘柄で同じ値を取る指標（VIX・KRE）。これだけで2灯になると、固有の灯に関係なく全銘柄が現金になります。</li>
          <li><b>固有の灯</b>: 銘柄自身の価格から作る指標（短期ボラ比・60日高値比）。市場が平穏でも、個別材料で2灯点くことがあります。</li>
          <li><b>復帰カウント</b>: 現金中に全指標が消灯した連続営業日数。途中で1灯でも点くと 0 に戻ります。</li>
          <li><b>経路依存</b>: 今日の建玉は過去の判定の積み重ねで決まるので、取得期間が違うと途中の判定が変わりえます。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          建物全体の火災報知器（市場共通）と、各部屋の煙感知器（固有）。建物の警報が鳴れば全員避難、部屋の感知器だけなら、その部屋だけ出ます。
          鳴り止んで5分待ってから戻るのも同じです。
        </p>
        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>表の「次の立会日の建玉」が結論。現金の行は寄りで売り、保有の行は何もしない。警戒（1灯）は翌日に2灯になりうる銘柄。</li>
          <li>市場共通の2灯が両方「点灯」なら、全銘柄が現金になります。1つだけなら、固有の灯が1つ点いた銘柄から順に現金になります。</li>
          <li>余裕が 2pt／10% を切った指標は、翌日の値動き1日で点灯しえます。米国側は朝6〜7時の更新で変わります。</li>
          <li>「判断日」が銘柄で違うときは、暦（東証と海外・投信）かデータ最終日の違いです。各行の日付で確認してください。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>変えるのは各銘柄の建玉 |q_i| の 1/0 だけ。配分（どの銘柄をいくら）はこの表では決めません。</li>
          <li>現金になった銘柄の資金は、同じ規則で「保有」の銘柄に回さない（市場共通の灯が点いているときは全体が危ない状態）。</li>
          <li>信用でレバレッジをかけているなら、保有・警戒の行が多いときは建玉倍率を先に下げる（系C22）。</li>
          <li>毎朝この表を開く運用は続かないので、通知（寄り前ブリーフ）と組み合わせる前提です。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>規則は3メガバンク（2006〜）で設計・検証したもの。銀行以外や海外銘柄では KRE の灯の意味が変わります（米地銀の下落が自銘柄のストレスと無関係なことがある）。</li>
          <li>10年取得では 2008 年を含まず、上昇相場だけの標本では規則は偶然と区別できません（1銘柄版の頑健性を参照）。</li>
          <li>V字型の急落（2024年8月・2026年3月）は逃します。指標が前日確定値である以上、1日で終わる急落は避けられません。</li>
          <li>投信（終値のみ）は4灯を出せますが、寄り約定を仮定できないので成績は意味を持ちません。</li>
          <li>銘柄間の相関は考慮していません。保有銘柄が同じ業種なら、固有の灯も同時に点きやすく、「警戒」が一斉に「現金」に変わりえます。</li>
        </ul>
      </AnalysisGuide>
      <AxiomPlacement corollaryId="C11" />
    </div>
  );
}
