"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  todayBin,
  DAY_STATES,
  SCHEMES,
  HORIZONS,
  DayState,
  BinScheme,
  TodayBinResult,
  TodayBin,
  Occurrence,
  entryLabel,
  horizonLabel,
} from "../../lib/today-bin";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

interface Hotspot { x: number; y: number; w: number; h: number; tip: string; onClick?: () => void; }

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
const fmtPct1 = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

function binFill(idx: number, k: number, dim = false): string {
  // 下位=赤 → 上位=緑のグラデーション
  const t = k <= 1 ? 0.5 : idx / (k - 1);
  const r = Math.round(220 - t * (220 - 22));
  const g = Math.round(38 + t * (163 - 38));
  const b = Math.round(38 + t * (74 - 38));
  return `rgba(${r},${g},${b},${dim ? 0.18 : 0.85})`;
}

// ---------- 描画1: 状態値の全履歴分布（今日の位置＋分位境界） ----------
function drawStateDist(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  res: TodayBinResult,
) {
  const ml = 8, mr = 8, mt = 24, mb = 30;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  const vals = res.allStateVals.map((s) => s.v);
  if (vals.length === 0) return;
  // 外れ値で潰れないよう 1〜99%tile にクリップした表示レンジ
  const sorted = [...vals].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.01)];
  const hi = sorted[Math.ceil(sorted.length * 0.99) - 1];
  const span = hi - lo || 1e-6;
  const nb = 50;
  const counts = new Array(nb).fill(0);
  for (const v of vals) {
    const t = (v - lo) / span;
    if (t < 0 || t > 1) continue;
    counts[Math.min(nb - 1, Math.floor(t * nb))]++;
  }
  const maxC = Math.max(1, ...counts);
  const xAt = (v: number) => ml + ((v - lo) / span) * plotW;
  const yBase = mt + plotH;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`「${res.stateLabel}」の全履歴分布（n=${vals.length}）と今日の位置`, ml, 14);

  // 今日のビンの値域を薄く塗る
  if (res.todayBinIdx !== null) {
    const b = res.bins[res.todayBinIdx];
    const x0 = b.rangeLo === null ? ml : Math.max(ml, xAt(b.rangeLo));
    const x1 = b.rangeHi === null ? ml + plotW : Math.min(ml + plotW, xAt(b.rangeHi));
    ctx.fillStyle = "rgba(37,99,235,0.10)";
    ctx.fillRect(x0, mt, Math.max(0, x1 - x0), plotH);
  }

  // ヒストグラム棒
  const bw = plotW / nb;
  for (let i = 0; i < nb; i++) {
    const center = lo + ((i + 0.5) / nb) * span;
    const binIdx = res.bins.findIndex((b) => (b.rangeLo === null || center >= b.rangeLo) && (b.rangeHi === null || center < b.rangeHi));
    ctx.fillStyle = binFill(binIdx < 0 ? 0 : binIdx, res.bins.length);
    const hgt = (counts[i] / maxC) * plotH;
    ctx.fillRect(ml + i * bw + 0.5, yBase - hgt, bw - 1, hgt);
  }

  // 分位境界線
  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  res.edges.forEach((e) => {
    if (e < lo || e > hi) return;
    ctx.beginPath();
    ctx.moveTo(xAt(e), mt);
    ctx.lineTo(xAt(e), yBase);
    ctx.stroke();
  });
  ctx.setLineDash([]);

  // 0%線
  if (lo <= 0 && hi >= 0) {
    ctx.strokeStyle = "#6b7280";
    ctx.beginPath();
    ctx.moveTo(xAt(0), mt);
    ctx.lineTo(xAt(0), yBase);
    ctx.stroke();
    ctx.fillStyle = "#6b7280";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("0%", xAt(0), yBase + 22);
  }

  // 今日の縦線
  if (res.todayValue !== null) {
    const tx = Math.max(ml, Math.min(ml + plotW, xAt(res.todayValue)));
    ctx.strokeStyle = "#1d4ed8";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(tx, mt - 4);
    ctx.lineTo(tx, yBase);
    ctx.stroke();
    ctx.fillStyle = "#1d4ed8";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = tx > ml + plotW * 0.7 ? "right" : "left";
    ctx.fillText(`今日 ${fmtPct(res.todayValue)}`, tx + (tx > ml + plotW * 0.7 ? -4 : 4), mt + 8);
  }

  // X軸ラベル（両端）
  ctx.fillStyle = "#9ca3af";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`${fmtPct(lo)}`, ml, yBase + 12);
  ctx.textAlign = "right";
  ctx.fillText(`${fmtPct(hi)}`, ml + plotW, yBase + 12);
}

// ---------- 描画2: 該当ビンの先行きリターン分布 ----------
function drawFwdDist(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bin: TodayBin,
  res: TodayBinResult,
) {
  const ml = 8, mr = 8, mt = 24, mb = 30;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  const vals = bin.forwards;
  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`該当ビンの先行きリターン分布（${res.horizonLabel}まで・n=${vals.length}）`, ml, 14);
  if (vals.length < 3) {
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    ctx.fillText("標本が不足しています。", ml, mt + 20);
    return;
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const lo = Math.min(sorted[0], -1e-4);
  const hi = Math.max(sorted[sorted.length - 1], 1e-4);
  const span = hi - lo || 1e-6;
  const nb = Math.min(30, Math.max(8, Math.round(Math.sqrt(vals.length) * 1.5)));
  const counts = new Array(nb).fill(0);
  for (const v of vals) counts[Math.min(nb - 1, Math.floor(((v - lo) / span) * nb))]++;
  const maxC = Math.max(1, ...counts);
  const xAt = (v: number) => ml + ((v - lo) / span) * plotW;
  const yBase = mt + plotH;
  const bw = plotW / nb;
  for (let i = 0; i < nb; i++) {
    const center = lo + ((i + 0.5) / nb) * span;
    ctx.fillStyle = center >= 0 ? "rgba(22,163,74,0.8)" : "rgba(220,38,38,0.8)";
    const hgt = (counts[i] / maxC) * plotH;
    ctx.fillRect(ml + i * bw + 0.5, yBase - hgt, bw - 1, hgt);
  }
  // 0%線
  ctx.strokeStyle = "#6b7280";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(xAt(0), mt);
  ctx.lineTo(xAt(0), yBase);
  ctx.stroke();
  // 平均線
  ctx.strokeStyle = "#1d4ed8";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 2]);
  ctx.beginPath();
  ctx.moveTo(xAt(bin.meanFwd), mt);
  ctx.lineTo(xAt(bin.meanFwd), yBase);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#1d4ed8";
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`平均${fmtPct(bin.meanFwd)}`, xAt(bin.meanFwd), mt + 8);
  // X軸
  ctx.fillStyle = "#9ca3af";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(fmtPct(lo), ml, yBase + 12);
  ctx.textAlign = "right";
  ctx.fillText(fmtPct(hi), ml + plotW, yBase + 12);
}

// ---------- 描画3: 状態値 × 先行きリターン 散布図（全履歴） ----------
function drawScatter(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  res: TodayBinResult,
  hotspots: Hotspot[],
) {
  const ml = 46, mr = 12, mt = 24, mb = 28;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  const pts = res.scatter;
  if (pts.length === 0) return;
  const xs = pts.map((p) => p.v).sort((a, b) => a - b);
  const ys = pts.map((p) => p.fwd).sort((a, b) => a - b);
  const xlo = xs[Math.floor(xs.length * 0.01)], xhi = xs[Math.ceil(xs.length * 0.99) - 1];
  const ylo = ys[Math.floor(ys.length * 0.02)], yhi = ys[Math.ceil(ys.length * 0.98) - 1];
  const xspan = xhi - xlo || 1e-6, yspan = yhi - ylo || 1e-6;
  const xAt = (v: number) => ml + ((Math.max(xlo, Math.min(xhi, v)) - xlo) / xspan) * plotW;
  const yAt = (v: number) => mt + ((yhi - Math.max(ylo, Math.min(yhi, v))) / yspan) * plotH;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`全履歴: 「${res.stateLabel}」(横) → 先行き(縦, ${res.horizonLabel})  n=${pts.length}`, ml - 38, 14);

  // 軸0線
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  if (ylo <= 0 && yhi >= 0) { ctx.beginPath(); ctx.moveTo(ml, yAt(0)); ctx.lineTo(ml + plotW, yAt(0)); ctx.stroke(); }
  if (xlo <= 0 && xhi >= 0) { ctx.beginPath(); ctx.moveTo(xAt(0), mt); ctx.lineTo(xAt(0), mt + plotH); ctx.stroke(); }

  // 点
  for (const p of pts) {
    ctx.fillStyle = p.fwd >= 0 ? "rgba(22,163,74,0.45)" : "rgba(220,38,38,0.45)";
    ctx.beginPath();
    ctx.arc(xAt(p.v), yAt(p.fwd), 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // ビンごとの平均（階段）
  ctx.strokeStyle = "#1d4ed8";
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  res.bins.forEach((b) => {
    if (b.n < 3) return;
    const x0 = b.rangeLo === null ? xlo : b.rangeLo;
    const x1 = b.rangeHi === null ? xhi : b.rangeHi;
    const y = yAt(b.meanFwd);
    if (!started) { ctx.moveTo(xAt(x0), y); started = true; } else ctx.lineTo(xAt(x0), y);
    ctx.lineTo(xAt(x1), y);
    hotspots.push({
      x: xAt(x0), y: mt, w: Math.max(2, xAt(x1) - xAt(x0)), h: plotH,
      tip: `${b.label}｜平均${fmtPct(b.meanFwd)}・勝率${(b.winRate * 100).toFixed(0)}%・n=${b.n}`,
    });
  });
  ctx.stroke();

  // 今日の縦線
  if (res.todayValue !== null) {
    const tx = xAt(res.todayValue);
    ctx.strokeStyle = "#1d4ed8";
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(tx, mt);
    ctx.lineTo(tx, mt + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#1d4ed8";
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = tx > ml + plotW * 0.7 ? "right" : "left";
    ctx.fillText("今日", tx + (tx > ml + plotW * 0.7 ? -3 : 3), mt + 10);
  }

  // Y軸ラベル
  ctx.fillStyle = "#9ca3af";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(fmtPct1(yhi), ml - 4, mt + 8);
  ctx.fillText("0%", ml - 4, yAt(0) + 3);
  ctx.fillText(fmtPct1(ylo), ml - 4, mt + plotH);
  ctx.textAlign = "left";
  ctx.fillText(fmtPct1(xlo), ml, mt + plotH + 14);
  ctx.textAlign = "right";
  ctx.fillText(fmtPct1(xhi), ml + plotW, mt + plotH + 14);
}

// ---------- 発生日テーブル ----------
function OccurrenceTable({ occ }: { occ: Occurrence[] }) {
  const sorted = useMemo(() => [...occ].sort((a, b) => (a.date < b.date ? 1 : -1)), [occ]);
  const shown = sorted.slice(0, 16);
  return (
    <div>
      <p className="text-[11px] text-gray-500 mb-1">同ビンの発生日（新しい順・最大16件 / 全{occ.length}件）</p>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-gray-400 border-b border-gray-200">
              <th className="text-left px-1.5 py-0.5">日付</th>
              <th className="text-right px-1.5">状態値</th>
              <th className="text-right px-1.5">→ 先行き</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((o, i) => (
              <tr key={i} className="border-b border-gray-50">
                <td className="px-1.5 py-0.5 text-gray-600">{o.date.slice(0, 10)}</td>
                <td className="px-1.5 text-right text-gray-500">{fmtPct(o.stateVal)}</td>
                <td className={`px-1.5 text-right font-medium ${o.fwd >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtPct(o.fwd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function actionTag(action: TodayBin["action"]) {
  if (action === "long") return <span className="inline-block rounded bg-green-100 text-green-700 px-1.5 py-0.5 text-[10px] font-bold">買い候補</span>;
  if (action === "short") return <span className="inline-block rounded bg-red-100 text-red-700 px-1.5 py-0.5 text-[10px] font-bold">売り/回避</span>;
  return <span className="inline-block rounded bg-gray-100 text-gray-500 px-1.5 py-0.5 text-[10px]">エッジ薄</span>;
}

type View = "fwd" | "scatter";

export default function TodayBinChart({ prices }: Props) {
  const distRef = useRef<HTMLCanvasElement>(null);
  const fwdRef = useRef<HTMLCanvasElement>(null);
  const scatterRef = useRef<HTMLCanvasElement>(null);
  const hotspotsRef = useRef<Hotspot[]>([]);

  const [state, setState] = useState<DayState>("gapClose");
  const [scheme, setScheme] = useState<BinScheme>("quintile");
  const [horizon, setHorizon] = useState(1);
  const [view, setView] = useState<View>("fwd");
  const [selBin, setSelBin] = useState<number | null>(null); // 明示選択。nullなら今日のビン
  const [tip, setTip] = useState<{ left: number; top: number; text: string } | null>(null);

  const entry = DAY_STATES.find((s) => s.value === state)!.entry;
  const horizons = entry === "close" ? HORIZONS.filter((h) => h !== 0) : HORIZONS;

  const res = useMemo(
    () => (prices.length < 60 ? null : todayBin(prices, state, scheme, horizon)),
    [prices, state, scheme, horizon],
  );

  const activeBinIdx = selBin !== null ? selBin : res?.todayBinIdx ?? null;
  const activeBin = res && activeBinIdx !== null ? res.bins[activeBinIdx] : null;

  // 状態/分割/先行きを変えたら選択ビンを今日のビンに戻す（レンダー中の派生リセット）
  const sigKey = `${state}|${scheme}|${horizon}`;
  const [prevKey, setPrevKey] = useState(sigKey);
  if (prevKey !== sigKey) { setPrevKey(sigKey); setSelBin(null); }

  // 描画
  useEffect(() => {
    if (!res) return;
    hotspotsRef.current = [];
    if (distRef.current) {
      const init = initCanvas(distRef.current, 150);
      if (init) drawStateDist(init.ctx, init.width, init.height, res);
    }
    if (view === "fwd" && fwdRef.current && activeBin) {
      const init = initCanvas(fwdRef.current, 170);
      if (init) drawFwdDist(init.ctx, init.width, init.height, activeBin, res);
    } else if (view === "scatter" && scatterRef.current) {
      const init = initCanvas(scatterRef.current, 230);
      if (init) drawScatter(init.ctx, init.width, init.height, res, hotspotsRef.current);
    }
  }, [res, view, activeBin]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const hs = hotspotsRef.current.find((h) => mx >= h.x && mx <= h.x + h.w && my >= h.y && my <= h.y + h.h);
    setTip(hs ? { left: mx, top: my, text: hs.tip } : null);
  };

  if (prices.length < 60) return null;

  const stateDesc = DAY_STATES.find((s) => s.value === state)!.desc;
  const k = res?.bins.length ?? 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div>
        <h3 className="font-bold text-gray-800">今日の値動き → リターンビン即時判断（曜日非依存）</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          取得した最新データ（今日の始値など）を前日始値/終値と比べたリターンとして数値化し、過去全履歴のどの分位ビンに該当するかを特定。
          同じビンに入った過去の日が“その後どう動いたか”の分布・期待値で、今まさにの売買を判断する。
        </p>
      </div>

      {/* コントロール */}
      <div className="space-y-2 bg-gray-50 rounded-md p-2.5">
        <div className="flex items-start gap-2 text-xs flex-wrap">
          <span className="text-gray-500 w-16 pt-1">今日の状態</span>
          <div className="flex flex-wrap gap-1">
            {DAY_STATES.map((s) => (
              <button key={s.value} onClick={() => setState(s.value)} title={s.desc}
                className={`px-2.5 py-1 rounded font-medium ${state === s.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{s.short}</button>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-gray-400 pl-[4.5rem] -mt-1">{stateDesc}</p>
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className="text-gray-500 w-16">分割</span>
          {SCHEMES.map((s) => (
            <button key={s.value} onClick={() => setScheme(s.value)}
              className={`px-2 py-0.5 rounded ${scheme === s.value ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{s.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className="text-gray-500 w-16">先行き</span>
          {horizons.map((h) => (
            <button key={h} onClick={() => setHorizon(h)}
              className={`px-2 py-0.5 rounded ${horizon === h ? "bg-gray-800 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{horizonLabel(h)}</button>
          ))}
        </div>
      </div>

      {!res ? (
        <p className="text-xs text-gray-400">標本が不足しています。</p>
      ) : (
        <>
          {/* ヘッドライン */}
          {res.todayValue !== null && res.todayBinIdx !== null && (() => {
            const tb = res.bins[res.todayBinIdx];
            const pct = res.todayPercentile ?? 0;
            return (
              <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 space-y-1">
                <div>
                  <span className="font-bold">{res.todayDate?.slice(0, 10)}</span> の「{res.stateLabel}」は{" "}
                  <span className="font-bold">{fmtPct(res.todayValue)}</span>{" "}
                  → 過去分布の<span className="font-bold">下から{(pct * 100).toFixed(0)}%</span>地点、
                  <span className="font-bold">「{tb.label.split(" ")[0]}」</span>ビンに該当
                  {!res.todayHasForward && <span className="text-blue-500">（建玉は{entryLabel(res.entry)}・{res.horizonLabel}まで進行中）</span>}
                </div>
                <div>
                  → 過去同ビンの{entryLabel(res.entry)}建て・{res.horizonLabel}までは{" "}
                  <span className="font-bold">平均 {fmtPct(tb.meanFwd)}</span>・勝率{" "}
                  <span className="font-bold">{(tb.winRate * 100).toFixed(0)}%</span>
                  （n={tb.n}、95%CI {fmtPct(tb.ciLow)}〜{fmtPct(tb.ciHigh)}）{" "}
                  <StatBadge n={tb.n} p={tb.p} significant={tb.significant} /> {actionTag(tb.action)}
                </div>
                <div className="text-blue-500">
                  基準（無条件・全日）: 平均 {fmtPct(res.baselineMean)}・勝率 {(res.baselineWin * 100).toFixed(0)}%（n={res.totalN}）
                </div>
              </div>
            );
          })()}

          {/* 状態値の全履歴分布＋今日の位置 */}
          <canvas ref={distRef} />

          {/* ビュー切替 */}
          <div className="flex gap-1 text-xs">
            {([["fwd", "該当ビンの先行き分布"], ["scatter", "全履歴 散布図"]] as [View, string][]).map(([v, lab]) => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1 rounded font-medium ${view === v ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{lab}</button>
            ))}
            {selBin !== null && (
              <button onClick={() => setSelBin(null)} className="px-3 py-1 rounded bg-amber-100 text-amber-700 hover:bg-amber-200">今日のビンに戻す</button>
            )}
          </div>

          {view === "fwd" ? (
            <canvas ref={fwdRef} />
          ) : (
            <div className="relative">
              <canvas ref={scatterRef} onMouseMove={onMove} onMouseLeave={() => setTip(null)} />
              {tip && <div className="pointer-events-none absolute z-10 max-w-[260px] rounded bg-gray-900/90 px-2 py-1 text-[10px] text-white shadow" style={{ left: Math.min(tip.left + 10, 9999), top: tip.top + 10 }}>{tip.text}</div>}
            </div>
          )}

          {/* ビン表 */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">ビン（{res.stateLabel}の値域）</th>
                  <th className="text-right px-2">n</th><th className="text-right px-2">平均</th><th className="text-right px-2">中央値</th>
                  <th className="text-left px-2">勝率</th><th className="text-left px-2">95%CI</th><th className="text-left px-2">有意性</th><th className="text-left px-2">判断</th>
                </tr>
              </thead>
              <tbody>
                {res.bins.map((b) => {
                  const isNow = b.idx === res.todayBinIdx;
                  const isSel = b.idx === activeBinIdx;
                  return (
                    <tr key={b.idx} onClick={() => setSelBin(b.idx)}
                      className={`border-b border-gray-100 cursor-pointer hover:bg-indigo-50 ${isNow ? "ring-2 ring-blue-400 ring-inset" : ""} ${isSel ? "bg-indigo-50" : ""}`}>
                      <td className="py-1 px-2 font-medium text-gray-700">
                        <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: binFill(b.idx, k) }} />
                        {isNow && <span className="text-blue-600 mr-1">◀今日</span>}{b.label}
                      </td>
                      <td className="text-right px-2 text-gray-600">{b.n}</td>
                      <td className={`text-right px-2 font-medium ${b.meanFwd >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtPct(b.meanFwd)}</td>
                      <td className="text-right px-2 text-gray-600">{fmtPct(b.medianFwd)}</td>
                      <td className="px-2"><div className="flex items-center gap-1"><div className="relative h-3 w-12 bg-gray-100 rounded-sm overflow-hidden"><div className={`absolute inset-y-0 left-0 ${b.winRate >= 0.5 ? "bg-green-400" : "bg-red-400"}`} style={{ width: `${b.winRate * 100}%` }} /><div className="absolute inset-y-0 left-1/2 w-px bg-gray-400" /></div><span className="text-gray-600 tabular-nums">{(b.winRate * 100).toFixed(0)}%</span></div></td>
                      <td className="px-2 text-gray-500 whitespace-nowrap">{fmtPct(b.ciLow)}〜{fmtPct(b.ciHigh)}</td>
                      <td className="px-2"><StatBadge n={b.n} p={b.p} significant={b.significant} /></td>
                      <td className="px-2">{actionTag(b.action)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-[11px] text-gray-400 mt-1">行クリックでそのビンの先行き分布・発生日に切替（青枠=今日の該当ビン）。</p>
          </div>

          {/* 選択ビンの発生日 */}
          {activeBin && activeBin.occurrences.length > 0 && (
            <div className="rounded-md border border-indigo-200 bg-indigo-50/40 p-3">
              <p className="text-xs font-bold text-indigo-900 mb-2">深掘り: {activeBin.label}{activeBin.idx === res.todayBinIdx ? "（今日のビン）" : ""}</p>
              <OccurrenceTable occ={activeBin.occurrences} />
            </div>
          )}
        </>
      )}

      <AnalysisGuide title="今日の値動き→リターンビン即時判断の詳細理論">
        <p className="font-medium text-gray-700">1. 何をしているか</p>
        <p>{"「今この瞬間にエントリーすべきか」を、今日の値動きが過去のどのリターン帯に位置するかから判断する。曜日や月などのカレンダー要因は一切使わず、純粋に『今日の動きの異常度（分位）』だけを条件にする。これにより全営業日を標本に使え（曜日で絞る分析の約5倍）、10分位や裾の異常値まで統計が安定する。"}</p>

        <p className="font-medium text-gray-700 mt-3">2. 「今日の状態」の定義（前日比リターン）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>夜間ギャップ（前日終値比）</strong> = (本日始値 − 前日終値) / 前日終値。寄付き時点で確定する“窓”。</li>
          <li><strong>前日始値比</strong> = (本日始値 − 前日始値) / 前日始値。前日の寄りと今日の寄りを比べたリターン。</li>
          <li><strong>日中リターン</strong> = (本日終値 − 本日始値) / 本日始値。引け時点で確定。</li>
          <li><strong>当日リターン（前日終値比）</strong> = (本日終値 − 前日終値) / 前日終値。引け時点で確定。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. ビン分割と「今日の位置」</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>選んだ状態値を全履歴で集め、上下(0で2)/3分位/5分位/10分位の<strong>分位境界</strong>で区切る。各ビンの標本数がほぼ揃う。</li>
          <li><strong>分布図</strong>では今日の状態値を青い縦線で、該当ビンを青く塗って示す。今日が「下から何%（パーセンタイル）」かで異常度が一目でわかる。</li>
          <li><strong>パーセンタイル</strong>＝今日の値以下だった過去日の割合。100%に近いほど“過去最大級に上げた状態”。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 先行きリターンと先読みバイアスの排除</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>建てのタイミング</strong>は状態の確定時刻に合わせる。寄付きで確定する状態（窓・前日始値比）は<strong>本日寄付き建て</strong>、引けで確定する状態（日中・当日）は<strong>本日引け建て</strong>。確定前の価格では建てない。</li>
          <li><strong>先行きリターン</strong> = (h営業日先の終値 − 建値) / 建値。h=0は本日引け（寄付き建てのみ）、h=1は翌日引け、…。</li>
          <li>各ビンで平均・中央値・勝率・標準偏差を集計。<strong>95%CI</strong>は移動ブロック・ブートストラップ（系列相関に頑健）。</li>
          <li><strong>有意性</strong>: 平均=0 の1標本t検定 → 全ビンを Benjamini-Hochberg FDR で多重比較補正。n≥10 かつ補正後p&lt;0.05 を「有意」とする。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 3つの図の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>全履歴分布（上図）</strong>: 今日の動きが分布のどこに居るか。裾（端）にあるほど稀＝平均回帰か順張りかの判断材料。</li>
          <li><strong>該当ビンの先行き分布</strong>: 同じビンの過去日が“その後どう動いたか”。平均が同じでも、勝率高めで小さく勝つ型か、たまの大勝で平均が持ち上がる型かを形で見分ける。</li>
          <li><strong>全履歴散布図</strong>: 横=今日の状態値、縦=先行きリターンの全点雲＋ビン平均の階段。右肩上がりならモメンタム（順張り）、右肩下がりなら逆張り（平均回帰）の地合い。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>今日のビンの<strong>判断列</strong>が「買い候補」かつ基準（無条件平均）を超え、散布図の傾きと整合するなら順張りエントリーの後押し。</li>
          <li>裾のビン（最上位/最下位）で先行きが<strong>逆符号</strong>なら平均回帰（行き過ぎの戻り取り）。</li>
          <li>発生日一覧で<strong>最近も効いているか</strong>を確認（古い時代だけのエッジは陳腐化している可能性）。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>取引コスト・スリッページ・寄付きの板の薄さは未考慮。窓の大きい日は実約定が想定とずれやすい。</li>
          <li>分位境界は標本依存。期間（PeriodSelector）を変えると境界もビン成績も動く。必ず n と有意性を確認し「参考(n小)」は重視しない。</li>
          <li>これは曜日・月などのカレンダー文脈を捨てた分析。曜日固有の癖は別コンポーネント「曜日 × 値動きビン 条件付き分析」で補完する。統計的有意≠実用的有意。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
