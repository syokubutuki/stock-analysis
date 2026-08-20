"use client";

// 相関だけを動かすと何が起きるか ── docs/correlation-growth-drag-visualization.md Phase 2
//
// 実データではなく「合成（seeded）」データで、相関 ρ という 1 本のつまみだけを動かす。
// 構成は仕様書 §10.5 Phase 2 のとおり:
//
//   G1 三本の崖   ρ=0 / 0.5 / 0.8 の g(建玉%) 放物線 ＋ 現在地ドット
//   U1 メトロノーム同期アニメ   N 本のミニ株価ラインが ρ を上げるほど同じ形に揃っていく
//   ρスライダー   この 1 本で上の 2 つが同時に動く
//
// 乱数は generateShocks() で先に固定し、ρ が変わっても同じ f・e を混ぜ直すだけにしてある
// （仕様書 §U1 / §10.6）。だから「スライダーを戻せば元の形に戻る」＝ 変わったのは相関だけ、
// が視覚的に保証される。
//
// 描画方式（仕様書 §10.3）:
//   G1 → 横軸が時間でない静的図なので Canvas2D（CLAUDE.md の規約どおり）
//   U1 → 横軸は時間だが**合成データで日付に意味がなく**、価値は「スライダーに対する形の応答」。
//        毎フレーム再描画するアニメーションに lightweight-charts は不向きなため、
//        規約から意図的に逸脱して Canvas2D を採用する（仕様書に理由を明記済み）。

import { useEffect, useMemo, useRef, useState } from "react";
import { PortfolioData } from "../../hooks/usePortfolioData";
import { Horizon, HORIZON_CONFIG } from "../../lib/signal-digest";
import { AlignedReturns, alignReturns, correlationMatrix } from "../../lib/portfolio-risk";
import { WatchlistItem, heldMarketValues, heldWeightsFor } from "../../lib/watchlist";
import {
  DOWNSIDE_RHO_EVENT,
  DownsideRho,
  loadDownsideRho,
  sameUniverse,
} from "../../lib/downside-rho";
import { stressCorrelation } from "../../lib/dcc";
import {
  useStressCorrCI,
  useStressCorrCIProfile,
  type StressProfilePoint,
} from "../../hooks/usePortfolioTail";
import {
  TRADING_DAYS,
  annualStats,
  doublingYears,
  doublingYearsLabel as yearsLabel,
  effectiveN,
  effectiveNFromWeights,
  generateShocks,
  growthCurve,
  hiddenLeverage,
  peakExposure,
  synthPaths,
} from "../../lib/growth-drag";
import { niceStep } from "../../lib/axis-scale";
import AnalysisGuide from "./AnalysisGuide";
import { CHART_COLORS } from "../../lib/chart-colors";

// ── 定数 ───────────────────────────────────────────────────────────────────
/** 崖の横軸（総建玉）の上限。300% ＝ 信用3倍まで見せる（仕様書 §G1）。 */
const W_MAX = 3;
/** 合成系列のバッファ長。ここから 1 年ぶん（WIN）の窓を流していく。 */
const BUF = 1200;
const WIN = TRADING_DAYS;
/** 乱数種。固定することで「同じ乱数の世界で相関だけが変わった」を保証する。 */
const SEED = 20260726;

const REF_RHOS = [
  { rho: 0.0, color: "#16a34a", label: "ρ = 0.0", note: "別々の賭け" },
  { rho: 0.5, color: "#d97706", label: "ρ = 0.5", note: "日本株大型の実勢" },
  { rho: 0.8, color: "#dc2626", label: "ρ = 0.8", note: "同業種で固めた場合" },
];

const pct = (v: number, d = 1) => `${v >= 0 ? "+" : "−"}${(Math.abs(v) * 100).toFixed(d)}%`;

function expoLabel(w: number): string {
  if (!isFinite(w)) return "—";
  return `${(w * 100).toFixed(0)}%`;
}

// ── Canvas サイズ調整（毎フレーム呼ぶので、変化が無いときは再確保しない） ────
function fitCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  if (width <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  if (
    canvas.dataset.w !== String(width) ||
    canvas.dataset.h !== String(height) ||
    canvas.dataset.d !== String(dpr)
  ) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.dataset.w = String(width);
    canvas.dataset.h = String(height);
    canvas.dataset.d = String(dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

interface CurvePt {
  w: number;
  g: number;
}

/** 崖の上に打つドット（現在地／危機時）。同じ建玉のまま曲線だけが入れ替わる、を表す。 */
interface CliffDot {
  /** 総建玉（横位置）。現在地と危機時で同じ値を使う＝「自分は何も変えていない」 */
  exposure: number;
  /** その建玉での成長率（縦位置） */
  g: number;
  label: string;
  color: string;
  /** true なら白抜きの丸、false なら塗り */
  hollow: boolean;
}

interface CliffView {
  mu: number;
  sigma: number;
  N: number;
  rho: number;
  exposure: number;
  refs: { rho: number; color: string; label: string; pts: CurvePt[]; peak: number }[];
  cur: CurvePt[];
  curPeak: number;
  /** 危機時 ρ の曲線（stressRho が渡されたときだけ）。 */
  stress: { rho: number; pts: CurvePt[]; peak: number; label: string } | null;
  /** 崖に打つドット（現在地は必ず 1 つ、危機時があれば 2 つ）。 */
  dots: CliffDot[];
}

interface SyncView {
  N: number;
  mu: number;
  sigma: number;
  exposure: number;
  perAsset: number[][];
  portfolio: number[];
}

/**
 * すべて optional。何も渡さなければ従来どおりの合成データ既定値（ρ=0.5 / N=10 / μ=8% /
 * σ=30%）で動くため、データが無いユーザーでもこのパネルは意味を持つ（常時表示可）。
 *
 * Phase 4（危機Σ連動）: `data` を渡すと、平時／危機時の平均相関・銘柄数・平均ボラを
 * **実測値**で初期化し、崖の上に「平時のあなた」と「暴落時のあなた」の 2 ドットを並べる。
 * 危機レジームの定義は既存 `stressCorrelation`（dcc.ts）に委ねる。
 */
export interface CorrelationDragChartProps {
  /**
   * 実測の元データ（/portfolio のウォッチリスト）。渡すと ρ・N・σ の初期値が実測値になる。
   * 省略すると合成データのみ（従来の挙動）。
   */
  data?: PortfolioData;
  /**
   * ウォッチリスト。渡すと「実際の建玉ウェイトでの N_eff」を等ウェイト版と並べて出せる
   * （等ウェイトのままだと実測 R と等相関近似は恒等的に一致してしまい情報がないため）。
   */
  watchlist?: WatchlistItem[];
  /** リターン窓の指定。data を渡すときだけ意味を持つ（既定 "swing"）。 */
  horizon?: Horizon;
  /** ρ スライダーの初期値。指定すると実測値より優先（既定は実測 → 無ければ 0.5）。 */
  initialRho?: number;
  /** 総建玉の初期値（既定 1.0 ＝ フル現物）。 */
  initialExposure?: number;
  /** 前提の初期値。指定すると実測値より優先（既定は実測 → 無ければ N=10 / σ=30%）。 */
  initialAssets?: number;
  initialSigPct?: number;
  /** 期待リターン μ の初期値（%）。**μ は実測しない**（後述の理由）。既定 8%。 */
  initialMuPct?: number;
  /**
   * 危機時の平均相関。指定すると実測値より優先。渡された（または実測できた）ときだけ
   * 崖に危機時の曲線と第2ドットを重ねる。
   */
  stressRho?: number;
  /** 第2ドットの見出し（既定「暴落時のあなた」）。 */
  stressLabel?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 危機レジームの定義（dcc.ts の stressCorrelation に渡す）。PortfolioRiskPanel と同一。 */
const STRESS_OPTS = { quantile: 0.25, lookback: 60 };

/** Δρ の CI に使うブロック長の選択肢（営業日）。 */
const BLOCK_LENS = [10, 20, 40];

/**
 * 窓依存プロファイルで測る窓（営業日）。データが足りない窓は実データ長に丸められる。
 * 126（半年）〜 2520（10年）まで。標本が増えるほど CI が縮むはずで、そうならなければ
 * 「相関構造そのものが期間で違う」ことを意味する。
 */
const PROFILE_WINDOWS = [126, 252, 504, 756, 1260, 2520];

export interface MeasuredInputs {
  n: number;
  tickers: string[];
  /** 年率ボラの平均（%）。 */
  avgVolPct: number;
  /** 全期間の平均相関。 */
  rhoAll: number;
  /** 平時（低ボラ標本）の平均相関。 */
  rhoCalm: number | null;
  /** 危機時（高ボラ標本）の平均相関。 */
  rhoStress: number | null;
  /** 危機時が測れなかった理由（期間不足など）。 */
  reason: string;
  nStressDays: number;
  nCalmDays: number;
  periods: number;
  /**
   * 実測の相関行列 R をそのまま使った実効銘柄数 (Σw)²/(wᵀRw)（等ウェイト）。
   *
   * 【重要】等ウェイトのとき、これは崖の式が使う等相関近似 N/(1+(N−1)ρ̄) と
   * **恒等的に一致する**（下の nEffEqualCorr と必ず同じ値になる）。証明:
   *   Σᵢⱼ Rᵢⱼ = N + 2·Σ_{i<j} Rᵢⱼ = N + N(N−1)ρ̄  ⇒  N²/Σᵢⱼ Rᵢⱼ = N/(1+(N−1)ρ̄)
   * したがって「実測 R を使えば等相関の近似誤差が見える」というのは**誤り**で、
   * 等ウェイトのままではこの2つを並べても情報がない。近似が本当に効くのは
   * ①ウェイトの偏り（nEffHeld）と ②ペア相関のばらつき（rhoMin/rhoMax）の2つ。
   */
  nEffEmpirical: number;
  /** 等相関近似での N_eff（ρ̄ ＝ 全期間の平均相関）。上と恒等的に一致する。 */
  nEffEqualCorr: number;
  /** 危機時の相関行列での実測 N_eff（危機標本が取れたときだけ）。 */
  nEffStress: number | null;
  /** 実際の建玉ウェイト（時価構成比）での N_eff。建玉が2銘柄未満なら null。 */
  nEffHeld: number | null;
  /** 建玉として数えた銘柄数。 */
  nHeld: number;
  /** ペア相関の最小・最大（1本の ρ では代表できない幅）。 */
  rhoMin: number;
  rhoMax: number;
}

export default function CorrelationDragChart({
  data,
  watchlist,
  horizon = "swing",
  initialRho,
  initialExposure = 1,
  initialAssets,
  initialMuPct = 8,
  initialSigPct,
  stressRho,
  stressLabel = "暴落時のあなた",
}: CorrelationDragChartProps = {}) {
  // ── 実測（data を渡されたときだけ） ────────────────────────────────────
  // 危機レジームは「直近60日のバスケット実現ボラが上位25%の日」。同時点のリターンで
  // 切ると条件付けバイアスで相関が機械的に**下がる**ため、事前に分かるボラで切る
  // （dcc.ts の解説を参照。危機を軽く見せる＝安全に見える間違いになる）。
  const aligned: AlignedReturns | null = useMemo(() => {
    if (!data) return null;
    const series = Object.entries(data)
      .filter(([, v]) => v.prices.length > 2)
      .map(([ticker, v]) => ({ ticker, prices: v.prices }));
    if (series.length < 2) return null;
    const a = alignReturns(series, HORIZON_CONFIG[horizon].window);
    return a.tickers.length >= 2 ? a : null;
  }, [data, horizon]);

  const measured: MeasuredInputs | null = useMemo(() => {
    if (!aligned) return null;

    const st = annualStats(aligned);
    const avgVol = st.vol.reduce((s, v) => s + v, 0) / st.vol.length;
    const stress = stressCorrelation(aligned, STRESS_OPTS);
    const cm = correlationMatrix(aligned);
    const n = aligned.tickers.length;
    const wEq = new Array(n).fill(1 / n);

    // 実際の建玉ウェイト（時価構成比）。等ウェイトとの差＝ウェイトの偏りが N_eff を削る分。
    // 抽出は watchlist.ts の共通関数（YourPortfolioDragPanel / PortfolioRiskPanel と同一）。
    const { weights: wHeld, count: nHeld } = heldWeightsFor(
      aligned.tickers,
      heldMarketValues(data ?? {}, watchlist ?? [])
    );

    // ペア相関の幅（崖が1本の ρ で代表しているものの実体）
    let rhoMin = Infinity;
    let rhoMax = -Infinity;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        rhoMin = Math.min(rhoMin, cm.matrix[i][j]);
        rhoMax = Math.max(rhoMax, cm.matrix[i][j]);
      }

    return {
      nEffHeld: wHeld && nHeld >= 2 ? effectiveNFromWeights(wHeld, cm.matrix) : null,
      nHeld,
      rhoMin: isFinite(rhoMin) ? rhoMin : 0,
      rhoMax: isFinite(rhoMax) ? rhoMax : 0,
      n,
      tickers: aligned.tickers,
      avgVolPct: avgVol * 100,
      rhoAll: cm.avgCorr,
      rhoCalm: stress.ok ? stress.avgCalm : null,
      rhoStress: stress.ok ? stress.avg : null,
      reason: stress.reason,
      nStressDays: stress.nDays,
      nCalmDays: stress.nCalm,
      periods: st.periods,
      nEffEmpirical: effectiveNFromWeights(wEq, cm.matrix),
      nEffEqualCorr: effectiveN(n, cm.avgCorr),
      nEffStress: stress.ok ? effectiveNFromWeights(wEq, stress.matrix) : null,
    };
  }, [aligned, data, watchlist]);

  // ── 危機時 ρ と平時 ρ の差の不確かさ（課題2） ───────────────────────────
  // 点推定だけでは「危機時のほうが低い」がノイズか本物かを判定できないので、
  // ボラのクラスタリングを壊さないブロック単位で再抽出して Δρ の CI を出す。
  // 計算は開いたときだけ走る（このパネルは折りたたみの中でマウントされる）。
  // 400回の再標本化 × 全ペア × 全日はメインスレッドを止めるので Worker へ逃がす。
  const [blockLen, setBlockLen] = useState(20);
  const ciOpts = useMemo(
    () => ({ ...STRESS_OPTS, blockLen, b: 400, level: 0.9 }),
    [blockLen]
  );
  const { value: rhoCI, loading: ciLoading } = useStressCorrCI(aligned, ciOpts);

  // ── 窓依存プロファイル（課題: 窓で結論が変わるのを1枚で見せる） ──────────
  // 252日で「弱い証拠」、756日で「検出不能」のように**窓で結論が入れ替わる**ことがあるので、
  // 窓を横軸に Δρ±CI を並べる。ここだけは常に全期間データから測る（パネル上部の窓設定に
  // 引きずられると「窓を変えた比較」にならないため）。
  const profileAligned: AlignedReturns | null = useMemo(() => {
    if (!data) return null;
    const series = Object.entries(data)
      .filter(([, v]) => v.prices.length > 2)
      .map(([ticker, v]) => ({ ticker, prices: v.prices }));
    if (series.length < 2) return null;
    const a = alignReturns(series, 100000); // 共通営業日の全履歴
    return a.tickers.length >= 2 ? a : null;
  }, [data]);
  const [showProfile, setShowProfile] = useState(false);
  const { value: profile, loading: profileLoading } = useStressCorrCIProfile(
    showProfile ? profileAligned : null,
    PROFILE_WINDOWS,
    ciOpts
  );

  // ── exceedance パネルから送られてきた下側相関 ρ⁻ ─────────────────────────
  // 「測る」パネルと「建玉を決める」パネルを跨ぐので、localStorage + イベントで受け取る
  // （panel-nav.ts と同じ最小構成）。初期値は遅延初期化で読む＝このパネルは SSR されない。
  const [downside, setDownside] = useState<DownsideRho | null>(() => loadDownsideRho());
  useEffect(() => {
    const onRho = (e: Event) => setDownside((e as CustomEvent<DownsideRho | null>).detail ?? null);
    window.addEventListener(DOWNSIDE_RHO_EVENT, onRho as EventListener);
    return () => window.removeEventListener(DOWNSIDE_RHO_EVENT, onRho as EventListener);
  }, []);
  /** 送られてきた ρ⁻ が今のウォッチリストと同じ銘柄構成で測られたか。 */
  const downsideSameUniverse =
    downside != null && measured != null && sameUniverse(downside.tickers, measured.tickers);

  // ── コントロール ──────────────────────────────────────────────────────
  // ρ・N・σ は「ユーザーが触るまでは実測値（無ければ既定値）に追従する」。
  // null = 未操作。データは非同期に届くので、useState の初期値に実測を入れてしまうと
  // 到着前の空データで固定されてしまう。効果（useEffect）での setState はこの
  // プロジェクトの lint で禁じられているため、**派生値で解決する**。
  const [rhoUser, setRhoUser] = useState<number | null>(null);
  const [nUser, setNUser] = useState<number | null>(null);
  const [sigUser, setSigUser] = useState<number | null>(null);
  const [exposure, setExposure] = useState(() => clamp(initialExposure, 0, W_MAX)); // 現在地＝フル現物
  const [muPct, setMuPct] = useState(() => clamp(initialMuPct, 0, 40));
  const [sweeping, setSweeping] = useState(false);

  // 自動追従値（props > 実測 > 既定）。useMemo の依存に載るので、React Compiler が
  // 純粋と判定できる Math.min/max で直接クランプする（自前ヘルパ経由だと
  // 「後で変更されうる値」と見なされてメモ化の保持に失敗する）。
  const rhoAuto = Math.min(0.95, Math.max(0, initialRho ?? measured?.rhoCalm ?? measured?.rhoAll ?? 0.5));
  const nAuto = Math.min(20, Math.max(2, Math.round(initialAssets ?? measured?.n ?? 10)));
  // 実測ボラは端数が長いので 0.1% 刻みに丸める（入力欄の幅に収まらないため）
  const sigAuto =
    Math.round(Math.min(80, Math.max(5, initialSigPct ?? measured?.avgVolPct ?? 30)) * 10) / 10;

  const rho = rhoUser ?? rhoAuto;
  const nAssets = nUser ?? nAuto;
  const sigPct = sigUser ?? sigAuto;
  /** 実測値に追従している（＝ユーザーが触っていない）か。 */
  const followsMeasured = measured != null && rhoUser === null && nUser === null && sigUser === null;

  // 危機時 ρ。props 指定が最優先、無ければ実測。
  const rhoStressMeasured = measured?.rhoStress ?? null;
  const rhoStressRaw = stressRho ?? rhoStressMeasured;
  const rhoStress =
    rhoStressRaw != null && isFinite(rhoStressRaw)
      ? Math.min(0.99, Math.max(0, rhoStressRaw))
      : null;

  const mu = muPct / 100;
  const sigma = sigPct / 100;

  // ── 効く数字（仕様書 §1） ───────────────────────────────────────────────
  const nEff = effectiveN(nAssets, rho);
  const hiddenLev = hiddenLeverage(nAssets, nEff);
  const taxMultiple = nEff > 1e-9 ? nAssets / nEff : nAssets;

  const gAt = useMemo(() => {
    return (w: number, r: number) => {
      const ne = effectiveN(nAssets, r);
      const se2 = (sigma * sigma) / Math.max(ne, 1e-9);
      return w * mu - (w * w * se2) / 2;
    };
  }, [nAssets, sigma, mu]);

  const peakAt = useMemo(() => {
    return (r: number) => peakExposure(mu, sigma / Math.sqrt(Math.max(effectiveN(nAssets, r), 1e-9)));
  }, [mu, sigma, nAssets]);

  // ── G1 曲線 ────────────────────────────────────────────────────────────
  const wGrid = useMemo(() => Array.from({ length: 301 }, (_, i) => (i * W_MAX) / 300), []);

  const gCur = gAt(exposure, rho);
  const gStress = rhoStress != null ? gAt(exposure, rhoStress) : null;
  // 白丸の見出し。実測の平時 ρ に追従しているときだけ「平時のあなた」と言い切る
  // （スライダーを危機時に合わせた状態で「平時」と表示すると嘘になる）。
  const baseDotLabel =
    measured != null && rhoUser === null && measured.rhoCalm != null
      ? "平時のあなた"
      : "あなたの現在地";

  const cliff: CliffView = useMemo(() => {
    // ドットは「同じ建玉のまま曲線だけが入れ替わる」ことを見せるため横位置を共有する。
    // 配列は push で後から変えず、条件付きスプレッドで一度に組む（React Compiler が
    // メモ化を保てるように＝可変オブジェクトを依存に載せない）。
    const dots: CliffDot[] = [
      {
        exposure,
        g: gAt(exposure, rho),
        label: baseDotLabel,
        color: "#111827",
        hollow: true,
      },
      ...(rhoStress != null
        ? [
            {
              exposure,
              g: gAt(exposure, rhoStress),
              label: stressLabel,
              color: "#b91c1c",
              hollow: false,
            },
          ]
        : []),
    ];
    return {
      mu,
      sigma,
      N: nAssets,
      rho,
      exposure,
      refs: REF_RHOS.map((r) => ({
        rho: r.rho,
        color: r.color,
        label: r.label,
        pts: growthCurve(mu, sigma, nAssets, r.rho, wGrid),
        peak: peakAt(r.rho),
      })),
      cur: growthCurve(mu, sigma, nAssets, rho, wGrid),
      curPeak: peakAt(rho),
      stress:
        rhoStress != null
          ? {
              rho: rhoStress,
              pts: growthCurve(mu, sigma, nAssets, rhoStress, wGrid),
              peak: peakAt(rhoStress),
              label: `危機時 ρ=${rhoStress.toFixed(2)}`,
            }
          : null,
      dots,
    };
  }, [mu, sigma, nAssets, rho, exposure, wGrid, peakAt, gAt, rhoStress, stressLabel, baseDotLabel]);

  // ── U1 合成系列（乱数は N が変わったときだけ引き直す） ────────────────────
  const shocks = useMemo(
    () => generateShocks({ N: nAssets, T: BUF, paths: 1, seed: SEED }),
    [nAssets]
  );
  const synth = useMemo(
    () =>
      synthPaths(
        { N: nAssets, rho, mu, sigma, T: BUF, paths: 1, seed: SEED, exposure },
        shocks
      ),
    [nAssets, rho, mu, sigma, exposure, shocks]
  );

  // ── 窓依存プロファイルの描画 ────────────────────────────────────────────
  const profileCanvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = profileCanvas.current;
    if (!canvas || !profile || profile.length === 0) return;
    const draw = () => drawProfile(canvas, profile);
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [profile]);

  // ── 崖の描画（静止画なので state 変化時と resize 時だけ） ──────────────────
  const cliffCanvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = cliffCanvas.current;
    if (!canvas) return;
    const draw = () => drawCliffs(canvas, cliff);
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [cliff]);

  // ── 同期アニメ（rAF ループ。React の再描画を介さず ref から最新値を読む） ──
  const syncCanvas = useRef<HTMLCanvasElement | null>(null);
  const syncWrap = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<SyncView | null>(null);
  const rhoRef = useRef(rho);
  const sweepRef = useRef(false);
  const sweepDirRef = useRef(1);
  const visibleRef = useRef(true);
  const offRef = useRef(0);
  // 描画すべき内容が変わったことを rAF ループへ伝えるカウンタ（毎フレーム再描画しない）
  const versionRef = useRef(0);
  const drawnRef = useRef(-1);

  useEffect(() => {
    viewRef.current = {
      N: nAssets,
      mu,
      sigma,
      exposure,
      perAsset: synth.perAsset,
      portfolio: synth.portfolio[0] ?? [],
    };
    rhoRef.current = rho;
    sweepRef.current = sweeping;
    versionRef.current += 1;
  }, [nAssets, mu, sigma, exposure, synth, rho, sweeping]);

  // 画面外ではアニメを止める（開きっぱなしのパネルで CPU を焼かない）
  useEffect(() => {
    const el = syncWrap.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => {
      visibleRef.current = es.some((e) => e.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    let raf = 0;
    let lastStep = 0;
    let lastSweep = 0;
    const onResize = () => {
      versionRef.current += 1;
    };
    window.addEventListener("resize", onResize);

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const canvas = syncCanvas.current;
      const v = viewRef.current;
      if (!canvas || !v || !visibleRef.current) return;

      // ρ の自動往復（メトロノームが揃っていく様子を、触らなくても見せる）
      if (sweepRef.current && now - lastSweep > 60) {
        lastSweep = now;
        let next = rhoRef.current + sweepDirRef.current * 0.02;
        if (next >= 0.9) {
          next = 0.9;
          sweepDirRef.current = -1;
        } else if (next <= 0) {
          next = 0;
          sweepDirRef.current = 1;
        }
        setRhoUser(Math.round(next * 100) / 100);
      }

      // 1 年ぶんの窓を流す
      let dirty = false;
      if (now - lastStep > 30) {
        lastStep = now;
        offRef.current = (offRef.current + 1) % (BUF - WIN);
        dirty = true;
      }
      if (drawnRef.current !== versionRef.current) {
        drawnRef.current = versionRef.current;
        dirty = true;
      }
      if (dirty) drawSync(canvas, v, offRef.current);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div className="space-y-5">
      {/* ── 実測バナー（Phase 4: 危機Σ連動） ───────────────────────────── */}
      {measured && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-xs font-semibold text-gray-700">
              あなたのウォッチリスト {measured.n} 銘柄の実測
            </span>
            <span className="text-[11px] text-fg-muted tabular-nums">
              {measured.periods}日 / {HORIZON_CONFIG[horizon].label}
            </span>
            {followsMeasured ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                実測値に追従中
              </span>
            ) : (
              <button
                onClick={() => {
                  setSweeping(false);
                  setRhoUser(null);
                  setNUser(null);
                  setSigUser(null);
                }}
                className="text-[10px] px-2 py-0.5 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-100"
              >
                ↩ 実測値に戻す
              </button>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-700 tabular-nums">
            {measured.rhoCalm != null && (
              <span>
                平時 ρ ={" "}
                <strong className="text-gray-900">{measured.rhoCalm.toFixed(2)}</strong>
                {rhoCI?.ok && (
                  <span className="text-fg-muted">
                    {" "}
                    [{rhoCI.calmLo.toFixed(2)}, {rhoCI.calmHi.toFixed(2)}]
                  </span>
                )}
                <span className="text-fg-muted"> （{measured.nCalmDays}日）</span>
              </span>
            )}
            <span>
              全期間 ρ = <strong className="text-gray-900">{measured.rhoAll.toFixed(2)}</strong>
            </span>
            {rhoStressMeasured != null && (
              <span>
                危機時 ρ ={" "}
                <strong className="text-red-700">{rhoStressMeasured.toFixed(2)}</strong>
                {rhoCI?.ok && (
                  <span className="text-fg-muted">
                    {" "}
                    [{rhoCI.stressLo.toFixed(2)}, {rhoCI.stressHi.toFixed(2)}]
                  </span>
                )}
                <span className="text-fg-muted"> （{measured.nStressDays}日）</span>
              </span>
            )}
            <span className="text-gray-500">
              1銘柄の平均ボラ σ = {measured.avgVolPct.toFixed(0)}%
            </span>
          </div>

          {/* ── 課題2: Δρ の不確かさ。CI が 0 を跨ぐなら「差は検出できない」と言い切る ── */}
          {rhoCI?.ok && measured.rhoCalm != null && rhoStressMeasured != null && (
            <div
              className={`mt-2 rounded border px-2 py-1.5 ${
                rhoCI.crossesZero
                  ? "border-gray-200 bg-white"
                  : rhoCI.delta > 0
                    ? "border-red-200 bg-red-50"
                    : "border-blue-200 bg-blue-50"
              }`}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs tabular-nums">
                <span className="text-gray-600">危機時 − 平時 の差 Δρ =</span>
                <strong
                  className={
                    rhoCI.crossesZero
                      ? "text-gray-700"
                      : rhoCI.delta > 0
                        ? "text-red-700"
                        : "text-blue-700"
                  }
                >
                  {rhoCI.delta >= 0 ? "+" : "−"}
                  {Math.abs(rhoCI.delta).toFixed(3)}
                </strong>
                <span className="text-gray-500">
                  {(rhoCI.level * 100).toFixed(0)}% CI [{rhoCI.deltaLo.toFixed(3)},{" "}
                  {rhoCI.deltaHi.toFixed(3)}]
                </span>
                <span className="text-gray-500">p = {rhoCI.pTwoSided.toFixed(3)}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded ${
                    rhoCI.crossesZero
                      ? "bg-gray-200 text-gray-600"
                      : rhoCI.pTwoSided < 0.05
                        ? "bg-amber-100 text-amber-800"
                        : "bg-yellow-50 text-yellow-800 border border-yellow-200"
                  }`}
                >
                  {rhoCI.crossesZero
                    ? "差は検出できない"
                    : rhoCI.pTwoSided < 0.05
                      ? "0 を跨がない（5%水準でも有意）"
                      : "0 を跨がないが弱い（5%水準では非有意）"}
                </span>
                <span className="ml-auto flex items-center gap-1 text-[10px] text-fg-muted">
                  ブロック長
                  {BLOCK_LENS.map((L) => (
                    <button
                      key={L}
                      onClick={() => setBlockLen(L)}
                      className={`px-1.5 py-0.5 rounded border ${
                        blockLen === L
                          ? "bg-gray-700 text-white border-gray-700"
                          : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                      }`}
                      title="再抽出する連続ブロックの長さ（営業日）。ボラのクラスタリングを壊さないための単位。"
                    >
                      {L}日
                    </button>
                  ))}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-gray-500">
                {rhoCI.crossesZero ? (
                  <>
                    ブロック・ブートストラップ（{blockLen}営業日ブロック・{rhoCI.b}回）で
                    Δρ の CI が <strong>0 を跨いでいます</strong>。つまり
                    <strong>この標本では平時と危機時の相関差を検出できません</strong>——
                    上に出ている符号は<strong>ノイズと区別がつかない</strong>ので、
                    向きを結論として読まないでください。
                  </>
                ) : (
                  <>
                    {(rhoCI.level * 100).toFixed(0)}% CI が 0 を跨がないので、この標本では
                    {rhoCI.delta > 0 ? (
                      <strong>危機時に相関が上がっている</strong>
                    ) : (
                      <strong>危機時のほうが相関が低い</strong>
                    )}
                    と読めます（ブロック {blockLen}日・{rhoCI.b}回）。
                    {rhoCI.pTwoSided < 0.05 ? (
                      <>
                        {" "}p = {rhoCI.pTwoSided.toFixed(3)} なので
                        <strong>慣例の5%水準でも有意</strong>です。
                      </>
                    ) : (
                      <>
                        {" "}ただし p = {rhoCI.pTwoSided.toFixed(3)} で
                        <strong>5%水準では有意になりません</strong>——
                        {(rhoCI.level * 100).toFixed(0)}% CI で 0 を外すのは
                        p &lt; {((1 - rhoCI.level)).toFixed(2)} と同義なので、
                        <strong>「弱い証拠」どまり</strong>と読んでください。
                      </>
                    )}
                    {rhoCI.delta < 0 && (
                      <>
                        {" "}一般論の「荒れると相関が上がる」が、少なくともこの標本では
                        成り立っていません。
                      </>
                    )}
                    {" "}いずれにせよ<strong>次の危機で同じ向き・同じ大きさになる保証ではありません</strong>。
                  </>
                )}
                {" "}標準誤差 {rhoCI.deltaSe.toFixed(3)}。ブロック長を変えても符号と結論が
                変わらないかを確認してください（変わるなら、その差は頑健ではありません）。
              </p>
            </div>
          )}
          {ciLoading && rhoStressMeasured != null && (
            <p className="mt-1 text-[11px] text-fg-muted">
              Δρ の信頼区間を計算中…（ブロック・ブートストラップ400回。別スレッドで走ります）
            </p>
          )}
          {rhoCI != null && !rhoCI.ok && rhoStressMeasured != null && (
            <p className="mt-1 text-[11px] text-fg-muted">
              Δρ の信頼区間は算出できませんでした（{rhoCI.reason}）。
            </p>
          )}

          {/* ── 窓依存プロファイル：窓で結論が変わるのを1枚で ─────────────── */}
          {rhoStressMeasured != null && (
            <div className="mt-2">
              <button
                onClick={() => setShowProfile((v) => !v)}
                className="text-[11px] px-2 py-0.5 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-100"
                title="推定に使う期間を変えながら Δρ とその信頼区間を並べる。どの窓でも同じ向きなら本物、窓ごとに入れ替わるならノイズ。"
              >
                {showProfile ? "▼ 窓依存プロファイルを閉じる" : "▶ 窓を変えても同じ結論か（窓依存プロファイル）"}
              </button>
              {showProfile && (
                <div className="mt-2">
                  {profileLoading || !profile ? (
                    <p className="text-[11px] text-fg-muted">
                      {PROFILE_WINDOWS.length}通りの窓でブートストラップ中…（別スレッドで走ります）
                    </p>
                  ) : (
                    <>
                      <canvas ref={profileCanvas} className="w-full" />
                      <p className="mt-1 text-[11px] text-gray-500">
                        横軸＝推定に使う期間（営業日）、縦軸＝Δρ とその
                        {(rhoCI?.level ?? 0.9) * 100}% CI。
                        <strong>灰色のゼロ線を跨いでいる窓は「差を検出できない」</strong>。
                        期間を伸ばすほど CI は縮むはずで、
                        <strong>縮んでもゼロを跨ぎ続けるなら「本当に差がない」</strong>、
                        逆に<strong>窓によって符号が入れ替わるなら相関構造そのものが期間で違う</strong>
                        （どちらか一方の期間の値を将来に当てはめてはいけない）。
                        {(() => {
                          const ok = profile.filter((p) => p.ci.ok);
                          if (ok.length < 2) return null;
                          const signs = new Set(ok.map((p) => Math.sign(p.ci.delta)));
                          const anySig = ok.filter((p) => !p.ci.crossesZero);
                          return (
                            <>
                              {" "}この標本では{ok.length}通りの窓のうち{anySig.length}通りで
                              CI がゼロを外し、符号は
                              {signs.size > 1 ? (
                                <strong className="text-amber-700">窓によって入れ替わっています</strong>
                              ) : (
                                <strong>すべて同じ向きです</strong>
                              )}
                              。
                            </>
                          );
                        })()}
                      </p>
                      <div className="mt-1 overflow-x-auto">
                        <table className="w-full text-[11px] tabular-nums border-collapse">
                          <thead>
                            <tr className="text-fg-muted text-left border-b border-gray-200">
                              <th className="py-1 pr-2 font-medium">期間</th>
                              <th className="py-1 px-2 font-medium text-right">平時 ρ</th>
                              <th className="py-1 px-2 font-medium text-right">危機時 ρ</th>
                              <th className="py-1 px-2 font-medium text-right">Δρ</th>
                              <th className="py-1 px-2 font-medium text-right">CI</th>
                              <th className="py-1 px-2 font-medium text-right">p</th>
                              <th className="py-1 pl-2 font-medium">判定</th>
                            </tr>
                          </thead>
                          <tbody>
                            {profile.map((p) => (
                              <tr key={p.requested} className="border-b border-gray-100">
                                <td className="py-1 pr-2 text-gray-700">
                                  {p.periods}日
                                  {p.periods < p.requested && (
                                    <span className="text-fg-muted">（{p.requested}日要求）</span>
                                  )}
                                </td>
                                <td className="py-1 px-2 text-right text-gray-500">
                                  {p.ci.ok
                                    ? ((p.ci.calmLo + p.ci.calmHi) / 2).toFixed(2)
                                    : "—"}
                                </td>
                                <td className="py-1 px-2 text-right text-gray-500">
                                  {p.ci.ok
                                    ? ((p.ci.stressLo + p.ci.stressHi) / 2).toFixed(2)
                                    : "—"}
                                </td>
                                <td
                                  className={`py-1 px-2 text-right font-medium ${
                                    !p.ci.ok
                                      ? "text-fg-muted"
                                      : p.ci.delta > 0
                                        ? "text-red-700"
                                        : "text-blue-700"
                                  }`}
                                >
                                  {p.ci.ok
                                    ? `${p.ci.delta >= 0 ? "+" : "−"}${Math.abs(p.ci.delta).toFixed(3)}`
                                    : "—"}
                                </td>
                                <td className="py-1 px-2 text-right text-fg-muted">
                                  {p.ci.ok
                                    ? `[${p.ci.deltaLo.toFixed(2)}, ${p.ci.deltaHi.toFixed(2)}]`
                                    : "—"}
                                </td>
                                <td className="py-1 px-2 text-right text-gray-500">
                                  {p.ci.ok ? p.ci.pTwoSided.toFixed(3) : "—"}
                                </td>
                                <td className="py-1 pl-2 text-gray-500">
                                  {!p.ci.ok
                                    ? p.ci.reason
                                    : p.ci.crossesZero
                                      ? "検出できない"
                                      : p.ci.pTwoSided < 0.05
                                        ? "有意"
                                        : "弱い証拠"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── 課題3: 等相関という単純化は、どこで効いてどこで効かないか ──
              等ウェイトなら「実測 R の N_eff」と「等相関近似」は代数的に同じ値になる。
              並べても情報がないので、実際に効く2つ（ウェイトの偏り・ペア相関の幅）を出す。 */}
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-gray-600 tabular-nums">
            <span className="text-gray-500">実効銘柄数 N_eff:</span>
            <span>
              等ウェイト ={" "}
              <strong className="text-gray-900">{measured.nEffEmpirical.toFixed(2)}</strong>
              <span className="text-fg-muted">
                {" "}（実測 R も等相関近似 N/(1+(N−1)ρ̄) も同値）
              </span>
            </span>
            {measured.nEffHeld != null ? (
              <span
                className={
                  measured.nEffHeld < measured.nEffEmpirical * 0.85
                    ? "text-amber-700"
                    : "text-gray-600"
                }
              >
                あなたの建玉ウェイト ={" "}
                <strong>{measured.nEffHeld.toFixed(2)}</strong>
                <span className="text-fg-muted"> （{measured.nHeld}銘柄の時価構成比）</span>
              </span>
            ) : (
              <span className="text-fg-muted">
                建玉ウェイト版は保有2銘柄以上（株数入力あり）で表示
              </span>
            )}
            {measured.nEffStress != null && (
              <span className="text-red-700">
                危機時 R = <strong>{measured.nEffStress.toFixed(2)}</strong>
              </span>
            )}
            <span className="text-gray-500">
              ペア相関の幅 {measured.rhoMin.toFixed(2)} 〜 {measured.rhoMax.toFixed(2)}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-gray-500">
            崖は<strong>全ペアの相関が等しい（等相関）</strong>という単純化の上に立っています。
            ただし<strong>等ウェイトのままでは、実測 R をそのまま使う {" (Σw)²/(wᵀRw) "} と
            等相関近似 N/(1+(N−1)ρ̄) は必ず同じ値になります</strong>
            （{" Σᵢⱼ Rᵢⱼ = N + N(N−1)ρ̄ "} なので代数的に一致。ρ̄ は非対角の平均）。
            つまり<strong>この2つを並べても近似の粗さは測れません</strong>。実際に効くのは次の2つです。
            {measured.nEffHeld == null ? (
              <>
                {" "}①<strong>ウェイトの偏り</strong>：等ウェイトを外れると N_eff は必ず落ちます。
                ウォッチリストに<strong>保有（株数入力あり）を2銘柄以上</strong>登録すると、
                あなたの実際の建玉構成比での N_eff をここに出します。
              </>
            ) : (
              <>
                {" "}①<strong>ウェイトの偏り</strong>：あなたの建玉構成比だと N_eff は{" "}
                <strong>{measured.nEffHeld.toFixed(2)}</strong>（等ウェイトの{" "}
                {((100 * measured.nEffHeld) / Math.max(measured.nEffEmpirical, 1e-9)).toFixed(0)}%）。
                {measured.nEffHeld < measured.nEffEmpirical * 0.85 && (
                  <strong className="text-amber-700">
                    {" "}偏りだけで実質的な分散が
                    {(100 - (100 * measured.nEffHeld) / Math.max(measured.nEffEmpirical, 1e-9)).toFixed(0)}%
                    失われています。
                  </strong>
                )}
              </>
            )}
            {" "}②<strong>ペア相関のばらつき</strong>：実測は {measured.rhoMin.toFixed(2)} 〜{" "}
            {measured.rhoMax.toFixed(2)} に散らばっていて、崖はこれを ρ 1本で代表しています。
            N_eff は一致しても、<strong>どのペアで束になっているかは表現できません</strong>——
            そこは「相関が食べた分」パネルの主成分（実質いくつの賭けか）で確認してください。
          </p>
          {rhoStressMeasured == null && (
            <p className="mt-1 text-[11px] text-amber-700">
              危機時の相関は算出できませんでした（{measured.reason || "期間不足"}）。
              期間の長い窓を選ぶと測れる場合があります。
            </p>
          )}
          {rhoStressMeasured != null && measured.rhoCalm != null && (
            <>
              <p className="mt-1 text-[11px] text-gray-500">
                危機レジームの定義は<strong>「直近60日のバスケット実現ボラが上位25%の日」</strong>。
                同時点の下落率で切ると相関が機械的に下がる（条件付けバイアス）ため、
                <strong>事前に分かるボラ</strong>で切っています。
                {measured.rhoAll > measured.rhoCalm && measured.rhoAll > rhoStressMeasured && (
                  <strong className="text-amber-700">
                    {" "}※ 全期間が両部分標本より高いのはバイアスの検知サインです。
                  </strong>
                )}
              </p>
              {/* 「危機時は相関が上がる」は一般的な傾向にすぎない。実測が逆に出たときに
                  上がった前提の文言を出すと嘘になるので、向きで文面を変える。 */}
              {rhoStressMeasured <= measured.rhoCalm && (
                <p className="mt-1 text-[11px] text-amber-700">
                  ※ この標本では<strong>危機時の相関が平時より低く</strong>出ました
                  （{rhoStressMeasured.toFixed(2)} ≤ {measured.rhoCalm.toFixed(2)}）。
                  「荒れた相場では必ず相関が上がる」は一般的な傾向にすぎず、
                  <strong>あなたの組み合わせでは成り立っていない</strong>という実測結果です。
                  ただし危機時は全体の25%（{measured.nStressDays}日）だけの部分標本なので、
                  この向きが本物かどうかは上の <strong>Δρ の信頼区間</strong>で判定してください
                  {rhoCI?.ok && (
                    <>
                      （現在は<strong>
                        {rhoCI.crossesZero
                          ? "0 を跨いでいる＝差を検出できていません"
                          : rhoCI.pTwoSided < 0.05
                            ? "0 を跨いでおらず p<0.05＝標本内では有意な差です"
                            : "0 を跨がないが p≥0.05＝弱い証拠どまりです"}
                      </strong>）
                    </>
                  )}
                  。銘柄を入れ替えたり窓を長くすると向きが変わることもあります。
                </p>
              )}
            </>
          )}
          <p className="mt-1 text-[11px] text-gray-500">
            <strong>期待リターン μ だけは実測しません</strong>（既定 {muPct}%）。
            μ の推定誤差は σ の推定誤差よりはるかに大きく、過去の平均リターンを入れると
            崖の頂点が「予測」に見えてしまうためです。μ は下の欄で自分の想定に変えてください。
          </p>
        </div>
      )}

      {/* ── ρ スライダー（この 1 本で全部が動く） ───────────────────────── */}
      <div className="rounded-lg border-2 border-blue-200 bg-blue-50 p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-gray-600">銘柄どうしの相関 ρ</span>
            <span className="text-3xl font-bold text-blue-700 tabular-nums">{rho.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={0.95}
            step={0.01}
            value={rho}
            onChange={(e) => {
              setSweeping(false);
              setRhoUser(Number(e.target.value));
            }}
            className="flex-1 min-w-[220px] accent-blue-600"
          />
          <div className="flex gap-1">
            {REF_RHOS.map((r) => (
              <button
                key={r.rho}
                onClick={() => {
                  setSweeping(false);
                  setRhoUser(r.rho);
                }}
                className="px-2 py-0.5 text-xs rounded border"
                style={{
                  borderColor: r.color,
                  color: Math.abs(rho - r.rho) < 1e-9 ? "#fff" : r.color,
                  background: Math.abs(rho - r.rho) < 1e-9 ? r.color : "#fff",
                }}
              >
                {r.rho.toFixed(1)}
              </button>
            ))}
            <button
              onClick={() => setSweeping((s) => !s)}
              className={`px-2 py-0.5 text-xs rounded border ${
                sweeping
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-blue-700 border-blue-300"
              }`}
              title="ρ を 0 ↔ 0.9 でゆっくり往復させる"
            >
              {sweeping ? "⏸ 自動" : "▶ 自動"}
            </button>
          </div>
        </div>

        {/* 実測値へのワンクリック（平時／危機時）。仕様書 §10.5 Phase 4 */}
        {measured && (measured.rhoCalm != null || rhoStressMeasured != null) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-gray-500">実測値に合わせる</span>
            {measured.rhoCalm != null && (
              <button
                onClick={() => {
                  setSweeping(false);
                  setRhoUser(null); // 追従に戻す（＝平時の実測値）
                }}
                className={`px-2 py-0.5 text-xs rounded border ${
                  rhoUser === null
                    ? "bg-gray-800 text-white border-gray-800"
                    : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                }`}
              >
                平時 {measured.rhoCalm.toFixed(2)}
              </button>
            )}
            {rhoStressMeasured != null && (
              <button
                onClick={() => {
                  setSweeping(false);
                  setRhoUser(rhoStressMeasured);
                }}
                className={`px-2 py-0.5 text-xs rounded border ${
                  rhoUser != null && Math.abs(rhoUser - rhoStressMeasured) < 1e-9
                    ? "bg-red-700 text-white border-red-700"
                    : "bg-white text-red-700 border-red-300 hover:bg-red-50"
                }`}
                title="スライダーを危機時の実測相関に合わせる（崖がどれだけ手前に来るかを太線で見る）"
              >
                危機時 {rhoStressMeasured.toFixed(2)}
              </button>
            )}
            {downside != null && (
              <button
                onClick={() => {
                  setSweeping(false);
                  setRhoUser(Math.min(0.95, Math.max(0, downside.rho)));
                }}
                className={`px-2 py-0.5 text-xs rounded border ${
                  rhoUser != null && Math.abs(rhoUser - Math.min(0.95, Math.max(0, downside.rho))) < 1e-9
                    ? "bg-orange-700 text-white border-orange-700"
                    : "bg-white text-orange-700 border-orange-300 hover:bg-orange-50"
                }`}
                title={`exceedance パネルで測った下側相関（θ=±${downside.theta.toFixed(1)}σ・${downside.periods}日・ヌル: ${downside.nullLabel}）。下げているときのあなたの崖を見るための値。`}
              >
                下側 ρ⁻ {downside.rho.toFixed(2)}
              </button>
            )}
          </div>
        )}
        {downside != null && (
          <p className="mt-1 text-[11px] text-gray-500">
            「下側 ρ⁻」は<strong>下落時“だけ”相関が上がるか</strong>パネルで測った値
            （θ=±{downside.theta.toFixed(1)}σ・{downside.periods}日・ヌル {downside.nullLabel}）。
            <strong>平時の ρ で建玉を決めていると、下げている最中のあなたは別の崖に立っています</strong>——
            このボタンで ρ を差し替え、頂点（最速の建玉）がどこまで手前に来るかを確認してください。
            {!downsideSameUniverse && (
              <strong className="text-amber-700">
                {" "}※ 測定時の銘柄構成（{downside.tickers.length}銘柄）が今と違うので参考値です。
              </strong>
            )}
            {Number.isFinite(downside.asymP) && downside.asymP >= 0.05 && (
              <strong className="text-amber-700">
                {" "}※ 非対称性は検出されていません（p={downside.asymP.toFixed(3)}）。
                ρ⁻ が高く見えても条件付けと標本ノイズで説明がつく範囲かもしれません。
              </strong>
            )}
          </p>
        )}
        <p className="mt-1.5 text-xs text-gray-700">
          {nAssets} 銘柄に分散したつもりでも、実質は{" "}
          <strong className="text-blue-700 tabular-nums text-base">{nEff.toFixed(1)} 銘柄</strong>
          。隠れレバレッジ{" "}
          <strong className="text-blue-700 tabular-nums">{hiddenLev.toFixed(2)} 倍</strong>、
          払っているボラティリティ税は本当に分散できていた場合の{" "}
          <strong className="text-blue-700 tabular-nums">{taxMultiple.toFixed(1)} 倍</strong>{" "}
          （N / N_eff）。
        </p>
      </div>

      {/* ── U1 メトロノーム同期アニメ ──────────────────────────────────── */}
      <div>
        <div className="text-xs font-semibold text-gray-700 mb-1.5">
          {nAssets} 本の値動きは、ρ を上げるほど「同じ形」になっていく
        </div>
        <div ref={syncWrap} className="relative">
          <canvas ref={syncCanvas} className="w-full" />
          <div className="absolute top-1 right-2 text-right pointer-events-none rounded bg-[#fafafa]/85 px-1.5 py-0.5">
            <div className="text-[10px] text-gray-500">実質銘柄数</div>
            <div className="text-xl font-bold tabular-nums text-gray-800">
              <span className="text-fg-muted">{nAssets.toFixed(1)}</span>
              <span className="text-gray-500 text-sm"> → </span>
              <span
                className={
                  nEff > nAssets * 0.7
                    ? "text-green-700"
                    : nEff > nAssets * 0.4
                      ? "text-amber-600"
                      : "text-red-600"
                }
              >
                {nEff.toFixed(1)}
              </span>
            </div>
          </div>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          上段＝{nAssets}銘柄それぞれの値動き（1年ぶんの窓が流れています）。下段＝それを等ウェイトで合成した
          ポートフォリオ（総建玉 {(exposure * 100).toFixed(0)}%）。灰色の破線は「ドラッグを無視した見かけの
          期待リターン W·μ」。
          <strong>
            {" "}乱数は固定してあるので、スライダーを戻せば元の形にぴったり戻ります
          </strong>
          ——変わったのは相関だけ、という証明です。ρ=0 では下段は滑らかに右肩上がり、ρ→1 では上段と同じくらい
          暴れて、上昇が鈍ります。
        </p>
      </div>

      {/* ── G1 三本の崖 ────────────────────────────────────────────────── */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
          <div className="text-xs font-semibold text-gray-700">
            三本の崖：入口の傾きは同じ。崖の位置だけが違う
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <span className="text-gray-500">あなたの総建玉</span>
            <input
              type="range"
              min={0}
              max={W_MAX}
              step={0.05}
              value={exposure}
              onChange={(e) => setExposure(Number(e.target.value))}
              className="w-40 accent-gray-700"
            />
            <span className="w-12 text-right tabular-nums font-semibold">
              {(exposure * 100).toFixed(0)}%
            </span>
          </label>
        </div>
        <canvas ref={cliffCanvas} className="w-full" />
        <p className="mt-1 text-[11px] text-gray-500">
          白丸＝あなたの現在地（総建玉 {(exposure * 100).toFixed(0)}%）。
          <strong>
            {" "}ρ を上げても丸は動きません。動くのは足元の崖のほうです。
          </strong>{" "}
          今の ρ={rho.toFixed(2)} では 実質成長率{" "}
          <strong className={gCur > 0 ? "text-gray-800" : "text-red-700"}>{pct(gCur)}</strong>、
          2倍になるまで <strong>{yearsLabel(doublingYears(gCur))}</strong>。
          薄赤の領域に入ったら、期待リターンが正でも資産は増えません。
          {rhoStress != null && gStress != null && (
            <>
              {" "}赤い破線＝<strong>危機時 ρ={rhoStress.toFixed(2)}</strong> の崖、赤い丸が
              {stressLabel}です。
              {rhoStress > rho ? (
                <>
                  <strong>建玉は 1mm も動かしていないのに</strong>、相関が上がっただけで成長率は{" "}
                  {pct(gCur)} から{" "}
                  <strong className={gStress > 0 ? "text-gray-800" : "text-red-700"}>
                    {pct(gStress)}
                  </strong>{" "}
                  へ落ち、2倍になるまでが {yearsLabel(doublingYears(gCur))} から{" "}
                  <strong>{yearsLabel(doublingYears(gStress))}</strong> へ延びます。
                </>
              ) : (
                <>
                  この標本では危機時の相関が今の ρ={rho.toFixed(2)} より<strong>低い</strong>ため、
                  赤い丸は白丸より<strong>上</strong>にあります（g {pct(gCur)} →{" "}
                  {pct(gStress)}）。相関が上がるとは限らない、という実測結果です——
                  ただし部分標本からの推定なので振れ幅は大きく、
                  <strong>次の危機で同じ向きとは限りません</strong>。
                </>
              )}
            </>
          )}
        </p>

        {/* 2ドットの意味を、数式でも統計でもなく「社会がすでに制度として出した答え」で言う。
            保険数理では相関の破れが除外条項として明文化されている（地震保険が別建てなのはそのため）。
            記号ゼロで音読でき、読者が生活の中で検算できる唯一の説明なので本文側に置く。 */}
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-[11px] text-gray-700">
          <div className="text-xs font-semibold text-gray-800">
            なぜ「一斉に下がる」ことだけが致命傷なのか — 火災保険が地震を引き受けない理由と同じです
          </div>
          <p className="mt-1">
            通常の火災保険は、<strong>地震による火災を補償しません</strong>。火事が別々に起きているうちは、
            契約を集めるほど平均に近づいて分散できます。ところが地震は、
            <strong>すべての契約を同時に燃やします</strong>。同時に来るリスクは、何件集めても分散されない
            ——だから保険会社はそれを<strong>除外条項</strong>として契約から切り離し、
            地震保険という別建て（政府の再保険つき）にしています。
            <strong>「分散できないリスクは引き受けない」というプロの判断が、条文になっている</strong>わけです。
          </p>
          <p className="mt-1.5">
            上の図の
            {rhoStress != null ? (
              <>
                <strong className="text-red-700">赤い丸</strong>が、あなたにとっての「地震による火災」です。
              </>
            ) : (
              <>
                <strong>ρ を右へ動かしたときの崖</strong>が、あなたにとっての「地震による火災」です。
              </>
            )}
            銘柄はバラバラに見えても、暴落は全部を同時に燃やしにきます。違うのは一点だけ——
            <strong className="text-red-700">あなたの口座には除外条項がありません</strong>。
            保険会社と違って「この部分は引き受けません」と言えない。
            切り離せない以上、打てる手は<strong>建玉（丸の横位置）を自分で下げておくこと</strong>だけです。
          </p>
          <p className="mt-1.5 text-gray-500">
            確率論の言葉で言えば、保険が成り立つのは大数の法則が効く＝各契約が<strong>独立</strong>だからで、
            地震はその独立性を壊します。ポートフォリオで同じ役をするのが相関 ρ で、
            ρ が上がるほど実効銘柄数 N_eff は 1 に近づく——
            <strong>「10銘柄」が「1銘柄を10倍」に変わる</strong>のがその瞬間です。
          </p>
        </div>
      </div>

      {/* 崖の要約表（仕様書 §G1 の表） */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-gray-300 text-gray-500">
              <th className="text-left py-1 px-2 font-medium">相関 ρ</th>
              <th className="text-right py-1 px-2 font-medium">実質銘柄数 N_eff</th>
              <th className="text-right py-1 px-2 font-medium">隠れレバ</th>
              <th className="text-right py-1 px-2 font-medium">最速となる建玉</th>
              <th className="text-right py-1 px-2 font-medium">成長率ゼロになる建玉</th>
              <th className="text-right py-1 px-2 font-medium">
                今の建玉（{(exposure * 100).toFixed(0)}%）での g
              </th>
              <th className="text-right py-1 px-2 font-medium">2倍まで</th>
            </tr>
          </thead>
          <tbody>
            {[
              ...REF_RHOS.map((r) => ({ rho: r.rho, color: r.color, note: r.note, cur: false })),
              {
                rho,
                color: "#111827",
                note:
                  measured && rhoUser === null
                    ? "平時のあなた（実測）"
                    : "今のスライダー位置",
                cur: true,
              },
              // 危機時 ρ が測れた（または渡された）ときだけ最下段に並べる
              ...(rhoStress != null
                ? [
                    {
                      rho: rhoStress,
                      color: "#b91c1c",
                      note: `${stressLabel}（${stressRho != null ? "指定値" : "危機時の実測相関"}）`,
                      cur: true,
                    },
                  ]
                : []),
              // exceedance パネルから受け取った下側相関（下げている最中の崖）
              ...(downside != null
                ? [
                    {
                      rho: Math.min(0.95, Math.max(0, downside.rho)),
                      color: "#c2410c",
                      note: `下落時テール ρ⁻（θ=±${downside.theta.toFixed(1)}σ）`,
                      cur: true,
                    },
                  ]
                : []),
            ].map((r, i) => {
              const ne = effectiveN(nAssets, r.rho);
              const pk = peakAt(r.rho);
              const g = gAt(exposure, r.rho);
              return (
                <tr
                  key={i}
                  className={`border-b border-gray-100 ${r.cur ? "bg-gray-100 font-semibold" : ""}`}
                >
                  <td className="py-1.5 px-2 whitespace-nowrap">
                    <span
                      className="inline-block w-3 h-1.5 rounded-sm mr-1.5 align-middle"
                      style={{ background: r.color }}
                    />
                    <span className="tabular-nums">{r.rho.toFixed(2)}</span>{" "}
                    <span className="text-fg-muted font-normal">{r.note}</span>
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{ne.toFixed(1)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                    {hiddenLeverage(nAssets, ne).toFixed(2)}×
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{expoLabel(pk)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{expoLabel(pk * 2)}</td>
                  <td
                    className={`py-1.5 px-2 text-right tabular-nums ${
                      g > 0 ? "text-gray-800" : "text-red-700"
                    }`}
                  >
                    {pct(g)}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                    {yearsLabel(doublingYears(g))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 前提（μ・σ・N）。実測が使えている項目には「実測」バッジを出す。 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-600 border-t border-gray-100 pt-3">
        <span className="text-fg-muted">{measured ? "前提（ρ・N・σ は実測）" : "前提（合成データ）"}</span>
        <label className="flex items-center gap-1">
          銘柄数 N
          {measured && (
            <span
              className={`text-[10px] px-1 rounded ${
                nUser === null ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"
              }`}
            >
              {nUser === null ? "実測" : "手動"}
            </span>
          )}
          <input
            type="number"
            min={2}
            max={20}
            step={1}
            value={nAssets}
            onChange={(e) =>
              setNUser(Math.max(2, Math.min(20, Math.round(Number(e.target.value) || 10))))
            }
            className="w-14 px-1 py-0.5 border border-gray-300 rounded text-right tabular-nums"
          />
        </label>
        <label className="flex items-center gap-1">
          期待リターン μ
          {measured && (
            <span
              className="text-[10px] px-1 rounded bg-amber-100 text-amber-700"
              title="μ は実測しません。推定誤差が σ よりはるかに大きく、崖の頂点が「予測」に見えてしまうため。"
            >
              仮定
            </span>
          )}
          <input
            type="number"
            min={0}
            max={40}
            step={1}
            value={muPct}
            onChange={(e) => setMuPct(Math.max(0, Math.min(40, Number(e.target.value) || 0)))}
            className="w-14 px-1 py-0.5 border border-gray-300 rounded text-right tabular-nums"
          />
          %
        </label>
        <label className="flex items-center gap-1">
          1銘柄のボラ σ
          {measured && (
            <span
              className={`text-[10px] px-1 rounded ${
                sigUser === null ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"
              }`}
            >
              {sigUser === null ? "実測" : "手動"}
            </span>
          )}
          <input
            type="number"
            min={5}
            max={80}
            step={1}
            value={sigPct}
            onChange={(e) => setSigUser(Math.max(5, Math.min(80, Number(e.target.value) || 30)))}
            className="w-16 px-1 py-0.5 border border-gray-300 rounded text-right tabular-nums"
          />
          %
        </label>
        <span className="text-fg-muted">
          いずれも年率。
          {measured
            ? "ρ・N・σ はウォッチリストの実測値、μ だけが仮定です。手で変えると「手動」に切り替わり、上の「実測値に戻す」で戻せます。"
            : "既定値は μ=8% / σ=30% / N=10（日本株の大型株を想定した水準）。"}
        </span>
      </div>

      <AnalysisGuide title="相関・実効銘柄数・成長率カーブの詳細理論">
        <p className="font-medium text-gray-700">1. 手法の概要</p>
        <p>
          「期待リターン」は<strong>足し算の世界</strong>の言葉です。100人が1回ずつ賭けたときの、100人の平均。
          でもあなたの資産は<strong>掛け算</strong>で増えます。今年の結果に来年の結果を掛ける。
          掛け算の世界では、上下に揺れること自体が資産を削ります。+10%と−10%を繰り返すと、
          平均は0%なのに資産は減っていく。この「揺れの分の目減り」を<strong>ボラティリティ税</strong>
          （ボラティリティ・ドラッグ）と呼びます。
        </p>
        <p>
          このパネルは、その税を決める最大の要因である<strong>銘柄どうしの相関 ρ</strong> だけを取り出して
          動かします。銘柄を足すと期待リターンは足し算で増えますが、税は<strong>二乗</strong>で増える。
          しかも似た値動きの銘柄を足すと揺れは打ち消し合わず、そのまま積み上がります。
          上のアニメーションは<strong>同じ乱数</strong>を使い、混ぜ方（相関）だけを変えています。
          スライダーを戻せば形が完全に元へ戻るのは、変わったのが相関だけだからです。
          下の「三本の崖」は、その相関が<strong>持てる建玉の上限</strong>をどれだけ手前に引き寄せるかを示します。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          対数リターン {" r_t = log(P_t / P_{t−1}) "}、資産の成長は {" W_T = W_0 · exp(Σ r_t) "}。
          算術平均（期待リターン）を μ_a、幾何平均（実質成長率）を g とすると、
          {" log(1+x) ≈ x − x²/2 "} を期待値に取り {" E[x²] ≈ σ² "} として
        </p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">g ≈ μ_a − σ²/2</p>
        <p>
          （対数正規分布なら近似ではなく厳密）。この {" σ²/2 "} がボラティリティ・ドラッグです。
          ポートフォリオの分散は {" σ_p² = Σ_i Σ_j w_i w_j σ_i σ_j ρ_ij "}。
          等ウェイト・共通 σ・共通 ρ なら
        </p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">
          σ_p² = σ²[ 1/N + (1−1/N)ρ ] = σ²/N_eff , N_eff = N/(1+(N−1)ρ)
        </p>
        <p>総建玉 W のときの成長率は3項に分解できます。これが「三本の崖」の式そのものです。</p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">
          g(W) = W·μ − W²σ²/(2N) − W²σ²(1−1/N)ρ/2
        </p>
        <p>
          第1項が期待（W に<strong>比例</strong>）、第2項が単独ドラッグ、第3項が相関ドラッグ
          （どちらも W の<strong>二乗</strong>）。だから 3 本の曲線は<strong>原点での傾きが完全に一致</strong>し
          （同じ μ）、離れていくのは二乗項だけ。放物線の頂点と g=0 交点は
        </p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">
          W* = μ / σ_eff² , σ_eff = σ/√N_eff  ／  g(W)=0 となるのは W = 2W*
        </p>
        <p>
          フルケリー比 {" λ = W / W* "} を使うと {" g(λ)/g_max = 2λ − λ² "}。λ=1 で最大、
          <strong>λ=2 で成長率ちょうどゼロ、λ&gt;2 では資産が減っていきます</strong>
          （期待値は増え続けているのに）。
        </p>
        <p>
          <strong>「相関を無視する」の数学的な意味</strong>: ρ を 0 と誤認して W* を計算すると、
          真の最適の {" √(1+(N−1)ρ) "} 倍の建玉を持つことになります。すなわち
          {" λ_true = √(N/N_eff) "}（＝隠れレバレッジ）。N=10, ρ=0.5 なら λ=2.35 で
          {" 2λ−λ² = −0.82 "}、成長率は最大値の −82%、つまり資産は減っていきます。
        </p>
        <p>
          アニメーションの合成方法は
          {" r_i,t = μ/T + σ_T·( √ρ·f_t + √(1−ρ)·e_i,t ) "}。共通ファクター f と個別ノイズ e を
          {" √ρ : √(1−ρ) "} で混ぜると、任意の 2 銘柄の相関はちょうど ρ になります
          （{" Cov = ρ·Var(f) = ρ "}、分散は {" ρ+(1−ρ)=1 "} で不変）。
          <strong>f と e は種を固定して先に作ってあり</strong>、ρ を変えても混合係数だけが変わります。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>相関 ρ</strong>: 2銘柄の値動きがどれだけ一緒に動くか。1 なら完全に同じ動き、
            0 なら無関係、−1 なら正反対。ここでは全ペア共通の平均相関として扱う。
          </li>
          <li>
            <strong>算術平均（期待リターン）</strong>: 各期のリターンを単純に平均したもの。
            「大勢の人の平均」に相当し、あなた1人の資産の伸びとは一致しない。
          </li>
          <li>
            <strong>幾何平均（実質成長率 g）</strong>: 資産が実際に増えていく速さ。
            掛け算の平均。長期投資で意味を持つのはこちらだけ。
          </li>
          <li>
            <strong>ボラティリティ・ドラッグ（ボラティリティ税）</strong>: 算術平均と幾何平均の差 σ²/2。
            値動きが荒いだけで自動的に取られる目減り分。
          </li>
          <li>
            <strong>実効銘柄数 N_eff</strong>: {" N/(1+(N−1)ρ) "}。
            「実質的に何個の<em>別々の</em>賭けを持っているか」。ρ=0 なら N、ρ=1 なら 1。
          </li>
          <li>
            <strong>N / N_eff</strong>: {" 1+(N−1)ρ "}。
            <strong>払っているボラティリティ税が、本当に分散できていた場合の何倍か</strong>。
          </li>
          <li>
            <strong>隠れレバレッジ</strong>: {" √(N/N_eff) "}。思っていたリスクの何倍を実際に負っているか。
          </li>
          <li>
            <strong>総建玉 W</strong>: 現金を含む資産に対する株式の比率。100% がフル現物、200% が信用2倍。
          </li>
          <li>
            <strong>倍化年数</strong>: {" ln2/g "}。成長率を「2倍になるまで何年か」に翻訳したもの。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>メトロノーム</strong>: 台の上に載せたメトロノームは、最初バラバラでも、
            台が揺れる（＝共通ファクター）とやがて全部が同じ拍で揃う。上のアニメがまさにそれ。
            揃った瞬間、10台あっても「1台を10倍の音量で鳴らしている」のと同じになる。
          </li>
          <li>
            <strong>卵とカゴとトラック</strong>: 卵を10個のカゴに分けたが、カゴを全部同じトラックに載せている。
            事故れば全部割れる。カゴの数（銘柄数）ではなく<strong>トラックの数（N_eff）</strong>が本当の分散。
          </li>
          <li>
            <strong>占い師</strong>: 別々の10人の占い師に聞く（ρ=0）のと、1人の占い師に10回聞く（ρ=1）のは違う。
            後者は自信が10倍になるだけで、情報は1つ分。
          </li>
          <li>
            <strong>和音とボリューム</strong>: 違う音を重ねると和音（分散）。同じ音を10個重ねても音量が10倍になるだけ
            （レバレッジ）。うるさいだけで曲は豊かにならない。
          </li>
          <li>
            <strong>穴の空いたバケツ</strong>: 期待リターン＝蛇口の水量、ボラ＝バケツの穴。
            相関の高い銘柄を足すと蛇口は太くなるが、穴は<strong>もっと速く</strong>大きくなる（穴は二乗で効く）。
          </li>
          <li>
            <strong>崖の位置</strong>: 3本の坂は入口の傾きが同じ。違うのは「どこで落ちるか」だけ。
            相関が高いほど崖は<strong>手前</strong>にある。同じ歩幅で歩いても、落ちる人と落ちない人が出る。
          </li>
          <li>
            <strong>地震と火災保険</strong>: 通常の火災保険が地震による火災を補償しないのは、
            地震が<strong>全契約を同時に燃やす</strong>＝独立性（大数の法則の前提）を壊すから。
            保険数理はこの「相関の破れ」を<strong>除外条項</strong>という形で明文化していて、
            地震だけ別建ての保険＋政府の再保険に切り出している。
            暴落時に ρ→1 になるポートフォリオはこれと同じ構造だが、
            <strong>投資家には除外条項が無い</strong>。プロが「引き受けない」と判断したリスクを、
            分散できているつもりで抱えている状態がありうる。打てる手は建玉を下げることだけ。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>3本の曲線は原点で必ず重なる</strong>。相関は「入口のうまみ」を一切変えない。
            変えるのは<strong>頂点（最速の建玉）</strong>と<strong>g=0 になる建玉</strong>の位置だけ。
          </li>
          <li>
            白丸（現在地）が頂点より<strong>右</strong>にあれば、建玉を減らすほど成長率が上がる領域。
            薄赤の帯まで来たら、期待リターンが正でも資産は増えない。
          </li>
          <li>
            μ=8% / σ=30% / N=10 の既定値では、ρ=0 の頂点は 890%、ρ=0.5 では 162%、ρ=0.8 では 108%。
            <strong>ρ=0.8 ならフル現物（100%）ですでに頂点の手前ぎりぎり</strong>、信用2.2倍で成長率ゼロ。
          </li>
          <li>
            N / N_eff = 5.5 なら、<strong>払っている税は本物の分散の5.5倍</strong>。
            銘柄数を増やしても、この数字が下がらなければ分散にはなっていない。
          </li>
          <li>
            上段のアニメで線の形がそっくりになったら、それは「10銘柄」ではなく「1銘柄を10倍」。
            右上のカウンタ（実質銘柄数）がその度合いを数字にしている。
          </li>
          <li>
            下段の合成ポートフォリオが灰色の破線（見かけの期待リターン）から下に離れていくぶんが、
            ドラッグとして実際に失われている部分。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>建玉上限を「崖の手前」から逆算する</strong>。自分のポートフォリオの平均相関を
            「相関が食べた分」パネルで測り、その ρ をここに入れて頂点 W* を読む。実際の建玉は
            <strong>W* の半分以下（λ&lt;0.5）</strong>に置くのが実務的に安全。
          </li>
          <li>
            <strong>同業種の追加は「分散」ではなく「増し玉」と認識する</strong>。ρ を 0.5 → 0.8 に動かしたときの
            崖の移動量が、その追加で失う建玉余力そのもの。
          </li>
          <li>
            レバレッジを検討するときは、必ず ρ を実勢（日本株大型なら 0.5 前後）にしてから頂点を見る。
            ρ=0 の感覚で建てると、真の最適の {" √(1+(N−1)ρ) "} 倍を持ってしまう。
          </li>
          <li>
            相関の低い資産（外国株・債券・コモディティ）を1つ入れるほうが、
            期待リターンの高い似た銘柄を3つ足すより g を上げることがある。ρ を下げたときの崖の後退量で確認できる。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">
          7. 平時と危機時（実測相関の入れ方）
        </p>
        <p>
          相関は定数ではありません。一般には<strong>穏やかな相場では低く、荒れると上がる</strong>
          傾向があります。このパネルは、あなたのウォッチリストから
          <strong>平時 ρ と危機時 ρ を別々に実測</strong>して崖の上に 2 つのドットを並べます。
          白丸が「平時のあなた」、赤丸が「暴落時のあなた」。
          <strong>横位置（総建玉）は同じ</strong>です——あなたは何も売買していないのに、
          相関が上がるだけで足元の崖が手前へずり寄り、成長率だけが落ちる。それが見えます。
        </p>
        <p>
          ただし<strong>これは「必ずそうなる」法則ではありません</strong>。実測すると
          危機時 ρ が平時 ρ より<strong>低く</strong>出る組み合わせもあります（例: 金利で動く銀行株と
          グロース株のように、荒れた局面で逆方向に振れる組み合わせ）。そのときパネルは
          赤丸が白丸より上に来た事実をそのまま表示し、
          <strong>「相関が上がるとは限らない」という実測結果として明示します</strong>。
          都合のいい向きに丸めません。
        </p>
        <p>
          <strong>危機レジームの定義（ここが技術的な要点）</strong>:
          「等加重バスケットの<strong>直近60日の実現ボラが上位25%</strong>の日」を危機、残りを平時とします。
          素朴には「バスケットのリターンが下位20%の日」で切りたくなりますが、
          <strong>それをやると相関は機械的に下がります</strong>。共通ファクターの実現値そのものを
          条件付けるため、部分標本内でファクター分散が切り詰められるからです
          （Boyer-Gibson-Loretan 1999 / Forbes-Rigobon 2002 の<strong>条件付けバイアス</strong>）。
          しかもバイアスの向きは<strong>「危機を軽く見せる」＝安全に見える間違い</strong>なので危険です。
          そこで<strong>事前に分かる情報（過去のボラ）だけ</strong>で切ります。
          この定義は当日の寄付時点で判定できるので、運用可能なレジーム定義にもなります。
          検知サインは<strong>「全期間 ρ が平時 ρ と危機時 ρ の両方より高い」</strong>——
          そうなっていたらバイアスが残っている合図で、パネルにも警告を出します。
        </p>
        <p>
          実装は既存の {" stressCorrelation() "}（dcc.ts）をそのまま使っています。
          「ポートフォリオ・リスク分析」の危機シナリオ VaR と<strong>同一の定義・同一の関数</strong>なので、
          2 つのパネルの危機時相関は必ず一致します。この定義は上下対称なので、
          <strong>「下落時<em>だけ</em>相関が上がる」という非対称性の検証には使えません</strong>
          （それには exceedance correlation を2変量正規のヌルと比べる必要があります）。
        </p>
        <p>
          <strong>μ だけは実測しません</strong>。ρ・N・σ は実測値を初期値に入れますが、
          期待リターン μ は既定 8% の<strong>仮定</strong>のままにしてあります。理由は
          「μ の推定誤差は σ の推定誤差よりはるかに大きい」から。過去の平均リターンを入れると
          崖の頂点 {" W*=μ/σ_eff² "} が<strong>あたかも予測であるかのように</strong>見えてしまいます。
          μ は自分の想定を手で入れて、頂点の位置がどれだけ動くかを確かめる欄として使ってください。
        </p>

        <p className="font-medium text-gray-700 mt-3">
          8. その差はノイズか本物か（Δρ のブロック・ブートストラップ）
        </p>
        <p>
          危機時 ρ は<strong>全体の25%しかない部分標本</strong>からの推定です。だから
          「危機時のほうが低い」と出ても、それが<strong>本物の非定常性</strong>なのか
          <strong>小標本のノイズ</strong>なのかは、点推定を見ているだけでは決して分かりません
          （実際、窓を 252日 → 756日 に変えると符号が入れ替わることがあります）。
          そこで {" Δρ = ρ_危機 − ρ_平時 "} の標本分布を作り、
          <strong>信頼区間が 0 を跨ぐかどうか</strong>で判定します。
        </p>
        <p>
          <strong>なぜ「ブロック」で再抽出するのか</strong>: 日次リターンには
          <strong>ボラのクラスタリング</strong>（荒れた日は固まって来る）があり、そもそも危機レジームを
          「直近60日のボラ」で定義しています。1日ずつバラバラに引き直すとこの塊が壊れ、
          <strong>危機レジームそのものが標本から消えてしまう</strong>ため、Δρ の振れ幅を過小評価します。
          そこで長さ L（既定20営業日）の<strong>連続ブロック</strong>を復元抽出して元の長さまで並べ、
          <strong>全銘柄で同じ日付ブロック</strong>を取ります（＝その日の横断的な同時性は壊さない）。
          再抽出した系列に対して<strong>レジーム分割からやり直す</strong>のが要点で、
          「どの日が危機か」の不確かさまで CI に含まれます。
        </p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">
          SE = sd(Δρ*) , CI = Δρ̂ ± z·SE , p = 2(1 − Φ(|Δρ̂| / SE))
        </p>
        <p>
          <strong>位置はブートストラップに任せていません</strong>（ここが設計上の判断）。
          ブロックを貼り合わせた系列では、数週間まとまって来るはずの危機が細切れになり、
          レジーム分割が甘くなります。その結果 <strong>Δρ* は実測より系統的に 0 へ寄る</strong>——
          真に ρ が 0.35→0.80 と上がる合成データで確かめると、実測 Δρ̂=+0.220 に対して
          ブート分布は [0.011, 0.209] に居座り、<strong>素のパーセンタイル区間だと実測値が
          自分の信頼区間の外に出てしまいました</strong>。これは推定量のバイアスではなく
          <strong>再標本化の副作用</strong>なので、区間の<strong>中心は実測値に固定</strong>し、
          ブートストラップは<strong>ばらつき（標準誤差）の推定にだけ</strong>使います。
          こうすると実測値は必ず区間の中心に来て、<strong>「区間が 0 を外す」と「p が小さい」が
          常に一致</strong>します。代償として Δρ̂ の正規近似を仮定しますが、
          Δρ̂ は多数のペア相関の平均の差なので妥当です。
          ρ 単体の CI は Fisher の z 変換 {" z = ½·ln((1+ρ)/(1−ρ)) "} 上で作ってから戻します
          （ρ は ±1 で頭打ちなので、そのままだと区間が範囲外にはみ出すため）。
        </p>
        <p>
          <strong>読み方</strong>: CI が 0 を跨いだら「<strong>差は検出できない</strong>」と言い切ってよく、
          表示されている符号を結論として読んではいけません。跨がなければ標本内では本物の差ですが、
          それでも<strong>次の危機で同じ大きさになる約束ではありません</strong>。
          ブロック長ボタン（10 / 20 / 40日）で<strong>結論が変わらないか</strong>を必ず確かめてください。
          ブロックを長くすると系列構造をより保存する代わりに実効的な標本数が減って CI が広がるので、
          <strong>長いブロックでも 0 を跨がない差だけが頑健</strong>です。
        </p>

        <p className="font-medium text-gray-700 mt-3">9. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>ρ・N・σ が実測でも、崖そのものは合成モデルです</strong>。
            アニメーションの値動きは seeded 乱数で、崖は等相関・正規分布・μ 一定という
            単純化の上に描かれています。実データそのままの分解は
            「相関が食べた分：期待リターンと『実際に増える速さ』のズレ」パネルを見てください。
            ウォッチリストを渡していない場合は、ρ・N・σ も含めて全て仮定です。
          </li>
          <li>
            <strong>全ペアの相関が等しい（等相関）という単純化</strong>を置いています。ただし
            <strong>「実測の相関行列を使えば近似の粗さが見える」というのは誤り</strong>です——
            等ウェイトのとき {" (Σw)²/(wᵀRw) "} と {" N/(1+(N−1)ρ̄) "} は
            <strong>恒等的に同じ値</strong>になります（{" Σᵢⱼ Rᵢⱼ = N + 2Σ_{i<j}Rᵢⱼ = N + N(N−1)ρ̄ "}
            より）。実際に単純化が効くのは
            <strong>①ウェイトの偏り</strong>（等ウェイトを外れると N_eff は必ず落ちる）と
            <strong>②ペア相関のばらつき</strong>（同じ ρ̄ でも「一部のペアだけ極端に高い」構造は
            ρ 1本では表現できない）の2つで、バナーにはその2つを出しています。
          </li>
          <li>
            <strong>μ の推定誤差は σ の推定誤差よりはるかに大きい</strong>。頂点 W* は μ に比例するため、
            ケリー最適点そのものは信用できません。判断は必ず <strong>λ&lt;1 の側（建玉を減らす側）に倒す</strong>。
          </li>
          <li>
            <strong>相関は非定常で、テール時に上がる</strong>。平時 ρ=0.5 でも暴落時には 0.8〜0.9 に寄り、
            崖はさらに手前へ来ます。上の 7. で実測した危機時 ρ がまさにこれです。ただし
            <strong>次の危機が過去の危機と同じ相関になる保証はありません</strong>。
            実測値は「最低限これくらいは上がる」という下限として読んでください。
          </li>
          <li>
            <strong>危機時 ρ は部分標本（全体の25%）からの推定</strong>なので、平時 ρ より標準誤差が大きく、
            銘柄数が多いと相関行列がランク落ちしやすくなります。標本日数がパネルに出るので、
            極端に少ないときは数字を信用しないでください（日数が足りなければ算出せず理由を表示します）。
            <strong>
              振れ幅そのものは Δρ = ρ_危機 − ρ_平時 のブートストラップ CI として数値で出しています
            </strong>
            （上の 8. 参照）。
          </li>
          <li>
            {" g ≈ μ−σ²/2 "} は2次近似。テールが厚い（尖度が高い）分布ではドラッグを
            <strong>過小評価</strong>します。アニメの乱数も正規分布なので、現実より穏やかです。
          </li>
          <li>
            アニメーションの1本の窓（1年）は<strong>たった1つの標本</strong>です。
            上がって見えても下がって見えても、それ自体は何も証明しません。窓が流れる中で
            「形がどれだけ揃っているか」だけを見てください。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 窓依存プロファイル（Canvas2D）
// 横軸は「推定に使う期間の長さ」で時間軸ではない（＝期間をズームする意味がない）ので、
// CLAUDE.md の規約どおり Canvas2D。窓ごとに Δρ の点と CI の縦棒を打ち、ゼロ線を引く。
// 見たいのは「点がゼロ線のどちら側か」と「棒がゼロ線を跨ぐか」の2つだけ。
// ────────────────────────────────────────────────────────────────────────────
function drawProfile(canvas: HTMLCanvasElement, points: StressProfilePoint[]) {
  const H = 200;
  const fit = fitCanvas(canvas, H);
  if (!fit) return;
  const { ctx, width, height } = fit;
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);

  const padL = 46;
  const padR = 12;
  const padT = 12;
  const padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  if (plotW < 60 || plotH < 50) return;

  const ok = points.filter((p) => p.ci.ok);
  if (ok.length === 0) {
    ctx.fillStyle = CHART_COLORS.ink;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("どの窓でも算出できませんでした", padL + plotW / 2, padT + plotH / 2);
    return;
  }

  let lo = 0;
  let hi = 0;
  for (const p of ok) {
    lo = Math.min(lo, p.ci.deltaLo, p.ci.delta);
    hi = Math.max(hi, p.ci.deltaHi, p.ci.delta);
  }
  const span = hi - lo || 0.1;
  lo -= span * 0.15;
  hi += span * 0.15;
  const range = hi - lo || 1;

  // 横位置は「窓の順番」で等間隔に置く（日数に比例させると短い窓が潰れて読めない）
  const xOf = (i: number) =>
    padL + (points.length === 1 ? plotW / 2 : (plotW * (i + 0.5)) / points.length);
  const yOf = (v: number) => padT + ((hi - v) / range) * plotH;

  // ゼロ線より下（Δρ<0＝危機時のほうが低い）を薄青、上を薄赤で塗り分ける
  const y0 = yOf(0);
  ctx.fillStyle = "#fef4f4";
  ctx.fillRect(padL, padT, plotW, Math.max(0, y0 - padT));
  ctx.fillStyle = "#f3f7fe";
  ctx.fillRect(padL, y0, plotW, Math.max(0, padT + plotH - y0));

  // y グリッド
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const step = niceStep(range / 4);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const y = yOf(v);
    ctx.strokeStyle = "#eceff1";
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillStyle = CHART_COLORS.ink;
    ctx.fillText(v.toFixed(2), padL - 6, y);
  }

  // ゼロ線（判定の境目なので濃く）
  ctx.strokeStyle = "#6b7280";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(padL, y0);
  ctx.lineTo(padL + plotW, y0);
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  points.forEach((p, i) => {
    const x = xOf(i);
    ctx.fillStyle = CHART_COLORS.ink;
    ctx.fillText(`${p.periods}日`, x, padT + plotH + 6);
    if (!p.ci.ok) return;
    const crosses = p.ci.crossesZero;
    const color = crosses ? CHART_COLORS.neutral : p.ci.delta > 0 ? "#b91c1c" : "#1d4ed8";
    // CI の縦棒（跨いでいるものは灰色＝「判定なし」が一目で分かる）
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, yOf(p.ci.deltaLo));
    ctx.lineTo(x, yOf(p.ci.deltaHi));
    ctx.stroke();
    // 上下のヒゲ
    ctx.lineWidth = 1.5;
    for (const v of [p.ci.deltaLo, p.ci.deltaHi]) {
      ctx.beginPath();
      ctx.moveTo(x - 4, yOf(v));
      ctx.lineTo(x + 4, yOf(v));
      ctx.stroke();
    }
    // 点推定
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, yOf(p.ci.delta), 3.5, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = "#6b7280";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("Δρ = 危機時 − 平時", padL + 2, padT + 2);
}

// ────────────────────────────────────────────────────────────────────────────
// G1 三本の崖（Canvas2D）
// 横軸は「総建玉%」＝時間軸ではないので、CLAUDE.md の規約どおり Canvas2D で描く。
// ────────────────────────────────────────────────────────────────────────────
function drawCliffs(canvas: HTMLCanvasElement, d: CliffView) {
  const H = 330;
  const fit = fitCanvas(canvas, H);
  if (!fit) return;
  const { ctx, width, height } = fit;
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);

  const padL = 52;
  const padR = 14;
  const padT = 14;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  if (plotW < 60 || plotH < 60) return;

  // y 定義域（4本の曲線から。見かけの期待リターン線はクリップして描く）
  let lo = 0;
  let hi = 0;
  const scan = (pts: CurvePt[]) => {
    for (const p of pts) {
      if (p.g < lo) lo = p.g;
      if (p.g > hi) hi = p.g;
    }
  };
  d.refs.forEach((c) => scan(c.pts));
  scan(d.cur);
  if (d.stress) scan(d.stress.pts);
  const span = hi - lo || 0.1;
  lo -= span * 0.1;
  hi += span * 0.1;
  const range = hi - lo || 1;

  const xOf = (w: number) => padL + (w / W_MAX) * plotW;
  const yOf = (g: number) => padT + ((hi - g) / range) * plotH;

  // g<0 の領域（薄赤）
  const y0 = yOf(0);
  ctx.fillStyle = "#fef2f2";
  ctx.fillRect(padL, y0, plotW, padT + plotH - y0);

  // グリッド
  ctx.strokeStyle = "#eceff1";
  ctx.lineWidth = 1;
  for (let w = 0; w <= W_MAX + 1e-9; w += 0.5) {
    const x = xOf(w);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
  }
  const yStep = niceStep(range / 5);
  ctx.textAlign = "right";
  ctx.font = "10px sans-serif";
  for (let g = Math.ceil(lo / yStep) * yStep; g <= hi; g += yStep) {
    const y = yOf(g);
    ctx.strokeStyle = "#eceff1";
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillStyle = CHART_COLORS.ink;
    ctx.fillText(`${(g * 100).toFixed(0)}%`, padL - 6, y + 3);
  }

  // ゼロ線
  ctx.strokeStyle = CHART_COLORS.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, y0);
  ctx.lineTo(padL + plotW, y0);
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT, plotW, plotH);
  ctx.clip();

  // 見かけの期待リターン W·μ（ドラッグを無視した直線）
  ctx.strokeStyle = CHART_COLORS.reference;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(0));
  ctx.lineTo(xOf(W_MAX), yOf(W_MAX * d.mu));
  ctx.stroke();
  ctx.setLineDash([]);

  const drawCurve = (pts: CurvePt[], color: string, w: number, alpha = 1) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xOf(p.w);
      const y = yOf(p.g);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  // 参照3本
  d.refs.forEach((c) => drawCurve(c.pts, c.color, 1.8, 0.85));
  // 危機時 ρ の曲線（渡されたときだけ）。ρ が平時より高ければ内側＝崖が手前に来るが、
  // 実測では逆に出ることもあるので「必ず内側」とは仮定しない（外側にも描ける）。
  if (d.stress) {
    ctx.setLineDash([6, 4]);
    drawCurve(d.stress.pts, "#b91c1c", 2.4, 0.95);
    ctx.setLineDash([]);
  }
  // 今の ρ（太線）
  drawCurve(d.cur, "#111827", 3);

  // 各曲線の頂点（▲）
  const triangle = (x: number, y: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - 7);
    ctx.lineTo(x - 5, y - 1);
    ctx.lineTo(x + 5, y - 1);
    ctx.closePath();
    ctx.fill();
  };
  d.refs.forEach((c) => {
    if (c.peak > 0 && c.peak <= W_MAX) {
      triangle(xOf(c.peak), yOf(d.mu * c.peak - (d.mu * c.peak) / 2), c.color);
    }
  });

  // 今の ρ の頂点と g=0 交点にはラベルを添える
  const gPeak = d.curPeak * d.mu - (d.curPeak * d.mu) / 2; // = μ·W*/2
  if (d.curPeak > 0 && d.curPeak <= W_MAX) {
    triangle(xOf(d.curPeak), yOf(gPeak), "#111827");
    ctx.textAlign = "center";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#fafafa";
    ctx.font = "bold 11px sans-serif";
    ctx.strokeText("▲ここが最速", xOf(d.curPeak), yOf(gPeak) - 11);
    ctx.fillStyle = "#111827";
    ctx.fillText("▲ここが最速", xOf(d.curPeak), yOf(gPeak) - 11);
    ctx.font = "10px sans-serif";
    ctx.strokeText(`建玉 ${(d.curPeak * 100).toFixed(0)}%`, xOf(d.curPeak), yOf(gPeak) - 23);
    ctx.fillStyle = "#6b7280";
    ctx.fillText(`建玉 ${(d.curPeak * 100).toFixed(0)}%`, xOf(d.curPeak), yOf(gPeak) - 23);
  }
  const wZero = d.curPeak * 2;
  if (wZero > 0 && wZero <= W_MAX) {
    const xz = xOf(wZero);
    ctx.strokeStyle = "#b91c1c";
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xz, padT);
    ctx.lineTo(xz, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = xz > padL + plotW * 0.75 ? "right" : "left";
    const dx = xz > padL + plotW * 0.75 ? -4 : 4;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#fafafa";
    ctx.strokeText("資産が増えなくなる", xz + dx, padT + 12);
    ctx.strokeText(`建玉 ${(wZero * 100).toFixed(0)}%`, xz + dx, padT + 24);
    ctx.fillStyle = "#b91c1c";
    ctx.fillText("資産が増えなくなる", xz + dx, padT + 12);
    ctx.fillText(`建玉 ${(wZero * 100).toFixed(0)}%`, xz + dx, padT + 24);
  }

  // 曲線ラベル（右寄り。白フチで可読性を確保）
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  const labelW = W_MAX * 0.85;
  const curveLabel = (pts: CurvePt[], label: string, color: string, dy: number) => {
    const g = pts[Math.round((labelW / W_MAX) * (pts.length - 1))]?.g ?? 0;
    const x = xOf(labelW) + 4;
    const y = yOf(g) + dy;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#fafafa";
    ctx.strokeText(label, x, y);
    ctx.fillStyle = color;
    ctx.fillText(label, x, y);
  };
  d.refs.forEach((c) => curveLabel(c.pts, c.label, c.color, -4));
  // 危機時の曲線にもラベルを付ける（ρ=0.8 の線と紛れないように少し下げる）
  if (d.stress) curveLabel(d.stress.pts, d.stress.label, "#b91c1c", 12);

  // 現在地ドット（危機時 ρ が渡されていれば 2 つ。横位置は共有＝建玉は変えていない）
  const gx = xOf(d.exposure);
  ctx.strokeStyle = "#111827";
  ctx.setLineDash([2, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(gx, padT + plotH);
  ctx.lineTo(gx, yOf(Math.max(...d.dots.map((t) => t.g))));
  ctx.stroke();
  ctx.setLineDash([]);

  // 2 ドットは g が近いと（相関差が小さいと）数ピクセルしか離れないので、
  // ラベルは「上のドットは上へ、下のドットは下へ」と外向きに逃がす。
  // どちらが上かは実測の向きで変わる（危機時 ρ が平時より低く出ることもある）。
  const gMax = Math.max(...d.dots.map((t) => t.g));
  // 相関差が小さいと 2 ドットはほぼ重なる。塗りドット（危機時）を先に描き、白抜きの
  // 現在地を最後に載せることで、重なっても両方の存在が分かる（白丸＋赤い縁）。
  [...d.dots]
    .sort((a, b) => Number(a.hollow) - Number(b.hollow))
    .forEach((dot) => {
    const dy = yOf(dot.g);
    ctx.beginPath();
    ctx.arc(gx, dy, 7, 0, Math.PI * 2);
    ctx.fillStyle = dot.hollow ? "#ffffff" : dot.color;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = dot.color;
    ctx.stroke();

    ctx.font = "bold 11px sans-serif";
    const right = gx > padL + plotW * 0.7;
    ctx.textAlign = right ? "right" : "left";
    const ldx = right ? -12 : 12;
    const ldy = d.dots.length > 1 ? (dot.g >= gMax ? -11 : 19) : 4;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#fafafa";
    ctx.strokeText(dot.label, gx + ldx, dy + ldy);
    ctx.fillStyle = dot.color;
    ctx.fillText(dot.label, gx + ldx, dy + ldy);
  });

  ctx.restore();

  // 軸ラベル
  ctx.textAlign = "center";
  ctx.font = "10px sans-serif";
  ctx.fillStyle = CHART_COLORS.ink;
  for (let w = 0; w <= W_MAX + 1e-9; w += 0.5) {
    ctx.fillText(`${(w * 100).toFixed(0)}%`, xOf(w), padT + plotH + 14);
  }
  ctx.fillText("総建玉（現金を含む資産に対する株式の比率）", padL + plotW / 2, height - 6);
  ctx.textAlign = "left";
  ctx.fillText("年率の実質成長率 g", padL - 46, padT - 3);
}

// ────────────────────────────────────────────────────────────────────────────
// U1 メトロノーム同期アニメ（Canvas2D・仕様書 §10.3 の意図的逸脱）
// 横軸は時間だが合成データで日付に意味がなく、価値は「ρ に対する形の応答」。
// 毎フレーム再描画するため lightweight-charts ではなく Canvas2D を使う。
// ────────────────────────────────────────────────────────────────────────────
function drawSync(canvas: HTMLCanvasElement, v: SyncView, off: number) {
  const N = v.N;
  const rowH = Math.max(12, Math.min(28, 240 / N));
  const padT = 10;
  const padL = 108;
  const padR = 12;
  const gap = 18;
  const portH = 150;
  const padB = 22;
  const H = Math.round(padT + N * rowH + gap + portH + padB);
  const fit = fitCanvas(canvas, H);
  if (!fit) return;
  const { ctx, width, height } = fit;
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);

  const plotW = width - padL - padR;
  if (plotW < 60) return;
  const xOf = (k: number) => padL + (k / WIN) * plotW;
  const years = WIN / TRADING_DAYS;

  // ── 上段: 銘柄ごとのミニ株価ライン ────────────────────────────────────
  // 縦の目盛りは全銘柄・全 ρ で共通（同じ拡大率でないと「揃っていく」が比較にならない）。
  // 帯からはみ出す分は隣の行に少し重なるが、形を潰さないほうを優先する。
  const halfA = Math.max(1.4 * v.sigma * Math.sqrt(years), 1e-6);
  for (let i = 0; i < N; i++) {
    const yc = padT + i * rowH + rowH / 2;
    ctx.strokeStyle = "#eef0f2";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, yc);
    ctx.lineTo(padL + plotW, yc);
    ctx.stroke();

    const line = v.perAsset[i];
    if (!line) continue;
    const base = line[off] ?? 0;
    ctx.beginPath();
    for (let k = 0; k <= WIN; k++) {
      const val = (line[off + k] ?? base) - base;
      const y = yc - Math.max(-1.6, Math.min(1.6, val / halfA)) * (rowH * 0.46);
      if (k === 0) ctx.moveTo(xOf(k), y);
      else ctx.lineTo(xOf(k), y);
    }
    ctx.strokeStyle = `hsl(${(i * 137.5) % 360} 62% 45%)`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  ctx.textAlign = "right";
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#6b7280";
  const assetMid = padT + (N * rowH) / 2;
  ctx.fillText(`${N}銘柄それぞれ`, padL - 10, assetMid - 6);
  ctx.fillStyle = CHART_COLORS.ink;
  ctx.fillText("の値動き", padL - 10, assetMid + 8);

  // ── 下段: 合成ポートフォリオ ─────────────────────────────────────────
  const pTop = padT + N * rowH + gap;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(padL, pTop, plotW, portH);
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.strokeRect(padL, pTop, plotW, portH);

  const W = Math.max(v.exposure, 0.05);
  // 合成側も ρ に依らない共通目盛り。ρ=0 で「穏やかに右肩上がり」、ρ→1 で「暴れる」の
  // 対比は、拡大率を固定しているからこそ意味を持つ。
  const halfP = Math.max(W * (Math.abs(v.mu) * years + 1.4 * v.sigma * Math.sqrt(years)), 1e-6);
  const baseY = pTop + portH * 0.62;
  const yP = (val: number) =>
    baseY - Math.max(-1.3, Math.min(1.3, val / halfP)) * (portH * 0.44);

  // ゼロ線
  ctx.strokeStyle = "#e5e7eb";
  ctx.beginPath();
  ctx.moveTo(padL, yP(0));
  ctx.lineTo(padL + plotW, yP(0));
  ctx.stroke();

  // 見かけの期待リターン W·μ·t（ドラッグを無視した直線）
  ctx.strokeStyle = CHART_COLORS.reference;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(xOf(0), yP(0));
  ctx.lineTo(xOf(WIN), yP(v.exposure * v.mu * years));
  ctx.stroke();
  ctx.setLineDash([]);

  const pf = v.portfolio;
  const pBase = pf[off] ?? 0;
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, pTop, plotW, portH);
  ctx.clip();
  ctx.beginPath();
  let last = 0;
  for (let k = 0; k <= WIN; k++) {
    const val = (pf[off + k] ?? pBase) - pBase;
    last = val;
    const y = yP(val);
    if (k === 0) ctx.moveTo(xOf(k), y);
    else ctx.lineTo(xOf(k), y);
  }
  ctx.strokeStyle = "#1d4ed8";
  ctx.lineWidth = 2;
  ctx.stroke();

  // 終端の到達点
  const ex = xOf(WIN);
  const ey = yP(last);
  ctx.beginPath();
  ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = "#1d4ed8";
  ctx.fill();
  ctx.restore();

  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "right";
  ctx.fillStyle = last >= 0 ? "#15803d" : "#b91c1c";
  const simple = Math.expm1(last);
  ctx.fillText(
    `この1年: ${simple >= 0 ? "+" : "−"}${(Math.abs(simple) * 100).toFixed(1)}%`,
    padL + plotW - 6,
    pTop + portH - 8
  );

  ctx.textAlign = "right";
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#6b7280";
  ctx.fillText("合成ポートフォリオ", padL - 10, pTop + portH / 2 - 6);
  ctx.fillStyle = CHART_COLORS.ink;
  ctx.fillText("（等ウェイト）", padL - 10, pTop + portH / 2 + 8);

  ctx.textAlign = "left";
  ctx.fillStyle = CHART_COLORS.ink;
  ctx.font = "10px sans-serif";
  ctx.fillText("← 1年ぶんの窓が流れています（横軸は合成時間・日付に意味はありません）", padL, height - 6);
}
