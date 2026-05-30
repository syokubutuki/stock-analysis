"use client";

import React, { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeRegimeTechnical, type RegimeTechnicalResult } from "../../lib/cross-analysis";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

function pctFmt(v: number): string { return (v * 100).toFixed(2) + "%"; }

const REGIME_COLORS = ["#10b981", "#f59e0b", "#ef4444"];
const REGIME_BG = ["bg-green-50 border-green-200", "bg-amber-50 border-amber-200", "bg-red-50 border-red-200"];
const REGIME_TEXT = ["text-green-800", "text-amber-800", "text-red-800"];

export default function RegimeTechnicalChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const results = useMemo(() => computeRegimeTechnical(prices), [prices]);

  // Win rate comparison bar chart
  useEffect(() => {
    if (!canvasRef.current || results.length === 0) return;
    const canvasH = 280;
    const init = initCanvas(canvasRef.current, canvasH);
    if (!init) return;
    const { ctx, width, height } = init;

    const ml = 130, mr = 20, mt = 30, mb = 30;
    const plotW = width - ml - mr;
    const plotH = height - mt - mb;

    // 4 metrics per regime, 3 regimes
    const metrics = [
      { label: "RSI買い (RSI<30)", getWR: (r: RegimeTechnicalResult) => r.rsiBuyWinRate, getN: (r: RegimeTechnicalResult) => r.rsiBuySignals },
      { label: "RSI売り (RSI>70)", getWR: (r: RegimeTechnicalResult) => r.rsiSellWinRate, getN: (r: RegimeTechnicalResult) => r.rsiSellSignals },
      { label: "MACDゴールデンクロス", getWR: (r: RegimeTechnicalResult) => r.macdBuyWinRate, getN: (r: RegimeTechnicalResult) => r.macdBuySignals },
      { label: "MACDデッドクロス", getWR: (r: RegimeTechnicalResult) => r.macdSellWinRate, getN: (r: RegimeTechnicalResult) => r.macdSellSignals },
    ];

    const rowH = plotH / metrics.length;
    const barH = rowH / 4.5;
    const regimeLabels = ["低ボラ", "中ボラ", "高ボラ"];

    // Grid
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 10; i++) {
      const x = ml + (plotW * i) / 10;
      ctx.beginPath(); ctx.moveTo(x, mt); ctx.lineTo(x, height - mb); ctx.stroke();
      if (i % 2 === 0) {
        ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
        ctx.fillText(`${i * 10}%`, x, height - mb + 12);
      }
    }

    // 50% reference line
    const x50 = ml + plotW * 0.5;
    ctx.strokeStyle = "#6b7280"; ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x50, mt); ctx.lineTo(x50, height - mb); ctx.stroke();
    ctx.setLineDash([]);

    // Draw bars
    for (let mi = 0; mi < metrics.length; mi++) {
      const metric = metrics[mi];
      const baseY = mt + mi * rowH;

      // Metric label
      ctx.fillStyle = "#374151";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(metric.label, ml - 8, baseY + rowH / 2 + 4);

      // Separator
      if (mi > 0) {
        ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(ml, baseY); ctx.lineTo(width - mr, baseY); ctx.stroke();
      }

      for (let ri = 0; ri < 3; ri++) {
        const r = results[ri];
        const wr = metric.getWR(r);
        const n = metric.getN(r);
        const y = baseY + (ri + 0.5) * (rowH / 3) - barH / 2 + 5;
        const barW = wr * plotW;

        // Bar
        ctx.fillStyle = REGIME_COLORS[ri] + (n > 0 ? "aa" : "33");
        ctx.fillRect(ml, y, barW, barH);

        // Border
        ctx.strokeStyle = REGIME_COLORS[ri];
        ctx.lineWidth = 0.8;
        ctx.strokeRect(ml, y, barW, barH);

        // Label
        ctx.fillStyle = n > 0 ? "#374151" : "#9ca3af";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "left";
        const labelText = n > 0 ? `${(wr * 100).toFixed(0)}% (n=${n})` : "n=0";
        ctx.fillText(labelText, ml + barW + 4, y + barH - 2);

        // Regime label (only for first metric)
        if (mi === 0) {
          ctx.fillStyle = REGIME_COLORS[ri];
          ctx.font = "bold 9px sans-serif";
          ctx.textAlign = "right";
          // ctx.fillText(regimeLabels[ri], ml - 8, y + barH - 2);
        }
      }
    }

    // Border
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
    ctx.strokeRect(ml, mt, plotW, plotH);

    // Title
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("レジーム別シグナル勝率 (5日後リターン)", ml, mt - 10);

    // Legend
    const legX = width - mr - 250;
    for (let ri = 0; ri < 3; ri++) {
      ctx.fillStyle = REGIME_COLORS[ri] + "aa";
      ctx.fillRect(legX + ri * 80, mt - 18, 10, 10);
      ctx.fillStyle = "#374151"; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(regimeLabels[ri], legX + ri * 80 + 14, mt - 9);
    }
  }, [results]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">レジーム別テクニカル指標有効性</h3>

      {results.length === 0 ? (
        <div className="text-sm text-gray-400">データが不足しています (最低60日必要)</div>
      ) : (
        <>
          {/* レジーム概要カード */}
          <div className="grid grid-cols-3 gap-3">
            {results.map((r, i) => (
              <div key={i} className={`p-3 rounded-lg border ${REGIME_BG[i]}`}>
                <div className={`text-xs font-bold ${REGIME_TEXT[i]} mb-1`}>{r.regime}</div>
                <div className="grid grid-cols-2 gap-1 text-xs">
                  <div>
                    <span className="text-gray-500">日数: </span>
                    <span className="font-mono font-medium">{r.n}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">年率ボラ: </span>
                    <span className="font-mono font-medium">{(r.avgVol * 100).toFixed(1)}%</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-gray-500">年率リターン: </span>
                    <span className={`font-mono font-medium ${r.avgReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {(r.avgReturn * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 勝率バーチャート */}
          <div className="relative">
            <canvas ref={canvasRef} />
          </div>

          {/* 詳細テーブル */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-gray-300">
                  <th className="py-2 px-2 text-left text-gray-500">指標</th>
                  {results.map((r, i) => (
                    <th key={i} colSpan={3} className="py-2 px-1 text-center" style={{ color: REGIME_COLORS[i] }}>
                      {r.regime}
                    </th>
                  ))}
                </tr>
                <tr className="border-b border-gray-200">
                  <th className="py-1 px-2"></th>
                  {results.map((_, i) => (
                    <React.Fragment key={i}>
                      <th className="py-1 px-1 text-center text-gray-400 font-normal">回数</th>
                      <th className="py-1 px-1 text-center text-gray-400 font-normal">勝率</th>
                      <th className="py-1 px-1 text-center text-gray-400 font-normal">平均5日R</th>
                    </React.Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  { label: "RSI < 30 買い", getN: (r: RegimeTechnicalResult) => r.rsiBuySignals, getWR: (r: RegimeTechnicalResult) => r.rsiBuyWinRate, getR: (r: RegimeTechnicalResult) => r.rsiBuyAvgReturn },
                  { label: "RSI > 70 売り", getN: (r: RegimeTechnicalResult) => r.rsiSellSignals, getWR: (r: RegimeTechnicalResult) => r.rsiSellWinRate, getR: (r: RegimeTechnicalResult) => r.rsiSellAvgReturn },
                  { label: "MACD GC買い", getN: (r: RegimeTechnicalResult) => r.macdBuySignals, getWR: (r: RegimeTechnicalResult) => r.macdBuyWinRate, getR: (r: RegimeTechnicalResult) => r.macdBuyAvgReturn },
                  { label: "MACD DC売り", getN: (r: RegimeTechnicalResult) => r.macdSellSignals, getWR: (r: RegimeTechnicalResult) => r.macdSellWinRate, getR: (r: RegimeTechnicalResult) => r.macdSellAvgReturn },
                ].map(row => (
                  <tr key={row.label} className="border-b border-gray-100">
                    <td className="py-1.5 px-2 font-medium text-gray-700">{row.label}</td>
                    {results.map((r, i) => (
                      <React.Fragment key={i}>
                        <td className="py-1.5 px-1 text-center font-mono text-gray-500">{row.getN(r)}</td>
                        <td className={`py-1.5 px-1 text-center font-mono ${row.getWR(r) >= 0.5 ? "text-green-600 font-medium" : row.getN(r) > 0 ? "text-red-600" : "text-gray-300"}`}>
                          {row.getN(r) > 0 ? `${(row.getWR(r) * 100).toFixed(0)}%` : "-"}
                        </td>
                        <td className={`py-1.5 px-1 text-center font-mono ${row.getR(r) >= 0 ? "text-green-600" : "text-red-600"}`}>
                          {row.getN(r) > 0 ? pctFmt(row.getR(r)) : "-"}
                        </td>
                      </React.Fragment>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 判定 */}
          <div className="p-3 bg-blue-50 rounded text-xs text-gray-700 space-y-1">
            <div className="font-medium text-blue-800 mb-1">レジーム別有効性の判定</div>
            <ul className="space-y-1">
              {results.map((r, i) => {
                const bestSignal =
                  (r.rsiBuySignals > 3 && r.rsiBuyWinRate > 0.55) ? `RSI買い (勝率${(r.rsiBuyWinRate*100).toFixed(0)}%)` :
                  (r.macdBuySignals > 3 && r.macdBuyWinRate > 0.55) ? `MACDゴールデンクロス (勝率${(r.macdBuyWinRate*100).toFixed(0)}%)` :
                  null;
                return (
                  <li key={i}>
                    <strong style={{ color: REGIME_COLORS[i] }}>{r.regime}</strong>:
                    {bestSignal
                      ? ` ${bestSignal}が有効。`
                      : " 明確に有効なシグナルなし。"}
                    年率リターン{(r.avgReturn * 100).toFixed(1)}%、
                    ボラ{(r.avgVol * 100).toFixed(0)}%。
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}

      <AnalysisGuide title="レジーム別テクニカル有効性の詳細理論">
        <p className="font-medium text-gray-700">1. レジーム分類</p>
        <p>20日ローリングボラティリティを計算し、その三分位（33%/66%パーセンタイル）で3つのレジームに分類します:</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>低ボラティリティ</strong>: 安定した相場。レンジ相場になりやすく、ミーンリバージョン（RSI等の逆張り）が有効になりやすい。</li>
          <li><strong>中ボラティリティ</strong>: 通常の相場。テクニカル指標が最も信頼性を持つ環境。</li>
          <li><strong>高ボラティリティ</strong>: 荒れた相場。トレンドが強く、モメンタム指標（MACD等の順張り）が有効になりやすい。ただしダマシも多い。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">2. RSIシグナルの評価</p>
        <p>{"RSI = 100 - 100/(1 + RS) で RS = (N期間の平均上昇幅) / (N期間の平均下落幅)。期間 N=14 を使用。"}</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>RSI &lt; 30 → 「売られすぎ」→ 買いシグナル。低ボラレジームで特に有効とされる。</li>
          <li>RSI &gt; 70 → 「買われすぎ」→ 売りシグナル。トレンド相場ではダマシになりやすい。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. MACDシグナルの評価</p>
        <p>{"MACD = EMA(12) - EMA(26)、シグナル = EMA(MACD, 9)、ヒストグラム = MACD - シグナル。"}</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ヒストグラムが負→正（ゴールデンクロス）→ 買いシグナル。トレンド転換の初期に出現。</li>
          <li>ヒストグラムが正→負（デッドクロス）→ 売りシグナル。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 勝率と平均リターン</p>
        <p>各シグナル発生後の5営業日リターンを計算し、以下を評価します:</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>勝率: 5日後リターンが正の割合。50%を超えれば有意な方向バイアスが存在。</li>
          <li>平均5日リターン: シグナル後の期待リターン。正であれば買いシグナルとして有効。</li>
          <li>サンプル数に注意: n &lt; 10 では統計的信頼性が低い。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. なぜレジーム別に評価するのか</p>
        <p>テクニカル指標の有効性は市場環境に大きく依存します。全期間での平均的な評価は、レジームの違いを打ち消してしまう可能性があります。例えば、RSI買いシグナルは低ボラレジームで高勝率だが、高ボラレジームではダマシが多い場合、全期間平均では「まあまあ」の結果になりますが、レジームを分離すれば「低ボラ時のみ使うべき」という実用的な知見が得られます。</p>
      </AnalysisGuide>
    </div>
  );
}

