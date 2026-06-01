"use client";

import { useEffect, useRef, useMemo, useCallback } from "react";
import { PricePoint } from "../../lib/types";
import { computePropagator } from "../../lib/propagator";
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

/** 確率値を青紫系カラーにマッピング */
function densityColor(value: number, maxVal: number): string {
  if (maxVal === 0) return "rgba(255,255,255,0)";
  const t = Math.min(value / maxVal, 1);
  if (t < 0.01) return "rgba(255,255,255,0)";
  // white -> light blue -> blue -> deep purple
  const r = Math.round(255 - t * 200);
  const g = Math.round(255 - t * 230);
  const b = Math.round(255 - t * 50);
  const a = 0.15 + t * 0.85;
  return `rgba(${r},${g},${b},${a})`;
}

export default function PropagatorChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const result = useMemo(() => computePropagator(prices), [prices]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || result.bins.length === 0) return;

    const setup = initCanvas(canvas, 420);
    if (!setup) return;
    const { ctx, width, height } = setup;

    const margin = { left: 60, right: 20, top: 30, bottom: 40 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    const { horizons, bins, heatmap, percentiles } = result;
    const nH = horizons.length;
    const nB = bins.length;

    // 最大確率密度
    let maxDensity = 0;
    for (const row of heatmap) {
      for (const v of row) {
        if (v > maxDensity) maxDensity = v;
      }
    }

    const binMin = bins[0] - (bins[1] - bins[0]) / 2;
    const binMax = bins[nB - 1] + (bins[1] - bins[0]) / 2;
    const binRange = binMax - binMin;

    const colW = plotW / nH;
    const toY = (val: number) =>
      margin.top + plotH - ((val - binMin) / binRange) * plotH;

    // ヒートマップ描画
    const cellH = plotH / nB;
    for (let h = 0; h < nH; h++) {
      const x = margin.left + h * colW;
      for (let b = 0; b < nB; b++) {
        const y = margin.top + plotH - (b + 1) * cellH;
        ctx.fillStyle = densityColor(heatmap[h][b], maxDensity);
        ctx.fillRect(x, y, colW, cellH + 1);
      }
    }

    // グリッド線
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    // 0% ライン
    const zeroY = toY(0);
    if (zeroY > margin.top && zeroY < margin.top + plotH) {
      ctx.strokeStyle = "#9ca3af";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(margin.left, zeroY);
      ctx.lineTo(margin.left + plotW, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#6b7280";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText("0%", margin.left - 5, zeroY + 3);
    }

    // パーセンタイルコーンライン
    const pLines: {
      key: keyof typeof percentiles;
      color: string;
      dash: number[];
      lw: number;
    }[] = [
      { key: "p5", color: "#ef4444", dash: [3, 3], lw: 1 },
      { key: "p25", color: "#f97316", dash: [5, 3], lw: 1.2 },
      { key: "p50", color: "#10b981", dash: [], lw: 2 },
      { key: "p75", color: "#f97316", dash: [5, 3], lw: 1.2 },
      { key: "p95", color: "#ef4444", dash: [3, 3], lw: 1 },
    ];

    for (const pl of pLines) {
      const vals = percentiles[pl.key];
      ctx.strokeStyle = pl.color;
      ctx.lineWidth = pl.lw;
      ctx.setLineDash(pl.dash);
      ctx.beginPath();
      for (let h = 0; h < nH; h++) {
        const x = margin.left + (h + 0.5) * colW;
        const y = toY(vals[h]);
        if (h === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // ラベル（右端）
      const lastVal = vals[nH - 1];
      const labelY = toY(lastVal);
      ctx.fillStyle = pl.color;
      ctx.font = "9px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(pl.key.toUpperCase(), margin.left + plotW + 2, labelY + 3);
    }

    // X軸ラベル
    ctx.fillStyle = "#374151";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    for (let h = 0; h < nH; h++) {
      const x = margin.left + (h + 0.5) * colW;
      ctx.fillText(`${horizons[h]}日`, x, height - margin.bottom + 18);
    }
    ctx.fillText("予測期間", margin.left + plotW / 2, height - 5);

    // Y軸ラベル（変化率%のティック）
    ctx.textAlign = "right";
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#6b7280";
    const yStep = binRange > 40 ? 10 : binRange > 20 ? 5 : binRange > 10 ? 2 : 1;
    const yStart = Math.ceil(binMin / yStep) * yStep;
    for (let v = yStart; v <= binMax; v += yStep) {
      const y = toY(v);
      if (y < margin.top || y > margin.top + plotH) continue;
      ctx.fillText(`${v > 0 ? "+" : ""}${v.toFixed(0)}%`, margin.left - 5, y + 3);
      ctx.strokeStyle = "#f3f4f6";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotW, y);
      ctx.stroke();
    }

    // タイトル
    ctx.fillStyle = "#111827";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("価格伝播関数（遷移確率密度ヒートマップ）", margin.left, margin.top - 10);

    // 凡例
    const legX = margin.left + plotW - 200;
    const legY = margin.top + 8;
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#10b981";
    ctx.fillText("── 中央値 (P50)", legX, legY);
    ctx.fillStyle = "#f97316";
    ctx.fillText("- - P25/P75", legX + 90, legY);
    ctx.fillStyle = "#ef4444";
    ctx.fillText("··· P5/P95", legX + 150, legY);
  }, [result]);

  useEffect(() => {
    draw();
    const handleResize = () => draw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [draw]);

  if (result.bins.length === 0) {
    return (
      <div className="text-xs text-gray-400 py-4">
        データが不足しています（30日以上必要）
      </div>
    );
  }

  const { horizons, percentiles, lastPrice } = result;

  return (
    <div>
      {/* サマリーカード */}
      <div className="grid grid-cols-5 gap-2 mb-3">
        {horizons.map((h, i) => {
          const med = percentiles.p50[i];
          const p5 = percentiles.p5[i];
          const p95 = percentiles.p95[i];
          return (
            <div
              key={h}
              className="bg-white border border-gray-200 rounded-lg p-2 text-center"
            >
              <div className="text-[10px] text-gray-500">{h}日後</div>
              <div
                className={`text-sm font-bold ${
                  med >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                {med >= 0 ? "+" : ""}
                {med.toFixed(2)}%
              </div>
              <div className="text-[9px] text-gray-400">
                {p5.toFixed(1)}% ~ {p95 >= 0 ? "+" : ""}
                {p95.toFixed(1)}%
              </div>
              <div className="text-[9px] text-gray-400 mt-0.5">
                {lastPrice > 0
                  ? `${(lastPrice * (1 + med / 100)).toFixed(0)}円`
                  : ""}
              </div>
            </div>
          );
        })}
      </div>

      {/* ヒートマップ */}
      <div className="w-full">
        <canvas ref={canvasRef} />
      </div>

      {/* AnalysisGuide */}
      <AnalysisGuide title="価格伝播関数（プロパゲータ）の詳細理論">
        <p className="font-medium text-gray-700">1. 価格伝播関数とは</p>
        <p>
          価格伝播関数（Price
          Propagator）は、現在の価格を起点として、将来N日後に価格がどの水準に到達する確率が高いかを
          ヒストリカルデータから推定する手法です。物理学の量子力学における「伝播関数（propagator）」に
          着想を得ており、価格の遷移確率密度を可視化します。これにより、将来の価格分布がどのように
          広がっていくか（拡散の形状）を直感的に把握できます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          {"N日間の変化率: r(t, N) = (P(t+N) - P(t)) / P(t) * 100 [%]"}
        </p>
        <p>
          {"遷移確率密度: f(r | N) = (1/M) * Σ δ(r - r_i(N))"}
        </p>
        <p>
          {"ここで M はサンプル数、δ はビンへの振り分けを表す。"}
          {"ヒストリカルデータの全起点 t から N日後の変化率を計算し、ヒストグラムに集計して正規化したものが遷移確率密度 f(r|N) となります。"}
        </p>
        <p>
          {"パーセンタイル p_q: ソートした変化率の q% 点。例えば P50 は中央値（メディアン）。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>遷移確率密度</strong>:
            ある状態（現在価格）から別の状態（将来価格）へ移る確率の密度関数
          </li>
          <li>
            <strong>ホライゾン（horizon）</strong>:
            予測対象の将来日数（5日、10日、20日、40日、60日）
          </li>
          <li>
            <strong>パーセンタイルコーン</strong>:
            各ホライゾンでの変化率のパーセンタイル（P5, P25, P50, P75,
            P95）を結んだ線。確率的な「コーン（円錐）」を形成する
          </li>
          <li>
            <strong>ビン</strong>:
            変化率を区切る小区間。ヒストグラムの各棒に相当
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          川の流れに例えると、現在地点から流した多数の浮きが、時間経過とともにどのように広がり散らばるかを
          観察するようなものです。短い時間（5日）では浮きは狭い範囲に集中しますが、長い時間（60日）では
          上流にも下流にも広がります。ヒートマップの色が濃い場所ほど「浮きが集まりやすい場所」、つまり
          価格が到達しやすい水準です。パーセンタイルラインは「浮きの90%がこの範囲内に収まる」という
          境界線を示しています。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            ヒートマップの色が濃い領域: その変化率に到達する確率が高い
          </li>
          <li>
            P50（緑線）が0%より上: 過去の傾向として上昇バイアスがある
          </li>
          <li>
            P5-P95の幅が広い: 将来の価格変動の不確実性が大きい
          </li>
          <li>
            分布が非対称（上寄り/下寄り）: リターンに歪み（スキュー）がある
          </li>
          <li>
            サマリーカードの中央値: 各期間での期待的な変化率の目安
          </li>
          <li>
            サマリーカードの範囲: P5〜P95は90%信頼区間に相当
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">
          6. 投資判断への活用
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            目標株価の設定: P75やP90を利益確定の目安に、P25やP10を損切りの目安に使う
          </li>
          <li>
            保有期間の決定: ホライゾン別の中央値を比較し、最も効率的なリターンが見込める期間を選択
          </li>
          <li>
            リスク管理: P5の値からワーストケースシナリオを把握し、ポジションサイズを調整
          </li>
          <li>
            オプション取引: 確率分布の形状からインプライドボラティリティとの乖離を確認
          </li>
          <li>
            非対称性の活用: 上方リターンの確率が高い（正のスキュー）銘柄を選好する戦略
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            過去の分布が将来も続く保証はない（非定常性）。市場の構造変化やレジーム転換が起きると分布が大きく変わる
          </li>
          <li>
            データ数が少ないホライゾン（60日等）はサンプル不足により推定精度が低下する
          </li>
          <li>
            テールリスク（極端な暴落・暴騰）はヒストリカルデータに十分含まれていない可能性がある
          </li>
          <li>
            変化率の分布は正規分布とは限らない（裾が厚い、非対称等）。正規分布を前提とした分析と結果が異なることがある
          </li>
          <li>
            この分析はヒストリカルシミュレーションに基づく経験的分布であり、理論モデルによる予測ではない
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
