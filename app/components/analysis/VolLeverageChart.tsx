"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeVolLeverage } from "../../lib/vol-leverage";
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

export default function VolLeverageChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const res = useMemo(() => computeVolLeverage(prices), [prices]);

  useEffect(() => {
    if (!canvasRef.current || !res) return;
    const init = initCanvas(canvasRef.current, 220);
    if (!init) return;
    const { ctx, width } = init;
    const ml = 40, mr = 14, mt = 24, mb = 40;
    const plotW = width - ml - mr, plotH = 220 - mt - mb;
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("当日リターン別 翌日ボラ（年率, 点線=全体平均）", ml, 14);
    const maxV = Math.max(res.baselineVol, ...res.buckets.map((b) => b.nextVol)) * 1.1 || 1;
    const yOf = (v: number) => mt + plotH - (v / maxV) * plotH;
    // baseline
    ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(ml, yOf(res.baselineVol)); ctx.lineTo(ml + plotW, yOf(res.baselineVol)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(`${(maxV * 100).toFixed(0)}%`, ml - 3, mt + 8);
    const slot = plotW / res.buckets.length;
    res.buckets.forEach((b, i) => {
      const x = ml + i * slot + slot * 0.2;
      const w = slot * 0.6;
      const h = (b.nextVol / maxV) * plotH;
      ctx.fillStyle = i < 2 ? "#dc2626" : i === 2 ? "#9ca3af" : "#16a34a";
      ctx.fillRect(x, mt + plotH - h, w, h);
      ctx.fillStyle = "#374151"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(`${(b.nextVol * 100).toFixed(0)}%`, x + w / 2, mt + plotH - h - 3);
      ctx.fillStyle = "#6b7280";
      ctx.fillText(b.label, x + w / 2, mt + plotH + 14);
      ctx.fillText(`n=${b.n}`, x + w / 2, mt + plotH + 26);
    });
  }, [res]);

  if (prices.length < 30 || !res) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">ボラのレバレッジ効果（下落→翌日ボラ拡大の非対称性）</h3>

      <div className={`rounded-md border px-3 py-2 text-xs ${res.corr < -0.05 ? "border-amber-200 bg-amber-50 text-amber-900" : "border-gray-200 bg-gray-50 text-gray-700"}`}>
        当日リターンと翌日ボラの相関 = <span className="font-bold">{res.corr.toFixed(3)}</span>
        {res.corr < -0.05 ? "（負＝下落するほど翌日ボラ拡大＝レバレッジ効果あり）" : "（弱い）"}
      </div>

      <div className="relative"><canvas ref={canvasRef} /></div>

      <AnalysisGuide title="ボラのレバレッジ効果の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"株価は『下げるとボラが急拡大、上げると落ち着く』という非対称性（レバレッジ効果）を持つことが多い。当日リターンの大小で分けて翌日のレンジ由来ボラ（Garman-Klass）を平均し、この非対称性を定量化する。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 数式・定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>当日リターン r_t を5階級に分け、各階級で翌日のGK年率ボラの平均を取る。</li>
          <li><strong>相関</strong>: corr(r_t, ボラ_t+1)。負で大きいほどレバレッジ効果が強い。</li>
          <li>レバレッジ効果の名称は、株価下落で自己資本が減り財務レバレッジが上がる→リスク増、という古典的説明に由来。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>大幅安（赤）の翌日ボラが全体平均より明確に高い＝<strong>下落後はリスク急拡大</strong>。サイズ縮小・ストップ拡大。</li>
          <li>この非対称性が強い銘柄は、下落時のオプション（プット）が割高になりやすい。</li>
          <li>相関がほぼ0なら対称的で、GARCHの非対称項（GJR/EGARCH）の効きは薄い。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>階級の閾値（±0.5%/±2%）次第で見え方が変わる。</li>
          <li>大幅高/大幅安は件数が少なくなりがち。nを確認。</li>
          <li>翌日のみの効果。複数日のボラ持続はGARCH/HARで別途。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
