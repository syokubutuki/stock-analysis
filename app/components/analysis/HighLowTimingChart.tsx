"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import {
  analyzeIntraday,
  conditionalTiming,
  computeDayPaths,
  computeActivityProfile,
  computeWeekdayHLProb,
  minuteToLabel,
  IntradayAnalysis,
  IntradayBar,
  ConditionKey,
  ConditionalTiming,
  WeekdayOverlay,
  ActivityPoint,
  WeekdayHLProb,
} from "../../lib/highlow-timing";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  ticker: string;
}

interface IntradayResponse {
  symbol: string;
  interval: string;
  range: string;
  gmtoffset: number;
  timezone: string;
  bars: IntradayBar[];
  error?: string;
}

const INTERVALS = [
  { value: "5m", label: "5分足", note: "直近約60日" },
  { value: "15m", label: "15分足", note: "直近約60日" },
  { value: "60m", label: "60分足", note: "直近約2年" },
] as const;

type View = "dist" | "hazard" | "path" | "cond" | "profile" | "weekday" | "wdhl" | "activity" | "breakout";
const VIEWS: { value: View; label: string }[] = [
  { value: "dist", label: "時間帯分布" },
  { value: "hazard", label: "到達確率" },
  { value: "path", label: "日中パス" },
  { value: "cond", label: "条件別" },
  { value: "profile", label: "平均形状" },
  { value: "weekday", label: "曜日別軌跡" },
  { value: "wdhl", label: "曜日別 高安時刻" },
  { value: "activity", label: "出来高・ボラ" },
  { value: "breakout", label: "ブレイク" },
];
const CANVAS_VIEWS = new Set<View>(["dist", "hazard", "cond", "profile", "weekday", "wdhl", "activity"]);

// 月〜金の色（曜日別軌跡で使用）
const WD_COLORS: Record<number, string> = {
  1: "#2563eb", 2: "#16a34a", 3: "#d97706", 4: "#db2777", 5: "#7c3aed",
};
const WD_NAMES: Record<number, string> = { 1: "月", 2: "火", 3: "水", 4: "木", 5: "金" };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
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

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
function signedPct(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
}

// ───────────────────────── 描画ヘルパ ─────────────────────────

function drawTimeAxis(ctx: CanvasRenderingContext2D, a: IntradayAnalysis, ml: number, slot: number, y: number) {
  const n = a.bins.length;
  ctx.fillStyle = "#6b7280";
  ctx.font = "8px sans-serif";
  ctx.textAlign = "center";
  const every = n > 14 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    if (i % every !== 0) continue;
    ctx.fillText(a.bins[i].label, ml + i * slot + slot / 2, y);
  }
}

function drawDistribution(ctx: CanvasRenderingContext2D, W: number, H: number, a: IntradayAnalysis) {
  const ml = 44, mr = 16, mt = 24, gap = 36;
  const plotW = W - ml - mr;
  const paneH = (H - mt - gap - 24) / 2;
  const n = a.bins.length;
  const slot = plotW / n;
  const barW = Math.max(2, slot * 0.7);
  const maxHigh = Math.max(1, ...a.highCounts);
  const maxLow = Math.max(1, ...a.lowCounts);

  const pane = (counts: number[], maxV: number, top: number, color: string, title: string, medMin: number) => {
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, top, plotW, paneH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(title, ml, top - 7);
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    ctx.fillText("0", ml - 5, top + paneH); ctx.fillText(String(maxV), ml - 5, top + 9);
    for (let i = 0; i < n; i++) {
      const h = (counts[i] / maxV) * (paneH - 6);
      const x = ml + i * slot + (slot - barW) / 2;
      const y = top + paneH - h;
      ctx.fillStyle = color; ctx.fillRect(x, y, barW, h);
      if (counts[i] > 0) {
        ctx.fillStyle = "#6b7280"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
        ctx.fillText(String(counts[i]), x + barW / 2, y - 2);
      }
    }
    const mIdx = (medMin - a.bins[0].startMinute) / a.binMinutes;
    const mx = ml + Math.max(0, Math.min(n, mIdx)) * slot;
    ctx.strokeStyle = "#111827"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(mx, top); ctx.lineTo(mx, top + paneH); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#111827"; ctx.font = "8px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(`中央値 ${minuteToLabel(medMin)}`, mx + 3, top + 9);
  };

  pane(a.highCounts, maxHigh, mt, "#ef4444cc", "高値が付いた時間帯（日数）", a.highMedianMinute);
  pane(a.lowCounts, maxLow, mt + paneH + gap, "#3b82f6cc", "安値が付いた時間帯（日数）", a.lowMedianMinute);
  drawTimeAxis(ctx, a, ml, slot, mt + paneH + gap + paneH + 12);
}

function drawHazard(ctx: CanvasRenderingContext2D, W: number, H: number, a: IntradayAnalysis) {
  const ml = 40, mr = 16, mt = 30, mb = 28;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = a.bins.length;
  const slot = plotW / n;
  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("その時刻までに高値／安値が出ている確率", ml, mt - 12);

  // y目盛
  ctx.textAlign = "right"; ctx.font = "9px sans-serif";
  for (let p = 0; p <= 1.0001; p += 0.25) {
    const y = mt + plotH - p * plotH;
    ctx.strokeStyle = "#eee"; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke();
    ctx.fillStyle = "#9ca3af"; ctx.fillText(`${(p * 100).toFixed(0)}%`, ml - 4, y + 3);
  }

  const line = (cdf: number[], color: string) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = ml + i * slot + slot / 2;
      const y = mt + plotH - cdf[i] * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  line(a.highCdf, "#ef4444");
  line(a.lowCdf, "#3b82f6");

  drawTimeAxis(ctx, a, ml, slot, mt + plotH + 14);
  // 凡例
  ctx.textAlign = "left"; ctx.font = "9px sans-serif";
  ctx.fillStyle = "#ef4444"; ctx.fillText("■ 高値到達", ml + 4, mt + 12);
  ctx.fillStyle = "#3b82f6"; ctx.fillText("■ 安値到達", ml + 70, mt + 12);
}

function drawConditional(ctx: CanvasRenderingContext2D, W: number, H: number, a: IntradayAnalysis, c: ConditionalTiming) {
  const ml = 40, mr = 16, mt = 26, gap = 34;
  const plotW = W - ml - mr;
  const paneH = (H - mt - gap - 24) / 2;
  const n = a.bins.length;
  const slot = plotW / n;
  const bw = Math.max(2, slot * 0.36);

  // 群サイズが違うので「その群内シェア(%)」で比較する
  const shareT = (cts: number[], nT: number) => cts.map((v) => (nT ? v / nT : 0));
  const hiT = shareT(c.highCountsTrue, c.nTrue), hiF = shareT(c.highCountsFalse, c.nFalse);
  const loT = shareT(c.lowCountsTrue, c.nTrue), loF = shareT(c.lowCountsFalse, c.nFalse);

  const pane = (sT: number[], sF: number[], top: number, title: string) => {
    const maxV = Math.max(0.01, ...sT, ...sF);
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, top, plotW, paneH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(title, ml, top - 6);
    for (let i = 0; i < n; i++) {
      const xc = ml + i * slot + slot / 2;
      const hT = (sT[i] / maxV) * (paneH - 4);
      const hF = (sF[i] / maxV) * (paneH - 4);
      ctx.fillStyle = "#f59e0bdd"; ctx.fillRect(xc - bw - 1, top + paneH - hT, bw, hT);
      ctx.fillStyle = "#6366f1aa"; ctx.fillRect(xc + 1, top + paneH - hF, bw, hF);
    }
  };
  pane(hiT, hiF, mt, "高値の時間帯（群内シェア）");
  pane(loT, loF, mt + paneH + gap, "安値の時間帯（群内シェア）");
  drawTimeAxis(ctx, a, ml, slot, mt + paneH + gap + paneH + 12);

  // 凡例
  ctx.textAlign = "left"; ctx.font = "9px sans-serif";
  ctx.fillStyle = "#f59e0b"; ctx.fillText(`■ ${c.trueLabel}（n=${c.nTrue}）`, ml + 4, mt + 11);
  ctx.fillStyle = "#6366f1"; ctx.fillText(`■ ${c.falseLabel}（n=${c.nFalse}）`, ml + 4, mt + 23);
}

function drawProfile(ctx: CanvasRenderingContext2D, W: number, H: number, a: IntradayAnalysis) {
  const ml = 44, mr = 16, mt = 28, mb = 28;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = a.profile.length;
  const slot = plotW / n;
  const xs = (i: number) => ml + i * slot + slot / 2;

  const lo: number[] = [], hi: number[] = [];
  for (const p of a.profile) { lo.push(p.meanPct - p.sdPct); hi.push(p.meanPct + p.sdPct); }
  const vmax = Math.max(0.1, ...hi, ...a.profile.map((p) => p.meanUpPct));
  const vmin = Math.min(-0.1, ...lo, ...a.profile.map((p) => p.meanDownPct));
  const ys = (v: number) => mt + plotH - ((v - vmin) / (vmax - vmin)) * plotH;

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("平均日中プロファイル（始値からの平均変化率%）", ml, mt - 12);

  // 0ライン
  const y0 = ys(0);
  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, y0); ctx.lineTo(ml + plotW, y0); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText("0%", ml - 4, y0 + 3);
  ctx.fillText(`${vmax.toFixed(2)}`, ml - 4, mt + 9);
  ctx.fillText(`${vmin.toFixed(2)}`, ml - 4, mt + plotH);

  // ±1σ帯
  ctx.fillStyle = "#9ca3af33"; ctx.beginPath();
  for (let i = 0; i < n; i++) { const x = xs(i), y = ys(hi[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(xs(i), ys(lo[i]));
  ctx.closePath(); ctx.fill();

  const drawLine = (vals: number[], color: string, width: number, dash: number[] = []) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = xs(i), y = ys(vals[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke(); ctx.setLineDash([]);
  };
  drawLine(a.profile.map((p) => p.meanUpPct), "#22c55e", 1, [4, 3]);
  drawLine(a.profile.map((p) => p.meanDownPct), "#ef4444", 1, [4, 3]);
  drawLine(a.profile.map((p) => p.meanPct), "#111827", 2);

  drawTimeAxis(ctx, a, ml, slot, mt + plotH + 14);
  ctx.textAlign = "left"; ctx.font = "9px sans-serif";
  ctx.fillStyle = "#111827"; ctx.fillText("― 全日平均", ml + 4, mt + 11);
  ctx.fillStyle = "#22c55e"; ctx.fillText("― 陽線日", ml + 70, mt + 11);
  ctx.fillStyle = "#ef4444"; ctx.fillText("― 陰線日", ml + 130, mt + 11);
}

function drawWeekday(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  a: IntradayAnalysis, ov: WeekdayOverlay,
  showSpaghetti: boolean, wdFilter: number | null,
  colorMode: "weekday" | "direction", yZoom: number
) {
  const ml = 44, mr = 16, mt = 28, mb = 28;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = ov.bins.length;
  const slot = plotW / n;
  const xs = (i: number) => ml + i * slot + slot / 2;

  const considered = ov.paths.filter((p) => wdFilter == null || p.weekday === wdFilter);
  // 個別日の外れ値で潰れないよう 2〜98 パーセンタイルでスケール、平均線と0は必ず含める
  const flat: number[] = [];
  for (const p of considered) for (const v of p.values) flat.push(v);
  flat.sort((x, y) => x - y);
  let vmax = Math.max(0.2, percentile(flat, 98));
  let vmin = Math.min(-0.2, percentile(flat, 2));
  for (const wm of ov.weekdayMean) {
    if (wdFilter != null && wm.weekday !== wdFilter) continue;
    if (wm.count === 0) continue;
    for (const v of wm.mean) { if (v > vmax) vmax = v; if (v < vmin) vmin = v; }
  }
  // ズーム: 0を固定したまま縦軸の振幅を拡大/縮小
  vmax /= yZoom; vmin /= yZoom;
  const ys = (v: number) => mt + plotH - ((v - vmin) / (vmax - vmin)) * plotH;

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(
    colorMode === "weekday" ? "曜日別 日中軌跡（始値からの変化率%）" : "日中軌跡 当日方向別（始値からの変化率%）",
    ml, mt - 12
  );

  // 0ライン・y目盛
  const y0 = ys(0);
  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, y0); ctx.lineTo(ml + plotW, y0); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText("0%", ml - 4, y0 + 3);
  ctx.fillText(vmax.toFixed(2), ml - 4, mt + 9);
  ctx.fillText(vmin.toFixed(2), ml - 4, mt + plotH);

  // プロット領域でクリップ（個別日の外れ値・ズームによるはみ出しを抑える）
  ctx.save();
  ctx.beginPath(); ctx.rect(ml, mt, plotW, plotH); ctx.clip();

  const drawPath = (vals: number[], color: string, width: number) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = xs(i), y = ys(vals[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  };

  if (colorMode === "weekday") {
    if (showSpaghetti) for (const p of considered) drawPath(p.values, WD_COLORS[p.weekday] + "22", 0.6);
    for (const wm of ov.weekdayMean) {
      if (wdFilter != null && wm.weekday !== wdFilter) continue;
      if (wm.count === 0) continue;
      drawPath(wm.mean, WD_COLORS[wm.weekday], 2.2);
    }
  } else {
    // 当日方向別: 陽線日=緑 / 陰線日=赤。太線はそれぞれの平均軌跡
    const up = considered.filter((p) => p.endPct > 0);
    const dn = considered.filter((p) => p.endPct <= 0);
    if (showSpaghetti) {
      for (const p of up) drawPath(p.values, "#22c55e22", 0.6);
      for (const p of dn) drawPath(p.values, "#ef444422", 0.6);
    }
    const meanOf = (ps: typeof considered) => {
      const m = new Array(n).fill(0);
      for (let i = 0; i < n; i++) m[i] = ps.length ? ps.reduce((s, p) => s + p.values[i], 0) / ps.length : 0;
      return m;
    };
    if (up.length) drawPath(meanOf(up), "#16a34a", 2.4);
    if (dn.length) drawPath(meanOf(dn), "#dc2626", 2.4);
  }
  ctx.restore();

  drawTimeAxis(ctx, a, ml, slot, mt + plotH + 14);
}

// 時間帯別 出来高・ボラ プロファイル（上: 出来高シェア / 下: 平均値幅%）
function drawActivity(ctx: CanvasRenderingContext2D, W: number, H: number, a: IntradayAnalysis, act: ActivityPoint[]) {
  const ml = 44, mr = 16, mt = 24, gap = 36;
  const plotW = W - ml - mr;
  const paneH = (H - mt - gap - 24) / 2;
  const n = act.length;
  const slot = plotW / n;
  const barW = Math.max(2, slot * 0.7);

  const pane = (vals: number[], top: number, color: string, title: string, fmt: (v: number) => string) => {
    const maxV = Math.max(1e-9, ...vals);
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, top, plotW, paneH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(title, ml, top - 7);
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    ctx.fillText("0", ml - 5, top + paneH); ctx.fillText(fmt(maxV), ml - 5, top + 9);
    for (let i = 0; i < n; i++) {
      const h = (vals[i] / maxV) * (paneH - 6);
      const x = ml + i * slot + (slot - barW) / 2;
      ctx.fillStyle = color; ctx.fillRect(x, top + paneH - h, barW, h);
    }
  };
  pane(act.map((p) => p.volumeShare), mt, "#0ea5e9cc", "出来高プロファイル（1日出来高に占める割合）", (v) => `${(v * 100).toFixed(0)}%`);
  pane(act.map((p) => p.meanRangePct), mt + paneH + gap, "#f43f5ecc", "時間帯別ボラティリティ（平均値幅 (高-安)/価格 %）", (v) => `${v.toFixed(2)}%`);
  drawTimeAxis(ctx, a, ml, slot, mt + paneH + gap + paneH + 12);
}

// 曜日 × 時刻 の高安出現確率ヒートマップ（上: 高値 / 下: 安値）。行内最大で正規化し各曜日のピーク時刻を強調
function drawWeekdayHL(ctx: CanvasRenderingContext2D, W: number, H: number, a: IntradayAnalysis, data: WeekdayHLProb[]) {
  const ml = 30, mr = 16, mt = 24, gap = 30;
  const plotW = W - ml - mr;
  const blockH = (H - mt - gap - 22) / 2;
  const rowH = blockH / 5;
  const n = a.bins.length;
  const cellW = plotW / n;

  const block = (top: number, key: "highProb" | "lowProb", peakKey: "highPeakMinute" | "lowPeakMinute", title: string, hue: (t: number) => string) => {
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(title, ml, top - 6);
    data.forEach((wd, r) => {
      const y = top + r * rowH;
      const probs = wd[key];
      const rowMax = Math.max(1e-9, ...probs);
      for (let i = 0; i < n; i++) {
        const t = probs[i] / rowMax; // 行内正規化
        ctx.fillStyle = hue(t);
        ctx.fillRect(ml + i * cellW, y, cellW + 0.5, rowH - 1);
      }
      // ピーク時刻にマーカー
      const peakIdx = (wd[peakKey] - a.bins[0].startMinute) / a.binMinutes;
      if (wd.count > 0 && peakIdx >= 0) {
        ctx.strokeStyle = "#111827"; ctx.lineWidth = 1;
        ctx.strokeRect(ml + peakIdx * cellW, y + 0.5, cellW, rowH - 2);
      }
      ctx.fillStyle = "#374151"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(WD_NAMES[wd.weekday], ml - 3, y + rowH / 2 + 3);
    });
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, top, plotW, blockH);
  };

  block(mt, "highProb", "highPeakMinute", "高値の出現確率（曜日×時刻・行内で正規化／枠=ピーク）", (t) => `rgba(239,68,68,${0.12 + t * 0.85})`);
  block(mt + blockH + gap, "lowProb", "lowPeakMinute", "安値の出現確率（曜日×時刻・行内で正規化／枠=ピーク）", (t) => `rgba(59,130,246,${0.12 + t * 0.85})`);
  drawTimeAxis(ctx, a, ml, cellW, mt + blockH + gap + blockH + 12);
}

// ───────────────────────── コンポーネント ─────────────────────────

export default function HighLowTimingChart({ ticker }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [intervalKey, setIntervalKey] = useState<string>("5m");
  const [view, setView] = useState<View>("dist");
  const [condKey, setCondKey] = useState<ConditionKey>("gapUp");
  const [showSpaghetti, setShowSpaghetti] = useState(true);
  const [wdFilter, setWdFilter] = useState<number | null>(null);
  const [colorMode, setColorMode] = useState<"weekday" | "direction">("weekday");
  const [yZoom, setYZoom] = useState(1);
  const [resp, setResp] = useState<IntradayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    // ticker/足種の変更時にデータ取得を開始する正規の副作用。即時にローディング状態へ。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setError(null); setResp(null);
    fetch(`/api/intraday?ticker=${encodeURIComponent(ticker)}&interval=${intervalKey}`)
      .then(async (r) => {
        const json = (await r.json()) as IntradayResponse;
        if (cancelled) return;
        if (!r.ok) { setError(json.error || "日中足の取得に失敗しました"); return; }
        setResp(json);
      })
      .catch(() => { if (!cancelled) setError("ネットワークエラー"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticker, intervalKey]);

  const analysis: IntradayAnalysis | null = useMemo(() => {
    if (!resp || resp.bars.length === 0) return null;
    return analyzeIntraday(resp.bars, resp.gmtoffset, 30, 30);
  }, [resp]);

  const cond: ConditionalTiming | null = useMemo(() => {
    if (!analysis) return null;
    return conditionalTiming(analysis, condKey);
  }, [analysis, condKey]);

  const overlay: WeekdayOverlay | null = useMemo(() => {
    if (!analysis) return null;
    return computeDayPaths(analysis);
  }, [analysis]);

  const activity: ActivityPoint[] | null = useMemo(() => {
    if (!analysis) return null;
    return computeActivityProfile(analysis);
  }, [analysis]);

  const wdhl: WeekdayHLProb[] | null = useMemo(() => {
    if (!analysis) return null;
    return computeWeekdayHLProb(analysis);
  }, [analysis]);

  useEffect(() => {
    if (!canvasRef.current || !analysis || !CANVAS_VIEWS.has(view)) return;
    const H = 360;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width } = init;
    if (view === "dist") drawDistribution(ctx, width, H, analysis);
    else if (view === "hazard") drawHazard(ctx, width, H, analysis);
    else if (view === "profile") drawProfile(ctx, width, H, analysis);
    else if (view === "cond" && cond) drawConditional(ctx, width, H, analysis, cond);
    else if (view === "weekday" && overlay) drawWeekday(ctx, width, H, analysis, overlay, showSpaghetti, wdFilter, colorMode, yZoom);
    else if (view === "activity" && activity) drawActivity(ctx, width, H, analysis, activity);
    else if (view === "wdhl" && wdhl) drawWeekdayHL(ctx, width, H, analysis, wdhl);
  }, [analysis, view, cond, overlay, showSpaghetti, wdFilter, colorMode, yZoom, activity, wdhl]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">高値・安値の時間帯分析</h3>
        <div className="flex gap-1">
          {INTERVALS.map((iv) => (
            <button
              key={iv.value}
              onClick={() => setIntervalKey(iv.value)}
              title={iv.note}
              className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                intervalKey === iv.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {iv.label}
            </button>
          ))}
        </div>
      </div>

      {/* ビュー切替 */}
      <div className="flex gap-1 flex-wrap">
        {VIEWS.map((v) => (
          <button
            key={v.value}
            onClick={() => setView(v.value)}
            className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
              view === v.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {loading && <div className="text-sm text-gray-400 py-8 text-center">日中足を取得中...</div>}
      {error && <div className="bg-amber-50 text-amber-700 rounded-lg p-3 text-sm">{error}</div>}

      {analysis && !loading && (
        <>
          <div className="text-xs text-gray-500">
            対象 {analysis.nDays} 営業日 / {resp?.interval} 足 /
            取引所時刻 {minuteToLabel(analysis.sessionStartMinute)}–{minuteToLabel(analysis.sessionEndMinute)}
            {resp?.timezone ? `（${resp.timezone}）` : ""}
          </div>

          {/* 条件セレクタ（条件別ビューのみ） */}
          {view === "cond" && (
            <div className="flex gap-1">
              {([
                { k: "gapUp", l: "ギャップ方向" },
                { k: "prevUp", l: "前日の方向" },
                { k: "trendUp", l: "トレンド" },
              ] as { k: ConditionKey; l: string }[]).map((o) => (
                <button
                  key={o.k}
                  onClick={() => setCondKey(o.k)}
                  className={`px-2 py-0.5 text-xs rounded ${
                    condKey === o.k ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {o.l}
                </button>
              ))}
            </div>
          )}

          {/* 曜日別軌跡のコントロール */}
          {view === "weekday" && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex gap-1">
                <button
                  onClick={() => setWdFilter(null)}
                  className={`px-2 py-0.5 text-xs rounded ${wdFilter == null ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                >全</button>
                {[1, 2, 3, 4, 5].map((wd) => (
                  <button
                    key={wd}
                    onClick={() => setWdFilter(wdFilter === wd ? null : wd)}
                    className="px-2 py-0.5 text-xs rounded font-medium"
                    style={wdFilter === wd
                      ? { backgroundColor: WD_COLORS[wd], color: "#fff" }
                      : { backgroundColor: "#f3f4f6", color: WD_COLORS[wd] }}
                  >{WD_NAMES[wd]}</button>
                ))}
              </div>
              <button
                onClick={() => setShowSpaghetti((s) => !s)}
                className={`px-2 py-0.5 text-xs rounded ${showSpaghetti ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
              >個別日 {showSpaghetti ? "表示" : "非表示"}</button>
              {/* 色分けモード */}
              <div className="flex gap-1">
                <button
                  onClick={() => setColorMode("weekday")}
                  className={`px-2 py-0.5 text-xs rounded ${colorMode === "weekday" ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                >曜日色</button>
                <button
                  onClick={() => setColorMode("direction")}
                  className={`px-2 py-0.5 text-xs rounded ${colorMode === "direction" ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                >当日方向</button>
              </div>
              {/* 縦軸ズーム */}
              <div className="flex items-center gap-1 ml-1">
                <button onClick={() => setYZoom((z) => Math.max(0.5, +(z / 1.4).toFixed(3)))} className="px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-600 hover:bg-gray-200">－</button>
                <span className="text-xs text-gray-500 w-10 text-center">×{yZoom.toFixed(1)}</span>
                <button onClick={() => setYZoom((z) => Math.min(20, +(z * 1.4).toFixed(3)))} className="px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-600 hover:bg-gray-200">＋</button>
                <button onClick={() => setYZoom(1)} className="px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-600 hover:bg-gray-200">リセット</button>
              </div>
            </div>
          )}

          {/* キャンバス系ビュー */}
          {CANVAS_VIEWS.has(view) && (
            <div className="relative"><canvas ref={canvasRef} /></div>
          )}

          {/* 曜日別の凡例・引け平均（曜日色モードのみ） */}
          {view === "weekday" && overlay && colorMode === "weekday" && (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 text-xs">
              {overlay.weekdayMean.map((wm) => (
                <div key={wm.weekday} className="bg-gray-50 rounded p-2">
                  <div className="flex items-center gap-1">
                    <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: WD_COLORS[wm.weekday] }} />
                    <span className="text-gray-600">{WD_NAMES[wm.weekday]}曜（{wm.count}日）</span>
                  </div>
                  <div className={`font-bold ${wm.endMean >= 0 ? "text-green-600" : "text-red-600"}`}>
                    引け平均 {wm.endMean >= 0 ? "+" : ""}{wm.endMean.toFixed(2)}%
                  </div>
                </div>
              ))}
            </div>
          )}
          {view === "weekday" && (
            <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
              {colorMode === "weekday"
                ? "太線=曜日ごとの平均軌跡、細線=各営業日の実際の軌跡（始値比%）。曜日ボタンで1曜日だけ抽出、＋/－で縦軸を拡大縮小できる。特定曜日が右肩上がり/下がりに偏れば曜日アノマリーの執行時間帯まで判断できる（例: 月曜は寄り安後場高 → 月曜寄り買い）。"
                : "緑=陽線で引けた日、赤=陰線で引けた日。太線は各々の平均軌跡。上昇日と下落日で日中の形が違えば（例: 上昇日は寄り後すぐ伸びる／下落日はじり安）、早い時間の値動きから当日の方向を見極めるヒントになる。"}
            </p>
          )}

          {/* 出来高・ボラ の所見 */}
          {view === "activity" && activity && (
            <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
              {"上=時間帯ごとの平均出来高シェア、下=平均値幅(高-安)/価格。出来高と値幅が膨らむ時間帯ほど約定しやすく動きやすい。高安がこの活況時間帯に出ているほど『出来高を伴う本物の高安』と読め、薄商いの時間に付いた極値はだましの可能性が高い。"}
            </p>
          )}

          {/* 曜日別 高安時刻 の所見・ピーク表 */}
          {view === "wdhl" && wdhl && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                {wdhl.map((wd) => (
                  <div key={wd.weekday} className="bg-gray-50 rounded p-2">
                    <div className="text-gray-600">{WD_NAMES[wd.weekday]}曜（{wd.count}日）</div>
                    <div className="text-red-600 font-bold">高値 {minuteToLabel(wd.highPeakMinute)}</div>
                    <div className="text-blue-600 font-bold">安値 {minuteToLabel(wd.lowPeakMinute)}</div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
                {"各曜日で高値（上段・赤）／安値（下段・青）が最も出やすい時刻を色の濃さで示す（行ごとに最大=1で正規化、黒枠=ピーク時刻）。曜日によってピークがずれるなら、その曜日に合わせて押し目買い・利確の時刻を変える根拠になる。"}
              </p>
            </>
          )}

          {/* 分布ビューの統計 */}
          {view === "dist" && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <Stat label="高値が寄り直後" value={pct(analysis.highOpenShare)} />
              <Stat label="高値が引け直前" value={pct(analysis.highCloseShare)} />
              <Stat label="安値が寄り直後" value={pct(analysis.lowOpenShare)} />
              <Stat label="安値が引け直前" value={pct(analysis.lowCloseShare)} />
              <Stat label="高値時刻の中央値" value={minuteToLabel(analysis.highMedianMinute)} />
              <Stat label="安値時刻の中央値" value={minuteToLabel(analysis.lowMedianMinute)} />
              <Stat label="高安どちらが先か" value={analysis.highMedianMinute < analysis.lowMedianMinute ? "高値が先(上→下)" : "安値が先(下→上)"} />
              <Stat label="高安同時バー" value={`${analysis.sameBarDays}日 (${pct(analysis.sameBarDays / analysis.nDays)})`} />
            </div>
          )}

          {/* 到達確率の所見 */}
          {view === "hazard" && (
            <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
              {"曲線は「その時刻までに当日の高値／安値がすでに付いている確率」。例えば高値曲線が60%に達した時刻を過ぎてまだ新高値が出ていなければ、本日高値はこれから出る可能性が高いと読める。利確・高値追い・ストップ設置の時間帯判断に使う。"}
            </p>
          )}

          {/* 日中パス（HTML表） */}
          {view === "path" && (
            <div className="space-y-2">
              <div className="text-xs text-gray-600">
                高値先行（高値が安値より先）: <strong>{pct(analysis.highFirstShare)}</strong> ／
                安値先行: <strong>{pct(1 - analysis.highFirstShare)}</strong>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1">パス類型</th>
                      <th className="text-right">頻度</th>
                      <th className="text-right">当日R</th>
                      <th className="text-right">翌日R</th>
                      <th className="text-right">翌日勝率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.paths.map((p) => (
                      <tr key={p.key} className="border-b border-gray-100">
                        <td className="py-1">
                          <div className="font-medium text-gray-800">{p.label}</div>
                          <div className="text-gray-400">{p.desc}</div>
                        </td>
                        <td className="text-right">{pct(p.share)}<br /><span className="text-gray-400">{p.count}日</span></td>
                        <td className={`text-right ${p.avgDayRet >= 0 ? "text-green-600" : "text-red-600"}`}>{signedPct(p.avgDayRet)}</td>
                        <td className={`text-right ${p.avgNextRet >= 0 ? "text-green-600" : "text-red-600"}`}>{signedPct(p.avgNextRet)}</td>
                        <td className={`text-right ${p.winRateNext > 0.52 ? "text-green-600" : p.winRateNext < 0.48 ? "text-red-600" : "text-gray-600"}`}>{pct(p.winRateNext)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-gray-400">{"当日R=寄り→引け、翌日R=翌日の終値→終値。翌日Rと勝率は各類型がどれだけ翌日方向を示唆するかを表す（n少の類型は参考程度）。"}</p>
            </div>
          )}

          {/* 条件別の所見 */}
          {view === "cond" && cond && (
            <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
              {cond.trueLabel}は高値が寄り直後に付く割合 <strong>{pct(cond.highOpenShareTrue)}</strong>、
              {cond.falseLabel}は <strong>{pct(cond.highOpenShareFalse)}</strong>。
              {cond.highOpenShareTrue - cond.highOpenShareFalse > 0.1
                ? `→ ${cond.trueLabel}は寄り天になりやすく、戻り売り・ギャップフェードが効きやすい。`
                : cond.highOpenShareFalse - cond.highOpenShareTrue > 0.1
                ? `→ ${cond.falseLabel}の方が寄り高で付きやすい。`
                : "→ 条件による寄り天傾向の差は小さい。"}
            </p>
          )}

          {/* ブレイク（HTMLバー） */}
          {view === "breakout" && (
            <div className="space-y-2">
              <div className="text-xs text-gray-500">オープニングレンジ = 寄り後 {analysis.breakout.orMinutes} 分</div>
              <Bar label="当日高値がOR内で確定" value={analysis.breakout.highInOrShare} />
              <Bar label="当日安値がOR内で確定" value={analysis.breakout.lowInOrShare} />
              <Bar label={`OR上抜け後 引けも上で終了（追随）`} value={analysis.breakout.upFollowThrough} note={`n=${analysis.breakout.upBreakDays}`} color="#22c55e" />
              <Bar label={`OR下抜け後 引けも下で終了（追随）`} value={analysis.breakout.downFollowThrough} note={`n=${analysis.breakout.downBreakDays}`} color="#ef4444" />
              <Bar label="前日高値タッチ→引けも超で維持" value={analysis.breakout.prevHighHoldShare} note={`タッチ率 ${pct(analysis.breakout.prevHighTouchShare)}`} color="#22c55e" />
              <Bar label="前日安値タッチ→引けも割れで維持" value={analysis.breakout.prevLowHoldShare} note={`タッチ率 ${pct(analysis.breakout.prevLowTouchShare)}`} color="#ef4444" />
              <p className="text-xs text-gray-400">{"追随率が高いほどブレイクは「本物」（順張り有利）、低いほど「だまし」が多い（逆張り・ブレイク後の戻り狙いが有利）。"}</p>
            </div>
          )}
        </>
      )}

      <AnalysisGuide title="高値・安値の時間帯分析の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"日足OHLCには「高値・安値が何時に付いたか」の情報が無いため、実際の日中足(5分足など)を取得し、各営業日の高値/安値を付けたバーの取引所ローカル時刻を特定する。単なる時刻分布に留めず、(1)時間帯分布、(2)到達確率、(3)日中パス類型、(4)条件別分布、(5)ブレイク追随の5視点で、日中の値動きの癖を取引判断に落とし込む。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 各ビューの内容と数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>時間帯分布</strong>: 各日の高値時刻 t_H(d)=argmax_t High_t、安値時刻 t_L(d)=argmin_t Low_t を30分刻みで集計。同値は最初のタッチを採用。</li>
          <li><strong>到達確率</strong>: 累積分布 F_H(t)=#{`{d: t_H(d)≤t}`}/N。「時刻tまでに高値が出ている確率」。安値も同様。</li>
          <li><strong>日中パス</strong>: 高安の順序(highFirst = t_H&lt;t_L)と引け方向(sign(close−open))で4類型に分け、各類型の当日リターンと翌日リターン・勝率を集計。順序は日中の方向と勢いを表す。</li>
          <li><strong>条件別</strong>: ギャップ g=(open−prevClose)/prevClose の符号、前日の陽陰、20日移動平均との上下で日を二分し、時間帯分布を群内シェアで比較。</li>
          <li><strong>平均形状</strong>: 時間帯ごとに (price−open)/open の平均(%)を取り±1σ帯と陽線日/陰線日の平均を重ねる。典型的な「1日の形」(U字・右肩上がり等)。</li>
          <li><strong>曜日別軌跡</strong>: 各営業日の始値比軌跡を曜日色で重ね描き(細線)、曜日ごとの平均軌跡(太線)を上に置く。平均では消える「実際の値動きの散らばり」と曜日固有の形状を同時に見る。色分けを「当日方向」に切替えると陽線日/陰線日で軌跡形状を比較でき、縦軸ズームで微細な差も拡大できる。</li>
          <li><strong>曜日別 高安時刻</strong>: 各曜日について高値/安値がどの時間帯に付くかの確率を行ごとに正規化したヒートマップで表示。曜日によるピーク時刻のズレを可視化する。</li>
          <li><strong>出来高・ボラ</strong>: 時間帯ごとの平均出来高シェアと平均値幅(高-安)/価格。活況な時間帯を特定し、高安がそこで付いたか(本物か薄商いか)の裏取りに使う。</li>
          <li><strong>ブレイク</strong>: 寄り後N分のオープニングレンジ(OR)と前日高安を基準に、突破後に引けまで追随した割合(=だましでない割合)を集計。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>高値先行 / 安値先行</strong>: その日の高値と安値のどちらが時間的に先に付いたか。先行する極値の逆方向に最終的に動くことが多い。</li>
          <li><strong>オープニングレンジ(OR)</strong>: 寄り付き直後の一定時間で作る高安の値幅。OR突破はブレイク戦略の基本シグナル。</li>
          <li><strong>追随(フォロースルー)</strong>: 突破後にその方向へ引けまで続くこと。だまし(突破後に戻る)の対義。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>高値先行が多く高値中央値が早い → 朝高後に垂れる「寄り天・配分」型。逆に安値先行が多ければ「朝安・後場高」型。</li>
          <li>到達確率の高値曲線が早い時刻で高水準 → 高値は前場で決まりやすく、後場の高値追いは分が悪い。</li>
          <li>パス類型の翌日リターン/勝率に偏りがあれば、その日中形状が翌日方向の先行サインになり得る。</li>
          <li>条件別で「ギャップアップ日の高値寄り集中度」が通常日より顕著なら、ギャップフェード(寄り戻り売り)の根拠になる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>執行タイミング</strong>: 安値先行・安値が前場集中なら寄り底の押し目買い、高値が引け集中なら大引け成行売りが噛み合う。</li>
          <li><strong>利確・損切り</strong>: 到達確率から「高値はもう出た公算が高い」時間帯では利確を急ぎ、「安値は後場に出やすい」なら前場の浅いストップを避ける。</li>
          <li><strong>順張り/逆張りの選択</strong>: ブレイク追随率が高い銘柄はOR・前日高安ブレイクの順張り、低い銘柄はだまし狙いの逆張りに向く。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"Yahooの日中足は取得期間に制約があり、5分/15分足は直近約60日、60分足でも約2年まで。直近の癖の把握に留め、長期の構造的傾向の断定には使わない。"}</li>
          <li>{"足の粒度より細かい時刻は分からない(5分足なら高値時刻は5分解像度)。"}</li>
          <li>{"高安が同一バー内で同時に付いた日は順序が曖昧。同時バー比率が高い銘柄はパス分類の解釈に注意。"}</li>
          <li>{"翌日リターンやブレイク追随はサンプル数が少ない類型では誤差が大きい。n表示を必ず確認すること。"}</li>
          <li>{"投資信託や流動性の低い銘柄は日中足が提供されず取得できない場合がある。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded p-2">
      <div className="text-gray-500">{label}</div>
      <div className="font-bold text-gray-800">{value}</div>
    </div>
  );
}

function Bar({ label, value, note, color = "#3b82f6" }: { label: string; value: number; note?: string; color?: string }) {
  return (
    <div className="text-xs">
      <div className="flex justify-between mb-0.5">
        <span className="text-gray-600">{label}</span>
        <span className="font-bold text-gray-800">{pct(value)}{note ? <span className="text-gray-400 font-normal ml-1">{note}</span> : null}</span>
      </div>
      <div className="h-2 bg-gray-100 rounded overflow-hidden">
        <div className="h-full rounded" style={{ width: `${Math.min(100, value * 100)}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}
