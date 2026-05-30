"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeVolTermStructure, type VolTermPoint } from "../../lib/cross-analysis";

import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode?: string;
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

export default function VolTermStructureChart({ prices }: Props) {
  const volChartRef = useRef<HTMLDivElement>(null);
  const ratioCanvasRef = useRef<HTMLCanvasElement>(null);
  const volApiRef = useRef<IChartApi | null>(null);

  const volData = useMemo(() => computeVolTermStructure(prices), [prices]);

  // Volatility time series chart (lightweight-charts)
  useEffect(() => {
    if (!volChartRef.current || volData.length === 0) return;

    const chart = createChart(volChartRef.current, {
      width: volChartRef.current.clientWidth,
      height: 320,
      layout: { textColor: "#374151", fontSize: 11 },
      grid: { vertLines: { color: "#f3f4f6" }, horzLines: { color: "#f3f4f6" } },
      rightPriceScale: { borderColor: "#e5e7eb" },
      timeScale: { borderColor: "#e5e7eb" },
    });
    volApiRef.current = chart;

    const colors = [
      { name: "5日vol", color: "#ef4444" },
      { name: "20日vol", color: "#f59e0b" },
      { name: "60日vol", color: "#3b82f6" },
      { name: "120日vol", color: "#6366f1" },
    ];

    const seriesList = colors.map(c => {
      const s = chart.addSeries(LineSeries, {
        color: c.color,
        lineWidth: c.name === "20日vol" ? 2 : 1,
        title: c.name,
        priceFormat: { type: "percent" as const },
      });
      return s;
    });

    const keys: (keyof VolTermPoint)[] = ["vol5", "vol20", "vol60", "vol120"];
    keys.forEach((key, i) => {
      seriesList[i].setData(
        volData.map(d => ({
          time: d.time as Time,
          value: d[key] as number * 100,
        }))
      );
    });

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (volChartRef.current) chart.applyOptions({ width: volChartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      volApiRef.current = null;
    };
  }, [volData]);

  // Ratio chart (canvas)
  useEffect(() => {
    if (!ratioCanvasRef.current || volData.length === 0) return;
    const canvasH = 200;
    const init = initCanvas(ratioCanvasRef.current, canvasH);
    if (!init) return;
    const { ctx, width, height } = init;

    const ml = 60, mr = 20, mt = 25, mb = 30;
    const plotW = width - ml - mr;
    const plotH = height - mt - mb;

    const ratio520 = volData.map(d => d.ratio_5_20);
    const ratio2060 = volData.map(d => d.ratio_20_60);
    const allRatios = [...ratio520, ...ratio2060].filter(v => isFinite(v));
    const minR = Math.min(...allRatios, 0.5);
    const maxR = Math.max(...allRatios, 1.5);
    const rangeR = maxR - minR || 1;

    const yFromR = (r: number) => mt + plotH - ((r - minR) / rangeR) * plotH;
    const xFromI = (i: number) => ml + (i / (volData.length - 1)) * plotW;

    // Grid
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = mt + (plotH * i) / 4;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      const val = maxR - (rangeR * i) / 4;
      ctx.fillStyle = "#9ca3af"; ctx.font = "10px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(val.toFixed(2), ml - 5, y + 3);
    }

    // 1.0 line (equilibrium)
    if (minR < 1 && maxR > 1) {
      const y1 = yFromR(1);
      ctx.strokeStyle = "#374151";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(ml, y1); ctx.lineTo(width - mr, y1); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#374151";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("均衡 (1.0)", width - mr + 3, y1 + 3);
    }

    // Ratio 5/20
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < volData.length; i++) {
      const x = xFromI(i), y = yFromR(ratio520[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Ratio 20/60
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < volData.length; i++) {
      const x = xFromI(i), y = yFromR(ratio2060[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Shading: contango (ratio > 1) vs backwardation
    for (let i = 0; i < volData.length - 1; i++) {
      const x = xFromI(i);
      const xNext = xFromI(i + 1);
      const r = ratio520[i];
      if (r > 1) {
        ctx.fillStyle = "rgba(239, 68, 68, 0.08)";
        ctx.fillRect(x, mt, xNext - x, plotH);
      } else if (r < 0.85) {
        ctx.fillStyle = "rgba(59, 130, 246, 0.08)";
        ctx.fillRect(x, mt, xNext - x, plotH);
      }
    }

    // Border
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
    ctx.strokeRect(ml, mt, plotW, plotH);

    // Title & Legend
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("ボラティリティ期間構造比率", ml, mt - 8);
    const legX = ml + 200;
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(legX, mt - 12); ctx.lineTo(legX + 18, mt - 12); ctx.stroke();
    ctx.fillStyle = "#374151"; ctx.font = "10px sans-serif";
    ctx.fillText("5日/20日", legX + 22, mt - 8);
    ctx.strokeStyle = "#3b82f6";
    ctx.beginPath(); ctx.moveTo(legX + 75, mt - 12); ctx.lineTo(legX + 93, mt - 12); ctx.stroke();
    ctx.fillText("20日/60日", legX + 97, mt - 8);
  }, [volData]);

  // Current state summary
  const latest = volData.length > 0 ? volData[volData.length - 1] : null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">ボラティリティ期間構造</h3>

      {volData.length === 0 ? (
        <div className="text-sm text-gray-400">データが不足しています (最低121日必要)</div>
      ) : (
        <>
          <div ref={volChartRef} />
          <div className="relative">
            <canvas ref={ratioCanvasRef} />
          </div>

          {/* 現在の状態 */}
          {latest && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              {[
                { label: "5日vol", val: latest.vol5, color: "#ef4444" },
                { label: "20日vol", val: latest.vol20, color: "#f59e0b" },
                { label: "60日vol", val: latest.vol60, color: "#3b82f6" },
                { label: "120日vol", val: latest.vol120, color: "#6366f1" },
              ].map(item => (
                <div key={item.label} className="p-2 bg-gray-50 rounded border border-gray-200">
                  <div className="text-gray-500">{item.label}</div>
                  <div className="font-mono font-bold" style={{ color: item.color }}>
                    {(item.val * 100).toFixed(1)}%
                  </div>
                </div>
              ))}
            </div>
          )}

          {latest && (
            <div className={`p-3 rounded text-xs ${
              latest.ratio_5_20 > 1.2 ? "bg-red-50 text-red-800" :
              latest.ratio_5_20 < 0.8 ? "bg-blue-50 text-blue-800" :
              "bg-gray-50 text-gray-700"
            }`}>
              <div className="font-medium mb-1">期間構造の判定</div>
              <p>
                短期/中期比率 = {latest.ratio_5_20.toFixed(3)}、
                中期/長期比率 = {latest.ratio_20_60.toFixed(3)}。
                {latest.ratio_5_20 > 1.2
                  ? "短期ボラが中期より著しく高い（コンタンゴ）。直近の急変動を反映しており、ボラティリティは今後低下する可能性が高い。"
                  : latest.ratio_5_20 < 0.8
                  ? "短期ボラが中期より著しく低い（バックワーデーション）。市場は一時的に落ち着いているが、溜まったエネルギーが放出される可能性。"
                  : "短期・中期のボラティリティは概ね均衡。安定した状態。"}
              </p>
            </div>
          )}
        </>
      )}

      <AnalysisGuide title="ボラティリティ期間構造の詳細理論">
        <p className="font-medium text-gray-700">1. ボラティリティ期間構造とは</p>
        <p>異なる計測窓幅（5日/20日/60日/120日）で計算した実現ボラティリティを同時に表示し、短期と長期のボラティリティ水準を比較する分析です。オプション市場のインプライドボラティリティ期間構造に対応するヒストリカル版です。</p>

        <p className="font-medium text-gray-700 mt-3">2. 実現ボラティリティの計算</p>
        <p>{"窓幅 N 日の年率実現ボラティリティ: σ_N(t) = std(r_{t-N+1}, ..., r_t) × √252"}</p>
        <p>{"ここで r_t = ln(P_t / P_{t-1}) は日次対数リターン。短い窓幅ほど直近の変動に敏感に反応します。"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 期間構造比率の解釈</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>比率 &gt; 1 (コンタンゴ)</strong>: 短期vol &gt; 長期vol。直近のボラティリティが過去の平均より高い。急変動（暴落/急騰）直後に典型的に出現。ボラティリティは平均回帰する傾向があるため、今後の低下を示唆。</li>
          <li><strong>比率 ≈ 1 (フラット)</strong>: 短期と長期のボラティリティが均衡。安定した市場状態。</li>
          <li><strong>比率 &lt; 1 (バックワーデーション)</strong>: 短期vol &lt; 長期vol。市場が一時的に落ち着いている状態。低ボラティリティ環境では、突然のボラティリティ急騰（vol explosion）のリスクがある。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. ボラティリティの平均回帰</p>
        <p>実現ボラティリティは長期的な平均水準に回帰する強い傾向があります。これはGARCH(1,1)モデルで理論的に説明されます。期間構造比率が極端な値を取った場合、ボラティリティは長期平均に向かって変化すると予想されます。</p>

        <p className="font-medium text-gray-700 mt-3">5. トレード戦略への応用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>短期/長期比率が極端に高い → ボラティリティの売り戦略（オプション売り等）が有利な可能性</li>
          <li>短期/長期比率が極端に低い → ボラティリティの買い戦略（ストラドル等）でジャンプリスクに備える</li>
          <li>期間構造の変化速度自体も情報を持つ。急激な変化はレジーム転換のシグナルとなり得る</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
