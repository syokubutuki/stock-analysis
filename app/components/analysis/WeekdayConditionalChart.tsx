"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  weekdayConditional,
  weekdayPivot,
  weekdayMatrixAll,
  SIGNATURES,
  Signature,
  BinScheme,
  Exit,
  Occurrence,
  WeekdayBin,
  WeekdayCondResult,
  WeekdayPivotResult,
  WeekdayMatrixResult,
  WD_LABELS,
} from "../../lib/weekday-conditional";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

interface Hotspot {
  x: number;
  y: number;
  w: number;
  h: number;
  tip: string;
  onClick?: () => void;
}

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  if (width < 2) return null;
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

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

const BIN_COLORS = ["#dc2626", "#ea580c", "#9ca3af", "#0891b2", "#16a34a"];
function binColor(idx: number, total: number): string {
  if (total <= 1) return "#2563eb";
  const palette = total === 2 ? ["#dc2626", "#16a34a"] : total === 3 ? ["#dc2626", "#9ca3af", "#16a34a"] : BIN_COLORS;
  return palette[Math.min(idx, palette.length - 1)];
}

function retBg(v: number, maxAbs: number): string {
  const t = maxAbs > 0 ? Math.min(1, Math.abs(v) / maxAbs) : 0;
  if (v >= 0) return `rgba(22, 163, 74, ${0.08 + t * 0.6})`;
  return `rgba(220, 38, 38, ${0.08 + t * 0.6})`;
}

// ---------- 描画: 曜日別フォワードパス ----------
function drawPaths(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  result: WeekdayCondResult,
  hotspots: Hotspot[],
  onPick: (rank: number) => void,
) {
  const ml = 50, mr = 92, mt = 26, mb = 26;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`${WD_LABELS[result.entryDow]}曜引け→同週の平均パス（ビン別・累積／点クリックで深掘り）`, ml - 42, 14);

  const xs: number[] = [];
  for (let d = result.entryDow; d <= 5; d++) xs.push(d);
  const allV = result.bins.flatMap((b) => b.path.flatMap((p) => [p.lo, p.hi, p.meanCum]));
  const vmax = Math.max(0.0001, ...allV);
  const vmin = Math.min(-0.0001, ...allV);
  const pad = (vmax - vmin) * 0.08;
  const yHi = vmax + pad, yLo = vmin - pad;
  const xAt = (d: number) => ml + (xs.length <= 1 ? plotW / 2 : ((d - result.entryDow) / (xs.length - 1)) * plotW);
  const yAt = (v: number) => mt + ((yHi - v) / (yHi - yLo)) * plotH;

  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  xs.forEach((d) => {
    ctx.beginPath();
    ctx.moveTo(xAt(d), mt);
    ctx.lineTo(xAt(d), mt + plotH);
    ctx.stroke();
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(WD_LABELS[d], xAt(d), mt + plotH + 16);
  });
  const zeroY = yAt(0);
  ctx.strokeStyle = "#9ca3af";
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(ml, zeroY);
  ctx.lineTo(ml + plotW, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#9ca3af";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(fmtPct(yHi), ml - 6, mt + 8);
  ctx.fillText("0%", ml - 6, zeroY + 3);
  ctx.fillText(fmtPct(yLo), ml - 6, mt + plotH);

  result.bins.forEach((b, idx) => {
    const color = binColor(idx, result.bins.length);
    const isNow = b.label === result.nowBinLabel;
    if (isNow && b.path.length > 1) {
      ctx.fillStyle = color + "22";
      ctx.beginPath();
      b.path.forEach((p, k) => {
        const x = xAt(p.dow), y = yAt(p.hi);
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      for (let k = b.path.length - 1; k >= 0; k--) ctx.lineTo(xAt(b.path[k].dow), yAt(b.path[k].lo));
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = isNow ? 3 : 1.5;
    ctx.beginPath();
    b.path.forEach((p, k) => {
      const x = xAt(p.dow), y = yAt(p.meanCum);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // 点＋ホットスポット
    b.path.forEach((p) => {
      const x = xAt(p.dow), y = yAt(p.meanCum);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, isNow ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
      hotspots.push({
        x: x - 7, y: y - 7, w: 14, h: 14,
        tip: `${b.label}｜${WD_LABELS[p.dow]}引け: ${fmtPct(p.meanCum)}（n=${p.n}${p.dow !== result.entryDow ? `, CI ${fmtPct(p.lo)}〜${fmtPct(p.hi)}` : ""}）`,
        onClick: () => onPick(b.rank),
      });
    });
    const last = b.path[b.path.length - 1];
    if (last) {
      ctx.fillStyle = color;
      ctx.font = isNow ? "bold 9px sans-serif" : "9px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(`${fmtPct(last.meanCum)}${isNow ? " ◀現在" : ""}`, ml + plotW + 4, yAt(last.meanCum) + 3);
    }
  });
}

// ---------- 描画: 2軸ピボット / マトリクス共通のセル ----------
function drawPivot(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  g: WeekdayPivotResult,
  hotspots: Hotspot[],
  onPick: (key: string) => void,
) {
  const ml = 104, mr = 12, mt = 42, mb = 8;
  const cols = g.xOrder.length, rows = g.yOrder.length;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  const cw = plotW / cols, ch = plotH / rows;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`${g.yLabel}(縦) × ${g.xLabel}(横) → ${g.exitLabel}までの平均（セルクリックで深掘り）`, 4, 14);
  ctx.fillStyle = "#6b7280";
  ctx.font = "9px sans-serif";
  ctx.fillText(`→ ${g.xLabel}`, ml, 32);
  ctx.save();
  ctx.translate(12, mt + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText(`↑ ${g.yLabel}`, 0, 0);
  ctx.restore();

  ctx.font = "9px sans-serif";
  ctx.fillStyle = "#6b7280";
  ctx.textAlign = "center";
  g.xOrder.forEach((lab, xi) => ctx.fillText(lab.split(" ")[0], ml + xi * cw + cw / 2, mt - 5));

  const cellMap = new Map(g.cells.map((c) => [`${c.xi}|${c.yi}`, c]));
  // 縦は上が「上位」になるよう yi を上から大きい順に
  for (let row = 0; row < rows; row++) {
    const yi = rows - 1 - row;
    ctx.fillStyle = "#6b7280";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(g.yOrder[yi].split(" ")[0], ml - 4, mt + row * ch + ch / 2 + 3);
    for (let xi = 0; xi < cols; xi++) {
      const x = ml + xi * cw, y = mt + row * ch;
      const c = cellMap.get(`${xi}|${yi}`);
      if (!c) {
        ctx.fillStyle = "#f3f4f6";
        ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
        continue;
      }
      ctx.fillStyle = retBg(c.meanFwd, g.maxAbs);
      ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
      if (g.nowXi === xi && g.nowYi === yi) {
        ctx.strokeStyle = "#1d4ed8";
        ctx.lineWidth = 2.5;
        ctx.strokeRect(x + 2, y + 2, cw - 4, ch - 4);
      }
      ctx.fillStyle = "#1f2937";
      ctx.font = c.significant ? "bold 11px sans-serif" : "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(fmtPct(c.meanFwd), x + cw / 2, y + ch / 2 - 1);
      ctx.fillStyle = "#6b7280";
      ctx.font = "8px sans-serif";
      ctx.fillText(`n=${c.n}${c.significant ? " ✓" : ""}`, x + cw / 2, y + ch / 2 + 12);
      hotspots.push({
        x, y, w: cw, h: ch,
        tip: `${g.yLabel}:${g.yOrder[yi].split(" ")[0]}／${g.xLabel}:${g.xOrder[xi].split(" ")[0]}｜平均${fmtPct(c.meanFwd)}・勝率${(c.winRate * 100).toFixed(0)}%・n=${c.n}・CI${fmtPct(c.ciLow)}〜${fmtPct(c.ciHigh)}・p=${c.p < 0.001 ? "<.001" : c.p.toFixed(3)}`,
        onClick: () => onPick(`${xi}|${yi}`),
      });
    }
  }
}

function drawMatrix(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  m: WeekdayMatrixResult,
  hotspots: Hotspot[],
  onPick: (dow: number, binIdx: number) => void,
) {
  const ml = 46, mr = 12, mt = 40, mb = 8;
  const cols = m.binLabels.length, rows = m.dows.length;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  const cw = plotW / cols, ch = plotH / rows;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`全曜日 × ビンランク → ${m.exitLabel}までの平均（セルクリックでその曜日を深掘り）`, 4, 14);
  ctx.fillStyle = "#6b7280";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "center";
  m.binLabels.forEach((lab, bi) => ctx.fillText(lab, ml + bi * cw + cw / 2, mt - 5));

  const cellMap = new Map(m.cells.map((c) => [`${c.dow}|${c.binIdx}`, c]));
  m.dows.forEach((d, row) => {
    ctx.fillStyle = "#374151";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`${WD_LABELS[d]}曜`, ml - 6, mt + row * ch + ch / 2 + 4);
    for (let bi = 0; bi < cols; bi++) {
      const x = ml + bi * cw, y = mt + row * ch;
      const c = cellMap.get(`${d}|${bi}`);
      if (!c) {
        ctx.fillStyle = "#f3f4f6";
        ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
        continue;
      }
      ctx.fillStyle = retBg(c.meanFwd, m.maxAbs);
      ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
      if (m.nowByDow[d] === bi) {
        ctx.strokeStyle = "#1d4ed8";
        ctx.lineWidth = 2.5;
        ctx.strokeRect(x + 2, y + 2, cw - 4, ch - 4);
      }
      ctx.fillStyle = "#1f2937";
      ctx.font = c.significant ? "bold 11px sans-serif" : "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(fmtPct(c.meanFwd), x + cw / 2, y + ch / 2 - 1);
      ctx.fillStyle = "#6b7280";
      ctx.font = "8px sans-serif";
      ctx.fillText(`n=${c.n}${c.significant ? " ✓" : ""}`, x + cw / 2, y + ch / 2 + 12);
      hotspots.push({
        x, y, w: cw, h: ch,
        tip: `${WD_LABELS[d]}曜・${m.binLabels[bi]}｜平均${fmtPct(c.meanFwd)}・勝率${(c.winRate * 100).toFixed(0)}%・n=${c.n}・p=${c.p < 0.001 ? "<.001" : c.p.toFixed(3)}`,
        onClick: () => onPick(d, bi),
      });
    }
  });
}

// ---------- ドリルダウン: 分布ヒストグラム ----------
function Histogram({ values, label }: { values: number[]; label: string }) {
  const bins = useMemo(() => {
    if (values.length === 0) return null;
    const lo = Math.min(...values), hi = Math.max(...values);
    const span = hi - lo || 1e-6;
    const k = Math.min(24, Math.max(6, Math.round(Math.sqrt(values.length))));
    const counts = new Array(k).fill(0);
    for (const v of values) counts[Math.min(k - 1, Math.floor(((v - lo) / span) * k))]++;
    return { lo, hi, k, counts, max: Math.max(...counts), span };
  }, [values]);
  if (!bins) return null;
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  return (
    <div>
      <p className="text-[11px] text-gray-500 mb-1">{label}（n={values.length}・平均{fmtPct(m)}）</p>
      <div className="flex items-end gap-px h-20 bg-gray-50 rounded px-1 pt-1">
        {bins.counts.map((c, i) => {
          const center = bins.lo + ((i + 0.5) / bins.k) * bins.span;
          return (
            <div
              key={i}
              className={`flex-1 ${center >= 0 ? "bg-green-400" : "bg-red-400"}`}
              style={{ height: `${(c / bins.max) * 100}%` }}
              title={`${fmtPct(bins.lo + (i / bins.k) * bins.span)}〜${fmtPct(bins.lo + ((i + 1) / bins.k) * bins.span)}: ${c}件`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-gray-400 mt-0.5">
        <span>{fmtPct(bins.lo)}</span>
        <span className="text-gray-500">0%</span>
        <span>{fmtPct(bins.hi)}</span>
      </div>
    </div>
  );
}

// ---------- ドリルダウン: 発生日一覧 ----------
function OccurrenceTable({ occ, xLabel, yLabel }: { occ: Occurrence[]; xLabel: string; yLabel?: string }) {
  const sorted = useMemo(() => [...occ].sort((a, b) => (a.date < b.date ? 1 : -1)), [occ]);
  const shown = sorted.slice(0, 16);
  return (
    <div>
      <p className="text-[11px] text-gray-500 mb-1">発生日（新しい順・最大16件 / 全{occ.length}件）</p>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-gray-400 border-b border-gray-200">
              <th className="text-left px-1.5 py-0.5">エントリー日</th>
              <th className="text-right px-1.5">{xLabel}</th>
              {yLabel && <th className="text-right px-1.5">{yLabel}</th>}
              <th className="text-right px-1.5">→ 結果</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((o, i) => (
              <tr key={i} className="border-b border-gray-50">
                <td className="px-1.5 py-0.5 text-gray-600">{o.date.slice(0, 10)}</td>
                <td className="px-1.5 text-right text-gray-500">{fmtPct(o.sigVal)}</td>
                {yLabel && <td className="px-1.5 text-right text-gray-500">{fmtPct(o.yVal ?? 0)}</td>}
                <td className={`px-1.5 text-right font-medium ${o.fwd >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtPct(o.fwd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const ENTRY_DOWS = [1, 2, 3, 4, 5];
const SCHEMES: { value: BinScheme; label: string }[] = [
  { value: "sign", label: "上下(2)" },
  { value: "tercile", label: "3分位" },
  { value: "quintile", label: "5分位" },
];
const NDAYS = [1, 2, 3, 5];
type View = "path" | "pivot" | "matrix";

function actionTag(action: WeekdayBin["action"]) {
  if (action === "long") return <span className="inline-block rounded bg-green-100 text-green-700 px-1.5 py-0.5 text-[10px] font-bold">買い候補</span>;
  if (action === "short") return <span className="inline-block rounded bg-red-100 text-red-700 px-1.5 py-0.5 text-[10px] font-bold">売り/回避</span>;
  return <span className="inline-block rounded bg-gray-100 text-gray-500 px-1.5 py-0.5 text-[10px]">エッジ薄</span>;
}

export default function WeekdayConditionalChart({ prices }: Props) {
  const pathRef = useRef<HTMLCanvasElement>(null);
  const pivotRef = useRef<HTMLCanvasElement>(null);
  const matrixRef = useRef<HTMLCanvasElement>(null);
  const hotspotsRef = useRef<Hotspot[]>([]);

  const [view, setView] = useState<View>("path");
  const [entryDow, setEntryDow] = useState(1);
  const [sig, setSig] = useState<Signature>("intraday");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const [exitKind, setExitKind] = useState<"weekday" | "ndays">("weekday");
  const [exitDow, setExitDow] = useState(5);
  const [exitN, setExitN] = useState(2);
  const [ySig, setYSig] = useState<Signature>("gap"); // ピボットY軸（X軸は sig を流用）

  const [drillRank, setDrillRank] = useState<number | null>(null); // path: ビン rank
  const [drillCell, setDrillCell] = useState<string | null>(null); // pivot: "xi|yi"
  const [tip, setTip] = useState<{ left: number; top: number; text: string } | null>(null);

  const exit: Exit = useMemo(
    () => (exitKind === "weekday" ? { kind: "weekday", dow: exitDow } : { kind: "ndays", n: exitN }),
    [exitKind, exitDow, exitN],
  );

  const result = useMemo(() => (prices.length < 120 ? null : weekdayConditional(prices, entryDow, sig, scheme, exit)), [prices, entryDow, sig, scheme, exit]);
  const pivot = useMemo(() => (prices.length < 120 || view !== "pivot" ? null : weekdayPivot(prices, entryDow, sig, ySig, scheme, exit)), [prices, entryDow, sig, ySig, scheme, exit, view]);
  const matrix = useMemo(() => (prices.length < 120 || view !== "matrix" ? null : weekdayMatrixAll(prices, sig, scheme, exit)), [prices, sig, scheme, exit, view]);

  // 描画
  useEffect(() => {
    hotspotsRef.current = [];
    if (view === "path" && result && pathRef.current) {
      const init = initCanvas(pathRef.current, 264);
      if (init) drawPaths(init.ctx, init.width, init.height, result, hotspotsRef.current, (rank) => { setDrillRank(rank); setDrillCell(null); });
    } else if (view === "pivot" && pivot && pivotRef.current) {
      const init = initCanvas(pivotRef.current, 56 + pivot.yOrder.length * 48);
      if (init) drawPivot(init.ctx, init.width, init.height, pivot, hotspotsRef.current, (key) => setDrillCell(key));
    } else if (view === "matrix" && matrix && matrixRef.current) {
      const init = initCanvas(matrixRef.current, 52 + matrix.dows.length * 42);
      if (init) drawMatrix(init.ctx, init.width, init.height, matrix, hotspotsRef.current, (d, bi) => { setEntryDow(d); setDrillRank(bi); setDrillCell(null); setView("path"); });
    }
  }, [view, result, pivot, matrix]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const hs = hotspotsRef.current.find((h) => mx >= h.x && mx <= h.x + h.w && my >= h.y && my <= h.y + h.h);
    if (hs) setTip({ left: mx, top: my, text: hs.tip });
    else setTip(null);
    e.currentTarget.style.cursor = hs?.onClick ? "pointer" : "default";
  };
  const onClickCanvas = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const hs = hotspotsRef.current.find((h) => mx >= h.x && mx <= h.x + h.w && my >= h.y && my <= h.y + h.h);
    hs?.onClick?.();
  };

  if (prices.length < 120) return null;

  const maxAbs = result ? Math.max(1e-9, ...result.bins.map((b) => Math.abs(b.meanFwd))) : 1;
  const nowBin = result?.bins.find((b) => b.label === result.nowBinLabel) ?? null;
  const sigLabel = SIGNATURES.find((s) => s.value === sig)?.label ?? "";
  const drillBin = result?.bins.find((b) => b.rank === drillRank) ?? null;
  const drillPivotCell = pivot?.cells.find((c) => `${c.xi}|${c.yi}` === drillCell) ?? null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div>
        <h3 className="font-bold text-gray-800">曜日 × 値動きビン 条件付き分析（インタラクティブ）</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          任意曜日を、その日の値動き（夜間ギャップ=前日Close比の当日Openリターン 等）でビンに分け、ビン/セルをクリックして“その後どう動くか”を深掘りする。
        </p>
      </div>

      {/* ビュー切替 */}
      <div className="flex gap-1 text-xs">
        {([["path", "ビン別パス&EV"], ["pivot", "2軸ピボット"], ["matrix", "全曜日マトリクス"]] as [View, string][]).map(([v, lab]) => (
          <button key={v} onClick={() => setView(v)} className={`px-3 py-1 rounded font-medium ${view === v ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{lab}</button>
        ))}
      </div>

      {/* 共通コントロール */}
      <div className="space-y-2 bg-gray-50 rounded-md p-2.5">
        {view !== "matrix" && (
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <span className="text-gray-500 w-20">エントリー曜日</span>
            {ENTRY_DOWS.map((d) => (
              <button key={d} onClick={() => { setEntryDow(d); setDrillRank(null); setDrillCell(null); if (d >= 5) setExitKind("ndays"); else if (exitDow <= d) setExitDow(5); }}
                className={`px-2.5 py-1 rounded font-medium ${entryDow === d ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{WD_LABELS[d]}</button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className="text-gray-500 w-20">{view === "pivot" ? "X軸ビン" : "値動きビン"}</span>
          {SIGNATURES.map((s) => (
            <button key={s.value} onClick={() => { setSig(s.value); setDrillRank(null); setDrillCell(null); }} className={`px-2.5 py-1 rounded font-medium ${sig === s.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`} title={s.desc}>{s.label}</button>
          ))}
        </div>
        {view === "pivot" && (
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <span className="text-gray-500 w-20">Y軸ビン</span>
            {SIGNATURES.map((s) => (
              <button key={s.value} onClick={() => { setYSig(s.value); setDrillCell(null); }} className={`px-2.5 py-1 rounded font-medium ${ySig === s.value ? "bg-cyan-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`} title={s.desc}>{s.label}</button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3 text-xs flex-wrap">
          <div className="flex items-center gap-1">
            <span className="text-gray-500">分割</span>
            {SCHEMES.map((s) => (
              <button key={s.value} onClick={() => { setScheme(s.value); setDrillRank(null); setDrillCell(null); }} className={`px-2 py-0.5 rounded ${scheme === s.value ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{s.label}</button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-gray-500">売り(exit)</span>
            <button onClick={() => setExitKind("weekday")} className={`px-2 py-0.5 rounded ${exitKind === "weekday" ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>同週の曜日引け</button>
            <button onClick={() => setExitKind("ndays")} className={`px-2 py-0.5 rounded ${exitKind === "ndays" ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>N営業日先</button>
          </div>
          {exitKind === "weekday" ? (
            <div className="flex items-center gap-1">
              {ENTRY_DOWS.filter((d) => view === "matrix" || d > entryDow).map((d) => (
                <button key={d} onClick={() => setExitDow(d)} className={`px-2 py-0.5 rounded ${exitDow === d ? "bg-gray-800 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{WD_LABELS[d]}</button>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-1">
              {NDAYS.map((n) => (
                <button key={n} onClick={() => setExitN(n)} className={`px-2 py-0.5 rounded ${exitN === n ? "bg-gray-800 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{n}日</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ===== ビュー: ビン別パス&EV ===== */}
      {view === "path" && (!result ? (
        <p className="text-xs text-gray-400">この条件では標本が不足しています。</p>
      ) : (
        <>
          {nowBin && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 space-y-0.5">
              <div><span className="font-bold">直近の{WD_LABELS[result.entryDow]}曜</span>{result.nowDate ? `（${result.nowDate.slice(0, 10)}）` : ""}は <span className="font-bold">「{result.nowBinLabel}」</span>ビンに該当</div>
              <div>→ 過去同ビンの{result.exitLabel}までは <span className="font-bold">平均 {fmtPct(nowBin.meanFwd)}</span>・勝率 <span className="font-bold">{(nowBin.winRate * 100).toFixed(0)}%</span>（n={nowBin.n}、95%CI {fmtPct(nowBin.ciLow)}〜{fmtPct(nowBin.ciHigh)}） <StatBadge n={nowBin.n} p={nowBin.p} significant={nowBin.significant} /> {actionTag(nowBin.action)}</div>
            </div>
          )}

          <div className="relative">
            <canvas ref={pathRef} onMouseMove={onMove} onMouseLeave={() => setTip(null)} onClick={onClickCanvas} />
            {tip && <div className="pointer-events-none absolute z-10 max-w-[280px] rounded bg-gray-900/90 px-2 py-1 text-[10px] text-white shadow" style={{ left: Math.min(tip.left + 10, 9999), top: tip.top + 10 }}>{tip.text}</div>}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">{sigLabel}ビン</th>
                  <th className="text-right px-2">n</th><th className="text-right px-2">平均</th><th className="text-right px-2">中央値</th>
                  <th className="text-left px-2">勝率</th><th className="text-right px-2">σ</th><th className="text-left px-2">95%CI</th><th className="text-left px-2">有意性</th><th className="text-left px-2">判断</th>
                </tr>
              </thead>
              <tbody>
                {result.bins.map((b, idx) => {
                  const isNow = b.label === result.nowBinLabel;
                  const isDrill = b.rank === drillRank;
                  return (
                    <tr key={b.label} onClick={() => { setDrillRank(b.rank); setDrillCell(null); }}
                      className={`border-b border-gray-100 cursor-pointer hover:bg-indigo-50 ${isNow ? "ring-2 ring-blue-400 ring-inset" : ""} ${isDrill ? "bg-indigo-50" : ""}`}>
                      <td className="py-1 px-2 font-medium text-gray-700">
                        <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: binColor(idx, result.bins.length) }} />
                        {isNow && <span className="text-blue-600 mr-1">◀</span>}{b.label}
                      </td>
                      <td className="text-right px-2 text-gray-600">{b.n}</td>
                      <td className="text-right px-2 font-medium" style={{ background: retBg(b.meanFwd, maxAbs) }}>{fmtPct(b.meanFwd)}</td>
                      <td className="text-right px-2 text-gray-600">{fmtPct(b.medianFwd)}</td>
                      <td className="px-2"><div className="flex items-center gap-1"><div className="relative h-3 w-12 bg-gray-100 rounded-sm overflow-hidden"><div className={`absolute inset-y-0 left-0 ${b.winRate >= 0.5 ? "bg-green-400" : "bg-red-400"}`} style={{ width: `${b.winRate * 100}%` }} /><div className="absolute inset-y-0 left-1/2 w-px bg-gray-400" /></div><span className="text-gray-600 tabular-nums">{(b.winRate * 100).toFixed(0)}%</span></div></td>
                      <td className="text-right px-2 text-gray-500">{(b.stdFwd * 100).toFixed(2)}%</td>
                      <td className="px-2 text-gray-500 whitespace-nowrap">{fmtPct(b.ciLow)}〜{fmtPct(b.ciHigh)}</td>
                      <td className="px-2"><StatBadge n={b.n} p={b.p} significant={b.significant} /></td>
                      <td className="px-2">{actionTag(b.action)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-[11px] text-gray-400 mt-1">基準（全{WD_LABELS[entryDow]}曜・無条件）: 平均 {fmtPct(result.baselineMean)}・勝率 {(result.baselineWin * 100).toFixed(0)}%（n={result.totalN}）。行クリックで分布と発生日を深掘り。</p>
          </div>

          {drillBin && (
            <div className="rounded-md border border-indigo-200 bg-indigo-50/40 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-indigo-900">深掘り: {WD_LABELS[result.entryDow]}曜・{drillBin.label} → {result.exitLabel}</p>
                <button onClick={() => setDrillRank(null)} className="text-[11px] text-gray-400 hover:text-gray-600">閉じる ✕</button>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <Histogram values={drillBin.occurrences.map((o) => o.fwd)} label="フォワードリターンの分布" />
                <OccurrenceTable occ={drillBin.occurrences} xLabel={sigLabel} />
              </div>
            </div>
          )}
        </>
      ))}

      {/* ===== ビュー: 2軸ピボット ===== */}
      {view === "pivot" && (!pivot || pivot.cells.length === 0 ? (
        <p className="text-xs text-gray-400">この条件では標本が不足しています。</p>
      ) : (
        <>
          <div className="relative">
            <canvas ref={pivotRef} onMouseMove={onMove} onMouseLeave={() => setTip(null)} onClick={onClickCanvas} />
            {tip && <div className="pointer-events-none absolute z-10 max-w-[300px] rounded bg-gray-900/90 px-2 py-1 text-[10px] text-white shadow" style={{ left: Math.min(tip.left + 10, 9999), top: tip.top + 10 }}>{tip.text}</div>}
          </div>
          <p className="text-[11px] text-gray-400">緑=上昇/赤=下落、✓=有意(n≥10)、青枠=直近{WD_LABELS[entryDow]}曜の該当セル。「{pivot.yLabel}は小さいのに{pivot.xLabel}は大きい」等の2条件の組合せで先行きが変わるかを読む。セルクリックで深掘り。</p>
          {drillPivotCell && (
            <div className="rounded-md border border-indigo-200 bg-indigo-50/40 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-indigo-900">深掘り: {WD_LABELS[pivot.entryDow]}曜・{pivot.yLabel}「{pivot.yOrder[drillPivotCell.yi].split(" ")[0]}」× {pivot.xLabel}「{pivot.xOrder[drillPivotCell.xi].split(" ")[0]}」</p>
                <button onClick={() => setDrillCell(null)} className="text-[11px] text-gray-400 hover:text-gray-600">閉じる ✕</button>
              </div>
              <div className="text-[11px] text-gray-600">{result?.exitLabel ?? pivot.exitLabel}まで 平均{fmtPct(drillPivotCell.meanFwd)}・中央値{fmtPct(drillPivotCell.medianFwd)}・勝率{(drillPivotCell.winRate * 100).toFixed(0)}%・95%CI {fmtPct(drillPivotCell.ciLow)}〜{fmtPct(drillPivotCell.ciHigh)}・n={drillPivotCell.n} <StatBadge n={drillPivotCell.n} p={drillPivotCell.p} significant={drillPivotCell.significant} /></div>
              <div className="grid md:grid-cols-2 gap-4">
                <Histogram values={drillPivotCell.occurrences.map((o) => o.fwd)} label="フォワードリターンの分布" />
                <OccurrenceTable occ={drillPivotCell.occurrences} xLabel={pivot.xLabel} yLabel={pivot.yLabel} />
              </div>
            </div>
          )}
        </>
      ))}

      {/* ===== ビュー: 全曜日マトリクス ===== */}
      {view === "matrix" && (!matrix ? (
        <p className="text-xs text-gray-400">この条件では標本が不足しています。</p>
      ) : (
        <>
          <div className="relative">
            <canvas ref={matrixRef} onMouseMove={onMove} onMouseLeave={() => setTip(null)} onClick={onClickCanvas} />
            {tip && <div className="pointer-events-none absolute z-10 max-w-[300px] rounded bg-gray-900/90 px-2 py-1 text-[10px] text-white shadow" style={{ left: Math.min(tip.left + 10, 9999), top: tip.top + 10 }}>{tip.text}</div>}
          </div>
          <p className="text-[11px] text-gray-400">行=曜日、列=「{sigLabel}」のビンランク（分位境界は曜日ごとに算出）。色=平均、✓=有意(n≥10)、青枠=各曜日の直近該当ビン。気になるセルをクリックすると「ビン別パス&EV」でその曜日を深掘り。</p>
        </>
      ))}

      <AnalysisGuide title="曜日×値動きビン 条件付き分析の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"「月曜は金曜から下げて始まりやすい→月曜買い」のような曜日アノマリーを、もう一段深掘りする。同じ曜日でも『その日がどう動いたか（窓・日中の上げ下げ）』で先行きは変わる。エントリー曜日を、その日の値動きシグネチャでビンに分け、ビンごとに『その後どう推移するか（曜日別パス）』と『指定タイミングで売った場合の条件付き期待値』を集計し、ビン/セルをクリックして個別発生日まで掘り下げられる。"}</p>

        <p className="font-medium text-gray-700 mt-3">2. 値動きシグネチャの定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>夜間ギャップ</strong> = (始値 − 前日終値) / 前日終値。＝「前日Closeから見た当日Openリターン」。0付近＝「始値≒前日終値」。</li>
          <li><strong>日中リターン</strong> = (終値 − 始値) / 始値。寄りからの当日の上げ下げ。</li>
          <li><strong>当日リターン</strong> = (終値 − 前日終値) / 前日終値。前日比トータル。</li>
          <li><strong>超過日中リターン</strong> = 日中リターン − 全日平均日中リターン。「平均以上に日中で上げた日か」。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 3つのビュー</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ビン別パス&EV</strong>: 選んだ曜日×1シグネチャのビンごとに、同週の火→水→木→金の平均累積パスとexit別EV・有意性。行/点クリックで分布ヒストグラム＋発生日一覧を深掘り。</li>
          <li><strong>2軸ピボット</strong>: X軸・Y軸に任意シグネチャ（夜間ギャップ×日中リターン 等）を割り当てたクロス集計。『窓は小さいのに日中で大きく上げた』など2条件の相互作用を読む。セルクリックで深掘り。</li>
          <li><strong>全曜日マトリクス</strong>: 月〜金×ビンランクを一画面で俯瞰し、エッジのある曜日×ビンを発見。セルクリックでその曜日のパスへ。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 計算（先読みバイアスの排除）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>建ては必ずエントリー曜日の「引け」</strong>。日中リターンや窓はその日の引けで確定するため、引け以降でしか同条件で建てられない（寄り建ては未確定情報を使う先読み）。</li>
          <li><strong>ビン分割</strong>: 上下(0で2)/3分位/5分位。分位はそのエントリー曜日の分布から境界を作り標本数がほぼ揃う。ラベル括弧内が値域。</li>
          <li><strong>曜日別パス</strong>: エントリー引けを0%として同週の各曜日の平均累積。週末をまたいだら打ち切り。帯=平均±1.96×標準誤差。</li>
          <li><strong>exit</strong>: 「同週の指定曜日引け」または「N営業日先引け」。フォワード=(exit終値−エントリー終値)/エントリー終値。</li>
          <li><strong>有意性</strong>: 平均=0 の1標本t検定 → 複数ビン/セルを Benjamini-Hochberg FDR で多重比較補正。95%CIは移動ブロック・ブートストラップ。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>パスの形</strong>で『その後どう動くか』を読む。上位ビンが右肩上がり継続＝モメンタム（順張り）。途中で反落＝過熱の戻り（利確/逆張り）。</li>
          <li><strong>判断列</strong>: 平均が基準（無条件）超・勝率≥50%・有意なら「買い候補」。有意な下落は「売り/回避」。</li>
          <li><strong>深掘りの分布</strong>: 平均が同じでも、勝率高めで小さく勝ち続ける型か、たまの大勝で平均が持ち上がる型かを分布の形で見分ける。発生日一覧で最近も効いているかを確認。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>取引コスト・スリッページ未控除。曜日×ビン×exitで標本が細るので必ずnと有意性を確認（「参考(n小)」は重視しない）。</li>
          <li>分位境界は標本依存。期間を変えると境界もビン成績も動く。多数のセルを同時に見るほど偶然の当たりが増えるためFDRと年次の安定を併用。</li>
          <li>祝日週は同週パスが短くなる/exitが成立しないことがある（その回は集計から除外）。統計的有意≠実用的有意。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
