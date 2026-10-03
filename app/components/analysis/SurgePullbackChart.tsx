"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, createSeriesMarkers, LineSeries, LineStyle, type IChartApi, type Time, type UTCTimestamp } from "lightweight-charts";
import type { PricePoint } from "../../lib/types";
import { computeSurgePullback, type SurgeOptions } from "../../lib/surge-pullback";
import { CHART_COLORS, DIRECTION_COLORS, EVENT_WINDOW_COLORS } from "../../lib/chart-colors";
import AnalysisGuide from "./AnalysisGuide";

const inputClass = "mt-1 w-full rounded border border-gray-300 bg-white px-2 py-2 text-sm";
const colors = { main: EVENT_WINDOW_COLORS.lookback, drop: DIRECTION_COLORS.down, rally: DIRECTION_COLORS.up, extra: EVENT_WINDOW_COLORS.outcome };
const pct = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}%`;
const probability = (value: number | null | undefined) => value == null ? "—" : pct(100 * value);
const dayTime = (day: number) => (946684800 + day * 86400) as UTCTimestamp;
const dayLabel = (time: Time) => `${Math.round((Number(time) - 946684800) / 86400)}営業日`;

interface PlotLine {
  title: string;
  color: string;
  dashed?: boolean;
  data: { time: Time; value?: number }[];
}

function TimingPlot({ title, lines, relative = false, markers = [], description }: {
  title: string; lines: PlotLine[]; relative?: boolean; markers?: string[]; description: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const api = useRef<IChartApi | null>(null);
  const markerKey = markers.join(",");
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      autoSize: true, height: 260,
      layout: { background: { color: CHART_COLORS.surface }, textColor: CHART_COLORS.ink },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      localization: { locale: "ja-JP", ...(relative ? { timeFormatter: dayLabel } : {}) },
      timeScale: { borderColor: CHART_COLORS.axis, ...(relative ? { tickMarkFormatter: dayLabel } : {}) },
    });
    api.current = chart;
    lines.forEach((line, index) => {
      const series = chart.addSeries(LineSeries, {
        title: line.title, color: line.color, lineWidth: 2,
        lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false, lastValueVisible: false,
      });
      series.setData(line.data);
      if (index === 0 && markerKey) createSeriesMarkers(series, markerKey.split(",").map((time) => ({
        time: time as Time, position: "aboveBar", shape: "arrowDown", color: colors.extra, text: "急騰",
      })));
    });
    chart.timeScale().fitContent();
    return () => { api.current = null; chart.remove(); };
  }, [lines, relative, markerKey]);
  return <figure className="min-w-0 space-y-2">
    <div className="flex items-start justify-between gap-2">
      <h4 className="font-semibold text-gray-800">{title}</h4>
      <button type="button" className="shrink-0 text-xs text-blue-700 underline" onClick={() => api.current?.timeScale().fitContent()}>全体表示</button>
    </div>
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">{lines.map((line) => <span key={line.title} style={{ color: line.color }}>{line.dashed ? "┄" : "━"} {line.title}</span>)}</div>
    <div ref={ref} className="h-[260px] w-full overflow-hidden rounded border border-gray-200" role="img" aria-label={`${title}。${description}`} />
    <figcaption className="text-xs text-gray-600">{description} ドラッグで移動、ホイール・ピンチで拡大。</figcaption>
  </figure>;
}

export default function SurgePullbackChart({ prices }: { prices: PricePoint[] }) {
  const [rise, setRise] = useState("3");
  const [drop, setDrop] = useState("2");
  const [rally, setRally] = useState("3");
  const [horizon, setHorizon] = useState("10");
  const [window, setWindow] = useState("10");
  const [basis, setBasis] = useState<SurgeOptions["basis"]>("signal");
  const [position, setPosition] = useState<SurgeOptions["position"]>("all");
  const [newHighOnly, setNewHighOnly] = useState(false);
  const [excludeOverlap, setExcludeOverlap] = useState(true);
  const [waveView, setWaveView] = useState<"price" | "age" | "position">("price");
  const [selectedDate, setSelectedDate] = useState("");
  const result = useMemo(() => computeSurgePullback(prices, {
    risePct: Number(rise), dropPct: Number(drop), rallyPct: Number(rally), horizon: Number(horizon),
    window: Number(window), basis, position, newHighOnly, excludeOverlap,
  }), [prices, rise, drop, rally, horizon, window, basis, position, newHighOnly, excludeOverlap]);
  const { selected, baseline, waves } = result;
  const latest = waves.at(-1);
  const event = selected.events.find((e) => e.time === selectedDate) ?? selected.events.at(-1);
  const selectedProbability = selected.days.at(-1)?.cumulativeProbability;
  const waveLines = useMemo<PlotLine[]>(() => {
    const line = (title: string, color: string, values: (number | null)[], dashed = false): PlotLine => ({
      title, color, dashed, data: waves.map((w, i) => ({ time: w.time as Time, ...(values[i] === null ? {} : { value: values[i]! }) })),
    });
    if (waveView === "age") return [line("高値からの営業日数", colors.rally, waves.map((w) => w.highAge)), line("安値からの営業日数", colors.drop, waves.map((w) => w.lowAge), true)];
    if (waveView === "position") return [line("レンジ内の位置 (%)", colors.main, waves.map((w) => w.position)), line("上位20%の境界", CHART_COLORS.reference, waves.map(() => 80), true), line("下位20%の境界", colors.extra, waves.map(() => 20), true)];
    return [line("終値", colors.main, waves.map((w) => w.close)), line("ローリング高値", colors.rally, waves.map((w) => w.high), true), line("ローリング安値", colors.drop, waves.map((w) => w.low), true)];
  }, [waves, waveView]);
  const probabilityLines = useMemo<PlotLine[]>(() => [
    { title: "急騰日 (KM)", color: colors.main, data: selected.days.map((d) => ({ time: dayTime(d.day), ...(d.cumulativeProbability === null ? {} : { value: d.cumulativeProbability * 100 }) })) },
    { title: "通常日 (KM)", color: CHART_COLORS.reference, dashed: true, data: baseline.days.map((d) => ({ time: dayTime(d.day), ...(d.cumulativeProbability === null ? {} : { value: d.cumulativeProbability * 100 }) })) },
  ], [selected.days, baseline.days]);
  const pathLines = useMemo<PlotLine[]>(() => {
    const lines: PlotLine[] = ([
      ["急騰後の中央値", "median", colors.main, false], ["25%点", "p25", colors.drop, true], ["75%点", "p75", colors.rally, true],
    ] as const).map(([title, key, color, dashed]) => ({ title, color, dashed,
      data: selected.paths.map((d) => ({ time: dayTime(d.day), ...(d[key] === null ? {} : { value: d[key] }) })),
    }));
    lines.push({ title: "通常日の中央値", color: CHART_COLORS.reference, dashed: true,
      data: baseline.paths.map((d) => ({ time: dayTime(d.day), ...(d.median === null ? {} : { value: d.median }) })) });
    if (event) lines.push({ title: `個別 ${event.time}`, color: colors.extra, data: event.path.map((value, day) => ({ time: dayTime(day), value })) });
    return lines;
  }, [selected.paths, baseline.paths, event]);
  const basisLabel = basis === "signal" ? "急騰日の終値" : basis === "peak" ? "起点以降の最高終値" : "前日終値";

  return <div className="space-y-5 text-sm">
    <p className="text-gray-600">前日比＋N%以上の日から、終値が指定幅下がるまでを追跡。2週間の波の位置と合わせて、押し目待ちと続伸の傾向を比較します。</p>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {([
        ["急騰 N (%)", rise, setRise, "0.1", "1000"], ["下落 n′ (%)", drop, setDrop, "0.1", "99.9"],
        ["続伸 (%)", rally, setRally, "0.1", "1000"], ["観測期間 (営業日)", horizon, setHorizon, "1", "60"],
        ["ローリング窓 (営業日)", window, setWindow, "2", "60"],
      ] as const).map(([label, value, set, min, max]) => <label key={label} className="min-w-0 text-xs text-gray-700">{label}<input type="number" className={inputClass} value={value} min={min} max={max} step={label.includes("%") ? "0.1" : "1"} onChange={(e) => set(e.target.value)} /></label>)}
      <label className="min-w-0 text-xs text-gray-700">下落の基準<select className={inputClass} value={basis} onChange={(e) => setBasis(e.target.value as SurgeOptions["basis"])}><option value="signal">急騰日の終値</option><option value="peak">起点以降の最高終値</option><option value="daily">前日終値</option></select></label>
      <label className="min-w-0 text-xs text-gray-700">起点のレンジ位置<select className={inputClass} value={position} onChange={(e) => setPosition(e.target.value as SurgeOptions["position"])}><option value="all">すべて</option><option value="upper">上位20% (80以上)</option><option value="lower">下位20% (20以下)</option></select></label>
    </div>
    <div className="flex flex-wrap gap-4 text-xs">
      <label className="flex items-center gap-2"><input type="checkbox" checked={newHighOnly} onChange={(e) => setNewHighOnly(e.target.checked)} />直前の窓の高値を更新した日だけ</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={excludeOverlap} onChange={(e) => setExcludeOverlap(e.target.checked)} />観測区間が重なる起点を除外</label>
    </div>
    <p className="text-xs text-gray-500">ページ上部の分析期間が対象です（{prices[0]?.time ?? "—"}〜{prices.at(-1)?.time ?? "—"}）。2週間 ≒ 10営業日。日数は取得済み日足の本数です。日中の安値タッチは数えません。</p>
    {result.error ? <p role="alert" className="rounded bg-amber-50 p-3 text-amber-900">{result.error}</p> : <>
      {latest && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label={`直近のレンジ位置 (${latest.time})`} value={pct(latest.position)} />
          <Metric label="窓内の高値 / 安値から" value={`${latest.highAge} / ${latest.lowAge}営業日`} />
          <Metric label={`${horizon}営業日以内の下落 (KM)`} value={probability(selectedProbability)} />
          <Metric label="下落までの中央値 (KM)" value={selected.median === null ? "50%未到達 / 推定不可" : `${selected.median}営業日`} />
        </div>
        <p className="text-xs text-gray-600">直近の変化：{latest.newHigh ? "高値を更新" : latest.highExpired ? "古い高値が窓から外れた" : "高値更新なし"} / {latest.newLow ? "安値を更新" : latest.lowExpired ? "古い安値が窓から外れた" : "安値更新なし"}。同値の高安は直近日を採用。0営業日前は当日です。</p>
        <label className="block max-w-sm text-xs text-gray-700">波の表示<select className={inputClass} value={waveView} onChange={(e) => setWaveView(e.target.value as typeof waveView)}><option value="price">価格とローリング高値・安値</option><option value="age">高値・安値からの経過日数</option><option value="position">レンジ内の位置 (0〜100)</option></select></label>
        <TimingPlot title={`${window}営業日の波の位置`} lines={waveLines} markers={waveView === "price" ? selected.events.map((e) => e.time) : []} description="過去と当日だけで計算。紫の矢印は集計に採用した急騰日。高安が同じ日は位置を計算しません。" />
      </>}
      <div className="rounded border border-blue-100 bg-blue-50 p-3 text-xs leading-relaxed" aria-live="polite">
        条件一致 {result.rawSignals}件 → 採用 {selected.events.length}件（重複除外 {result.rawSignals - selected.events.length}件）。下落到達 {selected.observed}件 / 期間内未到達 {selected.horizonCensored}件 / データ末尾で未到達 {selected.endCensored}件（うち翌日未観測 {selected.zeroFollowup}件）。
        <br />下落判定：{basisLabel}から−{drop}%。通常日は前日比＋{rise}%未満で、同じレンジ条件と重複除外を別々に適用（{baseline.events.length}件）。
      </div>
      {selected.events.length === 0 ? <p role="status" className="rounded bg-gray-50 p-4">条件を満たす急騰日がありません。Nを下げる、位置の条件を緩める、または分析期間を長くしてください。</p> : <>
        {selected.events.length - selected.zeroFollowup < 30 && <p className="text-xs text-amber-800">追跡できる標本が30件未満です。少数事例の参考値として読み、売買時点の予測と同一視しないでください。</p>}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <TimingPlot title="下落へ到達する累積確率 (%)" lines={probabilityLines} relative description="未到達例も含むKaplan–Meier推定。未観測の先は外挿しません。" />
          <TimingPlot title="起点終値からの騰落率 (%)" lines={pathLines} relative description={`統計線は全${horizon}日を観測した急騰${selected.completeCount}件・通常${baseline.completeCount}件。25〜75%点は値動きのばらつきで、予測の信頼区間ではありません。`} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-right text-xs"><caption className="mb-2 text-left font-semibold">日数別の下落到達確率と追跡対象数</caption><thead><tr className="border-b"><th className="p-2">営業日以内</th><th className="p-2">急騰日 (KM)</th><th className="p-2">当日の追跡対象</th><th className="p-2">当日の初到達</th><th className="p-2">通常日 (KM)</th><th className="p-2">通常日の追跡対象</th></tr></thead><tbody>{selected.days.filter((d) => [1, 3, 5, 10, 20, 40, Number(horizon)].includes(d.day)).map((d) => <tr key={d.day} className="border-b border-gray-100"><td className="p-2">{d.day}</td><td className="p-2">{probability(d.cumulativeProbability)}</td><td className="p-2">{d.atRisk}</td><td className="p-2">{d.events}</td><td className="p-2">{probability(baseline.days[d.day - 1]?.cumulativeProbability)}</td><td className="p-2">{baseline.days[d.day - 1]?.atRisk ?? 0}</td></tr>)}</tbody></table>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <h4 className="mb-2 font-semibold">下落と続伸、どちらが先か</h4>
          <p className="text-xs text-gray-600">全{horizon}日を観測した急騰{selected.completeCount}件が分母。下落は選択基準から−{drop}%、続伸は起点終値から＋{rally}%。</p>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">{([
            ["下落が先", selected.first.drop], ["続伸が先", selected.first.rally], ["どちらも未到達", selected.first.neither], ["同日到達", selected.first.tie],
          ] as const).map(([label, count]) => <Metric key={label} label={`${label} (${count}件)`} value={selected.completeCount ? probability(count / selected.completeCount) : "—"} />)}</div>
          <p className="mt-2 text-xs text-gray-600">下落前の最大上昇率の中央値：{pct(selected.maxRiseMedian)}（未到達例は観測上限まで、起点0%を含む終値ベース）。最高終値基準の下落は、起点より高い価格でも成立します。</p>
        </div>
        <label className="block max-w-md text-xs text-gray-700">個別の経路を重ねる<select className={inputClass} value={event?.time ?? ""} onChange={(e) => setSelectedDate(e.target.value)}>{[...selected.events].reverse().map((e) => <option key={e.time} value={e.time}>{e.time}：{e.dropDay !== null ? `${e.dropDay}営業日後に下落` : e.available < Number(horizon) ? `追跡中 (${e.available}日)` : "期間内未到達"}</option>)}</select></label>
        <details><summary className="cursor-pointer text-xs text-blue-700">個別事例の一覧（直近50件）</summary><div className="mt-2 overflow-x-auto"><table className="w-full whitespace-nowrap text-right text-xs"><thead><tr className="border-b"><th className="p-2">急騰日</th><th className="p-2">前日比</th><th className="p-2">レンジ位置</th><th className="p-2">初回下落</th><th className="p-2">初回続伸</th><th className="p-2">観測日数</th></tr></thead><tbody>{selected.events.slice(-50).reverse().map((e) => <tr key={e.time} className="border-b border-gray-100"><td className="p-2">{e.time}</td><td className="p-2">＋{pct(e.rise)}</td><td className="p-2">{pct(e.position)}</td><td className="p-2">{e.dropDay === null ? "未到達" : `${e.dropDay}日`}</td><td className="p-2">{e.rallyDay === null ? "未到達" : `${e.rallyDay}日`}</td><td className="p-2">{e.available}{e.available < Number(horizon) ? " (途中)" : ""}</td></tr>)}</tbody></table></div></details>
      </>}
    </>}
    <AnalysisGuide title="急騰後の押し目と波の位置：手法・数式・読み方">
      <p><strong>手法：</strong>急騰という条件が成立した日を起点に、下落までの待ち時間を追跡するイベント分析です。窓は直近W本（当日を含む）、追跡は翌日からH本。日中高安は位置の計算、終値は到達の判定に使います。</p>
      <p><strong>変数と条件：</strong>Cₜはt日の終値、HₜとLₜは日中高値・安値。Nは急騰率、Dは下落率、Uは続伸率（いずれも%）。rₜ＝100(Cₜ/Cₜ₋₁−1) ≥ N を急騰とします。直前の完全な窓と比較できるよう最初のW本は起点にしません。</p>
      <p><strong>波の位置：</strong>hₜ＝max(Hⱼ)、lₜ＝min(Lⱼ)、j＝t−W＋1,…,t。位置＝100(Cₜ−lₜ)/(hₜ−lₜ)。分子は安値からの距離、分母はレンジ幅なので、下限0・上限100に換算できます。幅0なら未定義。高値経過日数＝t−argmax Hⱼ、安値経過日数＝t−argmin Lⱼ。同値は直近を採用します。</p>
      <p>位置80以上は上位20%、20以下は下位20%。高値更新はHₜ &gt; hₜ₋₁、安値更新はLₜ &lt; lₜ₋₁。hₜ &lt; hₜ₋₁やlₜ &gt; lₜ₋₁は古い極値の窓落ちです。高い位置にいること自体は下落予告ではありません。</p>
      <p><strong>初到達：</strong>基準Bₜ,ₖは起点基準ならCₜ、最高終値基準ならmax(Cₜ,…,Cₜ₊ₖ)、前日基準ならCₜ₊ₖ₋₁。Tᴅ＝min{'{'}k≥1 : 100(1−Cₜ₊ₖ/Bₜ,ₖ) ≥ D{'}'}。続伸はTᵤ＝min{'{'}k≥1 : 100(Cₜ₊ₖ/Cₜ−1) ≥ U{'}'}。最高終値にはその日までの値しか使いません。</p>
      <p><strong>未到達とKM：</strong>A＝min(H,残りの観測本数)、Y＝min(Tᴅ,A)、δ＝1{'{'}Tᴅ≤A{'}'}。未到達を除かず「Y日までは下落しなかった」という右打ち切りとして保持します。nₖ＝Σ1{'{'}Y≥k{'}'}、dₖ＝Σ1{'{'}Y＝k,δ＝1{'}'} として、S(k)＝∏ⱼ₌₁ᵏ(1−dⱼ/nⱼ)、F(k)＝1−S(k)。各日の未到達割合を掛けて生存確率Sを求め、補数が累積到達確率Fです。同日発生・打ち切りは両方nに含めます。翌日未観測の起点はnに含めません。nが尽きた先は未推定（全件到達済みは100%）。中央値は初めてF≥0.5になる日で、到達例だけの中央値ではありません。</p>
      <p><strong>経路・先着：</strong>全H日を観測できた事例だけでRₜ(k)＝100(Cₜ₊ₖ/Cₜ−1)を集計。分位点は昇順x、a＝(m−1)qとしてx⌊a⌋＋(a−⌊a⌋)(x⌈a⌉−x⌊a⌋)、q＝0.25,0.5,0.75。先着割合は該当件数/完全観測件数。下落前最大上昇率はmax(0,Rₜ(k):1≤k&lt;Tᴅ)、未到達ならk≤Hです。これらと、途中観測を含むKMでは母集団が異なります。</p>
      <p><strong>直感的な例：</strong>100→103と急騰し、翌日104、2日後100なら、N＝3%、D＝2%の起点基準で2営業日後に到達（100/103−1 ≒ −2.91%）。その前に104まで上昇（約＋0.97%）しています。下がる確率と、待つ間の続伸を両方見るための分析です。</p>
      <p><strong>標本の選び方：</strong>重複除外時は採用起点tからt＋Hまで次の起点を採らず、t＋H＋1から再開。下落の速さで間隔を変えません。通常日はrₜ&lt;Nで同じ位置条件を満たす日を別々に間引きます。比較は記述的で、二群の追跡区間は互いに重なる場合があります。</p>
      <p><strong>活用と限界：</strong>位置条件を固定して通常日との差、標本数、後半の日数に残る追跡対象数、続伸先着を確認します。実行可能な売買成績ではなく、引け後に確定する条件の履歴集計です。翌日の約定・コスト・滑りは含まず、独立性や打ち切りの非情報性も保証されません。条件を試すほど過剰適合しやすいため、条件を固定した後の未使用期間で再確認してください。窓の高安は将来の山・谷を当てる指標ではなく、株式分割・配当・欠損・データ修復の影響も受けます。</p>
    </AnalysisGuide>
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded bg-gray-50 p-3"><div className="text-xs text-gray-600">{label}</div><div className="mt-1 break-words font-semibold text-gray-900">{value}</div></div>;
}
