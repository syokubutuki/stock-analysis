"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  statisticalComplexity,
  rollingCEPlane,
  normalizedLZComplexity,
  kolmogorovApprox,
} from "../../lib/complexity";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
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

export default function ComplexityEntropyChart({ prices, seriesMode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { values, times } = extractSeries(prices, seriesMode);

  const sc = useMemo(() => statisticalComplexity(values, 3, 1), [prices, seriesMode]);
  const lz = useMemo(() => normalizedLZComplexity(values), [prices, seriesMode]);
  const kolm = useMemo(() => kolmogorovApprox(values), [prices, seriesMode]);
  const cePlane = useMemo(() => rollingCEPlane(values, times, 3, 60), [prices, seriesMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || cePlane.length === 0) return;
    const result = initCanvas(canvas, 300);
    if (!result) return;
    const { ctx, width, height } = result;

    const margin = { top: 25, right: 20, bottom: 35, left: 55 };
    const pw = width - margin.left - margin.right;
    const ph = height - margin.top - margin.bottom;

    // PE range: 0-1, SC range: 0-max
    const maxSC = Math.max(...cePlane.map((p) => p.sc), 0.01);

    const toX = (pe: number) => margin.left + pe * pw;
    const toY = (sc: number) => margin.top + ph - (sc / maxSC) * ph;

    // グリッド
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = margin.top + (ph * i) / 4;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(width - margin.right, y);
      ctx.stroke();
    }
    for (let i = 0; i <= 4; i++) {
      const x = margin.left + (pw * i) / 4;
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + ph);
      ctx.stroke();
    }

    // 参照領域ラベル
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "rgba(34,197,94,0.3)";
    ctx.fillRect(margin.left, margin.top + ph * 0.3, pw * 0.4, ph * 0.4);
    ctx.fillStyle = "#166534";
    ctx.fillText("決定論的", margin.left + 5, margin.top + ph * 0.5);

    ctx.fillStyle = "rgba(239,68,68,0.1)";
    ctx.fillRect(margin.left + pw * 0.7, margin.top + ph * 0.6, pw * 0.3, ph * 0.4);
    ctx.fillStyle = "#991b1b";
    ctx.fillText("確率的", margin.left + pw * 0.72, margin.top + ph * 0.8);

    // 軌跡を色グラデーションで描画
    const n = cePlane.length;
    for (let i = 1; i < n; i++) {
      const t = i / (n - 1);
      const r = Math.round(59 + (239 - 59) * t);
      const g = Math.round(130 - 130 * t);
      const b = Math.round(246 - 208 * t);
      ctx.strokeStyle = `rgb(${r},${g},${b})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(toX(cePlane[i - 1].pe), toY(cePlane[i - 1].sc));
      ctx.lineTo(toX(cePlane[i].pe), toY(cePlane[i].sc));
      ctx.stroke();
    }

    // 最新点を強調
    if (n > 0) {
      const last = cePlane[n - 1];
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.arc(toX(last.pe), toY(last.sc), 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#333";
      ctx.font = "10px sans-serif";
      ctx.fillText("現在", toX(last.pe) + 8, toY(last.sc) + 3);
    }

    // 軸ラベル
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Permutation Entropy (正規化)", width / 2, height - 4);
    for (let i = 0; i <= 4; i++) {
      ctx.fillText((i * 0.25).toFixed(2), margin.left + (pw * i) / 4, height - 18);
    }
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const val = (maxSC * (4 - i)) / 4;
      ctx.fillText(val.toFixed(3), margin.left - 4, margin.top + (ph * i) / 4 + 3);
    }
    ctx.save();
    ctx.translate(12, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("Statistical Complexity", 0, 0);
    ctx.restore();

    ctx.fillStyle = "#333";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Complexity-Entropy Plane", margin.left + 5, margin.top - 8);

    // カラーバー
    const barW = 80, barH = 8;
    const barX = width - margin.right - barW - 5;
    const barY = margin.top + 5;
    for (let i = 0; i < barW; i++) {
      const t = i / barW;
      const r = Math.round(59 + (239 - 59) * t);
      const g = Math.round(130 - 130 * t);
      const b = Math.round(246 - 208 * t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(barX + i, barY, 1, barH);
    }
    ctx.fillStyle = "#666";
    ctx.font = "8px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("古い", barX, barY + barH + 9);
    ctx.textAlign = "right";
    ctx.fillText("新しい", barX + barW, barY + barH + 9);
  }, [cePlane]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">複雑度-エントロピー平面</h3>

      <div className="grid grid-cols-3 gap-3 text-xs mb-3">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Lempel-Ziv (正規化)</div>
          <div className="font-mono font-medium text-sm">{lz.toFixed(3)}</div>
          <div className="text-gray-400">{lz < 0.5 ? "低複雑度(構造的)" : lz > 0.8 ? "高複雑度(ランダム)" : "中程度"}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Kolmogorov近似</div>
          <div className="font-mono font-medium text-sm">{kolm.toFixed(3)}</div>
          <div className="text-gray-400">圧縮比 (低い=構造的)</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Statistical Complexity</div>
          <div className="font-mono font-medium text-sm text-purple-600">{sc.toFixed(4)}</div>
          <div className="text-gray-400">JSD×PE</div>
        </div>
      </div>

      <div className="w-full rounded border border-gray-100 overflow-hidden">
        <canvas ref={canvasRef} />
      </div>

      <AnalysisGuide title="複雑度-エントロピー平面の理論">
        <p className="font-medium text-gray-700">1. CE平面とは</p>
        <p>X軸=順列エントロピー(ランダム性)、Y軸=統計的複雑度(構造の豊かさ)の散布図です。ローリング窓で計算した軌跡を色グラデーション(青=古い→赤=新しい)で表示します。</p>

        <p className="font-medium text-gray-700 mt-3">2. Statistical Complexity (SC)</p>
        <p>SC = Q_0 × D_JS(P, P_uniform) × H_PE。Jensen-Shannon divergenceと順列エントロピーの積です。完全ランダムでも完全決定論的でもSC=0となり、中間的な(構造的だがノイズもある)系列で最大値を取ります。</p>

        <p className="font-medium text-gray-700 mt-3">3. Lempel-Ziv複雑度</p>
        <p>系列をバイナリ化してLZ76圧縮し、辞書サイズで複雑度を測定。正規化して0-1にスケーリング。低い=パターンの繰り返しが多い=圧縮しやすい。</p>

        <p className="font-medium text-gray-700 mt-3">4. 領域の解釈</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>左下(低PE, 低SC): 決定論的な系列 = トレンド相場</li>
          <li>右下(高PE, 低SC): 完全ランダム = 効率的市場</li>
          <li>中央上部(中PE, 高SC): 構造的だが複雑 = 非線形ダイナミクス</li>
          <li>軌跡の移動方向: 右への移動=ランダム化、左への移動=構造化</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>軌跡が左方向に移動中: 市場が構造化 = テクニカル分析が有効化</li>
          <li>SC急上昇: 複雑な(非線形な)ダイナミクスの出現 = 注意が必要</li>
          <li>LZ複雑度の低下: パターンの反復が増加 = アルゴリズム戦略が有効</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
