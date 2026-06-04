"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { hillBothTails } from "../../lib/hill-estimator";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function HillEstimatorChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const returns = useMemo(() => {
    const r: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i].close > 0 && prices[i - 1].close > 0) {
        r.push(Math.log(prices[i].close / prices[i - 1].close));
      }
    }
    return r;
  }, [prices]);

  const result = useMemo(() => hillBothTails(returns), [returns]);

  // Hill plot
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || result.hillPlot.length === 0) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 200;
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

    const pad = { top: 20, right: 15, bottom: 25, left: 45 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const data = result.hillPlot.filter(d => d.alpha > 0 && d.alpha < 20 && isFinite(d.alpha));
    if (data.length === 0) return;

    const minK = data[0].k;
    const maxK = data[data.length - 1].k;
    const maxAlpha = Math.min(Math.max(...data.map(d => d.alpha)) * 1.1, 15);

    const toX = (k: number) => pad.left + ((k - minK) / (maxK - minK)) * plotW;
    const toY = (a: number) => pad.top + (1 - a / maxAlpha) * plotH;

    // Hill plot curve
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = toX(d.k);
      const y = toY(d.alpha);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Optimal k marker
    ctx.fillStyle = "#dc2626";
    ctx.beginPath();
    ctx.arc(toX(result.k), toY(result.alpha), 5, 0, Math.PI * 2);
    ctx.fill();

    // Reference lines: α=2 (infinite variance), α=4 (infinite kurtosis)
    for (const ref of [2, 4]) {
      if (ref < maxAlpha) {
        ctx.strokeStyle = ref === 2 ? "#ef4444" : "#d97706";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.left, toY(ref));
        ctx.lineTo(width - pad.right, toY(ref));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = ref === 2 ? "#ef4444" : "#d97706";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(`α=${ref}`, pad.left + 3, toY(ref) - 3);
      }
    }

    // Labels
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("テール観測数 k", width / 2, height - 3);
    ctx.textAlign = "right";
    ctx.fillText(maxAlpha.toFixed(1), pad.left - 4, pad.top + 8);
    ctx.fillText("0", pad.left - 4, height - pad.bottom);
    ctx.textAlign = "center";
    ctx.fillText("Hill Plot (テール指数 vs k)", width / 2, 14);
  }, [result]);

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        Hill テール指数推定
      </h3>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">右テール α</div>
          <div className={`font-mono text-sm font-semibold ${result.alpha < 3 ? "text-red-700" : result.alpha < 5 ? "text-yellow-700" : "text-green-700"}`}>
            {result.alpha.toFixed(2)}
          </div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">左テール α</div>
          <div className={`font-mono text-sm font-semibold ${result.alphaLeft < 3 ? "text-red-700" : result.alphaLeft < 5 ? "text-yellow-700" : "text-green-700"}`}>
            {result.alphaLeft.toFixed(2)}
          </div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">テール観測数 k</div>
          <div className="font-mono text-sm">{result.k}</div>
        </div>
      </div>

      <div className="text-xs text-gray-600 mb-3">{result.interpretation}</div>

      <canvas ref={canvasRef} />

      <AnalysisGuide title="Hillテール指数推定の詳細理論">
        <p className="font-medium text-gray-700">1. Hill推定量とは</p>
        <p>
          テール分布がべき乗則 P(X {">"} x) ~ x^(-α) に従うと仮定し、テール指数αを推定します。
          {"α̂ = [1/k Σ ln(X_{(i)}/X_{(k+1)})]^{-1}"}
          <br />
          αが小さいほどテールが厚い（極端な値が頻繁に出現する）。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. αの意味</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>α {"<"} 2: 分散が無限大（非常に危険なテール）</li>
          <li>2 {"<"} α {"<"} 4: 分散は有限だが尖度は無限大</li>
          <li>α {">"} 4: 尖度も有限（比較的穏やかなテール）</li>
          <li>正規分布: α → ∞ （指数的に速い減衰）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. Hill Plot</p>
        <p>
          横軸kはテールの上位何個の観測を使うか。k が小さすぎると推定が不安定、大きすぎるとバイアスが入る。
          Hill Plotが安定する（プラトーの）k を選ぶのが正しい推定法。赤点が最適k。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>α {"<"} 3 → 正規分布VaRは大幅に過小。EVT（極値理論）ベースVaRが必要</li>
          <li>左αが右αより小さい → 下落方向のテールリスクが大きい</li>
          <li>左右のαの非対称性 → オプション戦略でヘッジを調整</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>kの選択に結果が敏感。Hill Plotで安定領域を確認</li>
          <li>サンプルサイズが小さいとテール推定の信頼性が低い</li>
          <li>条件付き分布（GARCHフィルタ後）の方が推定精度が高い場合がある</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
