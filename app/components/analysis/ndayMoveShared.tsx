"use client";

// 値動き条件別の将来分布・売買検証（cond-nday-move）の部品群で共有する小道具。
// Canvas の色は chart-colors.ts の定数だけを使う（直書きしない）。

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import AccessibleCanvas from "./AccessibleCanvas";
import { CHART_COLORS, DIRECTION_COLORS, EVENT_WINDOW_COLORS, withSign } from "../../lib/chart-colors";

export const inputClass = "mt-1 block w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm";
export const labelClass = "min-w-0 text-xs text-gray-700";
export const buttonClass = "rounded border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50 disabled:opacity-40";

/** 比率（0.012）を符号付きの%（+1.20%）に。 */
export function pctSigned(ratio: number | null | undefined, digits = 2): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return withSign(ratio * 100, digits, "%");
}

/** すでに%の値（1.2）を符号付きに。 */
export function pctPointsSigned(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return withSign(value, digits, "%");
}

/** 比率を符号なしの%に（勝率・割合）。 */
export function pctPlain(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function yen(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${Math.round(value).toLocaleString("ja-JP")}円`;
}

/** 円の損益（符号付き。マイナスは U+2212） */
export function yenSigned(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "±";
  return `${sign}${Math.abs(rounded).toLocaleString("ja-JP")}円`;
}

export function num(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

export function StatCard({ label, value, note }: { label: string; value: string; note?: ReactNode }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <p className="text-xs text-gray-600">{label}</p>
      <p className="mt-1 break-keep text-lg font-semibold tabular-nums">{value}</p>
      {note && <p className="mt-1 text-xs text-gray-500">{note}</p>}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "muted"; children: ReactNode }) {
  const cls = tone === "warn" ? "bg-amber-50 text-amber-900" : tone === "muted" ? "bg-gray-50 text-gray-700" : "bg-blue-50 text-blue-900";
  return <div className={`rounded p-3 text-xs leading-relaxed ${cls}`}>{children}</div>;
}

/** DPR を考慮して Canvas を親の幅に合わせる。描画できなければ null。 */
export function initCanvas(canvas: HTMLCanvasElement, height: number): { ctx: CanvasRenderingContext2D; width: number; height: number } | null {
  const parent = canvas.parentElement;
  const width = parent?.clientWidth ?? 0;
  if (width <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = CHART_COLORS.surface;
  ctx.fillRect(0, 0, width, height);
  ctx.font = "11px sans-serif";
  return { ctx, width, height };
}

/** 親の幅の変化で描き直す Canvas。draw は幅と高さを受け取って描く。 */
export function ResponsiveCanvas({ height, description, draw, deps }: {
  height: number;
  description: string;
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  deps: unknown[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  // 描画関数は毎回作り直されるので、最新のものを参照だけ差し替える（描き直しは deps で決める）。
  useLayoutEffect(() => {
    drawRef.current = draw;
  });
  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const paint = () => {
      const init = initCanvas(canvas, height);
      if (init) drawRef.current(init.ctx, init.width, init.height);
    };
    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(parent);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 描画は deps が変わったときだけやり直す
  }, [height, ...deps]);
  return <div className="min-w-0"><AccessibleCanvas ref={ref} description={description} /></div>;
}

export interface Bin {
  label: string;
  count: number;
  /** 強調（0日目・H日目・実際の成績の位置など） */
  tone?: "normal" | "edge" | "start" | "down" | "up";
}

/** 件数の棒グラフ（横軸は時間ではない）。 */
export function BarHistogram({ bins, xLabel, description, height = 220, marker }: {
  bins: Bin[];
  xLabel: string;
  description: string;
  height?: number;
  /** 棒の位置（0〜bins.length）に縦線を引く */
  marker?: { at: number; label: string } | null;
}) {
  return (
    <ResponsiveCanvas
      height={height}
      description={description}
      deps={[bins, xLabel, marker?.at, marker?.label]}
      draw={(ctx, width, h) => {
        const left = 40, right = 10, top = 22, bottom = 44;
        const plotW = width - left - right;
        const plotH = h - top - bottom;
        const max = Math.max(1, ...bins.map((b) => b.count));
        ctx.fillStyle = CHART_COLORS.ink;
        ctx.textAlign = "left";
        ctx.fillText("件数", 4, 14);
        for (let g = 0; g <= 4; g++) {
          const y = top + plotH * (1 - g / 4);
          ctx.strokeStyle = CHART_COLORS.grid;
          ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
          ctx.fillStyle = CHART_COLORS.ink;
          ctx.textAlign = "right";
          ctx.fillText((max * g / 4).toFixed(max < 4 ? 1 : 0), left - 4, y + 4);
        }
        const step = plotW / Math.max(1, bins.length);
        const stride = Math.max(1, Math.ceil(36 / step));
        bins.forEach((bin, i) => {
          const x = left + step * i;
          const bh = (plotH * bin.count) / max;
          ctx.fillStyle = bin.tone === "edge" ? EVENT_WINDOW_COLORS.followup : bin.tone === "start" ? EVENT_WINDOW_COLORS.lookback
            : bin.tone === "down" ? DIRECTION_COLORS.down : bin.tone === "up" ? DIRECTION_COLORS.up : CHART_COLORS.neutral;
          ctx.fillRect(x + 1, top + plotH - bh, Math.max(1, step - 2), bh);
          ctx.fillStyle = CHART_COLORS.ink;
          ctx.textAlign = "center";
          if (bin.count > 0 && step >= 18) ctx.fillText(String(bin.count), x + step / 2, top + plotH - bh - 4);
          if (i % stride === 0) ctx.fillText(bin.label, x + step / 2, h - bottom + 14);
        });
        // 目印は破線だけを引く（文字は棒の件数と重なるので、図の下の説明文で示す）
        if (marker && Number.isFinite(marker.at)) {
          const x = left + step * Math.max(0, Math.min(bins.length, marker.at));
          ctx.strokeStyle = CHART_COLORS.reference;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotH); ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
        }
        ctx.fillStyle = CHART_COLORS.ink;
        ctx.textAlign = "center";
        ctx.fillText(xLabel, left + plotW / 2, h - 8);
      }}
    />
  );
}

/** 値の並びを等幅のビンに数える。 */
export function binValues(values: number[], binsWanted: number, format: (v: number) => string): { bins: Bin[]; lo: number; width: number } {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { bins: [], lo: 0, width: 1 };
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (hi === lo) { lo -= 0.5; hi += 0.5; }
  const width = (hi - lo) / binsWanted;
  const counts = Array<number>(binsWanted).fill(0);
  for (const v of finite) counts[Math.min(binsWanted - 1, Math.floor((v - lo) / width))]++;
  return { bins: counts.map((count, i) => ({ label: format(lo + width * (i + 0.5)), count })), lo, width };
}

export function TabButton({ active, onClick, children, id, controls }: { active: boolean; onClick: () => void; children: ReactNode; id: string; controls: string }) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={active}
      aria-controls={controls}
      className={`rounded-t border px-3 py-2 text-xs sm:text-sm ${active ? "border-gray-300 border-b-white bg-white font-semibold text-gray-900" : "border-transparent text-gray-600 hover:text-gray-900"}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
