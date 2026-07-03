"use client";

// 日内累積パス層別コンポーネント(曜日/月内位置/曜日×米国)で共有する描画・UI部品。
// intraday-path-core の PathStat/PairDiff を受けて、Canvas2Dの重ね描き・凡例・
// 寄り→引けサマリー表・群間差マトリクス・原系列タイムラインを提供する。

import { useEffect, useRef } from "react";
import {
  createChart, LineSeries, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time,
} from "lightweight-charts";
import { PathStat, PairDiff } from "../../lib/intraday-path-core";
import { fmtSignedPct, drawTimeAxisLabels } from "./intradayShared";
import StatBadge from "./StatBadge";

// 群別の平均パス(+任意で中央値・95%帯)とピーク/ボトム点をCanvasに重ね描く。
export function drawPathStats(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  stats: PathStat[], timeLabels: string[], maxAbs: number,
  opts: { showBand: boolean; showMedian: boolean }
) {
  const ml = 44, mr = 10, mt = 10, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const G = timeLabels.length;
  if (G < 2) return;
  const yMax = maxAbs * 1.05;
  const X = (g: number) => ml + (g / (G - 1)) * plotW;
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;

  // グリッド + ゼロ線
  ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();

  // 縦軸目盛
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmtSignedPct(yMax, 1), ml - 3, mt + 8);
  ctx.fillText("0", ml - 3, Y(0) + 3);
  ctx.fillText(fmtSignedPct(-yMax, 1), ml - 3, mt + plotH);

  // 95%帯
  if (opts.showBand) {
    for (const b of stats) {
      if (b.n === 0) continue;
      ctx.fillStyle = b.color + "22";
      ctx.beginPath();
      for (let g = 0; g < G; g++) ctx.lineTo(X(g), Y(b.hi[g]));
      for (let g = G - 1; g >= 0; g--) ctx.lineTo(X(g), Y(b.lo[g]));
      ctx.closePath(); ctx.fill();
    }
  }

  // 中央値パス(破線)
  if (opts.showMedian) {
    ctx.setLineDash([3, 3]); ctx.lineWidth = 1.5;
    for (const b of stats) {
      if (b.n === 0) continue;
      ctx.strokeStyle = b.color + "cc";
      ctx.beginPath();
      for (let g = 0; g < G; g++) { const x = X(g), y = Y(b.med[g]); if (g === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // 平均パス(実線)
  for (const b of stats) {
    if (b.n === 0) continue;
    ctx.strokeStyle = b.color; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let g = 0; g < G; g++) { const x = X(g), y = Y(b.mean[g]); if (g === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  }

  // ピーク(▲塗り)・ボトム(▽白抜き)マーカー
  for (const b of stats) {
    if (b.n === 0) continue;
    const px = X(b.peakIdx), py = Y(b.mean[b.peakIdx]);
    ctx.fillStyle = b.color;
    ctx.beginPath(); ctx.moveTo(px, py - 4); ctx.lineTo(px - 3.5, py + 2); ctx.lineTo(px + 3.5, py + 2); ctx.closePath(); ctx.fill();
    const tx = X(b.troughIdx), ty = Y(b.mean[b.troughIdx]);
    ctx.strokeStyle = b.color; ctx.lineWidth = 1.2; ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.moveTo(tx, ty + 4); ctx.lineTo(tx - 3.5, ty - 2); ctx.lineTo(tx + 3.5, ty - 2); ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  drawTimeAxisLabels(ctx, timeLabels, ml, plotW / G, H - 6);
}

// 群の色凡例。
export function PathLegend({ stats, withN = true }: { stats: PathStat[]; withN?: boolean }) {
  return (
    <div className="flex items-center gap-3 flex-wrap text-[11px]">
      {stats.map((b) => (
        <span key={b.key} className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: b.color }} />
          <span className="text-gray-600">{b.label}{withN ? `（n=${b.n}）` : ""}</span>
        </span>
      ))}
    </div>
  );
}

// 寄り→引けサマリー表(平均・中央値・ピーク/ボトム時刻・有意性)。
export function PathSummaryTable({
  stats, timeLabels, groupHeader,
}: { stats: PathStat[]; timeLabels: string[]; groupHeader: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 border-b border-gray-200">
            <th className="text-left py-1 px-2">{groupHeader}</th>
            <th className="text-right px-2">日数</th>
            <th className="text-right px-2">寄り→引け平均</th>
            <th className="text-right px-2">中央値</th>
            <th className="text-center px-2">ピーク時刻</th>
            <th className="text-center px-2">ボトム時刻</th>
            <th className="text-left px-2">有意性</th>
          </tr>
        </thead>
        <tbody>
          {stats.filter((b) => b.n > 0).map((b) => (
            <tr key={b.key} className="border-b border-gray-100">
              <td className="py-1 px-2">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: b.color }} />
                  <span className="text-gray-700">{b.label}</span>
                </span>
              </td>
              <td className="text-right px-2 text-gray-600">{b.n}</td>
              <td className={`text-right px-2 font-medium ${b.endMean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(b.endMean)}</td>
              <td className={`text-right px-2 ${b.endMed >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(b.endMed)}</td>
              <td className="text-center px-2 text-gray-600">
                <span className="text-blue-600">▲</span> {timeLabels[b.peakIdx] ?? "-"} <span className="text-gray-400">({fmtSignedPct(b.mean[b.peakIdx])})</span>
              </td>
              <td className="text-center px-2 text-gray-600">
                <span className="text-red-500">▽</span> {timeLabels[b.troughIdx] ?? "-"} <span className="text-gray-400">({fmtSignedPct(b.mean[b.troughIdx])})</span>
              </td>
              <td className="px-2"><StatBadge n={b.n} p={b.endP} significant={b.endP < 0.05} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 群ペアの終端差マトリクス(上三角)。セル=差(行−列)、色=符号、★=FDR有意。
export function PairDiffMatrix({ stats, pairDiffs }: { stats: PathStat[]; pairDiffs: PairDiff[] }) {
  const active = stats.filter((s) => s.n >= 3);
  if (active.length < 2) return null;
  const lookup = new Map<string, PairDiff>();
  for (const d of pairDiffs) lookup.set(`${d.i}-${d.j}`, d);
  const anySig = pairDiffs.some((d) => d.pAdj < 0.05);

  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-gray-700">群間の寄り→引け差の検定（行 − 列）</div>
      <div className="overflow-x-auto">
        <table className="text-[11px] border-collapse">
          <thead>
            <tr>
              <th className="p-1"></th>
              {active.map((c) => (
                <th key={c.key} className="p-1 text-gray-600 font-medium">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {active.map((r) => {
              const ri = stats.indexOf(r);
              return (
                <tr key={r.key}>
                  <td className="p-1 text-gray-600 font-medium text-right">{r.label}</td>
                  {active.map((c) => {
                    const ci = stats.indexOf(c);
                    if (ri === ci) return <td key={c.key} className="p-1 text-center text-gray-300">—</td>;
                    const key = ri < ci ? `${ri}-${ci}` : `${ci}-${ri}`;
                    const d = lookup.get(key);
                    if (!d) return <td key={c.key} className="p-1 text-center text-gray-300">·</td>;
                    const diff = ri < ci ? d.diff : -d.diff;
                    const sig = d.pAdj < 0.05;
                    return (
                      <td
                        key={c.key}
                        title={`差 ${fmtSignedPct(diff)} / p=${d.p.toFixed(3)} / FDR ${d.pAdj.toFixed(3)}`}
                        className={`p-1 text-center tabular-nums ${sig ? "font-bold" : ""} ${diff >= 0 ? "text-green-700" : "text-red-700"} ${sig ? "bg-amber-50" : ""}`}
                      >
                        {fmtSignedPct(diff, 1)}{sig ? "★" : ""}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-gray-400">
        {anySig
          ? "★=FDR補正後も有意(p<0.05)。その群ペアは日内の伸びが統計的に異なる=曜日/条件効果の実体。"
          : "FDR補正後に有意なペアなし=群間の終端差は誤差の範囲。層別による日内パスの違いは断定できない。"}
        {" 値は行群−列群の寄り→引け平均差。"}
      </p>
    </div>
  );
}

// 原系列(日次終値)ライン上に、各立会日を群色●で重ねるズーム/パン可能タイムライン。
export interface TimelineDay { date: string; close: number; key: string; }
export function PathTimeline({
  days, colorOf,
}: { days: TimelineDay[]; colorOf: (key: string) => string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 240,
      crosshair: { mode: 0 },
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    chartRef.current = chart;
    const series = chart.addSeries(LineSeries, { color: "#cbd5e1", lineWidth: 1, title: "原系列(終値)" });
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);
    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null; seriesRef.current = null; markersRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(days.filter((d) => d.close > 0).map((d) => ({ time: d.date as Time, value: d.close })));
    const markers: SeriesMarker<Time>[] = days.map((d) => ({
      time: d.date as Time, position: "inBar", color: colorOf(d.key), shape: "circle", size: 1,
    }));
    markersRef.current?.setMarkers(markers);
    if (containerRef.current && containerRef.current.clientWidth > 0) {
      chartRef.current?.applyOptions({ width: containerRef.current.clientWidth });
    }
    chartRef.current?.timeScale().fitContent();
  }, [days, colorOf]);

  return <div ref={containerRef} className="w-full rounded border border-gray-100" />;
}
