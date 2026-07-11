"use client";

// NISA(非課税・持ち切り) vs 現物(課税・曜日タイミング戦略) の税引後 最終リターン比較。
// 「年初に全枠使い切って売らずに持つNISA」と「期待値が負の区間(例: 金曜引け→月曜)は
// 持たず良い区間だけ現物で回す戦略」を、税・コスト控除後で公平に比較する。
// 詳しい理論・税式・損益分岐は末尾の AnalysisGuide を参照。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { bestCombination, legsFromSlotSides, type Side, type TradeSpec } from "../../lib/weekday-trade";
import {
  compareNisaVsTaxable,
  rollingComparison,
  yenComparison,
  TAX_RATE,
  GROWTH_QUOTA,
  ANNUAL_QUOTA,
  type TaxModel,
  type Comparison,
  type SimResult,
} from "../../lib/nisa-vs-taxable";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

type SlotSide = Side | "flat";
type ViewMode = "single" | "rolling";

const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const num2 = (v: number) => v.toFixed(2);
const cls = (v: number) => (v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500");
const yen = (v: number) => `${Math.round(v).toLocaleString()}円`;

// 週内10スロットのラベル(0=月日中 .. 9=金オーバーナイト=週末)
const SLOT_LABELS = ["月\n日中", "月→火\n夜間", "火\n日中", "火→水\n夜間", "水\n日中", "水→木\n夜間", "木\n日中", "木→金\n夜間", "金\n日中", "金→月\n週末"];

// 週末回避プリセット(月始〜金引けをロング、金→月の週末だけ現金)
const AVOID_WEEKEND: SlotSide[] = ["long", "long", "long", "long", "long", "long", "long", "long", "long", "flat"];

function cycleSide(s: SlotSide): SlotSide {
  return s === "flat" ? "long" : s === "long" ? "short" : "flat";
}
function slotColor(s: SlotSide): string {
  return s === "long" ? "bg-emerald-600 text-white" : s === "short" ? "bg-rose-600 text-white" : "bg-white text-gray-400 border border-gray-200";
}
function slotText(s: SlotSide): string {
  return s === "long" ? "買" : s === "short" ? "売" : "―";
}

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

export default function NisaVsTaxableChart({ prices }: Props) {
  const [taxModel, setTaxModel] = useState<TaxModel>("yearEnd");
  const [taxRatePct, setTaxRatePct] = useState(TAX_RATE * 100);
  const [costBps, setCostBps] = useState(5);
  const [view, setView] = useState<ViewMode>("rolling");
  const [yenMode, setYenMode] = useState(false);
  const [capital, setCapital] = useState(3_000_000);
  const [quota, setQuota] = useState(GROWTH_QUOTA);

  // 戦略スロット。初期値は bestCombination の最適プラン。
  const best = useMemo(() => (prices.length > 60 ? bestCombination(prices, true) : null), [prices]);
  const [sides, setSides] = useState<SlotSide[] | null>(null);
  const effSides: SlotSide[] = useMemo(() => {
    if (sides) return sides;
    if (best) return best.slots.map((s) => s.side);
    return AVOID_WEEKEND;
  }, [sides, best]);

  const legs: TradeSpec[] = useMemo(() => legsFromSlotSides(effSides), [effSides]);
  const taxRate = taxRatePct / 100;

  const cmp = useMemo<Comparison | null>(() => {
    if (prices.length < 60) return null;
    return compareNisaVsTaxable({ prices, legs, gapFill: "cash", taxModel, taxRate, costBps });
  }, [prices, legs, taxModel, taxRate, costBps]);

  const rolling = useMemo(() => {
    if (view !== "rolling" || prices.length < 300) return null;
    return rollingComparison({ prices, legs, gapFill: "cash", taxModel, taxRate, costBps }, 252, 5);
  }, [view, prices, legs, taxModel, taxRate, costBps]);

  const yenRes = useMemo(() => (cmp && yenMode ? yenComparison(cmp, capital, quota) : null), [cmp, yenMode, capital, quota]);

  // === 単年エクイティ(税引後清算価値) — 横軸=日付なので lightweight-charts ===
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const showChart = view === "single" && cmp !== null;

  useEffect(() => {
    if (!showChart || !containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 280,
      crosshair: { mode: 0 },
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(0)}%` },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    chartRef.current = chart;
    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
    };
  }, [showChart]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !cmp || !showChart) return;
    for (const s of seriesRef.current) chart.removeSeries(s);
    seriesRef.current = [];
    const toRows = (r: SimResult) => r.path.map((p) => ({ time: (Math.floor(p.t / 86400000) * 86400) as unknown as Time, value: p.post - 1 }));
    const nisaS = chart.addSeries(LineSeries, { color: "#059669", lineWidth: 2, title: "NISA(非課税)", priceLineVisible: false });
    nisaS.setData(dedupe(toRows(cmp.nisa)));
    const bhS = chart.addSeries(LineSeries, { color: "#9ca3af", lineWidth: 1, title: "現物B&H(課税)", priceLineVisible: false });
    bhS.setData(dedupe(toRows(cmp.taxableBH)));
    const stS = chart.addSeries(LineSeries, { color: "#2563eb", lineWidth: 2, title: "現物 曜日戦略", priceLineVisible: false });
    stS.setData(dedupe(toRows(cmp.strategy)));
    seriesRef.current = [nisaS, bhS, stS];
    if (containerRef.current && containerRef.current.clientWidth > 0) chart.applyOptions({ width: containerRef.current.clientWidth });
    chart.timeScale().fitContent();
  }, [cmp, showChart]);

  // === ローリング差の分布(Canvas2D ヒストグラム) ===
  const histRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (view !== "rolling" || !rolling || !histRef.current || rolling.points.length === 0) return;
    const c = initCanvas(histRef.current, 200);
    if (!c) return;
    const { ctx, width, height } = c;
    const edges = rolling.points.map((p) => p.edge);
    const lo = Math.min(...edges, -0.01), hi = Math.max(...edges, 0.01);
    const nBins = 41;
    const bins = new Array(nBins).fill(0);
    for (const e of edges) {
      const idx = Math.min(nBins - 1, Math.max(0, Math.floor(((e - lo) / (hi - lo)) * nBins)));
      bins[idx]++;
    }
    const maxCount = Math.max(...bins);
    const padL = 8, padR = 8, padT = 12, padB = 24;
    const plotW = width - padL - padR, plotH = height - padT - padB;
    const x0 = padL + ((0 - lo) / (hi - lo)) * plotW; // edge=0 の位置
    // バー
    for (let i = 0; i < nBins; i++) {
      const binLo = lo + (i / nBins) * (hi - lo);
      const bh = (bins[i] / maxCount) * plotH;
      const bx = padL + (i / nBins) * plotW;
      const bw = plotW / nBins - 1;
      ctx.fillStyle = binLo >= 0 ? "#2563eb" : "#f87171"; // 正=戦略勝ち(青) / 負=NISA勝ち(赤)
      ctx.fillRect(bx, padT + plotH - bh, bw, bh);
    }
    // 0 の縦線
    ctx.strokeStyle = "#374151"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, padT); ctx.lineTo(x0, padT + plotH); ctx.stroke();
    ctx.fillStyle = "#374151"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("差=0", x0, padT + plotH + 12);
    // 中央値マーカー
    const xm = padL + ((rolling.medianEdge - lo) / (hi - lo)) * plotW;
    ctx.strokeStyle = "#f59e0b"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(xm, padT); ctx.lineTo(xm, padT + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#b45309"; ctx.textAlign = xm > width / 2 ? "right" : "left";
    ctx.fillText(`中央値 ${pct(rolling.medianEdge)}`, xm + (xm > width / 2 ? -4 : 4), padT + 10);
    // 軸ラベル
    ctx.fillStyle = "#9ca3af"; ctx.textAlign = "left";
    ctx.fillText(`←NISA有利 ${pct(lo)}`, padL, height - 4);
    ctx.textAlign = "right";
    ctx.fillText(`${pct(hi)} 戦略有利→`, width - padR, height - 4);
  }, [view, rolling]);

  if (prices.length < 60) {
    return <div className="text-sm text-gray-500 p-4">データが不足しています（60営業日以上が必要）。</div>;
  }
  if (!cmp) return null;

  const winnerLabel = cmp.winner === "strategy" ? "現物 曜日戦略" : cmp.winner === "nisa" ? "NISA(非課税・持ち切り)" : "引き分け";
  const winnerColor = cmp.winner === "strategy" ? "bg-blue-50 border-blue-300" : cmp.winner === "nisa" ? "bg-emerald-50 border-emerald-300" : "bg-gray-50 border-gray-300";

  const rows: { label: string; get: (r: SimResult) => string; color?: (r: SimResult) => string }[] = [
    { label: "税引前リターン", get: (r) => pct(r.preTaxReturn), color: (r) => cls(r.preTaxReturn) },
    { label: "税引後リターン", get: (r) => pct(r.afterTaxReturn), color: (r) => cls(r.afterTaxReturn) },
    { label: "支払税(富比)", get: (r) => `−${(r.taxPaid * 100).toFixed(2)}%`, color: () => "text-rose-500" },
    { label: "取引コスト", get: (r) => `−${(r.cost * 100).toFixed(2)}%`, color: () => "text-gray-500" },
    { label: "市場滞在率", get: (r) => `${(r.exposure * 100).toFixed(0)}%` },
    { label: "往復回数", get: (r) => `${r.nRoundTrips}` },
    { label: "年率ボラ", get: (r) => `${(r.volAnnual * 100).toFixed(1)}%` },
    { label: "最大DD", get: (r) => pct(r.maxDD), color: (r) => cls(r.maxDD) },
    { label: "Sharpe", get: (r) => num2(r.sharpe), color: (r) => cls(r.sharpe) },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        <span className="font-medium">NISA（年初に全枠使い切り、売らずに持ち切り・非課税）</span>と、
        <span className="font-medium">現物で曜日タイミング戦略（期待値が負の区間は現金・実現益に課税）</span>を回した場合の、
        <span className="font-medium">税・コスト控除後の最終リターン</span>を同一エンジンで比較します。各営業日の
        「今すべて売って税を精算したら手元にいくら残るか（清算価値）」を税引後エクイティとしています。
      </p>

      {/* 勝者バナー */}
      <div className={`rounded-lg border p-3 text-sm ${winnerColor}`}>
        <span className="font-medium">税引後で上回るのは: </span>
        <span className="font-bold">{winnerLabel}</span>
        <span className="text-gray-600">
          （NISA {pct(cmp.nisa.afterTaxReturn)} / 戦略 {pct(cmp.strategy.afterTaxReturn)} / 差{" "}
          <span className={cls(cmp.edge)}>{pct(cmp.edge)}</span>）
        </span>
        {rolling && (
          <span className="ml-1 text-gray-600">
            — ローリング1年窓では戦略が <span className="font-medium">{(rolling.winRate * 100).toFixed(0)}%</span> の年でNISAを上回り（中央値差 {pct(rolling.medianEdge)}）。
          </span>
        )}
      </div>

      {/* コントロール */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <div className="flex items-center gap-1">
          <span className="text-gray-500">表示:</span>
          {([["rolling", "ローリング分布"], ["single", "単年エクイティ"]] as [ViewMode, string][]).map(([m, label]) => (
            <button key={m} onClick={() => setView(m)} className={`px-2 py-0.5 rounded border ${view === m ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-600 border-gray-300"}`}>{label}</button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-500">税モデル:</span>
          {([["yearEnd", "源泉なし(年末一括)"], ["withholding", "源泉あり(都度)"]] as [TaxModel, string][]).map(([m, label]) => (
            <button key={m} onClick={() => setTaxModel(m)} className={`px-2 py-0.5 rounded border ${taxModel === m ? "bg-rose-600 text-white border-rose-600" : "bg-white text-gray-600 border-gray-300"}`}>{label}</button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-gray-500">
          税率
          <input type="number" min={0} max={55} step={0.1} value={taxRatePct} onChange={(e) => setTaxRatePct(Math.max(0, Number(e.target.value) || 0))} className="w-16 border border-gray-200 rounded px-1 py-0.5 bg-white text-right" />%
        </label>
        <label className="flex items-center gap-1 text-gray-500">
          片道コスト
          <input type="number" min={0} max={50} step={1} value={costBps} onChange={(e) => setCostBps(Math.max(0, Number(e.target.value) || 0))} className="w-14 border border-gray-200 rounded px-1 py-0.5 bg-white text-right" />bps
        </label>
        <label className="flex items-center gap-1 text-gray-500">
          <input type="checkbox" checked={yenMode} onChange={(e) => setYenMode(e.target.checked)} /> 円建て
        </label>
        {yenMode && (
          <>
            <label className="flex items-center gap-1 text-gray-500">
              資本
              <input type="number" min={0} step={100000} value={capital} onChange={(e) => setCapital(Math.max(0, Number(e.target.value) || 0))} className="w-28 border border-gray-200 rounded px-1 py-0.5 bg-white text-right" />円
            </label>
            <label className="flex items-center gap-1 text-gray-500">
              NISA枠
              <select value={quota} onChange={(e) => setQuota(Number(e.target.value))} className="border border-gray-200 rounded px-1 py-0.5 bg-white">
                <option value={GROWTH_QUOTA}>成長枠 240万</option>
                <option value={ANNUAL_QUOTA}>年間合計 360万</option>
                <option value={1e12}>上限なし</option>
              </select>
            </label>
          </>
        )}
      </div>

      {/* 戦略スロット・グリッド */}
      <div className="rounded-lg border border-gray-200 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700">現物戦略：週内どの区間を持つか</span>
          <div className="flex items-center gap-1 text-xs">
            <button onClick={() => setSides(best ? best.slots.map((s) => s.side) : AVOID_WEEKEND)} className="px-2 py-0.5 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50">最適プラン</button>
            <button onClick={() => setSides([...AVOID_WEEKEND])} className="px-2 py-0.5 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50">週末回避(月→金)</button>
          </div>
        </div>
        <div className="grid grid-cols-10 gap-1">
          {SLOT_LABELS.map((label, i) => (
            <button
              key={i}
              onClick={() => setSides(effSides.map((s, j) => (j === i ? cycleSide(s) : s)))}
              className={`flex flex-col items-center rounded py-1 text-[10px] leading-tight transition-colors ${slotColor(effSides[i])}`}
              title="クリックで 無→買→売 を切替"
            >
              <span className="whitespace-pre text-center opacity-80">{label}</span>
              <span className="text-sm font-bold mt-0.5">{slotText(effSides[i])}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-1.5">
          各区間をクリックで 無（現金）→ 買 → 売 を切替。緑=買・赤=売・灰=現金。右端「金→月」が週末ギャップ。ユーザー例「金→月は持たず月曜から保有」は<span className="font-medium">週末回避</span>プリセット。
        </p>
      </div>

      {view === "single" && (
        <>
          <div>
            <div className="text-xs text-gray-500 mb-1">税引後 清算価値の推移（緑=NISA / 灰=現物B&H / 青=現物戦略, ホイールでズーム）</div>
            <div ref={containerRef} className="w-full" />
          </div>

          {/* 3シナリオ指標表 */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-300 text-gray-500 text-xs">
                  <th className="text-left py-1 px-2">指標</th>
                  <th className="text-right py-1 px-2 text-emerald-700">NISA(非課税)</th>
                  <th className="text-right py-1 px-2">現物B&H(課税)</th>
                  <th className="text-right py-1 px-2 text-blue-700">現物 曜日戦略</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label} className="border-b border-gray-100">
                    <td className="py-1 px-2 text-gray-600">{row.label}</td>
                    {[cmp.nisa, cmp.taxableBH, cmp.strategy].map((r, i) => (
                      <td key={i} className={`text-right px-2 ${row.color ? row.color(r) : "text-gray-700"}`}>{row.get(r)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view === "rolling" && rolling && (
        <>
          <div>
            <div className="text-xs text-gray-500 mb-1">ローリング1年窓での「戦略 − NISA」税引後リターン差の分布（青=戦略勝ち / 赤=NISA勝ち, {rolling.points.length}窓）</div>
            <canvas ref={histRef} />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <Stat label="戦略の勝率" value={`${(rolling.winRate * 100).toFixed(0)}%`} sub="NISAを上回った窓" color={rolling.winRate > 0.5 ? "text-blue-600" : "text-emerald-600"} />
            <Stat label="差の中央値" value={pct(rolling.medianEdge)} sub="戦略 − NISA" color={cls(rolling.medianEdge)} />
            <Stat label="差の平均" value={pct(rolling.meanEdge)} sub="戦略 − NISA" color={cls(rolling.meanEdge)} />
            <Stat label="差の5–95%" value={`${pct(rolling.p5)} 〜 ${pct(rolling.p95)}`} sub="ばらつき" />
          </div>
          <p className="text-xs text-gray-400">
            単年は誤差が大きいため、10年履歴を1年窓でずらして分布を見るのが頑健です。分布が全体的に0より左（赤側）なら、税・コストを踏まえると
            この戦略はNISA持ち切りに負けやすいことを意味します。
          </p>
        </>
      )}

      {/* 損益分岐カード */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
        <span className="font-medium text-amber-800">税の損益分岐: </span>
        現物戦略が<span className="font-medium">非課税のNISA持ち切り（税引後 {pct(cmp.nisa.afterTaxReturn)}）</span>に並ぶには、
        税引前で <span className="font-bold">{pct(cmp.breakEvenGross)}</span> 稼ぐ必要があります
        （税率 {taxRatePct.toFixed(3)}% ぶんの上乗せハードル <span className={cls(cmp.requiredEdge)}>{pct(cmp.requiredEdge)}</span>）。
        現状の戦略は税引前 {pct(cmp.strategy.preTaxReturn)} なので、
        <span className={cmp.strategy.preTaxReturn >= cmp.breakEvenGross ? "text-blue-600 font-medium" : "text-emerald-600 font-medium"}>
          {cmp.strategy.preTaxReturn >= cmp.breakEvenGross ? " ハードルを越えています。" : " ハードルに届いていません。"}
        </span>
      </div>

      {/* 円建てカード */}
      {yenRes && (
        <div className="rounded-lg border border-gray-200 p-3 text-sm space-y-1">
          <div className="font-medium text-gray-700">円建て（資本 {yen(yenRes.capital)}）</div>
          <div className="flex justify-between"><span className="text-gray-500">NISA運用（枠内 {yen(yenRes.quotaUsed)}{yenRes.overflow > 0 ? ` + 超過 ${yen(yenRes.overflow)} は課税BH` : ""}）</span><span className="font-medium text-emerald-700">{yen(yenRes.nisaTotalYen)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">現物 曜日戦略（全額）</span><span className="font-medium text-blue-700">{yen(yenRes.strategyFinalYen)}</span></div>
          <div className="flex justify-between border-t border-gray-100 pt-1"><span className="text-gray-500">差（戦略 − NISA運用）</span><span className={`font-bold ${cls(yenRes.strategyFinalYen - yenRes.nisaTotalYen)}`}>{yen(yenRes.strategyFinalYen - yenRes.nisaTotalYen)}</span></div>
          {yenRes.overflow > 0 && <p className="text-xs text-gray-400">NISA枠を超えた分は課税口座でのバイ&ホールド（清算時課税）として計上しています。</p>}
        </div>
      )}

      <AnalysisGuide title="NISA vs 現物（税引後）比較の詳細理論">
        <p className="font-medium text-gray-700">1. 何を比較しているか</p>
        <p>
          同じ銘柄・同じ資本を1年運用したとき、(A)年初にNISAで全枠買って売らずに持ち切る（非課税）のと、
          (B)現物口座で曜日タイミング戦略（期待値が負の区間は現金にして、良い区間だけ保有）を回すのとで、
          <span className="font-medium">税・取引コストを引いた後の最終リターン</span>がどちらが上回るかを判定します。
          比較を公平にするため、両者を「価格イベント間の区間（セグメント）×目標ポジション」という同一エンジンで評価し、
          さらに中間ベースラインとして (C)現物のバイ&ホールド（課税）も並べます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 税引後リターンの定義（清算価値）</p>
        <p>
          各営業日の終値時点で「いま全部売って税を精算したら手元にいくら残るか」を清算価値とし、これを税引後の富とします。
          税率は τ（既定 20.315% ＝ 所得税15% + 復興特別 + 住民税5%）。年内の実現損益は<span className="font-medium">損益通算</span>し、
          プラスのぶんにのみ課税、マイナスなら課税されません（翌年への繰越は無視）。
        </p>
        <p className="pl-2">{"税引後リターン = 税引前リターン − τ × max(0, 年内実現純益)"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 税の損益分岐（この分析の核心）</p>
        <p>
          NISAは非課税なので税引後リターンは税引前と同じ R。現物戦略は実現益に課税されるので、益が出る前提では税引後 = R<sub>strat</sub>·(1−τ)。
          戦略がNISAに並ぶ条件は次式で、これが「税というハンデ」の正体です。
        </p>
        <p className="pl-2">{"R_strat·(1−τ) > R  ⟺  R_strat > R / (1−τ)"}</p>
        <p>
          τ=20.315% なら R/(1−τ) ≈ R×1.255。<span className="font-medium">つまり現物戦略は、NISA持ち切りより約25.5%多く税引前で稼いで初めて同点</span>になります。
          さらに戦略は市場滞在率が1未満（週末などは現金）なので、原資産が上昇ドリフトしている限り「持たない区間の取り逃し」も背負います。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 2つの税モデル</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">源泉なし（年末一括, Model A）</span>: 年内はプレタックスで複利し、清算（＝年末）に実現純益へ一括課税。一般口座／特定口座（源泉徴収なし）に対応。複利が最も効く有利なケース。</li>
          <li><span className="font-medium">源泉あり（都度, Model B）</span>: 往復ごとに源泉徴収して再投資元本を削り、年内の負けトレードで通算還付。勝ちトレードが多いほど「税の先払い」で複利が削られ、Aよりわずかに不利になります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 週内スロットと戦略定義</p>
        <p>
          1週間を10区間に分解します：各曜日の「日中（始値→終値）」5つと「オーバーナイト（終値→翌始値）」5つ。
          右端「金→月」が週末ギャップです。各区間に 買（+1）/売（−1）/現金（0）を割り当てたものが戦略で、
          <span className="font-medium">最適プラン</span>ボタンは過去データで各区間の富を最大化する組合せ（買・売・現金を独立選択）を入れます。
          ユーザー例「金→月は持たず月曜から保有」は<span className="font-medium">週末回避</span>プリセット（金→月だけ現金）です。
        </p>

        <p className="font-medium text-gray-700 mt-3">6. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">勝者バナー</span>: 選択期間1本での税引後の勝敗と差。</li>
          <li><span className="font-medium">ローリング分布</span>: 10年を1年窓でずらした各年の「戦略−NISA」差のヒストグラム。青が右に厚い＝戦略が勝ちやすい、赤が左に厚い＝NISAが勝ちやすい。<span className="font-medium">勝率と中央値差</span>が単年の運より頑健な結論です。</li>
          <li><span className="font-medium">損益分岐カード</span>: 戦略がNISAに並ぶのに必要な税引前リターンと、現状が届いているか。</li>
          <li>現物B&H（課税）とNISAの差＝<span className="font-medium">NISAの税優位</span>、現物B&Hと戦略の差＝<span className="font-medium">タイミングαの寄与</span>と読めます。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>戦略のタイミングαが「税ハードル R×τ/(1−τ)」を超えるほど強いか、ローリング勝率で確かめる。多くの場合、税と往復コストが強力な逆風になります。</li>
          <li>NISA枠には上限（成長投資枠240万/年）があるため、円建てモードで枠超過分を課税BHに回す前提での実額比較も可能です。</li>
          <li>戦略が滞在率を下げて浮かせた現金を別の非課税枠・他資産に回せるなら、比較の前提が変わります（ここでは現金=無利子と仮定）。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">8. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">配当を含まない</span>: 終値ベースのため配当が抜けています。配当もNISAは非課税なので、本来のNISA優位はここで示すより<span className="font-medium">さらに大きい</span>可能性があります。</li>
          <li><span className="font-medium">過剰適合</span>: 「最適プラン」を同じ期間で評価すると戦略が過大評価されます。ローリングでの安定性や、期間を変えた再現性を必ず確認してください。</li>
          <li><span className="font-medium">コスト・スリッページ</span>: 往復コストは片道bpsで近似。実際は板の薄さ・スプレッドでさらに削られます。</li>
          <li><span className="font-medium">繰越・他口座通算の無視</span>: 年内損益通算のみ考慮し、翌年への損失繰越や他口座との通算は無視しています。</li>
          <li><span className="font-medium">現金は無利子</span>: 市場外の資金は0%と仮定。短期金利で運用できる環境ではNISA側の相対優位がわずかに縮みます。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 p-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-bold ${color ?? "text-gray-800"}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400">{sub}</div>}
    </div>
  );
}

// lightweight-charts は同一時刻の重複・逆順を嫌うため、時刻昇順で重複を除去。
function dedupe(rows: { time: Time; value: number }[]): { time: Time; value: number }[] {
  const out: { time: Time; value: number }[] = [];
  let prev: number | null = null;
  for (const r of rows) {
    const t = r.time as unknown as number;
    if (prev !== null && t <= prev) continue;
    out.push(r);
    prev = t;
  }
  return out;
}
