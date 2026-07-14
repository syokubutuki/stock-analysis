"use client";

// 曜日 × 前夜米国ビン 交互作用パスの「ウォッチリスト横断」比較（多面メトリクス版）。
// 選んだ前夜米国ビンの翌日に絞り、各銘柄の曜日別の日内特性を、日中/前日比/ギャップ/上値到達/
// 下値到達/レンジ/勝率/終値位置/ボラ/シャープ/高安時刻/日内パス形状 の各面からヒートマップ化。
// 対象期間はローリング可能(最新起点で窓長可変 or 窓長固定で位置スライド)。末尾に全銘柄プールの
// 「横断平均」行(日付クラスタ頑健SE)を置き、固有 vs 共通を切り分ける。

import { useCallback, useMemo, useState } from "react";
import { useIntradayBasket } from "../../hooks/useIntraday";
import { useUsDaily, US_DRIVERS } from "../../hooks/useUsDaily";
import { groupByDay, buildBinGrid, BinGrid } from "../../lib/intraday-core";
import { computeUsReturns, BinScheme } from "../../lib/us-spillover-core";
import {
  UsMode, CrossStock, DateWindow, CellStats, ConsensusCell,
  prepCross, computeCrossBinning, computeCrossRows,
  CROSS_WD_ORDER, CROSS_WD_LABELS, minuteToLabel,
} from "../../lib/weekday-us-cross";
import { UsDriverButtons, BinSchemeButtons, intervalToMin } from "./usSpilloverShared";
import { IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct } from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  tickers: string[];
  names?: Record<string, string>;
}

const US_MODES: { value: UsMode; label: string; formula: string }[] = [
  { value: "ret", label: "前日終値比", formula: "ln(当日終値 / 前日終値)（オーバーナイト含む米国当日騰落）" },
  { value: "intra", label: "日中", formula: "ln(当日終値 / 当日始値)（米国正規セッション内）" },
];

// ───────────────────────── メトリクス定義 ─────────────────────────

type ColorKind = "div" | "divHalf" | "seq" | "timeGrid" | "timeMin" | "count" | "shape";
type Fmt = "pctS" | "pct" | "num2" | "pct0" | "timeGrid" | "timeMin" | "int" | "none";

interface Metric {
  key: string;
  label: string;
  group: string;
  color: ColorKind;
  fmt: Fmt;
  get: (c: CellStats) => number;
  p?: (c: CellStats) => number;
  hint: string;
}

const METRICS: Metric[] = [
  // リターン
  { key: "intraday", label: "日中(寄→引)", group: "リターン", color: "div", fmt: "pctS", get: (c) => c.intraday, p: (c) => c.intradayP, hint: "寄付で買い引けで売った平均。日中トレードの素の期待値。" },
  { key: "full", label: "前日比(前引→引)", group: "リターン", color: "div", fmt: "pctS", get: (c) => c.full, p: (c) => c.fullP, hint: "前日終値からの当日騰落(オーバーナイト込み)。実際の保有損益に近い。" },
  { key: "gap", label: "ギャップ(前引→寄)", group: "リターン", color: "div", fmt: "pctS", get: (c) => c.gap, p: (c) => c.gapP, hint: "夜間に開いた窓。寄付までに前夜米国を織り込んだ分。" },
  // 値幅・到達
  { key: "mfe", label: "上値到達(高/寄)", group: "値幅・到達", color: "div", fmt: "pctS", get: (c) => c.mfe, hint: "寄付から高値までの平均。日中どこまで上げたか=利確余地。" },
  { key: "mae", label: "下値到達(安/寄)", group: "値幅・到達", color: "div", fmt: "pctS", get: (c) => c.mae, hint: "寄付から安値までの平均(通常マイナス)。含み損の深さ=ストップ目安。" },
  { key: "range", label: "日中レンジ(高/安)", group: "値幅・到達", color: "seq", fmt: "pct", get: (c) => c.range, hint: "高値÷安値の平均。その日の値動きの大きさ。" },
  { key: "vol", label: "ボラ(日中σ)", group: "値幅・到達", color: "seq", fmt: "pct", get: (c) => c.vol, hint: "日中リターンの標準偏差。ばらつき=リスク。" },
  // 質
  { key: "winRate", label: "勝率(引>寄)", group: "トレード質", color: "divHalf", fmt: "pct0", get: (c) => c.winRate, hint: "引けが寄りを上回った日の割合。50%が中立。" },
  { key: "clv", label: "終値位置(安0-高1)", group: "トレード質", color: "divHalf", fmt: "pct0", get: (c) => c.clv, hint: "引けが日中レンジのどこか。1に近い=引け強い(大引け天井)、0=引け弱い。" },
  { key: "sharpe", label: "シャープ(平均/σ)", group: "トレード質", color: "div", fmt: "num2", get: (c) => c.sharpe, hint: "日中平均÷σ。リスク調整後の質。|0.2|超で強め。" },
  // 時刻
  { key: "peak", label: "上値ピーク時刻", group: "時刻", color: "timeGrid", fmt: "timeGrid", get: (c) => c.peakIdx, hint: "平均パスが最大になる時刻=利確の目安。" },
  { key: "trough", label: "最安時刻", group: "時刻", color: "timeGrid", fmt: "timeGrid", get: (c) => c.troughIdx, hint: "平均パスが最小になる時刻=仕込み/損切りの目安。" },
  { key: "highTime", label: "高値時刻(中央)", group: "時刻", color: "timeMin", fmt: "timeMin", get: (c) => c.highMin, hint: "その日の高値を付けた時刻の中央値。" },
  { key: "lowTime", label: "安値時刻(中央)", group: "時刻", color: "timeMin", fmt: "timeMin", get: (c) => c.lowMin, hint: "その日の安値を付けた時刻の中央値。" },
  // その他
  { key: "n", label: "データ数", group: "その他", color: "count", fmt: "int", get: (c) => c.n, hint: "そのセルの立会日数。少ないほど不安定。" },
  { key: "shape", label: "日内パス形状＋高安時刻", group: "その他", color: "shape", fmt: "none", get: () => 0, hint: "寄り基準の平均累積パス(±1σ帯)に、上値ピーク/最安(平均パス基準)と高値/安値の時刻中央(各日実測)の4マーカーを重ねて同時表示。" },
];

const METRIC_GROUPS = ["リターン", "値幅・到達", "トレード質", "時刻", "その他"];

// ───────────────────────── 配色・整形 ─────────────────────────

interface ColorCtx { scale: number; maxN: number; G: number; sessStart: number; sessEnd: number; }

function cellBg(m: Metric, v: number, ctx: ColorCtx): string {
  switch (m.color) {
    case "div": {
      const t = ctx.scale > 0 ? Math.max(-1, Math.min(1, v / ctx.scale)) : 0;
      const a = Math.abs(t) * 0.85 + 0.06;
      return t >= 0 ? `rgba(22,163,74,${a})` : `rgba(220,38,38,${a})`;
    }
    case "divHalf": {
      const t = Math.max(-1, Math.min(1, (v - 0.5) / 0.5));
      const a = Math.abs(t) * 0.8 + 0.05;
      return t >= 0 ? `rgba(22,163,74,${a})` : `rgba(220,38,38,${a})`;
    }
    case "seq": {
      const t = ctx.scale > 0 ? Math.max(0, Math.min(1, v / ctx.scale)) : 0;
      return `rgba(217,119,6,${t * 0.8 + 0.05})`;
    }
    case "timeGrid": {
      const frac = ctx.G > 1 ? v / (ctx.G - 1) : 0;
      return `rgba(37,99,235,${0.1 + frac * 0.55})`;
    }
    case "timeMin": {
      const span = ctx.sessEnd - ctx.sessStart;
      const frac = span > 0 ? Math.max(0, Math.min(1, (v - ctx.sessStart) / span)) : 0;
      return `rgba(37,99,235,${0.1 + frac * 0.55})`;
    }
    case "count": {
      const frac = ctx.maxN > 0 ? v / ctx.maxN : 0;
      return `rgba(22,163,74,${frac * 0.7 + 0.04})`;
    }
    default:
      return "transparent";
  }
}

function cellIntensity(m: Metric, v: number, ctx: ColorCtx): number {
  switch (m.color) {
    case "div": return ctx.scale > 0 ? Math.abs(v / ctx.scale) : 0;
    case "divHalf": return Math.abs((v - 0.5) / 0.5);
    case "seq": return ctx.scale > 0 ? v / ctx.scale : 0;
    case "timeGrid": return ctx.G > 1 ? v / (ctx.G - 1) : 0;
    case "timeMin": { const s = ctx.sessEnd - ctx.sessStart; return s > 0 ? (v - ctx.sessStart) / s : 0; }
    case "count": return ctx.maxN > 0 ? v / ctx.maxN : 0;
    default: return 0;
  }
}

function fmtValue(m: Metric, v: number, timeLabels: string[]): string {
  switch (m.fmt) {
    case "pctS": return fmtSignedPct(v, 1);
    case "pct": return `${(v * 100).toFixed(1)}%`;
    case "num2": return v.toFixed(2);
    case "pct0": return `${(v * 100).toFixed(0)}%`;
    case "timeGrid": return timeLabels[Math.round(v)] ?? "";
    case "timeMin": return minuteToLabel(Math.round(v));
    case "int": return String(Math.round(v));
    default: return "";
  }
}

function star(p: number): string {
  return p < 0.01 ? "★★" : p < 0.05 ? "★" : p < 0.1 ? "☆" : "";
}

function fmtBinRange(lo: number | null, hi: number | null): string {
  if (lo === null) return `≤ ${fmtSignedPct(hi!, 2)}`;
  if (hi === null) return `≥ ${fmtSignedPct(lo, 2)}`;
  return `${fmtSignedPct(lo, 2)} 〜 ${fmtSignedPct(hi, 2)}`;
}

// ───────────────────────── 本体 ─────────────────────────

export default function WeekdayUsCrossChart({ tickers, names }: Props) {
  const [usTicker, setUsTicker] = useState("^IXIC");
  const [interval, setInterval] = useState("60m");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const [usMode, setUsMode] = useState<UsMode>("ret");
  const [selBinRaw, setSelBinRaw] = useState<number | null>(null);
  const [metricKey, setMetricKey] = useState("intraday");
  // 対象期間: 0=全期間/最新 の既定なので、データ長が変わっても破綻しない(effectでのreset不要)。
  const [winMode, setWinMode] = useState<"latest" | "rolling">("latest");
  const [winLen, setWinLen] = useState(0); // 窓長(立会日). 0=全期間
  const [winEnd, setWinEnd] = useState(0); // 窓右端(1..D). 0=最新

  const resetBin = () => setSelBinRaw(null);
  const setUsTickerR = (t: string) => { setUsTicker(t); resetBin(); };
  const setUsModeR = (m: UsMode) => { setUsMode(m); resetBin(); };
  const setSchemeR = (s: BinScheme) => { setScheme(s); resetBin(); };

  const metric = METRICS.find((m) => m.key === metricKey)!;

  const uniqTickers = useMemo(
    () => Array.from(new Set(tickers.filter((t) => t && t.trim()))),
    [tickers]
  );
  const { ok, loading: bl, error: be } = useIntradayBasket(uniqTickers, interval);
  const { prices: usPrices, loading: ul, error: ue } = useUsDaily(usTicker);
  const loading = bl || ul;
  const error = be || ue;

  const built = useMemo(() => {
    if (ok.length === 0 || !usPrices) return null;
    const min = intervalToMin(interval);
    const stocks: CrossStock[] = [];
    let grid: BinGrid | null = null;
    for (const it of ok) {
      const resp = it.resp!;
      const days = groupByDay(resp.bars, resp.gmtoffset);
      const g = buildBinGrid(resp.bars, resp.gmtoffset, min);
      if (g && (!grid || g.bins.length > grid.bins.length)) grid = g;
      stocks.push({ ticker: it.ticker, name: names?.[it.ticker], days, gmtoffset: resp.gmtoffset });
    }
    if (!grid) return null;
    return { stocks, grid, us: computeUsReturns(usPrices) };
  }, [ok, usPrices, interval, names]);

  const prep = useMemo(
    () => (built ? prepCross(built.stocks, built.us, usMode) : null),
    [built, usMode]
  );

  // 対象期間(日付ウィンドウ)の導出
  const D = prep?.dateAxis.length ?? 0;
  const effEnd = winEnd > 0 ? Math.min(winEnd, D) : D;
  const rawLen = winLen > 0 ? winLen : D;
  const effWinLen = Math.min(rawLen, effEnd);
  const isFull = winMode === "latest" && effWinLen >= D;
  const dateWin: DateWindow | null = useMemo(() => {
    if (!prep || isFull || D === 0) return null;
    const start = prep.dateAxis[Math.max(0, effEnd - effWinLen)];
    const end = prep.dateAxis[Math.max(0, effEnd - 1)];
    return start && end ? { start, end } : null;
  }, [prep, isFull, D, effEnd, effWinLen]);
  const winStart = dateWin?.start ?? prep?.dateAxis[0] ?? "";
  const winEndDate = dateWin?.end ?? prep?.dateAxis[D - 1] ?? "";
  const barsAfter = D - effEnd;

  const setLen = useCallback((n: number) => {
    setWinLen(n);
    setWinEnd((prev) => (prev > 0 ? prev : 0)); // 最新起点は維持
  }, []);
  const switchMode = useCallback((m: "latest" | "rolling") => {
    if (m === "rolling") {
      setWinLen((prev) => (prev > 0 ? prev : Math.min(252, Math.max(20, D - 1))));
      setWinEnd(0);
    }
    setWinMode(m);
  }, [D]);

  const binning = useMemo(
    () => (prep ? computeCrossBinning(prep, scheme, usMode, dateWin) : null),
    [prep, scheme, usMode, dateWin]
  );
  const selBin = binning ? Math.min(selBinRaw ?? binning.todayBin, binning.meta.count - 1) : 0;

  const result = useMemo(
    () => (prep && built && binning ? computeCrossRows(prep, built.grid, scheme, usMode, binning.edges, selBin, dateWin) : null),
    [prep, built, binning, scheme, usMode, selBin, dateWin]
  );

  // 選択メトリクスの配色スケール(全セル+コンセンサスの分布から)
  const ctx: ColorCtx = useMemo(() => {
    const grid = built?.grid;
    const G = grid?.bins.length ?? 0;
    const base: ColorCtx = { scale: 0.01, maxN: 1, G, sessStart: grid?.sessionStart ?? 0, sessEnd: grid?.sessionEnd ?? 1 };
    if (!result) return base;
    const vals: number[] = [];
    let maxN = 1;
    const collect = (c: CellStats | null) => {
      if (!c) return;
      vals.push(metric.get(c));
      if (c.n > maxN) maxN = c.n;
    };
    for (const r of result.rows) for (const c of r.cells) collect(c);
    for (const c of result.consensus) collect(c);
    const abs = vals.map((v) => Math.abs(v)).filter((v) => isFinite(v)).sort((a, b) => a - b);
    const p90 = abs.length ? abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.9))] : 0.01;
    return { ...base, scale: Math.max(p90, metric.fmt === "num2" ? 0.05 : 0.002), maxN };
  }, [result, metric, built]);

  const usLabel = US_DRIVERS.find((d) => d.ticker === usTicker)?.label ?? usTicker;
  const modeMeta = US_MODES.find((m) => m.value === usMode)!;
  const selInfo = binning?.binInfos.find((b) => b.bin === selBin) ?? null;

  if (uniqTickers.length < 2) {
    return (
      <div className="text-sm text-gray-500">
        曜日×前夜米国の横断比較には、ウォッチリストに2銘柄以上が必要です。
      </div>
    );
  }

  const presets: [string, number][] = ([["3M", 63], ["6M", 126], ["1Y", 252], ["2Y", 504], ["3Y", 756]] as [string, number][])
    .filter(([, n]) => n < D);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-gray-500">
          選んだ前夜米国ビンの翌日に絞り、各銘柄の曜日別の日内特性を横断比較。末尾<span className="font-medium text-gray-700">横断平均</span>行は全銘柄プール(クラスタ頑健)。
        </p>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <UsDriverButtons value={usTicker} onChange={setUsTickerR} />
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">ビン基準:</span>
          {US_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setUsModeR(m.value)}
              title={m.formula}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                usMode === m.value ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <BinSchemeButtons value={scheme} onChange={setSchemeR} />
      </div>

      {/* ===== 対象期間コントロール(ローリング) ===== */}
      {prep && D > 0 && (
        <div className="rounded border border-gray-100 bg-gray-50/60 p-2.5 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-gray-600 font-medium">対象期間</span>
            <div className="inline-flex rounded overflow-hidden border border-gray-200">
              {([["latest", "最新起点"], ["rolling", "ローリング"]] as [typeof winMode, string][]).map(([m, lbl]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => switchMode(m)}
                  className={`px-2 py-0.5 text-[11px] ${winMode === m ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-100"}`}
                >{lbl}</button>
              ))}
            </div>
            <span className="text-gray-500">
              <span className="font-mono text-gray-700">{winStart}</span> 〜 <span className="font-mono text-gray-700">{winEndDate}</span>
              <span className="text-gray-400">（{effWinLen.toLocaleString()}立会日 ≈{(effWinLen / 252).toFixed(1)}年）</span>
              {isFull && <span className="text-gray-400"> ・全期間</span>}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1 text-xs">
            <span className="text-gray-500 mr-0.5">窓長</span>
            {presets.map(([lbl, n]) => (
              <button
                key={lbl}
                type="button"
                onClick={() => setLen(n)}
                className={`px-1.5 py-0.5 rounded text-[11px] ${!isFull && effWinLen === n ? "bg-blue-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}
              >{lbl}</button>
            ))}
            {winMode === "latest" && (
              <button
                type="button"
                onClick={() => { setWinLen(0); setWinEnd(0); }}
                className={`px-1.5 py-0.5 rounded text-[11px] ${isFull ? "bg-blue-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}
              >全期間</button>
            )}
          </div>

          {winMode === "latest" ? (
            <input
              type="range"
              min={20}
              max={D}
              step={1}
              value={effWinLen}
              onChange={(e) => { setWinLen(Number(e.target.value)); setWinEnd(0); }}
              className="w-full accent-blue-600"
              aria-label="窓長"
            />
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={effWinLen}
                max={D}
                step={1}
                value={effEnd}
                onChange={(e) => setWinEnd(Number(e.target.value))}
                className="w-full accent-blue-600"
                aria-label="窓の位置(右端)"
              />
              <button
                type="button"
                onClick={() => setWinEnd(0)}
                disabled={barsAfter === 0}
                className={`px-1.5 py-0.5 rounded text-[11px] whitespace-nowrap ${barsAfter === 0 ? "bg-gray-100 text-gray-400" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}
              >最新へ</button>
            </div>
          )}
          <p className="text-[10px] text-gray-400">
            {winMode === "latest"
              ? "窓長を変えると右端を最新に保ったまま集計期間を伸縮。曲線が期間で大きく変わる＝そのエッジは不安定。"
              : `窓長固定で位置をスライド。現在は最新から ${barsAfter.toLocaleString()} 立会日前で終了。エッジがどの時期に現れ・消えたかを確認。`}
          </p>
        </div>
      )}

      {/* 前夜米国ビン選択 */}
      {binning && (
        <div className="flex items-center gap-1.5 flex-wrap text-xs">
          <span className="text-gray-500">見る前夜米国ビン:</span>
          {binning.binInfos.map((b) => {
            const isSel = b.bin === selBin;
            const isToday = binning.todayBin === b.bin;
            return (
              <button
                key={b.bin}
                onClick={() => setSelBinRaw(b.bin)}
                title={`前夜米国リターン範囲 ${fmtBinRange(b.rangeLo, b.rangeHi)}｜米国立会日 n=${b.nUsDays}`}
                className={`flex flex-col items-start gap-0.5 px-2 py-1 rounded font-medium transition-colors ${
                  isSel ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: b.color }} />
                  {b.label}
                  {isToday && <span className={isSel ? "text-amber-300" : "text-blue-600"}>◀今</span>}
                </span>
                <span className={`text-[10px] font-normal tabular-nums ${isSel ? "text-gray-300" : "text-gray-400"}`}>
                  {fmtBinRange(b.rangeLo, b.rangeHi)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* 直近の前夜米国 */}
      {binning && prep?.latest && selInfo && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          {binning.todayUnpaired && (
            <span className="inline-block mr-1 px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 text-[10px] font-bold align-middle">
              寄り前・未反映
            </span>
          )}
          <span className="font-bold">直近の前夜米国（{prep.latest.date}）: {modeMeta.label} {fmtSignedPct(prep.latest.value, 2)}</span>
          {" → "}
          <span className="font-bold">{binning.binInfos[binning.todayBin]?.label}</span>
          {binning.todayBin === selBin
            ? <span className="text-blue-700">　（今このビンを表示中）</span>
            : <button onClick={() => setSelBinRaw(binning.todayBin)} className="ml-1 underline text-blue-700 hover:text-blue-900">このビンを見る</button>}
        </div>
      )}

      {/* メトリクス選択 */}
      <div className="space-y-1">
        <div className="text-xs text-gray-500">表示する指標</div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {METRIC_GROUPS.map((g) => (
            <div key={g} className="flex items-center gap-1 flex-wrap">
              <span className="text-[10px] text-gray-400">{g}:</span>
              {METRICS.filter((m) => m.group === g).map((m) => (
                <button
                  key={m.key}
                  onClick={() => setMetricKey(m.key)}
                  title={m.hint}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                    metricKey === m.key ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      <LoadingError loading={loading} error={error} />
      {!loading && !error && built && (!binning || !result) && (
        <div className="text-xs text-gray-400">対象期間内の標本が不足しています。窓長を広げるか、分位を粗く（陰陽/3分位）、または60分足を選んでください。</div>
      )}

      {result && selInfo && (
        <>
          <div className="text-xs text-gray-600">
            <span className="font-medium text-gray-700">{metric.label}</span>
            <span className="text-gray-400">｜{metric.hint}</span>
          </div>
          <div className="text-xs text-gray-500">
            条件: 前夜 {usLabel} の{modeMeta.label}が「{selInfo.label}」（{fmtBinRange(selInfo.rangeLo, selInfo.rangeHi)}）だった翌日。
            {metric.p && "★=有意(★★<1%/★<5%/☆<10%)。"}
          </div>

          <CrossHeatmap
            result={result}
            metric={metric}
            ctx={ctx}
            names={names}
          />

          <p className="text-[11px] text-gray-400">
            列(曜日)方向に色が銘柄をまたいで揃う＝そのビンでの曜日効果はウォッチリスト共通。1銘柄だけ突出＝個別要因/ノイズ。
            前夜米国ビンや対象期間を切り替え、同じ曜日列の傾向が反転/強弱・出現/消滅するかを見る。
          </p>
        </>
      )}

      <IntradayCaveat extra="前夜米国ビン×曜日で母集団を細分するため各セルは薄い(各セルにデータ数nを表示)。3分位・60分足を既定に、ローリングは窓を広めに。5分位や短い窓では横断平均行のみ実効標本が確保されやすい。" />

      <AnalysisGuide title="曜日×前夜米国ビン 横断比較の詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"単一銘柄の『曜日×前夜米国ビン 交互作用パス』をウォッチリスト全銘柄に同じ条件で一斉適用し、選んだ前夜米国ビン(例: 米大幅高)の翌日だけに絞る。各(銘柄×曜日)の日内パスを、リターン・値幅・到達・トレード質・時刻・形状の各面からスカラー化してヒートマップにする。"}
          {"単一銘柄では『固有の癖』か『地合い×曜日の共通構造』か判別できないが、横断で並べると、同じ曜日列が多数銘柄で揃うか(共通)、1銘柄だけ突出するか(固有/ノイズ)が一目で分かる。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 指標の定義(O=寄, H=高, L=安, C=引, P=前日引)</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>リターン</strong>: 日中=ln(C/O)、前日比=ln(C/P)(オーバーナイト込み・実損益に近い)、ギャップ=ln(O/P)(夜間の窓)。</li>
          <li><strong>値幅・到達</strong>: 上値到達=ln(H/O)(利確余地)、下値到達=ln(L/O)(含み損の深さ=ストップ目安)、日中レンジ=ln(H/L)、ボラ=日中リターンのσ。</li>
          <li><strong>トレード質</strong>: 勝率=C&gt;Oの割合、終値位置=(C−L)/(H−L)(1=大引け天井/0=引け安)、シャープ=日中平均/σ。</li>
          <li><strong>時刻</strong>: 上値ピーク/最安時刻=平均累積パスの最大/最小時間、高値/安値時刻=日中の高安を付けた時刻の中央値。前者は『銘柄全体で均した山谷』、後者は『各日が実際に高安を付けた時刻の代表値』で、両者はズレうる(平均パスは打ち消し合いで山谷が緩み時刻が中央寄りに、各日の実測は極値なのでばらつく)。</li>
          <li><strong>形状＋高安時刻</strong>: 寄り基準の平均累積パス r(t)=ln(P_t/O) を各セルにスパークライン描画し、上記4時刻を1枚に重ねて同時表示(● 上値ピーク/最安=平均パス基準、▽△ 高値/安値時刻中央=各日実測)。●と▽△の横のズレで両者の違いを一目で読める。縦軸は<strong>各セルの山谷レンジに自動フィット</strong>し、原系列のように形状をはっきり見せる(共通スケールだと大振幅セルに他が潰される)。振幅の大きさは左上に山谷幅(%)を数値表示して銘柄間比較を担保。灰帯は平均の±1標準誤差(σ/√n; 日次±1σ~1-2%だと平均パス~0.1-0.5%が潰れるため。枠でクリップし、帯が枠を超えるほど平均が不確か)。破線は寄り(0)の水準。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 集計と対象期間</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"前夜米国ビンの境界は『対象期間内・全銘柄共通』に取る(日付デデュープした米国リターンを順位分割)。銘柄横断で同じ地合いを比較するため。"}</li>
          <li>{"対象期間はローリング可能。最新起点(窓長可変・右端は最新)または窓長固定で位置をスライド。エッジがどの時期に現れ・消えたか、期間依存かを確認できる。"}</li>
          <li>{"横断平均行は全銘柄の該当日をプールし、日中リターンを『日付クラスタ頑健SE』で検定(同一営業日の全銘柄相関を吸収)。実効標本数nEffも併記。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>今夜の前夜米国は寄り前に確定(上部バナー)。そのビン列で、明日の曜日に最も効く銘柄・向き・利確/損切り時刻を選ぶ。前日比とギャップの分解で「窓で取るか日中で取るか」も判断。</li>
          <li>上値到達/下値到達で利確幅とストップ幅の当たりを、終値位置/ピーク時刻で手仕舞い時刻を、勝率/シャープでエッジの質を確認。</li>
          <li>横断平均で共通と確認できた条件だけ採用し、1銘柄だけのシグナルは見送る(過学習回避)。全銘柄同方向＝ブックが地合いに集中(分散不足)、逆行銘柄はヘッジ候補。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"前夜米国ビン×曜日で母集団を細分するため各セルは薄い(nを常時表示)。ローリングや5分位で更に薄くなる。横断平均行(プール)でのみ実効標本が確保されやすい。"}</li>
          <li>{"横断平均は『銘柄が似た反応をする』前提。値がさ/低位・業種・米国連動度が大きく違う銘柄を混ぜると平均が歪む。"}</li>
          <li>{"多重比較(銘柄×曜日×ビン×指標×期間)で見かけの有意が出やすい。★の数でなく横断的一貫性・nEff・期間頑健性を重視。"}</li>
          <li>{"日中足は約15分遅延・取得期間に上限(5/15/30分足≈60日, 60分足≈2年)。米国指数とビン基準で結果は変わる。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

// ───────────────────────── ヒートマップ表 ─────────────────────────

function CrossHeatmap({
  result, metric, ctx, names,
}: {
  result: NonNullable<ReturnType<typeof computeCrossRows>>;
  metric: Metric;
  ctx: ColorCtx;
  names?: Record<string, string>;
}) {
  const { timeLabels, grid } = result;

  const renderCell = (c: CellStats | null, consensusP?: number) => {
    if (!c || c.n < 1) return <span className="text-gray-300">—</span>;
    if (metric.key === "shape") {
      return <PathSpark cell={c} grid={grid} timeLabels={timeLabels} />;
    }
    const v = metric.get(c);
    const bg = cellBg(metric, v, ctx);
    const intensity = cellIntensity(metric, v, ctx);
    const color = intensity > 0.55 ? "#ffffff" : "#111827";
    const p = consensusP ?? (metric.p ? metric.p(c) : undefined);
    return (
      <div style={{ backgroundColor: bg, color }} className="rounded px-1 py-1 leading-tight tabular-nums" title={`n=${c.n}｜${metric.label} ${fmtValue(metric, v, timeLabels)}${p !== undefined ? `｜p=${p.toFixed(3)}` : ""}`}>
        <div className="font-semibold">{fmtValue(metric, v, timeLabels)}</div>
        <div className="text-[9px] opacity-80">
          {p !== undefined && star(p)}
          {c.n < 5 && <span className="ml-0.5">n{c.n}</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="overflow-x-auto">
      <table className="text-[11px] w-full border-collapse">
        <thead>
          <tr className="text-gray-500">
            <th className="text-left font-medium px-2 py-1 sticky left-0 bg-white z-10">銘柄</th>
            {CROSS_WD_ORDER.map((wd) => (
              <th key={wd} className="font-medium px-1 py-1 text-center min-w-[58px]">{CROSS_WD_LABELS[wd]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r) => (
            <tr key={r.ticker} className="border-t border-gray-100">
              <td className="px-2 py-1 sticky left-0 bg-white z-10">
                <div className="font-medium text-gray-700 truncate max-w-[130px]" title={r.ticker}>
                  {names?.[r.ticker] || r.ticker}
                </div>
                <div className="text-[9px] text-gray-400">n={r.nTotal}</div>
              </td>
              {r.cells.map((c, i) => (
                <td key={i} className="px-0.5 py-0.5 text-center align-middle">{renderCell(c)}</td>
              ))}
            </tr>
          ))}
          <tr className="border-t-2 border-gray-300 bg-gray-50">
            <td className="px-2 py-1 sticky left-0 bg-gray-50 z-10">
              <div className="font-bold text-gray-800">横断平均</div>
              <div className="text-[9px] text-gray-400">{result.nStocks}銘柄プール</div>
            </td>
            {result.consensus.map((c: ConsensusCell | null, i) => (
              <td key={i} className="px-0.5 py-0.5 text-center align-middle"
                title={c ? `のべ${c.n}｜独立${c.nDays}日｜実効${c.nEff.toFixed(1)}` : undefined}>
                {renderCell(c, c && metric.key === "intraday" ? c.intradayCrP : undefined)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      {(metric.color === "timeGrid" || metric.color === "timeMin") && (
        <div className="flex items-center gap-2 text-[10px] text-gray-400 mt-1">
          <span>色の濃さ=時刻の遅さ</span>
          <span className="inline-block w-16 h-2 rounded" style={{ background: "linear-gradient(90deg, rgba(37,99,235,0.1), rgba(37,99,235,0.65))" }} />
          <span>寄り → 大引け</span>
        </div>
      )}
      {metric.color === "div" && (
        <div className="text-[10px] text-gray-400 mt-1">緑=プラス / 赤=マイナス、濃いほど大。</div>
      )}
      {metric.key === "shape" && (
        <div className="flex flex-col gap-0.5 text-[10px] text-gray-500 mt-1.5">
          <div>
            寄り基準の平均累積パス。<span className="text-slate-600 font-medium">縦は各セルの山谷レンジに自動フィット</span>（原系列のように形状をはっきり表示）。
            <span className="text-gray-400">左上の%＝山谷の振幅（大きさはここで比較）</span>、<span className="text-slate-600">灰帯＝平均の±1標準誤差 σ/√n（枠でクリップ; 帯が枠を超えるほど不確か）</span>。
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            <span><span style={{ color: SP_GREEN }} className="font-bold">●</span> 上値ピーク時刻（平均パス最大＝利確目安）</span>
            <span><span style={{ color: SP_GREEN }} className="font-bold">▽</span> 高値時刻・中央（各日実測の高値時刻）</span>
            <span><span style={{ color: SP_RED }} className="font-bold">●</span> 最安時刻（平均パス最小＝仕込み/損切り目安）</span>
            <span><span style={{ color: SP_RED }} className="font-bold">△</span> 安値時刻・中央（各日実測の安値時刻）</span>
          </div>
          <div className="text-gray-400">
            ●（均された山谷の時刻）と ▽△（典型的な高安の時刻）の横のズレが両者の違い。近ければ一貫、離れれば日によって高安の付け方がばらつく。破線＝寄り(0)の水準。
          </div>
        </div>
      )}
    </div>
  );
}

// 1セルの日内平均パス ミニチャート。縦は「そのセルの平均パス自身のレンジ」に自動フィットし、
// 原系列のように形状をはっきり見せる(共通スケールだと大振幅セルに潰される)。振幅そのものは
// 左上に山谷幅(%)を数値表示し、銘柄間比較を担保。灰帯=平均の±1標準誤差(σ/√n, 枠でクリップ)。
// さらに4つの時刻マーカーを重ねる:
//  ● 上値ピーク時刻 / 最安時刻   = 平均累積パスの最大/最小(緑/赤の丸, パス上)
//  ▽ 高値時刻中央 / △ 安値時刻中央 = 各日実測の高安時刻の中央値(緑/赤の三角, 上端/下端)
// ●と▽△の横のズレが「均された山谷」と「典型的な高安の時刻」の違いを表す。
const SP_GREEN = "#16a34a", SP_RED = "#dc2626";
function PathSpark({ cell, grid, timeLabels }: {
  cell: CellStats; grid: BinGrid; timeLabels: string[];
}) {
  const { path, band, peakIdx, troughIdx, highMin, lowMin } = cell;
  const W = 104, H = 54, padX = 6, padTop = 9, padBot = 9;
  const G = path.length;
  if (G < 2) return <span className="text-gray-300">—</span>;

  // 縦スケール: 平均パス自身の [min, max] にフィット(帯ではなく線でフィット→形状が枠いっぱい)
  let lo = Infinity, hi = -Infinity;
  for (let g = 0; g < G; g++) { if (path[g] < lo) lo = path[g]; if (path[g] > hi) hi = path[g]; }
  const ampl = hi - lo; // 山谷の振幅(寄り基準)
  const padV = Math.max(ampl * 0.18, 2e-5);
  lo -= padV; hi += padV;
  const spanV = hi - lo || 1e-6;
  const plotH = H - padTop - padBot;

  const x = (i: number) => padX + (Math.max(0, Math.min(G - 1, i)) / (G - 1)) * (W - 2 * padX);
  const yRaw = (v: number) => padTop + ((hi - v) / spanV) * plotH; // path は必ず範囲内
  const yClip = (v: number) => Math.max(padTop - 2, Math.min(H - padBot + 2, yRaw(v))); // 帯は枠でクリップ

  const rootN = Math.sqrt(Math.max(1, cell.n)); // σ → s.e.(平均の標準誤差)
  const line = path.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yRaw(v).toFixed(1)}`).join(" ");
  const upper = path.map((v, i) => `${x(i).toFixed(1)},${yClip(v + band[i] / rootN).toFixed(1)}`);
  const lower = path.map((v, i) => `${x(i).toFixed(1)},${yClip(v - band[i] / rootN).toFixed(1)}`).reverse();
  const area = `M${upper.join(" L")} L${lower.join(" L")} Z`;

  // 分 → x(パスと同じ時間格子に写像)
  const xOfMin = (m: number) => x((m - grid.binStart) / grid.binMinutes);
  const highX = xOfMin(highMin);
  const lowX = xOfMin(lowMin);
  const peakX = x(peakIdx), peakY = yRaw(path[peakIdx]);
  const trX = x(troughIdx), trY = yRaw(path[troughIdx]);
  const zeroY = yRaw(0); // 寄り基準(0=始値)

  const amplPct = `${(ampl * 100).toFixed(ampl >= 0.01 ? 1 : 2)}%`;
  const title =
    `平均パス形状（寄り基準の累積対数リターン, 縦=自セルの山谷に自動フィット, 灰帯=±1標準誤差 σ/√n）\n` +
    `山谷の振幅 ${amplPct}\n` +
    `● 上値ピーク時刻 ${timeLabels[peakIdx] ?? ""}（平均パス最大）\n` +
    `▽ 高値時刻・中央 ${minuteToLabel(Math.round(highMin))}（各日実測）\n` +
    `● 最安時刻 ${timeLabels[troughIdx] ?? ""}（平均パス最小）\n` +
    `△ 安値時刻・中央 ${minuteToLabel(Math.round(lowMin))}（各日実測）`;

  return (
    <svg width={W} height={H} className="inline-block align-middle" style={{ overflow: "visible" }}>
      <title>{title}</title>
      {/* 寄り基準の0ライン(実位置) */}
      <line x1={padX} y1={zeroY} x2={W - padX} y2={zeroY} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="2 2" />
      <path d={area} fill="#94a3b8" opacity={0.18} />
      <path d={line} fill="none" stroke="#334155" strokeWidth={1.4} />
      {/* 高値時刻・中央: 上端▽ + 縦ガイド(緑) */}
      <line x1={highX} y1={padTop - 2} x2={highX} y2={H - padBot} stroke={SP_GREEN} strokeWidth={0.7} strokeDasharray="1.5 1.5" opacity={0.5} />
      <path d={`M${(highX - 3.5).toFixed(1)},${padTop - 8} L${(highX + 3.5).toFixed(1)},${padTop - 8} L${highX.toFixed(1)},${padTop - 2} Z`} fill={SP_GREEN} />
      {/* 安値時刻・中央: 下端△ + 縦ガイド(赤) */}
      <line x1={lowX} y1={padTop} x2={lowX} y2={H - padBot + 2} stroke={SP_RED} strokeWidth={0.7} strokeDasharray="1.5 1.5" opacity={0.5} />
      <path d={`M${(lowX - 3.5).toFixed(1)},${H - padBot + 8} L${(lowX + 3.5).toFixed(1)},${H - padBot + 8} L${lowX.toFixed(1)},${H - padBot + 2} Z`} fill={SP_RED} />
      {/* 上値ピーク / 最安: パス上の●(白縁) */}
      <circle cx={peakX} cy={peakY} r={2.7} fill={SP_GREEN} stroke="#fff" strokeWidth={0.8} />
      <circle cx={trX} cy={trY} r={2.7} fill={SP_RED} stroke="#fff" strokeWidth={0.8} />
      {/* 山谷の振幅(cross-cellの大きさ比較用) */}
      <text x={padX} y={7} fontSize={7.5} fill="#9ca3af" style={{ fontVariantNumeric: "tabular-nums" }}>{amplPct}</text>
    </svg>
  );
}
