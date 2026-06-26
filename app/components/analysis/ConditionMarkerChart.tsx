"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  createSeriesMarkers,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type IPriceLine,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  conditionalForwardReturns,
  buildStateFn,
  buildStateSeries,
  STATE_AXES,
  REVERSAL_AXES,
  TREND_AXES,
  CANDLE_RUN_AXES,
  CALENDAR_AXES,
  StateAxis,
  StateSeries,
} from "../../lib/conditional-forward-returns";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  minBars?: number;
}

const ALL_AXES: { value: StateAxis; label: string }[] = [
  ...STATE_AXES,
  ...REVERSAL_AXES,
  ...TREND_AXES,
  ...CANDLE_RUN_AXES,
  ...CALENDAR_AXES,
];

const HORIZONS = [1, 5, 10, 20];
const HEIGHT = 360;
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

// 各 i の状態確定後 N日先フォワードリターン（マーカー色分け用）。エンジンと同じ建て方。
function forwardReturnAt(
  prices: PricePoint[],
  i: number,
  horizon: number,
  entry: "close" | "open"
): number | null {
  const n = prices.length;
  let entryPx: number, exitPx: number;
  if (entry === "close") {
    if (i + horizon >= n) return null;
    entryPx = prices[i].close;
    exitPx = prices[i + horizon].close;
  } else {
    if (i + 1 + horizon >= n) return null;
    entryPx = prices[i + 1].open;
    exitPx = prices[i + 1 + horizon].open;
  }
  if (!(entryPx > 0) || !(exitPx > 0)) return null;
  return (exitPx - entryPx) / entryPx;
}

export default function ConditionMarkerChart({ prices, minBars = 250 }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  // 判定根拠の指標ペイン
  const indContainerRef = useRef<HTMLDivElement>(null);
  const indChartRef = useRef<IChartApi | null>(null);
  const indSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const indMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const indLinesRef = useRef<IPriceLine[]>([]);

  const [axis, setAxis] = useState<StateAxis>(ALL_AXES[0].value);
  const [horizon, setHorizon] = useState(5);
  const [entry, setEntry] = useState<"close" | "open">("close");
  const [stateLabel, setStateLabel] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selRange, setSelRange] = useState<{ from: number; to: number } | null>(null);

  // 状態関数とバケット順（全履歴で計算）
  const st = useMemo(
    () => (prices.length >= minBars ? buildStateFn(prices, axis) : null),
    [prices, axis, minBars]
  );

  // 状態判定の根拠となる指標系列（数値で表せる軸のみ）
  const indicator = useMemo<StateSeries | null>(
    () => (prices.length >= minBars ? buildStateSeries(prices, axis) : null),
    [prices, axis, minBars]
  );

  // 軸を変えたら状態ラベルを「現在の状態」に初期化
  const nowLabel = useMemo(() => {
    if (!st) return null;
    for (let i = prices.length - 1; i >= 0; i--) {
      const l = st.stateOf(i);
      if (l !== null) return l;
    }
    return null;
  }, [st, prices]);
  useEffect(() => {
    setStateLabel((prev) => (st && prev && st.order.includes(prev) ? prev : nowLabel));
  }, [st, nowLabel]);

  // 選択期間 → 集計対象述語（価格はスライスせずサンプルのみ限定）
  const accept = useMemo(() => {
    if (!selRange) return undefined;
    const { from, to } = selRange;
    return (i: number) => i >= from && i <= to;
  }, [selRange]);

  const result = useMemo(() => {
    if (!st) return null;
    return conditionalForwardReturns(prices, st, horizon, { entry, accept });
  }, [st, prices, horizon, entry, accept]);

  const selBucket = result?.buckets.find((b) => b.label === stateLabel) ?? null;
  const baseMean = result?.baselineMean ?? 0;

  // ── チャート初期化（マウント時一度だけ） ──
  const stateRefs = useRef({ prices, st, horizon, entry, stateLabel, selectMode, selRange });
  stateRefs.current = { prices, st, horizon, entry, stateLabel, selectMode, selRange };

  const drawHighlight = (x1: number | null, x2: number | null) => {
    const ov = overlayRef.current;
    if (!ov) return;
    if (x1 == null || x2 == null) { ov.style.display = "none"; return; }
    const left = Math.min(x1, x2);
    const w = Math.abs(x2 - x1);
    ov.style.display = "block";
    ov.style.left = `${left}px`;
    ov.style.width = `${w}px`;
  };

  const redrawFromRange = () => {
    const chart = chartRef.current;
    const r = stateRefs.current.selRange;
    if (!chart || !r) { drawHighlight(null, null); return; }
    const ts = chart.timeScale();
    drawHighlight(ts.logicalToCoordinate(r.from as never), ts.logicalToCoordinate(r.to as never));
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: HEIGHT,
      crosshair: { mode: 0 },
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;
    const series = chart.addSeries(LineSeries, { color: "#334155", lineWidth: 2, title: "株価" });
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);

    // 判定根拠の指標チャート（価格と時間軸を同期）
    let indChart: IChartApi | null = null;
    if (indContainerRef.current) {
      indChart = createChart(indContainerRef.current, {
        layout: { background: { color: "#ffffff" }, textColor: "#333" },
        grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f7f7f7" } },
        width: indContainerRef.current.clientWidth,
        height: 130,
        crosshair: { mode: 0 },
        rightPriceScale: { visible: true },
        timeScale: { timeVisible: false },
      });
      indChartRef.current = indChart;
      const indSeries = indChart.addSeries(LineSeries, { color: "#2563eb", lineWidth: 1, title: "判定指標" });
      indSeriesRef.current = indSeries;
      indMarkersRef.current = createSeriesMarkers(indSeries, []);

      // 双方向の時間軸同期（ロックで再帰防止）
      let lock = false;
      const sync = (src: IChartApi, dst: IChartApi) => {
        const r = src.timeScale().getVisibleLogicalRange();
        if (r) dst.timeScale().setVisibleLogicalRange(r);
      };
      chart.timeScale().subscribeVisibleLogicalRangeChange(() => { if (lock) return; lock = true; sync(chart, indChart!); lock = false; });
      indChart.timeScale().subscribeVisibleLogicalRangeChange(() => { if (lock) return; lock = true; sync(indChart!, chart); lock = false; });
    }

    const idxFromClientX = (clientX: number): number | null => {
      const cont = containerRef.current;
      if (!cont) return null;
      const x = clientX - cont.getBoundingClientRect().left;
      const logical = chart.timeScale().coordinateToLogical(x);
      if (logical == null) return null;
      const len = stateRefs.current.prices.length;
      return Math.max(0, Math.min(len - 1, Math.round(logical as number)));
    };

    let dragStartClientX: number | null = null;
    const onDown = (e: MouseEvent) => {
      if (!stateRefs.current.selectMode) return;
      dragStartClientX = e.clientX;
    };
    const onMove = (e: MouseEvent) => {
      if (dragStartClientX == null) return;
      const cont = containerRef.current;
      if (!cont) return;
      const rect = cont.getBoundingClientRect();
      drawHighlight(dragStartClientX - rect.left, e.clientX - rect.left);
    };
    const onUp = (e: MouseEvent) => {
      if (dragStartClientX == null) return;
      const a = idxFromClientX(dragStartClientX);
      const b = idxFromClientX(e.clientX);
      dragStartClientX = null;
      if (a != null && b != null && Math.abs(a - b) >= 2) {
        setSelRange({ from: Math.min(a, b), to: Math.max(a, b) });
      } else {
        redrawFromRange();
      }
    };
    const cont = containerRef.current;
    cont.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    chart.timeScale().subscribeVisibleLogicalRangeChange(redrawFromRange);

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
      if (indContainerRef.current && indChart) indChart.applyOptions({ width: indContainerRef.current.clientWidth });
      redrawFromRange();
    };
    window.addEventListener("resize", onResize);

    return () => {
      cont.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("resize", onResize);
      chart.remove();
      indChart?.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
      indChartRef.current = null;
      indSeriesRef.current = null;
      indMarkersRef.current = null;
      indLinesRef.current = [];
    };
  }, []);

  // 株価データ
  useEffect(() => {
    if (!seriesRef.current) return;
    seriesRef.current.setData(prices.map((p) => ({ time: p.time as Time, value: p.close })));
    chartRef.current?.timeScale().fitContent();
    redrawFromRange();
  }, [prices]);

  // 判定根拠の指標系列 + しきい値ライン
  useEffect(() => {
    const s = indSeriesRef.current;
    if (!s) return;
    indLinesRef.current.forEach((pl) => s.removePriceLine(pl));
    indLinesRef.current = [];
    if (!indicator) { s.setData([]); indMarkersRef.current?.setMarkers([]); return; }
    const data = [];
    for (let i = 0; i < prices.length; i++) {
      const v = indicator.values[i];
      if (v != null && isFinite(v)) data.push({ time: prices[i].time as Time, value: v });
    }
    s.setData(data);
    indicator.thresholds.forEach((t) => {
      const pl = s.createPriceLine({
        price: t.value, color: "#94a3b8", lineWidth: 1, lineStyle: LineStyle.Dashed,
        axisLabelVisible: true, title: t.label,
      });
      indLinesRef.current.push(pl);
    });
    // 価格チャートの表示範囲に合わせる
    const r = chartRef.current?.timeScale().getVisibleLogicalRange();
    if (r) indChartRef.current?.timeScale().setVisibleLogicalRange(r);
  }, [indicator, prices]);

  // 範囲選択モードでチャートのパン/ズームを無効化
  useEffect(() => {
    chartRef.current?.applyOptions({ handleScroll: !selectMode, handleScale: !selectMode });
    indChartRef.current?.applyOptions({ handleScroll: !selectMode, handleScale: !selectMode });
  }, [selectMode]);

  // 選択ハイライトの再描画
  useEffect(() => { redrawFromRange(); }, [selRange]);

  // 条件発生マーカー（選択状態の点灯日を、その後N日リターンの符号で色分け）
  useEffect(() => {
    if (!markersRef.current || !st || !stateLabel) {
      markersRef.current?.setMarkers([]);
      return;
    }
    const ms: SeriesMarker<Time>[] = [];
    for (let i = 0; i < prices.length; i++) {
      if (st.stateOf(i) !== stateLabel) continue;
      const fr = forwardReturnAt(prices, i, horizon, entry);
      const up = fr != null && fr > 0;
      const inSel = !selRange || (i >= selRange.from && i <= selRange.to);
      ms.push({
        time: prices[i].time as Time,
        position: "belowBar",
        color: fr == null ? "#9ca3af" : up ? "#16a34a" : "#dc2626",
        shape: "arrowUp",
        size: inSel ? 1 : 0.6,
      } as SeriesMarker<Time>);
    }
    markersRef.current.setMarkers(ms);
    // 指標ペインにも同じ点灯マーカー（線上に重ね、どの値で点灯したか示す）
    if (indMarkersRef.current) {
      indMarkersRef.current.setMarkers(
        indicator ? ms.map((m) => ({ ...m, position: "aboveBar" }) as SeriesMarker<Time>) : []
      );
    }
  }, [st, stateLabel, horizon, entry, prices, selRange, indicator]);

  if (prices.length < minBars || !st || !result) return null;

  const markerCount = (() => {
    let c = 0;
    for (let i = 0; i < prices.length; i++) if (st.stateOf(i) === stateLabel) c++;
    return c;
  })();
  const selDays = selRange
    ? `${prices[selRange.from].time} 〜 ${prices[selRange.to].time}（${selRange.to - selRange.from + 1}営業日）`
    : "全期間";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">条件発生マーカー & 区間クロスフィルタ</h3>
        <div className="flex gap-1">
          {(["close", "open"] as const).map((e) => (
            <button
              key={e}
              onClick={() => setEntry(e)}
              className={`px-2.5 py-1 text-xs rounded font-medium ${entry === e ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {e === "close" ? "当日引け建て" : "翌日寄り建て"}
            </button>
          ))}
        </div>
      </div>

      {/* 状態軸 */}
      <div className="flex gap-1 flex-wrap">
        {ALL_AXES.map((a) => (
          <button
            key={a.value}
            onClick={() => setAxis(a.value)}
            className={`px-2.5 py-1 text-xs rounded font-medium ${axis === a.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >
            {a.label}
          </button>
        ))}
      </div>

      {/* 状態ラベル + ホライズン */}
      <div className="flex items-center gap-2 text-xs text-gray-600 flex-wrap">
        <span>表示する状態:</span>
        <select
          value={stateLabel ?? ""}
          onChange={(e) => setStateLabel(e.target.value)}
          className="px-2 py-1 border border-gray-300 rounded"
        >
          {st.order.map((o) => (
            <option key={o} value={o}>{o}{o === nowLabel ? "（現在）" : ""}</option>
          ))}
        </select>
        <span className="ml-2">先行き日数 N:</span>
        {HORIZONS.map((h) => (
          <button
            key={h}
            onClick={() => setHorizon(h)}
            className={`px-2 py-0.5 rounded ${horizon === h ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
          >
            {h}日
          </button>
        ))}
      </div>

      {/* クロスフィルタ操作 */}
      <div className="flex items-center gap-3 text-xs flex-wrap rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
        <button
          onClick={() => setSelectMode((v) => !v)}
          className={`px-2.5 py-1 rounded font-medium ${selectMode ? "bg-indigo-600 text-white" : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-100"}`}
        >
          {selectMode ? "🔍 範囲選択モード ON（チャートをドラッグ）" : "範囲選択モード OFF"}
        </button>
        <span className="text-gray-600">対象期間: <span className="font-medium text-gray-800">{selDays}</span></span>
        {selRange && (
          <button onClick={() => setSelRange(null)} className="px-2 py-1 rounded bg-white border border-gray-300 text-gray-600 hover:bg-gray-100">
            全期間に戻す
          </button>
        )}
      </div>

      {/* 現在の集計サマリー（選択期間で再計算） */}
      {selBucket && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          <span className="font-bold">状態「{stateLabel}」</span>
          {" の"}{horizon}日先: 平均 <span className="font-bold">{fmtPct(selBucket.meanFwd)}</span>
          {"・勝率 "}<span className="font-bold">{(selBucket.winRate * 100).toFixed(0)}%</span>
          {"（n="}{selBucket.n}{"、基準平均 "}{fmtPct(baseMean)}{" 比 "}
          <span className="font-bold">{fmtPct(selBucket.meanFwd - baseMean)}</span>{"）  "}
          <StatBadge n={selBucket.n} p={selBucket.p} significant={selBucket.significant} />
        </div>
      )}

      {/* 価格チャート + 選択ハイライト */}
      <div ref={wrapperRef} className="relative w-full select-none">
        <div ref={containerRef} className="w-full rounded border border-gray-100" />
        <div
          ref={overlayRef}
          className="pointer-events-none absolute top-0 bg-indigo-400/15 border-x-2 border-indigo-400"
          style={{ display: "none", height: HEIGHT }}
        />
      </div>

      {/* 判定根拠の指標ペイン（価格と時間同期） */}
      <div>
        <div className="text-[11px] font-medium text-gray-600 mb-1">
          判定根拠の指標{indicator ? `: ${indicator.label}` : ""}（▲=条件点灯 / 点線=バケット境界）
        </div>
        <div ref={indContainerRef} className={`w-full rounded border border-gray-100 ${indicator ? "" : "hidden"}`} />
        {!indicator && (
          <p className="text-[11px] text-gray-400">この軸（{ALL_AXES.find((a) => a.value === axis)?.label}）は数値指標として表せないため、根拠系列は表示できません。RSI(2)・前日リターン・直近高値からの下落・連続下落日数 等の軸でご確認ください。</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block w-0 h-0" style={{ borderLeft: "4px solid transparent", borderRight: "4px solid transparent", borderBottom: "7px solid #16a34a" }} /> 点灯後{horizon}日 上昇</span>
        <span className="flex items-center gap-1"><span className="inline-block w-0 h-0" style={{ borderLeft: "4px solid transparent", borderRight: "4px solid transparent", borderBottom: "7px solid #dc2626" }} /> 点灯後{horizon}日 下落</span>
        <span className="text-gray-400">状態「{stateLabel}」点灯 {markerCount}回</span>
      </div>

      <AnalysisGuide title="条件発生マーカー & 区間クロスフィルタの詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"条件付き分析で定義した『状態』が実際にいつ・どの価格水準で点灯したかを、株価チャート上に▲マーカーで重ねる（条件発生マーカー）。さらにチャートをドラッグして任意区間を選ぶと、その期間だけで条件付き集計を再計算する（区間クロスフィルタ）。テーブルから入る既存の分析とは逆に、チャートを起点に有利な局面を視覚的に探せる。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 使い方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>状態軸 / 表示する状態</strong>を選ぶと、その状態が成立した日に▲が並ぶ。▲の色は<strong>点灯後N日のリターンの符号</strong>（緑=上昇 / 赤=下落 / 灰=データ不足）。過去にそのシグナルがどれだけ機能したかが点ごとに分かる。</li>
          <li><strong>範囲選択モード ON</strong>にしてチャートを左右にドラッグすると、選択帯（青）が引かれ、上部サマリーがその期間だけで再計算される。「全期間に戻す」で解除。</li>
          <li>選択範囲外の▲は小さく表示され、集計から除外される。</li>
          <li><strong>判定根拠の指標ペイン</strong>（価格チャートの下、時間軸を同期）に、状態判定のもとになった指標値（RSI・前日リターン・直近高値からの下落 等）と<strong>バケット境界（点線）</strong>を表示。各▲が「指標がどの水準に達して点灯したか」を線上で確認でき、条件発生の理由が一目で分かる。数値で表せない軸（トレンド・カレンダー系）では非表示。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 計算（先読みバイアスを排除）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>状態</strong>は i 日終値時点で確定する情報のみで判定。<strong>マーカー色</strong>の N日先リターンは結果であり、点灯時点では未知（▲の位置＝シグナル、色＝後から分かる結果）。</li>
          <li><strong>区間クロスフィルタ</strong>は価格系列をスライスせず、指標は全履歴で計算したまま<strong>集計対象の日だけを限定</strong>する。これにより区間先頭でも RSI 等のウォームアップが壊れない。</li>
          <li>サマリーの平均・勝率・95%CI・有意性は条件付きフォワードリターン・エンジンと同一（移動ブロック・ブートCt + Benjamini-Hochberg FDR）。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>緑の▲が連続する局面＝そのシグナルが機能していた相場。赤が増える区間＝機能不全。<strong>レジームによる効きの違い</strong>を目で確認できる。</li>
          <li>気になる急落・急騰の局面をドラッグで切り出し、「この相場ではこの条件は有効か」を局所検証できる。</li>
          <li>直近の▲（最新の点灯日）が現在のエントリー検討材料。サマリーの基準比がプラスかつ有意なら順張り/逆張りの後押し。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>区間を狭めるほど n が減り、平均・有意性が不安定になる。サマリーの n と「参考(n小)」バッジを必ず確認。</li>
          <li>マーカー色は将来情報を使った事後評価であり、リアルタイムの判定ではない。</li>
          <li>取引コスト・スリッページ未控除。短いNでは特に効く。</li>
          <li>状態境界（RSI=30 等）は固定値。境界付近は誤差が出やすい。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
