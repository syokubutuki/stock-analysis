"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  computeWeeklyAllocation,
  WeeklyAllocResult,
  TickerPrices,
  Side,
  EXIT_LABEL,
} from "../../lib/weekly-allocation";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
}

const bp = (v: number) => `${(v * 10000).toFixed(1)}bp`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

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
function drawAllocation(ctx: CanvasRenderingContext2D, width: number, height: number, r: WeeklyAllocResult) {
  const ml = 96;
  const mr = 56;
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
    ctx.fillStyle = "#4b5563";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(s.name.length > 12 ? `${s.name.slice(0, 11)}…` : s.name, ml - 6, cy + 3);

    const h = Math.min(rowH * 0.34, 9);
    ctx.fillStyle = "rgba(156,163,175,0.55)";
    ctx.fillRect(ml, cy - h - 1, Math.max(0, x(s.soloKelly) - ml), h);
    ctx.fillStyle = "rgba(37,99,235,0.8)";
    ctx.fillRect(ml, cy + 1, Math.max(0, x(s.weight) - ml), h);

    ctx.fillStyle = "#1f2937";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(pct(s.weight), Math.max(x(s.weight), ml) + 4, cy + 8);
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

export default function WeeklyAllocationChart({ tickers, pricesByTicker, names }: Props) {
  const allocRef = useRef<HTMLCanvasElement>(null);
  const slotRef = useRef<HTMLCanvasElement>(null);
  const splitRef = useRef<HTMLCanvasElement>(null);

  const [side, setSide] = useState<Side>("long");
  const [exitDay, setExitDay] = useState(5);
  const [kellyFraction, setKellyFraction] = useState(0.25);
  const [maxWeight, setMaxWeight] = useState(0.3);
  const [budget, setBudget] = useState(1);
  const [muShrink, setMuShrink] = useState(true);

  const result = useMemo(() => {
    const stocks: TickerPrices[] = tickers
      .map((t) => ({ ticker: t, name: names?.[t] ?? t, prices: pricesByTicker[t] ?? [] }))
      .filter((s) => s.prices.length > 0);
    return computeWeeklyAllocation(stocks, {
      side, exitDay, kellyFraction, maxWeight, budget, muShrink,
    });
  }, [tickers, pricesByTicker, names, side, exitDay, kellyFraction, maxWeight, budget, muShrink]);

  useEffect(() => {
    if (!result.ok) return;
    const draw = () => {
      const a = allocRef.current;
      if (a) {
        const init = initCanvas(a, 60 + 22 * (result.perStock.length + 1));
        if (init) drawAllocation(init.ctx, init.width, init.height, result);
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
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [result]);

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

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-800">
          週次エントリー配分・タイミング配分：どの銘柄に何%、いつ建てるか
        </h3>
        <span className="text-[10px] text-gray-400">
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
                <th className="text-left py-1 pr-2 font-medium">銘柄</th>
                <th className="text-right py-1 px-2 font-medium">μ（生）</th>
                <th className="text-right py-1 px-2 font-medium">SE</th>
                <th className="text-right py-1 px-2 font-medium">縮小b</th>
                <th className="text-right py-1 px-2 font-medium">μ̃（縮小後）</th>
                <th className="text-right py-1 px-2 font-medium">週次σ</th>
                <th className="text-right py-1 px-2 font-medium">Sharpe</th>
                <th className="text-right py-1 px-2 font-medium">単独ケリー</th>
                <th className="text-right py-1 pl-2 font-medium">配分</th>
              </tr>
            </thead>
            <tbody>
              {[...r.perStock].sort((a, b) => b.weight - a.weight).map((s) => (
                <tr key={s.ticker} className={`border-b border-gray-100 ${s.weight > 1e-6 ? "" : "text-gray-400"}`}>
                  <td className="py-1 pr-2 text-gray-700">{s.name}</td>
                  <td className="py-1 px-2 text-right">{bp(s.muRaw)}</td>
                  <td className="py-1 px-2 text-right text-gray-500">±{bp(s.se)}</td>
                  <td className={`py-1 px-2 text-right ${s.b < 0.3 ? "text-amber-600" : "text-gray-600"}`}>{s.b.toFixed(2)}</td>
                  <td className="py-1 px-2 text-right font-medium text-gray-900">{bp(s.muShrunk)}</td>
                  <td className="py-1 px-2 text-right text-gray-600">{pct(s.sigma)}</td>
                  <td className="py-1 px-2 text-right text-gray-600">{s.sharpe.toFixed(2)}</td>
                  <td className="py-1 px-2 text-right text-gray-500">{pct(s.soloKelly)}</td>
                  <td className="py-1 pl-2 text-right font-semibold text-blue-700">{pct(s.weight)}</td>
                </tr>
              ))}
              <tr className="border-t border-gray-300 text-gray-600">
                <td className="py-1 pr-2 font-medium">合計 / 現金</td>
                <td className="py-1 px-2 text-right" colSpan={3}>
                  横断コンセンサス μ̄ = {bp(r.muGrand)} ±{bp(r.muGrandSe)}
                </td>
                <td className="py-1 px-2 text-right">τ={bp(r.tau)}</td>
                <td className="py-1 px-2 text-right" colSpan={2}>
                  ポート週次 μ {bp(r.port.mu)} / σ {pct(r.port.sigma)}
                </td>
                <td className="py-1 px-2 text-right">{pct(r.soloSum)}</td>
                <td className="py-1 pl-2 text-right font-semibold">
                  {pct(r.exposure)}<span className="text-emerald-600"> / {pct(r.cash)}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="mt-1 text-[10px] text-gray-400">
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
                  <td className="py-0.5 text-right font-medium text-gray-400">{bp(r.hindsight.best)}<span className="ml-1 text-[9px]">到達不能</span></td>
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
            <p className="mt-1 text-[10px] text-gray-400">
              月寄が週内で最良だった割合 <b>{pct(r.pMonBest)}</b>（一様なら {pct(1 / r.nSlots)}）。
              最良との差 {bp(hindsightGap)} のうち、実装可能なルールで動かせるのは等分との差 {bp(reachableGap)} 程度までです。
            </p>
          </div>
          <div className="rounded border border-gray-200 p-2">
            <div className="text-[11px] font-medium text-gray-700">月寄 − 週内スロット平均（対応のある差の検定）</div>
            <div className="mt-1 text-[11px] text-gray-700">
              差 <b className="text-gray-900">{bp(r.monVsAvg.diff)}</b> ± {bp(r.monVsAvg.se)}
              <span className={`ml-2 font-medium ${monEdgeSignificant ? "text-blue-700" : "text-gray-400"}`}>
                t = {r.monVsAvg.t.toFixed(2)}
              </span>
            </div>
            <p className="mt-1 text-[10px] text-gray-400">
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
                    <td className={`py-0.5 text-right ${Math.abs(s.t) >= 1.96 ? "text-blue-700 font-medium" : "text-gray-400"}`}>{s.t.toFixed(2)}</td>
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
        <p className="mt-1 text-[10px] text-gray-400">
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
              <tr className="text-gray-400">
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
            <p className="mt-1 text-[10px] text-gray-400">
              左端 z=−4σ …… 右端 z=+4σ（月寄からの累積変動をボラで割った値。買いなら右ほど「もう上がってしまった」）。
              橙=待つ / 青=建てる / 灰=標本なし。標本 {"<"} 12 のビンは「建てる」に倒しています（証拠のある所でだけ素朴ルールから逸脱させる）。
              スロット1行目（月寄）は z≡0 なので全週共通の1つの判断です。
            </p>
          </div>
        </details>
      </div>

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

        <p className="font-medium text-gray-700 mt-3">3. 数式：なぜ「単独ケリーの合算」が破綻するか</p>
        <p>
          全銘柄を同じ月曜に建てて同じ日に降りるので、r<sub>t</sub> の各成分は強く<b>横断相関</b>します。
          平均ペア相関を ρ̄ とすると、独立な賭けの本数は
        </p>
        <p>{"N_eff = N / (1 + (N−1)·ρ̄)"}</p>
        <p>
          になります。例えば N=10、ρ̄=0.5 なら N<sub>eff</sub> ≈ 1.8。<b>10銘柄に分散しても実質2銘柄分のリスク分散しかありません。</b>
          このとき銘柄ごとに単独ケリー μ<sub>i</sub>/σ<sub>i</sub>² を計算して足すと、総エクスポージャーは
          およそ N/N<sub>eff</sub> ≈ 5倍のオーバーベットになります。上のバッジに出る「オーバーベット倍率」がその比です。
          コイン投げに例えるなら、10枚のコインを同時に投げているつもりで、実際は2枚のコインの結果を5回ずつ数えているようなものです。
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

        <p className="font-medium text-gray-700 mt-3">7. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>実効銘柄数 N<sub>eff</sub></b>：これが銘柄数よりずっと小さいなら、銘柄を増やしても分散効果はほぼ増えません。同業種を並べているサインです。</li>
          <li><b>オーバーベット倍率</b>：単独ケリーの単純合計 ÷ 最適配分の総建玉。2倍を超えるなら、素朴な足し算のサイジングは実質ダブルレバに相当します。</li>
          <li><b>現金%</b>：縮小後の μ̃ が Σ に対して弱ければ、最適解は自動的に現金を残します。「全額賭けてよいか」は別途判断する必要がなく、正しい μ̃・Σ を入れれば解が答えます。</li>
          <li><b>縮小係数 b</b>：0に近い銘柄が多いなら、銘柄ごとに配分を変えること自体の根拠が薄い。等加重に近い解が誠実です。</li>
          <li><b>月寄 − 週内平均の t</b>：|t| {"<"} 1.96 なら、月寄と他スロットは統計的に区別できません。「月曜に集中する」ことのタイミング面の正当化はできない、という意味です。</li>
          <li><b>CE(k) の形</b>：k=1 が最大なら月寄に全額でよい。中ほどにピークがあるなら、その本数に分けて建てるのが効率的です。</li>
          <li><b>④のOOS対決</b>：OOSで「待つ」が月寄固定を上回らないなら、待ちルールは後知恵です。IS との差が過剰最適化の大きさそのものです。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">8. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>発注サイズの決定</b>：①の配分列をそのまま「その銘柄に振る資産%」として使えます。ケリー係数 f は 1/4 から始めるのが実務的（推定誤差込みだとフルケリーは理論上も過大）。</li>
          <li><b>銘柄数の見直し</b>：N<sub>eff</sub> が小さいなら、銘柄を足すより<b>相関の低い銘柄に入れ替える</b>方が効きます。同業種の重複を削る判断材料になります。</li>
          <li><b>執行の設計</b>：③で k {">"} 1 が選ばれるなら、月曜に一括ではなく週内で分けて建てる。k=1 なら分割はコストの無駄です。</li>
          <li><b>待ちルールの採否</b>：④のOOSが月寄固定に勝てないなら、待たずに月寄で建てる。判断を増やさない方が期待値が高い、という結論を数字で確認できます。</li>
          <li><b>現金比率の根拠</b>：地合いが悪く μ̃ が縮んだ局面では自動的に現金比率が上がります。感覚ではなく μ̃/Σ の関係として説明できるサイジングになります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">9. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>μ の推定は本質的に難しい</b>。縮小してもなお μ̃ の不確かさが最大のリスクです。分数ケリーはその保険であって、消してはくれません。</li>
          <li><b>Σ は時変</b>。ここでは全期間一定として推定しています。危機局面では相関が1に寄り、N<sub>eff</sub> はさらに落ちます（＝表示より実際は分散が効きません）。</li>
          <li><b>月曜が休場の週は除外</b>しています（月寄という基準点が取れないため）。連休明けの週は構造が違う可能性があり、その分は別途「休場コンテキスト別曜日分析」で見てください。</li>
          <li><b>コスト・執行控除前</b>。スロット分割は発注回数を k 倍にするため、③の CE 改善が手数料・スプレッドを上回るか確認が必要です。</li>
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
