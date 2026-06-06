"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { logReturns } from "../../lib/transforms";
import { kramersMoyal } from "../../lib/kramers-moyal";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function KramersMoyalChart({ prices, seriesMode }: Props) {
  const driftCanvasRef = useRef<HTMLCanvasElement>(null);
  const potentialCanvasRef = useRef<HTMLCanvasElement>(null);

  const { values } = extractSeries(prices, seriesMode);
  const needsTransform = seriesMode === "close" || seriesMode === "open";
  const lr = needsTransform ? logReturns(values) : values;
  const priceLevels = needsTransform ? values.slice(0, -1) : values;
  const km = useMemo(() => kramersMoyal(priceLevels, lr, 20), [prices, seriesMode]);

  // Drift + Diffusion plot
  useEffect(() => {
    const canvas = driftCanvasRef.current;
    if (!canvas || km.priceLevels.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement?.clientWidth || 400;
    const height = 220;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { left: 55, right: 15, top: 20, bottom: 30 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const pMin = Math.min(...km.priceLevels);
    const pMax = Math.max(...km.priceLevels);
    const pRange = pMax - pMin || 1;
    const maxDrift = Math.max(...km.drift.map(Math.abs), 0.001);
    const maxDiff = Math.max(...km.diffusion, 0.001);

    const toX = (p: number) => margin.left + ((p - pMin) / pRange) * plotW;
    const halfH = plotH / 2;

    // Zero line
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top + halfH);
    ctx.lineTo(margin.left + plotW, margin.top + halfH);
    ctx.stroke();

    // Drift μ(p)
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    km.priceLevels.forEach((p, i) => {
      const x = toX(p);
      const y = margin.top + halfH - (km.drift[i] / maxDrift) * halfH * 0.9;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill positive/negative drift
    ctx.globalAlpha = 0.15;
    km.priceLevels.forEach((p, i) => {
      const x = toX(p);
      const y = margin.top + halfH - (km.drift[i] / maxDrift) * halfH * 0.9;
      const barW = plotW / km.priceLevels.length;
      ctx.fillStyle = km.drift[i] >= 0 ? "#22c55e" : "#ef4444";
      ctx.fillRect(x - barW / 2, Math.min(y, margin.top + halfH), barW, Math.abs(y - margin.top - halfH));
    });
    ctx.globalAlpha = 1;

    // Diffusion σ(p) (bottom half, inverted)
    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 2;
    ctx.beginPath();
    km.priceLevels.forEach((p, i) => {
      const x = toX(p);
      const y = margin.top + halfH + (km.diffusion[i] / maxDiff) * halfH * 0.8;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Stable/unstable points
    ctx.font = "bold 12px sans-serif";
    km.stablePoints.forEach((p) => {
      const x = toX(p);
      ctx.fillStyle = "#22c55e";
      ctx.textAlign = "center";
      ctx.fillText("▲", x, margin.top + halfH + 14);
    });
    km.unstablePoints.forEach((p) => {
      const x = toX(p);
      ctx.fillStyle = "#ef4444";
      ctx.textAlign = "center";
      ctx.fillText("▼", x, margin.top + halfH + 14);
    });

    // Labels
    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Kramers-Moyal: ドリフト μ(p) と拡散 σ(p)", width / 2, 12);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("株価レベル", width / 2, height - 5);

    ctx.textAlign = "left";
    ctx.fillStyle = "#3b82f6";
    ctx.fillText("μ(p) ドリフト", margin.left + 5, margin.top + 15);
    ctx.fillStyle = "#f97316";
    ctx.fillText("σ(p) 拡散", margin.left + 5, margin.top + plotH - 5);
  }, [km]);

  // Potential function
  useEffect(() => {
    const canvas = potentialCanvasRef.current;
    if (!canvas || km.priceLevels.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement?.clientWidth || 400;
    const height = 200;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { left: 55, right: 15, top: 20, bottom: 30 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const pMin = Math.min(...km.priceLevels);
    const pMax = Math.max(...km.priceLevels);
    const pRange = pMax - pMin || 1;

    const toX = (p: number) => margin.left + ((p - pMin) / pRange) * plotW;

    // Potential curve
    ctx.strokeStyle = "#8b5cf6";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    km.priceLevels.forEach((p, i) => {
      const x = toX(p);
      const y = margin.top + plotH - km.potential[i] * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill under curve
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = "#8b5cf6";
    ctx.beginPath();
    km.priceLevels.forEach((p, i) => {
      const x = toX(p);
      const y = margin.top + plotH - km.potential[i] * plotH;
      if (i === 0) ctx.moveTo(x, margin.top + plotH);
      ctx.lineTo(x, y);
    });
    ctx.lineTo(toX(km.priceLevels[km.priceLevels.length - 1]), margin.top + plotH);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Stable points (minima = attractors)
    ctx.font = "bold 11px sans-serif";
    km.stablePoints.forEach((p) => {
      const x = toX(p);
      const idx = km.priceLevels.findIndex((v) => Math.abs(v - p) < (pRange / km.priceLevels.length));
      if (idx >= 0) {
        const y = margin.top + plotH - km.potential[idx] * plotH;
        ctx.fillStyle = "#22c55e";
        ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fill();
        ctx.textAlign = "center";
        ctx.fillText(`${p.toFixed(0)}`, x, y + 16);
      }
    });

    km.unstablePoints.forEach((p) => {
      const x = toX(p);
      const idx = km.priceLevels.findIndex((v) => Math.abs(v - p) < (pRange / km.priceLevels.length));
      if (idx >= 0) {
        const y = margin.top + plotH - km.potential[idx] * plotH;
        ctx.fillStyle = "#ef4444";
        ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fill();
      }
    });

    // Labels
    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("ポテンシャル関数 V(p) = -∫μ(p)dp", width / 2, 12);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("株価レベル (緑=安定点, 赤=不安定点)", width / 2, height - 5);
  }, [km]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">Kramers-Moyal係数 / ポテンシャル関数</h3>
      <p className="text-xs text-gray-500 mb-3">確率微分方程式の局所ドリフトと拡散を非パラメトリックに推定</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3 text-xs">
        <div className="p-2 bg-green-50 rounded">
          <div className="text-green-700 font-medium">安定点 (ポテンシャル極小)</div>
          <div className="font-bold">{km.stablePoints.map((p) => p.toFixed(0)).join(", ") || "なし"}</div>
          <div className="text-green-600">株価が引き寄せられる価格帯</div>
        </div>
        <div className="p-2 bg-red-50 rounded">
          <div className="text-red-700 font-medium">不安定点 (ポテンシャル極大)</div>
          <div className="font-bold">{km.unstablePoints.map((p) => p.toFixed(0)).join(", ") || "なし"}</div>
          <div className="text-red-600">株価が反発される価格帯</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">解析ビン数</div>
          <div className="font-bold">{km.priceLevels.length}</div>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <canvas ref={driftCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <canvas ref={potentialCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      <AnalysisGuide title="Kramers-Moyal・ポテンシャル分析の詳細理論">
        <p className="font-medium text-gray-700">1. この分析の概要</p>
        <p>株価の確率的な動きを物理学の「力」と「ポテンシャルエネルギー」で表現する分析です。各価格帯で株価がどちらに引っ張られやすいか（ドリフト）、どれだけ揺らぐか（拡散）を推定し、安定点や不安定点を可視化します。</p>
        <p className="mt-1">ボールが起伏のある地面の上を転がるイメージです。谷底（ポテンシャルの極小）にはボールが引き寄せられ、丘の頂上（極大）からは転げ落ちます。株価も同様に「居心地のいい価格帯」と「不安定な価格帯」があり、この分析でそれを定量化します。</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"確率微分方程式: dp = μ(p)dt + σ(p)dW\n\nKramers-Moyal係数（第n次）:\n  M_n(p) = lim(Δt→0) (1/Δt) E[(p(t+Δt)-p(t))^n | p(t)=p]\n  第1次 M₁ = μ(p): ドリフト（局所的な方向性）\n  第2次 M₂ = σ²(p): 拡散（局所的なボラティリティ）\n\nポテンシャル関数: V(p) = -∫μ(p)dp"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>μ(p)</strong>: ドリフト係数。価格pでの局所的な上昇/下降圧力</li>
          <li><strong>σ(p)</strong>: 拡散係数。価格pでのボラティリティ（揺らぎの大きさ）</li>
          <li><strong>V(p)</strong>: ポテンシャル関数。ドリフトの逆符号の累積。物理学のポテンシャルエネルギーに対応</li>
          <li><strong>dW</strong>: ウィーナー過程の増分（ランダムなノイズ成分）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ドリフト μ(p)</strong>: 各価格帯での平均的な価格変化の方向と大きさ。正なら上昇圧力、負なら下降圧力</li>
          <li><strong>拡散 σ(p)</strong>: 各価格帯でのボラティリティ。価格レベルによってリスクが異なることを示す</li>
          <li><strong>安定平衡点</strong>: ポテンシャルの極小値。株価が引き寄せられやすい「居心地のいい価格帯」</li>
          <li><strong>不安定平衡点</strong>: ポテンシャルの極大値。株価が留まりにくい「不安定な価格帯」。どちらかの安定点に向かって離れる</li>
          <li><strong>非パラメトリック推定</strong>: 特定の確率分布を仮定せず、データそのものから各価格帯の統計量を直接計算する方法</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ドリフト μ(p) {">"} 0</strong>: その価格帯では上昇圧力がある。株価は上方向に動きやすい</li>
          <li><strong>ドリフト μ(p) {"<"} 0</strong>: その価格帯では下降圧力がある。株価は下方向に動きやすい</li>
          <li><strong>μ(p)がゼロを横切る点</strong>: 正→負の交差は安定平衡（株価が戻りやすい水準）、負→正の交差は不安定平衡</li>
          <li><strong>ポテンシャルの谷（極小）</strong>: 株価が滞在しやすいゾーン。支持・抵抗線の理論的裏付け</li>
          <li><strong>ポテンシャルの丘（極大）</strong>: 株価が通過しやすいゾーン。ブレイクアウトが起きやすい水準</li>
          <li><strong>拡散σ(p)が高い価格帯</strong>: その水準ではボラティリティが高く、値動きが荒い</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>サポート/レジスタンスの定量化</strong>: ポテンシャルの谷は理論的なサポート・レジスタンス水準。テクニカル分析の経験則を物理モデルで裏付ける</li>
          <li><strong>ブレイクアウト判断</strong>: ポテンシャルの丘を越えると、次の谷まで急速に動く可能性がある。丘の高さが低いほどブレイクアウトしやすい</li>
          <li><strong>リスク管理</strong>: 拡散σ(p)が高い価格帯ではポジションを縮小するなど、価格水準に応じたリスク調整が可能</li>
          <li><strong>平均回帰戦略</strong>: 現在価格が安定平衡点から離れている場合、平衡点に向かう回帰を見込んだ逆張りが検討できる</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>データビン幅依存</strong>: 価格帯のビン幅（分割の細かさ）によってドリフト・拡散の推定値が変わる。細かすぎるとノイズ、粗すぎると構造を見落とす</li>
          <li><strong>定常性の仮定</strong>: 推定期間中にドリフトやポテンシャルが変化しないことを暗黙に仮定。構造変化がある場合は短い窓で再推定が必要</li>
          <li><strong>有限サンプル</strong>: 価格帯の端（極端な高値・安値）ではデータが少なく、推定が不安定になる</li>
          <li><strong>高次項の無視</strong>: Kramers-Moyal展開を2次で打ち切っているため、ジャンプ過程など非ガウス的な要素は捉えきれない</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
