"use client";

// 持ち方の対数台帳 ― 同じ銘柄で「持ち切り」と「回転」を分解して比べる。
//
// 設計の由来は app/lib/holding-ledger.ts の冒頭コメントを読むこと。要点だけ:
// 「高ボラは幾何リターンを壊す」は実データ（285A.T: μ=268% > 壁52.7%）の前で成立しない。
// 成立するのは「回転コストと税は符号が確定していて測れる」「μ は測れない」の2つ。
// このパネルは**両方を同じ画面に並べて**、どちらが効いているかを銘柄ごとに読者に判定させる。
//
// 中心の操作子は **μ の前提スライダー**。σ を一切変えずに μ だけ動かすと、
// 同じ銘柄で「レバレッジ3倍が最適」から「建玉10%が最適」まで結論が反転する。
// それが「μ を測れると思うこと」の帰結であり、このパネルの主題である。

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  seriesStats,
  simpleReturns,
  decomposeLedger,
  walkStrategy,
  alwaysIn,
  placeboDistribution,
  ledgerGrid,
  TAX_RATE,
  DEFAULT_MARGIN_RATE_LONG,
  type LedgerParams,
  type SeriesStats,
} from "../../lib/holding-ledger";
import { representativeSpread } from "../../lib/spread-estimator";
import { doublingYears, doublingYearsLabel } from "../../lib/growth-drag";
import { niceTicks } from "../../lib/axis-scale";
import { CHART_COLORS, DIRECTION_TEXT_CLASS } from "../../lib/chart-colors";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const HOLD_DAYS_LIST = [3, 5, 10, 21, 63];
const IN_MARKET_LIST = [1, 0.7, 0.5, 0.3];

const pct = (x: number, d = 1) => (isFinite(x) ? `${(x * 100).toFixed(d)}%` : "—");
const signedPP = (x: number) => (isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}pp` : "—");

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  if (width <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = CHART_COLORS.surface;
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

export default function HoldingLedgerChart({ prices }: Props) {
  const waterfallRef = useRef<HTMLCanvasElement>(null);
  const placeboRef = useRef<HTMLCanvasElement>(null);

  const stats = useMemo(() => seriesStats(prices), [prices]);
  const rets = useMemo(() => simpleReturns(prices), [prices]);
  // 終値だけの系列（投信の基準価額）は high==low なので Corwin-Schultz が恒等的に 0 に
  // なり、既定値へ落ちる。落ちたことを画面に出さないと「実測 0.30%」という表示が
  // 測っていない数字を測ったように見せる（0331418A で実際にそう出ていた）。
  const cost = useMemo(() => {
    const cs = representativeSpread(prices, 21, "cs");
    return cs > 0 && isFinite(cs)
      ? { value: cs, measured: true }
      : { value: 0.003, measured: false };
  }, [prices]);
  const measuredCost = cost.value;
  // 終値だけの系列（投信の基準価額など）は open==high==low==close で配信される。
  // このとき「夜間＝日次リターンの全部・日中＝ゼロ」というもっともらしい嘘が出るので、
  // 帰属ブロックごと隠す。往復コストも高安から推定できないので既定値に落ちている。
  const hasIntraday = useMemo(
    () => prices.some((p) => p.open > 0 && p.close > 0 && p.open !== p.close),
    [prices]
  );

  // ── 操作子 ────────────────────────────────────────────────────────────
  const [holdDays, setHoldDays] = useState(10);
  const [inMarketPct, setInMarketPct] = useState(70);
  const [leverage, setLeverage] = useState(1);
  const [taxEnabled, setTaxEnabled] = useState(true);
  const [costBps, setCostBps] = useState<number | null>(null); // null = 実測に追従
  // μ の前提。null = 実測に追従。触ると「仮定」バッジが出る。
  const [muOverride, setMuOverride] = useState<number | null>(null);

  const costRT = costBps === null ? measuredCost : costBps / 10000;
  const inMarket = inMarketPct / 100;

  // μ を差し替えた統計量。σ（＝壁）は一切動かさないのがこの操作子の肝。
  const effStats: SeriesStats | null = useMemo(() => {
    if (!stats) return null;
    if (muOverride === null) return stats;
    return { ...stats, muArith: muOverride };
  }, [stats, muOverride]);

  const params: LedgerParams | null = useMemo(() => {
    if (!stats) return null;
    return {
      holdDays,
      inMarket,
      leverage,
      costRT,
      taxEnabled,
      taxRate: TAX_RATE,
      marginRate: DEFAULT_MARGIN_RATE_LONG,
      // 歩行エンジンと同じ土俵に乗せるため、既定の清算地平は標本期間そのもの。
      horizonYears: stats.years,
    };
  }, [stats, holdDays, inMarket, leverage, costRT, taxEnabled]);

  const ledger = useMemo(
    () => (effStats && params ? decomposeLedger(effStats, params) : null),
    [effStats, params]
  );

  // 実測の値動きをそのまま歩く群。μ の前提スライダーは**効かない**（実データだから）。
  const walkBH = useMemo(
    () =>
      rets.length > 50
        ? walkStrategy(rets, alwaysIn(rets.length), {
            leverage,
            costRT,
            taxEnabled,
            taxRate: TAX_RATE,
            marginRate: DEFAULT_MARGIN_RATE_LONG,
          })
        : null,
    [rets, leverage, costRT, taxEnabled]
  );

  const placebo = useMemo(
    () =>
      rets.length > 50
        ? placeboDistribution(rets, {
            holdDays,
            inMarket,
            leverage,
            costRT,
            taxEnabled,
            taxRate: TAX_RATE,
            marginRate: DEFAULT_MARGIN_RATE_LONG,
            iters: 400,
            seed: 20260829,
          })
        : null,
    [rets, holdDays, inMarket, leverage, costRT, taxEnabled]
  );

  const grid = useMemo(
    () => (effStats && params ? ledgerGrid(effStats, params, HOLD_DAYS_LIST, IN_MARKET_LIST) : null),
    [effStats, params]
  );

  // ── ウォーターフォール ────────────────────────────────────────────────
  useEffect(() => {
    const canvas = waterfallRef.current;
    if (!canvas || !ledger) return;
    const rows = ledger.steps.length;
    const rowH = 42;
    const padT = 12;
    const padB = 28;
    const padL = 96;
    const padR = 12;
    const draw = () => {
    const init = initCanvas(canvas, padT + padB + rows * rowH);
    if (!init) return;
    const { ctx, width, height } = init;

    let lo = 0;
    let hi = 0;
    const segs = ledger.steps.map((s, i) => {
      const from = s.kind === "result" ? 0 : i === 0 ? 0 : ledger.steps[i - 1].after;
      const to = s.after;
      lo = Math.min(lo, from, to);
      hi = Math.max(hi, from, to);
      return { ...s, from, to };
    });
    // 誤差棒も定義域に入れる。入れないと μ̂±1SE の端が軸の外で無言に切られ、
    // 「誤差棒は壁より長い」というこのパネル群の主題が過小に描かれる
    // （8306.T 既定で μ̂+1SE=36.0% に対し軸上限が 28.6% だった）。
    if (stats && muOverride === null) {
      const e = stats.seMu * leverage;
      lo = Math.min(lo, ledger.expected - e);
      hi = Math.max(hi, ledger.expected + e);
    }
    const span = hi - lo || 0.1;
    lo -= span * 0.06;
    hi += span * 0.06;
    const range = hi - lo || 1;
    const plotW = width - padL - padR;
    const xOf = (v: number) => padL + ((v - lo) / range) * plotW;

    const zx = xOf(0);
    ctx.strokeStyle = CHART_COLORS.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(zx, padT);
    ctx.lineTo(zx, padT + rows * rowH);
    ctx.stroke();

    const barH = 18;
    segs.forEach((s, i) => {
      const yTop = padT + i * rowH + (rowH - barH) / 2 - 2;
      const x0 = xOf(Math.min(s.from, s.to));
      const x1 = xOf(Math.max(s.from, s.to));
      const w = Math.max(x1 - x0, 1.5);
      // 色は「どの項か」ではなく「符号」も担う。μ を下げて g が負に落ちると、
      // 取りこぼしや税の項は**プラスに転じる**（市場にいない方がマシ・損失は税を軽くする）。
      // そこを赤のままにすると「赤い棒に +14.1%」という読めない表示になるので、
      // 有利に働いた段は中立色へ、最終結果は符号どおりの色にする。
      const color =
        s.kind === "base"
          ? "#3b82f6"
          : s.kind === "drag"
            ? "#7c3aed"
            : s.kind === "cost"
              ? s.delta < 0
                ? "#dc2626"
                : CHART_COLORS.neutral
              : s.delta >= 0
                ? "#16a34a"
                : "#dc2626";
      const strong = s.kind === "result" || s.kind === "drag";

      if (i > 0 && s.kind !== "result") {
        const cx = xOf(s.from);
        ctx.save();
        ctx.strokeStyle = "#cbd5e1";
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, padT + (i - 1) * rowH + (rowH - barH) / 2 - 2 + barH);
        ctx.lineTo(cx, yTop);
        ctx.stroke();
        ctx.restore();
      }

      ctx.fillStyle = color;
      ctx.fillRect(x0, yTop, w, barH);
      if (strong) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 - 1.5, yTop - 1.5, w + 3, barH + 3);
      }

      // μ の誤差棒は「期待リターン」の段にだけ重ねる。壁より長いことが一目で分かる。
      if (s.key === "expected" && stats && muOverride === null) {
        const cy = yTop + barH / 2;
        const eLo = xOf(Math.max(lo, s.to - stats.seMu * leverage));
        const eHi = xOf(Math.min(hi, s.to + stats.seMu * leverage));
        ctx.save();
        ctx.strokeStyle = "#1e3a8a";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(eLo, cy);
        ctx.lineTo(eHi, cy);
        ctx.moveTo(eLo, cy - 5);
        ctx.lineTo(eLo, cy + 5);
        ctx.moveTo(eHi, cy - 5);
        ctx.lineTo(eHi, cy + 5);
        ctx.stroke();
        ctx.restore();
      }

      ctx.textAlign = "right";
      ctx.fillStyle = s.delta >= 0 ? "#111827" : "#b91c1c";
      ctx.font = "bold 12px ui-monospace, monospace";
      ctx.fillText(`${s.delta >= 0 ? "+" : "−"}${Math.abs(s.delta * 100).toFixed(1)}%`, padL - 10, yTop + 13);

      ctx.font = strong ? "bold 11.5px sans-serif" : "11.5px sans-serif";
      const textW = ctx.measureText(s.label).width;
      if (x1 + 8 + textW < width - padR) {
        ctx.textAlign = "left";
        ctx.fillStyle = strong ? color : "#4b5563";
        ctx.fillText(s.label, x1 + 8, yTop + 13);
      } else if (w > textW + 14) {
        ctx.textAlign = "right";
        ctx.fillStyle = "#ffffff";
        ctx.fillText(s.label, x1 - 6, yTop + 13);
      } else {
        ctx.textAlign = "right";
        ctx.fillStyle = strong ? color : "#4b5563";
        ctx.fillText(s.label, x0 - 8, yTop + 13);
      }
    });

    ctx.textAlign = "center";
    ctx.font = "10px sans-serif";
    ctx.fillStyle = CHART_COLORS.ink;
    ctx.strokeStyle = CHART_COLORS.grid;
    for (const v of niceTicks(lo, hi, 5)) {
      const x = xOf(v);
      ctx.beginPath();
      ctx.moveTo(x, padT + rows * rowH);
      ctx.lineTo(x, padT + rows * rowH + 4);
      ctx.stroke();
      ctx.fillText(`${(v * 100).toFixed(0)}%`, x, padT + rows * rowH + 16);
    }
    ctx.textAlign = "left";
    ctx.fillText("年率（対数成長率）", padL, height - 4);
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [ledger, stats, muOverride, leverage]);

  // ── プラセボ分布 ──────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = placeboRef.current;
    if (!canvas || !placebo || !walkBH || placebo.gs.length < 20 || placebo.distinct < 5) return;
    const draw = () => {
    const init = initCanvas(canvas, 200);
    if (!init) return;
    const { ctx, width, height } = init;
    const padL = 44;
    const padR = 14;
    const padT = 26;
    const padB = 34;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const marks = [walkBH.g, ledger?.gNet ?? placebo.q50].filter((v) => isFinite(v));
    let lo = Math.min(...placebo.gs, ...marks);
    let hi = Math.max(...placebo.gs, ...marks);
    const pad = (hi - lo || 0.1) * 0.08;
    lo -= pad;
    hi += pad;
    const xOf = (v: number) => padL + ((v - lo) / (hi - lo)) * plotW;

    const BINS = 34;
    const counts = new Array(BINS).fill(0);
    for (const g of placebo.gs) {
      const b = Math.min(BINS - 1, Math.max(0, Math.floor(((g - lo) / (hi - lo)) * BINS)));
      counts[b]++;
    }
    const maxC = Math.max(...counts, 1);

    ctx.fillStyle = "#111827";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`ランダムに在場した ${placebo.gs.length} 通り（タイミング技能ゼロの対照群）`, padL, 14);

    const bw = plotW / BINS;
    counts.forEach((c, i) => {
      const h = (c / maxC) * plotH;
      ctx.fillStyle = "#93c5fd";
      ctx.fillRect(padL + i * bw, padT + plotH - h, Math.max(1, bw - 1), h);
    });

    // 3本の縦線のラベルは近接しがち（台帳の予測と中央は設計上ほぼ重なる）。
    // 段（level）を明示的に振り分けて衝突を避ける。level が大きいほど下に置く。
    const vline = (v: number, color: string, label: string, level: number) => {
      if (!isFinite(v) || v < lo || v > hi) return;
      const x = xOf(v);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = "bold 10px sans-serif";
      const flip = x > padL + plotW * 0.6;
      ctx.textAlign = flip ? "right" : "left";
      ctx.fillText(label, x + (flip ? -4 : 4), padT + 11 + level * 13);
    };
    vline(walkBH.g, "#16a34a", `持ち切り ${pct(walkBH.g)}`, 0);
    if (ledger) vline(ledger.gNet, "#b45309", `台帳の予測 ${pct(ledger.gNet)}`, 1);
    vline(placebo.q50, CHART_COLORS.reference, `ランダムの中央 ${pct(placebo.q50)}`, 2);

    ctx.strokeStyle = CHART_COLORS.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = CHART_COLORS.ink;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (const v of niceTicks(lo, hi, 5)) {
      const x = xOf(v);
      ctx.beginPath();
      ctx.moveTo(x, padT + plotH);
      ctx.lineTo(x, padT + plotH + 4);
      ctx.stroke();
      ctx.fillText(`${(v * 100).toFixed(0)}%`, x, padT + plotH + 16);
    }
    ctx.textAlign = "left";
    ctx.fillText("年率成長率", padL, height - 4);
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [placebo, walkBH, ledger]);

  if (!stats || !ledger || !params) return null;

  // 比べるのは「ドラッグ」と「売買の実費」だけ。取りこぼしは θ を上げれば消える
  // 別勘定なので、混ぜると判定がスライダーの位置で決まってしまう。
  const dragShare =
    ledger.dragLoss + ledger.turnoverLoss > 0
      ? ledger.dragLoss / (ledger.dragLoss + ledger.turnoverLoss)
      : 0;
  const turnoverWins = ledger.turnoverLoss > ledger.dragLoss;

  const muLo = stats.muArith - stats.seMu;
  const muHi = stats.muArith + stats.seMu;
  const kelly = stats.sigma > 0 ? (effStats?.muArith ?? 0) / (stats.sigma * stats.sigma) : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div>
        <h3 className="font-bold text-gray-800">持ち方の対数台帳（持ち切り vs 回転）</h3>
        <p className="text-xs text-gray-500 mt-1">
          {stats.from} 〜 {stats.to}（{stats.n}営業日 = {stats.years.toFixed(1)}年）。
          同じ銘柄・同じ相場で、<strong>持ち方だけ</strong>を変えたときに年率成長率がどう分解されるか。
        </p>
      </div>

      {/* ── 銘柄の素性 ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
        <div className="p-2 rounded border border-blue-200 bg-blue-50">
          <div className="text-gray-500">μ̂（年率算術）</div>
          <div className="font-mono font-bold">{pct(stats.muArith)}</div>
          <div className="text-gray-500 text-[10px]">±{(stats.seMu * 100).toFixed(1)}pp</div>
        </div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50">
          <div className="text-gray-500">σ（年率）</div>
          <div className="font-mono font-bold">{pct(stats.sigma)}</div>
        </div>
        <div className="p-2 rounded border border-purple-200 bg-purple-50">
          <div className="text-gray-500">壁 σ²/2</div>
          <div className="font-mono font-bold">{pct(stats.hurdle)}</div>
          <div className="text-gray-500 text-[10px]">これを μ が越えないと増えない</div>
        </div>
        <div className="p-2 rounded border border-green-200 bg-green-50">
          <div className="text-gray-500">g 実現</div>
          <div className="font-mono font-bold">{pct(stats.gRealized)}</div>
          <div className="text-gray-500 text-[10px]">倍化 {doublingYearsLabel(doublingYears(stats.gRealized))}</div>
        </div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50">
          <div className="text-gray-500">往復コスト{cost.measured ? "（実測）" : "（既定値）"}</div>
          <div className="font-mono font-bold">{pct(measuredCost, 2)}</div>
          <div className="text-gray-500 text-[10px]">
            {cost.measured ? "Corwin-Schultz" : "高安が無く推定不能のため既定 30bps"}
          </div>
        </div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50">
          <div className="text-gray-500">恒等式の残差</div>
          <div className="font-mono font-bold">{signedPP(stats.identityGap)}</div>
          <div className="text-gray-500 text-[10px]">g −(μ−σ²/2)</div>
        </div>
      </div>

      {/* ── μ の前提（このパネルの中心） ──────────────────────────────── */}
      <div className="rounded border border-amber-300 bg-amber-50 p-3 space-y-2">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div className="text-xs font-bold text-amber-900">
            μ の前提
            {muOverride === null ? (
              <span className="ml-2 font-normal text-amber-700">実測値に追従中</span>
            ) : (
              <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 font-normal">仮定</span>
            )}
          </div>
          <div className="text-xs font-mono">
            μ = {pct(effStats?.muArith ?? 0)} ／ ケリー f* = μ/σ² ={" "}
            <strong className={kelly > 1 ? "text-red-700" : ""}>{(kelly * 100).toFixed(0)}%</strong>
          </div>
        </div>
        <input
          type="range"
          min={-20}
          max={Math.max(300, Math.round(stats.muArith * 100))}
          step={1}
          value={Math.round((effStats?.muArith ?? 0) * 100)}
          onChange={(e) => setMuOverride(Number(e.target.value) / 100)}
          className="w-full"
          aria-label="μ の前提（年率%）"
        />
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <button type="button" onClick={() => setMuOverride(null)} className="px-2 py-0.5 rounded border border-amber-400 bg-white hover:bg-amber-100">
            実測 {pct(stats.muArith)} に戻す
          </button>
          <button type="button" onClick={() => setMuOverride(muLo)} className="px-2 py-0.5 rounded border border-amber-300 bg-white hover:bg-amber-100">
            −1SE {pct(muLo)}
          </button>
          <button type="button" onClick={() => setMuOverride(muHi)} className="px-2 py-0.5 rounded border border-amber-300 bg-white hover:bg-amber-100">
            +1SE {pct(muHi)}
          </button>
          <button type="button" onClick={() => setMuOverride(0.06)} className="px-2 py-0.5 rounded border border-amber-300 bg-white hover:bg-amber-100">
            株式の平均的な前提 6%
          </button>
        </div>
        <p className="text-[11px] text-amber-900 leading-relaxed">
          σ は動かしていません。<strong>μ だけ</strong>を動かすと、同じ銘柄で最適な建玉が
          {" "}{(((stats.muArith - stats.seMu) / (stats.sigma * stats.sigma)) * 100).toFixed(0)}% 〜{" "}
          {(((stats.muArith + stats.seMu) / (stats.sigma * stats.sigma)) * 100).toFixed(0)}%（±1SEの範囲だけで）動きます。
          この幅を決めているのは σ ではなく、<strong>誰にも測れない μ</strong> です。
        </p>
      </div>

      {/* ── 持ち方の操作子 ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
        <label className="space-y-1">
          <span className="text-gray-600">1回の保有日数 H：<strong className="font-mono">{holdDays}日</strong></span>
          <input type="range" min={1} max={63} value={holdDays} onChange={(e) => setHoldDays(Number(e.target.value))} className="w-full" />
        </label>
        <label className="space-y-1">
          <span className="text-gray-600">市場にいる割合 θ：<strong className="font-mono">{inMarketPct}%</strong></span>
          <input type="range" min={5} max={100} step={5} value={inMarketPct} onChange={(e) => setInMarketPct(Number(e.target.value))} className="w-full" />
        </label>
        <label className="space-y-1">
          <span className="text-gray-600">建玉倍率 q：<strong className="font-mono">{leverage.toFixed(1)}倍</strong></span>
          <input type="range" min={0.1} max={3} step={0.1} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className="w-full" />
        </label>
        <div className="space-y-1">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={taxEnabled} onChange={(e) => setTaxEnabled(e.target.checked)} />
            <span className="text-gray-600">実現益課税 {(TAX_RATE * 100).toFixed(3)}%</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-gray-600 whitespace-nowrap">往復コスト</span>
            <input
              type="number"
              step={1}
              min={0}
              value={Math.round(costRT * 10000)}
              onChange={(e) => setCostBps(Number(e.target.value))}
              className="w-16 border border-gray-300 rounded px-1 py-0.5 font-mono"
            />
            <span className="text-gray-500">bps</span>
            {costBps !== null && (
              <button type="button" onClick={() => setCostBps(null)} className="text-blue-600 underline">
                実測へ
              </button>
            )}
          </label>
        </div>
      </div>

      {/* ── ウォーターフォール ───────────────────────────────────────── */}
      <div className="relative">
        <canvas ref={waterfallRef} />
      </div>
      <p className="text-[11px] text-gray-500 -mt-2">
        紫＝ボラティリティドラッグ（建玉 q の<strong>二乗</strong>で効く）、赤＝削っている項、灰＝その設定では有利に働いた項、
        緑／赤の太枠＝手元に残る速さ（負なら赤）。符号は必ず左の数値で読んでください。
        {muOverride === null && "「期待リターン」の段に重ねた濃紺の横棒が μ̂ の ±1SE。"}
      </p>

      {/* ── ★ どちらが削ったか ─────────────────────────────────────── */}
      <div className="rounded border border-gray-300 p-3 space-y-2">
        <div className="text-xs font-bold text-gray-800">どちらが削ったか（同じスケールで比較）</div>
        {[
          { label: "ボラティリティドラッグ q²σ²/2", v: ledger.dragLoss, color: "bg-purple-500" },
          { label: "売買の実費（コスト＋信用金利＋税）", v: ledger.turnoverLoss, color: "bg-red-500" },
          { label: `市場にいない取りこぼし（θ=${inMarketPct}% の機会損失）`, v: ledger.idleLoss, color: "bg-amber-500" },
        ].map((b) => {
          const denom = Math.max(ledger.dragLoss, ledger.turnoverLoss, ledger.idleLoss, 1e-9);
          return (
            <div key={b.label} className="space-y-0.5">
              <div className="flex justify-between text-[11px]">
                <span className="text-gray-600">{b.label}</span>
                <span className="font-mono font-bold">{pct(b.v)}</span>
              </div>
              <div className="h-3 bg-gray-100 rounded overflow-hidden">
                <div className={`h-full ${b.color}`} style={{ width: `${Math.min(100, (Math.max(0, b.v) / denom) * 100)}%` }} />
              </div>
            </div>
          );
        })}
        <p className="text-[11px] text-gray-700 leading-relaxed">
          {turnoverWins ? (
            <>
              この設定では<strong className="text-red-700">売買の実費のほうが大きく削っています</strong>
              （ドラッグの{(ledger.turnoverLoss / Math.max(ledger.dragLoss, 1e-9)).toFixed(1)}倍）。
              ボラティリティが高いこと自体より、<strong>売買を挟むこと</strong>が効いている状態です。
            </>
          ) : (
            <>
              この設定では<strong className="text-purple-700">ドラッグのほうが大きく削っています</strong>
              （実費との合計の{(dragShare * 100).toFixed(0)}%）。
              建玉倍率 q を下げると q² で効くので、最も速く改善します。
            </>
          )}
        </p>
        <p className="text-[11px] text-gray-600 leading-relaxed">
          上2本だけを比べています。<strong>3本目の「取りこぼし」は売買費用ではなく、
          θ を 100% にすれば消える別勘定</strong>です（コストも税もゼロにしたときにだけ残る項）。
          混ぜて数えると、この判定が売買の話ではなく θ スライダーの位置で決まってしまいます。
        </p>
      </div>

      {/* ── 結果カード ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
        <div className="p-2 rounded border border-green-300 bg-green-50">
          <div className="text-gray-500">持ち切り（税引後）</div>
          <div className="font-mono font-bold text-base">{pct(ledger.gBuyHoldNet)}</div>
          <div className="text-gray-500 text-[10px]">倍化 {doublingYearsLabel(doublingYears(ledger.gBuyHoldNet))}</div>
        </div>
        <div className="p-2 rounded border border-red-300 bg-red-50">
          <div className="text-gray-500">この持ち方</div>
          <div className="font-mono font-bold text-base">{pct(ledger.gNet)}</div>
          <div className="text-gray-500 text-[10px]">倍化 {doublingYearsLabel(ledger.doublingYears)}</div>
        </div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50">
          <div className="text-gray-500">差</div>
          <div className={`font-mono font-bold text-base ${ledger.vsBuyHold >= 0 ? DIRECTION_TEXT_CLASS.up : DIRECTION_TEXT_CLASS.down}`}>
            {signedPP(ledger.vsBuyHold)}
          </div>
          <div className="text-gray-500 text-[10px]">年あたり</div>
        </div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50">
          <div className="text-gray-500">年間往復回数</div>
          <div className="font-mono font-bold text-base">{ledger.roundTrips.toFixed(0)}</div>
          <div className="text-gray-500 text-[10px]">持ち切りは期間中1回</div>
        </div>
      </div>

      {/* ── プラセボ分布 ────────────────────────────────────────────── */}
      {placebo && placebo.gs.length >= 20 && placebo.distinct < 5 ? (
        <div className="space-y-1">
          <div className="text-xs font-bold text-gray-800">実測の値動きで検証（プラセボ対照群）</div>
          <p className="text-[11px] text-gray-600 leading-relaxed rounded border border-gray-200 bg-gray-50 p-3">
            在場割合 θ が {inMarketPct}% なので、
            <strong>ランダムに選び直す余地がありません</strong>
            （どの試行も同じ日を保有するため、400通りが全部同じ結果になります）。
            対照群として意味を持たせるには θ を下げてください。
          </p>
        </div>
      ) : placebo && walkBH && placebo.gs.length >= 20 ? (
        <div className="space-y-1">
          <div className="text-xs font-bold text-gray-800">実測の値動きで検証（プラセボ対照群）</div>
          <div className="relative">
            <canvas ref={placeboRef} />
          </div>
          <p className="text-[11px] text-gray-600 leading-relaxed">
            同じ回転率・同じ在場割合で、<strong>いつ建てるかだけを無作為にした</strong> 400 通り
            （実測の平均 {(placebo.meanRoundTrips / stats.years).toFixed(0)} 往復/年 ＝ 台帳の
            {ledger.roundTrips.toFixed(0)} 往復/年。ここが揃っていないと比較になりません）。
            上の台帳が仮定した「タイミング技能ゼロ」が、実データでどれだけ散らばるかを示します。
            台帳の予測（{pct(ledger.gNet)}）がこの分布の中に落ちていれば、台帳の前提は妥当です。
            実際の売買がこの分布より<strong>右</strong>に出て初めて「技能」と言えます
            （その検定はカレンダー節の「タイミング判断の価値検定（SPA）」が担当します）。
            なおこの分布は実測の値動きを歩くので、上の μ スライダーは効きません。
          </p>
        </div>
      ) : null}

      {/* ── H × θ グリッド ─────────────────────────────────────────── */}
      {grid && (
        <div className="space-y-1">
          <div className="text-xs font-bold text-gray-800">保有日数 × 在場割合（持ち切り比 pp）</div>
          <div className="overflow-x-auto">
            <table className="text-[11px] border-collapse min-w-full">
              <thead>
                <tr className="bg-gray-50">
                  <th className="border border-gray-200 px-2 py-1 text-left">保有 H＼在場 θ</th>
                  {IN_MARKET_LIST.map((th) => (
                    <th key={th} className="border border-gray-200 px-2 py-1 font-mono">{(th * 100).toFixed(0)}%</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.map((row, i) => (
                  <tr key={HOLD_DAYS_LIST[i]}>
                    <th className="border border-gray-200 px-2 py-1 text-left font-mono bg-gray-50">{HOLD_DAYS_LIST[i]}日</th>
                    {row.map((cell) => (
                      <td key={cell.inMarket} className="border border-gray-200 px-2 py-1 text-center font-mono">
                        <div className={cell.vsBuyHold >= 0 ? DIRECTION_TEXT_CLASS.up : DIRECTION_TEXT_CLASS.down}>
                          {signedPP(cell.vsBuyHold)}
                        </div>
                        <div className="text-gray-500 text-[10px]">g {pct(cell.gNet)}</div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-500">
            すべて赤（持ち切り比マイナス）になるのは偶然ではありません。回転コストと税は
            <strong>符号が確定している</strong>ので、タイミング技能がゼロなら必ず負けます。
          </p>
        </div>
      )}

      {/* ── 夜間 / 日中（終値だけの系列では成立しないので隠す） ─────────── */}
      {hasIntraday && (
      <div className="rounded border border-gray-200 bg-gray-50 p-3 text-xs space-y-1">
        <div className="font-bold text-gray-800">ドリフトはどこにあったか（年率対数）</div>
        <div className="grid grid-cols-3 gap-2 font-mono">
          <div>
            <div className="text-gray-500 text-[11px]">夜間（前日終値→始値）</div>
            <div className="font-bold">{pct(stats.overnight)}</div>
          </div>
          <div>
            <div className="text-gray-500 text-[11px]">日中（始値→終値）</div>
            <div className="font-bold">{pct(stats.intraday)}</div>
          </div>
          <div>
            <div className="text-gray-500 text-[11px]">夜間シェア</div>
            <div className="font-bold">
              {Math.abs(stats.overnight + stats.intraday) > 1e-9
                ? `${((stats.overnight / (stats.overnight + stats.intraday)) * 100).toFixed(0)}%`
                : "—"}
            </div>
          </div>
        </div>
        <p className="text-[11px] text-gray-600 leading-relaxed">
          これは近似ではなく分解の恒等式です（夜間＋日中＝日次対数リターン）。
          日本株はドリフトが<strong>寄り付きギャップ</strong>に偏ることが多く、日中がマイナスの銘柄もあります。
          その場合、日中の値動きを見て建玉を動かす行為は、<strong>期待値の薄い区間で回転コストだけを払う</strong>ことになります。
        </p>
      </div>
      )}

      <AnalysisGuide title="持ち方の対数台帳の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          終端資産の対数を、<strong>加法的な項</strong>に分解します。富は掛け算で増えるので、対数を取ると
          「銘柄の素性」「建玉の大きさ」「市場にいる時間」「売買コスト」「税」が足し算になり、
          どれがいくら効いているかを同じ物差しで比較できます。掛け算のままでは比較できません。
        </p>
        <p>
          このパネルの目的は<strong>「高ボラをやめろ」と言うことではありません</strong>。
          ボラティリティドラッグと回転コストは<strong>別の機構</strong>であり、銘柄によってどちらが
          支配的かが変わります。両方を同じスケールで出して、読者自身に判定させます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式（省略なし）</p>
        <p>変数を定義します。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>r<sub>t</sub></strong>：日次の単純リターン。<strong>ρ<sub>t</sub> = ln(1+r<sub>t</sub>)</strong> が対数リターン。</li>
          <li><strong>μ</strong>：年率<strong>算術</strong>平均リターン。μ = 252·mean(r<sub>t</sub>)。</li>
          <li><strong>σ</strong>：年率ボラティリティ。σ = √252 · sd(ρ<sub>t</sub>)。</li>
          <li><strong>q</strong>：建玉倍率（1＝現物フル、2＝信用2倍）。<strong>θ</strong>：市場にいる時間割合。</li>
          <li><strong>H</strong>：1回の保有営業日数。<strong>c</strong>：1往復の売買コスト（比率）。<strong>τ</strong>：実現益への税率。</li>
        </ul>
        <p className="mt-2">
          <strong>(a) 幾何成長率の定義。</strong> 富 W<sub>T</sub> = W<sub>0</sub>·Π(1+r<sub>t</sub>) の対数を取ると
          ln(W<sub>T</sub>/W<sub>0</sub>) = Σρ<sub>t</sub>。年率にすると g = 252·mean(ρ<sub>t</sub>)。
          これが「実際に増える速さ」であり、平均リターン μ ではありません。
        </p>
        <p className="mt-2">
          <strong>(b) ドラッグの導出。</strong> ρ = ln(1+r) を r = 0 のまわりで展開すると
          ρ ≈ r − r²/2。両辺の期待値を取り、E[r²] = Var(r) + E[r]² で E[r]² が二次の微小量として無視できるとき
          E[ρ] ≈ E[r] − Var(r)/2。年率化して
        </p>
        <p className="font-mono text-center my-1">g = μ − σ²/2</p>
        <p>
          対数正規を仮定すれば近似ではなく厳密に成立します。このパネルの見出しにある
          「恒等式の残差」は g<sub>実現</sub> − (μ − σ²/2) の実測値で、通常 1pp 以内に収まります。
        </p>
        <p className="mt-2">
          <strong>(c) 建玉倍率。</strong> 建玉 q 倍の富は Π(1+q·r<sub>t</sub>) で回るので、同じ展開から
        </p>
        <p className="font-mono text-center my-1">g(q) = q·μ − q²σ²/2</p>
        <p>
          <strong>期待は q に比例し、ドラッグは q の二乗で効きます。</strong>これが本パネルで唯一
          「ボラティリティが決定的になる」場所です。g(q) を最大化する q が
          <strong>ケリー基準 q* = μ/σ²</strong>、g(q)=0 となる破産線が q = 2μ/σ² です。
        </p>
        <p className="mt-2">
          <strong>(d) 在場割合。</strong> 対数富は保有中しか動きません。タイミング技能がゼロ
          （在場期間のリターン分布＝全期間の分布）なら、期待項もドラッグ項も同じ θ が掛かります。
        </p>
        <p className="font-mono text-center my-1">g<sub>在場</sub> = θ·(q·μ − q²σ²/2)</p>
        <p>
          <strong>重要</strong>：売買を挟むこと自体はドラッグを<strong>相対的に悪化させません</strong>。
          「短期売買はボラティリティドラッグで損をする」という説明は、この式の前で成立しません。
        </p>
        <p className="mt-2">
          <strong>(e) 売買コスト。</strong> 富は W ← W·(1+r)·(1−qc) と回るので、対数を取ると
          1往復あたり ln(1−qc) を足すのが<strong>厳密な</strong>控除です（近似ではありません）。
          年間往復回数は N = 252θ/H なので
        </p>
        <p className="font-mono text-center my-1">コスト項 = (252θ/H)·ln(1 − q·c)</p>
        <p>
          <strong>H に反比例します。</strong>持ち切りは期間中1回しか払わないのに対し、H=5日なら年50回払います。
          この非対称性が、同じエッジでも結果を分ける主因になります。
        </p>
        <p className="mt-2">
          <strong>(f) 税の繰延。</strong> H日ごとに利益を実現して τ を払うと、1サイクルの純増は
          (1−τ)(e<sup>g·H/252</sup>−1) になります。年率対数に戻すと
        </p>
        <p className="font-mono text-center my-1">g<sub>税引後</sub> = (252/H)·ln[ 1 + (1−τ)(e<sup>g·H/252</sup> − 1) ]</p>
        <p>
          H → 0 の極限で g<sub>税引後</sub> → (1−τ)·g、つまり<strong>成長率そのものに τ が掛かります</strong>。
          H が大きいほど exp の凸性の分だけ有利になり、これが「課税繰延の価値」の正体です。
          税項は g に比例するので、<strong>当たっている銘柄ほど回転の税負担が大きくなります</strong>。
        </p>
        <p className="mt-2">
          <strong>(g) 信用金利。</strong> q &gt; 1 の部分は借入なので、年率 r<sub>m</sub> のキャリーが
          −θ·(q−1)·r<sub>m</sub> として対数空間に直接効きます。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 専門用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>幾何成長率（g）</strong>：資産が実際に増える年率の速さ。複利で効くのはこちら。</li>
          <li><strong>算術平均リターン（μ）</strong>：各期のリターンを単純平均したもの。σ²/2 だけ g より大きく出る「見かけの数字」。</li>
          <li><strong>ボラティリティドラッグ</strong>：μ と g の差 σ²/2。<strong>損失ではありません</strong>（後述5参照）。</li>
          <li><strong>在場割合（θ）</strong>：1年のうち建玉を持っている時間の比率。</li>
          <li><strong>回転率</strong>：年間の往復（建てて畳む）回数。コスト総額を決める。</li>
          <li><strong>実現益課税</strong>：手仕舞って利益を確定した時点でかかる税。含み益には課されない。</li>
          <li><strong>標準誤差 SE(μ̂)</strong>：μ の推定のばらつき。σ/√T（T は年数）。</li>
          <li><strong>プラセボ対照群</strong>：同じ回転率で、タイミングだけ無作為にした比較群。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          <strong>果樹園と収穫。</strong> 木（銘柄）が育つ速さは木の性質で決まります。
          収穫のたびに籠を運ぶ手間（売買コスト）と、収穫分にかかる税（実現益課税）を払います。
          年に50回収穫しても木が速く育つわけではなく、手間と税だけが50回分かかります。
          <strong>木を植え替える判断（銘柄選択）と、何回収穫するか（回転）は別の話です。</strong>
        </p>
        <p className="mt-2">
          <strong>ドラッグの正体。</strong> 100万円が +50% → −40% と動くと 90万円。順序を逆にしても 90万円。
          平均は (50−40)/2 = +5% なのに、実際は −10%。この乖離が σ²/2 です。
          <strong>σ²/2 は「誰かに取られた」のではなく、平均値と中央値の乖離</strong>です。
          期待値そのものは減っていません（減るのは典型的な結果のほう）。人生は1回しかないので、
          あなたが受け取るのは平均ではなく中央値です。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>「どちらが削ったか」の上2本が判定の中心。</strong>売買の実費のほうが長ければ、
            その銘柄で問題なのはボラティリティではなく売買頻度です。ドラッグのほうが長ければ、
            建玉 q を下げるのが最速の改善です。
            <strong>3本目の「取りこぼし」は上2本と混ぜないこと。</strong>あれは θ を上げれば消える
            機会損失で、売買費用ではありません（コストも税もゼロにしたときにだけ残ります）。
            混ぜて数えると、判定が θ スライダーの位置で決まってしまいます。
          </li>
          <li>
            <strong>壁 σ²/2 と SE(μ̂) を必ず見比べる。</strong>SE のほうが大きければ、
            「この銘柄は複利で増える」を<strong>測定では主張できません</strong>。
            高ボラ銘柄ほど壁は σ² で伸び、SE は σ で伸びるので、両方が同時に大きくなります。
          </li>
          <li>
            <strong>H×θ の表が全部マイナスなのは仕様です。</strong>コストと税は符号が確定しているので、
            技能ゼロなら必ず持ち切りに負けます。プラスにできる唯一の経路はタイミング技能です。
          </li>
          <li>
            <strong>ケリー f* の暴れ方を見る。</strong>μ を ±1SE 動かすだけで f* が数倍動くなら、
            「最適な建玉」は測定で決まっていません。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>銘柄選択と回転を切り離して考える。</strong>ある銘柄が当たっていることと、
            その銘柄を回転させることの是非は独立です。当たっている銘柄ほど、回転の税負担は重くなります。
          </li>
          <li>
            <strong>確実なものから手を付ける。</strong>μ は測れず σ は測れます。回転コストと税は
            符号が確定しています。改善は「測れて符号が確定している側」から着手するのが合理的です。
          </li>
          <li>
            <strong>q を最初に決める。</strong>ドラッグは q² で効くので、信用倍率を下げることは
            他のどの操作よりも確実に効きます。ドローダウンも同時に浅くなります。
          </li>
          <li>
            <strong>低ボラを選ぶ理由を取り違えない。</strong>「ドラッグを避けるため」ではなく
            <strong>「越えるべき壁が低く、必要な信念が小さくて済むから」</strong>です。
            σ=25% なら壁は年3.1%、σ=65% なら年21.1%。後者を正当化するには、
            誰も検証できない年21%以上の見通しを信じる必要があります。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>台帳はタイミング技能ゼロを前提にしています。</strong>技能が実在すれば結論は変わります。
            それを検定するのがプラセボ分布であり、正式な多重比較補正つきの検定は
            カレンダー節の SPA / Reality Check です。
          </li>
          <li>
            <strong>税は損益通算を仮定した近似です。</strong>実際には年をまたぐ繰越控除・特定口座の扱い・
            NISA枠で挙動が変わります。経路依存な厳密計算はカレンダー節の「NISA vs 現物」を参照。
          </li>
          <li>
            <strong>往復コストは高安から推定した代理値です</strong>（Corwin-Schultz）。板情報を使っていないので、
            流動性の低い銘柄では過大にも過小にもなり得ます。実際の手数料体系がわかるなら手入力してください。
          </li>
          <li>
            <strong>μ̂ は両端2点の恒等式です。</strong>μ̂ = ln(P<sub>T</sub>/P<sub>0</sub>)/T なので、
            観測頻度を上げても精度は<strong>1ミリも改善しません</strong>。σ̂ だけが √(2n) で縮みます。
            この非対称性の詳細は横断ダッシュボードの「個別ドリフトの識別限界」にあります。
          </li>
          <li>
            <strong>短い標本ほど危険です。</strong>上場から日の浅い銘柄では SE(μ̂) が壁を大きく上回り、
            実現した高い成長率は「その期間そうだった」以上の意味を持ちません。
          </li>
          <li>
            <strong>正規・独立を仮定していません</strong>が（歩行は実データをそのまま使う）、
            プラセボのブロック選択は独立に行うため、レジームの持続性は保存されません。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
