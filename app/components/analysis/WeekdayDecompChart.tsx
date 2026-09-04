"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { decomposeByWeekday } from "../../lib/overnight-intraday";
import AnalysisGuide from "./AnalysisGuide";
import AccessibleCanvas from "./AccessibleCanvas";
import StrategyVsBenchmark from "./StrategyVsBenchmark";
import { countRoundTrips } from "../../lib/strategy-vs-benchmark";
import { representativeSpread } from "../../lib/spread-estimator";
import { CHART_COLORS } from "../../lib/chart-colors";

interface Props {
  prices: PricePoint[];
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
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

type Mode = "mean" | "cum";
type Seg = "overnight" | "intraday";
const WD_LABEL: Record<number, string> = { 1: "月", 2: "火", 3: "水", 4: "木", 5: "金" };

export default function WeekdayDecompChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>("mean");
  const [seg, setSeg] = useState<Seg>("overnight");
  const [stratDow, setStratDow] = useState<number | 0>(0); // 0=全曜日
  const rows = useMemo(() => decomposeByWeekday(prices), [prices]);

  // 「選んだ曜日の、選んだ区間だけ建てる」戦略。
  // 区間は日ごとに独立に建てて畳むので、選択日1日＝1往復。単利を対数に直して渡す。
  const decompStrategy = useMemo(() => {
    const toLog = (r: number) => (Number.isFinite(r) && r > -1 ? Math.log(1 + r) : 0);
    const mask: boolean[] = [];
    const strategyDaily: number[] = [];
    const buyHoldDaily: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      const pc = prices[i - 1].close, o = prices[i].open, c = prices[i].close;
      if (!(pc > 0) || !(o > 0) || !(c > 0)) continue;
      const dow = new Date(`${prices[i].time}T00:00:00Z`).getUTCDay();
      if (dow < 1 || dow > 5) continue;
      const sel = stratDow === 0 || dow === stratDow;
      const r = seg === "overnight" ? (o - pc) / pc : (c - o) / o;
      mask.push(sel);
      strategyDaily.push(sel ? toLog(r) : 0);
      buyHoldDaily.push(toLog((c - pc) / pc));
    }
    return {
      strategyDaily,
      buyHoldDaily,
      roundTrips: countRoundTrips(mask, false),
      nSel: mask.filter(Boolean).length,
    };
  }, [prices, seg, stratDow]);
  const spreadRT = useMemo(() => (prices.length === 0 ? 0 : representativeSpread(prices)), [prices]);

  const chartDescription = useMemo(() => {
    if (rows.length === 0) return "曜日別の夜間・日中分解。計算できるデータが不足しています。";
    const on = rows.reduce((a, b) => (b.cumOvernight > a.cumOvernight ? b : a));
    const id = rows.reduce((a, b) => (b.cumIntraday > a.cumIntraday ? b : a));
    return `曜日別に、夜間（前日終値→当日始値）と日中（当日始値→終値）の累積リターンを分けて並べた図。夜間の累積が最も大きいのは${on.label}曜の${(on.cumOvernight * 100).toFixed(1)}%、日中は${id.label}曜の${(id.cumIntraday * 100).toFixed(1)}%です。`;
  }, [rows]);

  useEffect(() => {
    if (!canvasRef.current || rows.length === 0) return;
    const init = initCanvas(canvasRef.current, 240);
    if (!init) return;
    const { ctx, width } = init;
    const ml = 44, mr = 14, mt = 24, mb = 30;
    const plotW = width - ml - mr, plotH = 240 - mt - mb;
    const getOn = (r: typeof rows[0]) => (mode === "mean" ? r.meanOvernight : r.cumOvernight);
    const getId = (r: typeof rows[0]) => (mode === "mean" ? r.meanIntraday : r.cumIntraday);
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(mode === "mean" ? "曜日別 平均リターン（夜間/日中）" : "曜日別 累積リターン（夜間/日中）", ml, 14);
    const maxAbs = Math.max(1e-9, ...rows.flatMap((r) => [Math.abs(getOn(r)), Math.abs(getId(r))]));
    const zeroY = mt + plotH / 2;
    ctx.strokeStyle = CHART_COLORS.reference; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(ml, zeroY); ctx.lineTo(ml + plotW, zeroY); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = CHART_COLORS.ink; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(`${(maxAbs * 100).toFixed(mode === "mean" ? 2 : 0)}%`, ml - 4, mt + 8);
    ctx.fillText(`-${(maxAbs * 100).toFixed(mode === "mean" ? 2 : 0)}%`, ml - 4, mt + plotH);
    const slot = plotW / rows.length;
    const barW = slot * 0.32;
    rows.forEach((r, i) => {
      const x0 = ml + i * slot + slot * 0.1;
      const series = [
        { v: getOn(r), color: "#dc2626", off: 0 },
        { v: getId(r), color: "#2563eb", off: barW + 4 },
      ];
      for (const s of series) {
        const h = (Math.abs(s.v) / maxAbs) * (plotH / 2 - 2);
        ctx.fillStyle = s.color;
        ctx.fillRect(x0 + s.off, s.v >= 0 ? zeroY - h : zeroY, barW, h);
      }
      ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(r.label, x0 + barW + 2, mt + plotH + 14);
      ctx.fillStyle = CHART_COLORS.ink; ctx.font = "8px sans-serif";
      ctx.fillText(`n=${r.n}`, x0 + barW + 2, mt + plotH + 25);
    });
    ctx.textAlign = "left"; ctx.font = "9px sans-serif";
    ctx.fillStyle = "#dc2626"; ctx.fillText("■夜間", ml + 4, mt + 10);
    ctx.fillStyle = "#2563eb"; ctx.fillText("■日中", ml + 50, mt + 10);
  }, [rows, mode]);

  if (prices.length < 60 || rows.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">曜日別 夜間/日中エクイティ分解</h3>
        <div className="flex gap-1 text-xs">
          {(["mean", "cum"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`px-2 py-0.5 rounded ${mode === m ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{m === "mean" ? "平均" : "累積"}</button>
          ))}
        </div>
      </div>

      <div className="relative"><AccessibleCanvas ref={canvasRef} description={chartDescription} /></div>

      {/* 曜日×区間の戦略を B&H と比較（選択日1日＝1往復でコストを実額控除） */}
      {decompStrategy.strategyDaily.length > 0 && (
        <div className="pt-2 border-t border-gray-100 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h4 className="text-sm font-medium text-gray-700">
              曜日×区間の戦略 vs バイ&ホールド（
              {stratDow === 0 ? "全曜日" : `${WD_LABEL[stratDow]}曜`}の
              {seg === "overnight" ? "夜間" : "日中"}だけ建てる・n={decompStrategy.nSel}）
            </h4>
            <div className="flex items-center gap-2 text-xs text-gray-600">
              <div className="flex gap-1">
                {(["overnight", "intraday"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSeg(s)}
                    className={`px-2 py-0.5 rounded ${seg === s ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
                  >
                    {s === "overnight" ? "夜間" : "日中"}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => setStratDow(0)}
                  className={`px-2 py-0.5 rounded ${stratDow === 0 ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
                >
                  全
                </button>
                {[1, 2, 3, 4, 5].map((d) => (
                  <button
                    key={d}
                    onClick={() => setStratDow(d)}
                    className={`px-2 py-0.5 rounded ${stratDow === d ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
                  >
                    {WD_LABEL[d]}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <StrategyVsBenchmark
            strategyDaily={decompStrategy.strategyDaily}
            buyHoldDaily={decompStrategy.buyHoldDaily}
            roundTrips={decompStrategy.roundTrips}
            spreadRT={spreadRT}
            label="曜日×区間"
          />
        </div>
      )}

      <AnalysisGuide title="曜日別 夜間/日中分解の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"1日のリターンを夜間（持ち越し）と日中（ザラ場）に分け、さらに曜日別に集計する。『どの曜日の、どの時間帯でリターンが出やすいか』を見て、執行タイミングの戦略を選ぶ。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>夜間=(始値−前日終値)/前日終値、日中=(終値−始値)/始値。曜日ごとに平均・複利累積。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>特定曜日の夜間がプラスに偏る＝その曜日の持ち越しが有利（曜日×時間帯のアノマリー）。</li>
          <li>日中がマイナスの曜日＝デイトレを避ける/ショート寄りに。</li>
          <li>累積で見て安定して効いているか（一発依存でないか）を確認。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>上の「曜日×区間の戦略 vs B&H」パネルで取引コストを実額控除できる（グラフはコスト前）。区間は日ごとに建てて畳むので選択日1日＝1往復と数えており、回転率が高くコストが強く効く。</li>
          <li>曜日×時間帯の細分化で標本が減る（nを確認）。1曜日に絞ると年約50往復・標本も1/5になる。</li>
          <li>祝日・連休で曜日の意味がずれる週がある。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
