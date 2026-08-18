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
  UsMode, CrossStock, DateWindow, CellStats, ConsensusCell, CrossRow,
  prepCross, computeCrossBinning, computeCrossRows,
  CROSS_WD_ORDER, CROSS_WD_LABELS, minuteToLabel,
  WdScope, SortDir, MuBasis, AllocRow, AllocOpts, DEFAULT_ALLOC,
  cellAmplitude, rowScalar, rowMuVar, allocWeights, wdScopeLabel,
} from "../../lib/weekday-us-cross";
import { UsDriverButtons, BinSchemeButtons, intervalToMin } from "./usSpilloverShared";
import { IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct } from "./intradayShared";
import { NameColMode, NAME_COL_W, useNameColMode, nameColStyle, NameColHeader } from "./crossTableShared";
import AnalysisGuide from "./AnalysisGuide";
import { CHART_COLORS } from "../../lib/chart-colors";

interface Props {
  tickers: string[];
  names?: Record<string, string>;
  // 銘柄名のインライン編集(ウォッチリストへ永続化)。未指定なら編集UIを出さない。
  onRename?: (ticker: string, name: string) => void;
}

// 曜日をまたぐ集計スコープ。既定は週合計(月〜金を1週間まとめて建てたときの量)。
const WD_SCOPES: { value: WdScope; label: string; hint: string }[] = [
  { value: "sum", label: "週合計", hint: "月〜金の値を合計して並べる。1週間その銘柄を回したときの合計量なので、建玉配分の判断に直結する(リターン系のみ加算。σ・割合・時刻の指標では自動的に平均になる)。" },
  { value: "mean", label: "平均", hint: "月〜金の平均で並べる。トレード1回あたりの性質を比べる(曜日数の違いに左右されない)。" },
  { value: "best", label: "最良曜日", hint: "並び方向にとって最も有利な曜日1つの値で並べる(降順なら最大・昇順なら最小・|値|なら最大絶対値)。週のどこか1日だけ強い銘柄を拾う。" },
  ...CROSS_WD_ORDER.map((wd) => ({
    value: wd as WdScope,
    label: CROSS_WD_LABELS[wd],
    hint: `${CROSS_WD_LABELS[wd]}のセルだけで並べる(その曜日に最も効く銘柄を上に)。`,
  })),
];

const SORT_DIRS: { value: SortDir; label: string; hint: string }[] = [
  { value: "desc", label: "▼降順", hint: "大きい順。期待値やシャープなら『良い銘柄が上』。" },
  { value: "asc", label: "▲昇順", hint: "小さい順。下値到達・σ・p値のように『小さいほど良い』量や、逆張り/売り候補を探すとき。" },
  { value: "abs", label: "|値|", hint: "絶対値の大きい順。符号を問わず『効果が強い銘柄』を上に(買い候補と売り候補が混ざる)。" },
];

// 並び替えの対象量。METRICS 全件(形状を除く)＋ 統計・配分の派生量。
type DerivedKey = "t" | "kelly" | "alloc" | "ticker" | "name";
interface SortField {
  key: string;
  label: string;
  short: string; // 行見出し用の短縮名
  group: string;
  get?: (c: CellStats) => number; // セル→スカラー(スコープ集計の対象)
  derived?: DerivedKey;
  dir: "desc" | "asc"; // 既定の並び方向
  fmt: Fmt;
  additive: boolean; // 週合計が意味を持つか
  hint: string;
}

const SORT_GROUP_STATS = "統計・配分";
const SORT_GROUP_OTHER = "その他";

function buildSortFields(metric: Metric): SortField[] {
  const fromMetrics: SortField[] = METRICS.filter((m) => m.key !== "shape").map((m) => ({
    key: `m:${m.key}`, label: m.label, short: m.label, group: m.group,
    get: m.get, dir: m.dir ?? "desc", fmt: m.fmt, additive: !!m.additive, hint: m.hint,
  }));
  return [
    {
      key: "metric",
      label: `表示中の指標（${metric.key === "shape" ? "パス振幅" : metric.label}）`,
      short: metric.key === "shape" ? "パス振幅" : metric.label,
      group: "表示連動",
      get: metric.key === "shape" ? cellAmplitude : metric.get,
      dir: metric.key === "shape" ? "desc" : metric.dir ?? "desc",
      fmt: metric.key === "shape" ? "pct" : metric.fmt,
      additive: metric.key === "shape" ? true : !!metric.additive,
      hint: "上で選んでいる指標に追従して並べ替える。指標を切り替えると並びも一緒に変わる(形状のときは振幅で代用)。",
    },
    ...fromMetrics,
    { key: "t", label: "t値（期待値/SE）", short: "t値", group: SORT_GROUP_STATS, derived: "t", dir: "desc", fmt: "num2", additive: false, hint: "期待値が0から何標準誤差ぶん離れているか。|t|>2 でおよそ5%有意。標本の薄い銘柄の大きな期待値を割り引いて見られる。基準リターンは『期待値の基準』に従う。" },
    { key: "kelly", label: "ケリー比（μ̃/σ²）", short: "ケリー比", group: SORT_GROUP_STATS, derived: "kelly", dir: "desc", fmt: "num2", additive: false, hint: "対数効用での最適建玉比 q*=μ/σ²(相関無視)。同じ期待値なら揺れの小さい銘柄ほど大きい。既定では期待値から1標準誤差を引いた保守値 μ̃ を使う。" },
    { key: "alloc", label: "配分%（相対ウェイト）", short: "配分", group: SORT_GROUP_STATS, derived: "alloc", dir: "desc", fmt: "pct1", additive: false, hint: "ケリー比を全銘柄で正規化した相対配分。『予算のうち何%をこの銘柄に割くか』の目安(総建玉の大きさは別問題)。" },
    { key: "ticker", label: "銘柄コード", short: "コード", group: SORT_GROUP_OTHER, derived: "ticker", dir: "asc", fmt: "none", additive: false, hint: "ティッカーの昇順。" },
    { key: "name", label: "名称", short: "名称", group: SORT_GROUP_OTHER, derived: "name", dir: "asc", fmt: "none", additive: false, hint: "銘柄名の五十音/アルファベット順。" },
  ];
}

const MU_BASES: { value: MuBasis; label: string; hint: string }[] = [
  { value: "intraday", label: "日中(寄→引)", hint: "μ=平均 ln(引/寄)、σ=そのばらつき。寄付で建てて引けで閉じる日計りの期待値。" },
  { value: "full", label: "前日比(前引→引)", hint: "μ=平均 ln(引/前日引)。オーバーナイトを持ち越す前提の期待値(実際の保有損益に近い)。" },
  { value: "gap", label: "ギャップ(前引→寄)", hint: "μ=平均 ln(寄/前日引)。引けで建て翌寄で閉じる夜間だけの期待値。" },
];

// 形状スパークラインの縦軸スケール。
type SparkScale = "cell" | "row" | "all";
const SPARK_SCALES: { value: SparkScale; label: string; hint: string }[] = [
  { value: "all", label: "全銘柄共通", hint: "表内の全セル(横断平均行を含む)で同じ縦軸(±最大|パス|)。1%あたりの高さが全セルで等しくなり、どの銘柄・どの曜日が大きく動くかを形の大きさそのもので比較できる。小さい銘柄は平坦に潰れる。" },
  { value: "row", label: "銘柄内共通", hint: "各銘柄(行)の中で縦軸を共通化。銘柄間の値動きの大きさの差を打ち消し、その銘柄の中でどの曜日が大きいかを比較する(個別株分析の曜日パス図と同じ見え方)。" },
  { value: "cell", label: "各セル自動", hint: "セルごとに山谷レンジへ自動フィット。大きさは比べられないが、小さな銘柄でも形(山谷の時刻)がはっきり見える。" },
];

const US_MODES: { value: UsMode; label: string; formula: string }[] = [
  { value: "ret", label: "前日終値比", formula: "ln(当日終値 / 前日終値)（オーバーナイト含む米国当日騰落）" },
  { value: "intra", label: "日中", formula: "ln(当日終値 / 当日始値)（米国正規セッション内）" },
];

// ───────────────────────── メトリクス定義 ─────────────────────────

type ColorKind = "div" | "divHalf" | "seq" | "timeGrid" | "timeMin" | "count" | "shape";
type Fmt = "pctS" | "pct" | "pct1" | "num2" | "pct0" | "timeGrid" | "timeMin" | "int" | "none";

interface Metric {
  key: string;
  label: string;
  group: string;
  color: ColorKind;
  fmt: Fmt;
  get: (c: CellStats) => number;
  p?: (c: CellStats) => number;
  // 並び替え用: 既定の方向(未指定=降順)と、曜日をまたぐ「合計」が意味を持つか(未指定=持たない)
  dir?: "desc" | "asc";
  additive?: boolean;
  hint: string;
}

// 1セルの平均パスの最大絶対値(寄り基準)。共通縦軸 ±maxAbs を作るときのスケール源。
function cellMaxAbs(c: CellStats | null): number {
  if (!c || !c.path) return 0;
  let m = 0;
  for (const v of c.path) { const a = Math.abs(v); if (a > m) m = a; }
  return m;
}

const METRICS: Metric[] = [
  // リターン
  { key: "intraday", label: "日中(寄→引)", group: "リターン", color: "div", fmt: "pctS", get: (c) => c.intraday, p: (c) => c.intradayP, additive: true, hint: "寄付で買い引けで売った平均。日中トレードの素の期待値。" },
  { key: "full", label: "前日比(前引→引)", group: "リターン", color: "div", fmt: "pctS", get: (c) => c.full, p: (c) => c.fullP, additive: true, hint: "前日終値からの当日騰落(オーバーナイト込み)。実際の保有損益に近い。" },
  { key: "gap", label: "ギャップ(前引→寄)", group: "リターン", color: "div", fmt: "pctS", get: (c) => c.gap, p: (c) => c.gapP, additive: true, hint: "夜間に開いた窓。寄付までに前夜米国を織り込んだ分。" },
  // 値幅・到達
  { key: "mfe", label: "上値到達(高/寄)", group: "値幅・到達", color: "div", fmt: "pctS", get: (c) => c.mfe, additive: true, hint: "寄付から高値までの平均。日中どこまで上げたか=利確余地。" },
  { key: "mae", label: "下値到達(安/寄)", group: "値幅・到達", color: "div", fmt: "pctS", get: (c) => c.mae, dir: "asc", additive: true, hint: "寄付から安値までの平均(通常マイナス)。含み損の深さ=ストップ目安。並び替えは既定で昇順(深い順)。" },
  { key: "range", label: "日中レンジ(高/安)", group: "値幅・到達", color: "seq", fmt: "pct", get: (c) => c.range, additive: true, hint: "高値÷安値の平均。その日の値動きの大きさ。" },
  { key: "ampl", label: "パス振幅(山谷幅)", group: "値幅・到達", color: "seq", fmt: "pct", get: cellAmplitude, additive: true, hint: "平均累積パスの最大−最小。『平均すると残る』方向性の大きさで、日々のレンジ(打ち消し前)とは別物。これが大きい曜日ほど日内の形にエッジがある。" },
  { key: "vol", label: "ボラ(日中σ)", group: "値幅・到達", color: "seq", fmt: "pct", get: (c) => c.vol, hint: "日中リターンの標準偏差。ばらつき=リスク。σは足し算できないので曜日集計は平均になる。" },
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
  { key: "n", label: "データ数", group: "その他", color: "count", fmt: "int", get: (c) => c.n, additive: true, hint: "そのセルの立会日数。少ないほど不安定。" },
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

function fmtValue(fmt: Fmt, v: number, timeLabels: string[]): string {
  if (!isFinite(v)) return "—";
  switch (fmt) {
    case "pctS": return fmtSignedPct(v, 1);
    case "pct": return `${(v * 100).toFixed(1)}%`;
    case "pct1": return `${(v * 100).toFixed(1)}%`;
    case "num2": return v.toFixed(2);
    case "pct0": return `${(v * 100).toFixed(0)}%`;
    case "timeGrid": return timeLabels[Math.round(v)] ?? "";
    case "timeMin": return minuteToLabel(Math.round(v));
    case "int": return String(Math.round(v));
    default: return "";
  }
}

// 並び替え比較。値の無い行(NaN)は方向によらず常に最下部へ落とす。
function cmpVals(a: number | undefined, b: number | undefined, dir: SortDir): number {
  const av = a === undefined || !isFinite(a) ? NaN : a;
  const bv = b === undefined || !isFinite(b) ? NaN : b;
  const an = isNaN(av), bn = isNaN(bv);
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if (dir === "abs") return Math.abs(bv) - Math.abs(av);
  return dir === "asc" ? av - bv : bv - av;
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

export default function WeekdayUsCrossChart({ tickers, names, onRename }: Props) {
  const [usTicker, setUsTicker] = useState("^IXIC");
  const [interval, setInterval] = useState("60m");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const [usMode, setUsMode] = useState<UsMode>("ret");
  const [selBinRaw, setSelBinRaw] = useState<number | null>(null);
  const [metricKey, setMetricKey] = useState("intraday");
  // 並び替え: 対象量 × 曜日スコープ × 方向。既定は「表示中の指標(=日中期待値)・週合計・降順」。
  const [sortFieldKey, setSortFieldKey] = useState("metric");
  const [wdScope, setWdScope] = useState<WdScope>("sum");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  // 期待値・配分の基準リターンと、配分の作り方。
  const [muBasis, setMuBasis] = useState<MuBasis>("intraday");
  const [haircut, setHaircut] = useState(DEFAULT_ALLOC.haircut);
  const [minN, setMinN] = useState(DEFAULT_ALLOC.minN);
  const [showRank, setShowRank] = useState(true);
  // 形状セルの縦軸。既定=全銘柄共通(振幅の大小をそのまま目で比較できる)。
  const [sparkScale, setSparkScale] = useState<SparkScale>("all");
  // 対象期間: 0=全期間/最新 の既定なので、データ長が変わっても破綻しない(effectでのreset不要)。
  const [winMode, setWinMode] = useState<"latest" | "rolling">("latest");
  const [winLen, setWinLen] = useState(0); // 窓長(立会日). 0=全期間
  const [winEnd, setWinEnd] = useState(0); // 窓右端(1..D). 0=最新

  const resetBin = () => setSelBinRaw(null);
  const setUsTickerR = (t: string) => { setUsTicker(t); resetBin(); };
  const setUsModeR = (m: UsMode) => { setUsMode(m); resetBin(); };
  const setSchemeR = (s: BinScheme) => { setScheme(s); resetBin(); };

  const metric = METRICS.find((m) => m.key === metricKey)!;
  const sortFields = useMemo(() => buildSortFields(metric), [metric]);
  const sortField = sortFields.find((f) => f.key === sortFieldKey) ?? sortFields[0];
  // 対象量を切り替えたら方向はその量の既定へ戻す(下値到達=昇順 など)。
  const pickSortField = (key: string) => {
    setSortFieldKey(key);
    setSortDir(sortFields.find((f) => f.key === key)?.dir ?? "desc");
  };

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

  // ── 配分ウェイトと行の並び替え ──
  // ヒートマップの行見出し・ランキング表の両方が同じ値を使うよう、ここで一度だけ算出する。
  const allocOpts: AllocOpts = useMemo(() => ({ haircut, minN }), [haircut, minN]);
  const allocMap = useMemo(
    () => (result ? allocWeights(result.rows, wdScope, muBasis, allocOpts, sortDir) : null),
    [result, wdScope, muBasis, allocOpts, sortDir]
  );

  const sortVals = useMemo(() => {
    const m = new Map<string, number>();
    if (!result) return m;
    for (const r of result.rows) {
      let v = NaN;
      if (sortField.get) {
        v = rowScalar(r, sortField.get, wdScope, sortDir, sortField.additive);
      } else if (sortField.derived === "t") {
        const mv = rowMuVar(r, wdScope, muBasis, sortDir);
        v = mv && mv.se > 0 ? mv.mu / mv.se : NaN;
      } else if (sortField.derived === "kelly") {
        v = allocMap?.get(r.ticker)?.kelly ?? NaN;
      } else if (sortField.derived === "alloc") {
        v = allocMap?.get(r.ticker)?.weight ?? NaN;
      }
      m.set(r.ticker, v);
    }
    return m;
  }, [result, sortField, wdScope, sortDir, muBasis, allocMap]);

  const sortedRows = useMemo(() => {
    if (!result) return [] as CrossRow[];
    const rows = [...result.rows];
    const nm = (t: string) => names?.[t] || t;
    const sign = sortDir === "asc" ? 1 : -1;
    if (sortField.derived === "ticker") rows.sort((a, b) => a.ticker.localeCompare(b.ticker) * sign);
    else if (sortField.derived === "name") rows.sort((a, b) => nm(a.ticker).localeCompare(nm(b.ticker), "ja") * sign);
    else rows.sort((a, b) => cmpVals(sortVals.get(a.ticker), sortVals.get(b.ticker), sortDir));
    return rows;
  }, [result, sortField, sortVals, sortDir, names]);

  // 週合計が意味を持たない指標(σ・割合・時刻)では "sum" は平均へ落ちる。
  const sumFellBack = wdScope === "sum" && !!sortField.get && !sortField.additive;

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
              <span className="text-fg-muted">（{effWinLen.toLocaleString()}立会日 ≈{(effWinLen / 252).toFixed(1)}年）</span>
              {isFull && <span className="text-fg-muted"> ・全期間</span>}
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
                className={`px-1.5 py-0.5 rounded text-[11px] whitespace-nowrap ${barsAfter === 0 ? "bg-gray-100 text-fg-muted" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}
              >最新へ</button>
            </div>
          )}
          <p className="text-[10px] text-fg-muted">
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
                <span className={`text-[10px] font-normal tabular-nums ${isSel ? "text-gray-300" : "text-fg-muted"}`}>
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
              <span className="text-[10px] text-fg-muted">{g}:</span>
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
        <div className="text-xs text-fg-muted">対象期間内の標本が不足しています。窓長を広げるか、分位を粗く（陰陽/3分位）、または60分足を選んでください。</div>
      )}

      {result && selInfo && (
        <>
          <div className="text-xs text-gray-600">
            <span className="font-medium text-gray-700">{metric.label}</span>
            <span className="text-fg-muted">｜{metric.hint}</span>
          </div>
          <div className="text-xs text-gray-500">
            条件: 前夜 {usLabel} の{modeMeta.label}が「{selInfo.label}」（{fmtBinRange(selInfo.rangeLo, selInfo.rangeHi)}）だった翌日。
            {metric.p && "★=有意(★★<1%/★<5%/☆<10%)。"}
          </div>

          {/* ===== 並び替え(対象量 × 曜日スコープ × 方向) ===== */}
          <div className="rounded border border-gray-100 bg-gray-50/60 p-2.5 space-y-1.5">
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              <span className="text-gray-600 font-medium">並び替え</span>
              <select
                value={sortField.key}
                onChange={(e) => pickSortField(e.target.value)}
                title={sortField.hint}
                className="px-1.5 py-0.5 text-[11px] border border-gray-200 rounded bg-white text-gray-700 max-w-[230px]"
              >
                {["表示連動", ...METRIC_GROUPS.filter((g) => g !== "その他"), SORT_GROUP_STATS, SORT_GROUP_OTHER].map((g) => {
                  const fs = sortFields.filter((f) => f.group === g);
                  if (fs.length === 0) return null;
                  return (
                    <optgroup key={g} label={g}>
                      {fs.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </optgroup>
                  );
                })}
              </select>

              <span className="inline-flex items-center gap-1 flex-wrap pl-2 border-l border-gray-200">
                <span className="text-fg-muted text-[10px]">曜日:</span>
                {WD_SCOPES.map((s) => (
                  <button
                    key={String(s.value)}
                    onClick={() => setWdScope(s.value)}
                    title={s.hint}
                    className={`px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors ${
                      wdScope === s.value ? "bg-amber-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </span>

              <span className="inline-flex items-center gap-1 flex-wrap pl-2 border-l border-gray-200">
                {SORT_DIRS.map((d) => (
                  <button
                    key={d.value}
                    onClick={() => setSortDir(d.value)}
                    title={d.hint}
                    className={`px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors ${
                      sortDir === d.value ? "bg-gray-800 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </span>
            </div>

            {/* 期待値・配分の基準 */}
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              <span className="text-gray-500 text-[10px]">期待値の基準:</span>
              {MU_BASES.map((b) => (
                <button
                  key={b.value}
                  onClick={() => setMuBasis(b.value)}
                  title={b.hint}
                  className={`px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors ${
                    muBasis === b.value ? "bg-indigo-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {b.label}
                </button>
              ))}
              <span className="inline-flex items-center gap-1.5 flex-wrap pl-2 border-l border-gray-200">
                <label className="inline-flex items-center gap-1 cursor-pointer" title="期待値から1標準誤差を差し引いた保守値 μ̃=sign(μ)·max(0,|μ|−SE) で配分を作る。標本が薄く偶然大きく見えている銘柄の配分を自動で削る。">
                  <input type="checkbox" checked={haircut} onChange={(e) => setHaircut(e.target.checked)} className="accent-emerald-600" />
                  <span className="text-gray-600 text-[11px]">配分を−1SEで割引</span>
                </label>
                <label className="inline-flex items-center gap-1" title="この立会日数に満たない銘柄は配分の対象外にする(ウェイト0)。">
                  <span className="text-gray-500 text-[10px]">最小n</span>
                  <input
                    type="number" min={1} max={200} value={minN}
                    onChange={(e) => setMinN(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
                    className="w-12 px-1 py-0.5 text-[11px] border border-gray-200 rounded tabular-nums"
                  />
                </label>
              </span>
            </div>

            <p className="text-[10px] text-fg-muted">
              {sumFellBack
                ? `「${sortField.short}」は足し算できない量のため、週合計は自動で平均になっています。`
                : `並び順＝${sortField.short}（${wdScopeLabel(wdScope)}）の${sortDir === "abs" ? "絶対値の大きい順" : sortDir === "asc" ? "小さい順" : "大きい順"}。値の無い銘柄は常に最下部。`}
              {onRename && "　銘柄名の ✎ で名称を編集(ウォッチリストに保存)。"}
            </p>
          </div>

          {metric.key === "shape" && (
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              <span className="text-gray-500">形状の縦軸:</span>
              {SPARK_SCALES.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setSparkScale(s.value)}
                  title={s.hint}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                    sparkScale === s.value ? "bg-slate-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {s.label}
                </button>
              ))}
              <span className="text-[10px] text-fg-muted">
                {sparkScale === "cell"
                  ? "セルごとに自動フィット（大きさは比較不可・形だけ見る）"
                  : sparkScale === "row"
                  ? "銘柄内で軸固定（同じ行の曜日どうしが比較可）"
                  : "全銘柄で軸固定（表全体で振幅をそのまま比較可）"}
              </span>
            </div>
          )}

          <CrossHeatmap
            result={result}
            rows={sortedRows}
            metric={metric}
            ctx={ctx}
            names={names}
            sortVals={sortVals}
            sortLabel={`${sortField.short}（${wdScopeLabel(wdScope)}）`}
            sortFmt={sortField.fmt}
            hideSortVal={sortField.derived === "alloc"}
            allocMap={allocMap}
            sparkScale={sparkScale}
            onRename={onRename}
          />

          <p className="text-[11px] text-fg-muted">
            列(曜日)方向に色が銘柄をまたいで揃う＝そのビンでの曜日効果はウォッチリスト共通。1銘柄だけ突出＝個別要因/ノイズ。
            前夜米国ビンや対象期間を切り替え、同じ曜日列の傾向が反転/強弱・出現/消滅するかを見る。
          </p>

          {/* ===== 銘柄ランキング表(銘柄×指標) ===== */}
          <div className="space-y-1.5">
            <button
              onClick={() => setShowRank((v) => !v)}
              className="text-xs font-medium text-gray-700 hover:text-blue-600 inline-flex items-center gap-1"
            >
              <span className="text-fg-muted">{showRank ? "▼" : "▶"}</span>
              銘柄ランキング（{wdScopeLabel(wdScope)}・{MU_BASES.find((b) => b.value === muBasis)!.label}）
            </button>
            {showRank && result && allocMap && (
              <CrossRankTable
                result={result}
                rows={sortedRows}
                names={names}
                scope={wdScope}
                basis={muBasis}
                allocMap={allocMap}
                minN={minN}
                haircut={haircut}
              />
            )}
          </div>
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
          <li><strong>値幅・到達</strong>: 上値到達=ln(H/O)(利確余地)、下値到達=ln(L/O)(含み損の深さ=ストップ目安)、日中レンジ=ln(H/L)、ボラ=日中リターンのσ、<strong>パス振幅</strong>=max_t r̄(t) − min_t r̄(t)（平均累積パス r̄(t)=mean ln(P_t/O) の山谷幅）。日中レンジが「各日の値幅を平均したもの(方向が打ち消される前)」なのに対し、パス振幅は「平均してもなお残る方向性の大きさ」。レンジは大きいのに振幅が小さい＝日々よく動くが方向がバラバラ(エッジなし)、両方大きい＝時間帯の癖が一貫。</li>
          <li><strong>トレード質</strong>: 勝率=C&gt;Oの割合、終値位置=(C−L)/(H−L)(1=大引け天井/0=引け安)、シャープ=日中平均/σ。</li>
          <li><strong>時刻</strong>: 上値ピーク/最安時刻=平均累積パスの最大/最小時間、高値/安値時刻=日中の高安を付けた時刻の中央値。前者は『銘柄全体で均した山谷』、後者は『各日が実際に高安を付けた時刻の代表値』で、両者はズレうる(平均パスは打ち消し合いで山谷が緩み時刻が中央寄りに、各日の実測は極値なのでばらつく)。</li>
          <li><strong>形状＋高安時刻</strong>: 寄り基準の平均累積パス r(t)=ln(P_t/O) を各セルにスパークライン描画し、上記4時刻を1枚に重ねて同時表示(● 上値ピーク/最安=平均パス基準、▽△ 高値/安値時刻中央=各日実測)。●と▽△の横のズレで両者の違いを一目で読める。縦軸は3通りから選べる(下記)。振幅の大きさは左上に山谷幅(%)を数値表示。灰帯は平均の±1標準誤差(σ/√n; 日次±1σ~1-2%だと平均パス~0.1-0.5%が潰れるため。枠でクリップし、帯が枠を超えるほど平均が不確か)。破線は寄り(0)の水準。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 形状セルの縦軸(振幅の視覚比較)</p>
        <p>
          {"スパークラインは1セルが小さいため、縦軸の取り方で『何が比較できるか』が変わる。目的に応じて切り替える。"}
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>全銘柄共通（既定）</strong>: 表内の全セル(横断平均行を含む)で縦軸を ±max|r̄(t)|×1.05 に固定。<strong>1%あたりの高さが全セルで等しい</strong>ので、銘柄間・曜日間の振幅の差がそのまま形の大きさとして目に入る。値動きの小さい銘柄は平坦な線になる(それが正しい表現)。個別株分析の曜日パス図が全曜日で ±maxAbs を共有しているのと同じ流儀を、銘柄方向へ拡張したもの。</li>
          <li><strong>銘柄内共通</strong>: 行(銘柄)ごとに縦軸を固定。値がさ・ボラの銘柄間差を打ち消し、「この銘柄の中でどの曜日が大きいか」に集中できる。個別株分析の同一分析と同じ見え方。</li>
          <li><strong>各セル自動</strong>: セルごとに山谷レンジへフィット。大きさは比較できないが、振幅の小さいセルでも山谷の<em>時刻</em>(形の位相)が読める。共通軸で潰れたセルの形を確認したいときに使う。</li>
        </ul>
        <p>
          {"数値で厳密に比べたいときは、指標『パス振幅(山谷幅)』を選べば同じ量が%のヒートマップになる(色の濃さ=振幅の大きさ)。形で見る=共通軸、数で見る=パス振幅指標、の2枚を往復するのが早い。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 並び替え（対象量 × 曜日スコープ × 方向）</p>
        <p>
          {"ヒートマップは(銘柄×曜日)の2次元だが、『どの銘柄に建てるか』を決めるには行を1つの数に潰す必要がある。潰し方が曜日スコープ。曜日 d のセル平均を μ_d、そのσを σ_d、標本数を n_d、標準誤差を se_d = σ_d/√n_d とすると:"}
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>週合計（既定）</strong>: {"μ_row = Σ_{d=月..金} μ_d、σ²_row = Σ_d σ_d²、se_row = √(Σ_d se_d²)。月〜金すべてでその銘柄を回したときの1週間ぶんの量。日をまたぐ独立性を仮定して分散を足している。建玉配分の判断に最も直結する。"}</li>
          <li><strong>平均</strong>: {"μ_row = (1/k)Σ μ_d など、トレード1回あたりに割り戻した量。有効曜日数 k の違いに左右されずに銘柄の質を比べたいとき。"}</li>
          <li><strong>最良曜日</strong>: 並び方向にとって最も有利な曜日1つだけを採用（降順なら最大、昇順なら最小、|値|なら最大絶対値）。週のどこか1日だけ強い銘柄を拾う。</li>
          <li><strong>単一曜日（月〜金）</strong>: その曜日のセルだけ。『火曜に効く銘柄』のような曜日固有のランキングを作るときに使う。該当セルが空の行は常に最下部。</li>
          <li>{"σ・勝率・終値位置・時刻のように足し算できない量では、週合計は自動的に平均になる(その旨がコントロール下に表示される)。"}</li>
        </ul>
        <p>
          {"方向は 降順/昇順/|値| の3つ。|値| は符号を問わず効果の強い順で、買い候補と売り候補を一度に洗い出せる。対象量を切り替えると方向はその量の既定に戻る(例: 下値到達は昇順=深い順)。"}
          {"『表示中の指標』を選んでおくと、上のヒートマップで見ている指標に並びが追従する。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 期待値・t値・配分ウェイトの出し方</p>
        <p>
          {"『どの銘柄にどれだけ建てるか』を機械的に出すため、行スカラーから相対配分を作る。期待値の基準は 日中(寄→引) / 前日比(前引→引) / ギャップ(前引→寄) から選ぶ(選んだ基準の平均・σ・標本数が一貫して使われる)。"}
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>t値</strong>: {"t = μ/se。期待値が0から何標準誤差ぶん離れているか。|t|>2 でおよそ5%有意(ランキング表で★)。n の薄い銘柄の大きな期待値を割り引いて見るための列。"}</li>
          <li><strong>保守値（−1SE割引）</strong>: {"μ̃ = sign(μ)·max(0, |μ| − se)。『期待値から標準誤差1つぶんを削った値』。偶然大きく見えているだけの銘柄は μ̃ がほぼ0になり、自動的に配分から外れる。チェックを外せば生の μ を使う。"}</li>
          <li><strong>ケリー比</strong>: {"k = max(0, μ̃/σ²)。導出は対数効用の最大化 max_q E[ln(1+q·r)] ≈ q·μ − q²σ²/2 を q で微分して q* = μ/σ²。『1単位のリスクあたりどれだけ賭けてよいか』の倍率。"}</li>
          <li><strong>配分%</strong>: {"w_i = k_i / Σ_j k_j。全銘柄で正規化した相対配分で、『予算のうち何%をこの銘柄に割くか』。合計は常に100%になる。"}</li>
          <li><strong>直感的な例え</strong>: {"同じ期待値なら、揺れの小さい銘柄に多く積む。揺れは2乗で効くので、ボラが2倍の銘柄の配分は1/4になる。『儲かりそうな順』ではなく『儲けを揺れで割った順』に近い。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 結果の読み方（ランキング表）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"期待値 μ が大きくても ±SE が同じくらい大きければ t は1前後にしかならず、配分はほぼ付かない。μ・SE・t・配分% を必ずセットで見る。"}</li>
          <li>{"シャープ(μ/σ)が高いのに配分%が低い銘柄は、n が薄くて SE が大きい＝『効率は良さそうだが確認できていない』。逆に配分上位は『そこそこの効率を十分な標本で示している』銘柄。"}</li>
          <li>{"上位3銘柄で配分の大半を占める(表下に%表示)なら、実質的に数銘柄への集中投資。分散しているつもりでも集中していないかをここで確認する。"}</li>
          <li>{"最下段の横断平均行は全銘柄プール。個別行の μ が横断平均と同符号なら『地合い×曜日の共通構造』、単独で外れているなら『固有要因かノイズ』。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 集計と対象期間</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"前夜米国ビンの境界は『対象期間内・全銘柄共通』に取る(日付デデュープした米国リターンを順位分割)。銘柄横断で同じ地合いを比較するため。"}</li>
          <li>{"対象期間はローリング可能。最新起点(窓長可変・右端は最新)または窓長固定で位置をスライド。エッジがどの時期に現れ・消えたか、期間依存かを確認できる。"}</li>
          <li>{"横断平均行は全銘柄の該当日をプールし、日中リターンを『日付クラスタ頑健SE』で検定(同一営業日の全銘柄相関を吸収)。実効標本数nEffも併記。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">8. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>配分→時刻の順で往復する</strong>: まずランキング表(または配分%ソート)で建てる候補と割合を絞り、次にその銘柄の行をヒートマップで見て、上値ピーク/最安時刻・上値到達/下値到達から建玉と手仕舞いの時刻・利確幅・ストップ幅を決める。「誰に賭けるか」と「いつ出入りするか」は別の問いで、前者がこの表、後者がヒートマップ。</li>
          <li><strong>曜日スコープの使い分け</strong>: 週合計＝月〜金を通しで回す前提の配分、単一曜日＝その曜日だけ建てる前提の配分。実際に建てるつもりのスケジュールとスコープを一致させる(木曜しか建てないのに週合計で配分を決めない)。</li>
          <li>今夜の前夜米国は寄り前に確定(上部バナー)。そのビン列で、明日の曜日に最も効く銘柄・向き・利確/損切り時刻を選ぶ。前日比とギャップの分解で「窓で取るか日中で取るか」も判断。</li>
          <li>振幅は<strong>建玉サイズの手がかり</strong>: 同じ勝率・同じ方向なら振幅の大きい銘柄ほど1回の値幅が取れる。逆に振幅が小さいのに有意★が出ているセルは、手数料・スプレッドで消える大きさかを必ず確認する(振幅%が往復コストを下回るなら実行不能)。</li>
          <li>上値到達/下値到達で利確幅とストップ幅の当たりを、終値位置/ピーク時刻で手仕舞い時刻を、勝率/シャープでエッジの質を確認。</li>
          <li>横断平均で共通と確認できた条件だけ採用し、1銘柄だけのシグナルは見送る(過学習回避)。全銘柄同方向＝ブックが地合いに集中(分散不足)、逆行銘柄はヘッジ候補。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">9. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>{"配分%は相関を完全に無視している"}</strong>{"。同じ業種・同じ地合いに乗る銘柄を10個並べても『10銘柄に分散した』ことにはならず、実効レバレッジは √(N/N_eff) 倍に膨らむ(ポートフォリオ画面の『相関ドラッグ』分析が同じ問題を扱っている)。この%は分散効果を最大限見込んだ上限であり、実際にはもっと抑える必要がある。"}</li>
          <li><strong>{"配分%は相対比であって総建玉ではない"}</strong>{"。合計が100%になるのは正規化しているからで、『全額を建てろ』という意味ではない。フルケリーはドローダウンが激しいので、実務では総額に1/2〜1/4を掛けて使う。"}</li>
          <li>{"往復コスト(手数料・スプレッド・スリッページ)は一切控除していない。期待値μや振幅が往復コストを下回る銘柄は、表の上位にあっても実行すると負ける。"}</li>
          <li>{"期待値は過去の平均であって将来の保証ではない。上位に来た銘柄は多重比較(銘柄×曜日×ビン×指標×期間)の勝者でもあるので、対象期間をスライドさせて順位が保たれるかを必ず確認する。"}</li>
          <li>{"振幅は『大きさ』であって『信頼性』ではない。n が小さいセルは平均パスが偶然の1〜2日に引っ張られて大振幅に見える(平均は n の平方根で収束するため、n=3 のセルは n=30 の約3倍ばらつく)。振幅で並べたら必ず n と灰帯(±1標準誤差)の広さを合わせて見る。帯が枠を突き抜けるセルの振幅は信用しない。"}</li>
          <li>{"共通軸で平坦に見えるセルにもエッジはありうる(振幅が小さくても方向が一貫していれば有効)。大きさと有意性は別軸なので、共通軸で当たりを付けたら日中/前日比の★とシャープで裏を取る。"}</li>
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

// 横断平均行の行キー(銘柄コードと衝突しない値)。
const CONSENSUS_KEY = " consensus";

// 共通縦軸(±yMax)。scope 内の全セルで 1% あたりの高さを揃えるための上限。
function scaleMaxAbs(cells: (CellStats | null)[]): number {
  let m = 0;
  for (const c of cells) { const a = cellMaxAbs(c); if (a > m) m = a; }
  return m;
}

function CrossHeatmap({
  result, rows: sortedRows, metric, ctx, names, sortVals, sortLabel, sortFmt, hideSortVal, allocMap, sparkScale, onRename,
}: {
  result: NonNullable<ReturnType<typeof computeCrossRows>>;
  rows: CrossRow[]; // 親で並び替え済み
  metric: Metric;
  ctx: ColorCtx;
  names?: Record<string, string>;
  sortVals: Map<string, number>;
  sortLabel: string;
  sortFmt: Fmt;
  hideSortVal: boolean; // 配分%で並べているときは配分表示と重複するので省く
  allocMap: Map<string, AllocRow> | null;
  sparkScale: SparkScale;
  onRename?: (ticker: string, name: string) => void;
}) {
  const { timeLabels, grid } = result;
  const [nameCol, setNameCol] = useNameColMode();

  // 形状セルの共通縦軸。"all"=表全体(横断平均行も含む), "row"=行ごと, "cell"=なし(自動フィット)。
  const globalMaxAbs = useMemo(() => {
    if (sparkScale !== "all") return 0;
    const all: (CellStats | null)[] = [];
    for (const r of result.rows) all.push(...r.cells);
    all.push(...result.consensus);
    return scaleMaxAbs(all);
  }, [result.rows, result.consensus, sparkScale]);

  const rowMaxAbs = useMemo(() => {
    const m = new Map<string, number>();
    if (sparkScale !== "row") return m;
    for (const r of result.rows) m.set(r.ticker, scaleMaxAbs(r.cells));
    m.set(CONSENSUS_KEY, scaleMaxAbs(result.consensus));
    return m;
  }, [result.rows, result.consensus, sparkScale]);

  // 各セルに渡す共通軸(±yMax)。0/未定義なら PathSpark 側で自動フィット。
  const yMaxFor = (rowKey: string): number => {
    if (sparkScale === "all") return globalMaxAbs;
    if (sparkScale === "row") return rowMaxAbs.get(rowKey) ?? 0;
    return 0;
  };

  const renderCell = (c: CellStats | null, consensusP?: number, rowKey = "") => {
    if (!c || c.n < 1) return <span className="text-gray-300">—</span>;
    if (metric.key === "shape") {
      return (
        <PathSpark
          cell={c}
          grid={grid}
          timeLabels={timeLabels}
          yMax={yMaxFor(rowKey)}
          scaleMode={sparkScale}
        />
      );
    }
    const v = metric.get(c);
    const bg = cellBg(metric, v, ctx);
    const intensity = cellIntensity(metric, v, ctx);
    const color = intensity > 0.55 ? "#ffffff" : "#111827";
    const p = consensusP ?? (metric.p ? metric.p(c) : undefined);
    return (
      <div style={{ backgroundColor: bg, color }} className="rounded px-1 py-1 leading-tight tabular-nums" title={`n=${c.n}｜${metric.label} ${fmtValue(metric.fmt, v, timeLabels)}${p !== undefined ? `｜p=${p.toFixed(3)}` : ""}`}>
        <div className="font-semibold">{fmtValue(metric.fmt, v, timeLabels)}</div>
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
            <th className="text-left font-medium px-2 py-1 sticky left-0 bg-white z-10" style={nameColStyle(nameCol)}>
              <NameColHeader mode={nameCol} onChange={setNameCol} />
            </th>
            {CROSS_WD_ORDER.map((wd) => (
              <th key={wd} className="font-medium px-1 py-1 text-center min-w-[58px]">{CROSS_WD_LABELS[wd]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((r) => (
            <tr key={r.ticker} className="border-t border-gray-100">
              <td className="px-2 py-1 sticky left-0 bg-white z-10" style={nameColStyle(nameCol)}>
                <RowHeader
                  ticker={r.ticker}
                  name={names?.[r.ticker]}
                  // n は曜日スコープに入った立会日数(ランキング表と一致させる)。取れなければ全曜日合計。
                  n={allocMap?.get(r.ticker)?.n ?? r.nTotal}
                  sortVal={sortVals.get(r.ticker) ?? NaN}
                  sortLabel={sortLabel}
                  sortFmt={hideSortVal ? "none" : sortFmt}
                  alloc={allocMap?.get(r.ticker)}
                  timeLabels={timeLabels}
                  onRename={onRename}
                  mode={nameCol}
                />
              </td>
              {r.cells.map((c, i) => (
                <td key={i} className="px-0.5 py-0.5 text-center align-middle">{renderCell(c, undefined, r.ticker)}</td>
              ))}
            </tr>
          ))}
          <tr className="border-t-2 border-gray-300 bg-gray-50">
            <td className="px-2 py-1 sticky left-0 bg-gray-50 z-10" style={nameColStyle(nameCol)}
              title={nameCol === "code" ? `横断平均（${result.nStocks}銘柄プール）` : undefined}>
              <div className="font-bold text-gray-800 truncate">{nameCol === "code" ? "平均" : "横断平均"}</div>
              <div className="text-[9px] text-fg-muted truncate">
                {nameCol === "code" ? `${result.nStocks}銘柄` : `${result.nStocks}銘柄プール`}
              </div>
            </td>
            {result.consensus.map((c: ConsensusCell | null, i) => (
              <td key={i} className="px-0.5 py-0.5 text-center align-middle"
                title={c ? `のべ${c.n}｜独立${c.nDays}日｜実効${c.nEff.toFixed(1)}` : undefined}>
                {renderCell(c, c && metric.key === "intraday" ? c.intradayCrP : undefined, CONSENSUS_KEY)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      {(metric.color === "timeGrid" || metric.color === "timeMin") && (
        <div className="flex items-center gap-2 text-[10px] text-fg-muted mt-1">
          <span>色の濃さ=時刻の遅さ</span>
          <span className="inline-block w-16 h-2 rounded" style={{ background: "linear-gradient(90deg, rgba(37,99,235,0.1), rgba(37,99,235,0.65))" }} />
          <span>寄り → 大引け</span>
        </div>
      )}
      {metric.color === "div" && (
        <div className="text-[10px] text-fg-muted mt-1">緑=プラス / 赤=マイナス、濃いほど大。</div>
      )}
      {metric.key === "shape" && (
        <div className="flex flex-col gap-0.5 text-[10px] text-gray-500 mt-1.5">
          <div>
            寄り基準の平均累積パス。
            {sparkScale === "cell" ? (
              <>
                <span className="text-slate-600 font-medium">縦は各セルの山谷レンジに自動フィット</span>（形状をはっきり表示。大きさの比較は不可）。
                <span className="text-fg-muted">左上の%＝山谷の振幅（大きさはここで比較）</span>、
              </>
            ) : (
              <>
                <span className="text-slate-600 font-medium">
                  縦軸は{sparkScale === "all" ? "全銘柄・全曜日で共通" : "銘柄ごとに共通"}
                  {globalMaxAbs > 0 && sparkScale === "all" && `（±${(globalMaxAbs * 1.05 * 100).toFixed(2)}%）`}
                </span>
                （1%あたりの高さが{sparkScale === "all" ? "表全体" : "その行"}で等しく、
                <span className="text-gray-700 font-medium">振幅の大小をそのまま形の大きさとして比較できる</span>。平坦なセル＝動きが小さい）。
                <span className="text-fg-muted">左上の%＝山谷の振幅、</span>
              </>
            )}
            <span className="text-slate-600">灰帯＝平均の±1標準誤差 σ/√n（枠でクリップ; 帯が枠を超えるほど不確か）</span>。
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            <span><span style={{ color: SP_GREEN }} className="font-bold">●</span> 上値ピーク時刻（平均パス最大＝利確目安）</span>
            <span><span style={{ color: SP_GREEN }} className="font-bold">▽</span> 高値時刻・中央（各日実測の高値時刻）</span>
            <span><span style={{ color: SP_RED }} className="font-bold">●</span> 最安時刻（平均パス最小＝仕込み/損切り目安）</span>
            <span><span style={{ color: SP_RED }} className="font-bold">△</span> 安値時刻・中央（各日実測の安値時刻）</span>
          </div>
          <div className="text-fg-muted">
            ●（均された山谷の時刻）と ▽△（典型的な高安の時刻）の横のズレが両者の違い。近ければ一貫、離れれば日によって高安の付け方がばらつく。破線＝寄り(0)の水準。
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── 銘柄ランキング表(銘柄×指標) ─────────────────────────
//
// ヒートマップは(銘柄×曜日)の面だが、配分を決めるときに欲しいのは(銘柄×指標)の面。
// 曜日スコープで行を1本に潰し、期待値・SE・t・σ・シャープ・ケリー比・配分% を横に並べる。
// 列見出しクリックで並び替え(同じ列を再クリックで昇降反転)。

interface RankRow {
  ticker: string;
  name: string;
  isConsensus: boolean;
  n: number;
  mu: number;
  se: number;
  t: number;
  sd: number;
  sharpe: number;
  ampl: number;
  winRate: number;
  kelly: number;
  weight: number;
  excluded: boolean;
}

type RankKey = keyof Pick<RankRow, "name" | "n" | "mu" | "se" | "t" | "sd" | "sharpe" | "ampl" | "winRate" | "kelly" | "weight">;

const RANK_COLUMNS: { key: RankKey; label: string; dir: "asc" | "desc"; hint: string }[] = [
  { key: "name", label: "銘柄", dir: "asc", hint: "名称 / 銘柄コード" },
  { key: "n", label: "n", dir: "desc", hint: "このスコープに入った立会日数。少ないほど下の数字は当てにならない。" },
  { key: "mu", label: "期待値 μ", dir: "desc", hint: "選んだ基準リターンの平均。曜日スコープが週合計なら月〜金の合計。" },
  { key: "se", label: "±SE", dir: "asc", hint: "μ の標準誤差 σ/√n。小さいほど平均が信用できる。" },
  { key: "t", label: "t", dir: "desc", hint: "μ/SE。|t|>2 でおよそ5%有意(★)。多重比較の補正は入っていない。" },
  { key: "sd", label: "σ", dir: "asc", hint: "1トレードあたりのばらつき。配分の分母(σ²)になる。" },
  { key: "sharpe", label: "シャープ", dir: "desc", hint: "μ/σ。同じリスクでどれだけ取れたか＝効率。" },
  { key: "ampl", label: "振幅", dir: "desc", hint: "平均累積パスの山谷幅。日内の形の大きさ(往復コストと比べる)。" },
  { key: "winRate", label: "勝率", dir: "desc", hint: "引>寄 の割合。50%が中立。" },
  { key: "kelly", label: "ケリー比", dir: "desc", hint: "μ̃/σ²。対数効用での最適建玉比(相関無視・生の倍率)。" },
  { key: "weight", label: "配分%", dir: "desc", hint: "ケリー比を全銘柄で正規化した相対配分。予算のうち何%をこの銘柄に割くか。" },
];

function buildRankRow(r: CrossRow, scope: WdScope, basis: MuBasis, alloc: AllocRow | undefined, name: string, isConsensus: boolean): RankRow {
  const mv = rowMuVar(r, scope, basis, "desc");
  const sd = mv?.sd ?? NaN;
  return {
    ticker: r.ticker,
    name,
    isConsensus,
    n: mv?.n ?? 0,
    mu: mv?.mu ?? NaN,
    se: mv?.se ?? NaN,
    t: mv && mv.se > 0 ? mv.mu / mv.se : NaN,
    sd,
    sharpe: mv && sd > 0 ? mv.mu / sd : NaN,
    ampl: rowScalar(r, cellAmplitude, scope, "desc", true),
    winRate: rowScalar(r, (c) => c.winRate, scope, "desc", false),
    kelly: alloc?.kelly ?? NaN,
    weight: alloc?.weight ?? NaN,
    excluded: alloc?.excluded ?? true,
  };
}

function CrossRankTable({
  result, rows, names, scope, basis, allocMap, minN, haircut,
}: {
  result: NonNullable<ReturnType<typeof computeCrossRows>>;
  rows: CrossRow[];
  names?: Record<string, string>;
  scope: WdScope;
  basis: MuBasis;
  allocMap: Map<string, AllocRow>;
  minN: number;
  haircut: boolean;
}) {
  const [sortKey, setSortKey] = useState<RankKey>("weight");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const rankRows = useMemo(
    () => rows.map((r) => buildRankRow(r, scope, basis, allocMap.get(r.ticker), names?.[r.ticker] || r.ticker, false)),
    [rows, scope, basis, allocMap, names]
  );

  // 横断平均(全銘柄プール)も同じ計算に通して最下段に置く。配分の対象にはしない。
  const consensusRow = useMemo(() => {
    const pseudo: CrossRow = {
      ticker: CONSENSUS_KEY,
      cells: result.consensus,
      nTotal: result.consensus.reduce((a, c) => a + (c?.n ?? 0), 0),
    };
    return buildRankRow(pseudo, scope, basis, undefined, "横断平均", true);
  }, [result.consensus, scope, basis]);

  const sorted = useMemo(() => {
    const out = [...rankRows];
    const sign = sortDir === "asc" ? 1 : -1;
    if (sortKey === "name") out.sort((a, b) => a.name.localeCompare(b.name, "ja") * sign);
    else out.sort((a, b) => cmpVals(a[sortKey] as number, b[sortKey] as number, sortDir));
    return out;
  }, [rankRows, sortKey, sortDir]);

  const onSort = (key: RankKey, dir: "asc" | "desc") => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(dir); }
  };

  const positive = rankRows.filter((r) => isFinite(r.weight) && r.weight > 0);
  const top3 = [...positive].sort((a, b) => b.weight - a.weight).slice(0, 3).reduce((a, r) => a + r.weight, 0);
  const maxW = positive.reduce((m, r) => Math.max(m, r.weight), 0);

  const cell = (v: number, fmt: (x: number) => string, extra = "") =>
    isFinite(v) ? <span className={extra}>{fmt(v)}</span> : <span className="text-gray-300">—</span>;
  const pctS = (x: number) => fmtSignedPct(x, 2);
  const pct2 = (x: number) => `${(x * 100).toFixed(2)}%`;
  const pct0 = (x: number) => `${(x * 100).toFixed(0)}%`;

  const renderRow = (r: RankRow) => (
    <tr key={r.ticker} className={r.isConsensus ? "border-t-2 border-gray-300 bg-gray-50" : "border-t border-gray-100"}>
      <td className="px-2 py-1 text-left">
        <div className={`truncate max-w-[150px] ${r.isConsensus ? "font-bold text-gray-800" : "font-medium text-gray-700"}`} title={r.isConsensus ? `全${result.nStocks}銘柄プール` : `${r.name}（${r.ticker}）`}>
          {r.name}
        </div>
        {!r.isConsensus && r.name !== r.ticker && <div className="text-[9px] text-fg-muted font-mono">{r.ticker}</div>}
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-gray-500">{r.n}</td>
      <td className={`px-2 py-1 text-right tabular-nums font-semibold ${r.mu >= 0 ? "text-emerald-700" : "text-red-600"}`}>{cell(r.mu, pctS)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-fg-muted">{cell(r.se, pct2)}</td>
      <td className="px-2 py-1 text-right tabular-nums">
        {cell(r.t, (x) => x.toFixed(2), Math.abs(r.t) >= 2 ? "text-gray-900 font-semibold" : "text-gray-500")}
        {isFinite(r.t) && Math.abs(r.t) >= 2 && <span className="text-amber-500 ml-0.5">★</span>}
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-gray-500">{cell(r.sd, pct2)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-gray-700">{cell(r.sharpe, (x) => x.toFixed(2))}</td>
      <td className="px-2 py-1 text-right tabular-nums text-gray-500">{cell(r.ampl, pct2)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-gray-500">{cell(r.winRate, pct0)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-gray-700">{cell(r.kelly, (x) => x.toFixed(2))}</td>
      <td className="px-2 py-1 text-right tabular-nums">
        {r.isConsensus ? (
          <span className="text-gray-300">—</span>
        ) : r.excluded ? (
          <span className="text-gray-300" title={`n=${r.n} が最小n(${minN})未満`}>対象外</span>
        ) : (
          <div className="relative">
            <div className="absolute inset-y-0 right-0 rounded-sm bg-emerald-100"
              style={{ width: maxW > 0 ? `${Math.max(2, (r.weight / maxW) * 100)}%` : 0 }} />
            <span className={`relative ${r.weight > 0 ? "font-semibold text-emerald-800" : "text-gray-300"}`}>
              {(r.weight * 100).toFixed(1)}%
            </span>
          </div>
        )}
      </td>
    </tr>
  );

  return (
    <div className="space-y-1">
      <div className="overflow-x-auto">
        <table className="text-[11px] w-full border-collapse">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              {RANK_COLUMNS.map((col) => {
                const active = sortKey === col.key;
                return (
                  <th
                    key={col.key}
                    title={col.hint}
                    onClick={() => onSort(col.key, col.dir)}
                    className={`px-2 py-1.5 cursor-pointer select-none whitespace-nowrap font-medium ${col.key === "name" ? "text-left" : "text-right"} ${active ? "text-blue-600" : "text-gray-500 hover:text-gray-800"}`}
                  >
                    {col.label}
                    <span className="ml-0.5 inline-block w-2">{active ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map(renderRow)}
            {renderRow(consensusRow)}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-fg-muted">
        {positive.length === 0 ? (
          <span className="text-amber-600">配分＝ケリー比 max(0, μ̃/σ²)。保守値 μ̃ がプラスの銘柄が無く、この条件で建てる根拠はない。</span>
        ) : (
          <>
            配分＝ケリー比 max(0, μ̃/σ²) を{positive.length}銘柄で正規化して合計100%
            {positive.length > 3 && <>（上位3銘柄で{(top3 * 100).toFixed(0)}%）</>}。
          </>
        )}
        {haircut ? "μ̃ は期待値から1標準誤差を引いた保守値。" : "μ̃＝生の期待値（割引なし）。"}
        {`n<${minN} の銘柄は対象外。`}
        <span className="text-gray-500">これは銘柄間の相対比（相関を無視した上限）であって、総建玉の大きさではない。</span>
      </p>
    </div>
  );
}

// 銘柄行の見出し。名称(あれば)+ 銘柄コードを併記し、onRename があれば ✎ でインライン編集。
// 編集結果は親(ポートフォリオ)経由でウォッチリストに保存され、名称表示の不整合を解消できる。
// 2行目には「並び替えに使っている値」と「参考配分%」を出し、なぜこの順なのかを行ごとに追える。
// mode="code" では列を細めるため銘柄コードだけを出し、名称/値はツールチップに送る。
function RowHeader({ ticker, name, n, sortVal, sortLabel, sortFmt, alloc, timeLabels, onRename, mode }: {
  ticker: string; name?: string; n: number;
  sortVal: number; sortLabel: string; sortFmt: Fmt;
  alloc?: AllocRow;
  timeLabels: string[];
  onRename?: (ticker: string, name: string) => void;
  mode: NameColMode;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name ?? "");
  const hasName = !!name && name !== ticker;
  const sortTxt = sortFmt === "none" ? "" : fmtValue(sortFmt, sortVal, timeLabels);
  const w = alloc?.weight ?? 0;
  const allocTxt = alloc ? (alloc.excluded ? "—" : `${(w * 100).toFixed(w >= 0.1 ? 0 : 1)}%`) : "";
  const allocTip = alloc
    ? alloc.excluded
      ? `配分対象外（n=${alloc.n} が最小n未満、またはσ=0）`
      : `配分 ${(w * 100).toFixed(1)}%｜ケリー比 ${alloc.kelly.toFixed(2)}｜μ̃=${fmtSignedPct(alloc.muAdj, 2)}（μ=${fmtSignedPct(alloc.mu, 2)} ±SE ${(alloc.se * 100).toFixed(2)}%）｜σ=${(alloc.sd * 100).toFixed(2)}%｜n=${alloc.n}`
    : "";
  // td の左右padding(px-2=8px×2)を除いた実効幅。truncate を効かせるため内側にも上限を置く。
  const innerW = { maxWidth: NAME_COL_W[mode] - 16 };

  if (mode === "code") {
    return (
      <div style={innerW} title={`${hasName ? `${name}（${ticker}）` : ticker}｜n=${n}${sortTxt ? `｜${sortLabel} ${sortTxt}` : ""}${allocTxt ? `｜${allocTip}` : ""}`}>
        <div className="font-mono font-medium text-gray-700 truncate">{ticker}</div>
        <div className="text-[9px] text-fg-muted tabular-nums truncate">
          n={n}
          {allocTxt && <span className="ml-1 text-emerald-600 font-medium">{allocTxt}</span>}
        </div>
      </div>
    );
  }

  if (editing) {
    const commit = () => {
      const t = val.trim();
      if (t) onRename?.(ticker, t);
      setEditing(false);
    };
    return (
      <div className="flex items-center gap-1" style={innerW}>
        <input
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
          className="w-[112px] px-1 py-0.5 text-[11px] border border-gray-300 rounded"
          placeholder={ticker}
        />
        <button onClick={commit} title="保存" className="text-emerald-600 hover:text-emerald-700 text-sm leading-none">✓</button>
        <button onClick={() => setEditing(false)} title="取消" className="text-gray-500 hover:text-gray-600 text-sm leading-none">✕</button>
      </div>
    );
  }

  return (
    <div style={innerW}>
      <div className="flex items-center gap-1">
        <span className="font-medium text-gray-700 truncate" title={hasName ? `${name}（${ticker}）` : ticker}>
          {hasName ? name : ticker}
        </span>
        {onRename && (
          <button
            onClick={() => { setVal(hasName ? name! : ""); setEditing(true); }}
            title="銘柄名を編集(ウォッチリストに保存)"
            className="text-gray-300 hover:text-blue-500 text-[11px] leading-none flex-shrink-0"
          >✎</button>
        )}
      </div>
      <div className="text-[9px] text-fg-muted tabular-nums flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
        {hasName && <span className="font-mono">{ticker}</span>}
        <span>n={n}</span>
        {sortTxt && (
          <span className="text-gray-500" title={`並び替えに使っている値: ${sortLabel}`}>{sortTxt}</span>
        )}
        {allocTxt && (
          <span className={alloc?.excluded ? "text-gray-300" : "text-emerald-600 font-medium"} title={allocTip}>
            配分{allocTxt}
          </span>
        )}
      </div>
    </div>
  );
}

// 1セルの日内平均パス ミニチャート。縦軸は2通り:
//  - yMax>0 (共通軸): ±yMax の対称軸。全銘柄(または行内)で 1% あたりの高さが揃うので、
//    振幅の大小を形の大きさとして直接比較できる。個別株分析の曜日パス図(±maxAbs)と同じ流儀。
//  - yMax=0 (自動フィット): そのセルの平均パス自身のレンジに合わせる。大きさは比較不可だが
//    小さい銘柄でも形(山谷の時刻)がはっきり見える。
// いずれの場合も振幅そのものは左上に山谷幅(%)を数値表示して比較を担保。
// 灰帯=平均の±1標準誤差(σ/√n, 枠でクリップ)。さらに4つの時刻マーカーを重ねる:
//  ● 上値ピーク時刻 / 最安時刻   = 平均累積パスの最大/最小(緑/赤の丸, パス上)
//  ▽ 高値時刻中央 / △ 安値時刻中央 = 各日実測の高安時刻の中央値(緑/赤の三角, 上端/下端)
// ●と▽△の横のズレが「均された山谷」と「典型的な高安の時刻」の違いを表す。
const SP_GREEN = "#16a34a", SP_RED = "#dc2626";
function PathSpark({ cell, grid, timeLabels, yMax = 0, scaleMode = "cell" }: {
  cell: CellStats; grid: BinGrid; timeLabels: string[];
  yMax?: number; // >0 なら ±yMax の共通軸。0 ならセル自動フィット。
  scaleMode?: SparkScale;
}) {
  const { path, band, peakIdx, troughIdx, highMin, lowMin } = cell;
  const W = 104, H = 54, padX = 6, padTop = 9, padBot = 9;
  const G = path.length;
  if (G < 2) return <span className="text-gray-300">—</span>;

  // 山谷の振幅(寄り基準)は縦軸モードによらず同じ量。
  let pLo = Infinity, pHi = -Infinity;
  for (let g = 0; g < G; g++) { if (path[g] < pLo) pLo = path[g]; if (path[g] > pHi) pHi = path[g]; }
  const ampl = pHi - pLo;

  // 縦スケール。共通軸: 0を中央に置いた ±yMax(1.05倍の余白)。自動: 平均パス自身の [min,max]。
  let lo: number, hi: number;
  const fixed = yMax > 0;
  if (fixed) {
    const m = yMax * 1.05;
    lo = -m; hi = m;
  } else {
    const padV = Math.max(ampl * 0.18, 2e-5);
    lo = pLo - padV; hi = pHi + padV;
  }
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
  const axisDesc = fixed
    ? `縦=${scaleMode === "all" ? "全銘柄共通" : "銘柄内共通"}の固定軸 ±${(yMax * 1.05 * 100).toFixed(2)}%（他セルと大きさを直接比較可）`
    : "縦=自セルの山谷に自動フィット（大きさの比較は不可）";
  const title =
    `平均パス形状（寄り基準の累積対数リターン, ${axisDesc}, 灰帯=±1標準誤差 σ/√n）\n` +
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
      <path d={area} fill={CHART_COLORS.reference} opacity={0.18} />
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
      <text x={padX} y={7} fontSize={7.5} fill={CHART_COLORS.ink} style={{ fontVariantNumeric: "tabular-nums" }}>{amplPct}</text>
    </svg>
  );
}
