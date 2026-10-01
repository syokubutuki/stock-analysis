"use client";

// ① 条件成立後の分布（後から分かった値動きの記述。売買の成績ではない）。

import { useMemo } from "react";
import type { PricePoint } from "../../lib/types";
import type { AnalysisRange, MoveCondition, Quantiles } from "../../lib/nday-move";
import type { DistributionResult, EventPath } from "../../lib/nday-move-paths";
import type { SurvivalDay } from "../../lib/survival";
import { CHART_COLORS, EVENT_WINDOW_COLORS } from "../../lib/chart-colors";
import NdayMovePriceChart, { type PriceFocus, type PriceMarker } from "./NdayMovePriceChart";
import { BarHistogram, Notice, ResponsiveCanvas, StatCard, num, pctPointsSigned, pctPlain } from "./ndayMoveShared";

interface Props {
  prices: PricePoint[];
  range: AnalysisRange;
  condition: MoveCondition;
  result: DistributionResult;
  drawdownPct: number;
  excludeOverlap: boolean;
  benchName: string | null;
  selected: number | null;
  onSelect: (eventIndex: number) => void;
}

function PathsChart({ result, selected }: { result: DistributionResult; selected: number | null }) {
  const H = result.horizon;
  const complete = result.events.filter((e) => e.complete);
  const incomplete = result.events.filter((e) => !e.complete);
  const medoid = result.medoid !== null ? result.events[result.medoid] : null;
  const sel = selected !== null ? result.events[selected] : null;
  const description = `条件成立日を0日目とした終値の騰落率の経路。完全に観測した${complete.length}件と、観測が足りない${incomplete.length}件（破線）。`
    + (result.bands.length === H + 1 ? `日別中央値は${H}日目で${pctPointsSigned(result.bands[H].q50)}、25〜75%帯は${pctPointsSigned(result.bands[H].q25)}〜${pctPointsSigned(result.bands[H].q75)}。` : "")
    + (result.baseline.length === H + 1 ? `無条件（全営業日起点）の${H}日目中央値は${pctPointsSigned(result.baseline[H].q50)}。` : "")
    + (medoid ? `中央値の線に最も近い実在の事例は${medoid.date}。` : "");
  return (
    <ResponsiveCanvas
      height={300}
      description={description}
      deps={[result, selected]}
      draw={(ctx, width, height) => {
        const left = 48, right = 12, top = 16, bottom = 36;
        const plotW = width - left - right;
        const plotH = height - top - bottom;
        const values: number[] = [0];
        for (const b of result.bands) values.push(b.q10, b.q90);
        for (const b of result.baseline) values.push(b.q25, b.q75);
        if (medoid) values.push(...medoid.pathPct);
        if (sel) values.push(...sel.pathPct);
        let lo = Math.min(...values), hi = Math.max(...values);
        const pad = Math.max(0.5, (hi - lo) * 0.12);
        lo -= pad; hi += pad;
        // 目盛りは 1・2・2.5・5 ×10^k の刻みにそろえる
        const raw = (hi - lo) / 5;
        const mag = 10 ** Math.floor(Math.log10(raw));
        const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw) ?? raw;
        lo = Math.floor(lo / step) * step;
        hi = Math.ceil(hi / step) * step;
        const x = (k: number) => left + (plotW * k) / Math.max(1, H);
        const y = (v: number) => top + plotH * (1 - (v - lo) / (hi - lo));
        // 軸・目盛り
        ctx.strokeStyle = CHART_COLORS.grid;
        ctx.fillStyle = CHART_COLORS.ink;
        ctx.textAlign = "right";
        for (let v = lo; v <= hi + step / 2; v += step) {
          ctx.beginPath(); ctx.moveTo(left, y(v)); ctx.lineTo(width - right, y(v)); ctx.stroke();
          ctx.fillText(`${Math.abs(v) < step / 1000 ? "0" : v.toFixed(step < 1 ? 1 : 0)}%`, left - 4, y(v) + 4);
        }
        ctx.textAlign = "center";
        const stride = Math.max(1, Math.ceil(H / 10));
        for (let k = 0; k <= H; k += stride) ctx.fillText(String(k), x(k), height - bottom + 14);
        ctx.fillText("条件成立日からの営業日（0日目＝条件成立日の終値）", left + plotW / 2, height - 6);
        ctx.save();
        ctx.beginPath(); ctx.rect(left, top, plotW, plotH); ctx.clip();
        // 無条件の25〜75%帯と中央値
        if (result.baseline.length === H + 1) {
          ctx.globalAlpha = 0.18;
          ctx.fillStyle = CHART_COLORS.neutral;
          ctx.beginPath();
          result.baseline.forEach((b, k) => (k === 0 ? ctx.moveTo(x(k), y(b.q75)) : ctx.lineTo(x(k), y(b.q75))));
          [...result.baseline].reverse().forEach((b) => ctx.lineTo(x(b.k), y(b.q25)));
          ctx.closePath(); ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = CHART_COLORS.neutral;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          result.baseline.forEach((b, k) => (k === 0 ? ctx.moveTo(x(k), y(b.q50)) : ctx.lineTo(x(k), y(b.q50))));
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // 各事例
        ctx.lineWidth = 1;
        ctx.globalAlpha = complete.length > 60 ? 0.12 : 0.25;
        ctx.strokeStyle = EVENT_WINDOW_COLORS.lookback;
        for (const e of complete) {
          ctx.beginPath();
          e.pathPct.forEach((v, k) => (k === 0 ? ctx.moveTo(x(k), y(v)) : ctx.lineTo(x(k), y(v))));
          ctx.stroke();
        }
        ctx.setLineDash([3, 3]);
        for (const e of incomplete) {
          ctx.beginPath();
          e.pathPct.forEach((v, k) => (k === 0 ? ctx.moveTo(x(k), y(v)) : ctx.lineTo(x(k), y(v))));
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        // 分位帯と中央値
        if (result.bands.length === H + 1) {
          for (const [loKey, hiKey, alpha] of [["q10", "q90", 0.12], ["q25", "q75", 0.2]] as const) {
            ctx.globalAlpha = alpha;
            ctx.fillStyle = EVENT_WINDOW_COLORS.lookback;
            ctx.beginPath();
            result.bands.forEach((b, k) => (k === 0 ? ctx.moveTo(x(k), y(b[hiKey])) : ctx.lineTo(x(k), y(b[hiKey]))));
            [...result.bands].reverse().forEach((b) => ctx.lineTo(x(b.k), y(b[loKey])));
            ctx.closePath(); ctx.fill();
          }
          ctx.globalAlpha = 1;
          ctx.strokeStyle = EVENT_WINDOW_COLORS.lookback;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          result.bands.forEach((b, k) => (k === 0 ? ctx.moveTo(x(k), y(b.q50)) : ctx.lineTo(x(k), y(b.q50))));
          ctx.stroke();
        }
        if (medoid) {
          ctx.strokeStyle = EVENT_WINDOW_COLORS.outcome;
          ctx.lineWidth = 2;
          ctx.beginPath();
          medoid.pathPct.forEach((v, k) => (k === 0 ? ctx.moveTo(x(k), y(v)) : ctx.lineTo(x(k), y(v))));
          ctx.stroke();
        }
        if (sel) {
          ctx.strokeStyle = EVENT_WINDOW_COLORS.followup;
          ctx.lineWidth = 2;
          ctx.setLineDash(sel.complete ? [] : [4, 3]);
          ctx.beginPath();
          sel.pathPct.forEach((v, k) => (k === 0 ? ctx.moveTo(x(k), y(v)) : ctx.lineTo(x(k), y(v))));
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.strokeStyle = CHART_COLORS.reference;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(left, y(0)); ctx.lineTo(width - right, y(0)); ctx.stroke();
        ctx.restore();
      }}
    />
  );
}

function QuantileRow({ label, q, note }: { label: string; q: Quantiles | null; note?: string }) {
  return (
    <tr className="border-t border-gray-100">
      <th className="p-2 text-left font-normal">{label}{note && <span className="block text-[11px] text-gray-500">{note}</span>}</th>
      <td className="p-2">{q ? `${q.n}件` : "—"}</td>
      {(["q10", "q25", "q50", "q75", "q90"] as const).map((k) => <td key={k} className="p-2">{q ? pctPointsSigned(q[k]) : "—"}</td>)}
      <td className="p-2">{q ? pctPointsSigned(q.mean) : "—"}</td>
    </tr>
  );
}

function KmTable({ title, days, horizon, note }: { title: string; days: SurvivalDay[]; horizon: number; note: string }) {
  const milestones = days.filter((d) => [1, 2, 3, 5, 10, 20, horizon].includes(d.day));
  return (
    <div className="min-w-0">
      <h5 className="mb-1 text-xs font-medium text-gray-800">{title}</h5>
      <div className="overflow-x-auto">
        <table className="w-full text-right text-xs tabular-nums">
          <thead><tr className="border-b text-gray-600"><th className="p-1.5 text-left">期限</th><th className="p-1.5">累積の到達確率</th><th className="p-1.5">その日の追跡対象</th></tr></thead>
          <tbody>{milestones.map((d) => <tr key={d.day} className="border-b border-gray-100"><th className="p-1.5 text-left font-normal">{d.day}営業日以内</th><td className="p-1.5">{d.cumulativeProbability === null ? "推定不可" : pctPlain(d.cumulativeProbability)}</td><td className="p-1.5">{d.atRisk}件</td></tr>)}</tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-gray-500">{note}</p>
    </div>
  );
}

function outcomeText(e: EventPath, key: "firstDown" | "drawdown"): string {
  const o = e[key];
  if (o.observed) return `${o.time}日`;
  return e.available < 1 ? "未観測" : `${o.time}日まで無し`;
}

export default function NdayMoveDistribution({ prices, range, condition, result, drawdownPct, excludeOverlap, benchName, selected, onSelect }: Props) {
  const H = result.horizon;
  const c = result.counts;
  const sel = selected !== null ? result.events[selected] ?? null : null;

  const markers = useMemo<PriceMarker[]>(() => [
    ...result.events.map((e, i) => ({ id: `e${i}`, index: e.index, kind: "event" as const })),
    ...result.overlapExcluded.map((t) => ({ id: `x${t.index}`, index: t.index, kind: "event-dim" as const })),
    ...(result.leading ? [{ id: `l${result.leading.index}`, index: result.leading.index, kind: "event-dim" as const, text: "判定不能" }] : []),
  ], [result]);
  const focus = useMemo<PriceFocus | null>(() => (sel ? {
    from: sel.index - condition.lookback,
    to: sel.index + Math.max(1, sel.available),
    bands: [
      { from: sel.index - condition.lookback, to: sel.index, tone: "lookback" },
      { from: sel.index, to: sel.index + sel.available, tone: "forward" },
    ],
    label: `選択: ${sel.date}（${condition.lookback}日騰落 ${pctPointsSigned(sel.movePct)}）。青＝判定の${condition.lookback}営業日、橙＝その後の観測${sel.available}営業日${sel.complete ? "" : `（残り${H - sel.available}日は未観測）`}`,
  } : null), [sel, condition.lookback, H]);

  const dayBins = (hist: number[]) => hist.map((count, k) => ({
    label: k === 0 ? "0日" : k === H ? `${k}(端)` : String(k),
    count,
    tone: k === 0 ? "start" as const : k === H ? "edge" as const : "normal" as const,
  }));
  const maxAtStart = result.maxDayHist[0] ?? 0;
  const maxAtEdge = result.maxDayHist[H] ?? 0;
  const minAtStart = result.minDayHist[0] ?? 0;
  const minAtEdge = result.minDayHist[H] ?? 0;
  const medoid = result.medoid !== null ? result.events[result.medoid] : null;

  return (
    <div className="space-y-4">
      <Notice tone="warn">
        <strong>後から分かった値動きの記述です。</strong>極値（最高値・最低値）の日は観測期間が終わってから決まります。
        その日のうちに「ここが底・天井」と判定できたわけではなく、この表の値で売買できたことにはなりません。実行できる売買は②で検証します。
      </Notice>
      <p className="text-xs text-gray-700">
        件数の流れ：条件を満たした日 <strong>{c.conditionDays}日</strong> →
        {condition.trigger === "edge" ? <> 不成立→成立の立ち上がり <strong>{c.triggers}件</strong></> : <> 成立日すべて <strong>{c.triggers}件</strong></>}
        {c.leading > 0 && <>（データ先頭で既に成立していた1件は立ち上がりか判定できないため除外）</>}
        {excludeOverlap ? <> → 観測窓の重なりを除いて <strong>{c.adopted}件</strong>（除外{c.overlap}件：採用した日の翌日から{H}営業日以内に出た候補）</> : <> → 重なりを許して <strong>{c.adopted}件</strong></>}
        。うち{H}日を完全に観測 {c.complete}件・観測不足（期間末）{c.incomplete}件。
      </p>
      {!excludeOverlap && <Notice tone="warn">重なりを許しているため、同じ下げ（上げ）局面を何度も数えています。件数を独立した標本数とはみなせません。</Notice>}
      {c.touchesNoTrade > 0 && <Notice tone="muted">{c.touchesNoTrade}件は、判定区間か観測窓に「出来高0で4本値が同値の行」（休場日の擬似行など）を含みます。1行を1営業日として数えているため、その分だけ実際の立会日数とずれます。</Notice>}

      <NdayMovePriceChart
        prices={prices}
        range={range}
        markers={markers}
        focus={focus}
        onSelect={(id) => { if (id.startsWith("e")) onSelect(Number(id.slice(1))); }}
        ariaLabel={`終値の推移と条件成立日（採用${result.events.length}件、重複で除外${result.overlapExcluded.length}件は灰色）。${focus ? focus.label : "事例は未選択"}`}
      />

      {result.events.length === 0 ? (
        <p role="status" className="rounded bg-gray-50 p-4 text-sm text-gray-600">この期間には条件に当てはまる日がありません。閾値 p を小さくするか、判定期間 n・分析期間を変えてください。</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <StatCard label={`${H}日後の騰落率（中央値）`} value={pctPointsSigned(result.finalPct?.q50)} note={result.finalPct ? `完全窓${result.finalPct.n}件・10〜90%: ${pctPointsSigned(result.finalPct.q10)}〜${pctPointsSigned(result.finalPct.q90)}` : "完全に観測した事例なし"} />
            <StatCard label="無条件の同じ日数（中央値）" value={result.baseline.length === H + 1 ? pctPointsSigned(result.baseline[H].q50) : "—"} note={result.baseline.length === H + 1 ? `全営業日起点 ${result.baseline[H].n}本（重なりあり）` : undefined} />
            <StatCard label="初めて前日終値を下回るまで" value={result.firstDownMedian === null ? "未到達" : `中央値 ${result.firstDownMedian}日`} note="Kaplan–Meier（期間内に起きない事例は打ち切り）" />
            <StatCard label={`最高終値から${drawdownPct}%反落するまで`} value={result.drawdownMedian === null ? "未到達" : `中央値 ${result.drawdownMedian}日`} note="0日目も走行最高値に含める" />
          </div>
          {result.counts.complete < 30 && <Notice tone="warn">完全に観測した事例が{result.counts.complete}件しかありません。分位点は数件の違いで大きく動きます。重複を除いても相場局面・判定区間の共有による依存は残り、独立した標本にはなりません。</Notice>}

          <div>
            <h4 className="mb-1 text-sm font-medium">各事例の経路と、日ごとの中央値・分位帯</h4>
            <PathsChart result={result} selected={selected} />
            <p className="mt-1 text-xs text-gray-600">
              細い青線＝各事例（破線は期間末で観測不足）、濃い帯＝25〜75%、薄い帯＝10〜90%、太い青線＝日ごとの中央値、灰色の帯と破線＝無条件（全営業日起点）の25〜75%と中央値、橙＝選択中の事例。
              <strong>太い青線は日ごとの中央値を横につないだもので、実在の1本の経路ではありません。</strong>
              {medoid && <> 紫の線は、中央値の線に最も近い実在の事例（{medoid.date}）です。</>}
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <h4 className="mb-1 text-sm font-medium">最高終値の日（0〜{H}日目）</h4>
              <BarHistogram bins={dayBins(result.maxDayHist)} xLabel="最高終値をつけた営業日（0＝条件成立日）" description={`最高終値の日の分布。完全窓${c.complete}件。0日目${maxAtStart}件、${H}日目（窓の端）${maxAtEdge}件。`} />
              <p className="mt-1 text-xs text-gray-600">0日目{maxAtStart}件＝条件成立日の終値がその後{H}日で最も高かった。{H}日目{maxAtEdge}件は<strong>観測窓の端</strong>で、そこが天井だった（反転した）とは限りません。</p>
            </div>
            <div className="min-w-0">
              <h4 className="mb-1 text-sm font-medium">最低終値の日（0〜{H}日目）</h4>
              <BarHistogram bins={dayBins(result.minDayHist)} xLabel="最低終値をつけた営業日（0＝条件成立日）" description={`最低終値の日の分布。完全窓${c.complete}件。0日目${minAtStart}件、${H}日目（窓の端）${minAtEdge}件。`} />
              <p className="mt-1 text-xs text-gray-600">0日目{minAtStart}件＝条件成立日の終値が底だった。{H}日目{minAtEdge}件は窓の端で、その後も下げた可能性があります。同じ値が複数日にあれば最初の日を数えます。</p>
            </div>
          </div>

          <div>
            <h4 className="mb-1 text-sm font-medium">値幅の分布（条件成立日の終値からの変化率・完全窓）</h4>
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-right text-xs tabular-nums">
                <thead><tr className="border-b text-gray-600"><th className="p-2 text-left">指標</th><th className="p-2">件数</th><th className="p-2">10%</th><th className="p-2">25%</th><th className="p-2">中央値</th><th className="p-2">75%</th><th className="p-2">90%</th><th className="p-2">平均</th></tr></thead>
                <tbody>
                  <QuantileRow label={`${H}日後の終値`} q={result.finalPct} />
                  <QuantileRow label="観測窓の最高終値" q={result.maxPct} note="0日目を含む。0なら成立日が最高" />
                  <QuantileRow label="観測窓の最低終値" q={result.minPct} note="0日目を含む。0なら成立日が最低" />
                  <QuantileRow label="翌朝の窓（翌日始値）" q={result.gapPct} note="翌日寄りで買う売買には取れない部分" />
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-xs text-gray-600">翌朝の窓は、条件成立日の終値から翌営業日の始値までの変化です。①の分布は終値起点なのでこの部分を含みますが、②の売買（翌日の寄りで買う）には入りません。①が良く見えて②が振るわないときは、まずここを見てください。</p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <KmTable title="初めて前日終値を下回るまで" days={result.firstDownKM} horizon={H} note="その日の終値が前営業日を下回った最初の日（同値は下落ではない）。条件成立日の前日との比較は数えない。" />
            <KmTable title={`条件成立後の最高終値から${drawdownPct}%下落するまで`} days={result.drawdownKM} horizon={H} note="0日目からその日までの最高終値を基準にした下落。前日割れとは別の指標。" />
          </div>
          <p className="text-xs text-gray-600">「初めて下がる」「最高値を付ける」「一定幅反落する」は別の指標です。期間内に起きなかった事例は捨てず、その日まで起きなかったとだけ分かる打ち切りとして扱います（Kaplan–Meier）。追跡対象が尽きた先は推定しません。</p>

          {(result.byPreVol.length > 0 || result.byMarket.length > 0) && (
            <div>
              <h4 className="mb-1 text-sm font-medium">層別（記述のみ・有意性は主張しない）</h4>
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-right text-xs tabular-nums">
                  <thead><tr className="border-b text-gray-600"><th className="p-2 text-left">層</th><th className="p-2">件数</th><th className="p-2">{H}日後 中央値</th><th className="p-2">最高 中央値</th><th className="p-2">最低 中央値</th></tr></thead>
                  <tbody>{[...result.byPreVol, ...result.byMarket].map((g) => <tr key={g.label} className="border-t border-gray-100"><th className="p-2 text-left font-normal">{g.label}</th><td className="p-2">{g.n}件</td><td className="p-2">{pctPointsSigned(g.finalMedian)}</td><td className="p-2">{pctPointsSigned(g.maxMedian)}</td><td className="p-2">{pctPointsSigned(g.minMedian)}</td></tr>)}</tbody>
                </table>
              </div>
              <p className="mt-1 text-xs text-gray-600">事前ボラは判定区間より前の{60}営業日の日次変動で、判定区間の値動きを含めません（同時点の騰落で切ると機械的な相関が入るため）。{benchName ? `「市場も同じ向き」は同じ${condition.lookback}営業日に${benchName}が銘柄の騰落の半分以上、同じ向きに動いた事例です。` : "市場の騰落は取得できていません。"}層ごとの件数は少なく、差の有無は判断できません。</p>
            </div>
          )}

          <details className="rounded border border-gray-200 p-3" open>
            <summary className="cursor-pointer text-xs font-medium">イベント一覧（新しい順・全{result.events.length}件）— 日付を押すと上のチャートで確認できます</summary>
            <div className="mt-2 max-h-80 overflow-auto">
              <table className="w-full whitespace-nowrap text-right text-xs tabular-nums">
                <thead className="sticky top-0 bg-white"><tr className="border-b text-gray-600">
                  <th className="p-2 text-left">条件成立日</th><th className="p-2">{condition.lookback}日騰落</th><th className="p-2">翌朝の窓</th><th className="p-2">{H}日後</th>
                  <th className="p-2">最高（日）</th><th className="p-2">最低（日）</th><th className="p-2">前日割れ</th><th className="p-2">{drawdownPct}%反落</th>
                  {benchName && <th className="p-2">市場{condition.lookback}日</th>}<th className="p-2">観測</th>
                </tr></thead>
                <tbody>{result.events.map((e, i) => ({ e, i })).reverse().map(({ e, i }) => (
                  <tr key={e.index} className={`border-t border-gray-100 ${selected === i ? "bg-amber-50" : ""}`}>
                    <td className="p-2 text-left"><button type="button" className="text-blue-700 underline" aria-pressed={selected === i} onClick={() => onSelect(i)}>{e.date}</button>{e.touchesNoTrade && <span className="ml-1 text-gray-500" title="出来高0で4本値が同値の行を含む">※</span>}</td>
                    <td className="p-2">{pctPointsSigned(e.movePct)}{e.z !== null && <span className="block text-[11px] text-gray-500">{num(e.z, 1)}σ</span>}</td>
                    <td className="p-2">{pctPointsSigned(e.gapPct)}</td>
                    <td className="p-2">{e.complete ? pctPointsSigned(e.finalPct) : "—"}</td>
                    <td className="p-2">{pctPointsSigned(e.maxPct)}（{e.maxDay}{e.complete ? "" : "・暫定"}）</td>
                    <td className="p-2">{pctPointsSigned(e.minPct)}（{e.minDay}{e.complete ? "" : "・暫定"}）</td>
                    <td className="p-2">{outcomeText(e, "firstDown")}</td>
                    <td className="p-2">{outcomeText(e, "drawdown")}</td>
                    {benchName && <td className="p-2">{pctPointsSigned(e.marketLookbackPct)}</td>}
                    <td className="p-2">{e.complete ? "完全" : `不足（${e.available}/${H}日）`}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-gray-500">※ 判定区間か観測窓に出来高0の行を含む。暫定＝期間末で観測が足りない事例の途中までの極値で、分布には入れていません。</p>
          </details>
        </>
      )}
    </div>
  );
}
