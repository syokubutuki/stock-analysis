"use client";

import { DirectionGlyph, directionClass } from "./DirectionValue";

// 曜日ビン別 TP/SL ─ バリア設計の何が測れて何が測れないか（系C28）
//
// 4層。上から順に「確実に正しいこと」→「測れること」→「発見の余地」→「ヌルとの照合」。
//   層0 設計盤   … 推定ゼロの閉形式。暦時間シャープは A,B に不変であることを見せる
//   層1 σ正規化  … %では曜日でばらつく best が σ単位では一点に集まるか（分散比F）
//   層2 逸脱     … 到達確率・期待滞在・オーバーシュートの理論値からのずれを曜日間で検定
//   層3 ヌル較正 … 曜日ラベル破壊サロゲート／一致ブラウン運動／インターリーブ2分割OOS
//
// 計算は lib/weekday-barrier.ts（重いので weekday-barrier.worker.ts で実行）。
// 同足内でTP/SLどちらが先かは足からは分からないため、悲観(SL優先)・楽観(TP優先)の
// 両方を必ず走らせ、帯として表示する。帯が結論を反転させるなら「判定不能」と明記する。

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { useIntraday } from "../../hooks/useIntraday";
import {
  BarrierParams, BarrierResult, BarrierMode, TieBreak, DeviationRow, GridCell,
  WeekdayLayer1, designBoard, WD_ORDER, WD_LABELS, WD_COLORS,
} from "../../lib/weekday-barrier";
import type { BarrierWorkerRequest, BarrierWorkerResponse } from "../../lib/weekday-barrier.worker";
import { initCanvas, fmtPct, fmtSignedPct, ViewTabs } from "./intradayShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";
import { CHART_COLORS } from "../../lib/chart-colors";

interface Props { prices: PricePoint[]; ticker: string; }

type View = "board" | "sigma" | "deviation" | "null";
const VIEWS: { value: View; label: string }[] = [
  { value: "board", label: "層0 設計盤（推定ゼロ）" },
  { value: "sigma", label: "層1 σ正規化" },
  { value: "deviation", label: "層2 理論からの逸脱" },
  { value: "null", label: "層3 ヌル較正・OOS" },
];

const MODES: { value: BarrierMode; label: string; note: string }[] = [
  { value: "intraday", label: "日中（寄→引・60分足）", note: "主戦場。60分足730日＝曜日98日。逸脱指標のSEは5pp程度で測れる" },
  { value: "multiday", label: "数日（日足）", note: "窓が重なるためSEは√H倍。日内の到達順が不明なので悲観/楽観の帯が広がる" },
];

const H_OPTS = [3, 5, 10];

// 表示色
const C_TP = "#2563eb";
const C_SL = "#dc2626";
const C_TAU = "#16a34a";

// ───────────────────────── 層0の描画 ─────────────────────────

// 勝率・歪度・期待滞在を A の関数として3段で描く（B はスライダ固定）。
function drawDesignCurves(
  ctx: CanvasRenderingContext2D, W: number, H: number, B: number, hDays: number
) {
  const ml = 40, mr = 8, mt = 12, gap = 10;
  const panelH = (H - mt - 16 - gap * 2) / 3;
  const plotW = W - ml - mr;
  const aLo = 0.25, aHi = 3;
  const X = (a: number) => ml + ((a - aLo) / (aHi - aLo)) * plotW;

  const panels: { label: string; f: (a: number) => number; lo: number; hi: number; color: string }[] = [
    { label: "勝率 B/(A+B)", f: (a) => B / (a + B), lo: 0, hi: 1, color: C_TP },
    { label: "歪度 (A−B)/√(AB)", f: (a) => (a - B) / Math.sqrt(a * B), lo: -2.5, hi: 2.5, color: C_SL },
    { label: `期待滞在 AB·H（H=${hDays}日）`, f: (a) => a * B * hDays, lo: 0, hi: 3 * B * hDays, color: C_TAU },
  ];

  panels.forEach((p, i) => {
    const top = mt + i * (panelH + gap);
    const Y = (v: number) => top + (1 - (v - p.lo) / (p.hi - p.lo)) * panelH;
    ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 1;
    ctx.strokeRect(ml, top, plotW, panelH);
    // 0線（歪度パネルのみ意味を持つ）
    if (p.lo < 0 && p.hi > 0) {
      ctx.strokeStyle = "#e5e7eb";
      ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();
    }
    ctx.strokeStyle = p.color; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = 0; k <= 120; k++) {
      const a = aLo + ((aHi - aLo) * k) / 120;
      const x = X(a), y = Y(Math.max(p.lo, Math.min(p.hi, p.f(a))));
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(p.label, ml + 4, top + 10);
    ctx.textAlign = "right"; ctx.fillStyle = CHART_COLORS.ink;
    ctx.fillText(p.hi.toFixed(1), ml - 3, top + 8);
    ctx.fillText(p.lo.toFixed(1), ml - 3, top + panelH);
  });

  ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  for (const a of [0.5, 1, 1.5, 2, 2.5, 3]) ctx.fillText(`A=${a}`, X(a), H - 4);
}

// コスト後の暦時間シャープを (A,B) 平面で描く。コスト0なら一様（=バリアは無関係）、
// コスト>0 なら AB について単調増加（=内点解が消える）ことが目で見える。
function drawCostHeat(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  mu: number, sigma: number, T: number, cost: number, hDays: number
) {
  const ml = 34, mr = 12, mt = 14, mb = 24;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const N = 24;
  const aLo = 0.25, aHi = 3;
  const vals: number[][] = [];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < N; i++) {
    const row: number[] = [];
    for (let j = 0; j < N; j++) {
      const A = aLo + ((aHi - aLo) * i) / (N - 1);
      const B = aLo + ((aHi - aLo) * j) / (N - 1);
      const d = designBoard({ A, B, H: hDays, mu, sigma, T, cost });
      row.push(d.sharpeAfterCost);
      lo = Math.min(lo, d.sharpeAfterCost); hi = Math.max(hi, d.sharpeAfterCost);
    }
    vals.push(row);
  }
  const cw = plotW / N, ch = plotH / N;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const t = hi > lo ? (vals[i][j] - lo) / (hi - lo) : 0.5;
      // 青(低)→白→赤(高)
      const r = Math.round(255 * Math.min(1, 0.3 + 0.7 * t));
      const b = Math.round(255 * Math.min(1, 1.0 - 0.7 * t));
      ctx.fillStyle = `rgb(${r},${Math.round(255 * (1 - Math.abs(t - 0.5)))},${b})`;
      ctx.fillRect(ml + i * cw, mt + plotH - (j + 1) * ch, cw + 0.5, ch + 0.5);
    }
  }
  ctx.strokeStyle = "#d1d5db"; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif";
  ctx.textAlign = "center"; ctx.fillText("A（TPのσ倍）", ml + plotW / 2, H - 6);
  ctx.save();
  ctx.translate(10, mt + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText("B（SLのσ倍）", 0, 0);
  ctx.restore();
  ctx.textAlign = "left"; ctx.fillStyle = "#374151"; ctx.font = "9px sans-serif";
  ctx.fillText(
    hi - lo < 1e-9 ? "コスト0 → 全セル同値（バリアはシャープに無関係）" : `低 ${lo.toFixed(3)} → 高 ${hi.toFixed(3)}（ABが大きいほど良い＝内点解なし）`,
    ml, mt - 4
  );
}

// ───────────────────────── 層1の描画 ─────────────────────────

// 曜日別 best を散布（%単位 / σ単位の2枚を並べる）。
function drawBestScatter(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  rows: WeekdayLayer1[], unit: "pct" | "sigma"
) {
  const ml = 42, mr = 10, mt = 12, mb = 24;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const pts = rows
    .map((r) => {
      if (unit === "pct") {
        return r.bestPct ? { wd: r.weekday, x: r.bestPct.tpPct * 100, y: r.bestPct.slPct * 100 } : null;
      }
      return r.pctBestAsSigma ? { wd: r.weekday, x: r.pctBestAsSigma.A, y: r.pctBestAsSigma.B } : null;
    })
    .filter((p): p is { wd: number; x: number; y: number } => p !== null);
  if (pts.length === 0) return;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const pad = 0.25;
  const xLo = Math.min(...xs) * (1 - pad), xHi = Math.max(...xs) * (1 + pad);
  const yLo = Math.min(...ys) * (1 - pad), yHi = Math.max(...ys) * (1 + pad);
  const X = (v: number) => ml + ((v - xLo) / Math.max(1e-9, xHi - xLo)) * plotW;
  const Y = (v: number) => mt + (1 - (v - yLo) / Math.max(1e-9, yHi - yLo)) * plotH;

  ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  // 平均の十字（ばらつきの中心）
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  ctx.strokeStyle = "#cbd5e1"; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(X(mx), mt); ctx.lineTo(X(mx), mt + plotH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ml, Y(my)); ctx.lineTo(ml + plotW, Y(my)); ctx.stroke();
  ctx.setLineDash([]);

  for (const p of pts) {
    ctx.fillStyle = WD_COLORS[p.wd];
    ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#374151"; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(WD_LABELS[p.wd].slice(0, 1), X(p.x) + 7, Y(p.y) + 3);
  }

  ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  ctx.fillText(unit === "pct" ? "TP（%）" : "A（TPのσ倍）", ml + plotW / 2, H - 6);
  ctx.save(); ctx.translate(10, mt + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText(unit === "pct" ? "SL（%）" : "B（SLのσ倍）", 0, 0);
  ctx.restore();
  ctx.textAlign = "right"; ctx.fillStyle = CHART_COLORS.ink;
  ctx.fillText(unit === "pct" ? `${xHi.toFixed(2)}%` : xHi.toFixed(2), ml + plotW, mt - 3);
}

// σ単位格子のヒートマップ（プール）。最良セルに枠を打つ。
function drawGridHeat(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  grid: GridCell[][], aLevels: number[], bLevels: number[], bestAi: number, bestBi: number
) {
  const ml = 36, mr = 12, mt = 14, mb = 26;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const nA = aLevels.length, nB = bLevels.length;
  let lo = Infinity, hi = -Infinity;
  for (const row of grid) for (const c of row) { lo = Math.min(lo, c.expPerTime); hi = Math.max(hi, c.expPerTime); }
  const cw = plotW / nA, ch = plotH / nB;
  for (let i = 0; i < nA; i++) {
    for (let j = 0; j < nB; j++) {
      const v = grid[i][j].expPerTime;
      const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
      const r = Math.round(255 * Math.min(1, 0.25 + 0.75 * t));
      const b = Math.round(255 * Math.min(1, 1.05 - 0.75 * t));
      ctx.fillStyle = `rgb(${r},${Math.round(240 - 60 * Math.abs(t - 0.5))},${b})`;
      ctx.fillRect(ml + i * cw, mt + plotH - (j + 1) * ch, cw + 0.5, ch + 0.5);
    }
  }
  ctx.strokeStyle = "#111827"; ctx.lineWidth = 2;
  ctx.strokeRect(ml + bestAi * cw, mt + plotH - (bestBi + 1) * ch, cw, ch);
  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);

  ctx.fillStyle = "#6b7280"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
  for (let i = 0; i < nA; i += Math.max(1, Math.floor(nA / 5))) {
    ctx.fillText(aLevels[i].toFixed(2), ml + (i + 0.5) * cw, H - 14);
  }
  ctx.fillText("A（TPのσ倍）", ml + plotW / 2, H - 4);
  ctx.textAlign = "right";
  for (let j = 0; j < nB; j += Math.max(1, Math.floor(nB / 4))) {
    ctx.fillText(bLevels[j].toFixed(2), ml - 3, mt + plotH - (j + 0.5) * ch + 3);
  }
  ctx.textAlign = "left"; ctx.fillStyle = "#374151";
  ctx.fillText("黒枠＝best（単位時間あたり期待値）", ml, mt - 4);
}

// ───────────────────────── 層2の描画 ─────────────────────────

// 逸脱バー: 曜日別の (実測 − 理論) を ±SE つきで描く。0を跨ぐかを目で見る。
function drawDeviationBars(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  rows: DeviationRow[], metric: "p" | "tau" | "over"
) {
  const ml = 46, mr = 12, mt = 14, mb = 20;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const items = rows.map((r) => {
    if (metric === "p") return { wd: r.weekday, d: r.pHat - r.pTheory, se: r.pSe, n: r.nResolved };
    if (metric === "tau") return { wd: r.weekday, d: r.tauHat - Math.min(1, r.tauTheory), se: r.tauSe, n: r.n };
    return { wd: r.weekday, d: r.overMean, se: r.overSe, n: r.n };
  });
  const mx = Math.max(
    1e-6,
    ...items.map((i) => Math.abs(i.d) + (isFinite(i.se) ? 2 * i.se : 0))
  );
  const Y = (v: number) => mt + plotH / 2 - (v / (mx * 1.15)) * (plotH / 2);
  const bw = plotW / items.length;

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();
  ctx.fillStyle = CHART_COLORS.ink; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(metric === "p" ? `+${(mx * 100).toFixed(1)}pp` : `+${mx.toFixed(3)}`, ml - 3, mt + 8);
  ctx.fillText("理論値", ml - 3, Y(0) + 3);
  ctx.fillText(metric === "p" ? `−${(mx * 100).toFixed(1)}pp` : `−${mx.toFixed(3)}`, ml - 3, mt + plotH);

  items.forEach((it, i) => {
    const cx = ml + (i + 0.5) * bw;
    const sig = isFinite(it.se) && it.se > 0 && Math.abs(it.d) > 1.96 * it.se;
    ctx.fillStyle = WD_COLORS[it.wd] + (sig ? "" : "66");
    const y0 = Y(0), y1 = Y(it.d);
    ctx.fillRect(cx - bw * 0.28, Math.min(y0, y1), bw * 0.56, Math.abs(y1 - y0));
    if (isFinite(it.se) && it.se > 0) {
      ctx.strokeStyle = "#374151"; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, Y(it.d - 1.96 * it.se)); ctx.lineTo(cx, Y(it.d + 1.96 * it.se));
      ctx.moveTo(cx - 4, Y(it.d - 1.96 * it.se)); ctx.lineTo(cx + 4, Y(it.d - 1.96 * it.se));
      ctx.moveTo(cx - 4, Y(it.d + 1.96 * it.se)); ctx.lineTo(cx + 4, Y(it.d + 1.96 * it.se));
      ctx.stroke();
    }
    ctx.fillStyle = "#374151"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(WD_LABELS[it.wd], cx, H - 6);
  });
}

// ───────────────────────── 層3の描画 ─────────────────────────

function drawNullHist(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  sorted: number[], actual: number, label: string
) {
  const ml = 30, mr = 10, mt = 12, mb = 18;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  if (sorted.length < 5) return;
  const lo = Math.min(sorted[0], actual), hi = Math.max(sorted[sorted.length - 1], actual);
  const span = hi - lo || 1;
  const nb = 22;
  const counts = new Array(nb).fill(0);
  for (const v of sorted) counts[Math.max(0, Math.min(nb - 1, Math.floor(((v - lo) / span) * nb)))]++;
  const cMax = Math.max(...counts, 1);
  const X = (v: number) => ml + ((v - lo) / span) * plotW;
  const bw = plotW / nb;
  for (let b = 0; b < nb; b++) {
    ctx.fillStyle = "#cbd5e1";
    const h = (counts[b] / cMax) * plotH;
    ctx.fillRect(ml + b * bw + 0.5, mt + plotH - h, bw - 1, h);
  }
  ctx.strokeStyle = "#111827"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(X(actual), mt); ctx.lineTo(X(actual), mt + plotH); ctx.stroke();
  ctx.fillStyle = "#111827"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("実測", Math.max(ml + 14, Math.min(ml + plotW - 14, X(actual))), mt + 8);
  ctx.fillStyle = "#6b7280"; ctx.textAlign = "left";
  ctx.fillText(label, ml, H - 5);
}

// ───────────────────────── 本体 ─────────────────────────

export default function WeekdayBarrierChart({ prices, ticker }: Props) {
  const [view, setView] = useState<View>("board");
  const [mode, setMode] = useState<BarrierMode>("intraday");
  const [hDays, setHDays] = useState(5);
  const [costBp, setCostBp] = useState(10);
  const [nGrid, setNGrid] = useState(8);
  const [refA, setRefA] = useState(1);
  const [refB, setRefB] = useState(1);
  const [nSurrogate, setNSurrogate] = useState(150);
  const [boardA, setBoardA] = useState(1);
  const [boardB, setBoardB] = useState(1);

  const { resp, loading: barsLoading, error: barsError } = useIntraday(ticker, "60m");

  // 悲観(SL優先)・楽観(TP優先)の2本を必ず走らせ、帯として読む。
  // 結果には投入時の設定キーを添えて保持し、設定が変わったら「古い結果」として自然に無効化する
  // （効果の中で結果を消しに行かないので、条件変更時に前の絵が一瞬残ることもない）。
  type Stamped = { key: string; r: BarrierResult };
  const [resPess, setResPess] = useState<Stamped | null>(null);
  const [resOpt, setResOpt] = useState<Stamped | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqBase = useRef(0);
  const pending = useRef<Record<number, { tie: TieBreak; key: string }>>({});

  const boardCanvas = useRef<HTMLCanvasElement>(null);
  const heatCanvas = useRef<HTMLCanvasElement>(null);
  const pctCanvas = useRef<HTMLCanvasElement>(null);
  const sigCanvas = useRef<HTMLCanvasElement>(null);
  const gridCanvas = useRef<HTMLCanvasElement>(null);
  const devPCanvas = useRef<HTMLCanvasElement>(null);
  const devTCanvas = useRef<HTMLCanvasElement>(null);
  const devOCanvas = useRef<HTMLCanvasElement>(null);
  const nullFCanvas = useRef<HTMLCanvasElement>(null);
  const nullQCanvas = useRef<HTMLCanvasElement>(null);
  const nullBCanvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const w = new Worker(new URL("../../lib/weekday-barrier.worker.ts", import.meta.url));
    workerRef.current = w;
    w.onmessage = (ev: MessageEvent<BarrierWorkerResponse>) => {
      const p = pending.current[ev.data.reqId];
      if (!p) return;
      if (ev.data.progress) setProgress(ev.data.progress);
      if (ev.data.result) {
        const stamped = { key: p.key, r: ev.data.result };
        if (p.tie === "pessimistic") setResPess(stamped); else setResOpt(stamped);
        delete pending.current[ev.data.reqId];
        if (Object.keys(pending.current).length === 0) { setRunning(false); setProgress(null); }
      }
    };
    return () => { w.terminate(); workerRef.current = null; };
  }, []);

  // 投入設定の同一性キー。これが変わると保持中の結果は「古い」と判定される。
  const runKey = useMemo(
    () => [mode, hDays, costBp, nGrid, refA, refB, nSurrogate, resp?.bars.length ?? 0, prices.length].join("|"),
    [mode, hDays, costBp, nGrid, refA, refB, nSurrogate, resp, prices.length]
  );

  useEffect(() => {
    const w = workerRef.current;
    if (!w) return;
    if (mode === "intraday" && (!resp || resp.bars.length === 0)) return;
    if (mode === "multiday" && prices.length < 260) return;
    pending.current = {};
    // Worker への投入（外部システムの同期）に付随する進捗表示。結果自体は onmessage 側で入る。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRunning(true);
    setProgress(null);
    (["pessimistic", "optimistic"] as TieBreak[]).forEach((tie, k) => {
      const reqId = ++reqBase.current;
      pending.current[reqId] = { tie, key: runKey };
      const p: BarrierParams = {
        mode,
        hDays: mode === "intraday" ? 1 : hDays,
        tie,
        costBp,
        nGrid,
        aMax: 2.5,
        refA,
        refB,
        nSurrogate,
        nBrownian: Math.round(nSurrogate * 0.6),
        seed: 0x1234567 + k,
      };
      const req: BarrierWorkerRequest = {
        reqId, params: p,
        bars: mode === "intraday" ? resp?.bars : undefined,
        gmtoffset: resp?.gmtoffset,
        prices: mode === "multiday" ? prices : undefined,
      };
      w.postMessage(req);
    });
    // runKey に全設定が畳まれている（個別の設定値を依存に並べると二重発火する）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  // 帯の代表として悲観側を主表示にする（保守的な側）。設定が変わった直後は古い結果を使わない。
  const main = resPess?.key === runKey ? resPess.r : null;
  const alt = resOpt?.key === runKey ? resOpt.r : null;
  const l1 = main?.layer1 ?? null;
  const l2 = main?.layer2 ?? null;
  const l3 = main?.layer3 ?? null;

  // 層0の μ,σ は実測（時間切りのみの実現リターン）から取る。
  const hUnit = mode === "intraday" ? 1 : hDays;
  const muPerDay = main ? main.muPerH / hUnit : 0;
  const sigPerDay = main ? main.sigmaPerH / Math.sqrt(hUnit) : 0;
  const board = designBoard({
    A: boardA, B: boardB, H: hUnit,
    mu: muPerDay, sigma: sigPerDay, T: 250, cost: costBp / 10000,
  });
  const boardNoCost = designBoard({
    A: boardA, B: boardB, H: hUnit, mu: muPerDay, sigma: sigPerDay, T: 250, cost: 0,
  });

  useEffect(() => {
    if (view !== "board") return;
    if (boardCanvas.current) {
      const i = initCanvas(boardCanvas.current, 260);
      if (i) drawDesignCurves(i.ctx, i.width, i.height, boardB, hUnit);
    }
    if (heatCanvas.current) {
      const i = initCanvas(heatCanvas.current, 260);
      if (i) drawCostHeat(i.ctx, i.width, i.height, muPerDay, sigPerDay, 250, costBp / 10000, hUnit);
    }
  }, [view, boardB, hUnit, muPerDay, sigPerDay, costBp]);

  useEffect(() => {
    if (view !== "sigma" || !l1) return;
    if (pctCanvas.current) {
      const i = initCanvas(pctCanvas.current, 230);
      if (i) drawBestScatter(i.ctx, i.width, i.height, l1.byWeekday, "pct");
    }
    if (sigCanvas.current) {
      const i = initCanvas(sigCanvas.current, 230);
      if (i) drawBestScatter(i.ctx, i.width, i.height, l1.byWeekday, "sigma");
    }
    if (gridCanvas.current && l1.pooledBest) {
      const i = initCanvas(gridCanvas.current, 260);
      if (i) drawGridHeat(i.ctx, i.width, i.height, l1.pooledGrid, l1.aLevels, l1.bLevels, l1.pooledBest.ai, l1.pooledBest.bi);
    }
  }, [view, l1]);

  useEffect(() => {
    if (view !== "deviation" || !l2) return;
    const pairs: [React.RefObject<HTMLCanvasElement | null>, "p" | "tau" | "over"][] = [
      [devPCanvas, "p"], [devTCanvas, "tau"], [devOCanvas, "over"],
    ];
    for (const [ref, metric] of pairs) {
      if (!ref.current) continue;
      const i = initCanvas(ref.current, 150);
      if (i) drawDeviationBars(i.ctx, i.width, i.height, l2.rows, metric);
    }
  }, [view, l2]);

  useEffect(() => {
    if (view !== "null" || !l3) return;
    if (l3.surrogate && nullFCanvas.current && l1?.dispersion) {
      const i = initCanvas(nullFCanvas.current, 140);
      if (i) drawNullHist(i.ctx, i.width, i.height, l3.surrogate.dispF, l1.dispersion.f, "サロゲートの分散比F分布");
    }
    if (l3.surrogate && nullQCanvas.current && l2) {
      const i = initCanvas(nullQCanvas.current, 140);
      if (i) drawNullHist(i.ctx, i.width, i.height, l3.surrogate.cochranQ, l2.cochranQ, "サロゲートの到達確率Cochran Q分布");
    }
    if (l3.brownian && nullBCanvas.current && l1?.pooledBest) {
      const i = initCanvas(nullBCanvas.current, 140);
      if (i) drawNullHist(i.ctx, i.width, i.height, l3.brownian.bestExpPerTime, l1.pooledBest.expPerTime, "一致ブラウン運動ヌルの best 期待値分布");
    }
  }, [view, l3, l1, l2]);

  const loading = (mode === "intraday" && barsLoading) || running;
  const error = mode === "intraday" ? barsError : null;

  // 帯（悲観/楽観）が結論を反転させるか
  const bandFlips = useMemo(() => {
    if (!main?.layer1?.pooledBest || !alt?.layer1?.pooledBest) return false;
    const a = main.layer1.pooledBest, b = alt.layer1.pooledBest;
    return a.interior !== b.interior || (a.expPerTime > 0) !== (b.expPerTime > 0);
  }, [main, alt]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">曜日別 TP/SL：バリアで何が測れて何が測れないか（系C28）</h3>

      {/* 一言結論を最上段に固定 */}
      <div className="rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-800 leading-relaxed">
        <span className="font-bold">結論（推定不要・恒等式）: </span>
        {"σ単位のバリア（TP=+Aσ√H / SL=−Bσ√H）は暦時間あたりのシャープレシオを一切変えない。変えられるのは勝率・歪度・回転率・期待滞在時間だけ。"}
        <div className="mt-1 font-mono text-[11px] text-gray-600">
          期待損益 = μ × 期待滞在 = μ·AB·H　／　暦時間シャープ = μ√T/σ（A,Bに不依存）
        </div>
        <div className="mt-1">
          {"したがって期待値基準の最適バリアは μ>0 なら「外して持ち切り」に張り付く。"}
          <span className="font-bold text-gray-900">格子探索が内点に最適解を返すことは、経路依存性の存在か推定ノイズのどちらかを意味する</span>
          {" ── その切り分けだけがこの分析の仕事である。"}
        </div>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">保有期間:</span>
          {MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setMode(m.value)}
              title={m.note}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                mode === m.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >{m.label}</button>
          ))}
        </div>
        {mode === "multiday" && (
          <div className="flex items-center gap-1 flex-wrap text-xs">
            <span className="text-gray-500">H:</span>
            {H_OPTS.map((h) => (
              <button
                key={h}
                onClick={() => setHDays(h)}
                className={`px-2 py-0.5 rounded font-medium transition-colors ${
                  hDays === h ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >{h}日</button>
            ))}
          </div>
        )}
        <label className="flex items-center gap-1 text-xs text-gray-600">
          往復コスト
          <input
            type="number" min={0} max={100} step={1} value={costBp}
            onChange={(e) => setCostBp(Math.max(0, Number(e.target.value)))}
            className="w-14 border border-gray-300 rounded px-1 py-0.5 text-xs"
          />bp
        </label>
        <label className="flex items-center gap-1 text-xs text-gray-600">
          格子
          <select
            value={nGrid} onChange={(e) => setNGrid(Number(e.target.value))}
            className="border border-gray-300 rounded px-1 py-0.5 text-xs"
          >
            {[6, 8, 10].map((g) => <option key={g} value={g}>{g}×{g}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-gray-600">
          サロゲート
          <select
            value={nSurrogate} onChange={(e) => setNSurrogate(Number(e.target.value))}
            className="border border-gray-300 rounded px-1 py-0.5 text-xs"
          >
            {[50, 150, 300].map((n) => <option key={n} value={n}>{n}本</option>)}
          </select>
        </label>
      </div>

      {error && <div className="bg-amber-50 text-amber-700 rounded-lg p-3 text-sm">{error}</div>}
      {loading && (
        <div className="text-sm text-fg-muted py-4 text-center">
          {barsLoading ? "60分足を取得中..." : "格子 × サロゲート を計算中..."}
          {progress && ` ${progress.done}/${progress.total}`}
        </div>
      )}
      {!loading && main && !main.ok && (
        <div className="text-xs text-fg-muted">{main.reason}</div>
      )}

      <ViewTabs value={view} onChange={setView} views={VIEWS} />

      {/* ───────── 層0 設計盤 ───────── */}
      {view === "board" && (
        <div className="space-y-3">
          <div className="flex items-center gap-4 flex-wrap text-xs">
            <label className="flex items-center gap-2">
              <span className="text-gray-600">A（TP = {boardA.toFixed(2)}σ√H）</span>
              <input type="range" min={0.25} max={3} step={0.05} value={boardA}
                onChange={(e) => setBoardA(Number(e.target.value))} className="w-40" />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-gray-600">B（SL = {boardB.toFixed(2)}σ√H）</span>
              <input type="range" min={0.25} max={3} step={0.05} value={boardB}
                onChange={(e) => setBoardB(Number(e.target.value))} className="w-40" />
            </label>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-gray-50 rounded p-2">
              <div className="text-gray-500">勝率 B/(A+B)</div>
              <div className="font-bold text-gray-800">{fmtPct(board.hitProbZeroMu, 1)}</div>
              <div className="text-[10px] text-fg-muted">μ込みの厳密解 {fmtPct(board.hitProbExact, 1)}</div>
            </div>
            <div className="bg-gray-50 rounded p-2">
              <div className="text-gray-500">歪度 (A−B)/√(AB)</div>
              <div className={`font-bold ${directionClass(board.skew)}`}><DirectionGlyph value={board.skew} />{board.skew.toFixed(2)}</div>
              <div className="text-[10px] text-fg-muted">正=大勝ち小負け</div>
            </div>
            <div className="bg-gray-50 rounded p-2">
              <div className="text-gray-500">期待滞在 AB·H</div>
              <div className="font-bold text-gray-800">{board.eTauH.toFixed(2)} 日</div>
              <div className="text-[10px] text-fg-muted">250日で {board.nTrades.toFixed(0)} 回転</div>
            </div>
            <div className="bg-gray-50 rounded p-2">
              <div className="text-gray-500">1トレードのSD</div>
              <div className="font-bold text-gray-800">{main ? fmtPct(board.tradeSd, 2) : "—"}</div>
              <div className="text-[10px] text-fg-muted">√(AB)·σ√H{main ? "" : "（σの実測待ち）"}</div>
            </div>
          </div>

          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
            <span className="font-bold">
              この盤で動かせないもの: 暦時間シャープ = {main ? boardNoCost.sharpeCal.toFixed(3) : "（実測 μ,σ の計算待ち）"}
            </span>
            <span className="ml-2 text-red-700">
              {main
                ? `（A, B をどう動かしても不変。実測 μ=${fmtSignedPct(muPerDay, 3)}/日・σ=${fmtPct(sigPerDay, 2)}/日、T=250日で計算）`
                : "（A, B をどう動かしても不変。値は下の計算が終わると入る）"}
            </span>
            <div className="mt-1">
              コスト {costBp}bp を入れると → コスト後シャープ {board.sharpeAfterCost.toFixed(3)}（
              総コスト {fmtPct(board.costTotal, 2)}＝{board.nTrades.toFixed(0)}回転分）。
              <span className="font-bold">コストは AB が小さいほど重くなるので、期待値基準の最適は常に「バリアを外す」側に張り付く。</span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div>
              <div className="text-xs font-medium text-gray-700 mb-1">A を動かしたときの3量（B={boardB.toFixed(2)} 固定）</div>
              <div className="relative"><canvas ref={boardCanvas} /></div>
            </div>
            <div>
              <div className="text-xs font-medium text-gray-700 mb-1">コスト後 暦時間シャープの (A,B) 平面</div>
              <div className="relative"><canvas ref={heatCanvas} /></div>
            </div>
          </div>
          <p className="text-[11px] text-gray-500">
            {"左: 勝率は B/(A+B) で単調、歪度は A=B で0、期待滞在は AB に比例。いずれも推定を必要としない恒等式であり「発見」ではない。右: コスト0なら全面が同じ色（バリアはシャープに無関係）。コストを入れると右上（AB大）ほど良くなる一方通行になる。"}
          </p>
        </div>
      )}

      {/* ───────── 層1 σ正規化 ───────── */}
      {view === "sigma" && (
        l1 ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div>
                <div className="text-xs font-medium text-gray-700 mb-1">① %固定の格子で探した曜日別 best（%単位）</div>
                <div className="relative"><canvas ref={pctCanvas} /></div>
              </div>
              <div>
                <div className="text-xs font-medium text-gray-700 mb-1">② 同じ best を σ単位に直す（A = TP% / σ_dow√H）</div>
                <div className="relative"><canvas ref={sigCanvas} /></div>
              </div>
            </div>

            {l1.dispersion && (
              <div className={`rounded-md px-3 py-2 text-xs ${
                l1.dispersion.collapses
                  ? "bg-green-50 text-green-900 border border-green-200"
                  : "bg-gray-50 text-gray-700 border border-gray-200"
              }`}>
                <span className="font-bold">曜日間ばらつきの比較: </span>
                Var[log TP%] = {l1.dispersion.varLogPct.toFixed(4)} ／ Var[log A] = {l1.dispersion.varLogSig.toFixed(4)} ／
                F = {l1.dispersion.f.toFixed(2)}（df {l1.dispersion.k - 1},{l1.dispersion.k - 1}、p = {l1.dispersion.p.toFixed(3)}）
                <div className="mt-1">
                  {l1.dispersion.collapses
                    ? "σ正規化で曜日間のばらつきが有意に縮んだ＝「曜日別に最適 TP/SL が違う」の正体は σ_dow の違いだった。曜日別にバリアを切る必要はない。"
                    : "σ正規化してもばらつきは有意に縮まない。ただし縮まないことは「曜日差が本物」を意味しない（best 自体がノイズなら正規化しても縮まない）。"}
                  {l3?.surrogate
                    ? `　この F の自由度は (${l1.dispersion.k - 1},${l1.dispersion.k - 1}) しかなく検出力が乏しいため、判定はサロゲート分位点で行う → ${fmtPct(l3.surrogate.pctDispF, 0)} 点（層3①）。`
                    : "　自由度 (4,4) のF検定は検出力が乏しいので、判定は層3のサロゲート分位点で行うこと。"}
                </div>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 px-2">曜日</th>
                    <th className="text-right px-2">n</th>
                    <th className="text-right px-2">σ√H</th>
                    <th className="text-right px-2">best TP%</th>
                    <th className="text-right px-2">best SL%</th>
                    <th className="text-right px-2">→ A（σ単位）</th>
                    <th className="text-right px-2">→ B（σ単位）</th>
                    <th className="text-center px-2">σ格子の best</th>
                    <th className="text-center px-2">内点か</th>
                  </tr>
                </thead>
                <tbody>
                  {l1.byWeekday.map((w) => (
                    <tr key={w.weekday} className="border-b border-gray-100">
                      <td className="py-1 px-2">
                        <span className="inline-flex items-center gap-1">
                          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: WD_COLORS[w.weekday] }} />
                          <span className="text-gray-700">{WD_LABELS[w.weekday]}</span>
                        </span>
                      </td>
                      <td className="text-right px-2 text-gray-600">{w.n}</td>
                      <td className="text-right px-2 text-gray-600 tabular-nums">{fmtPct(w.hv, 2)}</td>
                      <td className="text-right px-2 tabular-nums text-gray-800">{w.bestPct ? fmtPct(w.bestPct.tpPct, 2) : "—"}</td>
                      <td className="text-right px-2 tabular-nums text-gray-800">{w.bestPct ? fmtPct(w.bestPct.slPct, 2) : "—"}</td>
                      <td className="text-right px-2 tabular-nums font-medium text-blue-700">{w.pctBestAsSigma ? w.pctBestAsSigma.A.toFixed(2) : "—"}</td>
                      <td className="text-right px-2 tabular-nums font-medium text-red-700">{w.pctBestAsSigma ? w.pctBestAsSigma.B.toFixed(2) : "—"}</td>
                      <td className="text-center px-2 text-gray-600 tabular-nums">
                        {w.bestSig ? `A=${w.bestSig.A.toFixed(2)} / B=${w.bestSig.B.toFixed(2)}` : "—"}
                      </td>
                      <td className="text-center px-2">
                        {w.bestSig ? (w.bestSig.interior ? <span className="text-amber-700 font-medium">内点</span> : <span className="text-fg-muted">縁</span>) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <div className="text-xs font-medium text-gray-700 mb-1">全曜日プールの σ単位格子（色＝単位時間あたり期待値）</div>
              <div className="relative"><canvas ref={gridCanvas} /></div>
              {l1.pooledBest && (
                <p className="text-[11px] text-gray-500 mt-1">
                  プール best: A={l1.pooledBest.A.toFixed(2)} / B={l1.pooledBest.B.toFixed(2)}（
                  単位時間期待値 {fmtSignedPct(l1.pooledBest.expPerTime, 3)}／1トレード {fmtSignedPct(l1.pooledBest.expPerTrade, 3)}／
                  勝率 {fmtPct(l1.pooledBest.winRate, 1)}／平均滞在 {l1.pooledBest.meanTauH.toFixed(2)}H）。
                  {l1.pooledBest.interior
                    ? " これは格子の内点にある ── 経路依存性の候補だが、層3でサロゲートと同頻度なら単なるノイズ。"
                    : " これは格子の縁にある ── 理論どおり（バリアを外す方向に張り付いた）。"}
                </p>
              )}
            </div>
          </div>
        ) : <div className="text-xs text-fg-muted">計算待ち。</div>
      )}

      {/* ───────── 層2 逸脱 ───────── */}
      {view === "deviation" && (
        l2 ? (
          <div className="space-y-3">
            <div className="flex items-center gap-4 flex-wrap text-xs">
              <label className="flex items-center gap-2">
                <span className="text-gray-600">基準 A = {refA.toFixed(2)}</span>
                <input type="range" min={0.25} max={2.5} step={0.25} value={refA}
                  onChange={(e) => setRefA(Number(e.target.value))} className="w-32" />
              </label>
              <label className="flex items-center gap-2">
                <span className="text-gray-600">基準 B = {refB.toFixed(2)}</span>
                <input type="range" min={0.25} max={2.5} step={0.25} value={refB}
                  onChange={(e) => setRefB(Number(e.target.value))} className="w-32" />
              </label>
              <span className="text-fg-muted">
                理論値: 到達確率 {fmtPct(refB / (refA + refB), 1)}／期待滞在 {(refA * refB).toFixed(2)}H
              </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <div>
                <div className="text-[11px] font-medium text-gray-700">到達確率 − B/(A+B)</div>
                <div className="relative"><canvas ref={devPCanvas} /></div>
                <div className="text-[10px] text-fg-muted">正=平均回帰的／負=モメンタム的</div>
              </div>
              <div>
                <div className="text-[11px] font-medium text-gray-700">期待滞在 − min(AB, 1)</div>
                <div className="relative"><canvas ref={devTCanvas} /></div>
                <div className="text-[10px] text-fg-muted">負=早く決着（ボラクラスタ）</div>
              </div>
              <div>
                <div className="text-[11px] font-medium text-gray-700">オーバーシュート（σ単位）</div>
                <div className="relative"><canvas ref={devOCanvas} /></div>
                <div className="text-[10px] text-fg-muted">正=ギャップで滑る（ジャンプ）</div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 px-2">曜日</th>
                    <th className="text-right px-2">n</th>
                    <th className="text-right px-2">時間切り率</th>
                    <th className="text-right px-2">到達確率</th>
                    <th className="text-right px-2">理論差</th>
                    <th className="text-right px-2">滞在(H)</th>
                    <th className="text-right px-2">理論差</th>
                    <th className="text-right px-2">オーバーシュート</th>
                  </tr>
                </thead>
                <tbody>
                  {l2.rows.filter((r) => r.n > 0).map((r) => (
                    <tr key={r.weekday} className="border-b border-gray-100">
                      <td className="py-1 px-2">
                        <span className="inline-flex items-center gap-1">
                          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: WD_COLORS[r.weekday] }} />
                          <span className="text-gray-700">{WD_LABELS[r.weekday]}</span>
                        </span>
                      </td>
                      <td className="text-right px-2 text-gray-600">{r.n}</td>
                      <td className="text-right px-2 text-gray-500 tabular-nums">{fmtPct(r.timeoutShare, 0)}</td>
                      <td className="text-right px-2 tabular-nums text-gray-800">{fmtPct(r.pHat, 1)}</td>
                      <td className={`text-right px-2 tabular-nums ${r.pP < 0.05 ? "font-bold" : ""} ${directionClass(r.pHat - r.pTheory)}`}><DirectionGlyph value={r.pHat - r.pTheory} />
                        {((r.pHat - r.pTheory) * 100).toFixed(1)}pp{r.pP < 0.05 ? "★" : ""}
                      </td>
                      <td className="text-right px-2 tabular-nums text-gray-800">{r.tauHat.toFixed(2)}</td>
                      <td className={`text-right px-2 tabular-nums ${r.tauP < 0.05 ? "font-bold" : ""} text-gray-700`}>
                        {(r.tauHat - Math.min(1, r.tauTheory)).toFixed(2)}{r.tauP < 0.05 ? "★" : ""}
                      </td>
                      <td className={`text-right px-2 tabular-nums ${r.overP < 0.05 ? "font-bold text-amber-700" : "text-gray-600"}`}>
                        {r.overMean.toFixed(3)}σ{r.overP < 0.05 ? "★" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-1">
              <div className="text-xs font-medium text-gray-700">曜日間の差だけを検定する（水準そのものは μ 混入で解釈できない）</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1 px-2">指標</th>
                      <th className="text-left px-2">検定</th>
                      <th className="text-right px-2">統計量</th>
                      <th className="text-right px-2">生p</th>
                      <th className="text-left px-2">FDR後</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-gray-100">
                      <td className="py-1 px-2 text-gray-700">到達確率</td>
                      <td className="px-2 text-gray-500">Cochran Q（比率の等質性）</td>
                      <td className="text-right px-2 tabular-nums">{l2.cochranQ.toFixed(2)}（df {l2.cochranDf}）</td>
                      <td className="text-right px-2 tabular-nums">{l2.cochranP.toFixed(3)}</td>
                      <td className="px-2"><StatBadge n={l2.rows.reduce((s, r) => s + r.nResolved, 0)} p={l2.pAdj[0]} significant={l2.pAdj[0] < 0.05} /></td>
                    </tr>
                    <tr className="border-b border-gray-100">
                      <td className="py-1 px-2 text-gray-700">期待滞在</td>
                      <td className="px-2 text-gray-500">一元配置分散分析 F</td>
                      <td className="text-right px-2 tabular-nums">{l2.tauF.toFixed(2)}（df {l2.tauFdf1},{l2.tauFdf2}）</td>
                      <td className="text-right px-2 tabular-nums">{l2.tauFp.toFixed(3)}</td>
                      <td className="px-2"><StatBadge n={l2.rows.reduce((s, r) => s + r.n, 0)} p={l2.pAdj[1]} significant={l2.pAdj[1] < 0.05} /></td>
                    </tr>
                    <tr className="border-b border-gray-100">
                      <td className="py-1 px-2 text-gray-700">オーバーシュート</td>
                      <td className="px-2 text-gray-500">Kruskal-Wallis</td>
                      <td className="text-right px-2 tabular-nums">{l2.kruskalH.toFixed(2)}（df {l2.kruskalDf}）</td>
                      <td className="text-right px-2 tabular-nums">{l2.kruskalP.toFixed(3)}</td>
                      <td className="px-2"><StatBadge n={l2.rows.reduce((s, r) => s + r.n, 0)} p={l2.pAdj[2]} significant={l2.pAdj[2] < 0.05} /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-fg-muted">
                {l2.overlapFactor > 1
                  ? `数日モードは窓が重なるため、SEを√H=${l2.overlapFactor.toFixed(2)}倍に膨らませて報告している（実効標本は n/H 相当）。`
                  : "日中モードは各日1本なので重なり補正なし。"}
                {" 逸脱の「水準」には離散化（1日6本前後の粗さ）と時間切りの機械的効果が混ざる。純粋な逸脱かを見るには層3の一致ブラウン運動ヌルと比べること。"}
              </p>
            </div>
          </div>
        ) : <div className="text-xs text-fg-muted">計算待ち。</div>
      )}

      {/* ───────── 層3 ヌル較正・OOS ───────── */}
      {view === "null" && (
        l3 ? (
          <div className="space-y-4">
            {/* ① 曜日ラベル破壊サロゲート */}
            {l3.surrogate && l1?.dispersion && l2 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-gray-700">
                  ① 曜日ラベル破壊サロゲート（{l3.surrogate.n}本）── 曜日構造ゼロと分かっているデータに同じパイプラインを流す
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">曜日別bestの平均期待値</div>
                    <div className="font-bold text-gray-800">実測はヌルの {fmtPct(l3.surrogate.pctBestExp, 0)} 点</div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">分散比F（σ正規化の効き）</div>
                    <div className="font-bold text-gray-800">{fmtPct(l3.surrogate.pctDispF, 0)} 点</div>
                    <div className="text-[10px] text-fg-muted">高い＝σ正規化で縮んだ（曜日差は不要）</div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">到達確率 Cochran Q</div>
                    <div className="font-bold text-gray-800">{fmtPct(l3.surrogate.pctCochran, 0)} 点</div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">滞在時間 ANOVA F</div>
                    <div className={`font-bold ${l3.surrogate.pctTauF > 0.95 ? "text-green-700" : "text-gray-800"}`}>
                      {fmtPct(l3.surrogate.pctTauF, 0)} 点
                    </div>
                    <div className="text-[10px] text-fg-muted">層2で唯一有意になりやすい指標</div>
                  </div>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div className="relative"><canvas ref={nullFCanvas} /></div>
                  <div className="relative"><canvas ref={nullQCanvas} /></div>
                </div>
                {/* 曜日「差」の証拠になるのは best期待値・到達確率・滞在時間の3つ。
                    分散比Fは向きが逆（高い＝σ正規化で差が消えた＝曜日別に切る必要がない）なので別扱いにする。 */}
                {(() => {
                  const diffHits = [
                    l3.surrogate.pctBestExp > 0.95 ? "best期待値" : "",
                    l3.surrogate.pctCochran > 0.95 ? "到達確率" : "",
                    l3.surrogate.pctTauF > 0.95 ? "滞在時間" : "",
                  ].filter(Boolean);
                  return (
                    <>
                      <div className={`rounded-md px-3 py-2 text-xs ${
                        diffHits.length
                          ? "bg-green-50 text-green-900 border border-green-200"
                          : "bg-red-50 text-red-900 border border-red-200"
                      }`}>
                        <span className="font-bold">曜日差の判定: </span>
                        {diffHits.length
                          ? `実測がサロゲート分布の上位5%に入っている指標がある（${diffHits.join("・")}）＝曜日構造がゼロでは説明できない。効果量とOOS（下の③）を必ず併記して読むこと。`
                          : "実測はサロゲート分布の中に埋もれている＝曜日ラベルを壊しても同じ絵が出る。曜日別にバリアを切る根拠はない（null result）。層2で有意に見えた指標も、曜日ラベルを壊しただけで同程度の値が出るということ。"}
                      </div>
                      <div className={`rounded-md px-3 py-2 text-xs ${
                        l3.surrogate.pctDispF > 0.95
                          ? "bg-blue-50 text-blue-900 border border-blue-200"
                          : "bg-gray-50 text-gray-700 border border-gray-200"
                      }`}>
                        <span className="font-bold">σ正規化の判定（層1の答え合わせ）: </span>
                        {l3.surrogate.pctDispF > 0.95
                          ? "分散比Fがサロゲート分布の上位5%＝「%単位で見えていた曜日別の最適幅の違いは σ_dow の違いだった」がヌルより有意に強い。曜日別にバリアを切る必要はない（設計書の成功条件①）。"
                          : "分散比Fはヌルの範囲内＝σ正規化で縮んだとも縮まなかったとも言えない。best 自体がノイズなら正規化しても縮まないため、層1の見た目から結論を出さないこと。"}
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            {/* ② 一致ブラウン運動ヌル */}
            {l3.brownian && l1?.pooledBest && l2 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-gray-700">
                  ② 一致ブラウン運動ヌル（{l3.brownian.n}本）── 同じ本数・同じ足数・同じσ・同じ決着規則の iid ガウス
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">ヌルで内点解が出た割合</div>
                    <div className="font-bold text-gray-800">{fmtPct(l3.brownian.interiorShare, 0)}</div>
                    <div className="text-[10px] text-fg-muted">実測: {l3.brownian.actualInterior ? "内点" : "縁"}</div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">best期待値の分位点</div>
                    <div className="font-bold text-gray-800">{fmtPct(l3.brownian.pctBestExp, 0)} 点</div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">ヌルの到達確率（中央値）</div>
                    <div className="font-bold text-gray-800">{fmtPct(l3.brownian.medPHat, 1)}</div>
                    <div className="text-[10px] text-fg-muted">理論 {fmtPct(l2.B / (l2.A + l2.B), 1)}</div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">ヌルの滞在（中央値）</div>
                    <div className="font-bold text-gray-800">{l3.brownian.medTauH.toFixed(2)}H</div>
                    <div className="text-[10px] text-fg-muted">理論 min(AB,1)={Math.min(1, l2.A * l2.B).toFixed(2)}</div>
                  </div>
                </div>
                <div className="relative"><canvas ref={nullBCanvas} /></div>
                <div className={`rounded-md px-3 py-2 text-xs ${
                  l3.brownian.actualInterior && l3.brownian.interiorShare < 0.2 && l3.brownian.pctBestExp > 0.95
                    ? "bg-green-50 text-green-900 border border-green-200"
                    : "bg-gray-50 text-gray-700 border border-gray-200"
                }`}>
                  <span className="font-bold">内点性の判定: </span>
                  {l3.brownian.actualInterior
                    ? (l3.brownian.interiorShare > 0.2
                      ? `実測は内点だが、経路依存性ゼロのブラウン運動でも ${fmtPct(l3.brownian.interiorShare, 0)} の頻度で内点解が出る＝内点性そのものがノイズの産物。`
                      : "実測が内点で、ヌルではほとんど内点解が出ない＝経路依存性の候補。効果量とOOSで詰めること。")
                    : "実測の best は格子の縁にある＝理論どおり（コスト下では『外して持ち切り』方向が最良）。TP/SL を最適化する動機がそもそも無い。"}
                  <div className="mt-1 text-[11px]">
                    {"ヌルの到達確率・滞在が理論値からずれている分は、離散化と時間切りの機械的効果。層2の逸脱はこの分を差し引いて読む。"}
                  </div>
                </div>
              </div>
            )}

            {/* ③ OOS */}
            {l3.oos.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-gray-700">③ インターリーブ2分割OOS（偶数本で学習→奇数本で検定、逆も）</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-200">
                        <th className="text-left py-1 px-2">出口ルール</th>
                        <th className="text-right px-2">n</th>
                        <th className="text-right px-2">1トレード期待値</th>
                        <th className="text-right px-2">単位時間期待値</th>
                        <th className="text-right px-2">1トレードSharpe</th>
                        <th className="text-right px-2">勝率</th>
                        <th className="text-right px-2">平均滞在</th>
                      </tr>
                    </thead>
                    <tbody>
                      {l3.oos.map((r) => (
                        <tr key={r.label} className="border-b border-gray-100">
                          <td className="py-1 px-2 text-gray-700">{r.label}</td>
                          <td className="text-right px-2 text-gray-600">{r.n}</td>
                          <td className={`text-right px-2 tabular-nums ${directionClass(r.expPerTrade)}`}><DirectionGlyph value={r.expPerTrade} />{fmtSignedPct(r.expPerTrade, 3)}</td>
                          <td className={`text-right px-2 tabular-nums ${directionClass(r.expPerTime)}`}><DirectionGlyph value={r.expPerTime} />{fmtSignedPct(r.expPerTime, 3)}</td>
                          <td className="text-right px-2 tabular-nums text-gray-800">{r.sharpePerTrade.toFixed(3)}</td>
                          <td className="text-right px-2 tabular-nums text-gray-600">{fmtPct(r.winRate, 1)}</td>
                          <td className="text-right px-2 tabular-nums text-gray-600">{r.meanTauH.toFixed(2)}H</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-gray-500">
                  {"「曜日別」が「共通」に勝てないなら曜日を状態に足す意味はない。「共通」が「バリアなし」に勝てないなら、そもそもバリアを置く意味がない（理論の予測どおり）。単位時間期待値は回転率の違いを揃えた比較。"}
                </p>
              </div>
            )}

            {/* 悲観/楽観の帯 */}
            {alt?.layer1?.pooledBest && l1?.pooledBest && (
              <div className={`rounded-md px-3 py-2 text-xs ${bandFlips ? "bg-amber-50 text-amber-900 border border-amber-200" : "bg-gray-50 text-gray-700 border border-gray-200"}`}>
                <span className="font-bold">同足同時到達の帯: </span>
                悲観側（SL優先）best A={l1.pooledBest.A.toFixed(2)}/B={l1.pooledBest.B.toFixed(2)}・単位時間期待値 {fmtSignedPct(l1.pooledBest.expPerTime, 3)}
                {" ／ "}
                楽観側（TP優先）best A={alt.layer1.pooledBest.A.toFixed(2)}/B={alt.layer1.pooledBest.B.toFixed(2)}・{fmtSignedPct(alt.layer1.pooledBest.expPerTime, 3)}
                <div className="mt-1">
                  {bandFlips
                    ? "帯の両端で結論（内点性または期待値の符号）が反転する＝この足では判定不能。より細かい足か、バリア幅を広げて同足同時到達を減らすこと。"
                    : "帯の両端で結論は変わらない＝同足内の到達順の不明性は結論に影響していない。"}
                </div>
              </div>
            )}
          </div>
        ) : <div className="text-xs text-fg-muted">計算待ち。</div>
      )}

      {main?.ok && (
        <p className="text-[11px] text-fg-muted">
          {mode === "intraday" ? "日中モード（60分足・寄りで建て引けで時間切り）" : `数日モード（日足・${hDays}営業日で時間切り・窓は重なる）`}
          ：経路 {main.n} 本（{main.from} 〜 {main.to}）、σ√H = {fmtPct(main.sigmaPerH, 2)}、
          実測 μ/H = {fmtSignedPct(main.muPerH, 3)}。
          曜日別の本数: {WD_ORDER.map((wd) => `${WD_LABELS[wd]} ${main.hv.nByWeekday[wd] ?? 0}`).join(" / ")}
        </p>
      )}

      <AnalysisGuide title="曜日別 TP/SL（バリア設計）の詳細理論">
        <p className="font-medium text-gray-700">1. 手法の概要</p>
        <p>
          {"TP/SL は「期待値を作る装置」ではなく「滞在時間・勝率・歪度を設計する装置」である。対数価格が算術ブラウン運動 X_t = μt + σW_t に従うとき、σ単位で切ったバリア（TP=+Aσ√H / SL=−Bσ√H）の下で期待損益は μ×期待滞在時間にしかならず、暦時間あたりのシャープレシオは A,B に一切依存しない。したがって「曜日ごとに最適な利確幅・損切り幅がある」という仮説は、σ正規化した瞬間に「曜日別シャープ S_dow の推定問題」と同一になり、その推定は系C26（個別ドリフトの識別限界）の壁に当たる。この分析は、その壁の手前で何が測れるか（理論からの逸脱）だけを曜日別に検定する。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"到達確率（厳密解）: h(x)=e^{−νx}（ν=2μ/σ²）は生成作用素 L=μ∂+(σ²/2)∂² の調和関数なので h(X_t) は martingale。任意停止定理 E[h(X_τ)]=h(0)=1 より"}<br />
            {"p = P(TPに先に到達) = (1 − e^{νb}) / (e^{−νa} − e^{νb})、νa = 2A·S、νb = 2B·S、S = μ√H/σ"}<br />
            {"→ σ が完全に消え、p は (A,B,S) だけの関数になる。"}</li>
          <li>{"μ=0 の極限: p → B/(A+B)。勝率 = B/(A+B)、期待値 = A·B/(A+B) − B·A/(A+B) = 0（任意停止定理）、標準偏差 = √(AB)·σ√H、歪度 = (A−B)/√(AB)、期待滞在 E[τ] = ab/σ² = AB·H。"}</li>
          <li>{"Wald の等式: X_t − μt が martingale なので E[X_τ] = μ·E[τ]。小 S の展開で p ≈ B/(A+B) + AB·S/(A+B)、E[X_τ] ≈ μ·AB·H。単位時間あたりに直すと E[X_τ]/E[τ] = μ で A,B に依存しない。"}</li>
          <li>{"暦時間シャープ: 期間 T に n = T/(AB·H) 回トレードすると 総期待値 = n·μ·AB·H = μT、総分散 = n·AB·σ²H = σ²T、Sharpe = μT/(σ√T) = μ√T/σ。いずれも A,B に不変。"}</li>
          <li>{"コスト単調性: 往復コスト c を入れると コスト後総期待値 = μT − c·T/(AB·H) となり AB について単調増加。よって期待値基準の最適バリアは常に「外す（持ち切り）」に張り付く。"}</li>
          <li>{"層1の分散比: log TP% = log A + log σ_dow なので、Var[log TP%] と Var[log A] は同じ単位で比較できる。F = Var[log TP%]/Var[log A] を F(k−1,k−1) で評価する。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>バリア</strong>: 建玉を強制的に終了させる価格の壁。上がTP（利確）、下がSL（損切り）。</li>
          <li><strong>σ単位（ボラ単位）</strong>: 幅を「%」でなく「その期間の標準偏差の何倍か」で測ること。銘柄・曜日でボラが違っても比較できる。</li>
          <li><strong>任意停止定理</strong>: 公平な賭け（martingale）は、どんな停止規則で止めても期待値が変わらないという定理。TP/SLで期待値を作れない理由そのもの。</li>
          <li><strong>勝者の呪い</strong>: 多数の候補から最良を選ぶと、選ばれた値には必ず上振れが含まれる現象。N候補なら見かけのt値は √(2 ln N) 程度に膨らむ。</li>
          <li><strong>サロゲート</strong>: 「調べたい構造だけを壊し、他は保存した」人工データ。ここでは曜日ラベルだけをシャッフルする。</li>
          <li><strong>オーバーシュート</strong>: バリアを飛び越して約定すること。ギャップやジャンプで起きる滑り。</li>
          <li><strong>内点解</strong>: 探索範囲の縁ではなく内側に最適点があること。理論上は起きないので、起きたら経路依存性かノイズを疑う。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          {"TP/SL は蛇口の太さではなく、バケツを取り替えるタイミングである。流れ込む水の量（μ×時間）は蛇口が決めるので、バケツを小さくして頻繁に取り替えても総量は増えない。増えるのは取り替え回数（＝コスト）だけ。バケツの大きさで変えられるのは「1回ごとに溢れるか余るか」の見え方（勝率と歪度）である。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>層0</strong>: 赤枠の暦時間シャープは A,B を動かしても数字が変わらない。これが本分析の出発点であり、ここを納得しないまま下の層を読むと必ず誤読する。</li>
          <li><strong>層1の2枚並置</strong>: 左（%単位）で曜日ごとにばらついていた best が、右（σ単位）で一点に集まれば「曜日差の正体は σ_dow」。分散比 F と p で判定する。</li>
          <li><strong>層2の逸脱バー</strong>: ±1.96SE のヒゲが0（理論値）を跨いでいれば逸脱なし。跨がなくても、それが曜日間で共通なら曜日を切る理由にはならない（判定は下の曜日間検定）。</li>
          <li><strong>層3①</strong>: 実測がサロゲート分布の上位5%に入らなければ、曜日ラベルを壊しても同じ絵が出るということ＝曜日差は無い。</li>
          <li><strong>層3②</strong>: ブラウン運動ヌルでも内点解が高頻度で出るなら、内点性は発見ではない。ヌルの到達確率・滞在が理論値からずれている分は離散化と時間切りの機械的効果で、層2の逸脱はその分を差し引いて読む。</li>
          <li><strong>層3③</strong>: 「曜日別 &gt; 共通」でなければ曜日を状態に足す意味がなく、「共通 &gt; バリアなし」でなければバリア自体に意味がない。</li>
          <li><strong>悲観/楽観の帯</strong>: 帯の両端で結論が反転したら「この足では判定不能」。足を細かくするかバリアを広げる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>勝率と歪度は<strong>好みで選べる</strong>。心理的に続けられる形（高勝率なら B&gt;A、宝くじ型なら A&gt;B）を選ぶのは合理的だが、<strong>それでシャープは上がらない</strong>ことを理解して選ぶ。</li>
          <li>SL の正当化は期待値ではなく、レバレッジ下の破産回避（系C22）と最大ドローダウン管理（系C11）で行う。「損切りは期待値を改善する」は誤り。</li>
          <li>回転率（＝コスト）は AB·H で決まる。同じ勝率・歪度なら AB が大きい側を選ぶ方がコスト負けしにくい。</li>
          <li>層3③で「バリアなし」が最良なら、出口は時間切り（引け・週末）に固定し、リスク管理は建玉サイズで行う。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"曜日別μは測れない。7203.T水準（日次σ≈1.8%）で曜日効果 δ=0.1%/日 を t=2 で検出するには n* = (2σ/δ)² = 1296日/曜日 ≈ 26年が必要。H=5日なら t≈0.25、H=15日なら t≈0.19。"}</li>
          <li>{"格子探索の勝者の呪い: 8×8格子×5曜日=320個の in-sample 最大化では、見かけのt値が √(2 ln 320) ≈ 3.40 まで膨らむ。真のシグナル（0.19〜1.24）の3〜18倍。best セルの数字を単独で信じてはいけない。"}</li>
          <li>{"連続時間の閉形式は離散足では近似。60分足なら1日6本前後しかなく、同足内でTP/SLどちらが先かは原理的に分からない。悲観/楽観の帯で挟むのはこのため。"}</li>
          <li>{"数日モードは窓が重なる（毎日エントリー×H日保有）ため、実効標本は n/H 相当。SEを√H倍して報告しているが、これは粗い保守的補正にすぎない。"}</li>
          <li>{"期待滞在の理論値 AB·H は時間切りなしの値。実測は H で打ち切られるため機械的に短くなる。この機械的効果は層3②のブラウン運動ヌルで測る。"}</li>
          <li>{"内点解が出ても、まずノイズを疑う。層3②のヌルで内点頻度が高ければ、それは探索の産物である。"}</li>
          <li>{"本分析は曜日×前夜米国ビン×TP/SL の3重交差を意図的に扱わない（1セル6.5日で議論の対象外）。トレーリングストップも扱わない（パラメータが増えて勝者の呪いが悪化する）。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
