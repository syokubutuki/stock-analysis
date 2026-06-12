"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode } from "../../lib/series-mode";
import { computePeriodicPhaseAttractor } from "../../lib/weekly-phase-attractor";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

const PERIODS = [
  { value: 5, label: "週内 (5)" },
  { value: 21, label: "月内 (21)" },
  { value: 63, label: "四半期内 (63)" },
];

// 位相 → 色相 (環状)
function phaseColor(phase: number, period: number, alpha = 1): string {
  const hue = (phase / period) * 360;
  return `hsla(${hue}, 70%, 50%, ${alpha})`;
}

export default function PeriodicPhaseAttractorChart({ prices, seriesMode }: Props) {
  const [tau, setTau] = useState(2);
  const [dim, setDim] = useState<2 | 3>(2);
  const [period, setPeriod] = useState(21);
  const [seed, setSeed] = useState(0);

  const scatterRef = useRef<HTMLCanvasElement>(null);

  const result = useMemo(
    () => computePeriodicPhaseAttractor(prices, seriesMode, { tau, dim, period }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prices, seriesMode, tau, dim, period, seed]
  );

  const significant = result.ok && result.PL > result.surrogateQ95;

  useEffect(() => {
    const canvas = scatterRef.current;
    if (!canvas || !result.ok) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = Math.min(parent.clientWidth - 16, 560);
    const height = 360;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const margin = 40;
    const xs = result.points.map((p) => p.x);
    const ys = result.points.map((p) => p.y);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const xr = xMax - xMin || 1, yr = yMax - yMin || 1;
    const sx = (x: number) => margin + ((x - xMin) / xr) * (width - margin * 2);
    const sy = (y: number) => height - margin - ((y - yMin) / yr) * (height - margin * 2);

    ctx.strokeStyle = "#e5e7eb";
    ctx.strokeRect(margin, margin, width - margin * 2, height - margin * 2);
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    ctx.fillText("r(t)", width - margin - 24, height - margin + 14);
    ctx.save();
    ctx.translate(margin - 14, margin + 24);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`r(t-${tau})`, 0, 0);
    ctx.restore();

    for (const p of result.points) {
      ctx.fillStyle = phaseColor(p.phase, result.period, 0.4);
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.y), 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // 重心巡回パス
    const present = result.centroids2d
      .map((c, k) => ({ c, k }))
      .filter((o) => !isNaN(o.c.x));
    if (present.length >= 2) {
      ctx.strokeStyle = "#374151";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      present.forEach((o, idx) => {
        const px = sx(o.c.x), py = sy(o.c.y);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.lineTo(sx(present[0].c.x), sy(present[0].c.y));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const o of present) {
      const px = sx(o.c.x), py = sy(o.c.y);
      ctx.fillStyle = phaseColor(o.k, result.period, 1);
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px monospace";
    ctx.fillText(`n=${result.n}  period=${result.period}  τ=${tau}`, margin + 4, margin + 12);
  }, [result, tau]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">一般周期 位相アトラクタ (月内・四半期内)</h3>
      <p className="text-xs text-gray-500 mb-3">
        週内(5)の枠組みを月内(21)・四半期内(63)へ一般化。位相 = 埋め込み点インデックス mod 周期(営業日位相)
      </p>

      <div className="flex flex-wrap gap-4 mb-3 items-end text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">周期</span>
          <div className="flex gap-1">
            {PERIODS.map((p) => (
              <button key={p.value} onClick={() => setPeriod(p.value)}
                className={`px-3 py-1 rounded text-xs font-medium ${period === p.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                {p.label}
              </button>
            ))}
          </div>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">遅延 {"τ"} = {tau}</span>
          <input type="range" min={1} max={10} value={tau}
            onChange={(e) => setTau(Number(e.target.value))} className="w-28 accent-blue-600" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">次元</span>
          <div className="flex gap-1">
            {([2, 3] as const).map((d) => (
              <button key={d} onClick={() => setDim(d)}
                className={`px-3 py-1 rounded text-xs font-medium ${dim === d ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                {d}D
              </button>
            ))}
          </div>
        </label>
        <button onClick={() => setSeed((s) => s + 1)}
          className="px-2 py-1 rounded text-xs text-gray-500 bg-gray-100 hover:bg-gray-200">
          サロゲート再抽選
        </button>
      </div>

      {!result.ok ? (
        <div className="text-sm text-gray-500 py-8 text-center">{result.message ?? "計算できませんでした"}</div>
      ) : (
        <>
          <div className={`mb-3 rounded border p-3 text-sm ${significant ? "bg-red-50 border-red-200" : "bg-gray-50 border-gray-200"}`}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
              <span className={`font-bold ${significant ? "text-red-700" : "text-gray-600"}`}>
                {significant ? `周期${result.period}の位相ロック: 有意` : `周期${result.period}の位相ロック: 非有意`}
              </span>
              <span className="text-gray-600">PL = <b>{result.PL.toFixed(3)}</b></span>
              <span className="text-gray-600">95%閾値 = {result.surrogateQ95.toFixed(3)}</span>
              <span className="text-gray-600">p値 = <b>{result.pValue.toFixed(4)}</b></span>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {significant
                ? `${result.period}営業日周期で軌道が位相空間の特定領域を巡回。月内/四半期内の決定論的サイクルの兆候。`
                : "観測F比がサロゲート範囲内。この周期での位相ロックの証拠は乏しい。"}
            </p>
          </div>

          <div className="flex justify-center">
            <canvas ref={scatterRef} className="rounded border border-gray-200" />
          </div>
          <div className="mt-2 flex items-center justify-center gap-2 text-xs text-gray-500">
            <span>位相0</span>
            <div className="w-32 h-2 rounded" style={{ background: "linear-gradient(to right, hsl(0,70%,50%), hsl(120,70%,50%), hsl(240,70%,50%), hsl(359,70%,50%))" }} />
            <span>位相{result.period - 1}</span>
            <span className="text-gray-400">(大きい点=位相重心 / 破線=巡回パス)</span>
          </div>

          <AnalysisGuide title="一般周期 位相アトラクタの詳細理論">
            <p className="font-medium text-gray-700">1. 何を検証しているか</p>
            <p>
              週内位相アトラクタ(周期5)と同じ枠組みを、月内(21営業日)・四半期内(63営業日)に一般化したものです。
              軌道が周期Tの位相に同期したリミットサイクルの骨格を持つかを、位相ロック統計量PLとサロゲート検定で判定します。
              ターン・オブ・ザ・マンス効果(月末月初の特異性)などの動力学版に相当します。
            </p>

            <p className="font-medium text-gray-700 mt-3">2. 数式</p>
            <p>{"位相 φ(t) = (埋め込み点インデックス) mod T   (T=周期)"}</p>
            <p>{"PL = [S_between/(T−1)] / [S_within/(N−T)]  (位相空間版 一元配置分散分析のF比)"}</p>
            <p>サロゲート(位相ラベルシャッフル)の95%を超え、p値&lt;0.05なら有意。</p>

            <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><b>営業日位相</b>: 暦月でなく、連続営業日インデックスを周期Tで割った余り。可変長の暦月を扱わずに済む近似。</li>
              <li><b>位相重心</b>: 同一位相の埋め込みベクトルの平均位置。重心が環状に巡れば周期サイクルの骨格。</li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
            <p>週内が「1週間のリズム」なら、月内は「給料日や月末決済のリズム」、四半期内は「決算サイクルのリズム」。同じ顕微鏡で倍率(周期)を変えて見るイメージ。</p>

            <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>同色(同位相)が固まり重心が環状に巡れば、その周期のサイクル構造。</li>
              <li>観測PLが95%閾値の右(p&lt;0.05)で有意。一様な雲なら構造なし。</li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>月内サイクルが有意なら、月内の特定タイミングでのリスク調整・リバランス時期の最適化。</li>
              <li>四半期内サイクルは決算アノマリーの動力学的裏付けとして利用。</li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>周期Tが大きいほど各位相の点数(N/T)が減り、統計的に苦しくなる(四半期=63は特に)。</li>
              <li>営業日位相は暦月の可変長を無視した近似。月末効果の厳密検証には暦ベースの位相が必要。</li>
              <li>非定常性・多重検定の注意は週内版と同じ。サロゲートp値を必ず確認。</li>
            </ul>
          </AnalysisGuide>
        </>
      )}
    </div>
  );
}
