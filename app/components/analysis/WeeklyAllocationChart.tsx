"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  computeWeeklyAllocation,
  WeeklyAllocResult,
  TickerPrices,
  Side,
  EXIT_LABEL,
  growthRatio,
} from "../../lib/weekly-allocation";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
}

const bp = (v: number) => `${(v * 10000).toFixed(1)}bp`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const yen = (v: number) => `${Math.round(v).toLocaleString()}円`;

const CAPITAL_KEY = "pf-entry-sizing-capital";
const LOT_KEY = "pf-entry-sizing-lot";

// 発注単位（単元株）。日本株は原則100株単位、それ以外は1株。
function autoLot(ticker: string): number {
  return /\.(T|JP)$/i.test(ticker) ? 100 : 1;
}

// 注文画面で検索するのは銘柄コードなので、コードを必ず前に出す。
function codeName(ticker: string, name: string): string {
  return name && name !== ticker ? `${ticker} ${name}` : ticker;
}

export interface OrderRow {
  ticker: string;
  label: string;
  price: number;
  lot: number;
  shares: number;
  amount: number;
  realizedWeight: number; // 単元丸め後の実配分
  targetWeight: number;
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

// ① 銘柄別の配分：単独ケリー（相関無視）と最適配分を並べ、オーバーベットを見せる
function drawAllocation(
  ctx: CanvasRenderingContext2D, width: number, height: number,
  r: WeeklyAllocResult, orders: Map<string, OrderRow>
) {
  const ml = 148;
  const mr = 72;
  const mt = 26;
  const mb = 18;
  const plotW = width - ml - mr;
  const rows = r.perStock.length + 1; // +1 = 現金
  const rowH = (height - mt - mb) / rows;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("配分：単独ケリー（灰・相関無視）vs 相関を織り込んだ最適配分（青）", 4, 14);

  const maxV = Math.max(0.05, ...r.perStock.map((s) => Math.max(s.soloKelly, s.weight)), r.cash);
  const x = (v: number) => ml + (v / maxV) * plotW;

  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ml, mt);
  ctx.lineTo(ml, mt + rowH * rows);
  ctx.stroke();

  const sorted = [...r.perStock].sort((a, b) => b.weight - a.weight);
  sorted.forEach((s, i) => {
    const cy = mt + rowH * (i + 0.5);
    // 注文時に検索するのは銘柄コードなので、コードを太字で前置し、社名は幅に収まる分だけ
    ctx.textAlign = "right";
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#9ca3af";
    const nm = s.name && s.name !== s.ticker ? s.name : "";
    const codeW = ctx.measureText(s.ticker).width;
    let shown = nm;
    while (shown.length > 1 && ctx.measureText(`${shown} `).width + codeW > ml - 12) {
      shown = shown.slice(0, -1);
    }
    if (shown && shown !== nm) shown = `${shown.slice(0, -1)}…`;
    if (shown) ctx.fillText(shown, ml - 8 - codeW - 4, cy + 3);
    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.fillText(s.ticker, ml - 6, cy + 3);

    const h = Math.min(rowH * 0.34, 9);
    ctx.fillStyle = "rgba(156,163,175,0.55)";
    ctx.fillRect(ml, cy - h - 1, Math.max(0, x(s.soloKelly) - ml), h);
    ctx.fillStyle = "rgba(37,99,235,0.8)";
    ctx.fillRect(ml, cy + 1, Math.max(0, x(s.weight) - ml), h);

    const o = orders.get(s.ticker);
    ctx.fillStyle = "#1f2937";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(
      o && o.shares > 0 ? `${pct(s.weight)} / ${o.shares.toLocaleString()}株` : pct(s.weight),
      Math.max(x(s.weight), ml) + 4, cy + 8
    );
  });

  // 現金
  const cy = mt + rowH * (sorted.length + 0.5);
  ctx.fillStyle = "#4b5563";
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("現金", ml - 6, cy + 3);
  ctx.fillStyle = "rgba(16,185,129,0.55)";
  ctx.fillRect(ml, cy - 4, Math.max(0, x(r.cash) - ml), 9);
  ctx.fillStyle = "#065f46";
  ctx.textAlign = "left";
  ctx.fillText(pct(r.cash), Math.max(x(r.cash), ml) + 4, cy + 4);
}

// ② スロット別の年率Sharpe。月寄を基準線として強調する。
function drawSlots(ctx: CanvasRenderingContext2D, width: number, height: number, r: WeeklyAllocResult) {
  const ml = 34;
  const mr = 10;
  const mt = 26;
  const mb = 34;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;
  const n = r.slotStats.length;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("エントリー・スロット別の年率Sharpe（同じ出口まで保有。破線=月寄の水準）", 4, 14);

  const maxAbs = Math.max(0.3, ...r.slotStats.map((s) => Math.abs(s.sharpe)));
  const zeroY = mt + plotH / 2;
  const scale = plotH / 2 / maxAbs;

  ctx.strokeStyle = "#d1d5db";
  ctx.beginPath();
  ctx.moveTo(ml, zeroY);
  ctx.lineTo(ml + plotW, zeroY);
  ctx.stroke();

  const slot = plotW / n;
  const bw = Math.min(46, slot * 0.6);
  r.slotStats.forEach((s, i) => {
    const cx = ml + slot * (i + 0.5);
    const h = s.sharpe * scale;
    const up = s.sharpe >= 0;
    const isMon = i === 0;
    const isBest = i === r.bestSlot;
    ctx.fillStyle = isMon
      ? "rgba(217,119,6,0.8)"
      : isBest
      ? "rgba(37,99,235,0.85)"
      : up
      ? "rgba(37,99,235,0.35)"
      : "rgba(220,38,38,0.35)";
    if (up) ctx.fillRect(cx - bw / 2, zeroY - h, bw, h);
    else ctx.fillRect(cx - bw / 2, zeroY, bw, -h);

    ctx.fillStyle = "#374151";
    ctx.font = `${isMon || isBest ? "bold " : ""}10px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(s.sharpe.toFixed(2), cx, up ? zeroY - h - 4 : zeroY - h + 12);
    ctx.fillStyle = isMon ? "#b45309" : "#6b7280";
    ctx.font = `${isMon ? "bold " : ""}9px sans-serif`;
    ctx.fillText(s.label, cx, mt + plotH + 13);
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px sans-serif";
    ctx.fillText(`t=${s.t.toFixed(1)}`, cx, mt + plotH + 24);
  });

  const y = zeroY - r.slotStats[0].sharpe * scale;
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = "#d97706";
  ctx.beginPath();
  ctx.moveTo(ml, y);
  ctx.lineTo(ml + plotW, y);
  ctx.stroke();
  ctx.restore();
}

// ③ 時間分散 k の掃引：確実性等価 CE(k)
function drawSplit(ctx: CanvasRenderingContext2D, width: number, height: number, r: WeeklyAllocResult) {
  const ml = 46;
  const mr = 12;
  const mt = 26;
  const mb = 30;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;
  const n = r.split.length;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("時間分散：先頭kスロットに等分したときの確実性等価 CE(k)（週次）", 4, 14);

  if (n < 2) {
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    ctx.fillText("出口が近すぎてスロットが1つしかありません", ml, mt + plotH / 2);
    return;
  }

  const ces = r.split.map((s) => s.ce);
  const lo = Math.min(...ces);
  const hi = Math.max(...ces);
  const pad = (hi - lo) * 0.2 || Math.abs(hi) * 0.2 || 1e-4;
  const yMin = lo - pad;
  const yMax = hi + pad;
  const xOf = (k: number) => ml + ((k - 1) / (n - 1)) * plotW;
  const yOf = (v: number) => mt + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // ゼロ線
  if (yMin < 0 && yMax > 0) {
    ctx.strokeStyle = "#e5e7eb";
    ctx.beginPath();
    ctx.moveTo(ml, yOf(0));
    ctx.lineTo(ml + plotW, yOf(0));
    ctx.stroke();
  }

  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 2;
  ctx.beginPath();
  r.split.forEach((s, i) => {
    const px = xOf(s.k);
    const py = yOf(s.ce);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  r.split.forEach((s) => {
    const px = xOf(s.k);
    const py = yOf(s.ce);
    const isBest = s.k === r.bestK;
    ctx.fillStyle = isBest ? "#1d4ed8" : "#93c5fd";
    ctx.beginPath();
    ctx.arc(px, py, isBest ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#6b7280";
    ctx.font = `${isBest ? "bold " : ""}9px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(`${s.k}`, px, mt + plotH + 12);
    if (isBest) {
      ctx.fillStyle = "#1d4ed8";
      ctx.font = "bold 9px sans-serif";
      ctx.fillText(bp(s.ce), px, py - 9);
    }
  });

  ctx.fillStyle = "#9ca3af";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(bp(yMax), ml - 4, mt + 4);
  ctx.fillText(bp(yMin), ml - 4, mt + plotH + 3);
  ctx.textAlign = "center";
  ctx.fillText("分割数 k（1=月寄に全額）", ml + plotW / 2, mt + plotH + 24);
}

// ⑤ 成長率カーブ g(λ)/g_max = 2λ − λ²。現在の配分が崖のどこに立つかを示す。
function drawGrowth(ctx: CanvasRenderingContext2D, width: number, height: number, r: WeeklyAllocResult) {
  const ml = 44;
  const mr = 14;
  const mt = 26;
  const mb = 34;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;
  const s = r.stress;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("成長率カーブ g(λ)/g_max = 2λ − λ²（λ=フルケリー比。λ=2 で成長率ゼロ）", 4, 14);

  const lamMax = Math.max(3, ...[s.lambdaOpt, s.lambdaOptStress, s.lambdaSolo, s.lambdaSoloStress].map((v) => v * 1.15));
  const xOf = (l: number) => ml + (l / lamMax) * plotW;
  const yOf = (g: number) => mt + plotH * (1 - (g + 1) / 2); // g ∈ [−1, 1] を描画域に

  // 領域の塗り分け（λ>2 = 成長率マイナス）
  ctx.fillStyle = "rgba(220,38,38,0.07)";
  ctx.fillRect(xOf(2), mt, Math.max(0, ml + plotW - xOf(2)), plotH);

  // ゼロ線・最大線
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  [0, 1].forEach((g) => {
    ctx.beginPath();
    ctx.moveTo(ml, yOf(g));
    ctx.lineTo(ml + plotW, yOf(g));
    ctx.stroke();
  });

  // カーブ
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 200; i++) {
    const l = (i / 200) * lamMax;
    const g = Math.max(-1, growthRatio(l));
    if (i === 0) ctx.moveTo(xOf(l), yOf(g));
    else ctx.lineTo(xOf(l), yOf(g));
  }
  ctx.stroke();

  const marks: { l: number; label: string; color: string }[] = [
    { l: s.lambdaOpt, label: "最適配分", color: "#1d4ed8" },
    { l: s.lambdaOptStress, label: "最適配分＠危機Σ", color: "#7c3aed" },
    { l: s.lambdaSolo, label: "単独ケリー", color: "#d97706" },
    { l: s.lambdaSoloStress, label: "単独ケリー＠危機Σ", color: "#dc2626" },
  ];
  marks.forEach((m, i) => {
    if (!(m.l > 0)) return;
    const g = Math.max(-1, growthRatio(m.l));
    const px = xOf(Math.min(m.l, lamMax));
    const py = yOf(g);
    ctx.strokeStyle = m.color;
    ctx.setLineDash([2, 2]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, mt + plotH);
    ctx.lineTo(px, py);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "9px sans-serif";
    ctx.textAlign = px > ml + plotW * 0.6 ? "right" : "left";
    ctx.fillText(`${m.label} λ=${m.l.toFixed(2)}`, px + (px > ml + plotW * 0.6 ? -6 : 6), mt + 12 + i * 11);
  });

  ctx.fillStyle = "#9ca3af";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("g_max", ml - 4, yOf(1) + 3);
  ctx.fillText("0", ml - 4, yOf(0) + 3);
  ctx.textAlign = "center";
  ctx.fillText("λ = 0", ml, mt + plotH + 14);
  ctx.fillText("λ = 2（成長率ゼロ）", xOf(2), mt + plotH + 14);
  ctx.fillText(`λ = ${lamMax.toFixed(1)}`, ml + plotW, mt + plotH + 14);
  ctx.fillText("フルケリー比 λ", ml + plotW / 2, mt + plotH + 27);
}

export default function WeeklyAllocationChart({ tickers, pricesByTicker, names }: Props) {
  const allocRef = useRef<HTMLCanvasElement>(null);
  const slotRef = useRef<HTMLCanvasElement>(null);
  const splitRef = useRef<HTMLCanvasElement>(null);
  const growthRef = useRef<HTMLCanvasElement>(null);

  const [side, setSide] = useState<Side>("long");
  const [exitDay, setExitDay] = useState(5);
  const [kellyFraction, setKellyFraction] = useState(0.25);
  const [maxWeight, setMaxWeight] = useState(0.3);
  const [budget, setBudget] = useState(1);
  const [muShrink, setMuShrink] = useState(true);
  // 総資産・単元設定は銘柄に依存しないので保存して使い回す。
  // このコンポーネントは ssr:false の動的インポートなので、初期化時に localStorage を読んでよい。
  const [capital, setCapital] = useState(() => {
    const c = Number(localStorage.getItem(CAPITAL_KEY));
    return isFinite(c) && c > 0 ? c : 1_000_000;
  });
  const [lotMode, setLotMode] = useState<"auto" | "100" | "1">(() => {
    const l = localStorage.getItem(LOT_KEY);
    return l === "auto" || l === "100" || l === "1" ? l : "auto";
  });

  useEffect(() => {
    localStorage.setItem(CAPITAL_KEY, String(capital));
  }, [capital]);
  useEffect(() => {
    localStorage.setItem(LOT_KEY, lotMode);
  }, [lotMode]);

  const result = useMemo(() => {
    const stocks: TickerPrices[] = tickers
      .map((t) => ({ ticker: t, name: names?.[t] ?? t, prices: pricesByTicker[t] ?? [] }))
      .filter((s) => s.prices.length > 0);
    return computeWeeklyAllocation(stocks, {
      side, exitDay, kellyFraction, maxWeight, budget, muShrink,
    });
  }, [tickers, pricesByTicker, names, side, exitDay, kellyFraction, maxWeight, budget, muShrink]);

  // 配分% → 実際に出す株数。単元株に切り捨てるので、実配分は目標からズレる。
  const orders = useMemo(() => {
    const m = new Map<string, OrderRow>();
    if (!result.ok) return m;
    for (const s of result.perStock) {
      const px = pricesByTicker[s.ticker]?.[(pricesByTicker[s.ticker]?.length ?? 0) - 1]?.close ?? 0;
      const lot = lotMode === "auto" ? autoLot(s.ticker) : Number(lotMode);
      const shares = px > 0 ? Math.floor((capital * s.weight) / (px * lot)) * lot : 0;
      const amount = shares * px;
      m.set(s.ticker, {
        ticker: s.ticker,
        label: codeName(s.ticker, s.name),
        price: px,
        lot,
        shares,
        amount,
        realizedWeight: capital > 0 ? amount / capital : 0,
        targetWeight: s.weight,
      });
    }
    return m;
  }, [result, pricesByTicker, capital, lotMode]);

  useEffect(() => {
    if (!result.ok) return;
    const draw = () => {
      const a = allocRef.current;
      if (a) {
        const init = initCanvas(a, 60 + 22 * (result.perStock.length + 1));
        if (init) drawAllocation(init.ctx, init.width, init.height, result, orders);
      }
      const s = slotRef.current;
      if (s) {
        const init = initCanvas(s, 200);
        if (init) drawSlots(init.ctx, init.width, init.height, result);
      }
      const p = splitRef.current;
      if (p) {
        const init = initCanvas(p, 190);
        if (init) drawSplit(init.ctx, init.width, init.height, result);
      }
      const g = growthRef.current;
      if (g && result.stress.ok) {
        const init = initCanvas(g, 220);
        if (init) drawGrowth(init.ctx, init.width, init.height, result);
      }
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [result, orders]);

  if (!result.ok) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="text-xs text-gray-500">
          週次エントリー配分：{result.reason ?? "データ待ち"}
        </div>
      </div>
    );
  }

  const r = result;
  const monIsBest = r.bestSlot === 0;
  const monEdgeSignificant = Math.abs(r.monVsAvg.t) >= 1.96;
  // Sharpeの大小だけでは「待ちが勝った」とは言わない。対応のある差が有意なことを要求する。
  const waitBeatsMon = r.waitOOS.sharpe > r.monFixed.sharpe + 1e-9 && r.waitVsMon.t >= 1.96;
  const waitSharpeOnly = r.waitOOS.sharpe > r.monFixed.sharpe + 1e-9 && !waitBeatsMon;
  const overfitGap = r.waitIS.sharpe - r.waitOOS.sharpe;
  const concentrateOk = monIsBest || (r.monVsAvg.diff > 0 && monEdgeSignificant);
  const hindsightGap = r.hindsight.best - r.hindsight.monOpen;
  const reachableGap = r.hindsight.equalAll - r.hindsight.monOpen;
  const orderRows = [...orders.values()];
  const totalAmount = orderRows.reduce((s, o) => s + o.amount, 0);
  const totalShares = orderRows.reduce((s, o) => s + o.shares, 0);
  const noPrice = orderRows.some((o) => o.price <= 0);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-800">
          週次エントリー配分・タイミング配分：どの銘柄に何%、いつ建てるか
        </h3>
        <span className="text-[10px] text-fg-muted">
          {r.nStocks}銘柄 / 全銘柄で揃う{r.nWeeks}週 / {r.from}〜{r.to}
          {r.skippedNoMonday > 0 && ` / 月曜休場の週 ${r.skippedNoMonday} を除外`}
        </span>
      </div>

      {/* 操作 */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-gray-500">方向</span>
          <select className="border border-gray-200 rounded px-1 py-0.5" value={side} onChange={(e) => setSide(e.target.value as Side)}>
            <option value="long">買い（ロング）</option>
            <option value="short">売り（ショート）</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">出口</span>
          <select className="border border-gray-200 rounded px-1 py-0.5" value={exitDay} onChange={(e) => setExitDay(Number(e.target.value))}>
            {EXIT_LABEL.map((l, i) => (
              <option key={l} value={i + 1}>{`${i + 1}日目の引け（${l}）`}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">ケリー係数 f</span>
          <select className="border border-gray-200 rounded px-1 py-0.5" value={kellyFraction} onChange={(e) => setKellyFraction(Number(e.target.value))}>
            <option value={1}>1（フルケリー）</option>
            <option value={0.5}>1/2</option>
            <option value={0.25}>1/4（推奨）</option>
            <option value={0.125}>1/8</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">1銘柄上限</span>
          <select className="border border-gray-200 rounded px-1 py-0.5" value={maxWeight} onChange={(e) => setMaxWeight(Number(e.target.value))}>
            {[0.1, 0.2, 0.3, 0.5, 1].map((v) => (
              <option key={v} value={v}>{pct(v)}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">総建玉上限</span>
          <select className="border border-gray-200 rounded px-1 py-0.5" value={budget} onChange={(e) => setBudget(Number(e.target.value))}>
            <option value={0.5}>50%（半分は現金）</option>
            <option value={1}>100%（レバ無し）</option>
            <option value={2}>200%（信用2倍）</option>
            <option value={3}>300%（信用3倍）</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={muShrink} onChange={(e) => setMuShrink(e.target.checked)} />
          <span className="text-gray-500">μを横断コンセンサスへ縮小</span>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">総資産</span>
          <input
            type="number"
            min={0}
            step={100000}
            className="border border-gray-200 rounded px-1 py-0.5 w-28 text-right"
            value={capital}
            onChange={(e) => setCapital(Math.max(0, Number(e.target.value)))}
          />
          <span className="text-fg-muted">円</span>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">売買単位</span>
          <select className="border border-gray-200 rounded px-1 py-0.5" value={lotMode} onChange={(e) => setLotMode(e.target.value as "auto" | "100" | "1")}>
            <option value="auto">自動（日本株=100株）</option>
            <option value="100">100株</option>
            <option value="1">1株</option>
          </select>
        </label>
      </div>

      {/* 判定 */}
      <div className={`mt-3 rounded p-2.5 text-xs border ${concentrateOk ? "bg-blue-50 border-blue-200 text-blue-900" : "bg-amber-50 border-amber-200 text-amber-900"}`}>
        <div className="font-semibold">
          総建玉 <b>{pct(r.exposure)}</b>（現金 {pct(r.cash)}）／ 実効銘柄数 <b>{r.nEffStocks.toFixed(1)}</b>（{r.nStocks}銘柄・平均相関 {r.rhoBar.toFixed(2)}）
          {r.overbet > 1.05 && <> ／ 単独ケリー合算は <b>{r.overbet.toFixed(1)}倍</b>のオーバーベット</>}
        </div>
        <div className="mt-1 leading-relaxed">
          {concentrateOk
            ? `月寄は週内スロットの平均より ${bp(r.monVsAvg.diff)}（t=${r.monVsAvg.t.toFixed(2)}）有利で、集中させる根拠があります。`
            : `月寄は週内スロットの平均に対して ${bp(r.monVsAvg.diff)}（t=${r.monVsAvg.t.toFixed(2)}）で、有意な優位はありません。「月曜に全額」を支える証拠は薄く、${r.bestSlot > 0 ? `${r.slotLabels[r.bestSlot]}の方がSharpeは高い（${r.slotStats[r.bestSlot].sharpe.toFixed(2)} vs ${r.slotStats[0].sharpe.toFixed(2)}）` : "スロット間の差自体が小さい"}状態です。`}
          {" "}後知恵の最良エントリーは月寄より {bp(hindsightGap)} 上ですが、これは到達不能な上限です（実装可能な差は週内平均との {bp(reachableGap)} の側）。
        </div>
      </div>

      {/* ① 配分 */}
      <div className="mt-4">
        <div className="text-[11px] font-medium text-gray-700">① 銘柄配分（相関を織り込んだケリー）</div>
        <div className="mt-1">
          <canvas ref={allocRef} />
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 pr-2 font-medium">コード</th>
                <th className="text-left py-1 pr-2 font-medium">銘柄名</th>
                <th className="text-right py-1 px-2 font-medium">μ（生）</th>
                <th className="text-right py-1 px-2 font-medium">SE</th>
                <th className="text-right py-1 px-2 font-medium">縮小b</th>
                <th className="text-right py-1 px-2 font-medium">μ̃（縮小後）</th>
                <th className="text-right py-1 px-2 font-medium">週次σ</th>
                <th className="text-right py-1 px-2 font-medium">Sharpe</th>
                <th className="text-right py-1 px-2 font-medium">単独ケリー</th>
                <th className="text-right py-1 px-2 font-medium">配分</th>
                <th className="text-right py-1 px-2 font-medium">現在値</th>
                <th className="text-right py-1 px-2 font-medium bg-blue-50/70">株数</th>
                <th className="text-right py-1 px-2 font-medium">概算金額</th>
                <th className="text-right py-1 pl-2 font-medium">実配分</th>
              </tr>
            </thead>
            <tbody>
              {[...r.perStock].sort((a, b) => b.weight - a.weight).map((s) => {
                const o = orders.get(s.ticker);
                const drift = o ? o.realizedWeight - s.weight : 0;
                return (
                  <tr key={s.ticker} className={`border-b border-gray-100 ${s.weight > 1e-6 ? "" : "text-fg-muted"}`}>
                    <td className="py-1 pr-2 font-mono font-medium text-gray-800 whitespace-nowrap">{s.ticker}</td>
                    <td className="py-1 pr-2 text-gray-600">{s.name === s.ticker ? "—" : s.name}</td>
                    <td className="py-1 px-2 text-right">{bp(s.muRaw)}</td>
                    <td className="py-1 px-2 text-right text-gray-500">±{bp(s.se)}</td>
                    <td className={`py-1 px-2 text-right ${s.b < 0.3 ? "text-amber-600" : "text-gray-600"}`}>{s.b.toFixed(2)}</td>
                    <td className="py-1 px-2 text-right font-medium text-gray-900">{bp(s.muShrunk)}</td>
                    <td className="py-1 px-2 text-right text-gray-600">{pct(s.sigma)}</td>
                    <td className="py-1 px-2 text-right text-gray-600">{s.sharpe.toFixed(2)}</td>
                    <td className="py-1 px-2 text-right text-gray-500">{pct(s.soloKelly)}</td>
                    <td className="py-1 px-2 text-right font-semibold text-blue-700">{pct(s.weight)}</td>
                    <td className="py-1 px-2 text-right text-gray-600">{o && o.price > 0 ? yen(o.price) : "—"}</td>
                    <td className="py-1 px-2 text-right font-semibold text-gray-900 bg-blue-50/70 whitespace-nowrap">
                      {o && o.price > 0 ? `${o.shares.toLocaleString()}株` : "—"}
                      {o && o.price > 0 && o.shares === 0 && (
                        <span className="ml-1 text-[9px] font-normal text-amber-600">1単元({yen(o.price * o.lot)})に届かず</span>
                      )}
                    </td>
                    <td className="py-1 px-2 text-right text-gray-700">{o ? yen(o.amount) : "—"}</td>
                    <td className={`py-1 pl-2 text-right ${Math.abs(drift) > 0.02 ? "text-amber-600 font-medium" : "text-gray-500"}`}>
                      {o ? pct(o.realizedWeight) : "—"}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t border-gray-300 text-gray-600">
                <td className="py-1 pr-2 font-medium" colSpan={2}>合計 / 現金</td>
                <td className="py-1 px-2 text-right" colSpan={3}>
                  横断コンセンサス μ̄ = {bp(r.muGrand)} ±{bp(r.muGrandSe)}
                </td>
                <td className="py-1 px-2 text-right">τ={bp(r.tau)}</td>
                <td className="py-1 px-2 text-right" colSpan={2}>
                  ポート週次 μ {bp(r.port.mu)} / σ {pct(r.port.sigma)}
                </td>
                <td className="py-1 px-2 text-right">{pct(r.soloSum)}</td>
                <td className="py-1 px-2 text-right font-semibold">
                  {pct(r.exposure)}<span className="text-emerald-600"> / {pct(r.cash)}</span>
                </td>
                <td className="py-1 px-2" />
                <td className="py-1 px-2 text-right font-semibold bg-blue-50/70">{totalShares.toLocaleString()}株</td>
                <td className="py-1 px-2 text-right font-semibold">{yen(totalAmount)}</td>
                <td className="py-1 pl-2 text-right font-semibold">
                  {pct(capital > 0 ? totalAmount / capital : 0)}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="mt-1 text-[10px] text-gray-500">
            発注金額合計 <b>{yen(totalAmount)}</b> / 総資産 {yen(capital)}
            {budget <= 1
              ? ` → 未使用現金 ${yen(capital - totalAmount)}（うち単元丸めによる余り ${yen(Math.max(0, r.exposure * capital - totalAmount))}）`
              : ` → 自己資金を ${yen(Math.max(0, totalAmount - capital))} 超過（信用建玉ぶん。実効レバレッジ ${(capital > 0 ? totalAmount / capital : 0).toFixed(2)}倍）`}
            。現在値は各銘柄の最新終値です（実際の約定は月曜の寄付なので、発注前に株数を再計算してください）。
            {noPrice && <span className="text-amber-600"> 一部の銘柄で現在値が取得できず、株数を算出できていません。</span>}
          </p>
          <p className="mt-1 text-[10px] text-fg-muted">
            μ̃ は経験ベイズ縮小後（b=τ²/(τ²+SE²)。b が小さい銘柄は「その銘柄固有のエッジ」が推定誤差に埋もれており、横断平均に寄せられます）。
            Σ は Ledoit-Wolf 収縮。配分は max μ̃ᵀw − (1/2f)·wᵀΣw s.t. 0≤w≤{pct(maxWeight)}, Σw≤{pct(budget)} の解。
            年率Sharpe {r.port.sharpe.toFixed(2)} / 年率成長率近似 g≈{pct(r.port.growth)}。
            無制約ケリー（上限も現金制約も無し）のグロス建玉は {pct(r.uncGross)} で、これが制約の必要性そのものです。
          </p>
        </div>
      </div>

      {/* ② スロット */}
      <div className="mt-4">
        <div className="text-[11px] font-medium text-gray-700">② いつ建てるか：スロット別の成績と後知恵ギャップ</div>
        <div className="mt-1">
          <canvas ref={slotRef} />
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div className="rounded border border-gray-200 p-2">
            <div className="text-[11px] font-medium text-gray-700">後知恵ギャップ（銘柄×週の平均リターン）</div>
            <table className="mt-1 w-full text-[11px]">
              <tbody>
                <tr className="text-gray-500">
                  <td className="py-0.5">完全予見の最良スロット</td>
                  <td className="py-0.5 text-right font-medium text-fg-muted">{bp(r.hindsight.best)}<span className="ml-1 text-[9px]">到達不能</span></td>
                </tr>
                <tr>
                  <td className="py-0.5 text-gray-700">月寄に全額（現行ルール）</td>
                  <td className="py-0.5 text-right font-semibold text-amber-700">{bp(r.hindsight.monOpen)}</td>
                </tr>
                <tr>
                  <td className="py-0.5 text-gray-700">週内スロット等分（時間分散）</td>
                  <td className="py-0.5 text-right font-medium text-gray-900">{bp(r.hindsight.equalAll)}</td>
                </tr>
                <tr className="text-gray-500">
                  <td className="py-0.5">完全予見の最悪スロット</td>
                  <td className="py-0.5 text-right">{bp(r.hindsight.worst)}</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-1 text-[10px] text-fg-muted">
              月寄が週内で最良だった割合 <b>{pct(r.pMonBest)}</b>（一様なら {pct(1 / r.nSlots)}）。
              最良との差 {bp(hindsightGap)} のうち、実装可能なルールで動かせるのは等分との差 {bp(reachableGap)} 程度までです。
            </p>
          </div>
          <div className="rounded border border-gray-200 p-2">
            <div className="text-[11px] font-medium text-gray-700">月寄 − 週内スロット平均（対応のある差の検定）</div>
            <div className="mt-1 text-[11px] text-gray-700">
              差 <b className="text-gray-900">{bp(r.monVsAvg.diff)}</b> ± {bp(r.monVsAvg.se)}
              <span className={`ml-2 font-medium ${monEdgeSignificant ? "text-blue-700" : "text-fg-muted"}`}>
                t = {r.monVsAvg.t.toFixed(2)}
              </span>
            </div>
            <p className="mt-1 text-[10px] text-fg-muted">
              同一週=1クラスタのクラスタ頑健SE。のべ観測に対する実効標本 nEff ≈ {Math.round(r.monVsAvg.nEff).toLocaleString()}。
              t が ±1.96 に届かないなら、月寄と他スロットは統計的に区別できず、
              「月曜に集中する」ことのタイミング面の正当化はできません（それでも執行の単純さという別の理由は残ります）。
            </p>
            <table className="mt-2 w-full text-[10px]">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-0.5 font-medium">スロット</th>
                  <th className="text-right py-0.5 font-medium">μ</th>
                  <th className="text-right py-0.5 font-medium">t</th>
                  <th className="text-right py-0.5 font-medium">Sharpe</th>
                </tr>
              </thead>
              <tbody>
                {r.slotStats.map((s) => (
                  <tr key={s.slot} className={`border-b border-gray-50 ${s.slot === 0 ? "bg-amber-50/60" : s.slot === r.bestSlot ? "bg-blue-50/60" : ""}`}>
                    <td className="py-0.5 text-gray-700">{s.slot === 0 && "▶ "}{s.label}</td>
                    <td className="py-0.5 text-right">{bp(s.mean)}</td>
                    <td className={`py-0.5 text-right ${Math.abs(s.t) >= 1.96 ? "text-blue-700 font-medium" : "text-fg-muted"}`}>{s.t.toFixed(2)}</td>
                    <td className="py-0.5 text-right">{s.sharpe.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ③ 時間分散 */}
      <div className="mt-4">
        <div className="text-[11px] font-medium text-gray-700">③ 資本を週内で分割すべきか（確実性等価の掃引）</div>
        <div className="mt-1">
          <canvas ref={splitRef} />
        </div>
        <div className="mt-1 text-[11px] text-gray-700">
          CE最大は <b>k = {r.bestK}</b>
          {r.bestK === 1
            ? "（＝月寄に全額。分割しても失う期待値のほうが大きい）"
            : `（＝先頭${r.bestK}スロットに ${pct(1 / r.bestK)} ずつ。分割で削れるリスクが失う期待値を上回る）`}
          。k=1 の CE {bp(r.split[0].ce)} に対し k={r.bestK} は {bp(r.split[r.bestK - 1].ce)}。
        </div>
        <p className="mt-1 text-[10px] text-fg-muted">
          CE(k) = μ_k − (1/2f)·σ_k²。μ_k・σ_k は「全銘柄等加重 × 先頭kスロット等分」の週次実現リターン系列から。
          分割は期待ドリフトを削る代わりに建値分散を {"(1+(k−1)ρ_s)/k"} 倍に縮めます。ρ_s（スロット間の建値相関）が高いほど分割の効きは鈍く、k=1 に寄ります。
        </p>
      </div>

      {/* ④ 待つ価値 */}
      <div className="mt-4">
        <div className="text-[11px] font-medium text-gray-700">④ 待つ価値：条件付きエントリーの最適停止（週単位2分割OOS）</div>
        <div className="mt-1 overflow-x-auto">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 pr-2 font-medium">エントリー・ルール</th>
                <th className="text-right py-1 px-2 font-medium">μ</th>
                <th className="text-right py-1 px-2 font-medium">σ</th>
                <th className="text-right py-1 px-2 font-medium">年率Sharpe</th>
                <th className="text-right py-1 px-2 font-medium">勝率</th>
                <th className="text-right py-1 pl-2 font-medium">平均建て時刻</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100 bg-amber-50/60">
                <td className="py-1 pr-2 text-gray-700">月寄に全額（現行ルール）</td>
                <td className="py-1 px-2 text-right">{bp(r.monFixed.mean)}</td>
                <td className="py-1 px-2 text-right text-gray-500">{pct(r.monFixed.sd)}</td>
                <td className="py-1 px-2 text-right font-semibold">{r.monFixed.sharpe.toFixed(2)}</td>
                <td className="py-1 px-2 text-right text-gray-600">{pct(r.monFixed.winRate)}</td>
                <td className="py-1 pl-2 text-right text-gray-500">月寄</td>
              </tr>
              <tr className={`border-b border-gray-100 ${waitBeatsMon ? "bg-blue-50/60" : ""}`}>
                <td className="py-1 pr-2 text-gray-700">条件付きで待つ（OOS）</td>
                <td className="py-1 px-2 text-right">{bp(r.waitOOS.mean)}</td>
                <td className="py-1 px-2 text-right text-gray-500">{pct(r.waitOOS.sd)}</td>
                <td className={`py-1 px-2 text-right font-semibold ${waitBeatsMon ? "text-blue-700" : ""}`}>{r.waitOOS.sharpe.toFixed(2)}</td>
                <td className="py-1 px-2 text-right text-gray-600">{pct(r.waitOOS.winRate)}</td>
                <td className="py-1 pl-2 text-right text-gray-500">{r.slotLabels[Math.round(r.waitOOS.meanSlot)] ?? "-"}付近</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 pr-2 text-gray-700">週内スロット等分（時間分散）</td>
                <td className="py-1 px-2 text-right">{bp(r.equalSplit.mean)}</td>
                <td className="py-1 px-2 text-right text-gray-500">{pct(r.equalSplit.sd)}</td>
                <td className="py-1 px-2 text-right font-semibold">{r.equalSplit.sharpe.toFixed(2)}</td>
                <td className="py-1 px-2 text-right text-gray-600">{pct(r.equalSplit.winRate)}</td>
                <td className="py-1 pl-2 text-right text-gray-500">週内平均</td>
              </tr>
              <tr className="text-fg-muted">
                <td className="py-1 pr-2">（参考）同じ方策を全データで学習・適用（IS）</td>
                <td className="py-1 px-2 text-right">{bp(r.waitIS.mean)}</td>
                <td className="py-1 px-2 text-right">{pct(r.waitIS.sd)}</td>
                <td className="py-1 px-2 text-right">{r.waitIS.sharpe.toFixed(2)}</td>
                <td className="py-1 px-2 text-right">{pct(r.waitIS.winRate)}</td>
                <td className="py-1 pl-2 text-right">{r.slotLabels[Math.round(r.waitIS.meanSlot)] ?? "-"}付近</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className={`mt-2 rounded p-2 text-[11px] border ${waitBeatsMon ? "bg-blue-50 border-blue-200 text-blue-900" : "bg-gray-50 border-gray-200 text-gray-700"}`}>
          <div>
            待つ − 月寄固定（同一の銘柄×週で対応させた差）：
            <b className="ml-1">{bp(r.waitVsMon.diff)}</b> ± {bp(r.waitVsMon.se)}、
            <span className={`ml-1 font-medium ${Math.abs(r.waitVsMon.t) >= 1.96 ? "text-blue-700" : "text-gray-500"}`}>
              t = {r.waitVsMon.t.toFixed(2)}
            </span>
            <span className="ml-2 text-gray-500">（同一週=1クラスタ / nEff ≈ {Math.round(r.waitVsMon.nEff).toLocaleString()}）</span>
          </div>
          <div className="mt-1 leading-relaxed">
            {waitBeatsMon
              ? `OOSでも「条件付きで待つ」が月寄固定を有意に上回りました（Sharpe ${r.waitOOS.sharpe.toFixed(2)} vs ${r.monFixed.sharpe.toFixed(2)}）。ただし IS との差 ${overfitGap.toFixed(2)} が過剰最適化の目安で、これが大きいほど将来の再現性は落ちます。`
              : waitSharpeOnly
              ? `OOSのSharpeは月寄固定を上回って見えます（${r.waitOOS.sharpe.toFixed(2)} vs ${r.monFixed.sharpe.toFixed(2)}）が、対応のある差は t=${r.waitVsMon.t.toFixed(2)} で有意ではありません。Sharpeの大小だけで採用してはいけない典型です。素朴な月寄固定を既定に据えてください。`
              : `OOSでは「条件付きで待つ」は月寄固定を上回りませんでした（Sharpe ${r.waitOOS.sharpe.toFixed(2)} vs ${r.monFixed.sharpe.toFixed(2)}）。IS では ${r.waitIS.sharpe.toFixed(2)} まで上がるのが、後知恵で待ち方を選ぶことの見かけ上の魅力です。素朴な月寄固定を採るのが誠実な既定になります。`}
          </div>
        </div>
        <details className="mt-2 text-[11px]">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-700">学習された「待つ」領域（スロット×月寄比z）</summary>
          <div className="mt-1 overflow-x-auto">
            <table className="text-[10px] border-collapse">
              <tbody>
                {r.slotLabels.slice(0, r.nSlots - 1).map((label, s) => (
                  <tr key={label}>
                    <td className="pr-2 text-gray-600 whitespace-nowrap">{label}</td>
                    {r.policy.action[s].map((a, b) => (
                      <td
                        key={b}
                        title={`z≈${(-4 + (b + 0.5) * 0.5).toFixed(2)} / n=${r.policy.count[s][b]}`}
                        className={`w-3 h-3 border border-white ${
                          r.policy.count[s][b] === 0
                            ? "bg-gray-100"
                            : a === "wait"
                            ? "bg-amber-400"
                            : "bg-blue-200"
                        }`}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-[10px] text-fg-muted">
              左端 z=−4σ …… 右端 z=+4σ（月寄からの累積変動をボラで割った値。買いなら右ほど「もう上がってしまった」）。
              橙=待つ / 青=建てる / 灰=標本なし。標本 {"<"} 12 のビンは「建てる」に倒しています（証拠のある所でだけ素朴ルールから逸脱させる）。
              スロット1行目（月寄）は z≡0 なので全週共通の1つの判断です。
            </p>
          </div>
        </details>
      </div>

      {/* ⑤ 危機時Σ */}
      {r.stress.ok && (
        <div className="mt-4">
          <div className="text-[11px] font-medium text-gray-700">
            ⑤ 危機時Σ：「テールでは相関が1に寄る」を数値で確かめる
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="rounded border border-gray-200 p-2">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-0.5 font-medium">レジーム</th>
                    <th className="text-right py-0.5 font-medium">週数</th>
                    <th className="text-right py-0.5 font-medium">平均相関 ρ̄</th>
                    <th className="text-right py-0.5 font-medium">実効銘柄数</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-gray-100">
                    <td className="py-0.5 text-gray-700">平穏（上位{pct(1 - r.stress.q)}）</td>
                    <td className="py-0.5 text-right text-gray-500">{r.stress.nCalm}</td>
                    <td className="py-0.5 text-right">{r.stress.rhoCalm.toFixed(3)}</td>
                    <td className="py-0.5 text-right">{r.stress.nEffCalm.toFixed(1)}</td>
                  </tr>
                  <tr className="border-b border-gray-100">
                    <td className="py-0.5 text-gray-700">全期間</td>
                    <td className="py-0.5 text-right text-gray-500">{r.nWeeks}</td>
                    <td className="py-0.5 text-right">{r.stress.rhoAll.toFixed(3)}</td>
                    <td className="py-0.5 text-right">{r.stress.nEffAll.toFixed(1)}</td>
                  </tr>
                  <tr className="bg-red-50/60">
                    <td className="py-0.5 font-medium text-gray-800">危機（下位{pct(r.stress.q)}）</td>
                    <td className="py-0.5 text-right text-gray-500">{r.stress.nStress}</td>
                    <td className="py-0.5 text-right font-semibold text-red-700">{r.stress.rhoStress.toFixed(3)}</td>
                    <td className="py-0.5 text-right font-semibold text-red-700">{r.stress.nEffStress.toFixed(1)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-1 text-[10px] text-gray-500">
                危機レジーム＝<b>直近13週のバスケット実現ボラが上位{pct(r.stress.q)}</b>の週。
                同時点の下落率で切ると共通ファクターの実現値を条件付けすることになり、相関が機械的に下がってしまう
                （条件付けバイアス）ため、<b>その週の始まりの時点で既知の情報だけ</b>で切っています。
                {r.stress.rhoStress > r.stress.rhoCalm + 0.03
                  ? ` 高ボラ期に相関が ${r.stress.rhoCalm.toFixed(2)} → ${r.stress.rhoStress.toFixed(2)} へ上がり、実効銘柄数は ${r.stress.nEffCalm.toFixed(1)} → ${r.stress.nEffStress.toFixed(1)} に目減りします。分散は必要なときに効きません。`
                  : " この標本では高ボラ期の相関上昇は目立ちません（真に無いのか、この期間に大きな危機が入っていないだけかは区別できません）。"}
              </p>
            </div>
            <div className="rounded border border-gray-200 p-2">
              <div className="text-[11px] text-gray-700">
                同じ配分のσ：平時 <b>{pct(r.stress.sigmaAll)}</b> → 危機Σで測ると <b className="text-red-700">{pct(r.stress.sigmaStress)}</b>
                （<b>{(r.stress.sigmaAll > 0 ? r.stress.sigmaStress / r.stress.sigmaAll : 1).toFixed(2)}倍</b>）
              </div>
              <div className="mt-1 text-[11px] text-gray-700">
                危機Σで組み直した総建玉 <b>{pct(r.stress.exposureStress)}</b>（現行 {pct(r.exposure)}）。
                そのとき失う期待リターンは週次 {bp(r.stress.muCostStress)}／年率 {pct(r.stress.muCostStress * 52)}。
              </div>
              <p className="mt-1 text-[10px] text-gray-500">
                これが「危機を織り込んで保守化する代金」です。Σ を危機側に置き換えると建玉は下がり、
                平時のリターンをこの分だけ諦めることになります。相関無視で建玉を増やすのとは正反対の方向です。
              </p>
            </div>
          </div>
          <div className="mt-2">
            <canvas ref={growthRef} />
          </div>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 pr-2 font-medium">配分の作り方</th>
                  <th className="text-right py-1 px-2 font-medium">λ（平時Σ）</th>
                  <th className="text-right py-1 px-2 font-medium">成長率 g/g_max</th>
                  <th className="text-right py-1 px-2 font-medium">λ（危機Σ）</th>
                  <th className="text-right py-1 px-2 font-medium">成長率 g/g_max</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: "相関を織り込んだ最適配分（採用）", l: r.stress.lambdaOpt, ls: r.stress.lambdaOptStress, hi: true },
                  { label: "単独ケリーの合算（相関を無視）", l: r.stress.lambdaSolo, ls: r.stress.lambdaSoloStress, hi: false },
                ].map((x) => {
                  const g = growthRatio(x.l);
                  const gs = growthRatio(x.ls);
                  return (
                    <tr key={x.label} className={`border-b border-gray-100 ${x.hi ? "bg-blue-50/60" : ""}`}>
                      <td className="py-1 pr-2 text-gray-700">{x.label}</td>
                      <td className="py-1 px-2 text-right font-medium">{x.l.toFixed(2)}</td>
                      <td className={`py-1 px-2 text-right ${g < 0 ? "text-red-600 font-semibold" : "text-gray-700"}`}>{g.toFixed(2)}</td>
                      <td className={`py-1 px-2 text-right font-medium ${x.ls > 2 ? "text-red-600" : ""}`}>{x.ls.toFixed(2)}</td>
                      <td className={`py-1 px-2 text-right ${gs < 0 ? "text-red-600 font-semibold" : "text-gray-700"}`}>{gs.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {r.stress.lambdaOpt < 0.5 && (
              <p className="mt-1 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-1.5">
                <b>λ が 1 を大きく下回っていますが、レバレッジを掛けろという意味ではありません。</b>
                これは総建玉上限（現在 {pct(budget)}）と1銘柄上限が効いて、フルケリー点まで張れていないという状態です。
                そもそもフルケリーは「μ・Σ が正しく既知」「リターンが正規分布」「連続的に建玉調整できる」という
                現実には成り立たない前提の上限値で、推定誤差・ファットテール・ジャンプを入れると実際の最適点はずっと左にあります。
                この表は<b>右へ行き過ぎていないかを確認するため</b>のもので、左に余裕があることを利用の推奨と読まないでください。
              </p>
            )}
            <p className="mt-1 text-[10px] text-gray-500">
              λ はフルケリー比（λ=1 が成長率最大、λ=2 で成長率ゼロ、λ&gt;2 は資産が減る領域）。
              {r.stress.lambdaSoloStress > 2
                ? ` 単独ケリーの合算は危機Σの下で λ=${r.stress.lambdaSoloStress.toFixed(2)} となり、成長率が負の領域に入ります。「相関を無視してリターンを追う」が実際には長期成長率を削る操作であることが、この行に出ています。`
                : ` この設定では単独ケリー合算も危機Σの下で λ=${r.stress.lambdaSoloStress.toFixed(2)} に留まっています（f を上げると比例して右に動くので、f を大きくする前にこの表を確認してください）。`}
            </p>
          </div>
        </div>
      )}

      <AnalysisGuide title="週次エントリー配分・タイミング配分の詳細理論">
        <p className="font-medium text-gray-700">1. 何をしているか — 2つの問いは1つの最適化</p>
        <p>
          「銘柄ごとに資産の何%を割り当てるか」と「月曜の寄りに全額を賭けてよいか」は、別々の問題に見えて
          同じ最適化の別の断面です。決定変数を「<b>銘柄 i を スロット s（月寄/月引/火寄/…）で建てる重み w<sub>i,s</sub></b>」と置き、
          残り 1 − Σw を現金とすれば、前者は w の銘柄方向の解、後者は w がスロット方向に集中するか・
          Σw が 1 に届くかどうか、という同じ w の読み方の違いになります。
          ここでの「スロット」とは週内で建てうる時刻のことで、月寄＝月曜の始値、月引＝月曜の終値、以下同様です。
          出口は上のセレクタで固定し（既定は金曜引け）、全スロットが同じ出口まで保有するので、純粋に「入口の違い」だけを比べられます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式：配分</p>
        <p>
          週次トレードリターン（月寄で建て、出口で降りた実現リターン）のベクトルを r<sub>t</sub> ∈ R<sup>N</sup> とし、
          μ = E[r]、Σ = Cov(r) とします。対数効用（ケリー）を2次までテイラー展開した目的関数は
        </p>
        <p>{"max_w  μᵀw − (γ/2)·wᵀΣw    s.t.  0 ≤ w_i ≤ cap,  Σw_i ≤ budget"}</p>
        <p>
          で、制約が無ければ解は <b>{"w* = (1/γ)·Σ⁻¹μ"}</b>。γ はリスク回避度で、分数ケリー係数 f に対し γ = 1/f です
          （f=1 がフルケリー、f=1/4 なら建玉はその 1/4）。Σ は半正定値なので目的関数は凹であり、
          制約集合 {"{0≤w≤cap, Σw≤budget}"} への射影勾配上昇で大域最適に到達します。射影は KKT 条件から
          {" w = clip(v−τ, 0, cap)"}（τ≥0、Σw {"<"} budget なら τ=0＝現金が残る）の形で二分探索できます。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 数式：なぜ「単独ケリー」がオーバーベットになるのか</p>
        <p>
          表の「単独ケリー」列は、その銘柄<b>だけ</b>を持つと仮定したときの最適建玉 f·μ<sub>i</sub>/σ<sub>i</sub>² です。
          正しい答え w* = f·Σ⁻¹μ と見比べると、<b>単独ケリーは Σ の非対角成分（＝銘柄間の共分散）を丸ごと無視した式</b>だと分かります。
          実際 Σ が対角行列（相関ゼロ）なら Σ⁻¹μ の第 i 成分はちょうど μ<sub>i</sub>/σ<sub>i</sub>² で、両者は一致します。
          <b>単独ケリーが正しくなるのは「銘柄同士が全く連動しないとき」だけ</b>です。
        </p>
        <p>
          ところが全銘柄を同じ月曜に建てて同じ日に降りるので、r<sub>t</sub> の各成分は強く<b>横断相関</b>します。
          相関がある場合に何が起きるかは、全銘柄が同じ σ・同じ μ・相関が一律 ρ という単純な場合で厳密に解けます。この Σ の逆行列を使うと
        </p>
        <p>{"w*_i = (f/σ²)·μ / (1 + (N−1)ρ)     一方   単独ケリー_i = (f/σ²)·μ"}</p>
        <p>
          つまり正解は<b>単独ケリーを (1+(N−1)ρ) で割った値</b>です。合計で見ると
        </p>
        <p>{"Σ(単独ケリー) / Σ(正しい配分) = 1 + (N−1)·ρ̄ = N / N_eff"}</p>
        <p>
          となり、上のバッジに出る<b>オーバーベット倍率は N/N<sub>eff</sub> にほぼ一致</b>します
          （この等式が厳密に成り立つのは σ・μ・ρ が全銘柄で等しい理想化のときで、実データでは近似です。
          また総建玉が上限に張り付いている場合は、その打ち切りぶんも倍率に上乗せされるため N/N<sub>eff</sub> より大きく出ます）。
        </p>
        <p>
          直感的には、単独ケリーは「各銘柄が独立にリスクを取ってくれる」と仮定して建玉を積みます。
          しかし実際には全員が同じ市場ファクタで一緒に上下するので、10銘柄に分けても<b>ポートフォリオの分散は10分の1にならない</b>。
          分母（リスク）が想定より大きいのに、分子（期待値）だけを銘柄数ぶん足しているのが、オーバーベットの正体です。
          コイン投げに例えるなら、10枚のコインを同時に投げているつもりで、実際は2枚のコインの結果を5回ずつ数えているようなもの。
          「分散しているから安全」と思って建玉を増やした結果、破産確率の高い集中投資になっている、という取り違えです。
          N=10、ρ̄=0.5 なら N<sub>eff</sub> ≈ 1.8 で、単独ケリーの合算は約5.5倍の建玉になります。
        </p>
        <p>
          なお表の単独ケリー列自体は「相関を無視するとどれだけ過大な数字が出るか」を見るための対照であって、
          <b>発注に使ってよいのは「配分」列（と、それを株数に落とした列）だけ</b>です。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 数式：μ の経験ベイズ縮小（これをやらないと数字が嘘になる）</p>
        <p>
          曜日×前夜米国ビンのような条件付きセルの平均 μ̂<sub>i</sub> は標本が薄く、標準誤差 SE<sub>i</sub> が大きい。
          これを生のまま Σ⁻¹ に食わせると誤差が増幅され、極端な重みが出ます。そこで
        </p>
        <p>{"μ̃_i = μ̄ + b_i·(μ̂_i − μ̄),   b_i = τ² / (τ² + SE_i²),   τ² = max(0, Var_cross(μ̂) − avg(SE²))"}</p>
        <p>
          と縮小します。μ̄ は<b>横断コンセンサス</b>（銘柄×週をプールし、同一週=1クラスタでSEを頑健化した平均）、
          τ² は「銘柄間の真のばらつき」の推定値です。表の <b>b</b> が 0 に近い銘柄は、
          「その銘柄固有のエッジ」と見えているものがほぼ推定誤差であることを意味し、配分は横断平均に寄せられます。
          τ²=0（銘柄間分散がすべて推定誤差で説明できる）なら b は全銘柄0で、
          <b>「銘柄ごとに違う配分をする根拠がそもそも無い」</b>という結論になります。
          Σ 側も Ledoit-Wolf 収縮（標本共分散と恒等行列の最適な混合）で条件数を改善しています。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 数式：後知恵ギャップと時間分散</p>
        <p>
          週内軌跡を眺めると月寄が最安に見えないのは当然です。<b>後知恵の最良スロットは、いかなる実行可能ルールも到達できない上限</b>だからです。
          そこで「完全予見の最良／月寄／週内等分／完全予見の最悪」の4点を並べ、月寄と等分の差だけを
          対応のある差の検定（同一週=1クラスタのクラスタ頑健SE）にかけます。これが実装可能な差の全体です。
        </p>
        <p>
          資本を先頭 k スロットに 1/k ずつ分けたときの建値分散は {"(1+(k−1)ρ_s)/k"} 倍に縮みます（ρ<sub>s</sub>=スロット間の建値相関）。
          一方、週内に正のドリフト δ があるなら遅いスロットほど期待リターンを失います。差引きの確実性等価は
        </p>
        <p>{"CE(k) = μ_k − (γ/2)·σ_k²"}</p>
        <p>
          で、これを k について掃引したのが③のグラフです。左端（k=1＝月寄に全額）が最大なら、分割しない方が良いという答えになります。
        </p>

        <p className="font-medium text-gray-700 mt-3">6. 数式：待つ価値（エントリーの最適停止）</p>
        <p>
          「月曜が最安とは限らない」を実行可能な形にすると、<b>各スロットで「いま建てる or 次まで待つ」を選ぶ最適停止問題</b>になります。
          状態は（スロット s, 月寄比 z）。z は月寄からの累積対数リターンを建玉時ボラ σ で割った値で、
          買いなら z が高い＝すでに上がってしまった＝不利な建値です。価値関数を後退帰納で解きます：
        </p>
        <p>{"V(S−1, z) = E[R_{S−1} | z]                          … 最終候補スロット＝強制エントリー"}</p>
        <p>{"V(s, z)   = max( E[R_s | z],  E[V(s+1, z′) | s, z] )  … 即エントリー vs 見送り"}</p>
        <p>
          R<sub>s</sub> はスロット s で建てて出口まで持ったときのリターン。継続価値は過去の週の遷移を数えて経験的に推定します。
          手仕舞い側の最適停止（個別ページの「最適手仕舞い」）を時間反転したものです。
          標本が 12 未満のビンは「建てる」に倒しており、<b>証拠のある所でだけ素朴ルールから逸脱</b>させています。
          評価は週単位のインターリーブ2分割OOS（偶数週で学習→奇数週で検定、および逆）。同一週を学習と検定に跨がせないので、横断相関の漏れが起きません。
        </p>

        <p className="font-medium text-gray-700 mt-3">7. 数式：危機時Σ と 成長率カーブ（⑤）</p>
        <p>
          「テールではどうせ相関が1に寄るのだから、平時は相関を無視してリターンを追う方が伸びるのでは」という直観は、
          前半は正しく後半が逆です。⑤はそれを数値で確かめる層です。
        </p>
        <p>
          まず危機レジームを切り出して Σ を推定します。ここで<b>切り方に落とし穴があります</b>。
          「その週のバスケット・リターンが下位 q 分位」で切ると、共通ファクターの実現値そのものを条件付けすることになり、
          部分標本内でのファクター分散が切り詰められて<b>相関が機械的に下がります</b>
          （Boyer-Gibson-Loretan 1999、Forbes-Rigobon 2002 の条件付けバイアス。実際この方式だと
          「危機時の方が相関が低い」という現実と逆の結果が出ます）。
          そこで本実装では危機レジームを<b>直近13週のバスケット実現ボラが上位 q 分位</b>で定義しています。
          同時点のリターンを条件にしないのでバイアスが入らず、しかも<b>月曜寄付の時点で判定できる</b>ため、
          実際の運用でも使えるレジーム定義になっています。
          相関が上がっていれば、実効銘柄数 N<sub>eff</sub> が平穏時より小さくなるのが表に出ます。
        </p>
        <p>
          次に、方向 w に沿ってスカラー s 倍の建玉を持つときの長期成長率
        </p>
        <p>{"g(s) = s·(μᵀw) − (s²/2)·(wᵀΣw)"}</p>
        <p>
          を最大にする s* = (μᵀw)/(wᵀΣw) を求めます。いま持っているのは s=1 なので、
          <b>現在の建玉がフルケリーの何倍か</b>は
        </p>
        <p>{"λ = 1/s* = (wᵀΣw) / (μᵀw)"}</p>
        <p>
          で測れます。このとき成長率は最大値に対して
        </p>
        <p>{"g(λ)/g_max = 2λ − λ²"}</p>
        <p>
          となり、<b>λ=1 で最大、λ=2 で成長率ちょうどゼロ、λ&gt;2 では資産が減っていきます</b>（期待値は増え続けるのに、です）。
          グラフ上に4点を打っています：最適配分／単独ケリー合算のそれぞれを、平時Σと危機Σで測った位置です。
        </p>
        <p>
          ここが核心です。<b>Σ が危機側に振れると λ は大きくなる方向にしか動きません</b>
          （分子 wᵀΣw が増えるため）。つまり「テールで相関が上がる」という前提を真に受けるなら、
          導かれる結論は「建玉を増やしてよい」ではなく<b>「今の建玉ですら過大かもしれない」</b>です。
          相関を無視した単独ケリー合算は、平時Σですでに λ が大きく、危機Σではさらに右へ動きます。
          「相関を無視してリターンを追う」は、算術平均のリターンを増やす代わりに幾何平均（＝実際に増える資産）を削る操作です。
        </p>
        <p>
          なお分数ケリー f はこの λ を丸ごとスケールします（f を半分にすれば λ も半分）。
          f=1/4 なら多少のオーバーベットは吸収されますが、f を上げた瞬間に4点がまとめて右へ動いて崖に近づきます。
          <b>f を上げる前に必ずこの表の「危機Σ」列を見てください。</b>
        </p>
        <p>
          <b>λ が 1 より小さいことをレバレッジの推奨と読まないでください。</b>
          フルケリー（λ=1）は「μ・Σ が正しく既知」「リターンが正規分布」「連続的に建玉を調整できる」という、
          現実には成り立たない前提の上での上限値です。推定誤差・ファットテール・約定の飛び（ジャンプ）を入れると
          実際の最適点はこれよりずっと左にあります。この層の役割は<b>右へ行き過ぎていないかの確認</b>であって、
          左の余白を埋めることではありません。
        </p>

        <p className="font-medium text-gray-700 mt-3">8. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>実効銘柄数 N<sub>eff</sub></b>：これが銘柄数よりずっと小さいなら、銘柄を増やしても分散効果はほぼ増えません。同業種を並べているサインです。</li>
          <li><b>オーバーベット倍率</b>：単独ケリーの単純合計 ÷ 最適配分の総建玉。2倍を超えるなら、素朴な足し算のサイジングは実質ダブルレバに相当します。</li>
          <li><b>現金%</b>：縮小後の μ̃ が Σ に対して弱ければ、最適解は自動的に現金を残します。「全額賭けてよいか」は別途判断する必要がなく、正しい μ̃・Σ を入れれば解が答えます。</li>
          <li><b>縮小係数 b</b>：0に近い銘柄が多いなら、銘柄ごとに配分を変えること自体の根拠が薄い。等加重に近い解が誠実です。</li>
          <li><b>月寄 − 週内平均の t</b>：|t| {"<"} 1.96 なら、月寄と他スロットは統計的に区別できません。「月曜に集中する」ことのタイミング面の正当化はできない、という意味です。</li>
          <li><b>CE(k) の形</b>：k=1 が最大なら月寄に全額でよい。中ほどにピークがあるなら、その本数に分けて建てるのが効率的です。</li>
          <li><b>④のOOS対決</b>：OOSで「待つ」が月寄固定を上回らないなら、待ちルールは後知恵です。IS との差が過剰最適化の大きさそのものです。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">9. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>発注サイズの決定</b>：総資産を入力すると、①の表の<b>「株数」列がそのまま発注数量</b>になります
            （株数 = ⌊総資産 × 配分% ÷ 現在値 ÷ 売買単位⌋ × 売買単位。日本株は100株単位に切り捨て）。
            銘柄コード列で証券会社の検索窓に入力してください。ケリー係数 f は 1/4 から始めるのが実務的です
            （推定誤差込みだとフルケリーは理論上も過大）。
          </li>
          <li>
            <b>「実配分」列のズレに注意</b>：単元株への切り捨てがあるので、実配分は目標配分と一致しません。
            資金が小さいほど、また株価が高い銘柄ほどズレは大きくなります（差が2%を超えると橙で表示）。
            株数が 0 になる銘柄は「1単元すら買えない」ということなので、その銘柄を諦めるか、
            銘柄数を絞って1銘柄あたりの配分を厚くするかの判断が必要です。
          </li>
          <li><b>銘柄数の見直し</b>：N<sub>eff</sub> が小さいなら、銘柄を足すより<b>相関の低い銘柄に入れ替える</b>方が効きます。同業種の重複を削る判断材料になります。</li>
          <li><b>執行の設計</b>：③で k {">"} 1 が選ばれるなら、月曜に一括ではなく週内で分けて建てる。k=1 なら分割はコストの無駄です。</li>
          <li><b>待ちルールの採否</b>：④のOOSが月寄固定に勝てないなら、待たずに月寄で建てる。判断を増やさない方が期待値が高い、という結論を数字で確認できます。</li>
          <li><b>現金比率の根拠</b>：地合いが悪く μ̃ が縮んだ局面では自動的に現金比率が上がります。感覚ではなく μ̃/Σ の関係として説明できるサイジングになります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">10. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>μ の推定は本質的に難しい</b>。縮小してもなお μ̃ の不確かさが最大のリスクです。分数ケリーはその保険であって、消してはくれません。</li>
          <li><b>Σ は時変</b>。ここでは全期間一定として推定しています。危機局面では相関が1に寄り、N<sub>eff</sub> はさらに落ちます（＝表示より実際は分散が効きません）。</li>
          <li><b>月曜が休場の週は除外</b>しています（月寄という基準点が取れないため）。連休明けの週は構造が違う可能性があり、その分は別途「休場コンテキスト別曜日分析」で見てください。</li>
          <li><b>コスト・執行控除前</b>。スロット分割は発注回数を k 倍にするため、③の CE 改善が手数料・スプレッドを上回るか確認が必要です。</li>
          <li>
            <b>株数は最新終値ベースの目安</b>です。実際の約定は月曜の寄付なので、金曜終値から窓が開けば必要金額はズレます。
            発注直前に総資産と株数を再計算してください。また単元未満株（S株・ミニ株）を使う場合は売買単位を1株に切り替えると、
            配分のズレはほぼ消えますが手数料率は不利になるのが普通です。
          </li>
          <li><b>後知恵の最良スロットは目標にしてはいけません</b>。あれは到達不能な上限で、そこを基準に「月曜は損だ」と考えるのは典型的な誤読です。</li>
          <li><b>スロットや出口を選ぶこと自体が多重検定</b>です。ここで最良に見えたスロットも、選択バイアス込みで割り引いて読んでください（④のOOS対決がその割引を実際に行う唯一の欄です）。</li>
          <li>
            <b>2分割OOSが守るのは「細かい構造への過剰適合」までです。</b>標本全体に乗ってしまった幸運（例：この標本ではたまたま水曜寄りが強かった）は、
            どちらの半分にも同じように現れるため除去できません。だからこそ Sharpe の大小ではなく<b>対応のある差の t</b> で判定し、
            それでも「エッジゼロでも見かけの好成績は出る」というヌル較正の教訓を前提に読んでください。
          </li>
          <li><b>日足の寄り・引け価格のみ</b>を使っています。日中の細かいタイミング（寄り直後・大引け間際）は分解できません。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
