"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeCornishFisherVaR, computeOmegaRatio } from "../../lib/cornish-fisher";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function CornishFisherChart({ prices }: Props) {
  const omegaCanvasRef = useRef<HTMLCanvasElement>(null);

  const returns = useMemo(() => {
    const r: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i].close > 0 && prices[i - 1].close > 0) {
        r.push(Math.log(prices[i].close / prices[i - 1].close));
      }
    }
    return r;
  }, [prices]);

  const cfVar = useMemo(() => computeCornishFisherVaR(returns), [returns]);
  const omega = useMemo(() => computeOmegaRatio(returns), [returns]);

  // Omega curve canvas
  useEffect(() => {
    const canvas = omegaCanvasRef.current;
    if (!canvas || omega.curve.length === 0) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 180;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, width, height);

    const pad = { top: 15, right: 15, bottom: 25, left: 55 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const data = omega.curve.filter(d => d.omega < 20);
    if (data.length === 0) return;

    const minT = data[0].threshold;
    const maxT = data[data.length - 1].threshold;
    const maxO = Math.min(Math.max(...data.map(d => d.omega)), 10);

    const toX = (t: number) => pad.left + (t - minT) / (maxT - minT) * plotW;
    const toY = (o: number) => pad.top + (1 - o / maxO) * plotH;

    // Ω=1 horizontal line
    if (maxO >= 1) {
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, toY(1));
      ctx.lineTo(width - pad.right, toY(1));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ef4444";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("Ω=1", pad.left + 2, toY(1) - 3);
    }

    // τ=0 vertical line
    if (minT < 0 && maxT > 0) {
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(toX(0), pad.top);
      ctx.lineTo(toX(0), height - pad.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Omega curve
    ctx.strokeStyle = "#8b5cf6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = toX(d.threshold);
      const y = toY(Math.min(d.omega, maxO));
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Labels
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("閾値 τ", width / 2, height - 3);
    ctx.fillText((minT * 100).toFixed(1) + "%", pad.left, height - 8);
    ctx.fillText((maxT * 100).toFixed(1) + "%", width - pad.right, height - 8);
    ctx.textAlign = "right";
    ctx.fillText(maxO.toFixed(1), pad.left - 4, pad.top + 8);
    ctx.fillText("0", pad.left - 4, height - pad.bottom);
    ctx.textAlign = "center";
    ctx.fillText("オメガレシオ Ω(τ)", width / 2, 12);
  }, [omega]);

  const fmt = (v: number) => (v * 100).toFixed(2) + "%";

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        Cornish-Fisher修正VaR / オメガレシオ
      </h3>

      {/* VaR比較テーブル */}
      <div className="mb-4">
        <div className="text-xs font-medium text-gray-600 mb-1">VaR比較</div>
        <table className="text-xs w-full border-collapse">
          <thead>
            <tr className="border-b">
              <th className="text-left py-1 text-gray-500">手法</th>
              <th className="text-right py-1 text-gray-500">95% VaR</th>
              <th className="text-right py-1 text-gray-500">99% VaR</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-100">
              <td className="py-1">正規分布</td>
              <td className="text-right font-mono">{fmt(cfVar.normalVaR95)}</td>
              <td className="text-right font-mono">{fmt(cfVar.normalVaR99)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1 font-semibold">Cornish-Fisher修正</td>
              <td className="text-right font-mono font-semibold">{fmt(cfVar.cfVaR95)}</td>
              <td className="text-right font-mono font-semibold">{fmt(cfVar.cfVaR99)}</td>
            </tr>
            <tr>
              <td className="py-1">ヒストリカル</td>
              <td className="text-right font-mono">{fmt(cfVar.historicalVaR95)}</td>
              <td className="text-right font-mono">{fmt(cfVar.historicalVaR99)}</td>
            </tr>
          </tbody>
        </table>
        <div className="text-xs text-gray-500 mt-1">
          歪度={cfVar.skewness.toFixed(3)}, 超過尖度={cfVar.excessKurtosis.toFixed(3)}
        </div>
      </div>

      <div className="text-xs text-gray-600 mb-3">{cfVar.interpretation}</div>

      {/* オメガレシオ */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">Ω(0)</div>
          <div className={`font-mono text-sm font-semibold ${omega.omega > 1 ? "text-green-700" : "text-red-700"}`}>
            {omega.omega.toFixed(3)}
          </div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">損益分岐点</div>
          <div className="font-mono text-sm">{(omega.breakeven * 100).toFixed(3)}%</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">判定</div>
          <div className={`text-sm font-semibold ${omega.omega > 1 ? "text-green-700" : "text-red-700"}`}>
            {omega.omega > 1 ? "投資妙味あり" : "リスク過大"}
          </div>
        </div>
      </div>

      <canvas ref={omegaCanvasRef} />

      <div className="text-xs text-gray-600 mt-2">{omega.interpretation}</div>

      <AnalysisGuide title="Cornish-Fisher VaR / オメガレシオの詳細理論">
        <p className="font-medium text-gray-700">1. Cornish-Fisher修正VaRとは</p>
        <p>
          正規分布を仮定したVaRは、ファットテール（厚い裾）や歪みを無視するためリスクを過小評価します。
          CF修正は歪度(S)と尖度(K)を使って正規分位数を補正し、より現実的なVaRを算出します。
          {"z_CF = z_α + (z²-1)S/6 + (z³-3z)K/24 - (2z³-5z)S²/36"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. オメガレシオ</p>
        <p>
          {"Ω(τ) = ∫_τ^∞[1-F(r)]dr / ∫_{-∞}^τ F(r)dr"}
          <br />
          シャープレシオの一般化。分布の全情報（歪度・尖度含む）を考慮します。
          Ω(0){">"} 1なら「良い日の累積が悪い日の累積を上回る」ことを意味します。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>CF VaR {">"} 正規VaR: ファットテール/負の歪度でリスクが過小評価されている</li>
          <li>CF VaR ≈ 正規VaR: 分布が正規に近い</li>
          <li>Ω(0) {">"} 1: 期待リターンがプラス（投資妙味あり）</li>
          <li>Ω曲線が右に移動するほど高リターン期待（ただし過去の結果）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>CF VaRを使ったリスク管理は正規VaRより保守的で安全</li>
          <li>Ω {">"} 1かつCF VaRが許容範囲内 → ポジションを検討</li>
          <li>損益分岐点がリスクフリーレート以下 → リスクフリーより優れた投資</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>CF展開は分布が正規から極端に離れると精度が低下する</li>
          <li>オメガレシオは過去データに基づく。将来の保証ではない</li>
          <li>短期間のデータではΩの推定が不安定</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
