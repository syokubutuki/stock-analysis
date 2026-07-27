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
import {
  TRADING_DAYS,
  doublingYears,
  doublingYearsLabel as yearsLabel,
  effectiveN,
  generateShocks,
  growthCurve,
  hiddenLeverage,
  peakExposure,
  synthPaths,
} from "../../lib/growth-drag";
import { niceStep } from "../../lib/axis-scale";
import AnalysisGuide from "./AnalysisGuide";

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
 * すべて optional。省略時は従来どおりの合成データ既定値（ρ=0.5 / N=10 / μ=8% / σ=30%）で
 * 動くため、props なしの呼び出し（/portfolio の pf-corr-drag）の挙動は不変。
 *
 * Phase 4（危機Σ連動）はここに実測値を流し込むだけで済むように用意してある:
 * `stressRho` に既存 `computeStress` の危機時平均相関を渡すと、崖の上に
 * 「平時のあなた」と「暴落時のあなた」の 2 ドットが並ぶ。
 */
export interface CorrelationDragChartProps {
  /** ρ スライダーの初期値（既定 0.5 ＝ 日本株大型の実勢）。 */
  initialRho?: number;
  /** 総建玉の初期値（既定 1.0 ＝ フル現物）。 */
  initialExposure?: number;
  /** 前提の初期値。省略時は μ=8% / σ=30% / N=10。 */
  initialAssets?: number;
  initialMuPct?: number;
  initialSigPct?: number;
  /**
   * 危機時の平均相関（実測値）。渡すと崖に危機時の曲線と第2ドットを重ねる。
   * 未指定なら従来どおり平時の 1 ドットのみ。
   */
  stressRho?: number;
  /** 第2ドットの見出し（既定「暴落時のあなた」）。 */
  stressLabel?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function CorrelationDragChart({
  initialRho = 0.5,
  initialExposure = 1,
  initialAssets = 10,
  initialMuPct = 8,
  initialSigPct = 30,
  stressRho,
  stressLabel = "暴落時のあなた",
}: CorrelationDragChartProps = {}) {
  // ── コントロール ──────────────────────────────────────────────────────
  const [rho, setRho] = useState(() => clamp(initialRho, 0, 0.95)); // 既定は日本株大型の実勢
  const [exposure, setExposure] = useState(() => clamp(initialExposure, 0, W_MAX)); // 現在地＝フル現物
  const [nAssets, setNAssets] = useState(() => clamp(Math.round(initialAssets), 2, 20));
  const [muPct, setMuPct] = useState(() => clamp(initialMuPct, 0, 40));
  const [sigPct, setSigPct] = useState(() => clamp(initialSigPct, 5, 80));
  const [sweeping, setSweeping] = useState(false);
  // 危機時 ρ（渡されたときだけ有効）。useMemo の依存に載るので、React Compiler が
  // 純粋と判定できる Math.min/max で直接クランプする（自前ヘルパ経由だと
  // 「後で変更されうる値」と見なされてメモ化の保持に失敗する）。
  const rhoStress =
    stressRho != null && isFinite(stressRho) ? Math.min(0.99, Math.max(0, stressRho)) : null;

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

  const cliff: CliffView = useMemo(() => {
    // ドットは「同じ建玉のまま曲線だけが入れ替わる」ことを見せるため横位置を共有する。
    // 配列は push で後から変えず、条件付きスプレッドで一度に組む（React Compiler が
    // メモ化を保てるように＝可変オブジェクトを依存に載せない）。
    const dots: CliffDot[] = [
      {
        exposure,
        g: gAt(exposure, rho),
        label: rhoStress != null ? "平時のあなた" : "あなたの現在地",
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
  }, [mu, sigma, nAssets, rho, exposure, wGrid, peakAt, gAt, rhoStress, stressLabel]);

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
        setRho(Math.round(next * 100) / 100);
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
              setRho(Number(e.target.value));
            }}
            className="flex-1 min-w-[220px] accent-blue-600"
          />
          <div className="flex gap-1">
            {REF_RHOS.map((r) => (
              <button
                key={r.rho}
                onClick={() => {
                  setSweeping(false);
                  setRho(r.rho);
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
              <span className="text-gray-400">{nAssets.toFixed(1)}</span>
              <span className="text-gray-400 text-sm"> → </span>
              <span
                className={
                  nEff > nAssets * 0.7
                    ? "text-green-600"
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
              {stressLabel}です。<strong>建玉は 1mm も動かしていないのに</strong>、成長率は{" "}
              {pct(gCur)} から{" "}
              <strong className={gStress > 0 ? "text-gray-800" : "text-red-700"}>
                {pct(gStress)}
              </strong>{" "}
              へ（2倍まで {yearsLabel(doublingYears(gCur))} →{" "}
              <strong>{yearsLabel(doublingYears(gStress))}</strong>）。
            </>
          )}
        </p>
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
              { rho, color: "#111827", note: "今のスライダー位置", cur: true },
              // 危機時 ρ が渡されているときだけ最下段に実測の危機時を並べる
              ...(rhoStress != null
                ? [{ rho: rhoStress, color: "#b91c1c", note: `${stressLabel}（危機時の実測相関）`, cur: true }]
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
                    <span className="text-gray-400 font-normal">{r.note}</span>
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

      {/* 前提（μ・σ・N） */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-600 border-t border-gray-100 pt-3">
        <span className="text-gray-400">前提（合成データ）</span>
        <label className="flex items-center gap-1">
          銘柄数 N
          <input
            type="number"
            min={2}
            max={20}
            step={1}
            value={nAssets}
            onChange={(e) =>
              setNAssets(Math.max(2, Math.min(20, Math.round(Number(e.target.value) || 10))))
            }
            className="w-14 px-1 py-0.5 border border-gray-300 rounded text-right tabular-nums"
          />
        </label>
        <label className="flex items-center gap-1">
          期待リターン μ
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
          <input
            type="number"
            min={5}
            max={80}
            step={1}
            value={sigPct}
            onChange={(e) => setSigPct(Math.max(5, Math.min(80, Number(e.target.value) || 30)))}
            className="w-14 px-1 py-0.5 border border-gray-300 rounded text-right tabular-nums"
          />
          %
        </label>
        <span className="text-gray-400">
          いずれも年率。既定値は μ=8% / σ=30% / N=10（日本株の大型株を想定した水準）。
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

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>ここは合成データです</strong>。μ・σ・N・ρ はあなたが入れた前提であって、実測値ではありません。
            実データでの分解は「相関が食べた分：期待リターンと『実際に増える速さ』のズレ」パネルを見てください。
          </li>
          <li>
            <strong>全ペアの相関が等しい（等相関）という単純化</strong>を置いています。現実には相関はペアごとに
            異なり、N_eff はウォッチリスト実測の {" (Σw)²/(wᵀRw) "} で測るほうが正確です。
          </li>
          <li>
            <strong>μ の推定誤差は σ の推定誤差よりはるかに大きい</strong>。頂点 W* は μ に比例するため、
            ケリー最適点そのものは信用できません。判断は必ず <strong>λ&lt;1 の側（建玉を減らす側）に倒す</strong>。
          </li>
          <li>
            <strong>相関は非定常で、テール時に上がる</strong>。平時 ρ=0.5 でも暴落時には 0.8〜0.9 に寄り、
            崖はさらに手前へ来ます。危機時の相関は「ポートフォリオ・リスク分析」の DCC・危機時相関を参照。
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
    ctx.fillStyle = "#9ca3af";
    ctx.fillText(`${(g * 100).toFixed(0)}%`, padL - 6, y + 3);
  }

  // ゼロ線
  ctx.strokeStyle = "#9ca3af";
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
  ctx.strokeStyle = "#94a3b8";
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
  // 危機時 ρ の曲線（渡されたときだけ）。平時より必ず内側＝崖が手前に来る。
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

  d.dots.forEach((dot, i) => {
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
    // 2 ドットが近接したときにラベルが重ならないよう、2 つ目は下側へずらす
    const ldy = d.dots.length > 1 ? (i === 0 ? -2 : 12) : 4;
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
  ctx.fillStyle = "#9ca3af";
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
  ctx.fillStyle = "#9ca3af";
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
  ctx.strokeStyle = "#94a3b8";
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
  ctx.fillStyle = "#9ca3af";
  ctx.fillText("（等ウェイト）", padL - 10, pTop + portH / 2 + 8);

  ctx.textAlign = "left";
  ctx.fillStyle = "#9ca3af";
  ctx.font = "10px sans-serif";
  ctx.fillText("← 1年ぶんの窓が流れています（横軸は合成時間・日付に意味はありません）", padL, height - 6);
}
