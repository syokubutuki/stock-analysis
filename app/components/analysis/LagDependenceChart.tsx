"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  lagScatterHeatmap, copulaScatter, mutualInfoByLag, scatterMatrix,
} from "../../lib/distribution-extended";
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
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

// ヒートマップのカラーマップ (count → color)
function densityColor(density: number, maxDensity: number): string {
  const t = Math.min(1, density / maxDensity);
  if (t < 0.25) return `rgba(59, 130, 246, ${t * 4 * 0.3})`;
  if (t < 0.5) return `rgba(59, 130, 246, ${0.3 + (t - 0.25) * 4 * 0.3})`;
  if (t < 0.75) return `rgba(239, 83, 80, ${0.3 + (t - 0.5) * 4 * 0.4})`;
  return `rgba(220, 38, 38, ${0.7 + (t - 0.75) * 4 * 0.3})`;
}

export default function LagDependenceChart({ prices, seriesMode }: Props) {
  const heatmapRef = useRef<HTMLCanvasElement>(null);
  const copulaRef = useRef<HTMLCanvasElement>(null);
  const miRef = useRef<HTMLCanvasElement>(null);
  const scatterRef = useRef<HTMLCanvasElement>(null);

  const { values: lr, times } = extractSeries(prices, seriesMode);
  const volumes = useMemo(() => {
    const vols = prices.map(p => p.volume);
    return vols.slice(vols.length - lr.length);
  }, [prices, seriesMode]);

  const heatmap = useMemo(() => lagScatterHeatmap(lr, 50), [prices, seriesMode]);
  const copula = useMemo(() => copulaScatter(lr), [prices, seriesMode]);
  const miLag = useMemo(() => mutualInfoByLag(lr, 20, 15), [prices, seriesMode]);
  const scatterPairs = useMemo(() => scatterMatrix(lr, times, volumes), [prices, seriesMode]);

  // 16. ラグ散布ヒートマップ
  useEffect(() => {
    if (!heatmapRef.current || heatmap.data.length < 1) return;
    const r = initCanvas(heatmapRef.current, 300); if (!r) return;
    const { ctx, width, height } = r;
    const size = Math.min(width, height);
    const pad = 45;
    const ps = size - 2 * pad;
    const bins = 50;
    const cellSize = ps / bins;

    const maxDensity = Math.max(...heatmap.data.map(d => d.density));

    // ヒートマップセル
    for (const d of heatmap.data) {
      const x = pad + d.xIdx * cellSize;
      const y = pad + (bins - 1 - d.yIdx) * cellSize;
      ctx.fillStyle = densityColor(d.density, maxDensity);
      ctx.fillRect(x, y, cellSize + 0.5, cellSize + 0.5);
    }

    // 対角線 (r[t-1] = r[t])
    ctx.strokeStyle = "rgba(220, 38, 38, 0.3)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad, pad + ps); ctx.lineTo(pad + ps, pad); ctx.stroke();
    ctx.setLineDash([]);

    // 軸ラベル
    const { minVal, maxVal } = heatmap;
    ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`r[t-1] (${(minVal * 100).toFixed(1)}%~${(maxVal * 100).toFixed(1)}%)`, size / 2, size - 5);
    ctx.save(); ctx.translate(10, size / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText("r[t]", 0, 0); ctx.restore();

    // カラーバー
    const barW = 10, barH = ps;
    const barX = pad + ps + 10;
    for (let i = 0; i < barH; i++) {
      const t = i / barH;
      ctx.fillStyle = densityColor(t * maxDensity, maxDensity);
      ctx.fillRect(barX, pad + barH - i, barW, 1);
    }
    ctx.fillStyle = "#999"; ctx.font = "8px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("高", barX + barW + 3, pad + 8);
    ctx.fillText("低", barX + barW + 3, pad + barH);
  }, [heatmap]);

  // 12. コピュラ散布図
  useEffect(() => {
    if (!copulaRef.current || copula.length < 5) return;
    const r = initCanvas(copulaRef.current, 280); if (!r) return;
    const { ctx, width, height } = r;
    const size = Math.min(width, height);
    const pad = 40;
    const ps = size - 2 * pad;

    // 背景のグリッド
    ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const pos = pad + (i / 4) * ps;
      ctx.beginPath(); ctx.moveTo(pad, pos); ctx.lineTo(pad + ps, pos); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pos, pad); ctx.lineTo(pos, pad + ps); ctx.stroke();
    }

    // 独立の対角線
    ctx.strokeStyle = "rgba(220, 38, 38, 0.3)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad, pad + ps); ctx.lineTo(pad + ps, pad); ctx.stroke();
    ctx.setLineDash([]);

    // 点
    for (const p of copula) {
      const x = pad + p.u * ps;
      const y = pad + ps - p.v * ps;
      // テール部分を強調
      const inTail = (p.u < 0.1 && p.v < 0.1) || (p.u > 0.9 && p.v > 0.9);
      ctx.fillStyle = inTail ? "rgba(239, 83, 80, 0.7)" : "rgba(59, 130, 246, 0.3)";
      ctx.beginPath(); ctx.arc(x, y, inTail ? 2.5 : 1.5, 0, Math.PI * 2); ctx.fill();
    }

    ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("u = Rank(r[t-1])/(n+1)", size / 2, size - 5);
    ctx.save(); ctx.translate(10, size / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText("v = Rank(r[t])/(n+1)", 0, 0); ctx.restore();
  }, [copula]);

  // 14. 相互情報量ラグプロット
  useEffect(() => {
    if (!miRef.current || miLag.length < 2) return;
    const r = initCanvas(miRef.current, 200); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 20, bottom: 30, left: 50, right: 50 };
    const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;
    const n = miLag.length;

    const maxMI = Math.max(...miLag.map(d => d.mi), 0.001);
    const maxACF = Math.max(...miLag.map(d => d.acfAbs), 0.001);
    const barW = Math.max(3, pw / n - 4);

    // MI bars
    for (let i = 0; i < n; i++) {
      const d = miLag[i];
      const x = pad.left + ((d.lag - 0.5) / (n + 1)) * pw;
      const barH = (d.mi / maxMI) * ph;
      ctx.fillStyle = "rgba(139, 92, 246, 0.6)";
      ctx.fillRect(x, pad.top + ph - barH, barW / 2, barH);
    }

    // ACF² line
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const d = miLag[i];
      const x = pad.left + ((d.lag) / (n + 1)) * pw;
      const y = pad.top + ph * (1 - d.acfAbs / maxACF);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Y軸 (左: MI)
    ctx.fillStyle = "#8b5cf6"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 3; i++) {
      const v = (maxMI * i) / 3;
      const y = pad.top + ph * (1 - i / 3);
      ctx.fillText(v.toFixed(4), pad.left - 5, y + 3);
    }

    // Y軸 (右: ACF²)
    ctx.fillStyle = "#ef4444"; ctx.textAlign = "left";
    for (let i = 0; i <= 3; i++) {
      const v = (maxACF * i) / 3;
      const y = pad.top + ph * (1 - i / 3);
      ctx.fillText(v.toFixed(4), width - pad.right + 5, y + 3);
    }

    // 凡例
    ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    ctx.fillStyle = "rgba(139, 92, 246, 0.6)"; ctx.fillRect(pad.left, height - 14, 12, 8);
    ctx.fillStyle = "#666"; ctx.fillText("相互情報量 I(rₜ; rₜ₋ₖ)", pad.left + 15, height - 7);
    const lx2 = pad.left + 140;
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(lx2, height - 10); ctx.lineTo(lx2 + 12, height - 10); ctx.stroke();
    ctx.fillStyle = "#666"; ctx.fillText("ACF²(k) (線形成分)", lx2 + 15, height - 7);

    ctx.fillStyle = "#333"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Lag", width / 2, height - 18);
  }, [miLag]);

  // 11. 散布図行列
  useEffect(() => {
    if (!scatterRef.current || scatterPairs.length < 1) return;
    const cols = scatterPairs.length;
    const cellH = 160;
    const totalH = cellH;
    const r = initCanvas(scatterRef.current, totalH); if (!r) return;
    const { ctx, width } = r;
    const cellW = Math.floor(width / cols);

    for (let c = 0; c < cols; c++) {
      const pair = scatterPairs[c];
      const ox = c * cellW;
      const margin = 25;
      const ps = Math.min(cellW, cellH) - 2 * margin;

      // 枠
      ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
      ctx.strokeRect(ox + margin, margin, ps, ps);

      const pts = pair.points;
      if (pts.length < 5) continue;
      let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
      for (const p of pts) {
        xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x);
        yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y);
      }
      const xRange = xMax - xMin || 1, yRange = yMax - yMin || 1;
      const toX = (v: number) => ox + margin + ((v - xMin) / xRange) * ps;
      const toY = (v: number) => margin + ps - ((v - yMin) / yRange) * ps;

      // 点
      ctx.fillStyle = "rgba(59, 130, 246, 0.2)";
      for (const p of pts) {
        ctx.beginPath(); ctx.arc(toX(p.x), toY(p.y), 1.5, 0, Math.PI * 2); ctx.fill();
      }

      // ラベル
      ctx.fillStyle = "#333"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(pair.labelX, ox + margin + ps / 2, margin + ps + 15);
      ctx.fillText(`ρ=${pair.correlation.toFixed(3)}`, ox + margin + ps / 2, margin - 5);

      ctx.save();
      ctx.translate(ox + 8, margin + ps / 2); ctx.rotate(-Math.PI / 2);
      ctx.fillText(pair.labelY, 0, 0);
      ctx.restore();
    }
  }, [scatterPairs]);

  // MI vs ACF² の差分 (非線形依存の量)
  const nonlinearDep = useMemo(() => {
    if (miLag.length === 0) return null;
    const totalMI = miLag.reduce((a, d) => a + d.mi, 0);
    const totalACF2 = miLag.reduce((a, d) => a + d.acfAbs, 0);
    return {
      totalMI,
      totalACF2,
      nonlinearRatio: totalMI > 0 ? Math.max(0, 1 - totalACF2 / totalMI) : 0,
    };
  }, [miLag]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">ラグ構造・非線形依存性分析</h3>

      {/* 統計サマリー */}
      {nonlinearDep && (
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">総相互情報量 (20ラグ合計)</div>
            <div className="font-mono font-medium">{nonlinearDep.totalMI.toFixed(4)} nats</div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">線形成分 (ACF²合計)</div>
            <div className="font-mono font-medium">{nonlinearDep.totalACF2.toFixed(4)}</div>
          </div>
          <div className="p-2 bg-gray-50 rounded">
            <div className="text-gray-500">非線形依存の割合</div>
            <div className={`font-mono font-medium ${nonlinearDep.nonlinearRatio > 0.3 ? "text-purple-600" : ""}`}>
              {(nonlinearDep.nonlinearRatio * 100).toFixed(1)}%
            </div>
          </div>
        </div>
      )}

      {/* ラグ散布ヒートマップ */}
      <div>
        <div className="text-xs text-gray-500 mb-1">ラグ散布図ヒートマップ: r[t] vs r[t-1] の同時密度</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={heatmapRef} /></div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* コピュラ散布図 */}
        <div>
          <div className="text-xs text-gray-500 mb-1">コピュラ散布図 (順位変換後、赤=テール領域)</div>
          <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={copulaRef} /></div>
        </div>
        {/* 相互情報量ラグプロット */}
        <div>
          <div className="text-xs text-gray-500 mb-1">相互情報量 vs ACF² (非線形依存の検出)</div>
          <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={miRef} /></div>
        </div>
      </div>

      {/* 散布図行列 */}
      <div>
        <div className="text-xs text-gray-500 mb-1">散布図行列 (線形/非線形依存の可視化)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={scatterRef} /></div>
      </div>

      <AnalysisGuide title="ラグ構造・非線形依存性分析の詳細理論">
        <p className="font-medium text-gray-700">1. ラグ散布図ヒートマップ</p>
        <p>r[t-1] (横軸) と r[t] (縦軸) の二次元同時密度をヒートマップで表示します。ACF(1)は同時分布の「線形成分」を1つの数値に要約したものですが、ヒートマップは分布全体の構造を見せます。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>対角線上に集中 → モメンタム: 上昇の後に上昇、下落の後に下落が続く</li>
          <li>反対角線上に集中 → ミーンリバージョン: 上昇の後に下落、下落の後に上昇</li>
          <li>中央に丸く集中 → 独立（ランダムウォーク）</li>
          <li>X字型の分布 → 非線形依存: 大きな変動の後にさらに大きな変動が来る（方向は問わない）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">2. コピュラ散布図</p>
        <p>各データ点をその順位（rank）に変換し、(u, v) = (Rank(r[t-1])/(n+1), Rank(r[t])/(n+1)) としてプロットします。この変換により周辺分布の影響（テールの重さ等）を除去し、「純粋な依存構造」のみを可視化します。</p>
        <p>コピュラ理論（Sklar定理）: 任意の同時CDF F(x,y) は、周辺CDF F₁(x), F₂(y) とコピュラ関数 C(u,v) を用いて F(x,y) = C(F₁(x), F₂(y)) と分解できます。散布図はこのC(u,v)を直接可視化したものです。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>左下・右上の四隅に赤い点が集中 → テール依存性: 極端な値動きが同時に起きやすい</li>
          <li>均一に分布 → 独立（ガウシアンコピュラに近い）</li>
          <li>特定の象限に偏り → 非対称なテール依存性</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 相互情報量 (MI) vs ACF²</p>
        <p>相互情報量 I(X;Y) = ΣΣ p(x,y) log(p(x,y)/(p(x)p(y))) は、2つの確率変数間の「あらゆる種類の依存性」を測定します。ACF²(k) = ρ²(k) は線形依存のみを測定します。</p>
        <p>MI ≫ ACF² の場合、線形相関では捉えられない非線形依存が存在することを意味します。例えば、r[t]の符号はr[t-1]に依存しないが、|r[t]|が|r[t-1]|に依存する場合（ボラティリティクラスタリング）、ACFはゼロでもMIは正の値を取ります。</p>
        <p>非線形依存の割合 = max(0, 1 - ΣACF²/ΣMI) で、全依存性のうち非線形成分が占める割合を推定します。</p>

        <p className="font-medium text-gray-700 mt-3">4. 散布図行列</p>
        <p>複数の変数ペアについて散布図を並べて表示し、線形相関係数ρと合わせて依存関係を多角的に分析します。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>r[t-1] vs r[t]: 自己相関の視覚化。V字型やU字型のパターンは非線形依存を示す</li>
          <li>|r[t-1]| vs r[t]: ボラティリティとリターン方向の関係</li>
          <li>|r[t-1]| vs |r[t]|: ボラティリティの持続性（ボラクラスタリング）</li>
          <li>出来高変化 vs r[t]: 出来高とリターンの同時関係</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">実務への示唆</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>非線形依存が大きい → 線形予測モデル（AR, ARMA）では不十分。ニューラルネット等の非線形モデルや、ボラティリティ条件付きの戦略を検討</li>
          <li>テール依存性が高い → 極端な値動きの後のポジション管理が重要。ストップロスの設定を厳格に</li>
          <li>ラグ散布図がX字型 → ストラドル戦略（方向は不明だが大きな変動を予測）が有効な可能性</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
