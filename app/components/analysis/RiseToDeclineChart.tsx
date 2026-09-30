"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PricePoint } from "../../lib/types";
import { computeRiseToDecline, type DeclineDefinition, type RiseToDeclineResult } from "../../lib/rise-to-decline";
import { CHART_COLORS, DIRECTION_COLORS } from "../../lib/chart-colors";
import AnalysisGuide from "./AnalysisGuide";
import AccessibleCanvas from "./AccessibleCanvas";
import RiseToDeclinePriceChart from "./RiseToDeclinePriceChart";
import RiseToDeclineOverviewChart from "./RiseToDeclineOverviewChart";

const inputClass = "mt-1 block w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm";
const daysText = (n: number | null) => n === null ? "未到達" : `${n}営業日`;
const probabilityText = (p: number | null) => p === null ? "推定不可" : `${(p * 100).toFixed(1)}%`;
const DEFINITIONS: { value: DeclineDefinition; label: string; description: string }[] = [
  { value: "first-down", label: "初めて前営業日より下落", description: "初めて終値が前営業日を下回る日。同値は下落に含めません。" },
  { value: "daily-drop", label: "前日比でX%以上下落", description: "1営業日の終値下落率がX%以上になる最初の日。数日分の下落率は合算しません。" },
  { value: "consecutive", label: "K営業日連続で下落", description: "終値がK営業日連続で前日を下回った、そのK日目。同値・上昇で連続日数をリセットします。" },
  { value: "drawdown", label: "最高終値からX%下落", description: "条件成立日の終値を含む、その時点までの最高終値からX%以上下がる最初の日。" },
  { value: "below-signal", label: "条件成立日の終値を下回る", description: "終値が条件成立日の終値を初めて下回る日。同値は含めません。" },
  { value: "future-peak", label: "その後H日間の最高終値までの日数", description: "翌日〜H営業日後の最高終値の日。同じ最高値が複数あれば最初の日を採用します。条件成立日は比較範囲に含めません。" },
];

function Histogram({ result, isPeak }: { result: RiseToDeclineResult; isPeak: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const draw = () => {
      const width = parent.clientWidth;
      if (width <= 0) return;
      const height = 250;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = CHART_COLORS.surface;
      ctx.fillRect(0, 0, width, height);
      const left = 38, top = 28, bottom = 54;
      const plotWidth = width - left - 12;
      const plotHeight = height - top - bottom;
      const max = Math.max(1, ...result.bins.map((b) => b.count));
      ctx.font = "11px sans-serif";
      ctx.fillStyle = CHART_COLORS.ink;
      ctx.fillText("件数", 6, 15);
      for (let g = 0; g <= 4; g++) {
        const y = top + plotHeight * (1 - g / 4);
        ctx.strokeStyle = CHART_COLORS.grid;
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - 12, y); ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillText((max * g / 4).toFixed(max < 4 ? 1 : 0), left - 5, y + 4);
      }
      const step = plotWidth / result.bins.length;
      const labelStride = Math.max(1, Math.ceil(45 / step));
      result.bins.forEach((bin, i) => {
        const x = left + step * i;
        const h = plotHeight * bin.count / max;
        ctx.fillStyle = isPeak ? CHART_COLORS.neutral : DIRECTION_COLORS.down;
        ctx.fillRect(x + 2, top + plotHeight - h, Math.max(1, step - 4), h);
        ctx.fillStyle = CHART_COLORS.ink;
        ctx.textAlign = "center";
        if (bin.count > 0 && step >= 22) ctx.fillText(String(bin.count), x + step / 2, top + plotHeight - h - 5);
        if (i % labelStride === 0) ctx.fillText(bin.from === bin.to ? String(bin.from) : `${bin.from}–${bin.to}`, x + step / 2, height - bottom + 18);
      });
      ctx.textAlign = "center";
      ctx.fillText(`${isPeak ? "最高終値" : "下落条件成立"}までの営業日数（翌日＝1）`, width / 2, height - 10);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [result, isPeak]);
  return <div className="min-w-0"><AccessibleCanvas ref={canvasRef} description={`${isPeak ? "最高終値" : "下落条件成立"}までの日数のヒストグラム。集計${result.observed}件。${result.bins.map((b) => `${b.from}〜${b.to}営業日: ${b.count}件`).join("、")}。${isPeak ? "H日未観測の事例は除外。" : "未成立の事例は別途表示。"}`} /></div>;
}

export default function RiseToDeclineChart({ prices }: { prices: PricePoint[] }) {
  const [lookback, setLookback] = useState("5");
  const [risePct, setRisePct] = useState("5");
  const [horizon, setHorizon] = useState("20");
  const [excludeOverlap, setExcludeOverlap] = useState(true);
  const [definition, setDefinition] = useState<DeclineDefinition>("first-down");
  const [dropPct, setDropPct] = useState("1");
  const [consecutiveDays, setConsecutiveDays] = useState("2");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [priceView, setPriceView] = useState<"single" | "all">("single");
  const selectSingleEvent = useCallback((date: string) => {
    setSelectedDate(date);
    setPriceView("single");
  }, []);
  const priceWindowRef = useRef<HTMLDivElement>(null);
  const isPeak = definition === "future-peak";
  const selectedDefinition = DEFINITIONS.find((d) => d.value === definition)!;
  const targetLabel = isPeak ? "最高終値" : "下落条件成立";
  const estimateLabel = isPeak ? "経験分布" : "KM";
  const result = useMemo(() => computeRiseToDecline(prices, {
    lookback: Number(lookback), risePct: Number(risePct), horizon: Number(horizon), excludeOverlap,
    definition, dropPct: Number(dropPct), consecutiveDays: Number(consecutiveDays),
  }), [prices, lookback, risePct, horizon, excludeOverlap, definition, dropPct, consecutiveDays]);
  const effectiveCount = isPeak ? result.observed : result.events.length - result.zeroFollowup;
  const milestones = result.days.filter((d) => [1, 3, 5, 10, 20, 60, Number(horizon)].includes(d.day));
  const selectedEvent = result.events.find((e) => e.signalDate === selectedDate)
    ?? result.events.filter((e) => e.availableFollowup === Number(horizon)).at(-1)
    ?? result.events.at(-1);
  const selectedIndex = selectedEvent ? result.events.indexOf(selectedEvent) : -1;

  return (
    <div className="space-y-4 text-sm">
      <p className="text-gray-600">過去L営業日でR%以上上昇した日から、選択した条件までの日数を集計します。</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="min-w-0 text-xs text-gray-700">集計する定義
          <select className={inputClass} value={definition} onChange={(e) => setDefinition(e.target.value as DeclineDefinition)}>
            {DEFINITIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </label>
        {(definition === "daily-drop" || definition === "drawdown") && <label className="text-xs text-gray-700">下落率X（%）
          <input className={inputClass} type="number" min="0.01" max="99.99" step="any" value={dropPct} onChange={(e) => setDropPct(e.target.value)} />
        </label>}
        {definition === "consecutive" && <label className="text-xs text-gray-700">連続下落日数K（営業日）
          <input className={inputClass} type="number" min="1" max={Number(horizon) || 252} step="1" value={consecutiveDays} onChange={(e) => setConsecutiveDays(e.target.value)} />
        </label>}
      </div>
      <p className="rounded bg-gray-50 p-3 text-xs text-gray-700">{selectedDefinition.description}</p>
      {isPeak && <p className="rounded bg-amber-50 p-3 text-xs text-amber-900">振り返り専用：H営業日後まで観測して初めて最高終値の日が決まります。その日の時点で天井を判定できる指標ではありません。上昇し続ける事例も含み、最高終値の後に下落したことは保証しません。</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="text-xs text-gray-700">上昇の判定期間（営業日）
          <input className={inputClass} type="number" min="1" max="252" step="1" value={lookback} onChange={(e) => setLookback(e.target.value)} />
        </label>
        <label className="text-xs text-gray-700">上昇率の下限（%）
          <input className={inputClass} type="number" min="0.01" max="1000" step="any" value={risePct} onChange={(e) => setRisePct(e.target.value)} />
        </label>
        <label className="text-xs text-gray-700">その後の追跡上限（営業日）
          <input className={inputClass} type="number" min="1" max="252" step="1" value={horizon} onChange={(e) => setHorizon(e.target.value)} />
        </label>
      </div>
      <label className="flex items-start gap-2 text-xs text-gray-700">
        <input className="mt-0.5" type="checkbox" checked={excludeOverlap} onChange={(e) => setExcludeOverlap(e.target.checked)} />
        <span>追跡期間が重なる事例を除く（採用日の翌日から追跡上限まで、新しい事例を採用しない）</span>
      </label>
      <p className="text-xs text-gray-500">対象：画面上部で選択した分析期間内の日足 {prices.length}本{prices.length > 0 && `（${prices[0].time}〜${prices[prices.length - 1].time}）`}。営業日は取得できた日足の本数で数えます。</p>

      {result.error ? <p role="alert" className="rounded bg-amber-50 p-3 text-amber-900">{result.error}</p>
        : result.events.length === 0 ? <p role="status" className="rounded bg-gray-50 p-4 text-gray-600">条件に一致する日がありません。上昇率の下限を下げるか、分析期間を長くしてください。</p>
          : <>
            {selectedEvent && <div ref={priceWindowRef} className="space-y-3 rounded border border-gray-200 p-3 scroll-mt-36">
              <h4 className="font-medium">原系列で期間と事例の集中を確認</h4>
              <div className="flex flex-wrap gap-2" role="group" aria-label="原系列の事例表示モード">
                <button type="button" aria-pressed={priceView === "single"} className={`rounded border px-3 py-2 text-xs ${priceView === "single" ? "border-blue-600 bg-blue-50 text-blue-800" : "border-gray-300"}`} onClick={() => setPriceView("single")}>1事例ずつ表示</button>
                <button type="button" aria-pressed={priceView === "all"} className={`rounded border px-3 py-2 text-xs ${priceView === "all" ? "border-blue-600 bg-blue-50 text-blue-800" : "border-gray-300"}`} onClick={() => setPriceView("all")}>全事例を表示（{result.events.length}件）</button>
              </div>
              {priceView === "single" && <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-0 flex-1 basis-64 text-xs text-gray-700">原系列に表示する事例（条件成立日）
                  <select className={inputClass} value={selectedEvent.signalDate} onChange={(e) => setSelectedDate(e.target.value)}>
                    {[...result.events].reverse().map((e) => <option key={e.signalDate} value={e.signalDate}>{e.signalDate}（+{e.risePct.toFixed(2)}%）</option>)}
                  </select>
                </label>
                <button type="button" className="rounded border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-40" disabled={selectedIndex <= 0} onClick={() => setSelectedDate(result.events[selectedIndex - 1].signalDate)}>前の事例（古い日）</button>
                <button type="button" className="rounded border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-40" disabled={selectedIndex >= result.events.length - 1} onClick={() => setSelectedDate(result.events[selectedIndex + 1].signalDate)}>次の事例（新しい日）</button>
              </div>}
              {priceView === "all"
                ? <RiseToDeclineOverviewChart prices={prices} events={result.events} lookback={Number(lookback)} horizon={Number(horizon)} isPeak={isPeak} onSelect={selectSingleEvent} />
                : <RiseToDeclinePriceChart prices={prices} event={selectedEvent} lookback={Number(lookback)} horizon={Number(horizon)} isPeak={isPeak} />}
              {priceView === "all" && <p className="text-xs text-gray-500">「全事例」は現在の重複除外設定で採用した事例です。条件に一致した全営業日を見るには、上の「追跡期間が重なる事例を除く」をオフにしてください。個別の事例は下の事例一覧の日付からも開けます。</p>}
              <p className="text-xs text-gray-500">事例の選択はこの価格チャートだけに反映されます。下の分布は採用した全事例の集計です。初期表示はH日分を観測できた最新事例（なければ最新事例）。</p>
            </div>}
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {[
                ["採用した事例", `${result.events.length}件`, `条件一致${result.rawSignals}件・重複除外${result.rawSignals - result.events.length}件`],
                [isPeak ? "H日観測済みの事例" : "下落条件の成立を観測", `${result.observed}件`, isPeak ? `観測不足による除外${result.incomplete}件` : `未成立・打ち切り${result.events.length - result.observed}件`],
                [`${targetLabel}までの中央値（${estimateLabel}）`, isPeak && !result.observed ? "推定不可" : daysText(result.median), "累積割合が50%に達する日"],
                [`25% / 75%到達日（${estimateLabel}）`, isPeak && !result.observed ? "推定不可" : `${daysText(result.quartiles[0])} / ${daysText(result.quartiles[1])}`, isPeak ? "H日観測済みの事例だけで計算" : "未到達＝観測範囲では決められない"],
              ].map(([label, value, note]) => <div key={label} className="rounded border border-gray-200 p-3">
                <p className="text-xs text-gray-600">{label}</p><p className="mt-1 break-keep text-lg font-semibold tabular-nums">{value}</p><p className="mt-1 text-xs text-gray-500">{note}</p>
              </div>)}
            </div>
            {(effectiveCount < 30 || !excludeOverlap) && <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">
              {effectiveCount < 30 && "集計できた事例が30件未満です。少数標本の参考値として読んでください。 "}
              {!excludeOverlap && "重複を含むため、連続する条件成立日が同じ上昇局面を繰り返し数えています。件数を独立した標本数とはみなせません。"}
            </p>}
            <div>
              <h4 className="mb-2 font-medium">{targetLabel}までの日数の分布（観測件数）</h4>
              {isPeak && result.observed === 0 ? <p role="status" className="rounded bg-gray-50 p-3">H日分を観測できた事例がありません。追跡上限を短くするか、分析期間を長くしてください。</p> : <Histogram result={result} isPeak={isPeak} />}
              <p className="mt-2 text-xs text-gray-600">{isPeak
                ? `H日観測済み${result.observed}件のみ集計。観測不足${result.incomplete}件は除外し、打ち切りとして補正しません。最高終値がH日目の事例：${result.peaksAtHorizon}件。`
                : `棒は条件成立を観測した事例のみ。追跡上限まで未成立：${result.horizonCensored}件 ／ データ末尾で追跡終了：${result.endCensored}件（翌日未観測：${result.zeroFollowup}件）。未成立を「0日」や「上限日で成立」として数えません。`}</p>
            </div>
            <div>
              <h4 className="mb-2 font-medium">{isPeak ? "最高終値が何営業日目までにあったか（経験分布）" : "何営業日以内に下落条件が成立したか（Kaplan–Meier推定）"}</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs tabular-nums">
                  <thead><tr className="border-b text-gray-600"><th className="p-2 text-left">期限</th><th className="p-2">{isPeak ? "累積割合" : "累積成立確率"}</th><th className="p-2">{isPeak ? "集計対象" : "その日の追跡対象"}</th></tr></thead>
                  <tbody>{milestones.map((d) => <tr key={d.day} className="border-b border-gray-100"><th className="p-2 text-left font-normal">{d.day}営業日以内</th><td className="p-2">{probabilityText(d.cumulativeProbability)}</td><td className="p-2">{d.atRisk}件</td></tr>)}</tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-gray-500">{isPeak ? "累積割合は、H日観測済みの全事例のうち、最高終値の日が指定日以内にあった割合です。条件成立日の翌日を1日目として数えます。" : "追跡対象＝前日まで条件未成立で、その日の終値も観測できた事例。打ち切りを反映するため、棒の件数比率とは異なります。追跡対象が尽きた先は外挿しません（全件成立済みなら100%）。"}</p>
            </div>
            <details className="rounded border border-gray-200 p-3">
              <summary className="cursor-pointer text-xs font-medium">日別の集計表</summary>
              <div className="mt-2 max-h-72 overflow-auto">
                <table className="w-full text-right text-xs tabular-nums">
                  <thead><tr><th className="p-2">営業日</th><th className="p-2">{isPeak ? "集計対象" : "追跡対象"}</th><th className="p-2">{isPeak ? "最高終値" : "初回成立"}</th>{!isPeak && <th className="p-2">打ち切り</th>}<th className="p-2">{isPeak ? "累積割合" : "累積確率"}</th></tr></thead>
                  <tbody>{result.days.map((d) => <tr key={d.day} className="border-t border-gray-100"><td className="p-2">{d.day}</td><td className="p-2">{d.atRisk}</td><td className="p-2">{d.declines}</td>{!isPeak && <td className="p-2">{d.censored}</td>}<td className="p-2">{probabilityText(d.cumulativeProbability)}</td></tr>)}</tbody>
                </table>
              </div>
            </details>
            <details className="rounded border border-gray-200 p-3">
              <summary className="cursor-pointer text-xs font-medium">採用した事例一覧（新しい順・全{result.events.length}件）</summary>
              <div className="mt-2 max-h-72 overflow-auto">
                <table className="w-full whitespace-nowrap text-right text-xs tabular-nums">
                  <thead><tr><th className="p-2">条件成立日</th><th className="p-2">過去の上昇率</th><th className="p-2">{isPeak ? "最高終値日 / 最終観測日" : "下落条件成立日 / 最終観測日"}</th><th className="p-2">経過日数</th><th className="p-2">結果</th></tr></thead>
                  <tbody>{[...result.events].reverse().map((e) => <tr key={e.signalDate} className={`border-t border-gray-100 ${selectedEvent?.signalDate === e.signalDate ? "bg-blue-50" : ""}`}><td className="p-2"><button type="button" className="text-blue-700 underline" aria-label={`${e.signalDate}の事例を原系列で表示`} aria-pressed={selectedEvent?.signalDate === e.signalDate} onClick={() => { selectSingleEvent(e.signalDate); priceWindowRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{e.signalDate}</button></td><td className="p-2">+{e.risePct.toFixed(2)}%</td><td className="p-2">{e.endDate}</td><td className="p-2">{e.duration}営業日</td><td className="p-2">{e.outcome === "peak" ? "最高終値（H日観測済み）" : e.outcome === "incomplete" ? "H日未観測・集計除外" : e.outcome === "decline" ? "初回成立" : e.outcome === "horizon" ? "上限まで未成立" : "データ末尾・未成立"}</td></tr>)}</tbody>
                </table>
              </div>
            </details>
          </>}

      <AnalysisGuide title="上昇後の日数分布：6種類の定義・数式・読み方">
        <p><strong>全事例表示：</strong>採用された全事例の判定区間と追跡区間を原系列に重ねます。青い起点の集中する時期を調べ、ズームして各事例を確認できます。青の起点付近をクリックするか、事例一覧の日付を選ぶと個別表示へ切り替わります。帯の濃さは区間の重なりを示すだけで、件数・確率の尺度ではありません。同じ日に複数の事例の結果が出た場合、紫の結果マーカーは1点にまとめます。重複除外設定によって表示対象が変わる点に注意してください。</p>
        <p><strong>原系列の区間表示：</strong>青の①→②は上昇率を判定する過去L営業日の区間、②は上昇条件成立日（0日目）、橙の②→④は翌日からH営業日後までを調べる追跡区間です。紫の③は選択した下落条件の成立日または最高終値日。③と④は異なる日になることがあり、早く下落しても追跡上限Hは短くなりません。データ末尾に届いた場合、④は観測できた最後の日を示し、未観測日数を別記します。事例選択・ズーム・移動は集計対象を変えません。</p>
        <p><strong>手法：</strong>上昇条件が成立した各日を起点とするイベント分析です。5種類の下落条件は初回成立までの待ち時間を推定し、「その後H日間の最高終値」は完全なH日窓の振り返り分布を集計します。選択中：{selectedDefinition.label}。</p>
        <p><strong>条件と日数：</strong>Cₜをt営業日の終値、Lを判定期間、Rを上昇率の下限（%）、Hを追跡上限とします。rₜ = 100(Cₜ / Cₜ₋ₗ − 1)、rₜ ≥ Rなら上昇条件成立です。下落条件をBₜ(k)としてTₜ = min&#123;k ≥ 1 : Bₜ(k)&#125;。起点を0日、翌営業日を1日とし、起点以前の下落を連続日数に含めません。</p>
        <ul className="list-disc space-y-1 pl-4">
          <li><strong>初めて前営業日より下落：</strong>Bₜ(k)は Cₜ₊ₖ &lt; Cₜ₊ₖ₋₁。同値は下落ではありません。</li>
          <li><strong>前日比でX%以上下落：</strong>Bₜ(k)は100(1 − Cₜ₊ₖ / Cₜ₊ₖ₋₁) ≥ X。Xは正の下落率（%）。複数日に分かれた下落は合算しません。</li>
          <li><strong>K営業日連続で下落：</strong>sₜ(0) = 0とし、Cₜ₊ₖ &lt; Cₜ₊ₖ₋₁ならsₜ(k) = sₜ(k−1) + 1、それ以外は0。Bₜ(k)はsₜ(k) ≥ K。連続下落が始まった日にさかのぼらず、K日目を成立日とします。</li>
          <li><strong>最高終値からX%下落：</strong>Pₜ(k) = max&#123;Cₜ,…,Cₜ₊ₖ&#125;、Bₜ(k)は100(1 − Cₜ₊ₖ / Pₜ(k)) ≥ X。Pはその時点までの最高値で、未来の最高値は使いません。起点の終値も最高値の候補に含めます。</li>
          <li><strong>条件成立日の終値を下回る：</strong>Bₜ(k)はCₜ₊ₖ &lt; Cₜ。同値では成立しません。</li>
          <li><strong>その後H日間の最高終値：</strong>Jₜ = min argmax₁≤ₖ≤H Cₜ₊ₖ。翌日〜H日後だけで最大値を探し、同じ最高値なら最初の日を選びます。起点を除くため、以後ずっと下がる場合でもJₜ = 1になりえます。</li>
        </ul>
        <p><strong>最高終値モードの集計：</strong>H日分の観測がある事例集合をE、件数をNとします。F̂(k) = (1/N)Σₜ∈E1&#123;Jₜ ≤ k&#125;、q分位日はmin&#123;k : F̂(k) ≥ q&#125;。これは観測された割合（経験分布）で、Kaplan–Meier推定ではありません。H日未観測の暫定最高値は除外します。N = 0なら推定不可。H日目の最高値はその先の反落が未確認であり、Hの設定によって結果も変わります。</p>
        <p><strong>下落条件モードの打ち切り：</strong>最終データの添字をMとして、追跡可能日数はAₜ = min(H, M − t)。観測日数Yₜ = min(Tₜ, Aₜ)、発生フラグδₜ = 1&#123;Tₜ ≤ Aₜ&#125;です。追跡中に選択した下落条件が成立しなければTₜは不明で、Yₜ = Aₜ、δₜ = 0（右打ち切り）とします。これは「その日まで未成立とだけ分かる」という意味です。Aₜ = 0の事例は件数に残しますが確率計算には寄与しません。以下のKMの式の「下落」は選択した条件の成立を意味します。</p>
        <p><strong>累積確率と中央値：</strong>k日目の追跡対象nₖ = Σₜ1&#123;Yₜ ≥ k&#125;、初回下落数dₖ = Σₜ1&#123;Yₜ = k, δₜ = 1&#125;。1&#123;条件&#125;は条件が真なら1、偽なら0。未下落確率Ŝ(0) = 1、Ŝ(k) = ∏ⱼ₌₁ᵏ(1 − dⱼ / nⱼ)、累積下落確率F̂(k) = 1 − Ŝ(k)です。各日の未下落割合を掛け合わせるのがKaplan–Meier（積極限法）です。同日に打ち切る事例も、その日のnₖに含めます。q分位日はmin&#123;k : F̂(k) ≥ q&#125;で、q = 0.25 / 0.5 / 0.75を表示します。到達しなければ「未到達」とし、平均日数で代用しません。</p>
        <p><strong>分布の棒：</strong>下落条件モードの各ビン[a,b]はΣₜ1&#123;δₜ = 1, a ≤ Yₜ ≤ b&#125;件、最高終値モードはΣₜ∈E1&#123;a ≤ Jₜ ≤ b&#125;件。幅はceil(H / 20)営業日（最大20本、末尾だけ短くなる場合あり）。未成立や観測不足の事例は別掲します。日別の正確な件数は集計表で確認できます。</p>
        <p><strong>6種類を比べる例：</strong>条件成立日100円、その後103→105→104→102→99円なら、初回下落は3日、前日比1%以上下落・2日連続下落・最高終値から2%下落は4日、条件成立日の終値割れは5日。その後5日間の最高終値は2日目です。</p>
        <p><strong>直感的な例：</strong>5営業日前100円、条件成立日105円なら5%上昇。翌日106円、2日後106円、3日後105.5円なら、初回下落は3営業日後です。起点の105円より高くても下落として数えます。4件中2件が1日目に下落し、残り2件がその日の終値まで観測済みならF̂(1) = 50%です。</p>
        <p><strong>重複の扱い：</strong>除外オンでは古い順に採用し、採用日tの次はt + H + 1以降から探します。早く下落しても待機期間は短縮しません。除外オフでは条件を満たす全営業日を数えるため、長い上昇局面の重みが大きくなります。</p>
        <p><strong>読み方と活用：</strong>下落条件モードで1〜3営業日の棒に集中すれば、その条件の後は早い押し戻しが多かったことを示します。最高終値モードなら、その期間の最高値が早い日に多かったことを示します。中央値3営業日なら、累積割合が初めて50%に達したのが3営業日目です。保有期間や利確ルールを検証する仮説に使い、別期間でも再現するかを確認します。売買の指示や将来の下落日の予告ではありません。</p>
        <p><strong>限界：</strong>最初の前日比下落モードでは小さな下落も含み、いずれのモードも日中の天井は測れません。最高終値モードは直近H日の事例が除かれるため、最近の局面を反映しづらくなります。重複を除いても相場局面・過去L日の共有による依存は残ります。打ち切りと待ち時間が無関係であるという仮定や、期間を通じた分布の安定性が崩れると推定は偏ります。30件は精度を保証する基準ではありません。少数標本、末尾の追跡対象減少、条件の後付け調整、株式分割・配当・欠測に注意してください。有意差や独立標本を仮定した信頼区間は表示していません。</p>
        <p>手法の参考：<a className="text-blue-700 underline" href="https://itl.nist.gov/div898/handbook/apr/section2/apr215.htm" target="_blank" rel="noreferrer">NIST：Kaplan–Meier推定</a>。</p>
      </AnalysisGuide>
    </div>
  );
}
