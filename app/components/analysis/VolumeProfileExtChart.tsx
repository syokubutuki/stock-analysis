"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeVolumeProfile } from "../../lib/volume-profile-ext";
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

export default function VolumeProfileExtChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const res = useMemo(() => computeVolumeProfile(prices, 44), [prices]);

  useEffect(() => {
    if (!canvasRef.current || !res) return;
    const H = 360;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width } = init;
    const ml = 60, mr = 80, mt = 16, mb = 12;
    const plotW = width - ml - mr, plotH = H - mt - mb;
    const n = res.bins.length;
    const rowH = plotH / n;
    const priceLo = res.bins[0].priceLow, priceHi = res.bins[n - 1].priceHigh;
    const yOf = (price: number) => mt + plotH - ((price - priceLo) / (priceHi - priceLo)) * plotH;

    res.bins.forEach((b, i) => {
      const w = (b.volume / res.maxVol) * plotW;
      const y = mt + plotH - (i + 1) * rowH;
      ctx.fillStyle = b.isPOC ? "#dc2626" : b.inValueArea ? "#3b82f6cc" : b.isLVN ? "#e5e7eb" : "#93c5fd";
      ctx.fillRect(ml, y + 0.5, w, rowH - 0.5);
      if (b.isHVN && !b.isPOC) { ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 1; ctx.strokeRect(ml, y + 0.5, w, rowH - 0.5); }
    });
    // POC / VA / current price ライン
    const drawLevel = (price: number, color: string, label: string) => {
      const y = yOf(price);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([4, 2]);
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(`${label} ${price.toFixed(0)}`, ml + plotW + 4, y + 3);
    };
    drawLevel(res.poc, "#dc2626", "POC");
    drawLevel(res.vaHigh, "#2563eb", "VAH");
    drawLevel(res.vaLow, "#2563eb", "VAL");
    drawLevel(res.currentPrice, "#111827", "現在");
    // y軸ラベル
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let g = 0; g <= 4; g++) { const pr = priceLo + (priceHi - priceLo) * (g / 4); ctx.fillText(pr.toFixed(0), ml - 4, yOf(pr) + 3); }
  }, [res]);

  if (prices.length < 30 || !res) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">期間ボリュームプロファイル拡張（POC・バリューエリア・HVN/LVN）</h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="p-2 rounded border border-red-200 bg-red-50"><div className="text-gray-500">POC(最大出来高)</div><div className="font-mono font-medium">{res.poc.toFixed(0)}</div></div>
        <div className="p-2 rounded border border-blue-200 bg-blue-50"><div className="text-gray-500">VA上限</div><div className="font-mono font-medium">{res.vaHigh.toFixed(0)}</div></div>
        <div className="p-2 rounded border border-blue-200 bg-blue-50"><div className="text-gray-500">VA下限</div><div className="font-mono font-medium">{res.vaLow.toFixed(0)}</div></div>
        <div className="p-2 rounded border border-gray-300 bg-gray-50"><div className="text-gray-500">現在値</div><div className="font-mono font-medium">{res.currentPrice.toFixed(0)}</div></div>
      </div>

      <div className="relative"><canvas ref={canvasRef} /></div>
      <div className="text-xs text-gray-500">赤=POC / 青=バリューエリア(70%) / 枠=HVN(厚い節) / 薄灰=LVN(薄い節)</div>

      <AnalysisGuide title="ボリュームプロファイルの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"時間軸ではなく『価格帯ごと』にどれだけ出来高が積み上がったかを見る。多くの取引が成立した価格は支持/抵抗になりやすく、出来高の薄い価格帯は素早く通過しやすい。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 用語・計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>POC</strong>(Point of Control): 最も出来高の多い価格帯。最強の引力＝支持抵抗。</li>
          <li><strong>バリューエリア</strong>(VA): POCから上下に広げ全出来高の70%が収まる価格帯（VAH=上限/VAL=下限）。「適正価格」の範囲。</li>
          <li><strong>HVN</strong>(High Volume Node): 出来高の濃い節＝価格が止まりやすい。<strong>LVN</strong>(Low Volume Node): 薄い節＝価格が走りやすい。</li>
          <li>各日の出来高を当日レンジに按分して価格帯に配分。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>POC・VAH/VALを支持抵抗の目安に。VA内は回帰しやすく、VA外への放れはトレンド。</li>
          <li>LVN（薄い帯）は抜けると一気に走りやすい＝ブレイクの通過点。</li>
          <li>現在値とPOCの位置関係で割高/割安、戻り目標を判断。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>日足按分のため日中の真の出来高分布（ティック）より粗い。</li>
          <li>期間（表示レンジ）の取り方でプロファイルが変わる。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
