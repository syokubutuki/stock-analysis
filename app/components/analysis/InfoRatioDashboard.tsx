"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeInfoRatio } from "../../lib/predictability";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; seriesMode?: string; }

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

export default function InfoRatioDashboard({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const items = useMemo(() => computeInfoRatio(prices), [prices]);

  useEffect(() => {
    if (!canvasRef.current || items.length === 0) return;
    const H = 300;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 140, mr = 20, mt = 30, mb = 20;
    const plotW = width - ml - mr, plotH = height - mt - mb;

    const maxMI = Math.max(...items.map(i => i.mi), 0.01);
    const rowH = plotH / items.length;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const y = mt + i * rowH;
      const barW = (item.mi / maxMI) * plotW * 0.85;

      // Rank color
      const rankColor = i < 3 ? "#ef4444" : i < 5 ? "#f59e0b" : "#94a3b8";

      // Bar
      ctx.fillStyle = rankColor + "88";
      ctx.fillRect(ml, y + rowH * 0.2, barW, rowH * 0.6);
      ctx.strokeStyle = rankColor; ctx.lineWidth = 0.8;
      ctx.strokeRect(ml, y + rowH * 0.2, barW, rowH * 0.6);

      // Rank badge
      ctx.fillStyle = rankColor;
      ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(`#${item.rank}`, ml - 120, y + rowH * 0.6);

      // Label
      ctx.fillStyle = "#374151"; ctx.font = "11px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(item.indicator, ml - 8, y + rowH * 0.6);

      // MI value
      ctx.fillStyle = "#374151"; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(`MI=${item.mi.toFixed(4)}`, ml + barW + 6, y + rowH * 0.5);
      ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif";
      ctx.fillText(`r=${item.correlation.toFixed(3)}`, ml + barW + 6, y + rowH * 0.75);

      // Separator
      if (i > 0) {
        ctx.strokeStyle = "#f3f4f6"; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      }
    }

    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("指標別 翌日リターン予測情報量ランキング", ml, mt - 10);
  }, [items]);

  if (items.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">情報比率ダッシュボード</h3>
      <p className="text-xs text-gray-500">各指標が翌日リターンについて持つ予測情報量 (相互情報量 MI) のランキング。</p>
      <div className="relative"><canvas ref={canvasRef} /></div>

      <div className="p-3 bg-blue-50 rounded text-xs text-gray-700">
        <div className="font-medium text-blue-800 mb-1">最も情報量の多い指標</div>
        {items.length > 0 && (
          <p>
            1位: <strong>{items[0].indicator}</strong> (MI={items[0].mi.toFixed(4)}, 相関={items[0].correlation.toFixed(3)})。
            {items[0].mi > 0.01
              ? "一定の予測情報を含む。ただし、MIは非線形関係も捉えるため、線形相関が低くてもMIが高い場合は非線形パターンが存在する。"
              : "全指標のMIが低く、翌日リターンの予測は困難。効率的市場に近い状態。"}
          </p>
        )}
      </div>

      <AnalysisGuide title="情報比率ダッシュボードの詳細理論">
        <p className="font-medium text-gray-700">1. 相互情報量 (MI)</p>
        <p>{"MI(X;Y) = ΣΣ p(x,y) log(p(x,y) / (p(x)p(y)))。X=指標値、Y=翌日リターン。MIは0以上で、XとYが独立なら0、完全に依存していれば正の大きな値。線形・非線形の両方の依存関係を捉える。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 計算方法</p>
        <p>各変数を10個のビンに離散化し、同時分布の頻度表から確率を推定してMIを計算します。ビン数が少ないと解像度が低下し、多いとサンプル不足でノイズが増加します。</p>
        <p className="font-medium text-gray-700 mt-3">3. 相関係数との違い</p>
        <p>Pearson相関は線形関係のみ測定。MI=0.05, r=0.01の場合、非線形パターン（例: ボラティリティ依存の方向バイアス）が存在する可能性があります。</p>
        <p className="font-medium text-gray-700 mt-3">4. 評価される指標</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>前日リターン r_t: 自己相関の検出</li>
          <li>|前日リターン|: ボラティリティ→方向の非線形関係</li>
          <li>出来高変化率: 出来高の先行性</li>
          <li>5日モメンタム: 中期トレンドの予測力</li>
          <li>20日ローリングボラティリティ: ボラレジームの予測力</li>
          <li>RSI(14): テクニカル指標の予測力</li>
          <li>Close Position: 日中の引け方の予測力</li>
          <li>ギャップサイズ: オーバーナイト情報の予測力</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
