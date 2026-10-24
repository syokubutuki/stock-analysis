"use client";

// ストレス退避規則（stress-hyst）— 明日の寄りで持つか、現金にするか。
// 計算は app/lib/derisk-rule.ts（純粋関数）。設計は docs/derisk-rule-design.md §3。
//
// 画面の約束:
//   ・最上位に「保険であり、年率の上積みは有意でない」と書く（研究の結論）
//   ・既定のパラメータは研究値で固定。編集中は「研究の設定での判定」を並列表示して、
//     調整して都合のよい判定を出す経路を塞ぐ
//   ・α(t) は出さない（方向は頑健だが大きさは非有意。見出しに置くと上積みと誤読される）

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type IPriceLine,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  LIGHT_KEYS,
  RESEARCH_PARAMS,
  computeDerisk,
  type DeriskMetrics,
  type DeriskParams,
  type DeriskResult,
  type DeriskState,
  type Light,
} from "../../lib/derisk-rule";
import { ROBUST_KEYS, ROBUST_LABELS, type RobustKey, type RobustResult } from "../../lib/derisk-robust";
import type { DeriskWorkerRequest, DeriskWorkerResponse } from "../../lib/derisk-rule.worker";
import { useBenchmarkSet } from "../../hooks/useBenchmarkSet";
import { describeSanityReport } from "../../lib/price-sanity";
import { representativeSpread } from "../../lib/spread-estimator";
import { CHART_COLORS } from "../../lib/chart-colors";
import AnalysisGuide from "./AnalysisGuide";
import StrategyVsBenchmark from "./StrategyVsBenchmark";
import { useAnalysisResultSummary } from "./AccordionSection";

const PANEL_ID = "regime-derisk";
const BENCH = ["^VIX", "KRE"] as const;
const PARAMS_KEY = "sa:derisk:params:v1";
const N_NULL = 1000;
const N_BOOT = 2000;
const BLOCK_LEN = 20;

/** 研究 §6 で「V字型：買い持ちより悪化」と記録された局面。エピソードがこの窓に重なれば印を付ける。 */
const V_SHAPE_WINDOWS: { label: string; from: string; to: string }[] = [
  { label: "2024年8月", from: "2024-07-04", to: "2024-09-30" },
  { label: "2026年3月", from: "2026-02-20", to: "2026-04-30" },
];

const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(d)}%`);
const signed = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));

function isRatio(key: Light["key"]): boolean {
  return key === "vixRatio" || key === "volRatio";
}
function fmtValue(l: Light): string {
  return isRatio(l.key) ? num(l.value, 2) : pct(l.value, 1);
}
function fmtThreshold(l: Light): string {
  return isRatio(l.key) ? `> ${l.threshold.toFixed(2)}` : `< ${pct(l.threshold, 0)}`;
}
/** 余裕の表示。比率型は閾値に対する割合、下落型は pt。 */
function fmtMargin(l: Light): string {
  if (!Number.isFinite(l.margin)) return "—";
  return isRatio(l.key) ? `${(l.margin * 100).toFixed(0)}%` : `${(l.margin * 100).toFixed(1)}pt`;
}
/** 閾値に近い（比率型 10% 未満・下落型 2pt 未満）。点灯中は別扱い。 */
function isNear(l: Light): boolean {
  if (l.lit) return false;
  return isRatio(l.key) ? l.margin < 0.1 : l.margin < 0.02;
}

function fmtRobust(key: RobustKey, v: number): string {
  return key === "sharpe" ? num(v) : pct(v);
}
function fmtDiff(key: RobustKey, v: number): string {
  if (!Number.isFinite(v)) return "—";
  return key === "sharpe" ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}pt`;
}
/** 見出しに添える短い判定。量は出さず向きだけ。 */
function verdictLabel(r: RobustResult): string {
  const mdd = r.null.find((s) => s.key === "maxDrawdown")!;
  if (r.null.every((s) => s.pGe <= 0.05)) return "：3指標とも偶然より良い";
  if (mdd.pGe <= 0.05) return "：最大DDだけ偶然より浅い";
  return "：この期間では偶然と区別できない";
}
function verdictLines(r: RobustResult): string[] {
  const out: string[] = [];
  const nul = Object.fromEntries(r.null.map((s) => [s.key, s])) as Record<RobustKey, RobustResult["null"][number]>;
  const boot = Object.fromEntries(r.boot.map((s) => [s.key, s])) as Record<RobustKey, RobustResult["boot"][number]>;
  const good = ROBUST_KEYS.filter((k) => nul[k].pGe <= 0.05);
  const bad = ROBUST_KEYS.filter((k) => nul[k].pGe >= 0.5);
  if (good.length === 3) out.push("① 現金期間の「位置」に意味がある: 同じ本数・長さを偶然に置くと3指標とも実際より悪い（P ≤ 0.05）。");
  else if (good.length > 0) out.push(`① 偶然より良いのは ${good.map((k) => ROBUST_LABELS[k]).join("・")} だけ。${bad.length ? `${bad.map((k) => ROBUST_LABELS[k]).join("・")} は偶然の配置の方が良い回が過半です。` : "残りは偶然と区別できません。"}`);
  else out.push("① この期間では、現金期間を偶然の位置に置いても同程度の成績が出ます。規則の「位置」に意味があるとは言えません。");
  const mddOk = boot.maxDrawdown.pPositive >= 0.9;
  const cagrOk = boot.cagr.lo5 > 0;
  if (mddOk && !cagrOk) out.push(`② 並べ替えても最大DDは浅くなる（P(>0)=${boot.maxDrawdown.pPositive.toFixed(2)}）が、年率差の90%区間は 0 をまたぐ。保険であって上積みではない、という研究の結論と同じ向きです。`);
  else if (mddOk && cagrOk) out.push("② 並べ替えても最大DDは浅くなり、年率差の90%区間も 0 を上回ります。この期間では上積みも出ていますが、研究の全期間では年率差は 0 をまたぎます。");
  else if (boot.maxDrawdown.pPositive <= 0.5) out.push("② 並べ替えると最大DDが買い持ちより深くなる回が過半。この期間では保険としても効いていません（V字型の急落を逃した期間が支配的）。");
  else out.push(`② 最大DD差は P(>0)=${boot.maxDrawdown.pPositive.toFixed(2)} で、浅くなる傾向はあるが決め手に欠けます。`);
  out.push("③ 全期間（2006〜）での研究の結果は下の記録のとおり。この画面の数字が弱いのは期間の違いで、規則が壊れた証拠ではありませんが、強い証拠でもありません。");
  return out;
}

function sameParams(a: DeriskParams, b: DeriskParams): boolean {
  return (Object.keys(RESEARCH_PARAMS) as (keyof DeriskParams)[]).every((k) => a[k] === b[k]);
}

function loadParams(): DeriskParams {
  try {
    const raw = localStorage.getItem(PARAMS_KEY);
    if (!raw) return RESEARCH_PARAMS;
    const p = JSON.parse(raw) as Partial<DeriskParams>;
    const out = { ...RESEARCH_PARAMS };
    for (const k of Object.keys(RESEARCH_PARAMS) as (keyof DeriskParams)[]) {
      const v = p[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return RESEARCH_PARAMS;
  }
}

function baseChart(el: HTMLDivElement, height: number, timeVisible: boolean, leftScale: boolean): IChartApi {
  return createChart(el, {
    layout: { background: { color: "#ffffff" }, textColor: "#333" },
    grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
    width: el.clientWidth,
    height,
    crosshair: { mode: 0 },
    rightPriceScale: { visible: true, borderColor: "#e5e7eb" },
    leftPriceScale: { visible: leftScale, borderColor: "#e5e7eb", mode: leftScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal },
    timeScale: { timeVisible: false, visible: timeVisible, borderColor: "#e5e7eb" },
  });
}

/** 3ペインの時間軸を相互同期する（EdgeDecayChart と同じ）。 */
function syncCharts(charts: IChartApi[]) {
  const unsubs: (() => void)[] = [];
  for (const src of charts) {
    const handler = (range: { from: number; to: number } | null) => {
      if (!range) return;
      for (const dst of charts) if (dst !== src) dst.timeScale().setVisibleLogicalRange(range);
    };
    src.timeScale().subscribeVisibleLogicalRangeChange(handler);
    unsubs.push(() => src.timeScale().unsubscribeVisibleLogicalRangeChange(handler));
  }
  return () => unsubs.forEach((u) => u());
}

function MetricRow({ label, rule, bh }: { label: string; rule: DeriskMetrics | null; bh: DeriskMetrics | null }) {
  return (
    <tr className="border-b border-gray-100">
      <td className="py-1 px-1.5 text-gray-600">{label}</td>
      <td className="text-right px-1.5 font-mono">{rule ? pct(rule.cagr) : "—"}</td>
      <td className="text-right px-1.5 font-mono">{rule ? pct(rule.maxDrawdown) : "—"}</td>
      <td className="text-right px-1.5 font-mono">{rule ? num(rule.sharpe) : "—"}</td>
      <td className="text-right px-1.5 font-mono text-gray-500">{bh ? pct(bh.cagr) : "—"}</td>
      <td className="text-right px-1.5 font-mono text-gray-500">{bh ? pct(bh.maxDrawdown) : "—"}</td>
      <td className="text-right px-1.5 font-mono text-gray-500">{bh ? num(bh.sharpe) : "—"}</td>
      <td className="text-right px-1.5 font-mono text-gray-500">{rule ? pct(rule.inMarket, 0) : "—"}</td>
      <td className="text-right px-1.5 font-mono text-gray-500">{rule ? `${rule.turnover.toFixed(1)}/年` : "—"}</td>
    </tr>
  );
}

function StateCard({ state, title, muted }: { state: DeriskState; title: string; muted?: boolean }) {
  const tone = state.holding
    ? state.stress > 0 ? "border-amber-300 bg-amber-50" : "border-green-200 bg-green-50"
    : "border-red-300 bg-red-50";
  return (
    <div className={`rounded border p-3 ${muted ? "opacity-80" : ""} ${tone}`}>
      <div className="text-[11px] text-gray-600">{title}</div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3">
        <span className={`text-xl font-bold ${state.holding ? "text-green-800" : "text-red-800"}`}>{state.holding ? "保有" : "現金"}</span>
        <span className="font-mono text-sm text-gray-800">点灯 {state.stress} / 4</span>
      </div>
    </div>
  );
}

export default function DeriskRuleChart({ prices, ticker }: { prices: PricePoint[]; ticker: string }) {
  const bench = useBenchmarkSet(BENCH);
  const [params, setParams] = useState<DeriskParams>(RESEARCH_PARAMS);
  const [paramsLoaded, setParamsLoaded] = useState(false);
  const [selectedEpisode, setSelectedEpisode] = useState<number | null>(null);

  // localStorage から復元（hydration 後に1回）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setParams(loadParams());
    setParamsLoaded(true);
  }, []);
  useEffect(() => {
    if (!paramsLoaded) return;
    try {
      if (sameParams(params, RESEARCH_PARAMS)) localStorage.removeItem(PARAMS_KEY);
      else localStorage.setItem(PARAMS_KEY, JSON.stringify(params));
    } catch { /* 保存できなくても動く */ }
  }, [params, paramsLoaded]);

  const closeOnly = useMemo(
    () => prices.length > 0 && prices.every((p) => p.volume === 0 && p.open === p.close && p.high === p.close && p.low === p.close),
    [prices],
  );

  const vix = bench.entries.get("^VIX")?.prices ?? null;
  const kre = bench.entries.get("KRE")?.prices ?? null;

  const result: DeriskResult | null = useMemo(() => {
    if (!vix || !kre || prices.length < 120) return null;
    return computeDerisk({ target: prices, vix, kre, ticker, params });
  }, [prices, vix, kre, ticker, params]);

  const tuned = !sameParams(params, RESEARCH_PARAMS);
  const baseline: DeriskResult | null = useMemo(() => {
    if (!tuned || !vix || !kre || prices.length < 120) return null;
    return computeDerisk({ target: prices, vix, kre, ticker, params: RESEARCH_PARAMS });
  }, [tuned, prices, vix, kre, ticker]);

  const spreadRT = useMemo(() => representativeSpread(prices), [prices]);

  // ───────── 頑健性（Worker・オンデマンド） ─────────
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const [robust, setRobust] = useState<{ key: string; result: RobustResult } | null>(null);
  const [robustRunning, setRobustRunning] = useState(false);
  const [robustError, setRobustError] = useState<string | null>(null);
  useEffect(() => () => { workerRef.current?.terminate(); workerRef.current = null; }, []);

  const headState = result?.next ?? result?.latest ?? null;
  useAnalysisResultSummary(
    PANEL_ID,
    headState
      ? !headState.holding
        ? { status: "finding", direction: "down", label: `退避中（${headState.stress}/4）` }
        : headState.stress > 0
          ? { status: "finding", direction: "down", label: `警戒（${headState.stress}/4）` }
          : { status: "none" }
      : { status: "none" },
  );

  const repaired = useMemo(() => {
    const out: string[] = [];
    for (const [t, e] of bench.entries) {
      const msg = describeSanityReport(e.dataQuality);
      if (msg && e.dataQuality && (e.dataQuality.repaired.length > 0 || e.dataQuality.suspects.length > 0)) out.push(`${t}: ${msg}`);
    }
    return out;
  }, [bench.entries]);

  // ───────── チャート ─────────
  const priceRef = useRef<HTMLDivElement>(null);
  const stressRef = useRef<HTMLDivElement>(null);
  const marginRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<IChartApi[]>([]);
  const seriesRef = useRef<{
    price: ISeriesApi<"Line">; eqRule: ISeriesApi<"Line">; eqBh: ISeriesApi<"Line">; band: ISeriesApi<"Histogram">;
    stress: ISeriesApi<"Line">; margins: ISeriesApi<"Line">[]; zero: ISeriesApi<"Line">;
  } | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<{ series: ISeriesApi<"Line">; line: IPriceLine }[]>([]);
  const hasChart = Boolean(result && result.rows.length > 0);

  useEffect(() => {
    if (!hasChart || !priceRef.current || !stressRef.current || !marginRef.current) return;
    const pc = baseChart(priceRef.current, 260, false, true);
    const sc = baseChart(stressRef.current, 120, false, false);
    const mc = baseChart(marginRef.current, 170, true, false);
    const band = pc.addSeries(HistogramSeries, { priceScaleId: "band", color: "rgba(220, 38, 38, 0.13)", base: 0, priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
    pc.priceScale("band").applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
    const price = pc.addSeries(LineSeries, { priceScaleId: "left", color: CHART_COLORS.neutral, lineWidth: 1, title: "価格", priceFormat: { type: "price", precision: 0, minMove: 1 } });
    const eqRule = pc.addSeries(LineSeries, { color: "#2563eb", lineWidth: 2, title: "退避規則", priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
    const eqBh = pc.addSeries(LineSeries, { color: "#9ca3af", lineWidth: 1, lineStyle: LineStyle.Dotted, title: "買い持ち", priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
    const stress = sc.addSeries(LineSeries, { color: "#b45309", lineWidth: 2, lineType: LineType.WithSteps, title: "点灯数", priceFormat: { type: "price", precision: 0, minMove: 1 } });
    const colors = ["#7c3aed", "#0891b2", "#dc2626", "#ea580c"];
    const labels = ["VIX比", "ボラ比", "60日DD", "KRE DD"];
    const margins = LIGHT_KEYS.map((_, i) => mc.addSeries(LineSeries, { color: colors[i], lineWidth: 1, title: labels[i], priceFormat: { type: "price", precision: 2, minMove: 0.01 } }));
    const zero = mc.addSeries(LineSeries, { color: CHART_COLORS.reference, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });
    chartsRef.current = [pc, sc, mc];
    seriesRef.current = { price, eqRule, eqBh, band, stress, margins, zero };
    markersRef.current = createSeriesMarkers(price, []);
    const unsync = syncCharts([pc, sc, mc]);
    const onResize = () => {
      if (priceRef.current) pc.applyOptions({ width: priceRef.current.clientWidth });
      if (stressRef.current) sc.applyOptions({ width: stressRef.current.clientWidth });
      if (marginRef.current) mc.applyOptions({ width: marginRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      unsync();
      [pc, sc, mc].forEach((c) => c.remove());
      chartsRef.current = [];
      seriesRef.current = null;
      markersRef.current = null;
      priceLinesRef.current = [];
    };
  }, [hasChart]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s || !result) return;
    for (const { series, line } of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];
    markersRef.current?.setMarkers([]);

    const closeByTime = new Map(prices.map((p) => [p.time, p.close]));
    const priceData: { time: Time; value: number }[] = [];
    const ruleData: { time: Time; value: number }[] = [];
    const bhData: { time: Time; value: number }[] = [];
    const bandData: { time: Time; value: number }[] = [];
    const stressData: { time: Time; value: number }[] = [];
    const marginData: { time: Time; value: number }[][] = LIGHT_KEYS.map(() => []);
    const zeroData: { time: Time; value: number }[] = [];
    let eqR = 0, eqB = 0;
    for (const r of result.rows) {
      const t = r.time as Time;
      const c = closeByTime.get(r.time);
      if (c !== undefined) priceData.push({ time: t, value: c });
      // エクイティは「その日の寄りで建てて翌寄りまで」の累積。最終行は未定義なので直前までの値を置く
      ruleData.push({ time: t, value: Math.exp(eqR) });
      bhData.push({ time: t, value: Math.exp(eqB) });
      if (r.net !== null && r.yOo !== null) { eqR += r.net; eqB += r.yOo; }
      bandData.push({ time: t, value: r.w === 0 ? 1 : 0 });
      stressData.push({ time: t, value: r.stress });
      const f = { vixRatio: r.vixRatio, volRatio: r.volRatio, dd60: r.dd60, kreDd60: r.kreDd60 };
      LIGHT_KEYS.forEach((k, i) => {
        const v = f[k];
        const m = k === "vixRatio" || k === "volRatio" ? 1 - v / result.params[k] : v - result.params[k];
        if (Number.isFinite(m)) marginData[i].push({ time: t, value: m });
      });
      zeroData.push({ time: t, value: 0 });
    }
    s.price.setData(priceData);
    s.eqRule.setData(ruleData);
    s.eqBh.setData(bhData);
    s.band.setData(bandData);
    s.stress.setData(stressData);
    s.margins.forEach((ser, i) => ser.setData(marginData[i]));
    s.zero.setData(zeroData);
    priceLinesRef.current.push({ series: s.stress, line: s.stress.createPriceLine({ price: result.params.kIn, color: "#dc2626", lineWidth: 1, lineStyle: LineStyle.Dashed, title: "退避" }) });

    const markers: SeriesMarker<Time>[] = [];
    for (const e of result.episodes) {
      markers.push({ time: e.start as Time, position: "aboveBar", color: "#dc2626", shape: "arrowDown", text: "現金" });
      if (e.end) {
        const idx = result.rows.findIndex((r) => r.time === e.end);
        const back = idx >= 0 && idx + 1 < result.rows.length ? result.rows[idx + 1].time : null;
        if (back) markers.push({ time: back as Time, position: "belowBar", color: "#059669", shape: "arrowUp", text: "復帰" });
      }
    }
    markers.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    markersRef.current?.setMarkers(markers);
    chartsRef.current.forEach((c) => c.timeScale().fitContent());
  }, [result, prices]);

  // エピソードの行をクリック → その区間へズーム
  useEffect(() => {
    if (selectedEpisode === null || !result) return;
    const e = result.episodes[selectedEpisode];
    if (!e) return;
    const i0 = result.rows.findIndex((r) => r.time === e.start);
    if (i0 < 0) return;
    const i1 = e.end ? result.rows.findIndex((r) => r.time === e.end) : result.rows.length - 1;
    const from = result.rows[Math.max(0, i0 - 30)].time as Time;
    const to = result.rows[Math.min(result.rows.length - 1, i1 + 30)].time as Time;
    chartsRef.current.forEach((c) => c.timeScale().setVisibleRange({ from, to }));
  }, [selectedEpisode, result]);

  // ───────── 早期リターン（hooks の後） ─────────
  if (prices.length < 120) {
    return <p className="text-sm text-fg-muted">日足が120本以上必要です（現在 {prices.length} 本）。</p>;
  }
  if (bench.loading) {
    return <p className="text-sm text-fg-muted">VIX と米地銀株（KRE）を取得しています…（{bench.done}/{bench.total}）</p>;
  }
  if (!vix || !kre) {
    return <p className="text-sm text-red-700">参照系列の取得に失敗しました（{bench.failed.join(", ")}）。再読み込みしてください。</p>;
  }
  if (!result || result.rows.length === 0 || !result.latest) {
    return <p className="text-sm text-fg-muted">4指標が揃う行がありません（60日の暖機が要ります）。</p>;
  }

  const head = result.next ?? result.latest;
  const headIsNext = result.next !== null;
  const baseHead = baseline ? (baseline.next ?? baseline.latest) : null;
  const research = { cagr: 0.104, mdd: -0.336, sharpe: 0.48, bhCagr: 0.058, bhMdd: -0.83, bhSharpe: 0.17 };
  const vShape = (e: { start: string; end: string | null }) =>
    V_SHAPE_WINDOWS.find((w) => e.start <= w.to && (e.end ?? "9999-12-31") >= w.from) ?? null;

  const evalRows = result.rows.filter((r) => r.yOo !== null);
  const strategyDaily = evalRows.map((r) => r.w * (r.yOo as number));
  const buyHoldDaily = evalRows.map((r) => r.yOo as number);
  let switches = 0;
  for (let i = 1; i < evalRows.length; i++) switches += Math.abs(evalRows[i].w - evalRows[i - 1].w);
  const robustKey = `${ticker}|${evalRows.length}|${evalRows[evalRows.length - 1]?.time ?? ""}|${result.costOneWay}|${JSON.stringify(params)}`;
  const robustResult = robust && robust.key === robustKey ? robust.result : null;
  const runRobust = () => {
    if (!workerRef.current) workerRef.current = new Worker(new URL("../../lib/derisk-rule.worker.ts", import.meta.url));
    const worker = workerRef.current;
    const reqId = ++reqIdRef.current;
    const key = robustKey;
    setRobustRunning(true);
    setRobustError(null);
    worker.onmessage = (ev: MessageEvent<DeriskWorkerResponse>) => {
      if (ev.data.reqId !== reqIdRef.current) return;
      setRobustRunning(false);
      if (ev.data.ok && ev.data.result) setRobust({ key, result: ev.data.result });
      else setRobustError(ev.data.error ?? "計算に失敗しました");
    };
    worker.onerror = () => { setRobustRunning(false); setRobustError("Worker の起動に失敗しました"); };
    const req: DeriskWorkerRequest = {
      reqId, y: buyHoldDaily, w: evalRows.map((r) => r.w), costOneWay: result.costOneWay,
      nNull: N_NULL, nBoot: N_BOOT, blockLen: BLOCK_LEN, seed: 20261023,
    };
    worker.postMessage(req);
  };
  const roundTrips = Math.max(1, Math.ceil(switches / 2));

  const setParam = (k: keyof DeriskParams, v: number) => setParams((p) => ({ ...p, [k]: v }));

  return (
    <div className="space-y-4 text-sm text-fg-body">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">ストレス退避規則 — 明日の寄りで持つか、現金にするか</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          4つのストレス指標のうち {result.params.kIn} つ以上が点灯したらその日の寄りから全額現金、全指標が {result.params.calmN} 営業日連続で消灯したら復帰。
          方向は当てない。荒れている状態を避けるだけ。
        </p>
        <p className="text-xs mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900">
          <b>これは保険です。</b> 研究（3メガバンク・2006年〜）では最大DDが −83% → −34% に浅くなる一方、年率の上積みは有意ではなく（90%区間が 0 をまたぐ）、
          強い上昇相場では劣後し、<b>1日で終わる急落（2024年8月・2026年3月型）では買い持ちより悪化</b>しました。
        </p>
      </div>

      {closeOnly && (
        <p className="text-xs text-amber-800">この系列は終値だけ（始値＝終値）なので、4灯の状態は出せますが、寄り約定を仮定する成績表は意味を持ちません。</p>
      )}

      {/* A. 判定ヘッダー */}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="space-y-2">
          <StateCard state={head} title={headIsNext ? `次の立会日 ${head.time} の建玉` : `データ最終日 ${head.time} の建玉`} />
          {!head.holding && (
            <div className="text-xs text-gray-700">復帰カウント <span className="font-mono">{head.calm} / {result.params.calmN}</span>（全消灯が連続した営業日数）</div>
          )}
          {headIsNext && result.latest && (
            <div className="text-[11px] text-gray-500">データ最終日 {result.latest.time}: 点灯 {result.latest.stress}/4・{result.latest.holding ? "保有" : "現金"}</div>
          )}
          {baseHead && (
            <StateCard state={baseHead} title="研究の設定での判定（既定）" muted />
          )}
          <div className="text-[11px] text-gray-500 leading-relaxed">
            米国データ: {head.usAsOf} の終値{head.usStale ? "（その日の米国終値は未着。朝6〜7時に更新されます）" : "（最新）"}
            <br />履歴の開始 {result.historyStart}（状態機械は経路依存。10年取得と長期取得で途中の判定が違いえます）
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse min-w-[360px]">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 px-1.5">指標</th>
                <th className="text-right px-1.5">現在値</th>
                <th className="text-right px-1.5">点灯条件</th>
                <th className="text-right px-1.5">余裕</th>
                <th className="text-left px-1.5">状態</th>
              </tr>
            </thead>
            <tbody>
              {head.lights.map((l) => {
                const near = isNear(l);
                const cls = l.lit ? "bg-red-50 text-red-800" : near ? "bg-amber-50 text-amber-900" : "";
                return (
                  <tr key={l.key} className={`border-b border-gray-100 ${cls}`}>
                    <td className="py-1 px-1.5">{l.label}</td>
                    <td className="text-right px-1.5 font-mono">{fmtValue(l)}</td>
                    <td className="text-right px-1.5 font-mono text-gray-500">{fmtThreshold(l)}</td>
                    <td className="text-right px-1.5 font-mono">{fmtMargin(l)}</td>
                    <td className="px-1.5">{l.lit ? "点灯" : near ? "閾値に近い" : "消灯"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-[11px] text-gray-500 mt-1">余裕は正＝安全側。比率型は閾値に対する割合、下落型は閾値までの pt。閾値に近い行は翌日点灯しえます。</p>
        </div>
      </div>

      {repaired.length > 0 && (
        <p className="text-[11px] text-amber-800">参照系列の修復: {repaired.join(" / ")}</p>
      )}

      {/* B. 3ペイン */}
      <div>
        <div className="text-xs text-gray-500 mb-1">価格（左軸・対数）と、寄り→翌寄りの累積エクイティ（右軸、青＝退避規則／灰点線＝買い持ち）。赤い帯＝現金化区間、▼退避・▲復帰</div>
        <div ref={priceRef} className="w-full rounded border border-gray-100" />
      </div>
      <div>
        <div className="text-xs text-gray-500 mb-1">点灯数（0〜4）。赤破線 = 退避の閾値 {result.params.kIn}</div>
        <div ref={stressRef} className="w-full rounded border border-gray-100" />
      </div>
      <div>
        <div className="text-xs text-gray-500 mb-1">4指標の余裕（正＝安全側）。破線の 0 が閾値で、下回れば点灯</div>
        <div ref={marginRef} className="w-full rounded border border-gray-100" />
      </div>

      {/* C. 成績 */}
      {!closeOnly && evalRows.length > 60 && (
        <div className="space-y-2">
          <StrategyVsBenchmark
            mode="returns"
            strategyDaily={strategyDaily}
            buyHoldDaily={buyHoldDaily}
            roundTrips={roundTrips}
            spreadRT={spreadRT}
            label="退避規則"
            defaultDeduct
          />
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse min-w-[560px]">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-1.5">区間（片道 {(result.costOneWay * 1e4).toFixed(0)}bp）</th>
                  <th className="text-right px-1.5">年率</th>
                  <th className="text-right px-1.5">最大DD</th>
                  <th className="text-right px-1.5">Sharpe</th>
                  <th className="text-right px-1.5 text-gray-400">B&H 年率</th>
                  <th className="text-right px-1.5 text-gray-400">B&H DD</th>
                  <th className="text-right px-1.5 text-gray-400">B&H Sh</th>
                  <th className="text-right px-1.5">滞在率</th>
                  <th className="text-right px-1.5">回転</th>
                </tr>
              </thead>
              <tbody>
                {result.metrics && <MetricRow label={`全期間 ${result.historyStart}〜`} rule={result.metrics.rule} bh={result.metrics.buyHold} />}
                {result.byEra.map((e) => <MetricRow key={e.label} label={e.label} rule={e.rule} bh={e.buyHold} />)}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
            <span className="text-gray-500">コスト感度:</span>
            {result.costSensitivity.map((c) => (
              <span key={c.costBp} className="font-mono">{c.costBp}bp → {pct(c.rule.cagr)} / {pct(c.rule.maxDrawdown)} / {num(c.rule.sharpe)}</span>
            ))}
          </div>
          <p className="text-[11px] text-gray-500 leading-relaxed">
            研究の数値（3メガバンク等ウェイト・2006-09〜・片道5bp）: 退避規則 年率 {pct(research.cagr)} / 最大DD {pct(research.mdd)} / Sharpe {num(research.sharpe)}、
            買い持ち {pct(research.bhCagr)} / {pct(research.bhMdd)} / {num(research.bhSharpe)}。
            画面の数値は1銘柄・取得できた期間（{result.historyStart}〜）なので、2008年の下落を含むかどうかで大きく違います。
            年率換算は研究と同じ 245 営業日。B&amp;H は寄り→翌寄りの系列。
          </p>
        </div>
      )}

      {/* D. エピソード */}
      <div>
        <div className="text-xs text-gray-500 mb-1">現金化エピソード（行をクリックで区間へズーム）。B&amp;H 累積が正なら「逃した」、負なら「守れた」</div>
        {result.episodes.length === 0 ? (
          <p className="text-xs text-gray-500">この期間に退避はありません。</p>
        ) : (
          <div className="overflow-x-auto max-h-64 overflow-y-auto">
            <table className="w-full text-xs border-collapse min-w-[520px]">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-1.5">退避</th>
                  <th className="text-left px-1.5">復帰</th>
                  <th className="text-right px-1.5">日数</th>
                  <th className="text-left px-1.5">退避時に点灯</th>
                  <th className="text-right px-1.5">区間の B&amp;H</th>
                  <th className="text-left px-1.5">結果</th>
                </tr>
              </thead>
              <tbody>
                {result.episodes.map((e, i) => {
                  const v = vShape(e);
                  const missed = e.bhReturn !== null && e.bhReturn > 0;
                  return (
                    <tr
                      key={e.start}
                      onClick={() => setSelectedEpisode(i)}
                      className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${selectedEpisode === i ? "bg-blue-50" : ""}`}
                    >
                      <td className="py-1 px-1.5 font-mono">{e.start}</td>
                      <td className="px-1.5 font-mono">{e.end ?? "継続中"}</td>
                      <td className="text-right px-1.5 font-mono">{e.days}</td>
                      <td className="px-1.5 text-gray-600">{e.litAtEntry.map((k) => ({ vixRatio: "VIX", volRatio: "ボラ", dd60: "DD", kreDd60: "KRE" })[k]).join("+")}</td>
                      <td className={`text-right px-1.5 font-mono ${e.bhReturn === null ? "text-gray-400" : missed ? "text-red-700" : "text-green-700"}`}>{signed(e.bhReturn)}</td>
                      <td className="px-1.5">
                        {e.bhReturn === null ? "—" : missed ? "逃した" : "守れた"}
                        {v && <span className="ml-1 rounded bg-red-100 px-1 text-[10px] text-red-800">V字型（{v.label}）</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* E. 頑健性（Worker・オンデマンド） */}
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-700">頑健性（偶然との比較）{robustResult ? verdictLabel(robustResult) : ""}</summary>
        <div className="mt-2 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={runRobust}
              disabled={robustRunning || closeOnly || evalRows.length <= 60}
              className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {robustRunning ? "計算中…" : robustResult ? "再計算" : "偶然との比較を計算"}
            </button>
            <span className="text-gray-500">
              ランダム配置ヌル {N_NULL} 回＋定常ブロックブートストラップ {N_BOOT} 回（平均ブロック長 {BLOCK_LEN} 日）。この銘柄の評価行 {evalRows.length} 日、現金化 {result.episodes.length} 本{tuned ? "。いまのパラメータで計算します" : ""}。
            </span>
          </div>
          {closeOnly && <p className="text-amber-700">終値のみの系列では寄り約定を仮定できないため計算しません。</p>}
          {robustError && <p className="text-red-600">{robustError}</p>}

          {robustResult && (
            <>
              <div className="overflow-x-auto">
                <p className="text-gray-700 mb-1">① ランダム配置ヌル: 同じ本数・同じ長さの現金期間を偶然の位置に置いたときの成績分布と、実際の成績</p>
                <table className="w-full text-xs border-collapse min-w-[560px]">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1 pr-2 font-normal">指標</th>
                      <th className="text-right py-1 px-2 font-normal">偶然 5%</th>
                      <th className="text-right py-1 px-2 font-normal">偶然 50%</th>
                      <th className="text-right py-1 px-2 font-normal">偶然 95%</th>
                      <th className="text-right py-1 px-2 font-normal">実際</th>
                      <th className="text-right py-1 pl-2 font-normal">P(偶然 ≥ 実際)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {robustResult.null.map((s) => (
                      <tr key={s.key} className="border-b border-gray-100">
                        <td className="py-1 pr-2">{ROBUST_LABELS[s.key]}{s.key === "maxDrawdown" ? "（≥ は「偶然の方が浅い」）" : ""}</td>
                        <td className="text-right py-1 px-2 font-mono">{fmtRobust(s.key, s.p5)}</td>
                        <td className="text-right py-1 px-2 font-mono">{fmtRobust(s.key, s.p50)}</td>
                        <td className="text-right py-1 px-2 font-mono">{fmtRobust(s.key, s.p95)}</td>
                        <td className="text-right py-1 px-2 font-mono font-semibold">{fmtRobust(s.key, s.actual)}</td>
                        <td className={`text-right py-1 pl-2 font-mono ${s.pGe <= 0.05 ? "text-emerald-700" : s.pGe >= 0.5 ? "text-red-600" : "text-gray-700"}`}>{s.pGe.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {robustResult.nullPlacementFailed > 0 && (
                  <p className="text-gray-500 mt-1">配置に失敗した試行 {robustResult.nullPlacementFailed} 回（置けた区間だけで評価。研究と同じ扱い）。</p>
                )}
              </div>

              <div className="overflow-x-auto">
                <p className="text-gray-700 mb-1">② 定常ブロックブートストラップ: 日次リターンをブロックで並べ替え直したときの差（退避規則 − 買い持ち）</p>
                <table className="w-full text-xs border-collapse min-w-[480px]">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1 pr-2 font-normal">差</th>
                      <th className="text-right py-1 px-2 font-normal">中央値</th>
                      <th className="text-right py-1 px-2 font-normal">90% 区間</th>
                      <th className="text-right py-1 pl-2 font-normal">P(差 &gt; 0)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {robustResult.boot.map((s) => (
                      <tr key={s.key} className="border-b border-gray-100">
                        <td className="py-1 pr-2">{ROBUST_LABELS[s.key]}{s.key === "maxDrawdown" ? "（正＝浅い）" : ""}</td>
                        <td className="text-right py-1 px-2 font-mono font-semibold">{fmtDiff(s.key, s.median)}</td>
                        <td className="text-right py-1 px-2 font-mono">[{fmtDiff(s.key, s.lo5)}, {fmtDiff(s.key, s.hi95)}]</td>
                        <td className={`text-right py-1 pl-2 font-mono ${s.pPositive >= 0.95 ? "text-emerald-700" : s.pPositive <= 0.5 ? "text-red-600" : "text-gray-700"}`}>{s.pPositive.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="list-disc pl-4 space-y-0.5 text-gray-700">
                {verdictLines(robustResult).map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </>
          )}

          <div className="text-gray-600">
            <p className="text-gray-700">研究の記録（3メガ平均・2006-09〜・片道5bp）</p>
            <ul className="list-disc pl-4 mt-1 space-y-0.5">
              <li>ランダム配置ヌル 1000 回: 最大DD −71% [−81, −56] vs 実際 −34%、年率 3.7% [0.3, 7.1] vs 10.4%、Sharpe 0.15 [0.01, 0.30] vs 0.48。3指標とも偶然が上回る割合 0.1% 以下。</li>
              <li>定常ブロックブートストラップ 2000 回: 最大DD差 +24.5pt [+4.2, +44.8] P=0.98、Sharpe差 +0.31 [+0.01, +0.60] P=0.96、年率差 +4.4pt [−4.5, +13.4] P=0.80（0 をまたぐ）。</li>
              <li>972 設定のグリッド: すべての設定で最大DDが買い持ちより浅い。Sharpe ≥ 買い持ちが 94%。ただし α の t&gt;2 は 2%（方向は頑健、大きさは小さい）。</li>
              <li>設計に使っていない銘柄（りそな・三井住友トラスト・千葉銀・ふくおか・トヨタ・ソニー・1321）: 最大DDは7中6で改善、年率は一貫しない。</li>
              <li>画面の数字と違う理由: ここは1銘柄・10年取得（2008 年を含まない）。研究の強さの大半は 2008 年の −80% を避けたことから来ており、上昇相場だけの標本では規則は偶然と区別できないのが普通です（2018〜 の時代別で年率が劣後するのと同じ現象）。</li>
            </ul>
          </div>
        </div>
      </details>

      {/* F. パラメータ */}
      <details className="text-xs" open={tuned}>
        <summary className="cursor-pointer text-gray-700">パラメータ{tuned ? "（研究の設定から外れています）" : "（研究の設定）"}</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-4">
          {([
            ["vixRatio", "VIX ÷ 20日平均 >", 0.05, 1, 3],
            ["volRatio", "5日ボラ ÷ 60日ボラ >", 0.1, 1, 4],
            ["dd60", "60日高値比 <", 0.01, -0.5, 0],
            ["kreDd60", "KRE 60日高値比 <", 0.01, -0.5, 0],
            ["kIn", "退避の点灯数 ≥", 1, 1, 4],
            ["calmN", "復帰の連続消灯日数", 1, 1, 30],
            ["kOut", "消灯とみなす点灯数 ≤", 1, 0, 3],
          ] as [keyof DeriskParams, string, number, number, number][]).map(([k, label, step, min, max]) => (
            <label key={k} className="flex items-center justify-between gap-2">
              <span className="text-gray-600">{label}</span>
              <input
                id={`derisk-${k}`}
                type="number"
                step={step}
                min={min}
                max={max}
                value={params[k]}
                onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setParam(k, v); }}
                className="w-20 px-1.5 py-0.5 border border-gray-200 rounded font-mono text-right"
              />
            </label>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => setParams(RESEARCH_PARAMS)} className="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50" disabled={!tuned}>研究値に戻す</button>
          <span className="text-gray-500">グリッドでは復帰日数 3/5/8/12 で同様の効果（尖った点ではない）。V字対策の変種（20日DD・速い指標だけで復帰・復帰短縮）は7件すべて不成立。ここで調整しても in-sample が増えるだけです。</span>
        </div>
      </details>

      <AnalysisGuide title="ストレス退避規則の詳細理論">
        <p className="font-medium text-gray-700">1. 手法の概要</p>
        <p>
          翌日の方向は当てられないが、「荒れているか」という状態は当てられる——銀行株のデリスク研究で確かめた、この非対称性だけを使う規則です。
          前日までに確定した4つの指標（米国のボラ指数、自銘柄の短期ボラの拡大、自銘柄の下落、米地銀株の下落）を数え、2つ以上が点灯したら翌営業日の寄りで全額現金、
          全部が消えて5営業日たったら寄りで戻ります。狙いは損益の平均を上げることではなく、「平均が期待を下回るのにボラが巨大な期間」を建玉ゼロで通過することです。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>日本の立会日 t の判断は t の朝7時。日本側は t−1 までの終値、米国側は日付が t より厳密に小さい最新の行を使います（先読み防止）。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"VIX比: v_j / mean(v_{j−19..j})、j は t より前の最新の米国営業日。閾値 1.25 を上回ると点灯。"}</li>
          <li>{"ボラ比: sd(r_{t−5..t−1}) / sd(r_{t−60..t−1})、r_i = ln C_i − ln C_{i−1}、sd は標本標準偏差（n−1 で割る）。閾値 1.8。"}</li>
          <li>{"60日高値比: C_{t−1} / max(C_{t−60..t−1}) − 1（有効本数 20 以上）。閾値 −12% を下回ると点灯。"}</li>
          <li>{"KRE 60日高値比: 米国の暦で K_j / max(K_{j−59..j}) − 1 を作ってから asof で引く。閾値 −12%。"}</li>
          <li>{"点灯数 s_t = Σ 1[点灯]。状態機械: 保有中に s_t ≥ 2 なら現金（その日の寄りから）。現金中は s_t ≤ 0 が連続した日数を数え、5 に達した日の寄りで保有へ。1 灯でも点けばカウントは 0 に戻る。"}</li>
          <li>{"評価: y_t = ln(O_{t+1}/O_t)（寄りで建て翌寄りまで）、純リターン n_t = w_t·y_t − c·|w_t − w_{t−1}|、片道 c = 5bp 既定（初日に片道1回分）。年率 = exp(Σn / (N/245)) − 1、最大DD は exp(累積) の最高値比。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 専門用語の日本語定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>ヒステリシス</b>: 入る条件と出る条件を別に置き、境界付近での往復（点いたり消えたり）を抑える仕組み。</li>
          <li><b>実現ボラ</b>: 過去の日次リターンの標準偏差。5日と60日の比が大きいほど「最近だけ荒れている」。</li>
          <li><b>ドローダウン（DD）</b>: 直近の高値からの下落率。最大DDはその最悪値。</li>
          <li><b>VIX</b>: S&amp;P500 オプションから逆算した市場の予想ボラ。<b>KRE</b>: 米地銀株ETF。邦銀と同じ金利・信用リスクに晒される。</li>
          <li><b>asof（厳密に小さい最新）</b>: 判断時刻に確定していた最新の値。同日の米国終値は使わない。</li>
          <li><b>ランダム配置ヌル</b>: 同じ長さ・本数の現金期間を偶然の位置に置いたときの成績分布。実際がそれより良いかで「規則に意味があるか」を見る。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          火災報知器と避難訓練です。煙・熱・隣家の警報・近隣の火事（4つの感知器）のうち2つが鳴ったら外へ出る。鳴り止んでもすぐ戻らず5分待つ。
          感度を上げれば誤報で何度も外に出て「戻りを逃す」。感度を下げれば初動が遅れる。研究で選んだのは、20年の火事の記録で最も焼け死なない設定であって、
          最も儲かる設定ではありません。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>判定ヘッダーの「次の立会日の建玉」が結論。点灯 2 以上で現金、現金中は復帰カウント 5 で保有。</li>
          <li>余裕が 2pt（下落型）または 10%（比率型）を切っている指標は、翌日点灯しえます。前夜の米国で動く VIX・KRE は朝6〜7時に更新されます。</li>
          <li>成績表の最大DDが買い持ちより浅いのが規則の効果。年率は上がっても下がっても偶然の範囲です（研究の90%区間は 0 をまたぐ）。</li>
          <li>エピソード表で「逃した」が並ぶ時期（V字型）はこの規則の弱点そのもの。指標が前日確定値なので、1日で終わる急落は避けられません。</li>
          <li>10年取得では 2008 年を含まないため、研究の数字（−83% → −34%）は再現しません。長期取得（range=max）が入ると一致します。</li>
          <li>頑健性: ランダム配置ヌルの「P(偶然 ≥ 実際)」が 0.05 以下なら現金期間の位置に意味があり、0.5 以上なら偶然の方が良い回が過半です。ブートストラップの最大DD差は P(&gt;0) が 0.9 以上で「並べ替えても浅い」。年率差の90%区間が 0 をまたげば上積みは言えません。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>変えるのは建玉の大きさ |q| を 1 か 0 の2値だけ。符号・対象・保有期間は変えません。</li>
          <li>年に3回程度しか動かないので、毎朝この画面を開く運用は続きません。通知（寄り前ブリーフ）と組み合わせる前提です。</li>
          <li>信用でレバレッジをかけている場合は追証回避の効果が大きい（吸収壁を避ける）。NISA 口座では売却枠の復活規則と税の非対称に注意。</li>
          <li>V字型への備えはこの規則の外（建玉サイズの事前制限・先物やオプションでのヘッジ）で考えます。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>設計の大半を 2018 年以降のデータを見て決め、最終設定の微調整は全期間を見て行いました。2006〜2017 年は時間外の検証にあたりますが、完全な前向き検証ではありません。</li>
          <li>評価は3メガバンクの等ウェイト。3行の相関は高く独立な標本ではありません。設計外の銘柄では年率が一貫しません（1321 は最大DDも改善せず年率が劣後）。</li>
          <li>約定は寄りの仮定。配当・分割は調整後終値に含まれ（再投資扱い）、税・信用金利・現金の運用益は未考慮。</li>
          <li>状態機械は経路依存です。履歴の開始日が違えば途中の判定が違いえます（復帰が一度成立すれば以後は一致）。</li>
          <li>画面でパラメータを調整して良く見える設定を選ぶ行為は、in-sample の最適化です。研究の設定での判定を常に並べているのはそのためです。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">公理的位置づけ（株式原論）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>立脚する公準/命題</b>: 公理5（破産の吸収壁）・命題2（サイジングの独立性）・系C11（ドローダウン管理）・系C17（レジーム切替下の Φ）</li>
          <li><b>測る P の性質</b>: 条件付き分散の拡大と直近高値からの下落という「状態」。方向 E[dP] ではない</li>
          <li><b>変える q の選択</b>: 建玉の大きさ |q| を {"{1, 0}"} で切り替える</li>
          <li><b>摩擦の扱い</b>: 回転は年3回程度。片道 5bp 既定、0/10/20bp の感度を常設</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
