"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computePathIntegral } from "../../lib/path-integral";
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

export default function PathIntegralChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const result = useMemo(() => computePathIntegral(prices), [prices]);

  useEffect(() => {
    const draw = () => {
      if (!canvasRef.current || result.paths.length === 0) return;
      const H = 420;
      const init = initCanvas(canvasRef.current, H);
      if (!init) return;
      const { ctx, width, height } = init;
      const ml = 60,
        mr = 30,
        mt = 30,
        mb = 35;
      const plotW = width - ml - mr,
        plotH = height - mt - mb;

      const { bands, displayPaths, horizon } = result;

      // Determine Y range from P5-P95 bands
      const allVals = [...bands.p5, ...bands.p95];
      const minV = Math.min(...allVals);
      const maxV = Math.max(...allVals);
      const rangeV = maxV - minV || 0.01;
      const pad = rangeV * 0.05;
      const yMin = minV - pad;
      const yMax = maxV + pad;
      const yRange = yMax - yMin;

      const xFrom = (i: number) => ml + (i / horizon) * plotW;
      const yFrom = (v: number) => mt + plotH - ((v - yMin) / yRange) * plotH;

      // Draw simulation paths (very faint)
      for (let pi = 0; pi < displayPaths.length; pi++) {
        ctx.strokeStyle = "rgba(59,130,246,0.05)";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        const path = displayPaths[pi];
        for (let i = 0; i <= horizon && i < path.length; i++) {
          const x = xFrom(i),
            y = yFrom(path[i]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Confidence bands
      const drawBand = (
        upper: number[],
        lower: number[],
        color: string
      ) => {
        ctx.beginPath();
        for (let i = 0; i <= horizon; i++) ctx.lineTo(xFrom(i), yFrom(upper[i]));
        for (let i = horizon; i >= 0; i--) ctx.lineTo(xFrom(i), yFrom(lower[i]));
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };

      // P5-P95 band (very light blue)
      drawBand(bands.p95, bands.p5, "rgba(59,130,246,0.08)");
      // P25-P75 band (light blue)
      drawBand(bands.p75, bands.p25, "rgba(59,130,246,0.18)");

      // Percentile lines
      const drawLine = (
        vals: number[],
        color: string,
        lw: number,
        dash?: number[]
      ) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        if (dash) ctx.setLineDash(dash);
        ctx.beginPath();
        for (let i = 0; i <= horizon; i++) {
          const x = xFrom(i),
            y = yFrom(vals[i]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        if (dash) ctx.setLineDash([]);
      };

      drawLine(bands.p5, "#ef4444", 1, [4, 4]);
      drawLine(bands.p25, "#f59e0b", 1, [3, 3]);
      drawLine(bands.p50, "#1d4ed8", 2.5);
      drawLine(bands.p75, "#f59e0b", 1, [3, 3]);
      drawLine(bands.p95, "#ef4444", 1, [4, 4]);

      // Zero line
      const y0 = yFrom(0);
      if (y0 >= mt && y0 <= mt + plotH) {
        ctx.strokeStyle = "#374151";
        ctx.lineWidth = 0.8;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(ml, y0);
        ctx.lineTo(width - mr, y0);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Grid lines (horizontal)
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 0.5;
      const nGridY = 6;
      for (let i = 0; i <= nGridY; i++) {
        const y = mt + (plotH * i) / nGridY;
        ctx.beginPath();
        ctx.moveTo(ml, y);
        ctx.lineTo(width - mr, y);
        ctx.stroke();
        const val = yMax - (yRange * i) / nGridY;
        ctx.fillStyle = "#9ca3af";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "right";
        ctx.fillText((val * 100).toFixed(1) + "%", ml - 4, y + 3);
      }

      // X-axis labels
      ctx.fillStyle = "#6b7280";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "center";
      const xStep = Math.max(1, Math.floor(horizon / 6));
      for (let d = 0; d <= horizon; d += xStep) {
        ctx.fillText(`${d}`, xFrom(d), height - mb + 14);
      }
      ctx.fillText("日後", xFrom(horizon) + 16, height - mb + 14);

      // Right-side labels for percentiles
      ctx.font = "9px sans-serif";
      ctx.textAlign = "left";
      const lx = width - mr + 3;
      ctx.fillStyle = "#ef4444";
      ctx.fillText("P95", lx, yFrom(bands.p95[horizon]) + 3);
      ctx.fillStyle = "#f59e0b";
      ctx.fillText("P75", lx, yFrom(bands.p75[horizon]) + 3);
      ctx.fillStyle = "#1d4ed8";
      ctx.fillText("P50", lx, yFrom(bands.p50[horizon]) + 3);
      ctx.fillStyle = "#f59e0b";
      ctx.fillText("P25", lx, yFrom(bands.p25[horizon]) + 3);
      ctx.fillStyle = "#ef4444";
      ctx.fillText("P5", lx, yFrom(bands.p5[horizon]) + 3);

      // Plot border
      ctx.strokeStyle = "#d1d5db";
      ctx.lineWidth = 1;
      ctx.strokeRect(ml, mt, plotW, plotH);

      // Title
      ctx.fillStyle = "#374151";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(
        `経路積分シミュレーション (${horizon}日, ${result.paths.length}パス, GARCH Bootstrap)`,
        ml,
        mt - 10
      );
    };

    draw();

    const handleResize = () => draw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [result]);

  if (result.paths.length === 0) return null;

  const { finalStats } = result;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">
        経路積分 (GARCH Bootstrap Monte Carlo)
      </h3>
      <div className="relative">
        <canvas ref={canvasRef} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded border">
          <div className="text-gray-500">上昇確率</div>
          <div
            className={`font-mono font-bold ${
              finalStats.upProb >= 0.5 ? "text-green-600" : "text-red-600"
            }`}
          >
            {(finalStats.upProb * 100).toFixed(1)}%
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded border">
          <div className="text-gray-500">期待リターン</div>
          <div
            className={`font-mono font-bold ${
              finalStats.mean >= 0 ? "text-green-600" : "text-red-600"
            }`}
          >
            {(finalStats.mean * 100).toFixed(2)}%
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded border">
          <div className="text-gray-500">標準偏差</div>
          <div className="font-mono font-bold text-gray-700">
            {(finalStats.std * 100).toFixed(2)}%
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded border">
          <div className="text-gray-500">歪度</div>
          <div
            className={`font-mono font-bold ${
              finalStats.skew < 0 ? "text-red-600" : "text-green-600"
            }`}
          >
            {finalStats.skew.toFixed(3)}
          </div>
        </div>
      </div>

      <AnalysisGuide title="経路積分シミュレーションの詳細理論">
        <p className="font-medium text-gray-700">1. 経路積分とは</p>
        <p>
          量子力学の経路積分（パス・インテグラル）では、粒子がA地点からB地点に到達する確率を、
          あらゆる可能な経路の寄与を足し合わせて計算します。本分析ではこの考え方を金融市場に応用し、
          株価が現在値から将来のあらゆる水準に到達する可能性を、多数のシミュレーション経路を生成して
          評価します。通常のモンテカルロとの違いは、ボラティリティの時間変動（クラスタリング）を
          GARCHモデルで捉えた上で経路を生成する点にあります。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式とアルゴリズム</p>
        <p>
          {"GARCH(1,1)モデル: σ²_t = ω + α(r_{t-1} - μ)² + βσ²_{t-1}"}
        </p>
        <p>
          {"ここで ω = (1 - α - β)σ²_uncond, α = 0.1, β = 0.85 としています。"}
        </p>
        <p>
          {"標準化残差: ε_t = (r_t - μ) / σ_t"}
        </p>
        <p>
          {"シミュレーション: 標準化残差集合 {ε_t} からランダムに復元抽出し、"}
          {"r*_t = μ + ε* × √(σ²_t) として合成リターンを生成。"}
          {"同時に σ²_t もGARCH式で更新することで、ボラティリティクラスタリングを再現します。"}
        </p>
        <p>
          {"累積対数リターン: S_T = Σ_{t=1}^{T} r*_t"}
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>GARCH</strong>:
            Generalized Autoregressive Conditional Heteroskedasticity。
            ボラティリティが過去のショックと過去のボラティリティに依存するモデル。
          </li>
          <li>
            <strong>ブートストラップ</strong>:
            実データから復元抽出する統計手法。分布仮定を置かずに実際の歪度・尖度を反映。
          </li>
          <li>
            <strong>ファンチャート</strong>:
            扇のように広がる信頼区間の可視化。将来の不確実性が時間とともに増大する様子を表現。
          </li>
          <li>
            <strong>経路積分</strong>:
            量子物理学由来の概念。ファインマンが提唱した「全経路の重み付き和」で確率を求める手法。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          通常のモンテカルロが「サイコロを何回も振ってランダムウォークさせる」のに対し、
          GARCH経路積分は「前回大きく振れたら次も大きく振れやすいサイコロ」を使うようなものです。
          嵐の日（高ボラティリティ期）の後はしばらく荒れやすく、穏やかな日（低ボラティリティ期）の
          後は穏やかが続きやすい。この「天気のような持続性」をシミュレーションに組み込んでいます。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            薄い青帯 (P5-P95): 90%の確率でこの範囲に収まる。帯が広いほど不確実性が高い。
          </li>
          <li>
            濃い青帯 (P25-P75): 50%の確率でこの範囲。最もありそうな値動きの範囲。
          </li>
          <li>
            中央の太い青線 (P50): 中央値パス。最も代表的なシナリオ。
          </li>
          <li>
            半透明のパス群: 個別シミュレーション経路。経路の密度が高い領域ほど到達確率が高い。
          </li>
          <li>
            上昇確率: 最終日のリターンが正となるパスの割合。50%を超えれば上昇バイアス。
          </li>
          <li>
            歪度が負なら下方リスクが大きく、正なら上方ポテンシャルが大きい。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            ポジションサイジング: P5の最悪シナリオから許容可能な損失額を逆算し、適切なポジション量を決定。
          </li>
          <li>
            利確・損切り水準: P25やP75を参考に現実的な利確・損切りラインを設定。
          </li>
          <li>
            リスク対リターン評価: 期待リターンと標準偏差の比率でリスク調整後リターンを評価。
          </li>
          <li>
            ファンの広がり速度: 短期間で急速に広がる場合、現在の市場は高ボラティリティ状態。
          </li>
          <li>
            非対称性の確認: 上方と下方の帯幅が非対称なら、リスクの偏りがある。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            GARCHパラメータ (α=0.1, β=0.85) は固定値であり、全銘柄に最適とは限らない。
          </li>
          <li>
            過去の残差分布が将来も不変という仮定（定常性の仮定）を置いている。
          </li>
          <li>
            レジーム変化（構造変化）には対応していない。市場環境が大きく変わると精度が低下する。
          </li>
          <li>
            決定論的PRNGを使用しているため、同じデータからは常に同じ結果が得られる（再現性は高い）。
          </li>
          <li>
            シミュレーション期間が長くなるほど予測精度は低下する。60営業日程度が実用的な上限。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
