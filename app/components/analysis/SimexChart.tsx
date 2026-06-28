"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { simexReversal } from "../../lib/simex";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
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

export default function SimexChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const res = useMemo(() => simexReversal(prices), [prices]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !res) return;
    const setup = initCanvas(canvas, 280);
    if (!setup) return;
    const { ctx, width, height } = setup;
    const padL = 50,
      padR = 16,
      padT = 16,
      padB = 34;
    const x0 = padL,
      x1 = width - padR,
      y0 = height - padB,
      y1 = padT;

    const zMin = -1,
      zMax = 2;
    const thetas = [
      ...res.curve.map((p) => p.theta),
      res.correctedSlope,
    ];
    let tMin = Math.min(...thetas);
    let tMax = Math.max(...thetas);
    const pad = (tMax - tMin) * 0.2 || 0.01;
    tMin -= pad;
    tMax += pad;

    const sx = (z: number) => x0 + ((z - zMin) / (zMax - zMin)) * (x1 - x0);
    const sy = (t: number) => y0 + ((t - tMin) / (tMax - tMin)) * (y1 - y0);

    // 軸
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y1);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x1, y0);
    ctx.stroke();

    // y=0 線
    if (tMin < 0 && tMax > 0) {
      ctx.strokeStyle = "#e5e7eb";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x0, sy(0));
      ctx.lineTo(x1, sy(0));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ζ=0 縦線(観測)
    ctx.strokeStyle = "#e5e7eb";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(sx(0), y1);
    ctx.lineTo(sx(0), y0);
    ctx.stroke();
    ctx.setLineDash([]);

    // フィット曲線 θ=a+bζ+cζ²
    const { a, b, c } = res.fit;
    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 100; i++) {
      const z = zMin + ((zMax - zMin) * i) / 100;
      const t = a + b * z + c * z * z;
      const px = sx(z),
        py = sy(t);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // 外挿区間(ζ<0)を破線で強調
    ctx.strokeStyle = "#a78bfa";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    for (let i = 0; i <= 50; i++) {
      const z = zMin + ((0 - zMin) * i) / 50;
      const t = a + b * z + c * z * z;
      const px = sx(z),
        py = sy(t);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // データ点(シミュレーション)
    for (const p of res.curve) {
      ctx.fillStyle = "#6366f1";
      ctx.beginPath();
      ctx.arc(sx(p.zeta), sy(p.theta), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // 補正点 ζ=−1
    ctx.fillStyle = "#dc2626";
    ctx.beginPath();
    ctx.arc(sx(-1), sy(res.correctedSlope), 6, 0, Math.PI * 2);
    ctx.fill();
    // 観測点 ζ=0
    ctx.fillStyle = "#111827";
    ctx.beginPath();
    ctx.arc(sx(0), sy(res.naiveSlope), 5, 0, Math.PI * 2);
    ctx.fill();

    // ラベル
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (const z of [-1, 0, 1, 2]) {
      ctx.fillText(`ζ=${z}`, sx(z), y0 + 14);
    }
    ctx.textAlign = "right";
    ctx.fillText(tMax.toFixed(3), x0 - 4, y1 + 8);
    ctx.fillText(tMin.toFixed(3), x0 - 4, y0);
    ctx.fillStyle = "#dc2626";
    ctx.textAlign = "left";
    ctx.fillText("補正(ノイズ0)", sx(-1) + 8, sy(res.correctedSlope) - 6);
    ctx.fillStyle = "#111827";
    ctx.fillText("観測", sx(0) + 8, sy(res.naiveSlope) + 14);
  }, [res]);

  if (prices.length < 120) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">
        SIMEXノイズ補正（縮んだ平均回帰/モメンタムの強さを回復）
      </h3>

      {res && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className="p-2 rounded border border-gray-300 bg-gray-50">
            <div className="text-gray-500">観測係数 θ(0)</div>
            <div className="font-mono font-medium text-base">
              {res.naiveSlope.toFixed(4)}
            </div>
            <div className="text-[10px] text-gray-400">ノイズで縮小</div>
          </div>
          <div className="p-2 rounded border border-red-200 bg-red-50">
            <div className="text-gray-500">補正係数 θ(−1)</div>
            <div className="font-mono font-medium text-base text-red-700">
              {res.correctedSlope.toFixed(4)}
            </div>
            <div className="text-[10px] text-gray-400">
              {res.reverting ? "平均回帰" : "モメンタム"}
            </div>
          </div>
          <div className="p-2 rounded border border-amber-200 bg-amber-50">
            <div className="text-gray-500">補正による増幅</div>
            <div className="font-mono font-medium text-base text-amber-700">
              +{res.attenuationPct.toFixed(0)}%
            </div>
            <div className="text-[10px] text-gray-400">|補正|/|観測|−1</div>
          </div>
          <div className="p-2 rounded border border-gray-200 bg-gray-50">
            <div className="text-gray-500">ノイズ割合 / σ</div>
            <div className="font-mono font-medium">
              {(res.noiseShare * 100).toFixed(0)}% / {res.sigmaUPct.toFixed(2)}%
            </div>
            <div className="text-[10px] text-gray-400">戻り値分散に占める</div>
          </div>
        </div>
      )}

      <canvas ref={canvasRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="SIMEXノイズ補正の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {
            "『今日のリターンから翌日のリターンを予測する係数θ』を測りたいが、価格にはノイズが乗っており、説明変数(今日のリターン)が不正確なためθは0方向に縮む。SIMEXは“わざとノイズをさらに足すと係数がどう縮むか”を実測し、その劣化曲線を『ノイズが負＝ノイズ0未満』の地点まで外挿して、本来の係数を復元する。"
          }
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 数式・手順</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"対象: r(t+1)=α+θ·r(t)+ε。θ<0=平均回帰、θ>0=モメンタム。"}</li>
          <li>
            {
              "ノイズ分散の推定: 戻り値の−1次自己共分散から σ_u²=max(0,−γ₁)(Roll法)。価格ノイズが戻り値に乗る分散は 2σ_u²。"
            }
          </li>
          <li>
            {
              "ζ=0,0.5,1,1.5,2 について、説明変数に分散 ζ·2σ_u² のノイズを加えてθを再推定し、多数回平均 → θ(ζ)。ζが増えるほどθは縮む。"
            }
          </li>
          <li>{"θ(ζ)=a+bζ+cζ² を最小二乗フィットし、ζ=−1(ノイズ0)へ外挿: θ補正=a−b+c。"}</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>ζ(ゼータ)</strong>
            : 追加ノイズの倍率。ζ=1で“元と同じだけ”ノイズを足す。ζ=−1が“元のノイズを差し引いた=ノイズ0”の仮想地点。
          </li>
          <li>
            例え: 老眼の度合いを変えて視力検査し、『度を弱めるほど見える』関係から“度0(裸眼の真の視力)”を逆算するようなもの。
          </li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            補正係数が<strong>はっきり負</strong>
            なら、見かけより強い<strong>平均回帰</strong>＝短期逆張り(下げたら買い)の優位性が大きい。
          </li>
          <li>
            補正係数が<strong>はっきり正</strong>
            なら<strong>モメンタム</strong>＝順張り(続伸に乗る)が有利。
          </li>
          <li>
            『増幅%』が大きい銘柄ほどノイズに埋もれた優位性が大きい。観測値だけで“エッジ無し”と切り捨てない。
          </li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            外挿(ζ&lt;0)は曲線形の仮定(2次)に依存する。点が直線的なら過大補正に注意。
          </li>
          <li>
            σ_u²の推定はRollモデルのMA(1)仮定に基づく。γ₁が正(ノイズより自己相関が勝つ)の銘柄では σ_u²=0 となり補正は効かない。
          </li>
          <li>
            これは線形1次の予測係数。非線形・条件付きの優位性は別途(条件付き分析・CCM等)で確認する。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
