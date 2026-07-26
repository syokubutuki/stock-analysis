"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  computeEntryVsBenchmark,
  EntryVsBenchmarkResult,
  StrategyRow,
  StrategyKey,
  PerfStat,
} from "../../lib/entry-vs-benchmark";
import { TickerPrices, Side, EXIT_LABEL } from "../../lib/weekly-allocation";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const pct2 = (v: number) => `${(v * 100).toFixed(2)}%`;
const num = (v: number) => (isFinite(v) ? v.toFixed(2) : "∞");

const COLOR: Record<StrategyKey, string> = {
  bh: "#6b7280",
  fixed: "#d97706",
  random: "#a3a3a3",
  equal: "#2563eb",
  best: "#059669",
  worst: "#dc2626",
};

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

// 資金曲線（対数軸）。Best/Worst が上下の帯になり、その中で実装可能な各戦略がどこにいるかを見る。
function drawEquity(ctx: CanvasRenderingContext2D, width: number, height: number, r: EntryVsBenchmarkResult) {
  const ml = 52;
  const mr = 96;
  const mt = 24;
  const mb = 26;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("資金曲線（対数軸・初期1.0）。緑=後知恵Best / 赤=最悪Worst が到達可能域の上下限", 4, 14);

  const all = r.rows.flatMap((x) => x.perf.equity);
  const lo = Math.log(Math.max(1e-4, Math.min(...all)));
  const hi = Math.log(Math.max(...all, 1.0001));
  const pad = (hi - lo) * 0.05 || 0.1;
  const yOf = (v: number) => mt + plotH - ((Math.log(Math.max(1e-4, v)) - (lo - pad)) / (hi - lo + 2 * pad)) * plotH;
  const n = r.rows[0]?.perf.equity.length ?? 1;
  const xOf = (i: number) => ml + (i / Math.max(1, n - 1)) * plotW;

  // 1.0 の水平線
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ml, yOf(1));
  ctx.lineTo(ml + plotW, yOf(1));
  ctx.stroke();

  // 描画順: 参照(Best/Worst/Random)を先に薄く、実運用候補を上に
  const order: StrategyKey[] = ["best", "worst", "random", "equal", "bh", "fixed"];
  for (const key of order) {
    const row = r.rows.find((x) => x.key === key);
    if (!row) continue;
    const isRef = key === "best" || key === "worst" || key === "random";
    ctx.strokeStyle = COLOR[key];
    ctx.lineWidth = isRef ? 1 : 2;
    ctx.globalAlpha = isRef ? 0.5 : 1;
    if (isRef) ctx.setLineDash([3, 3]);
    ctx.beginPath();
    row.perf.equity.forEach((v, i) => {
      const px = xOf(i);
      const py = yOf(v);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    const last = row.perf.equity[row.perf.equity.length - 1];
    ctx.fillStyle = COLOR[key];
    ctx.font = `${isRef ? "" : "bold "}9px sans-serif`;
    ctx.textAlign = "left";
    ctx.fillText(`${row.label.split("（")[0]} ×${last.toFixed(2)}`, ml + plotW + 4, yOf(last) + 3);
  }

  ctx.fillStyle = "#9ca3af";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(`×${Math.exp(hi).toFixed(1)}`, ml - 4, mt + 4);
  ctx.fillText("×1.0", ml - 4, yOf(1) + 3);
  ctx.textAlign = "left";
  ctx.fillText(r.from, ml, mt + plotH + 16);
  ctx.textAlign = "right";
  ctx.fillText(r.to, ml + plotW, mt + plotH + 16);
}

// 総リターンの分解（年率対数寄与の積み上げ）
function drawAttribution(ctx: CanvasRenderingContext2D, width: number, height: number, r: EntryVsBenchmarkResult) {
  const a = r.attribution;
  const ml = 96;
  const mr = 20;
  const mt = 26;
  const mb = 24;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("総リターンの分解（年率・対数寄与。合計＝戦略の年率対数リターン）", 4, 14);

  const items: { label: string; v: number; c: string }[] = [
    ...(a.hasMarket ? [{ label: "市場（床）", v: a.market, c: "#6b7280" }] : []),
    { label: "銘柄選択", v: a.selection, c: "#7c3aed" },
    { label: "資金配分", v: a.allocation, c: "#2563eb" },
    { label: "エントリー", v: a.timing, c: "#d97706" },
    { label: "＝合計", v: a.total, c: "#111827" },
  ];
  const maxAbs = Math.max(0.01, ...items.map((x) => Math.abs(x.v)));
  const zeroX = ml + plotW / 2;
  const scale = (plotW / 2) / maxAbs;
  const rowH = plotH / items.length;

  ctx.strokeStyle = "#d1d5db";
  ctx.beginPath();
  ctx.moveTo(zeroX, mt);
  ctx.lineTo(zeroX, mt + plotH);
  ctx.stroke();

  items.forEach((x, i) => {
    const cy = mt + rowH * (i + 0.5);
    const bw = x.v * scale;
    const h = Math.min(rowH * 0.5, 14);
    ctx.fillStyle = x.c;
    ctx.globalAlpha = x.label === "＝合計" ? 1 : 0.75;
    if (bw >= 0) ctx.fillRect(zeroX, cy - h / 2, bw, h);
    else ctx.fillRect(zeroX + bw, cy - h / 2, -bw, h);
    ctx.globalAlpha = 1;

    ctx.fillStyle = "#374151";
    ctx.font = `${x.label === "＝合計" ? "bold " : ""}10px sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(x.label, ml - 6, cy + 3);
    ctx.textAlign = bw >= 0 ? "left" : "right";
    ctx.fillStyle = "#1f2937";
    ctx.fillText(`${(x.v * 100).toFixed(1)}%`, zeroX + bw + (bw >= 0 ? 4 : -4), cy + 3);
  });
}

function perfCells(p: PerfStat) {
  return (
    <>
      <td className="py-1 px-2 text-right font-semibold">{pct(p.cagr)}</td>
      <td className="py-1 px-2 text-right">{num(p.sharpe)}</td>
      <td className="py-1 px-2 text-right">{num(p.sortino)}</td>
      <td className="py-1 px-2 text-right">{num(p.calmar)}</td>
      <td className="py-1 px-2 text-right text-red-600">{pct(p.maxDD)}</td>
      <td className="py-1 px-2 text-right">{pct(p.winRate)}</td>
      <td className="py-1 px-2 text-right">{num(p.profitFactor)}</td>
      <td className="py-1 px-2 text-right text-emerald-700">{pct2(p.avgWin)}</td>
      <td className="py-1 px-2 text-right text-red-600">{pct2(p.avgLoss)}</td>
      <td className="py-1 px-2 text-right text-gray-500">{p.nTrades.toLocaleString()}</td>
      <td className="py-1 px-2 text-right text-gray-500">{p.turnover.toFixed(1)}x</td>
    </>
  );
}

function diffCells(row: StrategyRow) {
  if (row.key === "bh") {
    return (
      <td className="py-1 px-2 text-center text-gray-400" colSpan={5}>
        ベンチマーク
      </td>
    );
  }
  const d = row.diff;
  const sig = d.p < 0.05;
  return (
    <>
      <td className={`py-1 px-2 text-right font-medium ${d.annualDiff >= 0 ? "text-emerald-700" : "text-red-600"}`}>
        {pct(d.annualDiff)}
      </td>
      <td className="py-1 px-2 text-right text-gray-500 whitespace-nowrap">
        [{pct2(d.ciLo * 52)}, {pct2(d.ciHi * 52)}]
      </td>
      <td className={`py-1 px-2 text-right ${sig ? "text-blue-700 font-medium" : "text-gray-400"}`}>{d.t.toFixed(2)}</td>
      <td className={`py-1 px-2 text-right ${sig ? "text-blue-700 font-medium" : "text-gray-400"}`}>
        {d.p < 0.001 ? "<0.001" : d.p.toFixed(3)}
      </td>
      <td className="py-1 px-2 text-right text-gray-600">{d.cohensD.toFixed(3)}</td>
    </>
  );
}

export default function EntryVsBenchmarkChart({ tickers, pricesByTicker, names }: Props) {
  const eqRef = useRef<HTMLCanvasElement>(null);
  const atRef = useRef<HTMLCanvasElement>(null);

  const [side, setSide] = useState<Side>("long");
  const [exitDay, setExitDay] = useState(5);
  const [kellyFraction, setKellyFraction] = useState(0.25);
  const [maxWeight, setMaxWeight] = useState(0.3);
  const [weightMode, setWeightMode] = useState<"kelly" | "equal">("kelly");
  const [benchTicker, setBenchTicker] = useState("^N225");
  const [benchPrices, setBenchPrices] = useState<PricePoint[] | null>(null);
  const [benchLoading, setBenchLoading] = useState(false);
  const [benchErr, setBenchErr] = useState<string | null>(null);

  // 分解の「床」に使う市場代理。取れなくても他の層は出せるので致命的ではない。
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setBenchLoading(true);
      setBenchErr(null);
      try {
        const res = await fetch(`/api/stock?ticker=${encodeURIComponent(benchTicker)}&range=10y`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !Array.isArray(json?.prices) || json.prices.length < 100) {
          setBenchPrices(null);
          setBenchErr("市場代理を取得できません");
        } else setBenchPrices(json.prices as PricePoint[]);
      } catch {
        if (!cancelled) { setBenchPrices(null); setBenchErr("通信エラー"); }
      } finally {
        if (!cancelled) setBenchLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [benchTicker]);

  const result = useMemo(() => {
    const stocks: TickerPrices[] = tickers
      .map((t) => ({ ticker: t, name: names?.[t] ?? t, prices: pricesByTicker[t] ?? [] }))
      .filter((s) => s.prices.length > 0);
    return computeEntryVsBenchmark(stocks, {
      side, exitDay, kellyFraction, maxWeight, weightMode,
      benchmarkPrices: benchPrices ?? undefined,
      benchmarkTicker: benchTicker,
    });
  }, [tickers, pricesByTicker, names, side, exitDay, kellyFraction, maxWeight, weightMode, benchPrices, benchTicker]);

  useEffect(() => {
    if (!result.ok) return;
    const draw = () => {
      const e = eqRef.current;
      if (e) {
        const init = initCanvas(e, 260);
        if (init) drawEquity(init.ctx, init.width, init.height, result);
      }
      const a = atRef.current;
      if (a) {
        const init = initCanvas(a, 170);
        if (init) drawAttribution(init.ctx, init.width, init.height, result);
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
          エントリー戦略 vs Buy&amp;Hold：{result.reason ?? "データ待ち"}
        </div>
      </div>
    );
  }

  const r = result;
  const fixed = r.rows.find((x) => x.key === "fixed")!;
  const rnd = r.rows.find((x) => x.key === "random")!;
  const a = r.attribution;
  const fixedBeats = fixed.diff.annualDiff > 0 && fixed.diff.p < 0.05;
  const DOMINANT_LABEL: Record<typeof a.dominant, string> = {
    market: "市場（床）",
    selection: "銘柄選択",
    allocation: "資金配分",
    timing: "エントリータイミング",
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-800">
          エントリー戦略 vs Buy&amp;Hold：違いは「週内のどこで建てるか」だけ
        </h3>
        <span className="text-[10px] text-gray-400">
          {r.nStocks}銘柄 / {r.nWeeks}週（{r.years.toFixed(1)}年）/ {r.from}〜{r.to} / 建玉{pct(r.exposure)}
        </span>
      </div>

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
          <span className="text-gray-500">配分</span>
          <select className="border border-gray-200 rounded px-1 py-0.5" value={weightMode} onChange={(e) => setWeightMode(e.target.value as "kelly" | "equal")}>
            <option value="kelly">ケリー最適配分</option>
            <option value="equal">等加重</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">ケリー係数 f</span>
          <select className="border border-gray-200 rounded px-1 py-0.5" value={kellyFraction} onChange={(e) => setKellyFraction(Number(e.target.value))}>
            <option value={1}>1</option>
            <option value={0.5}>1/2</option>
            <option value={0.25}>1/4</option>
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
          <span className="text-gray-500">市場代理</span>
          <input
            className="border border-gray-200 rounded px-1 py-0.5 w-24"
            value={benchTicker}
            onChange={(e) => setBenchTicker(e.target.value.trim())}
          />
          {benchLoading && <span className="text-gray-400">取得中…</span>}
          {benchErr && <span className="text-amber-600">{benchErr}</span>}
        </label>
      </div>

      {/* 判定 */}
      <div className={`mt-3 rounded p-2.5 text-xs border ${fixedBeats ? "bg-blue-50 border-blue-200 text-blue-900" : "bg-amber-50 border-amber-200 text-amber-900"}`}>
        <div className="font-semibold">
          {fixedBeats
            ? `毎週固定エントリーは Buy&Hold を年率 ${pct(fixed.diff.annualDiff)} 上回りました（p=${fixed.diff.p < 0.001 ? "<0.001" : fixed.diff.p.toFixed(3)}）`
            : `毎週固定エントリーの Buy&Hold 超過は年率 ${pct(fixed.diff.annualDiff)}、p=${fixed.diff.p < 0.001 ? "<0.001" : fixed.diff.p.toFixed(3)} で有意ではありません`}
        </div>
        <div className="mt-1 leading-relaxed">
          後知恵Best〜最悪Worst のレンジで、毎週固定は下から <b>{pct(fixed.rankInRange)}</b> の位置、
          ランダムは <b>{pct(rnd.rankInRange)}</b> の位置です。
          {Math.abs(fixed.rankInRange - rnd.rankInRange) < 0.08
            ? " ほぼ同じ位置＝「月曜に建てる」という判断がランダムと区別できていません。"
            : fixed.rankInRange > rnd.rankInRange
            ? " 固定がランダムより上にいるので、月曜という選択自体に情報があります。"
            : " 固定がランダムより下にいます。月曜を選ぶことが逆効果になっている可能性があります。"}
          {" "}エッジの主因は <b>{DOMINANT_LABEL[a.dominant]}</b>（年率対数寄与 {pct(a[a.dominant])}）です。
        </div>
      </div>

      <div className="mt-3">
        <canvas ref={eqRef} />
      </div>

      {/* 成績表 */}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[11px] border-collapse whitespace-nowrap">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 pr-2 font-medium">エントリー戦略</th>
              <th className="text-right py-1 px-2 font-medium">CAGR</th>
              <th className="text-right py-1 px-2 font-medium">Sharpe</th>
              <th className="text-right py-1 px-2 font-medium">Sortino</th>
              <th className="text-right py-1 px-2 font-medium">Calmar</th>
              <th className="text-right py-1 px-2 font-medium">最大DD</th>
              <th className="text-right py-1 px-2 font-medium">勝率</th>
              <th className="text-right py-1 px-2 font-medium">PF</th>
              <th className="text-right py-1 px-2 font-medium">平均利益</th>
              <th className="text-right py-1 px-2 font-medium">平均損失</th>
              <th className="text-right py-1 px-2 font-medium">建玉数</th>
              <th className="text-right py-1 px-2 font-medium">年回転率</th>
              <th className="text-right py-1 px-2 font-medium border-l border-gray-200">年率差</th>
              <th className="text-right py-1 px-2 font-medium">95%CI</th>
              <th className="text-right py-1 px-2 font-medium">t</th>
              <th className="text-right py-1 px-2 font-medium">p</th>
              <th className="text-right py-1 px-2 font-medium">効果量d</th>
            </tr>
          </thead>
          <tbody>
            {r.rows.map((row) => (
              <tr
                key={row.key}
                className={`border-b border-gray-100 ${
                  row.key === "bh" ? "bg-gray-50" : row.key === "fixed" ? "bg-amber-50/60" : ""
                } ${row.key === "best" || row.key === "worst" ? "text-gray-400" : ""}`}
              >
                <td className="py-1 pr-2">
                  <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: COLOR[row.key] }} />
                  <span className={row.key === "fixed" || row.key === "bh" ? "font-medium text-gray-800" : "text-gray-700"}>
                    {row.label}
                  </span>
                </td>
                {perfCells(row.perf)}
                <td className="border-l border-gray-200 p-0" />
                {diffCells(row)}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-[10px] text-gray-400">
          年率差＝週次リターン差の年率換算（戦略 − Buy&amp;Hold）。95%CIはポートフォリオ週次差系列のブロック・ブートストラップ（800回）。
          t・pは<b>銘柄×週の対応差を同一週=1クラスタでクラスタ頑健化</b>したもの（横断相関を吸収）。効果量dは週次差の Cohen&apos;s d。
          {rnd.spread && (
            <> ランダムは{rnd.spread.m}本の経路の中央Sharpe経路。5–95%帯は CAGR {pct(rnd.spread.cagrLo)}〜{pct(rnd.spread.cagrHi)} / Sharpe {num(rnd.spread.sharpeLo)}〜{num(rnd.spread.sharpeHi)}。</>
          )}
          {" "}Best/Worthは先読みを含む到達不能な参照値です。回転率は往復売買代金÷資産の年率。コスト・税控除前。
          {r.skippedNoMonday > 0 && ` 月曜休場で除外した週が ${r.skippedNoMonday} 件あり、その間 Buy&Hold だけが保有を続けています。`}
        </p>
      </div>

      {/* 分解 */}
      <div className="mt-4">
        <div className="text-[11px] font-medium text-gray-700">
          総リターンの分解：エッジはどこから来ているか
        </div>
        <div className="mt-1">
          <canvas ref={atRef} />
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 pr-2 font-medium">寄与</th>
                <th className="text-right py-1 px-2 font-medium">年率</th>
                <th className="text-right py-1 px-2 font-medium">全体比</th>
                <th className="text-left py-1 pl-2 font-medium">定義（入れ子ベンチマークの差）</th>
              </tr>
            </thead>
            <tbody>
              {a.hasMarket && (
                <tr className="border-b border-gray-100">
                  <td className="py-1 pr-2 text-gray-700">市場（床）</td>
                  <td className="py-1 px-2 text-right font-medium">{pct(a.market)}</td>
                  <td className="py-1 px-2 text-right text-gray-500">{a.total !== 0 ? pct(a.market / a.total) : "—"}</td>
                  <td className="py-1 pl-2 text-gray-500">{r.benchmarkTicker} を持ち続けた場合</td>
                </tr>
              )}
              <tr className="border-b border-gray-100">
                <td className="py-1 pr-2 text-gray-700">銘柄選択</td>
                <td className="py-1 px-2 text-right font-medium">{pct(a.selection)}</td>
                <td className="py-1 px-2 text-right text-gray-500">{a.total !== 0 ? pct(a.selection / a.total) : "—"}</td>
                <td className="py-1 pl-2 text-gray-500">ウォッチリスト等加重B&amp;H − 市場</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 pr-2 text-gray-700">資金配分</td>
                <td className="py-1 px-2 text-right font-medium">{pct(a.allocation)}</td>
                <td className="py-1 px-2 text-right text-gray-500">{a.total !== 0 ? pct(a.allocation / a.total) : "—"}</td>
                <td className="py-1 pl-2 text-gray-500">最適配分B&amp;H − 等加重B&amp;H（加重＋現金比率）</td>
              </tr>
              <tr className="border-b border-gray-100 bg-amber-50/60">
                <td className="py-1 pr-2 font-medium text-gray-800">エントリータイミング</td>
                <td className="py-1 px-2 text-right font-semibold">{pct(a.timing)}</td>
                <td className="py-1 px-2 text-right text-gray-500">{a.total !== 0 ? pct(a.timing / a.total) : "—"}</td>
                <td className="py-1 pl-2 text-gray-500">毎週固定エントリー − 最適配分B&amp;H</td>
              </tr>
              <tr className="border-t border-gray-300">
                <td className="py-1 pr-2 font-semibold text-gray-800">合計（戦略の年率対数リターン）</td>
                <td className="py-1 px-2 text-right font-semibold">{pct(a.total)}</td>
                <td className="py-1 px-2 text-right text-gray-500">100%</td>
                <td className="py-1 pl-2 text-gray-400">対数なので厳密に加法</td>
              </tr>
            </tbody>
          </table>
          {!a.hasMarket && (
            <p className="mt-1 text-[10px] text-amber-600">
              市場代理を取得できていないため「市場（床）」を 0 として扱っています。銘柄選択の欄はウォッチリスト等加重B&amp;Hの
              絶対リターンそのものになり、床との比較にはなっていません。
            </p>
          )}
        </div>
      </div>

      <AnalysisGuide title="エントリー戦略 vs Buy&Hold 比較の詳細理論">
        <p className="font-medium text-gray-700">1. 何をしているか — 「エントリー戦略だけ」を変える</p>
        <p>
          週次エントリー戦略が Buy&amp;Hold より優れているかを判定するとき、比較対象がズレていると答えが出ません。
          そこでこの分析は<b>銘柄・エントリー日・保有期間・資金配分をすべて同一に固定</b>し、
          「週内のどこで建てるか」だけを変えた戦略群を同じ資金曲線の土俵に載せます。
          Buy&amp;Hold も同じ配分 w で組み、余った分は現金として扱うので、
          両者の違いは<b>「週の一部だけ持つか、持ち続けるか」と「週内のどの時点で建てるか」だけ</b>になります。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. なぜ Best / Worst / Random を必ず並べるのか</p>
        <p>
          「毎週固定が Buy&amp;Hold に勝った」だけでは、その勝ちの意味が分かりません。判断に必要なのは
          <b>到達可能域のどこにいるか</b>です。そこで3つの参照を置きます。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>完全後知恵 Best</b>：毎週その週で最も良かったスロットを事後に選ぶ。先読みを含むので<b>到達不能な上限</b>。ここを目標にするのは典型的な誤読です。</li>
          <li><b>最悪タイミング Worst</b>：同様の下限。BestとWorstの幅が「タイミングという行為で動かせる範囲の全量」です。</li>
          <li><b>ランダムエントリー</b>：毎週一様乱数でスロットを選ぶ。<b>判断をしない対照群</b>で、医学試験のプラセボにあたります。固定エントリーがランダムと同じ位置なら、「月曜を選ぶ」という判断は情報を持っていません。</li>
        </ul>
        <p>
          上のバッジに出る「下から◯%の位置」は rank = (CAGR − Worst)/(Best − Worst) です。
          固定とランダムの位置が近ければ、勝ち負けの正体は判断ではなく引きです。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 数式：各指標</p>
        <p>{"CAGR = (最終資産)^(52/T) − 1          Sharpe = (μ_w/σ_w)·√52"}</p>
        <p>{"Sortino = (μ_w/σ_down)·√52,   σ_down = √( mean( min(r,0)² ) )   … 下方偏差のみでリスクを測る"}</p>
        <p>{"Calmar = CAGR / |最大DD|             PF = Σ(利益) / |Σ(損失)|"}</p>
        <p>{"年間回転率 = 往復売買代金 / 資産 = 2 × 建玉比率 × 52   （Buy&Hold は期間中1往復なので 2×建玉比率÷年数）"}</p>
        <p>
          <b>Sortino</b> は「下振れだけを罰する」シャープ比です。上振れのブレはリスクではないという立場を取ります。
          <b>Calmar</b> は「最大の谷を1回食らって何年で取り返すか」の逆数で、体感的な耐えやすさに近い指標です。
          <b>PF（プロフィットファクター）</b>は総利益÷総損失で、1.0が損益分岐。
          回転率が高いほど手数料・スプレッド・税の影響が大きくなるので、
          <b>週次戦略は回転率が Buy&amp;Hold の数十倍</b>になる点を必ず見てください（この表はコスト控除前です）。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 数式：差分の検定（2つのSEを併記する理由）</p>
        <p>
          週次のポートフォリオ差系列 d<sub>t</sub> = r<sub>戦略,t</sub> − r<sub>B&amp;H,t</sub> について、
          95%信頼区間は<b>ブロック・ブートストラップ</b>（ブロック長 L ≈ ∛T、800回リサンプル）で出します。
          系列に自己相関があっても壊れないためです。
        </p>
        <p>
          一方 t 値・p 値は<b>銘柄×週の対応差</b>をプールし、<b>同一週=1クラスタ</b>としてクラスタ頑健化して計算します：
        </p>
        <p>{"Var(μ̂) = (1/N²)·Σ_週 ( Σ_{i∈週}(d_i − μ̂) )²    →    t = μ̂ / √Var(μ̂),  df = 週数 − 1"}</p>
        <p>
          この2本立てにしているのは、それぞれ弱点が逆だからです。ポートフォリオ系列は1週=1観測なのでクラスタが効かず標本数が小さい。
          銘柄×週プールは標本数が多い代わりに、同じ週は全銘柄が一緒に動くので素朴に数えると<b>偽の有意</b>が出ます。
          クラスタ頑健SEはこれを吸収し、<b>実効標本数 nEff</b> が「のべ観測数に対して実質どれだけの独立標本か」を教えてくれます。
        </p>
        <p>
          <b>効果量 Cohen&apos;s d</b> = mean(d)/sd(d) は「差が週次のばらつき何個ぶんか」。
          p 値は標本数を増やせばいくらでも小さくできますが、d は大きくなりません。
          d が 0.1 を下回るなら、統計的に有意でも<b>実務的にはほぼ無意味な差</b>です。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 数式：総リターンの分解</p>
        <p>
          エッジの出どころを診断するため、入れ子のベンチマーク列を作って対数リターンで加法分解します
          （対数なら差の和が全体に厳密に一致します）：
        </p>
        <p>{"ln(1+R_戦略) = ln(1+R_市場)"}</p>
        <p>{"             + [ ln(1+R_等加重B&H) − ln(1+R_市場) ]        … 銘柄選択"}</p>
        <p>{"             + [ ln(1+R_最適配分B&H) − ln(1+R_等加重B&H) ] … 資金配分"}</p>
        <p>{"             + [ ln(1+R_戦略) − ln(1+R_最適配分B&H) ]      … エントリータイミング"}</p>
        <p>
          各層の意味は次の通りです。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>市場（床）</b>：ただ市場に参加していれば得られた分。何も工夫しなくても取れる部分です。</li>
          <li><b>銘柄選択</b>：この銘柄群を選んだことによる、市場からの上乗せ。ウォッチリストを組んだ判断の価値です。</li>
          <li><b>資金配分</b>：等加重ではなくケリー配分にしたこと（加重の傾け＋現金を残したこと）の効果。<b>現金を残せば通常マイナスに出ます</b>が、その分リスクも下げているので Sharpe と併せて読んでください。</li>
          <li><b>エントリータイミング</b>：同じ銘柄・同じ配分で持ち続ける代わりに、週内で建てて降りたことの効果。<b>あなたの週次戦略が生んでいる固有の価値はここだけ</b>です。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>エントリー層がほぼ0</b>：週次で建てたり降りたりしている苦労が、リターンを1円も生んでいないという意味です。市場・銘柄選択で説明が付くなら、Buy&amp;Hold に切り替えるのが合理的です。</li>
          <li><b>エントリー層がプラスでも p が大きい</b>：偶然と区別できていません。とくに Best〜Worst の幅が広いのに固定とランダムの位置が近い場合、差の正体は引きです。</li>
          <li><b>Sharpe/Sortino が改善しCAGRが劣る</b>：週の一部しか持たないので当然です。リスク調整後で勝っているなら、レバレッジを掛ける前提では意味があります（③の総建玉上限で確認）。</li>
          <li><b>Calmar と最大DD</b>：週末・祝日を持たない戦略はギャップリスクを避けるため、DDが浅くなりやすい。ここが週次戦略の一番の取り柄になることが多いです。</li>
          <li><b>回転率</b>：Buy&amp;Hold の数十倍なら、往復コスト0.1%でも年間数%を失います。年率差がその水準を超えていなければ、コスト後は負けです。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>戦略を続けるかの判断</b>：エントリー層の年率寄与が往復コスト総額を超えているかで決めます。超えていなければ、同じ銘柄を持ち続ける方が手取りは多くなります。</li>
          <li><b>配分と現金の妥当性</b>：資金配分層が大きくマイナスなら、現金を持ちすぎか、縮小が効きすぎています。f を上げるか総建玉上限を見直す材料になります。</li>
          <li><b>銘柄選択の再評価</b>：銘柄選択層がマイナスなら、市場（インデックス）を持つ方が良かったということです。ウォッチリストの入れ替えを検討してください。</li>
          <li><b>出口の再設計</b>：出口を変えて再計算すると、エントリー層の寄与がどう動くかを見られます。エントリーと出口はセットで最適化する必要があります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">8. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>コスト・税・スリッページはすべて控除前</b>です。回転率の差が大きいので、実務ではここが結論を反転させることが珍しくありません。</li>
          <li><b>配分 w は全期間のデータで推定した値を全期間に当てている</b>（インサンプル）ため、資金配分層は実力より良く出ます。前向きの数字が欲しい場合は pf-oos のウォークフォワードと併せて読んでください。</li>
          <li><b>Best/Worst は先読み</b>です。到達不能な参照値であり、目標ではありません。</li>
          <li><b>月曜休場の週は戦略側だけ休んで</b>います（月寄という基準点が取れないため除外）。その間 Buy&amp;Hold は保有を続けるので、その差もエントリー層に含まれます。</li>
          <li><b>ランダムの代表経路は中央Sharpe経路</b>です。M本の平均を取ると週内均等エントリーに潰れてしまうため、あえて1本を選んでいます。5–95%帯を必ず併読してください。</li>
          <li><b>市場代理の選択が分解を左右します</b>。日本株中心なら ^N225 や 1306.T、米国株中心なら ^GSPC など、ウォッチリストの中身に合ったものを指定してください。合っていないと「銘柄選択」層に市場のズレが混入します。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
