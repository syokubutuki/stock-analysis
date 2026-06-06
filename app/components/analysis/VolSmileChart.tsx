"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { estimateVolSmile } from "../../lib/vol-smile";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function VolSmileChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const returns = useMemo(() => {
    const r: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1].close > 0)
        r.push(Math.log(prices[i].close / prices[i - 1].close));
    }
    return r;
  }, [prices]);

  const result = useMemo(() => estimateVolSmile(returns), [returns]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || result.smile.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const width = parent.clientWidth;
    const height = 250;
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

    const pad = { top: 25, right: 25, bottom: 35, left: 60 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const vols = result.smile.map((s) => s.impliedVol * 100);
    const minV = Math.min(...vols) * 0.95;
    const maxV = Math.max(...vols) * 1.05;
    const minM = 0.80;
    const maxM = 1.20;

    const toX = (m: number) => pad.left + ((m - minM) / (maxM - minM)) * plotW;
    const toY = (v: number) => pad.top + (1 - (v - minV) / (maxV - minV)) * plotH;

    // Grid
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    for (let m = 0.85; m <= 1.15; m += 0.05) {
      ctx.beginPath();
      ctx.moveTo(toX(m), pad.top);
      ctx.lineTo(toX(m), height - pad.bottom);
      ctx.stroke();
    }
    for (let v = Math.ceil(minV); v <= maxV; v += 5) {
      ctx.beginPath();
      ctx.moveTo(pad.left, toY(v));
      ctx.lineTo(width - pad.right, toY(v));
      ctx.stroke();
    }

    // ATM vertical line
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(toX(1.0), pad.top);
    ctx.lineTo(toX(1.0), height - pad.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // Smile curve
    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < result.smile.length; i++) {
      const s = result.smile[i];
      const x = toX(s.moneyness);
      const y = toY(s.impliedVol * 100);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // ATM point
    const atmIdx = result.smile.findIndex((s) => Math.abs(s.moneyness - 1.0) < 0.006);
    if (atmIdx >= 0) {
      const s = result.smile[atmIdx];
      const x = toX(s.moneyness);
      const y = toY(s.impliedVol * 100);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#7c3aed";
      ctx.fill();
      ctx.fillStyle = "#374151";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`ATM: ${(s.impliedVol * 100).toFixed(1)}%`, x, y - 10);
    }

    // X-axis labels
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (let m = 0.85; m <= 1.15; m += 0.05) {
      ctx.fillText(m.toFixed(2), toX(m), height - pad.bottom + 14);
    }
    ctx.fillText("マネーネス (K/S)", width / 2, height - 3);

    // Y-axis labels
    ctx.textAlign = "right";
    for (let v = Math.ceil(minV); v <= maxV; v += 5) {
      ctx.fillText(`${v.toFixed(0)}%`, pad.left - 5, toY(v) + 3);
    }

    // Title
    ctx.fillStyle = "#374151";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Implied Volatility (%)", pad.left, pad.top - 8);
  }, [result]);

  if (result.smile.length === 0) return null;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">
        ボラティリティスマイル推定
      </h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">ATM Vol</div>
          <div className="font-mono text-sm font-bold">
            {(result.atmVol * 100).toFixed(1)}%
          </div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">スキュー</div>
          <div className={`font-mono text-sm font-bold ${result.skew > 0 ? "text-red-600" : "text-blue-600"}`}>
            {(result.skew * 100).toFixed(2)}%
          </div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">歪度</div>
          <div className="font-mono text-sm">{result.sourceSkewness.toFixed(3)}</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">超過尖度</div>
          <div className="font-mono text-sm">{result.sourceKurtosis.toFixed(3)}</div>
        </div>
      </div>

      <canvas ref={canvasRef} />

      <p className="text-xs text-gray-600 mt-2">{result.interpretation}</p>

      <AnalysisGuide title="ボラティリティスマイルの詳細理論">
        <p className="font-medium text-gray-700">1. ボラティリティスマイルとは</p>
        <p>
          オプション市場では、ストライク価格（行使価格）によってインプライドボラティリティ(IV)が異なります。
          Black-Scholesモデルが正しければIVは一定のはずですが、実際にはOTM（アウト・オブ・ザ・マネー）の
          プットやコールほどIVが高くなる傾向があり、グラフが笑顔のような形になることから「スマイル」と呼ばれます。
          本分析では、ヒストリカルリターンの歪度・尖度からこのスマイル形状を近似推定します。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>{"Backus-Foresi-Wu近似:"}</p>
        <p>{"sigma_imp(m) = sigma_ATM * [1 + lambda1*d + lambda2*(d^2 - 1)]"}</p>
        <p>{"d = log(K/S) / (sigma_ATM * sqrt(T))"}</p>
        <p>{"lambda1 = -skewness/6 (スキュー制御)"}</p>
        <p>{"lambda2 = excessKurtosis/24 (曲率制御)"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>マネーネス (K/S): ストライク価格/現在株価の比率。1.0がATM</li>
          <li>スキュー: OTMプットとOTMコールのIV差。正ならプット側が高い（下落保険の需要）</li>
          <li>コンベクシティ: OTM平均IVとATM IVの差。テールリスクの大きさを反映</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>スキューが大きい → 市場が下落リスクを懸念。プロテクティブプットのコストが高い</li>
          <li>コンベクシティが大きい → テールイベント（急落・急騰）のリスクが高いと市場が認識</li>
          <li>スマイルが対称 → 上下のリスクがほぼ均等に認識されている</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>本推定は実際のオプション市場データではなく、ヒストリカルリターンからの近似</li>
          <li>実際のIVスマイルは需給要因も反映するため、ヒストリカル推定とは乖離する</li>
          <li>T=1ヶ月を仮定しており、満期の違いは考慮していない</li>
          <li>歪度・尖度が極端な場合、近似精度が低下する可能性がある</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
