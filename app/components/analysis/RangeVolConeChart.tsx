"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { rangeVolCone } from "../../lib/vol-cone-range";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
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

export default function RangeVolConeChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rows = useMemo(() => rangeVolCone(prices), [prices]);
  const latest = rows.length ? rows[Math.min(2, rows.length - 1)] : null;

  useEffect(() => {
    if (!canvasRef.current || rows.length < 2) return;
    const init = initCanvas(canvasRef.current, 260);
    if (!init) return;
    const { ctx, width } = init;
    const ml = 44, mr = 14, mt = 22, mb = 28;
    const plotW = width - ml - mr, plotH = 260 - mt - mb;
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("Yang-Zhangボラコーン（窓長別の分位 + 現在値●）", ml, 14);
    const maxV = Math.max(...rows.map((r) => r.max)) * 1.05 || 1;
    const xOf = (i: number) => ml + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
    const yOf = (v: number) => mt + plotH - (v / maxV) * plotH;
    // y軸
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (const g of [0, 0.5, 1]) { const v = maxV * g; ctx.fillText(`${(v * 100).toFixed(0)}%`, ml - 4, yOf(v) + 3); }
    // 帯（25-75）
    ctx.fillStyle = "rgba(37,99,235,0.10)";
    ctx.beginPath();
    rows.forEach((r, i) => ctx[i === 0 ? "moveTo" : "lineTo"](xOf(i), yOf(r.q75)));
    for (let i = rows.length - 1; i >= 0; i--) ctx.lineTo(xOf(i), yOf(rows[i].q25));
    ctx.closePath(); ctx.fill();
    const line = (key: "min" | "median" | "max", color: string, w: number, dash: number[]) => {
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.beginPath();
      rows.forEach((r, i) => ctx[i === 0 ? "moveTo" : "lineTo"](xOf(i), yOf(r[key])));
      ctx.stroke(); ctx.setLineDash([]);
    };
    line("max", "#d1d5db", 1, [3, 3]);
    line("median", "#2563eb", 2, []);
    line("min", "#d1d5db", 1, [3, 3]);
    // 現在値●
    rows.forEach((r, i) => {
      ctx.fillStyle = r.pctile > 0.8 ? "#dc2626" : r.pctile < 0.2 ? "#16a34a" : "#f59e0b";
      ctx.beginPath(); ctx.arc(xOf(i), yOf(r.current), 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(`${r.window}d`, xOf(i), mt + plotH + 14);
    });
  }, [rows]);

  if (prices.length < 60 || rows.length < 2) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">レンジ由来ボラコーン（Yang-Zhang）</h3>

      {latest && (
        <div className={`rounded-md border px-3 py-2 text-xs ${latest.pctile > 0.8 ? "border-red-200 bg-red-50 text-red-900" : latest.pctile < 0.2 ? "border-green-200 bg-green-50 text-green-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
          現在の{latest.window}日ボラは過去の<span className="font-bold">{(latest.pctile * 100).toFixed(0)}パーセンタイル</span>
          （{latest.pctile > 0.8 ? "割高＝ボラ売り/縮小局面に注意" : latest.pctile < 0.2 ? "割安＝ボラ買い/拡大余地" : "中庸"}）。
        </div>
      )}

      <div className="relative"><canvas ref={canvasRef} /></div>
      <div className="text-xs text-gray-500">● 現在値（緑=割安/橙=中庸/赤=割高）／ 青線=中央値 / 帯=25-75% / 点線=最小・最大</div>

      <AnalysisGuide title="ボラコーンの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"いまのボラが過去と比べて高いのか低いのかを、複数の観測期間（窓長）にわたって一望する。各窓長での実現ボラの分位（最小〜最大、中央値、25-75%帯）に現在値を重ね、割高/割安を判定する。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>窓長 5/10/21/42/63/126日それぞれで Yang-Zhang 年率ボラのローリング系列を作る。</li>
          <li>各系列の min/25%/中央値/75%/max と、現在値・その<strong>パーセンタイル</strong>（現在値が過去の何%地点か）を算出。</li>
          <li>YZ＝窓（オーバーナイト）込みの効率的なレンジ由来推定。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>現在値●が帯の上（赤・80%超）＝ボラ割高。オプション売り・平均回帰（ボラ縮小）を想定。</li>
          <li>●が帯の下（緑・20%未満）＝ボラ割安。ボラ拡大（ブレイク）に備える・オプション買い。</li>
          <li>短窓と長窓で位置が乖離＝足元の急変。ターム構造の歪みを示す。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>過去分布が基準。レジームが恒常的に変わると割高/割安の判断もずれる。</li>
          <li>実現ボラであり、オプションのインプライドボラとは別物（直接の裁定ではない）。</li>
          <li>短い窓は推定誤差が大きい。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
