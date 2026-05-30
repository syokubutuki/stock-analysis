"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { normalPDF } from "../../lib/distribution";
import {
  empiricalCDF, kde, fitTDistribution, tPDF,
  analyzeTails, ppPlot, ksTest, adTest,
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

function pctFmt(v: number, d = 4): string { return (v * 100).toFixed(d) + "%"; }

export default function DistributionShapeChart({ prices, seriesMode }: Props) {
  const cdfRef = useRef<HTMLCanvasElement>(null);
  const logHistRef = useRef<HTMLCanvasElement>(null);
  const kdeRef = useRef<HTMLCanvasElement>(null);
  const ppRef = useRef<HTMLCanvasElement>(null);
  const tailRef = useRef<HTMLCanvasElement>(null);

  const { values: lr } = extractSeries(prices, seriesMode);

  const cdfData = useMemo(() => empiricalCDF(lr), [prices, seriesMode]);
  const kdeData = useMemo(() => kde(lr, 200), [prices, seriesMode]);
  const tFit = useMemo(() => fitTDistribution(lr), [prices, seriesMode]);
  const tails = useMemo(() => analyzeTails(lr), [prices, seriesMode]);
  const pp = useMemo(() => ppPlot(lr), [prices, seriesMode]);
  const ks = useMemo(() => ksTest(lr), [prices, seriesMode]);
  const ad = useMemo(() => adTest(lr), [prices, seriesMode]);

  const m = useMemo(() => lr.length ? lr.reduce((a, b) => a + b, 0) / lr.length : 0, [prices, seriesMode]);
  const s = useMemo(() => {
    if (lr.length < 2) return 0;
    const v = lr.reduce((a, x) => a + (x - m) ** 2, 0) / lr.length;
    return Math.sqrt(v);
  }, [lr, m]);

  // 1. CDF比較プロット
  useEffect(() => {
    if (!cdfRef.current || cdfData.length < 2) return;
    const r = initCanvas(cdfRef.current, 220); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 15, bottom: 30, left: 50, right: 15 };
    const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;

    const minX = cdfData[0].x, maxX = cdfData[cdfData.length - 1].x;
    const rangeX = maxX - minX || 1;
    const toX = (v: number) => pad.left + ((v - minX) / rangeX) * pw;
    const toY = (v: number) => pad.top + ph * (1 - v);

    // グリッド
    ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = toY(i / 4);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
      ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText((i * 25).toString() + "%", pad.left - 5, y + 3);
    }

    // 正規CDF (青破線)
    ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 3]);
    ctx.beginPath();
    for (let i = 0; i < cdfData.length; i++) {
      const x = toX(cdfData[i].x), y = toY(cdfData[i].normal);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]);

    // 経験的CDF (赤)
    ctx.strokeStyle = "#dc2626"; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < cdfData.length; i++) {
      const x = toX(cdfData[i].x), y = toY(cdfData[i].empirical);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // KS最大乖離位置
    const ksIdx = cdfData.reduce((best, d, i) =>
      Math.abs(d.empirical - d.normal) > Math.abs(cdfData[best].empirical - cdfData[best].normal) ? i : best, 0);
    const ksPt = cdfData[ksIdx];
    ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(toX(ksPt.x), toY(ksPt.empirical));
    ctx.lineTo(toX(ksPt.x), toY(ksPt.normal));
    ctx.stroke();

    // 凡例
    ctx.font = "9px sans-serif";
    const legends = [
      { color: "#dc2626", label: "経験的CDF", dash: false },
      { color: "#2563eb", label: "正規CDF", dash: true },
      { color: "#f59e0b", label: `KS D=${ks.D.toFixed(4)}`, dash: false },
    ];
    let lx = pad.left;
    for (const lg of legends) {
      ctx.fillStyle = lg.color; ctx.fillRect(lx, height - 12, 12, 3);
      ctx.fillStyle = "#666"; ctx.fillText(lg.label, lx + 15, height - 7);
      lx += ctx.measureText(lg.label).width + 25;
    }
  }, [cdfData, ks]);

  // 2. 対数スケールヒストグラム
  useEffect(() => {
    if (!logHistRef.current || lr.length < 10) return;
    const r = initCanvas(logHistRef.current, 220); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 15, bottom: 30, left: 50, right: 15 };
    const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;

    const bins = 60;
    const min = Math.min(...lr), max = Math.max(...lr);
    const range = max - min || 1;
    const binW = range / bins;
    const counts = new Array(bins).fill(0);
    for (const v of lr) {
      const idx = Math.min(Math.floor((v - min) / binW), bins - 1);
      counts[idx]++;
    }
    const densities = counts.map(c => c / (lr.length * binW));
    const logDensities = densities.map(d => d > 0 ? Math.log10(d) : -10);
    const normalDensities: number[] = [];
    for (let i = 0; i < bins; i++) {
      const x = min + (i + 0.5) * binW;
      const nd = normalPDF(x, m, s);
      normalDensities.push(nd > 0 ? Math.log10(nd) : -10);
    }

    const allLog = [...logDensities, ...normalDensities].filter(v => v > -10);
    const logMin = Math.min(...allLog, -5);
    const logMax = Math.max(...allLog, 0) + 0.2;
    const logRange = logMax - logMin || 1;

    const toX = (i: number) => pad.left + ((i + 0.5) / bins) * pw;
    const toY = (v: number) => pad.top + ph * (1 - (v - logMin) / logRange);
    const barWidth = Math.max(2, pw / bins - 1);

    // ヒストグラム (対数スケール)
    for (let i = 0; i < bins; i++) {
      if (densities[i] <= 0) continue;
      const x = toX(i) - barWidth / 2;
      const y = toY(logDensities[i]);
      const y0 = toY(logMin);
      const center = min + (i + 0.5) * binW;
      ctx.fillStyle = center >= 0 ? "rgba(38, 166, 154, 0.5)" : "rgba(239, 83, 80, 0.5)";
      ctx.fillRect(x, y, barWidth, y0 - y);
    }

    // 正規分布 (対数スケール)
    ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < bins; i++) {
      if (normalDensities[i] <= -10) continue;
      const x = toX(i), y = toY(normalDensities[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Y軸ラベル
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let v = Math.ceil(logMin); v <= Math.floor(logMax); v++) {
      const y = toY(v);
      ctx.fillText(`10^${v}`, pad.left - 5, y + 3);
      ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }

    ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("リターン (対数密度スケール)", width / 2, height - 5);
  }, [lr, m, s]);

  // 3. KDE + t分布
  useEffect(() => {
    if (!kdeRef.current || kdeData.length < 2) return;
    const r = initCanvas(kdeRef.current, 220); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 15, bottom: 30, left: 50, right: 15 };
    const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;

    const maxDensity = Math.max(
      ...kdeData.map(d => d.density),
      normalPDF(m, m, s),
      tPDF(tFit.mu, tFit.nu, tFit.mu, tFit.sigma)
    ) * 1.1;
    const minX = kdeData[0].x, maxX = kdeData[kdeData.length - 1].x;
    const rangeX = maxX - minX || 1;

    const toX = (v: number) => pad.left + ((v - minX) / rangeX) * pw;
    const toY = (v: number) => pad.top + ph * (1 - v / maxDensity);

    // KDE (黒、太)
    ctx.strokeStyle = "#111"; ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < kdeData.length; i++) {
      const x = toX(kdeData[i].x), y = toY(kdeData[i].density);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 正規分布 (青破線)
    ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 3]);
    ctx.beginPath();
    for (let i = 0; i < kdeData.length; i++) {
      const x = toX(kdeData[i].x);
      const y = toY(normalPDF(kdeData[i].x, m, s));
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]);

    // t分布 (赤)
    ctx.strokeStyle = "#dc2626"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < kdeData.length; i++) {
      const x = toX(kdeData[i].x);
      const y = toY(tPDF(kdeData[i].x, tFit.nu, tFit.mu, tFit.sigma));
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 凡例
    ctx.font = "9px sans-serif";
    const legends = [
      { color: "#111", label: "KDE (データ)", lw: 2.5 },
      { color: "#2563eb", label: "正規分布", lw: 1.5 },
      { color: "#dc2626", label: `t分布 (ν=${tFit.nu.toFixed(1)})`, lw: 1.5 },
    ];
    let lx = pad.left;
    for (const lg of legends) {
      ctx.strokeStyle = lg.color; ctx.lineWidth = lg.lw;
      ctx.beginPath(); ctx.moveTo(lx, height - 10); ctx.lineTo(lx + 12, height - 10); ctx.stroke();
      ctx.fillStyle = "#666"; ctx.fillText(lg.label, lx + 15, height - 7);
      lx += ctx.measureText(lg.label).width + 30;
    }
  }, [kdeData, m, s, tFit]);

  // 17. PPプロット
  useEffect(() => {
    if (!ppRef.current || pp.length < 5) return;
    const r = initCanvas(ppRef.current, 220); if (!r) return;
    const { ctx, width, height } = r;
    const size = Math.min(width, height);
    const margin = 35;
    const ps = size - 2 * margin;

    // 45度線
    ctx.strokeStyle = "#dc2626"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(margin, size - margin); ctx.lineTo(margin + ps, margin); ctx.stroke();
    ctx.setLineDash([]);

    // 点
    ctx.fillStyle = "rgba(37, 99, 235, 0.4)";
    for (const p of pp) {
      const x = margin + p.theoretical * ps;
      const y = size - margin - p.empirical * ps;
      ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill();
    }

    ctx.fillStyle = "#666"; ctx.font = "10px sans-serif";
    ctx.textAlign = "center"; ctx.fillText("理論確率 (正規)", size / 2, size - 5);
    ctx.save(); ctx.translate(10, size / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText("経験確率", -20, 0); ctx.restore();
  }, [pp]);

  // 6. テール分析チャート
  useEffect(() => {
    if (!tailRef.current || lr.length < 20) return;
    const r = initCanvas(tailRef.current, 180); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 15, bottom: 25, left: 50, right: 15 };
    const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;

    // 上下テールのヒストグラムを重ねて表示
    const upperVals = lr.filter(v => v > 0);
    const lowerVals = lr.filter(v => v < 0).map(v => -v); // 絶対値に変換

    const drawTailHist = (vals: number[], color: string, label: string, offsetY: number) => {
      if (vals.length < 3) return;
      const bins = 25;
      const max = Math.max(...vals);
      const binW = max / bins;
      if (binW <= 0) return;
      const counts = new Array(bins).fill(0);
      for (const v of vals) {
        const idx = Math.min(Math.floor(v / binW), bins - 1);
        counts[idx]++;
      }
      const maxCount = Math.max(...counts, 1);
      const halfH = ph / 2 - 5;

      for (let i = 0; i < bins; i++) {
        const x = pad.left + (i / bins) * pw;
        const barW = Math.max(2, pw / bins - 1);
        const barH = (counts[i] / maxCount) * halfH;
        ctx.fillStyle = color;
        ctx.fillRect(x, offsetY + halfH - barH, barW, barH);
      }

      ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(`${label} (n=${vals.length})`, pad.left + 5, offsetY + 12);
    };

    drawTailHist(upperVals, "rgba(34, 197, 94, 0.5)", "上側テール (正のリターン)", pad.top);
    drawTailHist(lowerVals, "rgba(239, 83, 80, 0.5)", "下側テール (|負のリターン|)", pad.top + ph / 2 + 5);

    // 中央の区切り線
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + ph / 2);
    ctx.lineTo(width - pad.right, pad.top + ph / 2);
    ctx.stroke();
  }, [lr]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">分布形状の詳細分析</h3>

      {/* 統計検定結果 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">KS検定 D値</div>
          <div className="font-mono font-medium">{ks.D.toFixed(4)}</div>
          <div className={`text-gray-400 ${ks.pValue < 0.05 ? "text-red-500" : "text-green-500"}`}>
            p={ks.pValue.toFixed(4)} {ks.pValue < 0.05 ? "棄却" : "不棄却"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">AD検定 A²*</div>
          <div className="font-mono font-medium">{ad.A2star.toFixed(4)}</div>
          <div className={`text-gray-400 ${ad.pValue < 0.05 ? "text-red-500" : "text-green-500"}`}>
            p={ad.pValue.toFixed(4)} {ad.pValue < 0.05 ? "棄却" : "不棄却"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">t分布 自由度ν</div>
          <div className={`font-mono font-medium ${tFit.nu < 5 ? "text-red-600" : tFit.nu < 10 ? "text-orange-600" : ""}`}>
            {tFit.nu.toFixed(1)}
          </div>
          <div className="text-gray-400">{tFit.nu < 5 ? "非常に重いテール" : tFit.nu < 10 ? "やや重いテール" : "軽いテール"}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">上側テール &gt;1%</div>
          <div className="font-mono font-medium text-green-600">{pctFmt(tails.upper.exceedance1pct, 2)}</div>
          <div className="text-gray-400">&gt;2%: {pctFmt(tails.upper.exceedance2pct, 2)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">下側テール &lt;-1%</div>
          <div className="font-mono font-medium text-red-600">{pctFmt(tails.lower.exceedance1pct, 2)}</div>
          <div className="text-gray-400">&lt;-2%: {pctFmt(tails.lower.exceedance2pct, 2)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">テール非対称性</div>
          <div className="font-mono font-medium">
            {tails.upper.n > 0 && tails.lower.n > 0
              ? (tails.upper.n / tails.lower.n).toFixed(2)
              : "-"}
          </div>
          <div className="text-gray-400">上側N/下側N比</div>
        </div>
      </div>

      {/* CDF比較 */}
      <div>
        <div className="text-xs text-gray-500 mb-1">経験的CDF vs 正規CDF (黄色=KS最大乖離点)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={cdfRef} /></div>
      </div>

      {/* KDE + t分布 + 正規分布 */}
      <div>
        <div className="text-xs text-gray-500 mb-1">カーネル密度推定 (KDE) vs 正規分布 vs t分布フィット</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={kdeRef} /></div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 対数スケールヒストグラム */}
        <div>
          <div className="text-xs text-gray-500 mb-1">対数スケール密度 (テール部分の拡大)</div>
          <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={logHistRef} /></div>
        </div>
        {/* PPプロット */}
        <div>
          <div className="text-xs text-gray-500 mb-1">P-Pプロット (確率-確率プロット)</div>
          <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={ppRef} /></div>
        </div>
      </div>

      {/* テール分析 */}
      <div>
        <div className="text-xs text-gray-500 mb-1">上側/下側テール個別分析</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={tailRef} /></div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="p-2 bg-green-50 rounded">
          <div className="text-gray-500">上側テール (正のリターン)</div>
          <div className="font-mono">N={tails.upper.n}, 平均={pctFmt(tails.upper.mean)}, 最大={pctFmt(tails.upper.max)}</div>
        </div>
        <div className="p-2 bg-red-50 rounded">
          <div className="text-gray-500">下側テール (負のリターン)</div>
          <div className="font-mono">N={tails.lower.n}, 平均={pctFmt(tails.lower.mean)}, 最小={pctFmt(tails.lower.max)}</div>
        </div>
      </div>

      <AnalysisGuide title="分布形状分析の詳細理論">
        <p className="font-medium text-gray-700">1. 経験的CDF比較</p>
        <p>経験的累積分布関数 F̂ₙ(x) = (1/n)Σᵢ I(Xᵢ ≤ x) と、同じ平均μ・標準偏差σを持つ正規分布の理論CDF Φ((x-μ)/σ) を重ねて表示します。Glivenko-Cantelliの定理により、F̂ₙ(x) は n→∞ で真のCDFに一様収束します。ヒストグラムと異なりビン幅の選択に依存しないため、分布全体の乖離を偏りなく評価できます。</p>

        <p className="font-medium text-gray-700 mt-3">2. 対数スケールヒストグラム</p>
        <p>密度を対数軸(log₁₀)で表示することで、±3σ以遠のテール部分を拡大して可視化します。正規分布のテールは放物線 log f(x) ∝ -x²/2 として表れますが、ファットテールを持つ分布では直線的 log f(x) ∝ -α|x| (指数的減衰) や緩やかな減衰 log f(x) ∝ -β log|x| (べき乗則) として現れます。この違いにより、テールの「重さ」を視覚的に判別できます。</p>

        <p className="font-medium text-gray-700 mt-3">3. カーネル密度推定 (KDE)</p>
        <p>KDEはノンパラメトリックな密度推定法です: f̂(x) = (1/nh) Σᵢ K((x-Xᵢ)/h)。ここでK(·)はガウスカーネル、hはバンド幅です。バンド幅の選択にはSilvermanの経験則 h = 1.06σn⁻¹/⁵ を使用しています。ヒストグラムのビン幅依存性を排除し、分布の多峰性（複数の体制が混在していることを示唆）を検出できます。</p>

        <p className="font-medium text-gray-700 mt-3">4. t分布フィッティング</p>
        <p>Studentのt分布 f(x;ν,μ,σ) = Γ((ν+1)/2)/(σ√(νπ)Γ(ν/2)) × (1 + ((x-μ)/σ)²/ν)^(-(ν+1)/2) を最尤法でフィットします。自由度νが小さいほどテールが重くなります。ν→∞で正規分布に収束します。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ν &lt; 3: 分散が発散。極めて重いテール</li>
          <li>ν = 3~5: 非常に重いテール。尖度が有限だが大きい</li>
          <li>ν = 5~10: 中程度のテール。多くの株式リターンがこの範囲</li>
          <li>ν &gt; 30: ほぼ正規分布と同等</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 上側/下側テール個別分析</p>
        <p>正のリターン（上側テール）と負のリターン（下側テール）を|z|&gt;1σの閾値で分離し、それぞれの出現頻度・条件付き期待値・最大値を比較します。一般に株式市場では下側テールが上側テールより重い（負の歪度）傾向があり、暴落リスクが上昇リスクより大きいことを示します。</p>

        <p className="font-medium text-gray-700 mt-3">6. P-Pプロット</p>
        <p>各データ点について、理論CDF値 Φ((xᵢ-μ)/σ) を横軸、経験CDF値 i/(n+1) を縦軸にプロットします。Q-Qプロットがテールの適合度に敏感であるのに対し、P-Pプロットは分布の中央部の適合度に敏感です。両方を見ることで、分布のどの部分で乖離が生じているかを完全に把握できます。</p>

        <p className="font-medium text-gray-700 mt-3">7. Kolmogorov-Smirnov検定</p>
        <p>KS統計量 D = sup_x |F̂ₙ(x) - F₀(x)| は経験CDFと理論CDFの最大乖離です。帰無仮説H₀:「データは正規分布に従う」のもとで、√n × D の分布（Kolmogorov分布）からp値を計算します。JB検定が歪度・尖度のみを用いるのに対し、KS検定はCDF全体の形状を評価します。</p>

        <p className="font-medium text-gray-700 mt-3">8. Anderson-Darling検定</p>
        <p>{"AD統計量 A² = -n - (1/n) Σᵢ (2i-1)[ln Φ(zᵢ) + ln(1-Φ(z_{n+1-i}))] は、KS検定の重み付きバージョンです。テール部分に大きな重みを与えるため、金融データのファットテール検出においてKS検定より検出力が高くなります。修正統計量 A²* = A²(1 + 0.75/n + 2.25/n²) は有限サンプル補正を施したものです。"}</p>

        <p className="font-medium text-gray-700 mt-3">実務への示唆</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>3つの検定（JB, KS, AD）をすべて棄却 → 正規分布の仮定は不適切。VaR計算にはt分布やヒストリカルシミュレーションを使用すべき</li>
          <li>t分布のν &lt; 5 → ポジションサイズを通常の半分以下に抑えることを検討</li>
          <li>テール非対称性が大きい → プットオプションの買いなど非対称なヘッジが有効</li>
          <li>KDEが多峰的 → レジーム分析（HMM等）で複数の状態を識別すべき</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
