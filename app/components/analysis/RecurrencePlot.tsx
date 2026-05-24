"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  computeRecurrencePlot,
  estimateLyapunov,
  takensEmbedding,
} from "../../lib/nonlinear";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function RecurrencePlot({ prices, seriesMode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef<HTMLCanvasElement>(null);

  const { values: lr, times: seriesTimes } = extractSeries(prices, seriesMode);

  const rp = useMemo(() => computeRecurrencePlot(lr, 1, 3), [prices, seriesMode]);
  const lyap = useMemo(() => estimateLyapunov(lr, 1, 3, 15), [prices, seriesMode]);
  const embedding = useMemo(
    () => takensEmbedding(lr, seriesTimes, 1, 2),
    [prices, seriesMode]
  );

  // Recurrence Plot描画
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || rp.n === 0) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const size = Math.min(parent.clientWidth, 350);
    const dpr = window.devicePixelRatio || 1;

    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);

    const cellSize = size / rp.n;

    ctx.fillStyle = "#1e40af";
    for (let i = 0; i < rp.n; i++) {
      for (let j = 0; j < rp.n; j++) {
        if (rp.matrix[i * rp.n + j] === 1) {
          ctx.fillRect(
            Math.floor(j * cellSize),
            Math.floor(i * cellSize),
            Math.max(1, Math.ceil(cellSize)),
            Math.max(1, Math.ceil(cellSize))
          );
        }
      }
    }
  }, [rp]);

  // 位相空間プロット描画
  useEffect(() => {
    const canvas = phaseRef.current;
    if (!canvas || embedding.length === 0) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const size = Math.min(parent.clientWidth, 350);
    const dpr = window.devicePixelRatio || 1;

    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, size, size);

    const xs = embedding.map((p) => p.x);
    const ys = embedding.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const margin = 20;
    const plotSize = size - 2 * margin;

    // 軌跡
    ctx.strokeStyle = "rgba(59, 130, 246, 0.3)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let i = 0; i < embedding.length; i++) {
      const px = margin + ((embedding[i].x - minX) / rangeX) * plotSize;
      const py = margin + ((embedding[i].y - minY) / rangeY) * plotSize;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // 点
    for (let i = 0; i < embedding.length; i++) {
      const t = i / embedding.length;
      const px = margin + ((embedding[i].x - minX) / rangeX) * plotSize;
      const py = margin + ((embedding[i].y - minY) / rangeY) * plotSize;
      ctx.fillStyle = `rgba(${Math.round(255 * t)}, ${Math.round(100 * (1 - t))}, ${Math.round(255 * (1 - t))}, 0.7)`;
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 軸ラベル
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.fillText("r(t)", size / 2 - 10, size - 4);
    ctx.save();
    ctx.translate(10, size / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("r(t-1)", 0, 0);
    ctx.restore();
  }, [embedding]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">非線形動力学</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Recurrence Plot */}
        <div>
          <div className="text-sm font-medium text-gray-700 mb-2">
            Recurrence Plot
          </div>
          <div className="flex justify-center">
            <canvas ref={canvasRef} className="rounded border border-gray-100" />
          </div>
          <div className="mt-2 text-xs space-y-1">
            <div>回帰率(RR): <span className="font-mono font-medium">{(rp.recurrenceRate * 100).toFixed(2)}%</span></div>
            <div>決定性(DET): <span className="font-mono font-medium">{(rp.determinism * 100).toFixed(2)}%</span></div>
            <div>層流性(LAM): <span className="font-mono font-medium">{(rp.laminarity * 100).toFixed(2)}%</span></div>
            <div>滞留時間(TT): <span className="font-mono font-medium">{rp.trappingTime.toFixed(2)}</span></div>
            <div>対角線ENTR: <span className="font-mono font-medium">{rp.diagEntropy.toFixed(3)}</span></div>
            <div>最長対角線: <span className="font-mono font-medium">{rp.maxDiagLength}</span></div>
            <div>最長垂直線: <span className="font-mono font-medium">{rp.maxVertLength}</span></div>
          </div>
        </div>

        {/* Phase Space */}
        <div>
          <div className="text-sm font-medium text-gray-700 mb-2">
            位相空間 (Takens埋め込み)
          </div>
          <div className="flex justify-center">
            <canvas ref={phaseRef} className="rounded border border-gray-100" />
          </div>
          <div className="mt-2 text-xs text-gray-500">
            色: 赤(古い) → 青(新しい) / τ=1, dim=2
          </div>
        </div>
      </div>

      {/* Lyapunov指数 */}
      <div className="mt-4 p-3 bg-gray-50 rounded">
        <div className="text-sm font-medium text-gray-700 mb-1">Lyapunov指数</div>
        <div className="text-xs grid grid-cols-2 gap-2">
          <div>
            最大指数: <span className={`font-mono font-medium ${lyap.exponent > 0 ? "text-red-600" : "text-green-600"}`}>
              {lyap.exponent.toFixed(4)}
            </span>
          </div>
          <div className="text-gray-500">
            {lyap.exponent > 0.01
              ? "正 → カオス的挙動 (予測困難)"
              : lyap.exponent < -0.01
              ? "負 → 安定的 (予測可能)"
              : "≈0 → 境界的"}
          </div>
        </div>
      </div>

      <AnalysisGuide title="非線形動力学の読み方">
        <p><span className="font-medium">位相空間(Takens埋め込み):</span> {"Takensの定理に基づき、1次元の時系列を多次元空間に再構成したものです。ここでは遅延座標 (r_t, r_{t-1}) の2次元プロットを表示しています。元の系の力学的構造(アトラクタ)を可視化できます。"}</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">点が一様に分布:</span> ランダムな系列。予測可能な構造がない。</li>
          <li><span className="font-medium">特定の形状(楕円、渦巻き等):</span> 決定論的な構造が存在。その構造を利用した予測が可能かもしれない。</li>
          <li><span className="font-medium">色の推移:</span> 赤(過去)→青(現在)。アトラクタ上の軌道がどう変化したかが分かります。</li>
        </ul>
        <p><span className="font-medium">Recurrence Plot(再帰プロット):</span> 位相空間上で、異なる2時点のベクトルが近い(=似た状態にある)場合に点を打つプロットです。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">対角線上の直線パターン:</span> 系列に周期性がある(同じ軌道を繰り返している)。</li>
          <li><span className="font-medium">対角線の断片(斜めの短い線分):</span> 類似した動きが一時的に繰り返されている。長いほど持続性が高い。</li>
          <li><span className="font-medium">水平・垂直の線:</span> 系列がある状態に「滞留」している(レンジ相場)。</li>
          <li><span className="font-medium">白い領域(点がない):</span> 以前とは全く異なる状態 = レジーム変化が起きた可能性。</li>
        </ul>
        <p><span className="font-medium">RQA (Recurrence Quantification Analysis) メトリクス:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">回帰率(RR):</span> 全ペアのうち再帰している割合。高いほど系列のパターンが繰り返されている。</li>
          <li><span className="font-medium">決定性(DET):</span> 長さ2以上の対角線に含まれる再帰点の割合。高いほど決定論的(=予測可能)。</li>
          <li><span className="font-medium">層流性(LAM):</span> 長さ2以上の垂直線に含まれる再帰点の割合。高いほど系列が特定の状態に「滞留」しやすい(レンジ相場)。</li>
          <li><span className="font-medium">滞留時間(TT):</span> 垂直線の平均長さ。長いほど同じ状態に長く留まる傾向がある。</li>
          <li><span className="font-medium">対角線ENTR:</span> 対角線長の分布のShannon Entropy。高いほど対角線の長さが多様 = 複雑な動力学。</li>
          <li><span className="font-medium">最長対角線:</span> 最も長い対角線構造の長さ。長いほど系列が長期間にわたって過去の軌道を繰り返している。</li>
          <li><span className="font-medium">最長垂直線:</span> 最も長い滞留の長さ。長いほど強いレンジ相場が存在した。</li>
        </ul>
        <p><span className="font-medium">Lyapunov指数:</span> 位相空間上で近接した2つの軌道が時間とともにどれだけ離れるか(発散速度)を示す指標です。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">{`正(λ > 0):`}</span> 初期条件への鋭敏な依存性 = カオス的。わずかな誤差が指数関数的に拡大するため、長期予測は本質的に困難。</li>
          <li><span className="font-medium">{`ゼロ付近(λ ≈ 0):`}</span> 境界的。周期的またはクリティカルな状態。</li>
          <li><span className="font-medium">{`負(λ < 0):`}</span> 軌道が収束。安定した固定点や周期軌道に向かっている = 予測がしやすい。</li>
        </ul>
        <p><span className="font-medium">トレードへの活用:</span> Lyapunov指数が負または0付近で決定性が高い期間は、テクニカル分析の信頼性が高まります。逆にLyapunov指数が大きく正で決定性が低い場合は、ポジションサイズを縮小し、リスク管理を強化すべきです。</p>
      </AnalysisGuide>
    </div>
  );
}
