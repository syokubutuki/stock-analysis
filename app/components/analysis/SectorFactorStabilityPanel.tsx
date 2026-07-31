"use client";

// 系C29 P2「この順位は来年も同じか」の描画層（L2-A〜D ＋ 建玉への翻訳）。
//
// **これは独立した分析ではなく、SectorFactorSelectChart（P1）の同じ画面に差し込む層**。
// 「この順位表を使ってよいのか」に答える層なので、順位表から離すと必ず読まれない。
// 判定バッジだけは順位表の直前に出す（順位を読む前に信用度を見せるため）。
//
// 計算は sector-factor-stability.ts。重い L2-C（supWald のブロック・ブート）だけ Worker。
// 描画方式は CLAUDE.md の規約どおり、横軸が時間の「ローリング b(t)」だけ
// lightweight-charts、残りは横軸が時間でない静的図なので Canvas2D。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  createSeriesMarkers,
  LineStyle,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeSectorStability,
  BOJ_POLICY_EVENTS,
  DEFAULT_STABILITY_PARAMS,
  type StabilityParams,
  type StabilityResult,
  type BreakResult,
} from "../../lib/sector-factor-stability";
import type { StabilityWorkerRequest, StabilityWorkerResponse } from "../../lib/sector-factor-stability.worker";
import type { FactorPrices } from "../../lib/sector-factor-select";
import AnalysisGuide from "./AnalysisGuide";

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

/**
 * 右端の凡例ラベルを縦に重ならないよう積む。
 * 系列の終端値が近いと文字が重なって読めなくなるため（実測で「上位5生存」と
 * 「rankIC(S)」が完全に重なった）、使用済みの y を覚えて押し下げる。
 */
function makeLabelStack(min = 11) {
  const used: number[] = [];
  return (y: number) => {
    let v = y;
    for (let i = 0; i < 20; i++) {
      if (!used.some((u) => Math.abs(u - v) < min)) break;
      v += min;
    }
    used.push(v);
    return v;
  };
}

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

// ════════════════════════════════════════════════════════════════════════════
// 計算のフック（親が持つ。バッジと本体で同じ result を使うため）
// ════════════════════════════════════════════════════════════════════════════

export interface StabilityControls {
  window: number;
  rollWindow: number;
  rollStep: number;
  horizons: number[];
}

export const DEFAULT_STABILITY_CONTROLS: StabilityControls = {
  window: DEFAULT_STABILITY_PARAMS.window,
  rollWindow: DEFAULT_STABILITY_PARAMS.rollWindow,
  rollStep: DEFAULT_STABILITY_PARAMS.rollStep,
  horizons: DEFAULT_STABILITY_PARAMS.horizons,
};

export interface StabilityState {
  result: StabilityResult | null;
  breaks: BreakResult | null;
  breakProgress: { done: number; total: number } | null;
  computing: boolean;
  breakError: string | null;
}

/**
 * L2 の計算。P1 の描画を止めないよう、重い同期計算は次のフレームへ送ってから走らせる。
 * L2-C だけは Worker（supWald のブートが全体の計算量を支配するため）。
 */
export function useSectorStability(
  pricesByTicker: Record<string, PricePoint[]>,
  factors: FactorPrices | null,
  controls: StabilityControls,
  extra: Partial<StabilityParams>,
  names: Record<string, string>,
  enabled: boolean
): StabilityState {
  const [result, setResult] = useState<StabilityResult | null>(null);
  const [computing, setComputing] = useState(false);
  const [breaks, setBreaks] = useState<BreakResult | null>(null);
  const [breakProgress, setBreakProgress] = useState<{ done: number; total: number } | null>(null);
  const [breakError, setBreakError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqRef = useRef(0);

  const key = JSON.stringify({ c: controls, e: extra, n: Object.keys(pricesByTicker).sort() });

  useEffect(() => {
    let cancelled = false;
    // P1 の描画を先に出してから重い計算に入る（同期 setState を効果本体に置かない）。
    const id = setTimeout(() => {
      if (cancelled) return;
      if (!enabled || !factors?.market || Object.keys(pricesByTicker).length < 3) {
        setResult(null);
        setBreaks(null);
        setComputing(false);
        return;
      }
      setComputing(true);
      setBreaks(null);
      setBreakError(null);
      let res: StabilityResult | null = null;
      try {
        res = computeSectorStability(
          pricesByTicker,
          factors,
          { ...extra, ...controls },
          names
        );
      } catch (err) {
        console.error("sector stability compute failed", err);
      }
      if (cancelled) return;
      setResult(res);
      setComputing(false);

      // ── L2-C を Worker へ ────────────────────────────────
      if (!res) return;
      try {
        if (!workerRef.current) {
          workerRef.current = new Worker(
            new URL("../../lib/sector-factor-stability.worker.ts", import.meta.url)
          );
        }
        const w = workerRef.current;
        const reqId = ++reqRef.current;
        w.onmessage = (ev: MessageEvent<StabilityWorkerResponse>) => {
          if (ev.data.reqId !== reqRef.current) return;
          if (ev.data.progress) setBreakProgress(ev.data.progress);
          if (ev.data.error) setBreakError(ev.data.error);
          if (ev.data.result) {
            setBreaks(ev.data.result);
            setBreakProgress(null);
          }
        };
        const req: StabilityWorkerRequest = {
          reqId,
          kind: "breaks",
          panel: res.panel,
          params: {
            trim: res.params.trim,
            rollStep: res.params.rollStep,
            nBoot: res.params.nBoot,
            blockLen: res.params.blockLen,
            seed: res.params.seed,
          },
        };
        setBreakProgress({ done: 0, total: res.tickers.length + 1 });
        w.postMessage(req);
      } catch (err) {
        setBreakError(String(err));
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, factors?.market, factors?.sector, factors?.rate]);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    []
  );

  return { result, breaks, breakProgress, computing, breakError };
}

// ════════════════════════════════════════════════════════════════════════════
// L2-A 判定バッジ（順位表の直前に置く）
// ════════════════════════════════════════════════════════════════════════════

export function StabilityVerdictBadge({ state }: { state: StabilityState }) {
  const { result, computing } = state;
  if (computing && !result) {
    return (
      <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
        この順位が来年も同じかを検証中…（ローリング推定 → 持続率 π）
      </div>
    );
  }
  if (!result) return null;
  const p = result.persistence;
  const dead = p.indistinguishableFromNull;
  const strong = !dead && p.piLo > 0.5;
  const cls = dead
    ? "border-red-300 bg-red-50 text-red-800"
    : strong
      ? "border-green-300 bg-green-50 text-green-800"
      : "border-amber-300 bg-amber-50 text-amber-800";
  const surv = result.rankStability.byHorizon.find((r) => r.h === p.decisionH);
  return (
    <div className={`rounded border px-3 py-2 ${cls}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-bold">
          {dead
            ? "この順位は使えない（持続性を測れていない）"
            : strong
              ? "この順位は来年もほぼ同じ"
              : "順位の持続性は弱い"}
        </span>
        <span className="font-mono text-xs">
          π({p.decisionH}日) = <b className="text-base">{p.piPoint.toFixed(2)}</b>
          <span className="text-gray-500">
            {" "}
            [{p.piLo.toFixed(2)}, {p.piHi.toFixed(2)}]
          </span>
          <span className="mx-1 text-gray-400">/</span>
          半減期{" "}
          <b>
            {p.halfLife !== null ? `${Math.round(p.halfLife)}日` : "—"}
          </b>
          {surv && (
            <>
              <span className="mx-1 text-gray-400">/</span>
              上位{result.params.topK}本の1年後生存 <b>{pct(surv.topKSurvival, 0)}</b>
              <span className="text-gray-500">（ヌル {pct(surv.survivalNull, 0)}）</span>
            </>
          )}
        </span>
      </div>
      <div className="mt-0.5 text-[11px]">
        {dead
          ? "今日の b の散らばりが1年後まで残るという証拠が、この標本からは出ていない。下の推奨ウェイトは参考値として読み、実際の配分は等加重（または銀行ETF 1615.T）に寄せること。"
          : strong
            ? `今日の b の散らばりのうち ${pct(Math.max(0, p.piLo), 0)} 以上が1年後まで残る（CI下限）。順位表をチルトの根拠に使ってよい。ただし残るのは「順位」であって「儲かること」ではない（P3 の前向き検証は未了）。`
            : "持続はしているが CI が広く、チルトを強く効かせる根拠には足りない。二段収縮で平均へ寄せた値を使うこと。"}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 本体
// ════════════════════════════════════════════════════════════════════════════

const SERIES_COLORS = ["#4f46e5", "#059669", "#d97706", "#dc2626", "#0284c7", "#7c3aed"];

interface PanelProps {
  state: StabilityState;
  controls: StabilityControls;
  setControls: (c: StabilityControls) => void;
  names: Record<string, string>;
  heldSet: Set<string>;
}

export default function SectorStabilityPanel({ state, controls, setControls, names, heldSet }: PanelProps) {
  const { result, breaks, breakProgress, computing, breakError } = state;
  const [twoStage, setTwoStage] = useState(true);
  const [lambda, setLambda] = useState(1);
  const [costBps, setCostBps] = useState(10);
  const [breakTicker, setBreakTicker] = useState<string | null>(null);

  const label = useCallback(
    (t: string) => (names[t] ?? t).slice(0, 12),
    [names]
  );

  // ── L2-A 減衰曲線 ────────────────────────────────────────
  const decayRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = decayRef.current;
    if (!cv || !result) return;
    const init = initCanvas(cv, 210);
    if (!init) return;
    const { ctx, width, height } = init;
    const padL = 44;
    const padR = 90;
    const padT = 14;
    const padB = 30;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const cur = result.persistence.curve;
    if (cur.length === 0) return;

    const hMax = Math.max(...cur.map((c) => c.h)) * 1.05;
    const yLo = Math.min(-0.15, ...cur.map((c) => (Number.isFinite(c.lo) ? c.lo : 0))) - 0.05;
    const yHi = Math.max(1.1, ...cur.map((c) => (Number.isFinite(c.hi) ? c.hi : 0))) + 0.05;
    const X = (h: number) => padL + (h / hMax) * plotW;
    const Y = (v: number) => padT + plotH - ((v - yLo) / (yHi - yLo)) * plotH;

    // 目盛
    ctx.strokeStyle = "#e5e7eb";
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    for (let v = Math.ceil(yLo * 4) / 4; v <= yHi; v += 0.25) {
      ctx.beginPath();
      ctx.moveTo(padL, Y(v));
      ctx.lineTo(padL + plotW, Y(v));
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(v.toFixed(2), padL - 5, Y(v) + 3);
    }
    // 持続率 1 と 0 を強調（π は 10px だと n と紛らわしいので canvas では漢字で書く）
    const stack = makeLabelStack();
    for (const [v, txt] of [
      [1, "1.0 完全に持続"],
      [0, "0 順位は無意味"],
    ] as [number, string][]) {
      if (v < yLo || v > yHi) continue;
      ctx.strokeStyle = "#94a3b8";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, Y(v));
      ctx.lineTo(padL + plotW, Y(v));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#64748b";
      ctx.textAlign = "left";
      ctx.fillText(txt, padL + plotW + 4, stack(Y(v)) + 3);
    }

    // ヌル95%点（銘柄ラベル横断シャッフル）。0 の線とほぼ重なるので線の上に置く。
    ctx.strokeStyle = "#f87171";
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    cur.forEach((c, i) => (i === 0 ? ctx.moveTo(X(c.h), Y(c.nullHi)) : ctx.lineTo(X(c.h), Y(c.nullHi))));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#dc2626";
    ctx.textAlign = "left";
    ctx.fillText("ヌル95%（持続性ゼロの上限）", padL + 6, Y(cur[0].nullHi) - 5);

    // exp(−h/τ) フィット
    const tau = result.persistence.tau;
    if (tau !== null) {
      ctx.strokeStyle = "#c7d2fe";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let h = 0; h <= hMax; h += hMax / 60) {
        const v = Math.exp(-h / tau);
        if (h === 0) ctx.moveTo(X(h), Y(v));
        else ctx.lineTo(X(h), Y(v));
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      const hl = result.persistence.halfLife;
      if (hl !== null && hl <= hMax) {
        ctx.strokeStyle = "#6366f1";
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(X(hl), padT);
        ctx.lineTo(X(hl), padT + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#4f46e5";
        ctx.textAlign = "center";
        ctx.fillText(`半減期 ${Math.round(hl)}日`, X(hl), padT + 10);
      }
    }

    // CI と点
    for (const c of cur) {
      if (Number.isFinite(c.lo) && Number.isFinite(c.hi)) {
        ctx.strokeStyle = "#94a3b8";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(X(c.h), Y(c.lo));
        ctx.lineTo(X(c.h), Y(c.hi));
        ctx.stroke();
        for (const e of [c.lo, c.hi]) {
          ctx.beginPath();
          ctx.moveTo(X(c.h) - 3, Y(e));
          ctx.lineTo(X(c.h) + 3, Y(e));
          ctx.stroke();
        }
      }
      ctx.fillStyle = c.overlap > 0 ? "#a5b4fc" : "#4f46e5";
      ctx.beginPath();
      ctx.arc(X(c.h), Y(c.pi), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#6b7280";
      ctx.textAlign = "center";
      ctx.fillText(`${c.h}日`, X(c.h), height - 16);
      ctx.fillStyle = "#9ca3af";
      ctx.fillText(c.overlap > 0 ? `φ=${c.overlap.toFixed(2)}` : "非重複", X(c.h), height - 5);
    }

    ctx.strokeStyle = "#d1d5db";
    ctx.strokeRect(padL, padT, plotW, plotH);
  }, [result]);

  // ── L2-B ローリング b(t)（lightweight-charts）────────────
  const rollRef = useRef<HTMLDivElement | null>(null);
  const topIdx = useMemo(() => {
    if (!result) return [];
    const last = result.rolls[result.rolls.length - 1];
    return last.score
      .map((v, i) => ({ v, i }))
      .sort((a, b) => b.v - a.v)
      .slice(0, result.params.topK)
      .map((x) => x.i);
  }, [result]);

  useEffect(() => {
    const el = rollRef.current;
    if (!el || !result) return;
    const chart = createChart(el, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: el.clientWidth,
      height: 300,
      crosshair: { mode: 0 },
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    const colorOf = (i: number) => {
      const rank = topIdx.indexOf(i);
      if (rank >= 0) return SERIES_COLORS[rank % SERIES_COLORS.length];
      return "#d4d4d8";
    };
    let markerSeries: ReturnType<typeof chart.addSeries> | null = null;
    // 目立たせたい銘柄を後に描いて前面に出す。
    const order = [...result.tickers.keys()].sort(
      (a, b) => (topIdx.includes(a) ? 1 : 0) - (topIdx.includes(b) ? 1 : 0)
    );
    for (const i of order) {
      const t = result.tickers[i];
      const s = chart.addSeries(LineSeries, {
        color: colorOf(i),
        lineWidth: heldSet.has(t) ? 3 : topIdx.includes(i) ? 2 : 1,
        title: topIdx.includes(i) || heldSet.has(t) ? label(t) : "",
        priceLineVisible: topIdx.includes(i),
        lastValueVisible: topIdx.includes(i),
      });
      s.setData(result.rolls.map((r) => ({ time: r.date as Time, value: r.b[i] })));
      if (topIdx[0] === i) markerSeries = s;
    }
    // 政策イベントと合意分割点をマーカーに（検定には使わない・ラベルのみ）。
    if (markerSeries) {
      const dates = result.rolls.map((r) => r.date);
      const snap = (d: string) => dates.find((x) => x >= d) ?? null;
      const ms: SeriesMarker<Time>[] = [];
      for (const ev of BOJ_POLICY_EVENTS) {
        const d = snap(ev.date);
        if (d) ms.push({ time: d as Time, position: "aboveBar", color: "#94a3b8", shape: "arrowDown", text: ev.label.slice(0, 8) });
      }
      for (const cb of breaks?.consensusBreaks.slice(0, 3) ?? []) {
        const d = snap(cb.date);
        if (d) ms.push({ time: d as Time, position: "belowBar", color: "#dc2626", shape: "arrowUp", text: `分割点 ${cb.votes}票` });
      }
      ms.sort((a, b) => String(a.time).localeCompare(String(b.time)));
      createSeriesMarkers(markerSeries, ms);
      markerSeries.createPriceLine({
        price: result.decision.bMean,
        color: "#6366f1",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "b̄",
      });
    }
    chart.timeScale().fitContent();
    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, [result, topIdx, heldSet, label, breaks]);

  // ── L2-B 生存率・IC ─────────────────────────────────────
  const survRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = survRef.current;
    if (!cv || !result) return;
    const init = initCanvas(cv, 180);
    if (!init) return;
    const { ctx, width, height } = init;
    const padL = 40;
    const padR = 78;
    const padT = 12;
    const padB = 26;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const rows = result.rankStability.byHorizon;
    if (rows.length === 0) return;
    const hMax = Math.max(...rows.map((r) => r.h)) * 1.05;
    const X = (h: number) => padL + (h / hMax) * plotW;
    const Y = (v: number) => padT + plotH - v * plotH;

    ctx.strokeStyle = "#e5e7eb";
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    for (let v = 0; v <= 1.0001; v += 0.25) {
      ctx.beginPath();
      ctx.moveTo(padL, Y(v));
      ctx.lineTo(padL + plotW, Y(v));
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(pct(v, 0), padL - 5, Y(v) + 3);
    }
    // ヌル線 k/N
    const stack = makeLabelStack();
    const nl = rows[0].survivalNull;
    ctx.strokeStyle = "#f87171";
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, Y(nl));
    ctx.lineTo(padL + plotW, Y(nl));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#dc2626";
    ctx.textAlign = "left";
    ctx.fillText(`ヌル k/N=${pct(nl, 0)}`, padL + plotW + 4, stack(Y(nl)) + 3);

    const draw = (get: (r: (typeof rows)[0]) => number, color: string, name: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      rows.forEach((r, i) => (i === 0 ? ctx.moveTo(X(r.h), Y(get(r))) : ctx.lineTo(X(r.h), Y(get(r)))));
      ctx.stroke();
      ctx.lineWidth = 1;
      for (const r of rows) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(X(r.h), Y(get(r)), 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.fillText(name, padL + plotW + 4, stack(Y(get(rows[rows.length - 1]))) + 3);
    };
    draw((r) => r.topKSurvival, "#4f46e5", `上位${result.params.topK}生存`);
    draw((r) => Math.max(0, r.rankIcS), "#059669", "rankIC(S)");
    draw((r) => Math.max(0, Math.min(1, r.turnover / 2)), "#d97706", "片道回転");

    for (const r of rows) {
      ctx.fillStyle = "#6b7280";
      ctx.textAlign = "center";
      ctx.fillText(`${r.h}日`, X(r.h), height - 8);
    }
    ctx.strokeStyle = "#d1d5db";
    ctx.strokeRect(padL, padT, plotW, plotH);
  }, [result]);

  // ── L2-B 遷移行列 ──────────────────────────────────────
  const transRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = transRef.current;
    if (!cv || !result) return;
    const Q = result.rankStability.quantiles;
    const init = initCanvas(cv, 40 + Q * 34);
    if (!init) return;
    const { ctx, width } = init;
    const padL = 62;
    const padT = 30;
    const cell = Math.min(56, (width - padL - 16) / Q);
    const M = result.rankStability.transition;
    ctx.font = "10px sans-serif";
    for (let r = 0; r < Q; r++) {
      ctx.fillStyle = "#6b7280";
      ctx.textAlign = "right";
      ctx.fillText(`今 Q${Q - r}`, padL - 6, padT + r * 34 + 20);
      for (let c = 0; c < Q; c++) {
        const v = M[Q - 1 - r]?.[Q - 1 - c] ?? 0;
        const a = Math.min(1, v * 1.4);
        ctx.fillStyle = `rgba(79,70,229,${a.toFixed(3)})`;
        ctx.fillRect(padL + c * cell, padT + r * 34, cell - 2, 32);
        ctx.fillStyle = a > 0.5 ? "#ffffff" : "#374151";
        ctx.textAlign = "center";
        ctx.fillText(pct(v, 0), padL + c * cell + cell / 2 - 1, padT + r * 34 + 20);
      }
    }
    for (let c = 0; c < Q; c++) {
      ctx.fillStyle = "#6b7280";
      ctx.textAlign = "center";
      ctx.fillText(`来 Q${Q - c}`, padL + c * cell + cell / 2 - 1, padT - 8);
    }
  }, [result]);

  // ── 決定: ウェイト比較バー ────────────────────────────
  const weightRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = weightRef.current;
    if (!cv || !result) return;
    const d = result.decision;
    const shown = result.tickers.map((t, i) => i).filter((i) => d.weightBase[i] > 0 || d.weight[i] > 0);
    if (shown.length === 0) return;
    const rowH = 26;
    const init = initCanvas(cv, shown.length * rowH + 34);
    if (!init) return;
    const { ctx, width, height } = init;
    const padL = 96;
    const padR = 54;
    const plotW = width - padL - padR;
    const wMax = Math.max(...shown.map((i) => Math.max(d.weightBase[i], d.weight[i]))) * 1.1;
    const X = (v: number) => padL + (v / wMax) * plotW;
    const eq = 1 / shown.length;

    ctx.font = "10px sans-serif";
    shown.forEach((i, k) => {
      const y = 20 + k * rowH;
      ctx.textAlign = "right";
      ctx.fillStyle = heldSet.has(result.tickers[i]) ? "#1d4ed8" : "#374151";
      ctx.font = heldSet.has(result.tickers[i]) ? "bold 10px sans-serif" : "10px sans-serif";
      ctx.fillText(label(result.tickers[i]), padL - 6, y + 13);
      ctx.font = "10px sans-serif";
      ctx.fillStyle = "#c7d2fe";
      ctx.fillRect(padL, y, X(d.weightBase[i]) - padL, 9);
      ctx.fillStyle = "#4f46e5";
      ctx.fillRect(padL, y + 10, X(d.weight[i]) - padL, 9);
      ctx.fillStyle = "#6b7280";
      ctx.textAlign = "left";
      ctx.fillText(pct(d.weightBase[i], 1), X(d.weightBase[i]) + 3, y + 8);
      ctx.fillStyle = "#4f46e5";
      ctx.fillText(pct(d.weight[i], 1), X(d.weight[i]) + 3, y + 18);
    });
    // 等加重の基準線
    ctx.strokeStyle = "#f59e0b";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(X(eq), 12);
    ctx.lineTo(X(eq), height - 14);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#b45309";
    ctx.textAlign = "center";
    ctx.fillText(`等加重 ${pct(eq, 1)}`, X(eq), height - 3);
    ctx.fillStyle = "#9ca3af";
    ctx.textAlign = "left";
    ctx.fillText("上=持続率で割り引かない（P1 と同じ式） / 下=二段収縮後", padL, 10);
  }, [result, heldSet, label]);

  // ── 決定: コスト曲線（costBps は描画時に反映）───────────
  const costRef = useRef<HTMLCanvasElement | null>(null);
  const costCurve = useMemo(() => {
    if (!result) return [];
    const c = costBps / 10000;
    return result.decision.costCurve.map((p) => {
      const cost = c * p.turnover * (252 / p.days);
      return { ...p, cost, total: p.staleness + cost };
    });
  }, [result, costBps]);
  const bestRebalance = useMemo(() => {
    if (costCurve.length === 0 || !result?.persistence.tau || result.decision.grossEdge <= 0) return null;
    return costCurve.reduce((a, b) => (b.total < a.total ? b : a));
  }, [costCurve, result]);

  useEffect(() => {
    const cv = costRef.current;
    if (!cv || costCurve.length === 0) return;
    const init = initCanvas(cv, 190);
    if (!init) return;
    const { ctx, width, height } = init;
    const padL = 46;
    const padR = 62;
    const padT = 12;
    const padB = 26;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const xMax = Math.max(...costCurve.map((p) => p.days));
    const yMax = Math.max(...costCurve.map((p) => p.total)) * 1.1 || 1;
    const X = (v: number) => padL + (v / xMax) * plotW;
    const Y = (v: number) => padT + plotH - (v / yMax) * plotH;

    ctx.font = "10px sans-serif";
    ctx.strokeStyle = "#e5e7eb";
    for (let k = 0; k <= 4; k++) {
      const v = (yMax * k) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, Y(v));
      ctx.lineTo(padL + plotW, Y(v));
      ctx.stroke();
      ctx.fillStyle = "#9ca3af";
      ctx.textAlign = "right";
      ctx.fillText(`${(v * 100).toFixed(2)}%`, padL - 5, Y(v) + 3);
    }
    const stack = makeLabelStack();
    const line = (get: (p: (typeof costCurve)[0]) => number, color: string, name: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      costCurve.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p.days), Y(get(p))) : ctx.lineTo(X(p.days), Y(get(p)))));
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.fillText(name, padL + plotW + 4, stack(Y(get(costCurve[costCurve.length - 1]))) + 3);
    };
    line((p) => p.staleness, "#dc2626", "陳腐化");
    line((p) => p.cost, "#0284c7", "コスト");
    line((p) => p.total, "#111827", "合計");
    if (bestRebalance) {
      ctx.fillStyle = "#111827";
      ctx.beginPath();
      ctx.arc(X(bestRebalance.days), Y(bestRebalance.total), 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#111827";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(X(bestRebalance.days), padT);
      ctx.lineTo(X(bestRebalance.days), padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = "center";
      ctx.fillText(`最小 ${bestRebalance.days}日`, X(bestRebalance.days), padT + 10);
    }
    for (let k = 0; k <= 4; k++) {
      const v = (xMax * k) / 4;
      ctx.fillStyle = "#9ca3af";
      ctx.textAlign = "center";
      ctx.fillText(`${Math.round(v)}日`, X(v), height - 8);
    }
    ctx.strokeStyle = "#d1d5db";
    ctx.strokeRect(padL, padT, plotW, plotH);
  }, [costCurve, bestRebalance]);

  // ── L2-D b⁺/b⁻ 対バー ─────────────────────────────────
  const asymRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = asymRef.current;
    if (!cv || !result) return;
    const rows = result.asymmetry.byTicker;
    if (rows.length === 0) return;
    const rowH = 26;
    const init = initCanvas(cv, rows.length * rowH + 34);
    if (!init) return;
    const { ctx, width, height } = init;
    const padL = 96;
    const padR = 74;
    const plotW = width - padL - padR;
    const bMax = Math.max(...rows.flatMap((r) => [r.bPlus, r.bMinus])) * 1.1 || 1;
    const X = (v: number) => padL + (Math.max(0, v) / bMax) * plotW;

    ctx.font = "10px sans-serif";
    rows.forEach((r, k) => {
      const y = 20 + k * rowH;
      const sig = r.deltaQ < 0.1;
      const bad = r.verdict === "暴落増幅" || r.verdict === "下げで強まる（要注意）";
      ctx.textAlign = "right";
      ctx.fillStyle = heldSet.has(r.ticker) ? "#1d4ed8" : "#374151";
      ctx.font = heldSet.has(r.ticker) ? "bold 10px sans-serif" : "10px sans-serif";
      ctx.fillText(label(r.ticker), padL - 6, y + 13);
      ctx.font = "10px sans-serif";
      ctx.fillStyle = sig ? "#059669" : "#a7f3d0";
      ctx.fillRect(padL, y, X(r.bPlus) - padL, 9);
      ctx.fillStyle = bad ? "#dc2626" : sig ? "#94a3b8" : "#e5e7eb";
      ctx.fillRect(padL, y + 10, X(r.bMinus) - padL, 9);
      ctx.textAlign = "left";
      ctx.fillStyle = "#6b7280";
      ctx.fillText(`${r.bPlus.toFixed(2)} / ${r.bMinus.toFixed(2)}`, padL + plotW + 4, y + 12);
    });
    ctx.fillStyle = "#9ca3af";
    ctx.textAlign = "left";
    ctx.fillText("上=b⁺（セクター上昇日） / 下=b⁻（下落日）。赤=下げで強まる", padL, 10);
    ctx.strokeStyle = "#d1d5db";
    ctx.beginPath();
    ctx.moveTo(padL, 14);
    ctx.lineTo(padL, height - 8);
    ctx.stroke();
  }, [result, heldSet, label]);

  // ── L2-C supWald 経路 ────────────────────────────────
  const breakRow = useMemo(() => {
    if (!breaks) return null;
    if (breakTicker) {
      const r = breaks.byTicker.find((x) => x.ticker === breakTicker);
      if (r) return r;
      if (breaks.common?.ticker === breakTicker) return breaks.common;
    }
    return [...breaks.byTicker].sort((a, b) => a.bootP - b.bootP)[0] ?? null;
  }, [breaks, breakTicker]);

  const pathRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = pathRef.current;
    if (!cv || !breakRow) return;
    const init = initCanvas(cv, 170);
    if (!init) return;
    const { ctx, width, height } = init;
    const padL = 40;
    const padR = 16;
    const padT = 14;
    const padB = 24;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const p = breakRow.path;
    const yMax = Math.max(breakRow.crit95, ...p.map((x) => x.w)) * 1.1 || 1;
    const X = (i: number) => padL + (i / Math.max(1, p.length - 1)) * plotW;
    const Y = (v: number) => padT + plotH - (v / yMax) * plotH;

    ctx.font = "10px sans-serif";
    ctx.strokeStyle = "#e5e7eb";
    for (let k = 0; k <= 4; k++) {
      const v = (yMax * k) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, Y(v));
      ctx.lineTo(padL + plotW, Y(v));
      ctx.stroke();
      ctx.fillStyle = "#9ca3af";
      ctx.textAlign = "right";
      ctx.fillText(v.toFixed(0), padL - 5, Y(v) + 3);
    }
    ctx.strokeStyle = "#4f46e5";
    ctx.lineWidth = 2;
    ctx.beginPath();
    p.forEach((x, i) => (i === 0 ? ctx.moveTo(X(i), Y(x.w)) : ctx.lineTo(X(i), Y(x.w))));
    ctx.stroke();
    ctx.lineWidth = 1;
    // ブート臨界値
    ctx.strokeStyle = "#dc2626";
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, Y(breakRow.crit95));
    ctx.lineTo(padL + plotW, Y(breakRow.crit95));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#dc2626";
    ctx.textAlign = "left";
    ctx.fillText(`ブート臨界値95% = ${breakRow.crit95.toFixed(0)}`, padL + 4, Y(breakRow.crit95) - 4);
    // 最大点
    const best = p.reduce((a, b, i) => (b.w > p[a].w ? i : a), 0);
    ctx.fillStyle = "#111827";
    ctx.beginPath();
    ctx.arc(X(best), Y(p[best].w), 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = X(best) > padL + plotW / 2 ? "right" : "left";
    ctx.fillText(`${p[best].date}  W=${p[best].w.toFixed(0)}`, X(best) + (X(best) > padL + plotW / 2 ? -6 : 6), Y(p[best].w) - 6);
    // 日付軸
    for (const k of [0, Math.floor(p.length / 2), p.length - 1]) {
      ctx.fillStyle = "#9ca3af";
      ctx.textAlign = k === 0 ? "left" : k === p.length - 1 ? "right" : "center";
      ctx.fillText(p[k].date, X(k), height - 8);
    }
    ctx.strokeStyle = "#d1d5db";
    ctx.strokeRect(padL, padT, plotW, plotH);
  }, [breakRow]);

  if (!result) {
    return computing ? (
      <div className="rounded border border-gray-200 px-3 py-4 text-xs text-gray-500">持続性を検証中…</div>
    ) : null;
  }

  const p = result.persistence;
  const d = result.decision;
  const useW = twoStage ? d.weight : d.weightBase;
  const sigBreaks = breaks?.byTicker.filter((r) => r.q < 0.1) ?? [];

  return (
    <div className="space-y-3 rounded border border-indigo-200 bg-indigo-50/20 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] font-bold text-white">P2</span>
        <span className="font-medium text-gray-700">この順位は来年も同じか ─ 持続性・順位安定性・構造変化・非対称性</span>
      </div>

      {/* ── 操作 ─────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-gray-500">全体窓</span>
        <div className="inline-flex overflow-hidden rounded border border-gray-300">
          {[1250, 2400].map((w) => (
            <button
              key={w}
              onClick={() => setControls({ ...controls, window: w })}
              className={`px-2 py-0.5 ${controls.window === w ? "bg-indigo-600 text-white" : "bg-white text-gray-600"}`}
            >
              {(w / 250).toFixed(0)}年
            </button>
          ))}
        </div>
        <span className="ml-1 text-gray-500">ローリング窓</span>
        <div className="inline-flex overflow-hidden rounded border border-gray-300">
          {[125, 250, 500].map((w) => (
            <button
              key={w}
              onClick={() => setControls({ ...controls, rollWindow: w })}
              className={`px-2 py-0.5 ${controls.rollWindow === w ? "bg-indigo-600 text-white" : "bg-white text-gray-600"}`}
            >
              {w}日
            </button>
          ))}
        </div>
        <span className="ml-1 text-gray-500">刻み</span>
        <div className="inline-flex overflow-hidden rounded border border-gray-300">
          {[5, 21].map((w) => (
            <button
              key={w}
              onClick={() => setControls({ ...controls, rollStep: w })}
              className={`px-2 py-0.5 ${controls.rollStep === w ? "bg-indigo-600 text-white" : "bg-white text-gray-600"}`}
            >
              {w}日
            </button>
          ))}
        </div>
        <label className="ml-1 flex items-center gap-1">
          <input type="checkbox" checked={twoStage} onChange={(e) => setTwoStage(e.target.checked)} />
          <span className="text-gray-600">二段収縮</span>
        </label>
        <span className="ml-1 text-gray-500">コスト</span>
        <select
          value={costBps}
          onChange={(e) => setCostBps(Number(e.target.value))}
          className="rounded border border-gray-300 px-1 py-0.5"
        >
          {[5, 10, 20].map((c) => (
            <option key={c} value={c}>
              {c}bp
            </option>
          ))}
        </select>
        <span className="ml-1 text-gray-500">λ</span>
        <select
          value={lambda}
          onChange={(e) => setLambda(Number(e.target.value))}
          className="rounded border border-gray-300 px-1 py-0.5"
        >
          {[0, 0.5, 1, 2].map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        {computing && <span className="text-gray-500">再計算中…</span>}
      </div>

      {/* ── L2-A 減衰曲線 ───────────────────────────── */}
      <div>
        <div className="mb-1 text-[11px] font-medium text-gray-700">
          L2-A 持続率の減衰 π(h) ─ 今日の b の散らばりのうち h 日後まで残る割合
        </div>
        <canvas ref={decayRef} />
        <div className="mt-1 text-[10px] leading-relaxed text-gray-500">
          π = <span className="font-mono">Cov_i(b̂_t, b̂_&#123;t+h&#125;) / [Var_i(b̂) − mean_i(SE²)]</span>。
          窓が重ならなければ推定誤差は共分散から自動的に消えるので、e をモデル化せずに η だけを取り出せる。
          分母から <span className="font-mono">mean(SE²)</span> を引くのは、引かないと減衰バイアスで π が過小に出るため。
          薄い点（φ&gt;0）は2つの窓が標本を共有しており、重複ぶん <span className="font-mono">φ·mean(SE²)</span> を分子から差し引いてある。
          <b> 赤破線（ヌル）は銘柄ラベルを毎時点シャッフルして作った「持続性ゼロ」の分布の95%点</b>で、
          CI がこれを跨ぐなら測れていない。
        </div>
      </div>

      {/* ── L2-A の要約 ───────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MiniStat
          label={`π(${p.decisionH}日)`}
          value={p.piPoint.toFixed(2)}
          sub={`CI [${p.piLo.toFixed(2)}, ${p.piHi.toFixed(2)}]`}
          tone={p.indistinguishableFromNull ? "bad" : p.piLo > 0.5 ? "good" : "warn"}
        />
        <MiniStat
          label="半減期"
          value={p.halfLife !== null ? `${Math.round(p.halfLife)}日` : "—"}
          sub={p.tau !== null ? `τ=${Math.round(p.tau)}日` : "減衰が見えない"}
        />
        <MiniStat
          label="採用した π"
          value={p.piForDecision.toFixed(2)}
          sub="CI下限（誤差割引・C16）"
          tone={p.piForDecision > 0.5 ? "good" : "warn"}
        />
        <MiniStat
          label="実効ペア数"
          value={(p.curve.find((c) => c.h === p.decisionH)?.nEffPairs ?? 0).toFixed(1)}
          sub={`名目 ${p.curve.find((c) => c.h === p.decisionH)?.nPairs ?? 0} 組`}
        />
      </div>

      {/* ── 決定: ウェイト比較 ───────────────────────── */}
      <div>
        <div className="mb-1 text-[11px] font-medium text-gray-700">
          P1 → P2 のウェイト変化（二段収縮 b_forecast = b̄ + π·(b_JS − b̄)）
        </div>
        <canvas ref={weightRef} />
        <div className="mt-1 text-[10px] leading-relaxed text-gray-500">
          <b>二段になっている理由</b>: James-Stein は「測り間違い（e）」を直し、π は「本当に変わってしまう分（η）」を割り引く。
          別の量なので片方だけでは足りない。π=0 のとき b_forecast は全銘柄 b̄ になり、
          w ∝ 1/σ_ε²（＝実質リスクパリティ＝選別しない）へ自動的に退避する。
          今回の移動量は総変動で <b>{pct(d.tiltReduction, 1)}</b>（JS収縮率 {pct(d.shrinkFactor, 1)} / 採用 π {p.piForDecision.toFixed(2)}）。
        </div>
      </div>

      {/* ── L2-B ローリング b(t) ────────────────────── */}
      <div>
        <div className="mb-1 text-[11px] font-medium text-gray-700">
          L2-B ローリング b(t)（窓 {result.params.rollWindow}日・刻み {result.params.rollStep}日）
        </div>
        <div ref={rollRef} />
        <div className="mt-1 text-[10px] leading-relaxed text-gray-500">
          色つきが現時点の上位{result.params.topK}本、太線は保有銘柄。灰色の▽は日銀の政策変更日（
          <b>検定には使っていない・ラベルのみ</b>。後知恵で日付を選ぶと必ず有意になるため）。
          赤の△は L2-C がデータから見つけた分割点。横軸ズームで局面ごとの動きを確認できる。
        </div>
      </div>

      {/* ── L2-B 生存率と遷移 ──────────────────────── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] font-medium text-gray-700">L2-B 上位{result.params.topK}本の生存率と順位相関</div>
          <canvas ref={survRef} />
          <div className="mt-1 text-[10px] leading-relaxed text-gray-500">
            <b>生存率が最も実務的</b>: 「今日の上位{result.params.topK}本のうち h 日後も上位に残る本数」がそのまま入替本数になる。
            完全ランダムでも k/N = {pct(result.rankStability.byHorizon[0]?.survivalNull ?? 0, 0)} は残るので、
            <b className="text-red-700">この赤線が「安定」のゼロ点</b>。順位は S = b/σ_ε で測る（選別に使うのが S だから）。
            橙は実際に生じる片道回転率（右軸は共通の 0〜100%、回転は 2 で割って表示）。
          </div>
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium text-gray-700">
            L2-B 分位遷移行列（h={result.rankStability.transitionH}日・{result.rankStability.quantiles}分位）
          </div>
          <canvas ref={transRef} />
          <div className="mt-1 text-[10px] leading-relaxed text-gray-500">
            対角が濃いほど順位が動かない。<b>両端（最上位・最下位）が濃く中間が薄いのが典型</b>で、
            それは「構造的に違う銘柄は動かないが、似た銘柄同士の順位は入れ替わる」ことを意味する。
            上位{result.params.topK}本の選別が両端の差だけで決まっているなら、実際の選別力は生存率の見た目より弱い。
          </div>
        </div>
      </div>

      {/* ── 決定: リバランス間隔 ────────────────────── */}
      <div>
        <div className="mb-1 text-[11px] font-medium text-gray-700">リバランス間隔 ─ 陳腐化とコストの交換</div>
        <canvas ref={costRef} />
        <div className="mt-1 text-[10px] leading-relaxed text-gray-500">
          {bestRebalance ? (
            <>
              <b className="text-gray-800">
                半減期 {p.halfLife !== null ? Math.round(p.halfLife) : "—"}日 なので、リバランスは
                約{Math.max(1, Math.round(bestRebalance.days / 21))}ヶ月ごと（{bestRebalance.days}営業日）が最適。
                それより速く回してもコスト負けする。
              </b>{" "}
            </>
          ) : (
            <b className="text-gray-800">減衰が観測範囲で見えないため最適間隔は決まらない（＝コストが低いほうへ寄せる＝回さない）。 </b>
          )}
          陳腐化は「保持期間中に平均で取り逃がすチルトの粗利」で、露出保持率の平均 (τ/Δt)(1−e^&#123;−Δt/τ&#125;) から出す。
          粗利は <span className="font-mono">m·(Σw_i b_i − b̄)</span> ＝ 年 {pct(d.grossEdge, 2)} で、
          <b className="text-amber-700"> m（セクターの年率期待リターン）は推定値ではなく {pct(result.params.assumedFactorReturn, 0)} と置いた仮定</b>。
          m を半分にすれば最適間隔は伸びる。コストは実測した回転率 ×{costBps}bp。
        </div>
      </div>

      {/* ── L2-D 非対称性 ─────────────────────────── */}
      <div>
        <div className="mb-1 text-[11px] font-medium text-gray-700">
          L2-D その b は「金利が上がる日」に出るのか「市場が落ちる日」に出るのか
        </div>
        <canvas ref={asymRef} />
        <div className="overflow-x-auto">
          <table className="mt-2 w-full min-w-[720px] border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-gray-300 text-gray-500">
                <th className="px-1.5 py-1 text-left">銘柄</th>
                <th className="px-1.5 py-1 text-right">b⁺ / b⁻</th>
                <th className="px-1.5 py-1 text-right">δ の t</th>
                <th className="px-1.5 py-1 text-right">q</th>
                <th className="px-1.5 py-1 text-right">市場上げ / 下げ</th>
                <th className="px-1.5 py-1 text-right">金利上げ / 下げ</th>
                <th className="px-1.5 py-1 text-right">S</th>
                <th className="px-1.5 py-1 text-right">S&apos;（λ={lambda}）</th>
                <th className="px-1.5 py-1 text-left">判定</th>
              </tr>
            </thead>
            <tbody>
              {[...result.asymmetry.byTicker]
                .map((r) => ({
                  ...r,
                  sAdj:
                    r.sigmaEps > 0 ? (r.bPlus - lambda * Math.max(0, r.bMinus - r.bPlus)) / r.sigmaEps : 0,
                }))
                .sort((a, b) => b.sAdj - a.sAdj)
                .map((r) => (
                  <tr key={r.ticker} className="border-b border-gray-100">
                    <td className="px-1.5 py-1">
                      <span className={heldSet.has(r.ticker) ? "font-bold text-blue-700" : "text-gray-800"}>
                        {label(r.ticker)}
                      </span>
                    </td>
                    <td className="px-1.5 py-1 text-right font-mono">
                      {r.bPlus.toFixed(2)} / {r.bMinus.toFixed(2)}
                    </td>
                    <td className="px-1.5 py-1 text-right font-mono text-gray-600">{r.deltaT.toFixed(1)}</td>
                    <td className={`px-1.5 py-1 text-right font-mono ${r.deltaQ < 0.1 ? "font-bold text-gray-800" : "text-gray-400"}`}>
                      {r.deltaQ.toFixed(3)}
                    </td>
                    <td className="px-1.5 py-1 text-right font-mono text-gray-600">
                      {r.bMktUp.toFixed(2)} /{" "}
                      <span className={r.mktDeltaQ < 0.1 && r.bMktDown > r.bMktUp ? "font-bold text-red-700" : ""}>
                        {r.bMktDown.toFixed(2)}
                      </span>
                    </td>
                    <td className="px-1.5 py-1 text-right font-mono text-gray-600">
                      {Number.isFinite(r.bRateUp) ? `${r.bRateUp.toFixed(2)} / ${r.bRateDown.toFixed(2)}` : "—"}
                    </td>
                    <td className="px-1.5 py-1 text-right font-mono text-gray-600">{r.score.toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-right font-mono font-bold text-indigo-700">{r.sAdj.toFixed(2)}</td>
                    <td
                      className={`px-1.5 py-1 text-[10px] ${
                        r.verdict === "暴落増幅"
                          ? "font-bold text-red-700"
                          : r.verdict === "下げで強まる（要注意）"
                            ? "text-amber-700"
                            : r.verdict === "理想形"
                              ? "text-green-700"
                              : "text-gray-400"
                      }`}
                    >
                      {r.verdict}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className="mt-1 text-[10px] leading-relaxed text-gray-500">
          推定は部分標本に切らず<b>交互作用ダミー1本の回帰</b>で行う（切ると各群の SE が膨らみ、条件付けバイアスも入る）:
          <span className="font-mono"> r = α + γD + cM + bF + δ(F·D)</span> で b|D=0 と b|D=0+δ を同時に出す。
          δ の検定は銘柄横断で BH-FDR 補正。<b className="text-red-700">「暴落増幅」＝市場下落日にセクター露出が有意に増える</b>銘柄で、
          分散のつもりが暴落時に集中する（C11 と衝突）。
          S&apos; は下げで強まるぶんにペナルティを掛けた順位で、λ=0 にすれば P1 と同じ並びに戻る。
        </div>
      </div>

      {/* ── L2-C 構造変化 ─────────────────────────── */}
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] font-medium text-gray-700">
          <span>L2-C 構造変化 ─ 「長い窓ほど良い」を疑う</span>
          {breakProgress && (
            <span className="font-normal text-gray-500">
              検証中… {breakProgress.done}/{breakProgress.total}
            </span>
          )}
          {breakError && <span className="font-normal text-red-600">Worker エラー: {breakError}</span>}
        </div>
        {!breaks ? (
          <div className="rounded border border-gray-200 px-3 py-3 text-[11px] text-gray-500">
            分割点をデータに探させ、その選抜バイアスをブロック・ブートで補正した臨界値を作っている（重いので別スレッド）。
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1 text-[10px]">
              <span className="text-gray-500">経路を見る銘柄</span>
              {[...(breaks.common ? [breaks.common] : []), ...breaks.byTicker].map((r) => (
                <button
                  key={r.ticker}
                  onClick={() => setBreakTicker(r.ticker)}
                  className={`rounded border px-1.5 py-0.5 ${
                    breakRow?.ticker === r.ticker
                      ? "border-indigo-600 bg-indigo-600 text-white"
                      : r.q < 0.1
                        ? "border-amber-300 bg-amber-50 text-amber-800"
                        : "border-gray-300 bg-white text-gray-500"
                  }`}
                >
                  {r.ticker.startsWith("＊") ? r.ticker : label(r.ticker)}
                </button>
              ))}
            </div>
            <canvas ref={pathRef} className="mt-1" />
            {breakRow && (
              <div className="mt-1 text-[10px] text-gray-500">
                {breakRow.ticker.startsWith("＊") ? "共通成分" : label(breakRow.ticker)} の W(s) 経路。
                分割点 <b>{breakRow.breakDate ?? "—"}</b> で b が{" "}
                <b>
                  {breakRow.bBefore.toFixed(2)} → {breakRow.bAfter.toFixed(2)}
                </b>
                （ブート p = {breakRow.bootP.toFixed(3)} / BH後 q = {breakRow.q.toFixed(3)}）。
              </div>
            )}

            {breaks.common && (
              <div
                className={`mt-2 rounded border px-2.5 py-2 text-[11px] ${
                  breaks.common.bootP < 0.1 ? "border-amber-300 bg-amber-50 text-amber-900" : "border-gray-200 bg-gray-50 text-gray-600"
                }`}
              >
                <b>共通成分の検定</b>（等加重バスケット）: supW = {breaks.common.supW.toFixed(0)} / p ={" "}
                {breaks.common.bootP.toFixed(3)} / 分割点 {breaks.common.breakDate ?? "—"} で b{" "}
                {breaks.common.bBefore.toFixed(2)} → {breaks.common.bAfter.toFixed(2)}。
                <br />
                これが無いと解釈を誤る。個別銘柄で分割点が続々見つかっても、それが<b>全銘柄に共通の水準変化</b>なら
                順位は動いておらず、選別（＝相対の話）は壊れていない。壊れるのは「b の絶対値」を使う建玉サイズのほう。
                {p.piPoint > 0.7 && breaks.common.bootP < 0.1 && (
                  <>
                    {" "}
                    <b>今回がまさにその形</b>: π({p.decisionH}日)={p.piPoint.toFixed(2)} と高いのに構造変化が有意 ──
                    <b>「順位は不変・水準は共通して上昇」</b>と読む。
                  </>
                )}
              </div>
            )}

            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[620px] border-collapse text-[11px]">
                <thead>
                  <tr className="border-b border-gray-300 text-gray-500">
                    <th className="px-1.5 py-1 text-left">銘柄</th>
                    <th className="px-1.5 py-1 text-right">supW</th>
                    <th className="px-1.5 py-1 text-right">ブート臨界値95%</th>
                    <th className="px-1.5 py-1 text-right">p</th>
                    <th className="px-1.5 py-1 text-right">q(BH)</th>
                    <th className="px-1.5 py-1 text-center">分割点</th>
                    <th className="px-1.5 py-1 text-right">b 前 → 後</th>
                  </tr>
                </thead>
                <tbody>
                  {[...breaks.byTicker]
                    .sort((a, b) => a.q - b.q)
                    .map((r) => (
                      <tr key={r.ticker} className={`border-b border-gray-100 ${r.q < 0.1 ? "bg-amber-50/50" : ""}`}>
                        <td className="px-1.5 py-1">
                          <span className={heldSet.has(r.ticker) ? "font-bold text-blue-700" : "text-gray-800"}>
                            {label(r.ticker)}
                          </span>
                        </td>
                        <td className="px-1.5 py-1 text-right font-mono">{r.supW.toFixed(0)}</td>
                        <td className="px-1.5 py-1 text-right font-mono text-gray-500">{r.crit95.toFixed(0)}</td>
                        <td className="px-1.5 py-1 text-right font-mono text-gray-600">{r.bootP.toFixed(3)}</td>
                        <td className={`px-1.5 py-1 text-right font-mono ${r.q < 0.1 ? "font-bold text-amber-800" : "text-gray-400"}`}>
                          {r.q.toFixed(3)}
                        </td>
                        <td className="px-1.5 py-1 text-center font-mono text-gray-600">{r.breakDate ?? "—"}</td>
                        <td className="px-1.5 py-1 text-right font-mono">
                          {r.bBefore.toFixed(2)} → {r.bAfter.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            {breaks.consensusBreaks.length > 0 && (
              <div className="mt-2 rounded bg-gray-50 px-2 py-1.5 text-[10px] leading-relaxed text-gray-600">
                <b>分割点の票（q&lt;0.1 の銘柄のみ）</b>:{" "}
                {breaks.consensusBreaks.slice(0, 4).map((c) => (
                  <span key={c.date} className="mr-2 font-mono">
                    {c.date} <b>{c.votes}票</b>
                    {c.nearestEvent ? `（${c.nearestEvent}）` : c.gapDays !== null ? "（近い政策日なし）" : ""}
                  </span>
                ))}
                <br />
                政策日は<b>ラベルとしてだけ</b>使う。データに分割点を探させ、政策日は「見つかった点が経済的に説明できるか」の
                事後確認に回す（後知恵で日付を選ぶと必ず有意になるため）。
                {breaks.recommendWindowFrom && (
                  <>
                    {" "}
                    <b className="text-amber-800">
                      票が {breaks.recommendWindowFrom} に集中している。b の水準を建玉サイズに使うなら、
                      推定窓をこの日以降に切り替えることを検討する（本数は減るが正しい）。
                    </b>
                  </>
                )}
              </div>
            )}
          </>
        )}
        {breaks && sigBreaks.length === 0 && (
          <div className="mt-1 text-[10px] text-gray-500">
            BH-FDR 後に有意な銘柄は無い＝長い窓を使ってよい（分散が減るぶん有利）。ただし検出力は高くないので
            「変化が無い」の証明ではない。
          </div>
        )}
      </div>

      {/* ── 銘柄別トラストと警告 ────────────────────── */}
      <div className="rounded border border-gray-200 bg-white px-3 py-2">
        <div className="mb-1 text-[11px] font-medium text-gray-700">銘柄ごとの b の安定度</div>
        <div className="flex flex-wrap gap-1.5">
          {result.tickers.map((t, i) => (
            <span
              key={t}
              title={`安定度 ${d.trust[i].toFixed(2)} / 推奨w ${pct(useW[i], 1)}`}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                d.trust[i] > 0.2
                  ? "border-green-300 bg-green-50 text-green-800"
                  : d.trust[i] > -0.5
                    ? "border-gray-300 bg-gray-50 text-gray-600"
                    : "border-red-300 bg-red-50 text-red-700"
              } ${heldSet.has(t) ? "ring-1 ring-blue-300" : ""}`}
            >
              {label(t)} <span className="font-mono">{d.trust[i].toFixed(2)}</span>
            </span>
          ))}
        </div>
        <div className="mt-1 text-[10px] leading-relaxed text-gray-500">
          安定度 = <span className="font-mono">1 − sd_t(b̂ − b̄_t) / mean_t(SE)</span>。
          時系列の変動が推定誤差だけで説明できるなら 0 以上（＝b は動いていない）、大きく負なら本当に動いている。
          <b>横断平均 b̄_t を抜いてから測る</b>のが要点で、抜かないと「全銘柄の b が揃って上がった」だけで全員が不安定と出る
          （共通の水準変化は順位を一切動かさないので、選別には無害）。
        </div>
      </div>

      {result.warnings.length > 0 && (
        <ul className="list-disc space-y-1 rounded border border-gray-200 bg-white px-4 py-2 text-[11px] text-gray-600">
          {result.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
          {breaks?.warnings.map((w, i) => (
            <li key={`b${i}`}>{w}</li>
          ))}
        </ul>
      )}

      <AnalysisGuide title="持続性検証（P2）の詳細理論 ─ 誤差が小さいことと使えることは別">
        <p className="font-medium text-gray-700">1. なぜこの層が要るのか</p>
        <p>
          P1 が示したのは「<b>今の b を測れる</b>」ということだけでした（b の上下差の t は 8〜13、
          James-Stein 収縮率は 5% 未満）。にもかかわらず、その順位表を発注に使ってよいかは
          <b>まだ何も分かっていません</b>。P1 が測ったのは「過去数年の平均的な b」であって、
          「明日から先の b」ではないからです。両者が同じである保証はどこにもありません。
        </p>
        <p>
          b が動く原因は統計の問題ではなく<b>実在の経済的変化</b>です ── 有価証券デュレーションの短縮、
          貸出構成の入れ替え、金融政策レジームの転換（マイナス金利期と解除後で b の水準どころか符号も
          変わりうる）、資本政策・再編。<b>誤差が小さいことは「使える」を意味せず、使えるかどうかは持続性が決めます。</b>
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式 ─ b̂ を3つに割る</p>
        <p className="font-mono text-[11px] bg-white/70 rounded px-2 py-1">
          {"b̂_{i,t} = β_i + η_{i,t} + e_{i,t}"}
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>β_i（恒久成分）</b>: 銘柄の構造。来期も残る。<b>選別に使えるのはここだけ</b></li>
          <li><b>η_i,t（一時成分）</b>: 実在するが来期には消える変動。<b>実在するが使えない</b></li>
          <li><b>e_i,t（推定誤差）</b>: 標本のノイズ。SE(b̂) で既知で、P1 の James-Stein が潰した</li>
        </ul>
        <p>
          P1 の収縮は e だけを潰しました。<b>η は手つかずのまま残っています。</b>
          「収縮率 4.6%」は「b̂ の散らばりの95%は実在する」と言っただけで、
          <b>そのうち来期も残るのが何割かは何も言っていません</b>。ここが P1 と P2 の境界です。
        </p>
        <p>推定量は「窓をずらした横断（銘柄方向）の共分散」です。</p>
        <p className="font-mono text-[11px] bg-white/70 rounded px-2 py-1">
          {"Cov_i( b̂_{i,t}, b̂_{i,t+h} ) = Var(β) + Cov(η_t, η_{t+h})"}
        </p>
        <p>
          推定誤差 e は窓が重ならなければ独立なので、<b>共分散からは自動的に消えます</b>。
          これが本手法の要で、e を別途モデル化しなくてよい理由です。持続率は
        </p>
        <p className="font-mono text-[11px] bg-white/70 rounded px-2 py-1">
          {"π(h) = Cov_i( b̂_t, b̂_{t+h} ) / [ Var_i(b̂) − mean_i(SE_i²) ]"}
        </p>
        <p>
          分母は<b>推定誤差を除いた真の散らばり</b>でなければなりません（除かないと減衰バイアスで過小評価）。
          h が窓長より短いときは2つの窓が標本を共有するので、共有割合 φ に対し
          {" "}<span className="font-mono">{"φ·mean(SE²)"}</span>{" "}を分子から差し引いて補正しています。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>π = 1</b>: b は完全に恒久的。P1 の順位をそのまま使ってよい</li>
          <li><b>π = 0.5</b>: 半分は消える。<b>チルトを半分に薄めるべき</b></li>
          <li><b>π = 0</b>: 今日の b の散らばりは来期と無関係。<b>等加重にせよ</b></li>
          <li><b>π &lt; 0</b>: 平均回帰。順位を反転させる余地すらある（が、まず疑うべきはデータ）</li>
          <li>
            <b>CI がヌルを跨ぐ</b>: 「持続性は測れていない」が結論であり、<b>測れていないなら等加重に寄せる</b>（C16 の誤差割引）
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 検出力の壁（この層で最も誤読しやすい点）</p>
        <p>
          N 銘柄の横断相関なので、<b>1組の窓ペアから得られる π の標準誤差は約 1/√(N−3)</b>。
          N=16 なら 0.28 で、単発の推定では π=0.3 と π=0.8 を区別できません。これは実装前に分かる制約です。
          そこで (a) 窓ペアを多数使い、(b) ペア単位のブロック・ブートで CI を出し（重なりを正直に反映）、
          (c) h を複数取って減衰曲線として見て、(d) 銘柄ラベルの横断シャッフルでヌルを併記しています。
        </p>
        <p>
          <b>実効ペア数</b>は名目のペア数より遥かに小さくなります。1ペアが覆う時間は
          「窓長 + h」なので、それより近いペア同士は独立ではありません。画面の「実効ペア数」がその値です。
          <b>π の CI が [0, 0.9] のように広く出ることは十分あり得て、そのときの誠実な結論は
          「持続性は測れていない」です。</b>
        </p>

        <p className="font-medium text-gray-700 mt-3">5. π がそのまま建玉の強さになる（この層の存在意義）</p>
        <p>
          P1 は <span className="font-mono">w ∝ b/σ_ε²</span> を出しましたが、その b は<b>今の b</b> であって
          <b>来期の b</b> ではありません。来期の b の最良予測は、持続率で平均に縮めた値になります。
        </p>
        <p className="font-mono text-[11px] bg-white/70 rounded px-2 py-1">
          {"b_forecast,i = b̄ + π(h)·( b_JS,i − b̄ )    →    w_i ∝ b_forecast,i / σ_ε,i²"}
        </p>
        <p>
          <b>二段になっている理由</b>: James-Stein は「測り間違い」を直します。π は「本当に変わってしまう」ぶんを
          織り込みます。両者は別の量で、片方だけでは足りません。
          <b>π = 0 のとき自動的に「等加重に近い形」へ退避する</b>のがこの式の良いところで、
          「持続性が無いなら選別するな」という結論が、別ルールでなく同じ式から出ます。
        </p>

        <p className="font-medium text-gray-700 mt-3">6. 直感的な例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>β / η / e は「実力・調子・測定のブレ」</b>。James-Stein が直すのは<b>測定のブレだけ</b>で、
            調子の波は何度測り直しても消えません。今日の打率が高い打者を選ぶとき、
            「測定誤差が小さい」ことと「来季も打つ」ことは別の話です
          </li>
          <li>
            <b>半減期は「地図の賞味期限」</b>。τ より速く回すのはコストの浪費、τ より長く放置するのは
            古い地図で運転すること
          </li>
          <li>
            <b>共通の水準変化と順位の変化は別物</b>。全員の身長が伸びても背の順は変わりません。
            L2-C が構造変化を検出しても π が高いなら、それは「全員伸びた」であって「順番が変わった」ではありません
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>π がチルトの強さを決める</b>。π=0.5 なら P1 の推奨から等加重方向へ半分戻す</li>
          <li><b>上位k本の生存率が入替本数</b>。年間の回転コストの見積りはここから直接出る</li>
          <li><b>半減期がリバランス間隔を決める唯一の物理量</b>。それより速く回すのは手数料の寄付</li>
          <li>
            <b>「暴落増幅」判定の銘柄は建玉を縮める</b>。同じ S でも、下げでだけ効く b は
            セクターのプットを売っているのと同じで、実効的な期待値が低い
          </li>
          <li>
            <b>構造変化が「共通」なら選別は無傷</b>。ただし b の絶対値を建玉サイズに使っているなら、
            推定窓を分割点以降に切り替える
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">8. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>π が高いことは「儲かる」を意味しない</b>。順位が持続することと、その順位に賭けて床（等加重）に
            勝てることは別です。後者は P3 のウォークフォワード検証の仕事で、まだ済んでいません
          </li>
          <li>
            <b>π は横断の散らばりの持続を測る</b>ので、その散らばりが「構造的に違う少数の銘柄」で
            作られている場合、見かけより選別力は弱くなります。遷移行列の中間分位が薄いかどうかで確認してください
          </li>
          <li>
            <b>supWald の検出力は高くない</b>。分割点を探索したぶんの選抜バイアスをブロック・ブートで
            補正しているため臨界値が高く、「有意でない＝変化が無い」ではありません
          </li>
          <li>
            <b>政策日は検定に使っていません</b>。後知恵で日付を選ぶと必ず有意になるため、
            データに分割点を探させ、政策日は事後の説明にだけ使います
          </li>
          <li>
            <b>リバランス間隔は m（セクターの期待リターン）の仮定に依存します</b>。
            m は測れない量なので、これは推定ではなく感応度分析として読んでください
          </li>
          <li>
            <b>生存者バイアスは P1 と同じだけ残ります</b>。消えた地銀は標本に居ないので、
            実際の順位の持続性は本分析より悪くなる方向に歪みます
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">公理的位置づけ（株式原論）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>立脚する公準/命題</b>: 公準3（非先読み）＋命題4（情報の価値）＋公理5／C29 の後段・C16（誤差割引）・C17（レジーム切替）
          </li>
          <li>
            <b>測る P の性質</b>: ファクター感応度 b の<b>時間的持続性</b> π(h) と構造変化点
          </li>
          <li>
            <b>変える q の選択</b>: チルトの強さ（w の平均への収縮量）・リバランス間隔・推定窓
          </li>
          <li>
            <b>摩擦の扱い</b>: 半減期 τ とコスト c の交換で最適間隔が決まる。τ が短いほど選別は割に合わない
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function MiniStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "bad" | "warn";
}) {
  const c =
    tone === "good" ? "text-green-700" : tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "text-gray-800";
  return (
    <div className="rounded border border-gray-200 bg-white px-2.5 py-1.5">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-sm font-bold font-mono ${c}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400 leading-tight">{sub}</div>}
    </div>
  );
}
