"use client";

import { useMemo, useCallback, useRef, useEffect } from "react";
import { PricePoint } from "../../lib/types";
import type { PeriodKey } from "../../hooks/useAnalysisData";

interface Props {
  prices: PricePoint[];
  period?: PeriodKey;
}

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const DOW_TRADING = [1, 2, 3, 4, 5]; // Mon-Fri
const MONTH_LABELS = [
  "1月","2月","3月","4月","5月","6月",
  "7月","8月","9月","10月","11月","12月",
];

interface DayStats {
  date: string;
  dayOfWeek: number;
  month: number;
  closeReturn: number;   // 前日比 (close-to-close)
  intradayReturn: number; // 日中 (open→close)
  overnightReturn: number; // 夜間 (prev close→open)
}

function pct(v: number): string {
  return (v * 100).toFixed(3) + "%";
}
function pct2(v: number): string {
  return (v * 100).toFixed(2) + "%";
}

function colorClass(v: number): string {
  return v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500";
}

export default function SpiralHeatmap({ prices, period }: Props) {
  const cumulCanvasRef = useRef<HTMLCanvasElement>(null);

  const days: DayStats[] = useMemo(() => {
    if (prices.length < 2) return [];
    return prices.slice(1).map((p, i) => {
      const prev = prices[i];
      const d = new Date(p.time);
      const prevClose = prev.close || 1;
      const open = p.open || prevClose;
      return {
        date: p.time,
        dayOfWeek: d.getDay(),
        month: d.getMonth(),
        closeReturn: (p.close - prevClose) / prevClose,
        intradayReturn: (p.close - open) / open,
        overnightReturn: (open - prevClose) / prevClose,
      };
    });
  }, [prices]);

  // --- Weekday stats ---
  const dowStats = useMemo(() => {
    const stats = Array.from({ length: 7 }, () => ({
      closeReturns: [] as number[],
      intradayReturns: [] as number[],
      overnightReturns: [] as number[],
    }));
    for (const d of days) {
      stats[d.dayOfWeek].closeReturns.push(d.closeReturn);
      stats[d.dayOfWeek].intradayReturns.push(d.intradayReturn);
      stats[d.dayOfWeek].overnightReturns.push(d.overnightReturn);
    }
    return stats.map((s) => {
      const n = s.closeReturns.length;
      if (n === 0) return null;
      const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const median = (arr: number[]) => {
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      };
      const std = (arr: number[]) => {
        const m = mean(arr);
        return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
      };
      const winRate = (arr: number[]) => arr.filter((v) => v > 0).length / arr.length;
      return {
        n,
        close: { mean: mean(s.closeReturns), median: median(s.closeReturns), std: std(s.closeReturns), winRate: winRate(s.closeReturns) },
        intraday: { mean: mean(s.intradayReturns), median: median(s.intradayReturns), std: std(s.intradayReturns), winRate: winRate(s.intradayReturns) },
        overnight: { mean: mean(s.overnightReturns), median: median(s.overnightReturns), std: std(s.overnightReturns), winRate: winRate(s.overnightReturns) },
      };
    });
  }, [days]);

  // --- Month stats ---
  const monthStats = useMemo(() => {
    const stats = Array.from({ length: 12 }, () => ({
      closeReturns: [] as number[],
      intradayReturns: [] as number[],
      overnightReturns: [] as number[],
    }));
    for (const d of days) {
      stats[d.month].closeReturns.push(d.closeReturn);
      stats[d.month].intradayReturns.push(d.intradayReturn);
      stats[d.month].overnightReturns.push(d.overnightReturn);
    }
    return stats.map((s) => {
      const n = s.closeReturns.length;
      if (n === 0) return null;
      const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const std = (arr: number[]) => {
        const m = mean(arr);
        return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
      };
      const winRate = (arr: number[]) => arr.filter((v) => v > 0).length / arr.length;
      return {
        n,
        close: { mean: mean(s.closeReturns), std: std(s.closeReturns), winRate: winRate(s.closeReturns) },
        intraday: { mean: mean(s.intradayReturns), std: std(s.intradayReturns), winRate: winRate(s.intradayReturns) },
        overnight: { mean: mean(s.overnightReturns), std: std(s.overnightReturns), winRate: winRate(s.overnightReturns) },
      };
    });
  }, [days]);

  // --- Weekday x Month cross stats ---
  const crossStats = useMemo(() => {
    // [dow][month] => returns[]
    const grid: number[][][] = Array.from({ length: 7 }, () =>
      Array.from({ length: 12 }, () => [])
    );
    for (const d of days) {
      grid[d.dayOfWeek][d.month].push(d.closeReturn);
    }
    return grid.map((months) =>
      months.map((returns) => {
        if (returns.length === 0) return null;
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        return { mean, n: returns.length };
      })
    );
  }, [days]);

  // --- Streak analysis ---
  const streakStats = useMemo(() => {
    if (days.length === 0) return null;
    let curUp = 0, curDown = 0;
    let maxUp = 0, maxDown = 0;
    const upStreaks: number[] = [];
    const downStreaks: number[] = [];
    for (const d of days) {
      if (d.closeReturn > 0) {
        curUp++;
        if (curDown > 0) { downStreaks.push(curDown); curDown = 0; }
      } else if (d.closeReturn < 0) {
        curDown++;
        if (curUp > 0) { upStreaks.push(curUp); curUp = 0; }
      } else {
        if (curUp > 0) upStreaks.push(curUp);
        if (curDown > 0) downStreaks.push(curDown);
        curUp = 0; curDown = 0;
      }
      maxUp = Math.max(maxUp, curUp);
      maxDown = Math.max(maxDown, curDown);
    }
    if (curUp > 0) upStreaks.push(curUp);
    if (curDown > 0) downStreaks.push(curDown);
    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    return { maxUp, maxDown, avgUp: avg(upStreaks), avgDown: avg(downStreaks), upCount: upStreaks.length, downCount: downStreaks.length };
  }, [days]);

  // --- Cumulative return by weekday (canvas chart) ---
  const dowCumulative = useMemo(() => {
    // For each trading day, build cumulative return series per weekday
    const series: Record<number, { idx: number; cumRet: number }[]> = {};
    const counters: Record<number, number> = {};
    const cumRet: Record<number, number> = {};
    for (const dow of DOW_TRADING) {
      series[dow] = [];
      counters[dow] = 0;
      cumRet[dow] = 0;
    }
    for (const d of days) {
      if (!(d.dayOfWeek in series)) continue;
      cumRet[d.dayOfWeek] += d.closeReturn;
      counters[d.dayOfWeek]++;
      series[d.dayOfWeek].push({ idx: counters[d.dayOfWeek], cumRet: cumRet[d.dayOfWeek] });
    }
    return series;
  }, [days]);

  // --- Monthly cumulative return (canvas chart) ---
  const monthCumulative = useMemo(() => {
    const series: Record<number, { idx: number; cumRet: number }[]> = {};
    const counters: Record<number, number> = {};
    const cumRet: Record<number, number> = {};
    for (let m = 0; m < 12; m++) {
      series[m] = [];
      counters[m] = 0;
      cumRet[m] = 0;
    }
    for (const d of days) {
      cumRet[d.month] += d.closeReturn;
      counters[d.month]++;
      series[d.month].push({ idx: counters[d.month], cumRet: cumRet[d.month] });
    }
    return series;
  }, [days]);

  const DOW_COLORS = ["#999", "#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#999"];
  const MONTH_COLORS = [
    "#ef4444","#f97316","#eab308","#22c55e","#14b8a6","#06b6d4",
    "#3b82f6","#6366f1","#8b5cf6","#a855f7","#ec4899","#f43f5e",
  ];

  // Draw cumulative return charts
  const drawCumulative = useCallback((
    canvas: HTMLCanvasElement,
    seriesData: Record<number, { idx: number; cumRet: number }[]>,
    colors: string[],
    labels: string[],
    keys: number[],
  ) => {
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 200;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, width, height);

    // Find global min/max
    let allMin = 0, allMax = 0, allMaxIdx = 0;
    for (const k of keys) {
      for (const pt of seriesData[k]) {
        allMin = Math.min(allMin, pt.cumRet);
        allMax = Math.max(allMax, pt.cumRet);
        allMaxIdx = Math.max(allMaxIdx, pt.idx);
      }
    }
    if (allMaxIdx === 0) return;

    const pad = { top: 15, bottom: 25, left: 50, right: 15 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const range = allMax - allMin || 0.01;

    // Zero line
    const zeroY = pad.top + plotH * (1 - (0 - allMin) / range);
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, zeroY);
    ctx.lineTo(width - pad.right, zeroY);
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = "#999";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "right";
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const val = allMin + (range * i) / yTicks;
      const y = pad.top + plotH * (1 - i / yTicks);
      ctx.fillText((val * 100).toFixed(1) + "%", pad.left - 5, y + 3);
      ctx.strokeStyle = "#f0f0f0";
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();
    }

    // Draw series
    for (const k of keys) {
      const pts = seriesData[k];
      if (pts.length < 2) continue;
      ctx.strokeStyle = colors[k];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = pad.left + (pts[i].idx / allMaxIdx) * plotW;
        const y = pad.top + plotH * (1 - (pts[i].cumRet - allMin) / range);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Legend
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    let lx = pad.left;
    for (const k of keys) {
      if (!seriesData[k] || seriesData[k].length === 0) continue;
      ctx.fillStyle = colors[k];
      ctx.fillRect(lx, height - 12, 12, 3);
      ctx.fillStyle = "#666";
      ctx.fillText(labels[k], lx + 15, height - 7);
      lx += ctx.measureText(labels[k]).width + 25;
    }
  }, []);

  useEffect(() => {
    if (!cumulCanvasRef.current || days.length === 0) return;
    drawCumulative(cumulCanvasRef.current, dowCumulative, DOW_COLORS, DOW_LABELS, DOW_TRADING);
  }, [days, dowCumulative, drawCumulative]);

  if (days.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="font-bold text-gray-800 mb-3">カレンダー分析</h3>
        <p className="text-xs text-gray-400">データが不足しています。</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-5">
      <h3 className="font-bold text-gray-800">カレンダー分析</h3>

      {/* Weekday detailed stats */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日別リターン詳細</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1 px-2 text-left text-gray-500 font-medium"></th>
                {DOW_TRADING.map((dow) => (
                  <th key={dow} className="py-1 px-2 text-center font-medium text-gray-700">{DOW_LABELS[dow]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-500">N (サンプル数)</td>
                {DOW_TRADING.map((dow) => (
                  <td key={dow} className="py-1 px-2 text-center font-mono text-gray-600">{dowStats[dow]?.n ?? 0}</td>
                ))}
              </tr>
              {/* Close-to-close */}
              <tr className="border-b border-gray-100 bg-gray-50">
                <td className="py-1 px-2 text-gray-500 font-medium" colSpan={6}>前日比 (Close-to-Close)</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">平均</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.close.mean) : ""}`}>{s ? pct(s.close.mean) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">中央値</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.close.median) : ""}`}>{s ? pct(s.close.median) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">標準偏差</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className="py-1 px-2 text-center font-mono text-gray-600">{s ? pct(s.close.std) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">勝率</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className="py-1 px-2 text-center font-mono text-gray-600">{s ? pct2(s.close.winRate) : "-"}</td>;
                })}
              </tr>
              {/* Intraday */}
              <tr className="border-b border-gray-100 bg-gray-50">
                <td className="py-1 px-2 text-gray-500 font-medium" colSpan={6}>日中 (Open→Close)</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">平均</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.intraday.mean) : ""}`}>{s ? pct(s.intraday.mean) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">中央値</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.intraday.median) : ""}`}>{s ? pct(s.intraday.median) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">勝率</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className="py-1 px-2 text-center font-mono text-gray-600">{s ? pct2(s.intraday.winRate) : "-"}</td>;
                })}
              </tr>
              {/* Overnight */}
              <tr className="border-b border-gray-100 bg-gray-50">
                <td className="py-1 px-2 text-gray-500 font-medium" colSpan={6}>夜間 (PrevClose→Open)</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">平均</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.overnight.mean) : ""}`}>{s ? pct(s.overnight.mean) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-400">中央値</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className={`py-1 px-2 text-center font-mono ${s ? colorClass(s.overnight.median) : ""}`}>{s ? pct(s.overnight.median) : "-"}</td>;
                })}
              </tr>
              <tr>
                <td className="py-1 px-2 text-gray-400">勝率</td>
                {DOW_TRADING.map((dow) => {
                  const s = dowStats[dow];
                  return <td key={dow} className="py-1 px-2 text-center font-mono text-gray-600">{s ? pct2(s.overnight.winRate) : "-"}</td>;
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Monthly stats */}
      <div>
        <div className="text-xs text-gray-500 mb-1">月別リターン詳細</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1 px-1.5 text-left text-gray-500 font-medium"></th>
                {MONTH_LABELS.map((label, m) => (
                  monthStats[m] && <th key={m} className="py-1 px-1.5 text-center font-medium text-gray-700">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">N</td>
                {monthStats.map((s, m) => s && (
                  <td key={m} className="py-1 px-1.5 text-center font-mono text-gray-600">{s.n}</td>
                ))}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">前日比 平均</td>
                {monthStats.map((s, m) => s && (
                  <td key={m} className={`py-1 px-1.5 text-center font-mono ${colorClass(s.close.mean)}`}>{pct2(s.close.mean)}</td>
                ))}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">標準偏差</td>
                {monthStats.map((s, m) => s && (
                  <td key={m} className="py-1 px-1.5 text-center font-mono text-gray-600">{pct2(s.close.std)}</td>
                ))}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">勝率</td>
                {monthStats.map((s, m) => s && (
                  <td key={m} className="py-1 px-1.5 text-center font-mono text-gray-600">{pct2(s.close.winRate)}</td>
                ))}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-1.5 text-gray-500">日中 平均</td>
                {monthStats.map((s, m) => s && (
                  <td key={m} className={`py-1 px-1.5 text-center font-mono ${colorClass(s.intraday.mean)}`}>{pct2(s.intraday.mean)}</td>
                ))}
              </tr>
              <tr>
                <td className="py-1 px-1.5 text-gray-500">夜間 平均</td>
                {monthStats.map((s, m) => s && (
                  <td key={m} className={`py-1 px-1.5 text-center font-mono ${colorClass(s.overnight.mean)}`}>{pct2(s.overnight.mean)}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Weekday x Month cross table */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日 x 月 クロス集計 (前日比 平均)</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1 px-1.5 text-left text-gray-500 font-medium"></th>
                {MONTH_LABELS.map((label, m) => {
                  const hasData = DOW_TRADING.some((dow) => crossStats[dow][m] !== null);
                  return hasData && <th key={m} className="py-1 px-1.5 text-center font-medium text-gray-700">{label}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {DOW_TRADING.map((dow) => (
                <tr key={dow} className="border-b border-gray-100">
                  <td className="py-1 px-1.5 text-gray-600 font-medium">{DOW_LABELS[dow]}</td>
                  {MONTH_LABELS.map((_, m) => {
                    const hasData = DOW_TRADING.some((d) => crossStats[d][m] !== null);
                    if (!hasData) return null;
                    const cell = crossStats[dow][m];
                    if (!cell) return <td key={m} className="py-1 px-1.5 text-center text-gray-300">-</td>;
                    return (
                      <td key={m} className={`py-1 px-1.5 text-center font-mono ${colorClass(cell.mean)}`} title={`N=${cell.n}`}>
                        {pct2(cell.mean)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Cumulative return by weekday */}
      <div>
        <div className="text-xs text-gray-500 mb-1">曜日別 累積リターン</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden">
          <canvas ref={cumulCanvasRef} />
        </div>
      </div>

      {/* Streak analysis */}
      {streakStats && (
        <div>
          <div className="text-xs text-gray-500 mb-1">連騰・連落分析</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-400">最長連騰</div>
              <div className="font-mono text-green-600 text-sm">{streakStats.maxUp}日</div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-400">最長連落</div>
              <div className="font-mono text-red-600 text-sm">{streakStats.maxDown}日</div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-400">平均連騰</div>
              <div className="font-mono text-gray-700 text-sm">{streakStats.avgUp.toFixed(1)}日 ({streakStats.upCount}回)</div>
            </div>
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-gray-400">平均連落</div>
              <div className="font-mono text-gray-700 text-sm">{streakStats.avgDown.toFixed(1)}日 ({streakStats.downCount}回)</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
