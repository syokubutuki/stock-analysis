"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeVolumeProfile } from "../../lib/cross-analysis";
import AnalysisGuide from "./AnalysisGuide";

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

function fmtVol(v: number): string {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return v.toFixed(0);
}

export default function VolumeProfileChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const profile = useMemo(() => computeVolumeProfile(prices, 50), [prices]);

  useEffect(() => {
    if (!canvasRef.current || profile.bins.length === 0) return;
    const canvasH = 500;
    const init = initCanvas(canvasRef.current, canvasH);
    if (!init) return;
    const { ctx, width, height } = init;

    const ml = 80, mr = 20, mt = 30, mb = 30;
    const plotW = width - ml - mr;
    const plotH = height - mt - mb;

    const bins = profile.bins;
    const minPrice = bins[0].priceCenter - (bins[1]?.priceCenter - bins[0].priceCenter || 0) / 2;
    const maxPrice = bins[bins.length - 1].priceCenter + (bins[bins.length - 1].priceCenter - (bins[bins.length - 2]?.priceCenter || bins[bins.length - 1].priceCenter)) / 2;
    const priceRange = maxPrice - minPrice || 1;
    const maxVol = Math.max(...bins.map(b => b.volume), 1);

    // Y position from price
    const yFromPrice = (p: number) => mt + plotH - ((p - minPrice) / priceRange) * plotH;
    const barHeight = plotH / bins.length;

    // Draw bins as horizontal bars
    for (const bin of bins) {
      const y = yFromPrice(bin.priceCenter) - barHeight / 2;
      const totalW = (bin.volume / maxVol) * plotW;
      const buyW = bin.volume > 0 ? (bin.buyVolume / bin.volume) * totalW : 0;
      const sellW = totalW - buyW;

      // Buy volume (green)
      ctx.fillStyle = "rgba(34, 197, 94, 0.6)";
      ctx.fillRect(ml, y + 1, buyW, barHeight - 2);
      // Sell volume (red)
      ctx.fillStyle = "rgba(239, 68, 68, 0.5)";
      ctx.fillRect(ml + buyW, y + 1, sellW, barHeight - 2);
    }

    // POC line
    const pocY = yFromPrice(profile.poc);
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(ml, pocY); ctx.lineTo(width - mr, pocY);
    ctx.stroke();
    ctx.fillStyle = "#f59e0b";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`POC: ${profile.poc.toFixed(0)}`, ml - 4, pocY + 4);

    // VAH / VAL lines
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 3]);
    const vahY = yFromPrice(profile.vah);
    ctx.beginPath(); ctx.moveTo(ml, vahY); ctx.lineTo(width - mr, vahY); ctx.stroke();
    ctx.fillStyle = "#3b82f6";
    ctx.fillText(`VAH: ${profile.vah.toFixed(0)}`, ml - 4, vahY + 4);

    const valY = yFromPrice(profile.val);
    ctx.beginPath(); ctx.moveTo(ml, valY); ctx.lineTo(width - mr, valY); ctx.stroke();
    ctx.fillText(`VAL: ${profile.val.toFixed(0)}`, ml - 4, valY + 4);

    // Value Area shading
    ctx.fillStyle = "rgba(59, 130, 246, 0.06)";
    ctx.fillRect(ml, vahY, plotW, valY - vahY);

    ctx.setLineDash([]);

    // Y axis labels (price)
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    const nTicks = 8;
    for (let i = 0; i <= nTicks; i++) {
      const price = minPrice + (priceRange * i) / nTicks;
      const y = yFromPrice(price);
      ctx.fillText(price.toFixed(0), ml - 4, y + 3);
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
    }

    // X axis labels (volume)
    ctx.textAlign = "center";
    ctx.fillStyle = "#6b7280";
    for (let i = 0; i <= 4; i++) {
      const vol = (maxVol * i) / 4;
      const x = ml + (plotW * i) / 4;
      ctx.fillText(fmtVol(vol), x, height - mb + 15);
    }

    // Border
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.strokeRect(ml, mt, plotW, plotH);

    // Title
    ctx.fillStyle = "#374151";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("出来高プロファイル (Volume at Price)", ml, mt - 10);

    // Legend
    const lx = width - mr - 200;
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "rgba(34, 197, 94, 0.6)";
    ctx.fillRect(lx, mt + 5, 12, 10);
    ctx.fillStyle = "#374151";
    ctx.fillText("買い出来高", lx + 16, mt + 14);
    ctx.fillStyle = "rgba(239, 68, 68, 0.5)";
    ctx.fillRect(lx + 85, mt + 5, 12, 10);
    ctx.fillStyle = "#374151";
    ctx.fillText("売り出来高", lx + 101, mt + 14);
  }, [profile]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">出来高プロファイル (Volume at Price)</h3>

      <div className="relative">
        <canvas ref={canvasRef} />
      </div>

      {/* 統計サマリー */}
      {profile.bins.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className="p-2 bg-amber-50 rounded border border-amber-200">
            <div className="text-gray-500">POC (最大出来高)</div>
            <div className="font-mono font-bold text-amber-700">{profile.poc.toFixed(1)}</div>
          </div>
          <div className="p-2 bg-blue-50 rounded border border-blue-200">
            <div className="text-gray-500">VAH (70%上限)</div>
            <div className="font-mono font-bold text-blue-700">{profile.vah.toFixed(1)}</div>
          </div>
          <div className="p-2 bg-blue-50 rounded border border-blue-200">
            <div className="text-gray-500">VAL (70%下限)</div>
            <div className="font-mono font-bold text-blue-700">{profile.val.toFixed(1)}</div>
          </div>
          <div className="p-2 bg-gray-50 rounded border border-gray-200">
            <div className="text-gray-500">バリューエリア幅</div>
            <div className="font-mono font-bold text-gray-700">
              {((profile.vah - profile.val) / profile.poc * 100).toFixed(1)}%
            </div>
          </div>
        </div>
      )}

      {/* 判定 */}
      {profile.bins.length > 0 && (() => {
        const lastClose = prices[prices.length - 1]?.close || 0;
        const position = lastClose >= profile.vah ? "above" : lastClose <= profile.val ? "below" : "inside";
        return (
          <div className={`p-3 rounded text-xs ${
            position === "inside" ? "bg-green-50 text-green-800" :
            position === "above" ? "bg-blue-50 text-blue-800" :
            "bg-orange-50 text-orange-800"
          }`}>
            <div className="font-medium mb-1">現在値の位置分析</div>
            <p>
              現在値 {lastClose.toFixed(0)} は
              {position === "inside"
                ? `バリューエリア内 (${profile.val.toFixed(0)}~${profile.vah.toFixed(0)})。出来高が集中した公正価値圏にある。`
                : position === "above"
                ? `バリューエリアの上 (VAH: ${profile.vah.toFixed(0)})。出来高の薄い高値圏で、抵抗が少なく上昇しやすいが、落ちると戻りやすい。`
                : `バリューエリアの下 (VAL: ${profile.val.toFixed(0)})。出来高の薄い安値圏で、サポートが弱く下落しやすいが、反発すると一気に戻る可能性。`}
            </p>
          </div>
        );
      })()}

      <AnalysisGuide title="出来高プロファイル分析の詳細理論">
        <p className="font-medium text-gray-700">1. 出来高プロファイルとは</p>
        <p>出来高プロファイル (Volume Profile) は、価格帯別の累積出来高を横向きヒストグラムで表示する分析手法です。通常の出来高チャートが「いつ」取引されたかを示すのに対し、出来高プロファイルは「いくらで」取引されたかを示します。</p>

        <p className="font-medium text-gray-700 mt-3">2. 主要概念</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>POC (Point of Control)</strong>: 最も出来高が集中した価格帯。最も「合意された」価格であり、強い引力を持つ。価格がPOCから離れると、POCに引き戻される傾向がある。</li>
          <li><strong>バリューエリア (VA)</strong>: 全出来高の70%が取引された価格範囲。統計的に、翌日も70%の確率でバリューエリア内に留まるとされる (Value Area Rule)。</li>
          <li><strong>VAH (Value Area High)</strong>: バリューエリアの上限。この上に価格が抜けると、出来高が薄い領域に入り急騰しやすい。</li>
          <li><strong>VAL (Value Area Low)</strong>: バリューエリアの下限。この下に価格が抜けると、サポートが弱く急落しやすい。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 出来高の分配方法</p>
        <p>日足データでは、各日のOHLCから日中の価格レンジを推定します。各日の出来高は、その日のHigh-Lowの範囲内の各価格ビンに均等に分配されます。Close &gt; Openの日は買い出来高（緑）、Close &lt; Openの日は売り出来高（赤）として分類されます。</p>

        <p className="font-medium text-gray-700 mt-3">4. バリューエリアの計算</p>
        <p>POCのビンから出発し、上下に隣接するビンの出来高を比較しながら、累積出来高が全体の70%に達するまでバリューエリアを拡張します。各ステップでは、上側と下側でより出来高の多い方を先に追加します。</p>

        <p className="font-medium text-gray-700 mt-3">5. トレード戦略への応用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>出来高の集中する価格帯（High Volume Node, HVN）は支持/抵抗線として機能する</li>
          <li>出来高の少ない価格帯（Low Volume Node, LVN）では価格が素早く通過する傾向がある</li>
          <li>バリューエリア内でのレンジトレード: VAHで売り、VALで買い</li>
          <li>VAH/VALのブレイクアウト: 出来高の薄い領域に入るとモメンタムが加速</li>
          <li>POCへの回帰: 価格がPOCから大きく離れた後、POCに回帰する傾向を利用</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
