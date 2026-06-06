"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeOptimalStopping } from "../../lib/optimal-stopping";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function OptimalStoppingChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const closePrices = useMemo(() => prices.map((p) => p.close), [prices]);
  const result = useMemo(() => computeOptimalStopping(closePrices), [closePrices]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || result.exerciseBoundary.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const width = parent.clientWidth;
    const height = 280;
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

    const pad = { top: 20, right: 15, bottom: 30, left: 60 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const N = result.exerciseBoundary.length;
    const startIdx = prices.length - N;
    const p = prices.slice(startIdx).map((d) => d.close);

    const allVals = [...p, ...result.exerciseBoundary];
    let minY = Math.min(...allVals);
    let maxY = Math.max(...allVals);
    const yRange = maxY - minY || 1;
    minY -= yRange * 0.05;
    maxY += yRange * 0.05;

    const toX = (t: number) => pad.left + (t / (N - 1)) * plotW;
    const toY = (v: number) => pad.top + (1 - (v - minY) / (maxY - minY)) * plotH;

    // Exercise boundary
    ctx.strokeStyle = "rgba(239, 68, 68, 0.5)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (let t = 0; t < N; t++) {
      const x = toX(t);
      const y = toY(result.exerciseBoundary[t]);
      t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Price path
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let t = 0; t < N; t++) {
      const x = toX(t);
      const y = toY(p[t]);
      t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Optimal sell marker
    const optIdx = result.optimalSellIndex - startIdx;
    if (optIdx >= 0 && optIdx < N) {
      ctx.beginPath();
      ctx.arc(toX(optIdx), toY(p[optIdx]), 6, 0, Math.PI * 2);
      ctx.fillStyle = "#dc2626";
      ctx.fill();
      ctx.fillStyle = "#dc2626";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("最適停止", toX(optIdx), toY(p[optIdx]) - 10);
    }

    // Secretary pick marker
    const secIdx = result.secretaryPick - startIdx;
    if (secIdx >= 0 && secIdx < N) {
      ctx.beginPath();
      ctx.arc(toX(secIdx), toY(p[secIdx]), 5, 0, Math.PI * 2);
      ctx.fillStyle = "#059669";
      ctx.fill();
      ctx.fillStyle = "#059669";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("1/e rule", toX(secIdx), toY(p[secIdx]) + 18);
    }

    // Secretary threshold line
    ctx.strokeStyle = "rgba(5, 150, 105, 0.3)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(toX(result.secretaryThreshold), pad.top);
    ctx.lineTo(toX(result.secretaryThreshold), height - pad.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // Labels
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(maxY.toFixed(0), pad.left - 4, pad.top + 8);
    ctx.fillText(minY.toFixed(0), pad.left - 4, height - pad.bottom);
    ctx.textAlign = "left";
    ctx.fillStyle = "#2563eb";
    ctx.fillText("価格", pad.left + 5, pad.top + 12);
    ctx.fillStyle = "#ef4444";
    ctx.fillText("行使境界", pad.left + 40, pad.top + 12);
  }, [result, prices]);

  if (result.exerciseBoundary.length === 0) return null;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        最適停止問題 (Optimal Stopping)
      </h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">最適停止リターン</div>
          <div className={`font-mono text-sm font-bold ${result.expectedReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
            {result.expectedReturn.toFixed(2)}%
          </div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">Secretary法リターン</div>
          <div className={`font-mono text-sm font-bold ${result.secretaryReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
            {result.secretaryReturn.toFixed(2)}%
          </div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">B&Hリターン</div>
          <div className={`font-mono text-sm ${result.actualReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
            {result.actualReturn.toFixed(2)}%
          </div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">観測期間 (1/e)</div>
          <div className="font-mono text-sm">{result.secretaryThreshold}日</div>
        </div>
      </div>

      <canvas ref={canvasRef} />

      <p className="text-xs text-gray-600 mt-2">{result.interpretation}</p>

      <AnalysisGuide title="最適停止問題の詳細理論">
        <p className="font-medium text-gray-700">1. 最適停止問題とは</p>
        <p>
          「いつ売るか」を数学的に最適化する問題です。後退帰納法で各時点の
          「今売る価値」と「保有を続ける価値（継続価値）」を比較し、
          売却が有利になる最初の時点を求めます。
          Secretary Problem（秘書問題）は、全体の1/eを観察し、その後で
          観察期間の最高値を超えた最初の時点を選ぶ古典的なアルゴリズムです。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>{"後退帰納法: V(T) = S(T), V(t) = max(S(t), δ·E[V(t+1)|S(t)])"}</p>
        <p>{"δ = 割引因子, S(t) = 時刻tの価格"}</p>
        <p>{"Secretary Problem: 最初のN/e個を観察→以降で最初に最高値を超えた候補を選択"}</p>
        <p>{"最適確率 ≈ 1/e ≈ 36.8%（漸近的に最適）"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>赤点: 最適停止ルールによる売却ポイント</li>
          <li>緑点: Secretary法（1/e rule）による売却ポイント</li>
          <li>赤破線: 行使境界（この線を超えると売却が有利）</li>
          <li>緑破線: 観察期間の終了ライン</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>最適停止理論は「利食いタイミング」の理論的根拠を提供</li>
          <li>行使境界を超えた時点が理論上の売り時</li>
          <li>Secretary法は事前情報なしで約37%の確率で最高値付近を選択可能</li>
          <li>実際の投資では取引コスト・税金も考慮が必要</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>後知恵バイアス: 過去データに対する最適解であり、将来の最適解ではない</li>
          <li>継続価値の推定にブートストラップを使用しており、近似的な結果</li>
          <li>Secretary Problemは一度しか選べない前提であり、再参入可能な株式取引とは異なる</li>
          <li>計算量の都合上、直近500日に制限している</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
