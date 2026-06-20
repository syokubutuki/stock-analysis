"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import {
  extractCandles,
  aggregateSeason,
  BucketAgg,
  SeasonAxis,
} from "../../lib/candle-seasonality";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

type Metric = "shape" | "vol" | "clv" | "excursion" | "gap" | "bull";
const METRICS: { value: Metric; label: string }[] = [
  { value: "shape", label: "足形状" },
  { value: "vol", label: "レンジ・ボラ" },
  { value: "clv", label: "終値位置(CLV)" },
  { value: "excursion", label: "上下到達(MFE/MAE)" },
  { value: "gap", label: "窓・窓埋め" },
  { value: "bull", label: "陽線率" },
];

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

const H = 320;

// 共通レイアウト
function layout(width: number) {
  const ml = 48, mr = 16, mt = 28, mb = 26;
  return { ml, mr, mt, mb, plotW: width - ml - mr, plotH: H - mt - mb };
}
function drawXLabels(ctx: CanvasRenderingContext2D, buckets: BucketAgg[], ml: number, slot: number, y: number) {
  ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  buckets.forEach((b, i) => ctx.fillText(`${b.label}`, ml + i * slot + slot / 2, y));
}
function frame(ctx: CanvasRenderingContext2D, ml: number, mt: number, plotW: number, plotH: number, title: string) {
  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(title, ml, mt - 12);
}

// 積み上げ（足形状: 下ヒゲ→実体→上ヒゲ, 合計≒1）
function drawShape(ctx: CanvasRenderingContext2D, width: number, buckets: BucketAgg[]) {
  const { ml, mt, plotW, plotH } = layout(width);
  frame(ctx, ml, mt, plotW, plotH, "足形状の構成（下ヒゲ／実体／上ヒゲ の平均割合）");
  const slot = plotW / buckets.length;
  const barW = Math.max(4, slot * 0.6);
  const segs = [
    { key: "lower" as const, color: "#16a34acc", label: "下ヒゲ" },
    { key: "body" as const, color: "#3b82f6cc", label: "実体" },
    { key: "upper" as const, color: "#ef4444cc", label: "上ヒゲ" },
  ];
  buckets.forEach((b, i) => {
    const x = ml + i * slot + (slot - barW) / 2;
    let yTop = mt + plotH;
    for (const s of segs) {
      const h = (b[s.key] as number) * plotH;
      ctx.fillStyle = s.color;
      ctx.fillRect(x, yTop - h, barW, h);
      yTop -= h;
    }
  });
  drawXLabels(ctx, buckets, ml, slot, mt + plotH + 14);
  // 凡例
  ctx.textAlign = "left"; ctx.font = "9px sans-serif";
  let lx = ml + 4;
  for (const s of segs) {
    ctx.fillStyle = s.color; ctx.fillRect(lx, mt + 4, 9, 9);
    ctx.fillStyle = "#6b7280"; ctx.fillText(s.label, lx + 12, mt + 12);
    lx += 12 + ctx.measureText(s.label).width + 14;
  }
}

// グループ棒（2系列, %表示）レンジ・ボラ
function drawGrouped(
  ctx: CanvasRenderingContext2D, width: number, buckets: BucketAgg[],
  series: { get: (b: BucketAgg) => number; color: string; label: string }[],
  title: string
) {
  const { ml, mt, plotW, plotH } = layout(width);
  frame(ctx, ml, mt, plotW, plotH, title);
  const slot = plotW / buckets.length;
  const maxV = Math.max(1e-9, ...buckets.flatMap((b) => series.map((s) => s.get(b))));
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(`${(maxV * 100).toFixed(2)}%`, ml - 4, mt + 9);
  ctx.fillText("0", ml - 4, mt + plotH);
  const groupW = slot * 0.7;
  const barW = groupW / series.length;
  buckets.forEach((b, i) => {
    const x0 = ml + i * slot + (slot - groupW) / 2;
    series.forEach((s, j) => {
      const h = (s.get(b) / maxV) * (plotH - 4);
      ctx.fillStyle = s.color;
      ctx.fillRect(x0 + j * barW, mt + plotH - h, barW - 1, h);
    });
  });
  drawXLabels(ctx, buckets, ml, slot, mt + plotH + 14);
  ctx.textAlign = "left"; ctx.font = "9px sans-serif";
  let lx = ml + 4;
  for (const s of series) {
    ctx.fillStyle = s.color; ctx.fillRect(lx, mt + 4, 9, 9);
    ctx.fillStyle = "#6b7280"; ctx.fillText(s.label, lx + 12, mt + 12);
    lx += 12 + ctx.measureText(s.label).width + 14;
  }
}

// 中央ゼロから上下に伸びる発散棒
function drawDiverging(
  ctx: CanvasRenderingContext2D, width: number, buckets: BucketAgg[],
  posOf: (b: BucketAgg) => number, negOf: (b: BucketAgg) => number,
  posColor: string, negColor: string, title: string,
  fmt: (v: number) => string, posLabel: string, negLabel: string
) {
  const { ml, mt, plotW, plotH } = layout(width);
  frame(ctx, ml, mt, plotW, plotH, title);
  const slot = plotW / buckets.length;
  const barW = Math.max(4, slot * 0.5);
  const maxAbs = Math.max(1e-9, ...buckets.flatMap((b) => [Math.abs(posOf(b)), Math.abs(negOf(b))]));
  const zeroY = mt + plotH / 2;
  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, zeroY); ctx.lineTo(ml + plotW, zeroY); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmt(maxAbs), ml - 4, mt + 9);
  ctx.fillText(fmt(-maxAbs), ml - 4, mt + plotH);
  buckets.forEach((b, i) => {
    const x = ml + i * slot + (slot - barW) / 2;
    const pv = posOf(b), nv = negOf(b);
    const ph = (Math.abs(pv) / maxAbs) * (plotH / 2 - 2);
    const nh = (Math.abs(nv) / maxAbs) * (plotH / 2 - 2);
    ctx.fillStyle = posColor; ctx.fillRect(x, zeroY - ph, barW, ph);
    ctx.fillStyle = negColor; ctx.fillRect(x, zeroY, barW, nh);
  });
  drawXLabels(ctx, buckets, ml, slot, mt + plotH + 14);
  ctx.textAlign = "left"; ctx.font = "9px sans-serif";
  ctx.fillStyle = posColor; ctx.fillText(`■ ${posLabel}`, ml + 4, mt + 12);
  ctx.fillStyle = negColor; ctx.fillText(`■ ${negLabel}`, ml + 90, mt + 12);
}

// 単系列（0..1 の率, 50%基準線）陽線率
function drawBull(ctx: CanvasRenderingContext2D, width: number, buckets: BucketAgg[]) {
  const { ml, mt, plotW, plotH } = layout(width);
  frame(ctx, ml, mt, plotW, plotH, "陽線率（終値>始値 の割合）");
  const slot = plotW / buckets.length;
  const barW = Math.max(4, slot * 0.6);
  const toY = (v: number) => mt + plotH - v * plotH;
  // 0,50,100% グリッド
  ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  for (const g of [0, 0.5, 1]) {
    const y = toY(g);
    ctx.strokeStyle = g === 0.5 ? "#9ca3af" : "#eee";
    ctx.setLineDash(g === 0.5 ? [2, 2] : []);
    ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#9ca3af"; ctx.fillText(`${(g * 100).toFixed(0)}%`, ml - 4, y + 3);
  }
  buckets.forEach((b, i) => {
    const x = ml + i * slot + (slot - barW) / 2;
    const h = b.bullRate * plotH;
    ctx.fillStyle = b.bullRate >= 0.5 ? "#16a34acc" : "#dc2626cc";
    ctx.fillRect(x, mt + plotH - h, barW, h);
    ctx.fillStyle = "#374151"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`${(b.bullRate * 100).toFixed(0)}`, x + barW / 2, mt + plotH - h - 2);
  });
  drawXLabels(ctx, buckets, ml, slot, mt + plotH + 14);
}

export default function CandleSeasonalityChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [axis, setAxis] = useState<SeasonAxis>("weekday");
  const [metric, setMetric] = useState<Metric>("vol");

  const buckets = useMemo(() => {
    if (prices.length < 5) return [];
    return aggregateSeason(extractCandles(prices), axis);
  }, [prices, axis]);

  useEffect(() => {
    if (!canvasRef.current || buckets.length === 0) return;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width } = init;
    if (metric === "shape") drawShape(ctx, width, buckets);
    else if (metric === "vol")
      drawGrouped(ctx, width, buckets, [
        { get: (b) => b.rangePct, color: "#0ea5e9cc", label: "日次レンジ (H-L)/C" },
        { get: (b) => b.gkVol, color: "#f43f5ecc", label: "Garman-Klassボラ" },
      ], "レンジ・ボラの季節性（平均%）");
    else if (metric === "clv")
      drawDiverging(ctx, width, buckets,
        (b) => Math.max(0, b.clv), (b) => Math.min(0, b.clv),
        "#16a34acc", "#dc2626cc", "終値のレンジ内位置 CLV（+1=高値引け / -1=安値引け）",
        (v) => v.toFixed(2), "高値引け寄り", "安値引け寄り");
    else if (metric === "excursion")
      drawDiverging(ctx, width, buckets,
        (b) => b.mfeUp, (b) => -b.maeDown,
        "#16a34acc", "#dc2626cc", "寄りからの日中到達（上振れ MFE / 下振れ MAE 平均）",
        (v) => `${(v * 100).toFixed(2)}%`, "上振れ (H-O)/O", "下振れ (O-L)/O");
    else if (metric === "gap")
      drawGrouped(ctx, width, buckets, [
        { get: (b) => b.gapUpRate, color: "#16a34acc", label: "上窓率" },
        { get: (b) => b.gapDownRate, color: "#dc2626cc", label: "下窓率" },
        { get: (b) => b.fillRate, color: "#3b82f6cc", label: "窓埋め率" },
      ], "窓の発生率と窓埋め率（割合）");
    else if (metric === "bull") drawBull(ctx, width, buckets);
  }, [buckets, metric]);

  if (prices.length < 5) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">ローソク足の季節性（足の中身×カレンダー）</h3>
        <div className="flex gap-1">
          <button
            onClick={() => setAxis("weekday")}
            className={`px-2.5 py-1 text-xs rounded font-medium ${axis === "weekday" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >曜日</button>
          <button
            onClick={() => setAxis("month")}
            className={`px-2.5 py-1 text-xs rounded font-medium ${axis === "month" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >月</button>
        </div>
      </div>

      <div className="flex gap-1 flex-wrap">
        {METRICS.map((m) => (
          <button
            key={m.value}
            onClick={() => setMetric(m.value)}
            className={`px-2.5 py-1 text-xs rounded font-medium ${metric === m.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >{m.label}</button>
        ))}
      </div>

      <div className="text-xs text-gray-500">
        {axis === "weekday" ? "曜日別" : "月別"} ／ サンプル {buckets.reduce((s, b) => s + b.n, 0)} 日
        （各バケットの日数: {buckets.map((b) => `${b.label}${b.n}`).join(" ")}）
      </div>

      <div className="relative"><canvas ref={canvasRef} /></div>

      <AnalysisGuide title="ローソク足の季節性の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"既存のカレンダー分析が『前日終値→当日終値』のような点対点の変化率を曜日/月で平均するのに対し、本分析は1本の日足ローソクの“中身”（実体・ヒゲ・値幅・終値の位置・寄りからの上下到達・窓・陽線かどうか）をカレンダー軸で分解する。終値だけでは見えない、曜日・月ごとの値動きの質的な癖を捉える。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 各指標と数式（O=始値, H=高値, L=安値, C=終値, prevC=前日終値）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>足形状</strong>: 実体=｜C−O｜/(H−L)、上ヒゲ=(H−max(O,C))/(H−L)、下ヒゲ=(min(O,C)−L)/(H−L)。合計≒1。</li>
          <li><strong>レンジ</strong>: (H−L)/C。<strong>Garman-Klassボラ</strong>: σ=√(0.5·(ln(H/L))² − (2ln2−1)·(ln(C/O))²)。OHLCを使い終値間ボラより効率的に1日の変動を推定。</li>
          <li><strong>CLV (Close Location Value)</strong>: (2C−H−L)/(H−L)。+1=高値引け、−1=安値引け、0=中央。引けにかけての買い/売り圧を表す。</li>
          <li><strong>MFE/MAE</strong>: 上振れ=(H−O)/O、下振れ=(O−L)/O。寄り付きからどれだけ上下に動いたか（含み益/含み損の最大幅の代理）。</li>
          <li><strong>窓・窓埋め</strong>: 窓=(O−prevC)/prevC が±0.1%超。上窓は当日安値が、下窓は当日高値が prevC に達したら「埋めた」と判定。</li>
          <li><strong>陽線率</strong>: C&gt;O の割合（終値間の勝率とは別物で、寄り→引けの方向）。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>上ヒゲが長い曜日 → その曜日は高値を売られやすい（戻り売り優位）。下ヒゲが長ければ押し目買いが入りやすい。</li>
          <li>レンジ/ボラが大きい曜日・月 → 値幅が出やすく、ストップは広めに・サイズは小さめに。</li>
          <li>CLVが高い曜日 → 引けにかけて買われる（大引け強）。低ければ引け安。</li>
          <li>MFEがMAEを上回る曜日 → 寄りから上に伸びやすく押し目買い向き。逆なら戻り売り向き。</li>
          <li>窓埋め率が高い曜日 → 寄りの窓は埋まりやすく、ギャップ逆張りが機能しやすい。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>曜日・月ごとに利確/損切り幅（MFE/MAE）とストップ幅（レンジ/ボラ）を変える。</li>
          <li>CLV・上下ヒゲから執行タイミング（寄り/引け、戻り売り/押し目買い）を選ぶ。</li>
          <li>窓埋め率の高い曜日に絞ってギャップ逆張り、低い曜日は窓継続の順張り。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"日足ベースなので日中の到達『時刻』までは分からない（時刻は『高値・安値の時間帯分析』を併用）。"}</li>
          <li>{"バケットあたりの日数が少ないと平均が不安定。各バケットのnを確認すること。"}</li>
          <li>{"アノマリーは時期で減衰する。期間セレクタを変えて持続性を確認するのが望ましい。"}</li>
          <li>{"窓埋め判定は日中の経路ではなく当日の高安が prevC に達したかで近似している。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
