"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries, SERIES_MODE_LABELS } from "../../lib/series-mode";
import { acf, confidenceBound } from "../../lib/autocorrelation";
import { ljungBoxTest, rollingACF1 } from "../../lib/distribution-extended";
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

function drawACFBars(
  canvas: HTMLCanvasElement,
  data: { lag: number; value: number }[],
  bound: number,
  title: string
) {
  const r = initCanvas(canvas, 180); if (!r) return;
  const { ctx, width, height } = r;
  const margin = { top: 20, right: 10, bottom: 20, left: 40 };
  const pw = width - margin.left - margin.right;
  const ph = height - margin.top - margin.bottom;

  const plotData = data.filter(d => d.lag > 0);
  if (plotData.length === 0) return;
  const maxLag = plotData[plotData.length - 1].lag;
  const maxVal = Math.max(1, ...plotData.map(d => Math.abs(d.value)));
  const barW = Math.max(2, pw / maxLag - 2);
  const toX = (lag: number) => margin.left + (lag / maxLag) * pw;
  const toY = (v: number) => margin.top + ph / 2 - (v / maxVal) * (ph / 2);

  ctx.fillStyle = "rgba(59, 130, 246, 0.1)";
  ctx.fillRect(margin.left, toY(bound), pw, toY(-bound) - toY(bound));
  ctx.strokeStyle = "rgba(59, 130, 246, 0.4)"; ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(margin.left, toY(bound)); ctx.lineTo(width - margin.right, toY(bound));
  ctx.moveTo(margin.left, toY(-bound)); ctx.lineTo(width - margin.right, toY(-bound));
  ctx.stroke(); ctx.setLineDash([]);

  ctx.strokeStyle = "#999"; ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(margin.left, toY(0)); ctx.lineTo(width - margin.right, toY(0)); ctx.stroke();

  for (const d of plotData) {
    const x = toX(d.lag) - barW / 2;
    const y0 = toY(0), y1 = toY(d.value);
    ctx.fillStyle = Math.abs(d.value) > bound ? "#ef4444" : "#3b82f6";
    ctx.fillRect(x, Math.min(y0, y1), barW, Math.abs(y1 - y0));
  }

  ctx.fillStyle = "#333"; ctx.font = "bold 11px sans-serif";
  ctx.fillText(title, margin.left + 5, margin.top - 5);
  ctx.font = "10px sans-serif"; ctx.fillStyle = "#999";
  ctx.fillText("Lag", width / 2 - 10, height - 3);
}

export default function ACFExtendedChart({ prices, seriesMode }: Props) {
  const absAcfRef = useRef<HTMLCanvasElement>(null);
  const rollingRef = useRef<HTMLCanvasElement>(null);

  const { values: lr, times } = extractSeries(prices, seriesMode);
  const lrAbs = lr.map(r => Math.abs(r));

  const absAcfData = useMemo(() => acf(lrAbs, 30), [prices, seriesMode]);
  const bound = confidenceBound(lr.length);

  // Ljung-Box検定
  const lb10 = useMemo(() => ljungBoxTest(lr, 10), [prices, seriesMode]);
  const lb20 = useMemo(() => ljungBoxTest(lr, 20), [prices, seriesMode]);
  const lbSq10 = useMemo(() => ljungBoxTest(lr.map(r => r * r), 10), [prices, seriesMode]);
  const lbAbs10 = useMemo(() => ljungBoxTest(lrAbs, 10), [prices, seriesMode]);

  // ローリングACF(1)
  const rollingData = useMemo(() => rollingACF1(lr, times, 60), [prices, seriesMode]);

  const modeLabel = SERIES_MODE_LABELS[seriesMode];

  // 絶対リターンACF
  useEffect(() => {
    if (absAcfRef.current) drawACFBars(absAcfRef.current, absAcfData, bound, `ACF (|${modeLabel}|)`);
  }, [absAcfData, bound, modeLabel]);

  // ローリングACF(1)
  useEffect(() => {
    if (!rollingRef.current || rollingData.length < 2) return;
    const r = initCanvas(rollingRef.current, 200); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 15, bottom: 25, left: 50, right: 15 };
    const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;
    const n = rollingData.length;

    let minV = Infinity, maxV = -Infinity;
    for (const d of rollingData) { minV = Math.min(minV, d.acf1); maxV = Math.max(maxV, d.acf1); }
    const range = Math.max(maxV - minV, 0.01);
    const toX = (i: number) => pad.left + (i / (n - 1)) * pw;
    const toY = (v: number) => pad.top + ph * (1 - (v - minV) / range);

    // ゼロライン
    if (minV <= 0 && maxV >= 0) {
      ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad.left, toY(0)); ctx.lineTo(width - pad.right, toY(0)); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Y軸
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const v = minV + (range * i) / 4;
      const y = toY(v);
      ctx.fillText(v.toFixed(3), pad.left - 5, y + 3);
      ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }

    // ACF(1)ライン
    ctx.strokeStyle = "#8b5cf6"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = toX(i), y = toY(rollingData[i].acf1);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 信頼区間
    const cb = confidenceBound(60);
    ctx.strokeStyle = "rgba(59, 130, 246, 0.3)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    const yUp = toY(cb), yDown = toY(-cb);
    ctx.beginPath(); ctx.moveTo(pad.left, yUp); ctx.lineTo(width - pad.right, yUp); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad.left, yDown); ctx.lineTo(width - pad.right, yDown); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("ローリングACF(1) (60日窓)", pad.left + 5, pad.top - 2);
  }, [rollingData]);

  const sigAbsACF = absAcfData.filter(d => d.lag > 0 && Math.abs(d.value) > bound);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">自己相関分析 (拡張)</h3>

      {/* Ljung-Box検定結果 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Ljung-Box (リターン, L=10)</div>
          <div className="font-mono font-medium">Q={lb10.Q.toFixed(2)}</div>
          <div className={`${lb10.pValue < 0.05 ? "text-red-500" : "text-green-500"}`}>
            p={lb10.pValue.toFixed(4)} {lb10.pValue < 0.05 ? "有意" : "非有意"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Ljung-Box (リターン, L=20)</div>
          <div className="font-mono font-medium">Q={lb20.Q.toFixed(2)}</div>
          <div className={`${lb20.pValue < 0.05 ? "text-red-500" : "text-green-500"}`}>
            p={lb20.pValue.toFixed(4)} {lb20.pValue < 0.05 ? "有意" : "非有意"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Ljung-Box (r², L=10)</div>
          <div className="font-mono font-medium">Q={lbSq10.Q.toFixed(2)}</div>
          <div className={`${lbSq10.pValue < 0.05 ? "text-orange-600 font-medium" : "text-green-500"}`}>
            p={lbSq10.pValue.toFixed(4)} {lbSq10.pValue < 0.05 ? "ボラクラスタ有意" : "非有意"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Ljung-Box (|r|, L=10)</div>
          <div className="font-mono font-medium">Q={lbAbs10.Q.toFixed(2)}</div>
          <div className={`${lbAbs10.pValue < 0.05 ? "text-orange-600 font-medium" : "text-green-500"}`}>
            p={lbAbs10.pValue.toFixed(4)} {lbAbs10.pValue < 0.05 ? "長期記憶有意" : "非有意"}
          </div>
        </div>
      </div>

      {/* 絶対リターンACF */}
      <div>
        <div className="text-xs text-gray-500 mb-1">絶対リターン |r| の自己相関 (Taylor効果・ボラティリティ長期記憶)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={absAcfRef} /></div>
        <div className="mt-1 text-xs text-gray-500">
          有意なラグ: {sigAbsACF.length > 0 ? sigAbsACF.map(d => `Lag${d.lag}`).join(", ") : "なし"}
        </div>
      </div>

      {/* ローリングACF(1) */}
      {rollingData.length > 0 && (
        <div>
          <div className="text-xs text-gray-500 mb-1">ローリングACF(1) — 自己相関の時変性 (破線=95%信頼区間)</div>
          <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={rollingRef} /></div>
        </div>
      )}

      <AnalysisGuide title="拡張自己相関分析の詳細理論">
        <p className="font-medium text-gray-700">1. Ljung-Box検定</p>
        <p>Ljung-Box統計量 Q(L) = n(n+2) Σₖ₌₁ᴸ ρ̂²(k)/(n-k) は、「ラグ1からLまでの自己相関がすべてゼロ」という帰無仮説を一括で検定します。個別のACFバーが信頼区間内であっても、弱い相関が多数のラグに分散して存在する場合、Ljung-Box検定が検出します。Q(L)は自由度Lのχ²分布に漸近的に従います。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>リターンのQ(10)が有意 → 短期の線形予測可能性が存在する</li>
          <li>r²のQ(10)が有意 → ARCH効果（ボラティリティクラスタリング）が存在。GARCH型モデルが有効</li>
          <li>|r|のQ(10)が有意 → ボラティリティの長期記憶性。FIGARCH等のモデルを検討</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">2. 絶対リターンのACF (Taylor効果)</p>
        <p>Taylor (1986) が発見した「|rₜ|のACFはrₜ²のACFより遅く減衰する」現象をTaylor効果と呼びます。理論的に、rₜ²のACFは4次モーメント（尖度）の影響を受けるのに対し、|rₜ|のACFは2次モーメントのみに依存するため、ファットテールによる外れ値の影響を受けにくく、ボラティリティの持続性をより頑健に推定できます。</p>
        <p>ACF(|rₜ|) の減衰が非常に遅い（数十ラグ以上で有意）場合、ボラティリティに長期記憶性（long memory）があることを示します。この場合、Hurst指数 H &gt; 0.5 やFIGARCHモデルとの整合性を確認してください。</p>

        <p className="font-medium text-gray-700 mt-3">3. ローリングACF(1)</p>
        <p>ρ̂₁(t) = Corr(rₜ, rₜ₋₁) を窓幅60日で計算し、自己相関の時変性を可視化します。これにより以下を検出できます:</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ACF(1) &gt; 0 が持続 → モメンタム効果（トレンド追従が有効）</li>
          <li>ACF(1) &lt; 0 が持続 → ミーンリバージョン（逆張りが有効）</li>
          <li>ACF(1) の急変 → 市場の微細構造（流動性や取引行動）の変化</li>
          <li>ACF(1) が時期によって正負を行き来 → レジーム変化の存在</li>
        </ul>
        <p>低流動性の銘柄ではACF(1) &gt; 0 になりやすく（Bid-Askバウンス効果が弱いため）、高流動性の銘柄ではACF(1) ≈ 0 またはわずかに負（Bid-Askバウンス）になる傾向があります。</p>
      </AnalysisGuide>
    </div>
  );
}
