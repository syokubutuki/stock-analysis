"use client";

// 「月曜は下げて始まる」を条件付き現象として解剖する。
// 目的変数(月曜ギャップ/寄り後追随/当日/窓埋め)を、前週末(直前の金曜・木曜)の値動き経路・
// 前夜米国・トレンド/ボラ/需給・カレンダー文脈で層別し、どの経路で顕著か/機能しないかを
// 5つの視点(条件別・2次元交互作用・散布回帰・木金ベクトル・ドライバー寄与)で可視化する。

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { useUsDaily, US_DRIVERS } from "../../hooks/useUsDaily";
import { initCanvas, LoadingError, IntradayCaveat } from "./intradayShared";
import { UsDriverButtons } from "./usSpilloverShared";
import AnalysisGuide from "./AnalysisGuide";
import StatBadge from "./StatBadge";
import {
  buildMondayRecords, latestConditioners, MondayRec,
  CONDITIONERS, TARGETS, condDef, targetDef, fmtCondValue, PCT_KEYS,
  conditionalByBin, heatmap2D, scatterData, quiverData, driverRanking,
  CondResult, HeatResult, ScatterResult, QuiverResult, DriverRow,
} from "../../lib/monday-gap";

interface Props { prices: PricePoint[]; }

const WD = ["日", "月", "火", "水", "木", "金"];
type View = "cond" | "heat" | "scatter" | "quiver" | "driver";
const VIEWS: { value: View; label: string }[] = [
  { value: "cond", label: "① 条件別(単変数)" },
  { value: "heat", label: "② 交互作用ヒートマップ" },
  { value: "scatter", label: "③ 散布図+回帰" },
  { value: "quiver", label: "④ 木金ベクトル" },
  { value: "driver", label: "⑤ ドライバー寄与" },
];
type Ctx = "all" | "post" | "normal" | "mEnd" | "mStart";
const CTXS: { value: Ctx; label: string }[] = [
  { value: "all", label: "全て" },
  { value: "normal", label: "通常週(連休なし)" },
  { value: "post", label: "連休明けのみ" },
  { value: "mStart", label: "月初のみ" },
  { value: "mEnd", label: "月末のみ" },
];

// 発散カラースケール t∈[-1,1]: 負=赤 / 0=白 / 正=緑
function heatColor(t: number): string {
  const c = Math.max(-1, Math.min(1, t));
  if (c >= 0) return `rgb(${Math.round(255 - c * 215)},${Math.round(255 - c * 58)},${Math.round(255 - c * 197)})`;
  const a = -c; return `rgb(${Math.round(255 - a * 35)},${Math.round(255 - a * 217)},${Math.round(255 - a * 217)})`;
}

// 説明変数セレクタ(US不足時はUS系を無効化)。renderの外で宣言(状態保持のため)。
function CondSelect({ value, onChange, label, usMissing }: { value: string; onChange: (v: string) => void; label: string; usMissing: boolean }) {
  return (
    <label className="flex items-center gap-1 text-xs text-gray-600">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="border border-gray-300 rounded px-1.5 py-0.5 text-xs">
        {CONDITIONERS.map((c) => (
          <option key={c.key} value={c.key} disabled={!!c.needsUs && usMissing}>{c.label}{c.needsUs ? " (米)" : ""}</option>
        ))}
      </select>
    </label>
  );
}
const pctText = (v: number, d = 2) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
const rateText = (v: number) => `${(v * 100).toFixed(0)}%`;

// ───────────────────────── Canvas: ① 条件別バー ─────────────────────────
function drawCondBars(ctx: CanvasRenderingContext2D, w: number, h: number, res: CondResult, isRate: boolean) {
  const padL = 44, padR = 12, padT = 14, padB = 40;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const bins = res.bins;
  const vals = bins.flatMap((b) => (isRate ? [b.mean] : [b.mean, b.ciLo, b.ciHi]));
  vals.push(isRate ? res.baselinePos : res.baselineMean);
  const base = isRate ? 0.5 : 0;
  const maxAbs = Math.max(1e-4, ...vals.map((v) => Math.abs(v - base))) * 1.15;
  const yOf = (v: number) => padT + plotH / 2 - ((v - base) / maxAbs) * (plotH / 2);
  // 基準線(0 or 全体平均)
  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, yOf(base)); ctx.lineTo(w - padR, yOf(base)); ctx.stroke();
  // 全体平均の点線
  const baseVal = isRate ? res.baselinePos : res.baselineMean;
  ctx.strokeStyle = "#9333ea"; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(padL, yOf(baseVal)); ctx.lineTo(w - padR, yOf(baseVal)); ctx.stroke();
  ctx.setLineDash([]);
  const bw = plotW / bins.length;
  ctx.font = "10px sans-serif"; ctx.textAlign = "center";
  bins.forEach((b, i) => {
    const cx = padL + bw * (i + 0.5);
    const v = isRate ? b.posRate : b.mean;
    const y0 = yOf(base), y1 = yOf(v);
    ctx.fillStyle = b.color; ctx.globalAlpha = res.nowBin === b.idx ? 1 : 0.75;
    ctx.fillRect(cx - bw * 0.32, Math.min(y0, y1), bw * 0.64, Math.abs(y1 - y0));
    ctx.globalAlpha = 1;
    if (res.nowBin === b.idx) { ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 2; ctx.strokeRect(cx - bw * 0.32, Math.min(y0, y1), bw * 0.64, Math.abs(y1 - y0)); }
    if (!isRate) { // CIひげ
      ctx.strokeStyle = "#374151"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, yOf(b.ciLo)); ctx.lineTo(cx, yOf(b.ciHi));
      ctx.moveTo(cx - 4, yOf(b.ciLo)); ctx.lineTo(cx + 4, yOf(b.ciLo));
      ctx.moveTo(cx - 4, yOf(b.ciHi)); ctx.lineTo(cx + 4, yOf(b.ciHi)); ctx.stroke();
    }
    ctx.fillStyle = "#374151";
    ctx.fillText(b.label, cx, h - padB + 14);
    ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif";
    ctx.fillText(`n=${b.n}`, cx, h - padB + 26);
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#111827";
    ctx.fillText(isRate ? rateText(v) : pctText(v), cx, y1 + (v >= base ? -4 : 12));
    if (res.nowBin === b.idx) { ctx.fillStyle = "#1d4ed8"; ctx.fillText("◀今", cx, padT + 8); }
  });
  // y軸ラベル
  ctx.textAlign = "right"; ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif";
  ctx.fillText(isRate ? "上昇率" : "平均", padL - 6, padT + 8);
}

// ───────────────────────── Canvas: ② ヒートマップ ─────────────────────────
function drawHeat(ctx: CanvasRenderingContext2D, w: number, h: number, res: HeatResult, metric: "mean" | "neg", xLabel: string, yLabel: string) {
  const padL = 84, padR = 14, padT = 16, padB = 40;
  const k = res.k;
  const cellW = (w - padL - padR) / k, cellH = (h - padT - padB) / k;
  const isRate = res.targetKind === "rate";
  ctx.font = "10px sans-serif";
  for (let xi = 0; xi < k; xi++) for (let yi = 0; yi < k; yi++) {
    const cell = res.cells.find((c) => c.xi === xi && c.yi === yi);
    const x = padL + xi * cellW, y = padT + (k - 1 - yi) * cellH; // yiは下から上へ
    if (!cell) { ctx.fillStyle = "#f9fafb"; ctx.fillRect(x, y, cellW - 1, cellH - 1); continue; }
    let t: number, main: string;
    if (metric === "neg") { t = -(cell.negRate - 0.5) / 0.5; main = rateText(cell.negRate); } // 下寄り率高=赤
    else if (isRate) { t = (cell.mean - 0.5) / 0.5; main = rateText(cell.mean); }
    else { t = cell.mean / res.maxAbs; main = pctText(cell.mean); }
    ctx.fillStyle = heatColor(t); ctx.fillRect(x, y, cellW - 1, cellH - 1);
    const isNow = res.nowXi === xi && res.nowYi === yi;
    if (isNow) { ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 3; ctx.strokeRect(x + 1, y + 1, cellW - 3, cellH - 3); }
    ctx.fillStyle = "#111827"; ctx.textAlign = "center";
    ctx.font = "bold 11px sans-serif"; ctx.fillText(main, x + cellW / 2, y + cellH / 2 - 2);
    ctx.font = "9px sans-serif"; ctx.fillStyle = "#4b5563";
    ctx.fillText(`n=${cell.n}${cell.significant ? " ★" : ""}`, x + cellW / 2, y + cellH / 2 + 12);
    if (isNow) { ctx.fillStyle = "#1d4ed8"; ctx.font = "bold 9px sans-serif"; ctx.fillText("今", x + cellW - 10, y + 11); }
  }
  // 軸ラベル
  ctx.fillStyle = "#374151"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
  for (let xi = 0; xi < k; xi++) ctx.fillText(res.xLabels[xi], padL + (xi + 0.5) * cellW, h - padB + 14);
  ctx.textAlign = "right";
  for (let yi = 0; yi < k; yi++) ctx.fillText(res.yLabels[yi], padL - 6, padT + (k - 1 - yi + 0.5) * cellH + 3);
  ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif";
  ctx.textAlign = "center"; ctx.fillText(`X: ${xLabel} →`, (padL + w - padR) / 2, h - 6);
  ctx.save(); ctx.translate(12, (padT + h - padB) / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText(`Y: ${yLabel} →`, 0, 0); ctx.restore();
}

// ───────────────────────── Canvas: ③ 散布図+回帰 ─────────────────────────
function drawScatter(ctx: CanvasRenderingContext2D, w: number, h: number, res: ScatterResult, xIsPct: boolean, yIsRate: boolean, nowX: number | null) {
  const padL = 50, padR = 14, padT = 14, padB = 34;
  const pts = res.points;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs), yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xPad = (xMax - xMin) * 0.05 || 0.01, yPad = (yMax - yMin) * 0.05 || 0.01;
  const xr = [xMin - xPad, xMax + xPad], yr = [yMin - yPad, yMax + yPad];
  const X = (v: number) => padL + ((v - xr[0]) / (xr[1] - xr[0])) * (w - padL - padR);
  const Y = (v: number) => padT + (1 - (v - yr[0]) / (yr[1] - yr[0])) * (h - padT - padB);
  // ゼロ軸
  ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
  if (xr[0] < 0 && xr[1] > 0) { ctx.beginPath(); ctx.moveTo(X(0), padT); ctx.lineTo(X(0), h - padB); ctx.stroke(); }
  const yzero = yIsRate ? 0.5 : 0;
  if (yr[0] < yzero && yr[1] > yzero) { ctx.beginPath(); ctx.moveTo(padL, Y(yzero)); ctx.lineTo(w - padR, Y(yzero)); ctx.stroke(); }
  // 点(前夜米国の符号で着色: 陽=緑, 陰=赤, 不明=灰)
  for (const p of pts) {
    ctx.fillStyle = p.us === null ? "rgba(156,163,175,0.6)" : p.us >= 0 ? "rgba(22,163,74,0.55)" : "rgba(220,38,38,0.55)";
    ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 2.6, 0, Math.PI * 2); ctx.fill();
  }
  // 回帰線
  if (res.reg) {
    ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(xr[0]), Y(res.reg.alpha + res.reg.beta * xr[0]));
    ctx.lineTo(X(xr[1]), Y(res.reg.alpha + res.reg.beta * xr[1])); ctx.stroke();
  }
  // 今の縦線
  if (nowX !== null && nowX >= xr[0] && nowX <= xr[1]) {
    ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(X(nowX), padT); ctx.lineTo(X(nowX), h - padB); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#b45309"; ctx.font = "9px sans-serif"; ctx.textAlign = "center"; ctx.fillText("今", X(nowX), padT + 8);
  }
  // 軸目盛
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  const fx = (v: number) => (xIsPct ? pctText(v, 1) : v.toFixed(2));
  ctx.fillText(fx(xr[0]), padL + 14, h - padB + 12); ctx.fillText(fx(xr[1]), w - padR - 14, h - padB + 12);
  ctx.textAlign = "right";
  ctx.fillText(yIsRate ? rateText(yr[1]) : pctText(yr[1], 1), padL - 4, padT + 8);
  ctx.fillText(yIsRate ? rateText(yr[0]) : pctText(yr[0], 1), padL - 4, h - padB);
}

// ───────────────────────── Canvas: ④ 木金ベクトル散布 ─────────────────────────
function drawQuiver(ctx: CanvasRenderingContext2D, w: number, h: number, res: QuiverResult, isRate: boolean) {
  const pad = 40, size = Math.min(w - pad * 2, h - pad * 2);
  const cx = pad + size / 2, cy = pad + size / 2, R = size / 2;
  const m = res.axisMax;
  const X = (v: number) => cx + (v / m) * R;
  const Y = (v: number) => cy - (v / m) * R;
  // 象限線
  ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(-m), Y(0)); ctx.lineTo(X(m), Y(0)); ctx.moveTo(X(0), Y(-m)); ctx.lineTo(X(0), Y(m)); ctx.stroke();
  // 点: 位置=(木, 金)、色=月曜目的変数の符号/強度、大きさ=|目的変数|
  for (const p of res.points) {
    const t = isRate ? (p.t - 0.5) / 0.5 : p.t / res.tMax;
    ctx.fillStyle = heatColor(t).replace("rgb", "rgba").replace(")", ",0.75)");
    const r = 2 + Math.min(6, (Math.abs(isRate ? p.t - 0.5 : p.t) / (isRate ? 0.5 : res.tMax)) * 6);
    ctx.beginPath(); ctx.arc(X(p.thu), Y(p.fri), r, 0, Math.PI * 2); ctx.fill();
  }
  // 象限ラベル
  ctx.fillStyle = "#9ca3af"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("木↑ 金↑", X(m * 0.6), Y(m * 0.9));
  ctx.fillText("木↓ 金↑", X(-m * 0.6), Y(m * 0.9));
  ctx.fillText("木↑ 金↓", X(m * 0.6), Y(-m * 0.85));
  ctx.fillText("木↓ 金↓", X(-m * 0.6), Y(-m * 0.85));
  ctx.fillStyle = "#6b7280";
  ctx.fillText("→ 木曜リターン", cx, cy + R + 22);
  ctx.save(); ctx.translate(cx - R - 22, cy); ctx.rotate(-Math.PI / 2); ctx.fillText("→ 金曜リターン", 0, 0); ctx.restore();
}

// ───────────────────────── Canvas: ⑤ ドライバー寄与 ─────────────────────────
function drawDrivers(ctx: CanvasRenderingContext2D, w: number, h: number, rows: DriverRow[]) {
  const padL = 150, padR = 40, padT = 8, padB = 8;
  const rowH = (h - padT - padB) / rows.length;
  const cx = padL + (w - padL - padR) / 2;
  const half = (w - padL - padR) / 2;
  const maxAbs = Math.max(0.05, ...rows.map((r) => Math.abs(r.corr)));
  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, h - padB); ctx.stroke();
  ctx.font = "10px sans-serif";
  rows.forEach((r, i) => {
    const y = padT + rowH * (i + 0.5);
    const bw = (r.corr / maxAbs) * half;
    ctx.fillStyle = r.corr >= 0 ? (r.significant ? "#16a34a" : "#86efac") : (r.significant ? "#dc2626" : "#fca5a5");
    ctx.fillRect(Math.min(cx, cx + bw), y - rowH * 0.3, Math.abs(bw), rowH * 0.6);
    // 偏相関(米国統制)を黒縦棒で
    if (r.partialCorr !== null) {
      const px = cx + (r.partialCorr / maxAbs) * half;
      ctx.strokeStyle = "#111827"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, y - rowH * 0.32); ctx.lineTo(px, y + rowH * 0.32); ctx.stroke();
    }
    ctx.fillStyle = "#374151"; ctx.textAlign = "right";
    ctx.fillText(r.label, padL - 6, y + 3);
    ctx.textAlign = "left"; ctx.fillStyle = "#6b7280";
    ctx.fillText(r.corr.toFixed(2) + (r.significant ? "★" : ""), w - padR + 3, y + 3);
  });
}

export default function MondayGapChart({ prices }: Props) {
  const [targetDow, setTargetDow] = useState(1);
  const [usTicker, setUsTicker] = useState("^GSPC");
  const [view, setView] = useState<View>("cond");
  const [targetKey, setTargetKey] = useState("gap");
  const [k, setK] = useState(3);
  const [condKey, setCondKey] = useState("friIntra");
  const [xKey, setXKey] = useState("usRet");
  const [yKey, setYKey] = useState("friIntra");
  const [ctxFilter, setCtxFilter] = useState<Ctx>("all");
  const [heatMetric, setHeatMetric] = useState<"mean" | "neg">("mean");

  const { prices: usPrices, loading: usLoading, error: usError } = useUsDaily(usTicker);

  const build = useMemo(() => buildMondayRecords(prices, usPrices, targetDow), [prices, usPrices, targetDow]);
  const latest = useMemo(() => latestConditioners(prices, usPrices), [prices, usPrices]);

  const recs: MondayRec[] = useMemo(() => {
    const f = build.recs;
    if (ctxFilter === "all") return f;
    if (ctxFilter === "post") return f.filter((r) => r.gapDaysPrev > 3);
    if (ctxFilter === "normal") return f.filter((r) => r.gapDaysPrev <= 3);
    if (ctxFilter === "mStart") return f.filter((r) => r.monthPhase === 0);
    return f.filter((r) => r.monthPhase === 2);
  }, [build, ctxFilter]);

  const nv = latest.values;
  const cond = useMemo<CondResult | null>(() => conditionalByBin(recs, condKey, targetKey, k, nv[condKey] ?? null), [recs, condKey, targetKey, k, nv]);
  const heat = useMemo<HeatResult | null>(() => heatmap2D(recs, xKey, yKey, targetKey, k, nv[xKey] ?? null, nv[yKey] ?? null), [recs, xKey, yKey, targetKey, k, nv]);
  const scatter = useMemo<ScatterResult | null>(() => scatterData(recs, condKey, targetKey, nv[condKey] ?? null), [recs, condKey, targetKey, nv]);
  const quiver = useMemo<QuiverResult | null>(() => quiverData(recs, targetKey), [recs, targetKey]);
  const drivers = useMemo<DriverRow[]>(() => driverRanking(recs, targetKey, build.hasUs), [recs, targetKey, build.hasUs]);

  const condRef = useRef<HTMLCanvasElement>(null);
  const heatRef = useRef<HTMLCanvasElement>(null);
  const scatRef = useRef<HTMLCanvasElement>(null);
  const quivRef = useRef<HTMLCanvasElement>(null);
  const drivRef = useRef<HTMLCanvasElement>(null);

  const td = targetDef(targetKey)!;
  const isRate = td.kind === "rate";

  useEffect(() => {
    if (view !== "cond" || !cond || !condRef.current) return;
    const c = initCanvas(condRef.current, 240); if (c) drawCondBars(c.ctx, c.width, c.height, cond, isRate);
  }, [view, cond, isRate]);
  useEffect(() => {
    if (view !== "heat" || !heat || !heatRef.current) return;
    const c = initCanvas(heatRef.current, 320);
    if (c) drawHeat(c.ctx, c.width, c.height, heat, heatMetric, condDef(xKey)?.label ?? xKey, condDef(yKey)?.label ?? yKey);
  }, [view, heat, heatMetric, xKey, yKey]);
  useEffect(() => {
    if (view !== "scatter" || !scatter || !scatRef.current) return;
    const c = initCanvas(scatRef.current, 300);
    if (c) drawScatter(c.ctx, c.width, c.height, scatter, PCT_KEYS.has(condKey), isRate, nv[condKey] ?? null);
  }, [view, scatter, condKey, isRate, nv]);
  useEffect(() => {
    if (view !== "quiver" || !quiver || !quivRef.current) return;
    const c = initCanvas(quivRef.current, 340); if (c) drawQuiver(c.ctx, c.width, c.height, quiver, isRate);
  }, [view, quiver, isRate]);
  useEffect(() => {
    if (view !== "driver" || drivers.length === 0 || !drivRef.current) return;
    const c = initCanvas(drivRef.current, Math.max(200, drivers.length * 22 + 16)); if (c) drawDrivers(c.ctx, c.width, c.height, drivers);
  }, [view, drivers]);

  const usLabel = US_DRIVERS.find((d) => d.ticker === usTicker)?.label ?? usTicker;
  const usMissing = !build.hasUs;
  const wd = WD[targetDow];

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">{wd}曜の値動きを解剖：どの経路のとき「{wd}曜は下げて始まる」が効くか</h3>
        <UsDriverButtons value={usTicker} onChange={setUsTicker} />
      </div>

      {/* 週初め曜日・目的変数・分割数・文脈 */}
      <div className="flex items-center gap-4 flex-wrap text-xs">
        <div className="flex items-center gap-1">
          <span className="text-gray-500">週初め:</span>
          {[1, 2, 3, 4, 5].map((d) => (
            <button key={d} onClick={() => setTargetDow(d)} className={`px-2 py-0.5 rounded font-medium ${targetDow === d ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{WD[d]}</button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-gray-600">
          目的変数:
          <select value={targetKey} onChange={(e) => setTargetKey(e.target.value)} className="border border-gray-300 rounded px-1.5 py-0.5 text-xs">
            {TARGETS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-1">
          <span className="text-gray-500">分割:</span>
          {[2, 3, 5].map((kk) => (
            <button key={kk} onClick={() => setK(kk)} className={`px-2 py-0.5 rounded font-medium ${k === kk ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{kk}分割</button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-gray-600">
          文脈:
          <select value={ctxFilter} onChange={(e) => setCtxFilter(e.target.value as Ctx)} className="border border-gray-300 rounded px-1.5 py-0.5 text-xs">
            {CTXS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
      </div>

      {/* ビュー切替 */}
      <div className="flex items-center gap-1 flex-wrap border-b border-gray-100 pb-2">
        {VIEWS.map((v) => (
          <button key={v.value} onClick={() => setView(v.value)} className={`px-2.5 py-1 rounded text-xs font-medium ${view === v.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{v.label}</button>
        ))}
      </div>

      {/* 目的変数の説明 */}
      <div className="text-[11px] text-gray-500">
        <span className="font-medium text-gray-700">目的変数:</span> {td.label} — {td.desc}
      </div>

      <LoadingError loading={usLoading} error={usError} />
      {usMissing && !usLoading && (
        <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">前夜米国データが不足しています。米国系の説明変数は選択できません({usLabel})。</div>
      )}

      {/* ① 条件別 */}
      {view === "cond" && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <CondSelect value={condKey} onChange={setCondKey} label="説明変数:" usMissing={usMissing} />
            <span className="text-[11px] text-gray-400">{condDef(condKey)?.desc}</span>
          </div>
          {!cond && <div className="text-xs text-gray-400">標本が不足しています(分割数を減らすか文脈フィルタを緩めてください)。</div>}
          {cond && (
            <>
              <div className="text-[11px] text-gray-500">
                相関 r={cond.corr.toFixed(3)}(p={cond.corrP < 0.001 ? "<.001" : cond.corrP.toFixed(3)})／全体 {isRate ? `上昇率 ${rateText(cond.baselinePos)}` : `平均 ${pctText(cond.baselineMean)}`}・下寄り率 {rateText(cond.baselineNeg)}(n={cond.totalN})。
                {cond.nowValue !== null && <> 直近の{wd}曜前(金曜相当 {latest.friDate})の{condDef(condKey)?.label}={fmtCondValue(condKey, cond.nowValue)} → <span className="font-bold text-blue-700">{cond.bins.find((b) => b.idx === cond.nowBin)?.label ?? "—"}</span> ビン。</>}
              </div>
              <canvas ref={condRef} />
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1 px-2">ビン</th><th className="text-right px-2">範囲</th><th className="text-right px-2">n</th>
                      <th className="text-right px-2">{isRate ? "達成率" : "平均"}</th><th className="text-right px-2">中央値</th>
                      <th className="text-right px-2">下寄り率</th><th className="text-right px-2">95%CI</th><th className="text-center px-2">有意性</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cond.bins.map((b) => {
                      const rng = b.rangeLo === null ? `≤ ${fmtCondValue(condKey, b.rangeHi)}` : b.rangeHi === null ? `≥ ${fmtCondValue(condKey, b.rangeLo)}` : `${fmtCondValue(condKey, b.rangeLo)}〜${fmtCondValue(condKey, b.rangeHi)}`;
                      return (
                        <tr key={b.idx} className={`border-b border-gray-100 ${cond.nowBin === b.idx ? "bg-blue-50" : ""}`}>
                          <td className="py-1 px-2 font-medium"><span className="inline-block w-2.5 h-2.5 rounded-full mr-1 align-middle" style={{ backgroundColor: b.color }} />{b.label}{cond.nowBin === b.idx && <span className="text-blue-600 ml-1">◀今</span>}</td>
                          <td className="text-right px-2 tabular-nums text-gray-500">{rng}</td>
                          <td className="text-right px-2 tabular-nums">{b.n}</td>
                          <td className={`text-right px-2 tabular-nums font-medium ${(isRate ? b.posRate - 0.5 : b.mean) >= 0 ? "text-green-700" : "text-red-700"}`}>{isRate ? rateText(b.posRate) : pctText(b.mean)}</td>
                          <td className="text-right px-2 tabular-nums">{isRate ? "—" : pctText(b.median)}</td>
                          <td className="text-right px-2 tabular-nums text-gray-600">{rateText(b.negRate)}</td>
                          <td className="text-right px-2 tabular-nums text-gray-500">{isRate ? "—" : `[${pctText(b.ciLo)}, ${pctText(b.ciHi)}]`}</td>
                          <td className="text-center px-2"><StatBadge n={b.n} p={b.pAdj} significant={b.significant} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ② ヒートマップ */}
      {view === "heat" && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <CondSelect value={xKey} onChange={setXKey} label="X軸:" usMissing={usMissing} />
            <CondSelect value={yKey} onChange={setYKey} label="Y軸:" usMissing={usMissing} />
            <div className="flex items-center gap-1">
              <span className="text-gray-500 text-xs">色:</span>
              {(["mean", "neg"] as const).map((mm) => (
                <button key={mm} onClick={() => setHeatMetric(mm)} className={`px-2 py-0.5 rounded text-xs font-medium ${heatMetric === mm ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{mm === "mean" ? (isRate ? "達成率" : "平均") : "下寄り率"}</button>
              ))}
            </div>
          </div>
          {!heat && <div className="text-xs text-gray-400">標本が不足しています(分割数を減らすか文脈を緩めてください)。US系は前夜米国データが必要です。</div>}
          {heat && (
            <>
              <div className="text-[11px] text-gray-500">セル値={heatMetric === "neg" ? "下寄り率(赤=高)" : isRate ? "窓埋め達成率" : "月曜目的変数の平均(緑=上/赤=下)"}・★=FDR有意・青枠=直近条件の該当セル。</div>
              <canvas ref={heatRef} />
              <p className="text-[11px] text-gray-400">2要因の掛け合わせで初めて現れるエッジを見る。推奨: X=前夜米国／Y=金曜引けの勢い。米国を統制した上での金曜経路の効き(列内の縦の変化)に注目。</p>
            </>
          )}
        </div>
      )}

      {/* ③ 散布図 */}
      {view === "scatter" && (
        <div className="space-y-3">
          <CondSelect value={condKey} onChange={setCondKey} label="説明変数(X):" usMissing={usMissing} />
          {!scatter && <div className="text-xs text-gray-400">標本が不足しています。</div>}
          {scatter && (
            <>
              <div className="text-[11px] text-gray-500">
                点=各{wd}曜(色: 前夜米国 陽=緑/陰=赤/不明=灰)。
                {scatter.reg && <> 回帰: y={pctText(scatter.reg.alpha, 2)}{scatter.reg.beta >= 0 ? " + " : " − "}{Math.abs(scatter.reg.beta).toFixed(3)}·x｜r={scatter.reg.corr.toFixed(3)}・β p={scatter.reg.pBeta < 0.001 ? "<.001" : scatter.reg.pBeta.toFixed(3)}・βの95%CI [{scatter.betaCI.lo.toFixed(3)}, {scatter.betaCI.hi.toFixed(3)}]</>}
              </div>
              <canvas ref={scatRef} />
              <p className="text-[11px] text-gray-400">傾きβが負なら「その変数が高いほど月曜は下げやすい」。前夜米国の色分けで、同じXでも米国次第で上下が割れる(交絡)かを目視できる。</p>
            </>
          )}
        </div>
      )}

      {/* ④ 木金ベクトル */}
      {view === "quiver" && (
        <div className="space-y-3">
          {!quiver && <div className="text-xs text-gray-400">標本が不足しています。</div>}
          {quiver && (
            <>
              <div className="text-[11px] text-gray-500">位置=(木曜リターン, 金曜リターン)、色/大きさ={td.label}(緑=上/赤=下、大きいほど強い)。前週末2日の値動きベクトルがどの象限のとき月曜が下げるかを見る。</div>
              <canvas ref={quivRef} />
              <p className="text-[11px] text-gray-400">例: 「木↓金↓(左下)」に赤(下寄り)が集まれば、下落継続後の月曜は窓を開けて下げやすい。「木↓金↑(左上)」でリバウンド後の月曜が反落するか等、経路の形と月曜の関係を象限で読む。</p>
            </>
          )}
        </div>
      )}

      {/* ⑤ ドライバー寄与 */}
      {view === "driver" && (
        <div className="space-y-3">
          <div className="text-[11px] text-gray-500">各説明変数と{td.label}の相関(棒)を強い順に。★=FDR有意。黒縦棒=前夜米国を統制した偏相関(米国という交絡を除いても残る効きか)。</div>
          {drivers.length === 0 ? <div className="text-xs text-gray-400">標本が不足しています。</div> : (
            <>
              <canvas ref={drivRef} />
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead><tr className="text-gray-500 border-b border-gray-200"><th className="text-left py-1 px-2">説明変数</th><th className="text-right px-2">n</th><th className="text-right px-2">相関 r</th><th className="text-right px-2">偏相関(米国統制)</th><th className="text-center px-2">有意性</th></tr></thead>
                  <tbody>
                    {drivers.map((r) => (
                      <tr key={r.key} className="border-b border-gray-100">
                        <td className="py-1 px-2">{r.label}{r.needsUs && <span className="text-gray-400"> (米)</span>}</td>
                        <td className="text-right px-2 tabular-nums">{r.n}</td>
                        <td className={`text-right px-2 tabular-nums font-medium ${r.corr >= 0 ? "text-green-700" : "text-red-700"}`}>{r.corr.toFixed(3)}</td>
                        <td className="text-right px-2 tabular-nums text-gray-600">{r.partialCorr === null ? "—" : r.partialCorr.toFixed(3)}</td>
                        <td className="text-center px-2"><StatBadge n={r.n} p={r.pAdj} significant={r.significant} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      <IntradayCaveat extra={`${wd}曜のみを母集団とするため標本は元々少なく(週1回)、さらに分割・文脈で絞ると各セルは薄くなる。5分割や交互作用は多重比較で見かけのパターンが出やすい。★(FDR)とn、95%CIで過剰解釈を防ぐこと。前夜米国は月曜寄りの支配的ドライバなので、金曜経路の効きは必ず「米国を統制した偏相関/列内変化」で確認する。`} />

      <AnalysisGuide title="月曜ギャップ解剖の詳細理論">
        <p className="font-medium text-gray-700">1. 何を計算しているか</p>
        <p>{"「月曜は下げて始まる」という経験則を、常に成り立つ法則としてではなく“ある条件のときだけ強まる/消える条件付き現象”として分解する。目的変数(月曜の寄りギャップ・寄り後追随・当日騰落・窓埋め)を、寄り前に確定している説明変数(直前の金曜/木曜の値動き経路・前夜の米国・トレンド/ボラ/需給・カレンダー文脈)で層別し、どの経路で顕著か・どこで機能しないかを5つの視点で可視化する。"}</p>

        <p className="font-medium text-gray-700 mt-3">2. 変数の定義(すべて対数リターン)</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>目的変数</strong>: 月曜ギャップ=ln(月O/前金C)、寄り後追随=ln(月C/月O)、当日=ln(月C/前金C)=ギャップ+追随、窓埋め=下寄り時に月曜ザラ場が前金C以上に戻したか(0/1)。</li>
          <li><strong>金曜経路</strong>: 引けの勢い=ln(金C/金O)、引けの位置CLV=(金C−金L)/(金H−金L)、金曜前日比=ln(金C/木C)、レンジ=ln(金H/金L)、金曜自身のギャップ=ln(金O/木C)。</li>
          <li><strong>木曜・週</strong>: 木曜=ln(木C/水C)、木金2日ベクトル=ln(金C/水C)、前週5日=ln(金C/5日前C)。</li>
          <li><strong>地合い</strong>: 25日線乖離、実現ボラ(20日σ)、RSI(14)、相対出来高(金曜/20日平均)。</li>
          <li><strong>前夜米国</strong>: 月曜の日付より暦日が厳密に小さい最新の米国立会日=金曜夜のセッション。前日比 ln(C/前C) と日中 ln(C/O)。</li>
          <li><strong>文脈</strong>: 連休明け(直前立会からの暦日数&gt;3)、月内フェーズ(月初/月中/月末)。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 5つの視点(結果の読み方)</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>①条件別</strong>: 説明変数を等頻度ビンに分け、ビンごとの目的変数の平均・下寄り率・95%CI・有意性。単調に変化するか、特定ビンだけ極端かを見る。</li>
          <li><strong>②交互作用ヒートマップ</strong>: 2変数の掛け合わせ。X=前夜米国/Y=金曜引けの勢い が推奨。列内(米国を固定)で縦に変化するなら、米国を除いても効く金曜経路のエッジ。</li>
          <li><strong>③散布図+回帰</strong>: 連続関係と外れ値。傾きβの符号・95%CI・r。点を前夜米国の符号で着色し交絡を目視。</li>
          <li><strong>④木金ベクトル</strong>: 位置=(木,金)リターン、色=月曜の目的変数。どの象限(継続/反転)の翌週が下げるか。</li>
          <li><strong>⑤ドライバー寄与</strong>: 全変数の相関を強い順に。黒縦棒の偏相関(前夜米国を統制)が残れば、その変数は米国の代理ではない独自の効き。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>金曜引け〜前夜米国は月曜寄り前に判明する。上部の「直近→該当ビン/セル」で、次の月曜に下寄りが強まりそうな条件かを寄り前に判定できる。</li>
          <li>下寄りが強い条件かつ「寄り後追随」も下なら寄り売り継続、下寄りだが追随が反発・窓埋め率が高い条件なら寄り底の買い、と目的変数を分けて戦術を選ぶ。</li>
          <li>①→②→⑤の順に、単変数で当たりを付け→交互作用で掛け合わせ→偏相関で交絡を除いて、実運用に残す条件を絞る。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"月曜は週1回しか発生せず標本が少ない。10年でも約500週。分割・文脈・交互作用で急速に痩せるので、n・★(FDR補正済)・95%CIを必ず確認する。"}</li>
          <li>{"前夜米国は月曜寄りの支配的ドライバで、金曜JPとも相関する(多重共線性)。金曜経路の効果は必ず偏相関・列内変化で見て、見かけの相関を掴まない。"}</li>
          <li>{"祝日で月曜が休場なら、週初めは火曜になる。週初め曜日セレクタで対象日を切り替えられるが、連休明けは値動きの性質が変わるため文脈フィルタで分離する。"}</li>
          <li>{"米国指数の選択(S&P500/NASDAQ/SOX/ダウ)で結果は変わる。対象銘柄と連動の強い指数を選ぶ。過去のエッジは将来を保証しない。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
