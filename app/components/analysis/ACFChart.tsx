"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { logReturns } from "../../lib/transforms";
import { acf, pacf, confidenceBound } from "../../lib/autocorrelation";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

function drawACF(
  canvas: HTMLCanvasElement,
  data: { lag: number; value: number }[],
  bound: number,
  title: string
) {
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

  const margin = { top: 20, right: 10, bottom: 20, left: 40 };
  const pw = width - margin.left - margin.right;
  const ph = height - margin.top - margin.bottom;

  // lag=0を除外
  const plotData = data.filter((d) => d.lag > 0);
  if (plotData.length === 0) return;

  const maxLag = plotData[plotData.length - 1].lag;
  const maxVal = Math.max(1, ...plotData.map((d) => Math.abs(d.value)));
  const barW = Math.max(2, pw / maxLag - 2);

  const toX = (lag: number) => margin.left + (lag / maxLag) * pw;
  const toY = (v: number) => margin.top + ph / 2 - (v / maxVal) * (ph / 2);

  // 信頼区間
  ctx.fillStyle = "rgba(59, 130, 246, 0.1)";
  ctx.fillRect(margin.left, toY(bound), pw, toY(-bound) - toY(bound));
  ctx.strokeStyle = "rgba(59, 130, 246, 0.4)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(margin.left, toY(bound));
  ctx.lineTo(width - margin.right, toY(bound));
  ctx.moveTo(margin.left, toY(-bound));
  ctx.lineTo(width - margin.right, toY(-bound));
  ctx.stroke();
  ctx.setLineDash([]);

  // ゼロ線
  ctx.strokeStyle = "#999";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(margin.left, toY(0));
  ctx.lineTo(width - margin.right, toY(0));
  ctx.stroke();

  // バー
  for (const d of plotData) {
    const x = toX(d.lag) - barW / 2;
    const y0 = toY(0);
    const y1 = toY(d.value);
    ctx.fillStyle = Math.abs(d.value) > bound ? "#ef4444" : "#3b82f6";
    ctx.fillRect(x, Math.min(y0, y1), barW, Math.abs(y1 - y0));
  }

  ctx.fillStyle = "#333";
  ctx.font = "bold 11px sans-serif";
  ctx.fillText(title, margin.left + 5, margin.top - 5);
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#999";
  ctx.fillText("Lag", width / 2 - 10, height - 3);
}

export default function ACFChart({ prices }: Props) {
  const acfCanvasRef = useRef<HTMLCanvasElement>(null);
  const pacfCanvasRef = useRef<HTMLCanvasElement>(null);
  const acfSqCanvasRef = useRef<HTMLCanvasElement>(null);

  const closes = prices.map((p) => p.close);
  const lr = logReturns(closes);
  const lrSq = lr.map((r) => r * r); // リターンの二乗

  const acfData = useMemo(() => acf(lr, 30), [prices]);
  const pacfData = useMemo(() => pacf(lr, 30), [prices]);
  const acfSqData = useMemo(() => acf(lrSq, 30), [prices]);
  const bound = confidenceBound(lr.length);

  useEffect(() => {
    if (acfCanvasRef.current) drawACF(acfCanvasRef.current, acfData, bound, "ACF (リターン)");
    if (pacfCanvasRef.current) drawACF(pacfCanvasRef.current, pacfData, bound, "PACF (リターン)");
    if (acfSqCanvasRef.current) drawACF(acfSqCanvasRef.current, acfSqData, bound, "ACF (リターン²)");
  }, [prices, acfData, pacfData, acfSqData, bound]);

  // 有意なラグの検出
  const sigACF = acfData.filter((d) => d.lag > 0 && Math.abs(d.value) > bound);
  const sigSqACF = acfSqData.filter((d) => d.lag > 0 && Math.abs(d.value) > bound);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">自己相関分析</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="w-full rounded border border-gray-100 overflow-hidden">
            <canvas ref={acfCanvasRef} />
          </div>
        </div>
        <div>
          <div className="w-full rounded border border-gray-100 overflow-hidden">
            <canvas ref={pacfCanvasRef} />
          </div>
        </div>
      </div>

      <div className="mt-3">
        <div className="text-xs text-gray-500 mb-1">ボラティリティクラスタリング検出</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden">
          <canvas ref={acfSqCanvasRef} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">有意なACF(リターン)</div>
          <div className="font-mono font-medium">
            {sigACF.length > 0
              ? sigACF.map((d) => `Lag${d.lag}`).join(", ")
              : "なし (効率的市場)"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">{"有意なACF(リターン²)"}</div>
          <div className={`font-mono font-medium ${sigSqACF.length > 3 ? "text-orange-600" : ""}`}>
            {sigSqACF.length > 0
              ? `${sigSqACF.length}個のラグ → ボラクラスタリング`
              : "なし"}
          </div>
        </div>
      </div>

      <AnalysisGuide title="自己相関分析の読み方">
        <p><span className="font-medium">ACF(自己相関関数):</span> {"ラグkの自己相関 = 「今日のリターンとk日前のリターンの相関」。"}青い帯は95%信頼区間で、帯を超える赤いバーは統計的に有意な自己相関です。</p>
        <p><span className="font-medium">PACF(偏自己相関関数):</span> 中間のラグの影響を除去した「純粋な」自己相関です。ARモデルの次数決定に使います。PACF(k)が有意 = 過去k日の情報が現在に直接影響している。</p>
        <p><span className="font-medium">{"ACF(リターン²):"}</span> リターンの二乗の自己相関はボラティリティクラスタリング(大きな変動の後に大きな変動が続く現象)を検出します。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">リターンのACFに有意なラグがある:</span> 市場に非効率性がある可能性。そのラグを利用した予測が可能かもしれない。</li>
          <li><span className="font-medium">リターンのACFに有意なラグがない:</span> リターン自体はほぼランダム(効率的市場仮説と整合)。</li>
          <li><span className="font-medium">{"リターン²のACFに多くの有意なラグ:"}</span> ボラティリティクラスタリングが強い。「静かな日の後は静かな日、荒れた日の後は荒れた日」が続く傾向。GARCH型モデルが有効。</li>
        </ul>
        <p><span className="font-medium">トレードへの活用:</span> ボラティリティクラスタリングが強い銘柄では、低ボラ期間にポジションを取り、ボラティリティ拡大とともにトレンドフォローする戦略が考えられます。</p>
      </AnalysisGuide>
    </div>
  );
}
