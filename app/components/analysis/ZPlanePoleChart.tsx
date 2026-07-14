"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { logReturns } from "../../lib/transforms";
import { fitARPoles, selectARByAic, ARFit } from "../../lib/z-plane";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function ZPlanePoleChart({ prices, seriesMode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [auto, setAuto] = useState(true);
  const [order, setOrder] = useState(8);

  // AR は定常系列に当てはめる。水準系列(close/open)は対数リターン化。
  const { values } = extractSeries(prices, seriesMode);
  const needsTransform = seriesMode === "close" || seriesMode === "open";
  const series = useMemo(
    () => (needsTransform ? logReturns(values) : values),
    [prices, seriesMode]
  );

  const fit: ARFit = useMemo(
    () => (auto ? selectARByAic(series, 20) : fitARPoles(series, order)),
    [series, auto, order]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const size = Math.min(parent.clientWidth, 420);
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

    const pad = 36;
    const plot = size - pad * 2;
    const cx = pad + plot / 2;
    const cy = pad + plot / 2;
    // 単位円半径 = plot/2 の 0.82。|z|>1 の極もはみ出さず描けるよう余白を残す。
    const R = (plot / 2) * 0.82;
    const X = (re: number) => cx + re * R;
    const Y = (im: number) => cy - im * R;

    // 軸
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, cy);
    ctx.lineTo(size - pad, cy);
    ctx.moveTo(cx, pad);
    ctx.lineTo(cx, size - pad);
    ctx.stroke();

    // 内側ガイド円 |z|=0.5
    ctx.strokeStyle = "#f1f5f9";
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.5, 0, 2 * Math.PI);
    ctx.stroke();

    // 単位円（定常/非定常の境界）
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("|z|=1", X(0) + R * 0.72, Y(0) - R * 0.72);

    // 極を × で描画（単位円に近いほど赤く）
    for (const p of fit.poles) {
      const t = Math.min(1, p.modulus); // 0(中心)→1(単位円)
      const r = Math.round(59 + t * 180);
      const g = Math.round(130 - t * 110);
      const b = Math.round(246 - t * 210);
      ctx.strokeStyle = `rgb(${r},${g},${b})`;
      ctx.lineWidth = 2;
      const px = X(p.re);
      const py = Y(p.im);
      const s = 5;
      ctx.beginPath();
      ctx.moveTo(px - s, py - s);
      ctx.lineTo(px + s, py + s);
      ctx.moveTo(px - s, py + s);
      ctx.lineTo(px + s, py - s);
      ctx.stroke();
    }

    // 軸ラベル
    ctx.fillStyle = "#6b7280";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("Re z", size - pad, cy - 6);
    ctx.textAlign = "left";
    ctx.fillText("Im z", cx + 6, pad + 4);
  }, [fit]);

  const cyclic = useMemo(
    () => fit.poles.filter((p) => Math.abs(p.im) > 1e-4 && p.im > 0),
    [fit]
  );

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        z平面ポールマップ (AR極の複素配置)
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        AR(p)モデルの特性根を複素z平面に描き、持続性(単位円への近さ)と周期(偏角)を幾何学的に読む
      </p>

      {/* 次数コントロール */}
      <div className="flex flex-wrap items-center gap-3 mb-3 text-xs text-gray-600">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />
          AR次数を自動選択 (AIC)
        </label>
        {!auto && (
          <label className="flex items-center gap-2">
            次数 p = {order}
            <input
              type="range"
              min={1}
              max={20}
              value={order}
              onChange={(e) => setOrder(Number(e.target.value))}
              className="w-40"
            />
          </label>
        )}
        {auto && (
          <span className="text-gray-400">選択次数 p = {fit.order}</span>
        )}
      </div>

      {/* 統計カード */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <StatCard
          label="定常性"
          value={fit.stationary ? "定常" : "非定常"}
          sub={fit.stationary ? "全極が単位円内" : "単位円外の極あり"}
        />
        <StatCard
          label="卓越極 |z|"
          value={fit.dominant ? fit.dominant.modulus.toFixed(3) : "—"}
          sub={
            fit.dominant && fit.dominant.modulus > 0.9
              ? "長期記憶・トレンド的"
              : "速い減衰"
          }
        />
        <StatCard
          label="卓越極 半減期"
          value={
            fit.dominant && isFinite(fit.dominant.halfLife)
              ? `${fit.dominant.halfLife.toFixed(1)} 日`
              : "∞"
          }
        />
        <StatCard label="共役極(サイクル)" value={`${cyclic.length} 組`} />
      </div>

      {/* z平面 Canvas + 極テーブル */}
      <div className="flex flex-col lg:flex-row gap-4 items-start">
        <div>
          <canvas ref={canvasRef} className="rounded border border-gray-100" />
          <div className="text-xs text-gray-400 mt-1">
            破線=単位円(定常境界), ×=極, 色=単位円への近さ(青→赤), 横=実部, 縦=虚部
          </div>
        </div>
        <div className="flex-1 min-w-0 w-full">
          <div className="overflow-x-auto">
            <table className="text-xs w-full border-collapse">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 pr-2">#</th>
                  <th className="text-right py-1 px-2">|z|</th>
                  <th className="text-right py-1 px-2">偏角°</th>
                  <th className="text-right py-1 px-2">周期(日)</th>
                  <th className="text-right py-1 pl-2">半減期(日)</th>
                </tr>
              </thead>
              <tbody>
                {fit.poles.map((p, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    <td className="py-1 pr-2 text-gray-400">{i + 1}</td>
                    <td className="text-right py-1 px-2 font-medium text-gray-800">
                      {p.modulus.toFixed(3)}
                    </td>
                    <td className="text-right py-1 px-2 text-gray-600">
                      {p.angleDeg.toFixed(0)}
                    </td>
                    <td className="text-right py-1 px-2 text-gray-600">
                      {isFinite(p.period) ? p.period.toFixed(1) : "∞"}
                    </td>
                    <td className="text-right py-1 pl-2 text-gray-600">
                      {isFinite(p.halfLife) ? p.halfLife.toFixed(1) : "∞"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="p-2 bg-gray-50 rounded text-xs text-gray-600 mt-2">
            単位円<strong>近傍(|z|→1)</strong>の極ほど記憶が長く相場を支配。実軸上の極は
            トレンド的持続、<strong>共役対</strong>は周期<code>2π/θ</code>の減衰サイクルを表す。
          </div>
        </div>
      </div>

      <AnalysisGuide title="z平面ポールマップの詳細理論">
        <p className="font-medium text-gray-700">1. z変換とz平面とは</p>
        <p>
          時系列 x_t の<strong>z変換</strong>は {"X(z) = Σ x_t·z^{-t}"} で定義され、
          離散時間版のラプラス変換にあたります。z は複素数なので、系の性質を
          複素平面(<strong>z平面</strong>)上で幾何学的に読めます。とくに時系列に
          自己回帰モデル AR(p) を当てはめると、その「伝達関数」の分母がゼロになる点
          ＝<strong>極(pole)</strong>の位置が、系の持続性と周期を決めます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式(AR極の導出)</p>
        <p className="mt-1">
          AR(p): {"x_t = φ₁x_{t-1} + φ₂x_{t-2} + … + φ_p x_{t-p} + e_t"}。
          {"ラグ演算子 L(Lx_t=x_{t-1})で書くと (1 − φ₁L − … − φ_p L^p)x_t = e_t"}。
          特性方程式 {"z^p − φ₁z^{p-1} − … − φ_p = 0"} の根が極です。係数 φ は
          <strong>Yule-Walker方程式</strong>(自己共分散 γ_k を用いた {"γ_k = Σ φ_j γ_{k-j}"})を
          <strong>Levinson-Durbin再帰</strong>で解いて推定し、根は<strong>Durand-Kerner法</strong>で数値的に求めます。
        </p>
        <p className="mt-1">
          各極 z = r·e^{"{iθ}"} について、絶対値 <strong>r=|z|</strong> が持続性、偏角 θ が周期を与えます:{" "}
          {"周期 = 2π/|θ| [日]"}、{"半減期 = ln(0.5)/ln r [日]"}。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 直感的な例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            極 = ブランコの「揺れの芯」。芯が単位円の<strong>縁ぎりぎり(|z|→1)</strong>にあると、
            一度押した揺れがなかなか止まらない(記憶が長い)。中心(|z|→0)に近いほどすぐ減衰する。
          </li>
          <li>
            極の<strong>角度</strong>=揺れの速さ。実軸上(角度0°)ならゆっくり一方向、
            角度が大きいほど速い周期振動。上下の<strong>共役ペア</strong>が1つのサイクルを作る。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>|z|が単位円に近い極</strong>: 長期記憶・トレンド持続。半減期が長い。</li>
          <li><strong>|z|≥1(単位円の外)</strong>: 非定常(単位根・爆発的)。水準系列そのものはたいてい単位根を持つため、リターン化して見る。</li>
          <li><strong>複素共役対で単位円近傍</strong>: その周期(2π/θ)の減衰サイクルが強い。表の「周期」列がその銘柄の卓越周期候補。</li>
          <li><strong>負の実極(角度≈180°)</strong>: 周期2の交互変動＝短期のミーンリバージョン(反転)。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>卓越極の<strong>半減期</strong>は、ショックの影響が薄れるまでの日数の目安。トレンドフォローの保有期間やミーンリバージョンのエントリー窓の設計に使える。</li>
          <li>単位円近傍の<strong>共役対の周期</strong>は、カレンダー/サイクル戦略の周期選定(何日周期で回すか)の裏付けになる。</li>
          <li>負の実極が支配的なら短期反転(逆張り)が効きやすく、正の実極が支配的なら順張りが効きやすい。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ARは線形モデル。ボラティリティクラスタリングなど非線形構造は極に現れない(別途GARCH等が必要)。</li>
          <li>次数pを上げすぎると過剰適合で単位円付近に偽の極が並ぶ。AIC自動選択か、複数次数での頑健性確認を推奨。</li>
          <li>Yule-Walker推定は標本自己共分散に基づくため、標本が短い/外れ値が多いと極が不安定になる。</li>
          <li>推定した極は記述的な要約であり、将来の周期・持続の継続を保証しない。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="p-2 bg-gray-50 rounded text-xs">
      <div className="text-gray-500">{label}</div>
      <div className="font-bold text-gray-800">{value}</div>
      {sub && <div className="text-gray-400">{sub}</div>}
    </div>
  );
}
