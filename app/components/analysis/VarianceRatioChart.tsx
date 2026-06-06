"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { computeVarianceRatio } from "../../lib/variance-ratio";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function VarianceRatioChart({ prices, seriesMode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { values } = extractSeries(prices, seriesMode);

  const returns = useMemo(() => {
    if (seriesMode === "logReturn" || seriesMode === "diff") return values;
    const r: number[] = [];
    for (let i = 1; i < values.length; i++) {
      if (values[i - 1] !== 0) r.push(Math.log(values[i] / values[i - 1]));
    }
    return r;
  }, [values, seriesMode]);

  const result = useMemo(() => computeVarianceRatio(returns), [returns]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || result.points.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const width = parent.clientWidth;
    const height = 220;
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

    const pad = { top: 25, right: 30, bottom: 35, left: 55 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const pts = result.points;
    const maxVR = Math.max(...pts.map((p) => p.vr), 1.5);
    const minVR = Math.min(...pts.map((p) => p.vr), 0.5);
    const range = maxVR - minVR;
    const yMin = minVR - range * 0.1;
    const yMax = maxVR + range * 0.1;

    const toX = (i: number) => pad.left + (i + 0.5) * (plotW / pts.length);
    const toY = (v: number) => pad.top + plotH * (1 - (v - yMin) / (yMax - yMin));

    // Grid
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    for (let y = Math.ceil(yMin * 10) / 10; y <= yMax; y += 0.2) {
      const py = toY(y);
      ctx.beginPath();
      ctx.moveTo(pad.left, py);
      ctx.lineTo(width - pad.right, py);
      ctx.stroke();
    }

    // VR=1 reference line
    const y1 = toY(1);
    ctx.strokeStyle = "#6b7280";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(pad.left, y1);
    ctx.lineTo(width - pad.right, y1);
    ctx.stroke();
    ctx.setLineDash([]);

    // 95% confidence band (approximate: VR=1 ± 1.96 * se)
    ctx.fillStyle = "rgba(156,163,175,0.12)";
    for (let i = 0; i < pts.length; i++) {
      const se = pts[i].zStat !== 0 ? Math.abs((pts[i].vr - 1) / pts[i].zStat) : 0.1;
      const upper = 1 + 1.96 * se;
      const lower = 1 - 1.96 * se;
      const barW = plotW / pts.length * 0.6;
      ctx.fillRect(toX(i) - barW / 2, toY(upper), barW, toY(lower) - toY(upper));
    }

    // Bars
    const barW = plotW / pts.length * 0.5;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const x = toX(i) - barW / 2;
      const yBar = toY(p.vr);
      const y1Line = toY(1);

      ctx.fillStyle = p.significant
        ? p.vr > 1
          ? "rgba(239,68,68,0.7)"
          : "rgba(59,130,246,0.7)"
        : "rgba(107,114,128,0.4)";

      if (p.vr >= 1) {
        ctx.fillRect(x, yBar, barW, y1Line - yBar);
      } else {
        ctx.fillRect(x, y1Line, barW, yBar - y1Line);
      }

      // VR value label
      ctx.fillStyle = "#1f2937";
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "center";
      ctx.fillText(p.vr.toFixed(3), toX(i), yBar - 5);

      // q label
      ctx.fillStyle = "#6b7280";
      ctx.font = "11px sans-serif";
      ctx.fillText(`q=${p.q}`, toX(i), height - pad.bottom + 15);

      // p-value
      ctx.font = "9px monospace";
      ctx.fillStyle = p.significant ? "#dc2626" : "#9ca3af";
      ctx.fillText(`p=${p.pValue.toFixed(3)}`, toX(i), height - pad.bottom + 27);
    }

    // Y-axis labels
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    for (let y = Math.ceil(yMin * 10) / 10; y <= yMax; y += 0.2) {
      ctx.fillText(y.toFixed(1), pad.left - 5, toY(y) + 3);
    }

    // Title
    ctx.fillStyle = "#374151";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("VR(q)", pad.left, pad.top - 8);
    ctx.textAlign = "right";
    ctx.fillText("VR=1: ランダムウォーク", width - pad.right, pad.top - 8);
  }, [result]);

  if (result.points.length === 0) return null;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">
        分散比検定 (Lo-MacKinlay Variance Ratio Test)
      </h3>

      <div className="flex flex-wrap gap-2 mb-3">
        <span
          className={`text-xs px-2 py-1 rounded ${
            result.isRandomWalk
              ? "bg-gray-100 text-gray-700"
              : "bg-red-100 text-red-700"
          }`}
        >
          {result.isRandomWalk ? "ランダムウォーク棄却不可" : "ランダムウォーク棄却"}
        </span>
        {result.points
          .filter((p) => p.significant)
          .map((p) => (
            <span
              key={p.q}
              className={`text-xs px-2 py-1 rounded ${
                p.vr > 1
                  ? "bg-red-50 text-red-600"
                  : "bg-blue-50 text-blue-600"
              }`}
            >
              q={p.q}: {p.vr > 1 ? "モメンタム" : "平均回帰"}
            </span>
          ))}
      </div>

      <canvas ref={canvasRef} />

      <p className="text-xs text-gray-600 mt-2">{result.interpretation}</p>

      <AnalysisGuide title="分散比検定の詳細理論">
        <p className="font-medium text-gray-700">1. 分散比検定とは</p>
        <p>
          ランダムウォーク仮説の直接的な検定手法です。もし株価がランダムウォークに従うなら、
          q日間のリターンの分散はちょうど1日リターンの分散のq倍になるはずです。
          これは「コイン投げの結果を10回分まとめても、各回の分散の10倍になる」という
          独立同分布の基本性質に基づいています。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>{"VR(q) = Var(r_t(q)) / [q * Var(r_t)]"}</p>
        <p>{"r_t(q) = r_t + r_{t+1} + ... + r_{t+q-1} (q期間の重複リターン)"}</p>
        <p>{"Lo-MacKinlay Z統計量: Z = (VR(q) - 1) / sqrt(theta(q))"}</p>
        <p>{"theta(q)はヘテロスケダスティシティ（分散不均一性）に頑健な標準誤差"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>VR(q) = 1: ランダムウォーク（リターンが独立、予測不能）</li>
          <li>VR(q) &gt; 1: 正の自己相関（モメンタム）。上昇が続きやすい/下落が続きやすい</li>
          <li>VR(q) &lt; 1: 負の自己相関（平均回帰）。上昇後に下落しやすい/その逆</li>
          <li>赤色のバー: 統計的に有意（p &lt; 0.05）</li>
          <li>灰色のバー: 有意でない（ランダムウォークと矛盾しない）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>VR &gt; 1が有意 → トレンドフォロー/モメンタム戦略が有効な可能性</li>
          <li>VR &lt; 1が有意 → 逆張り/ミーンリバージョン戦略が有効な可能性</li>
          <li>短期(q=2,4)と長期(q=16,32)でパターンが異なる場合、時間軸別の戦略切り替えを検討</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>VRの有意性は標本サイズに依存。短い期間では検出力が低い</li>
          <li>GARCHクラスタリング（ボラティリティの時変性）がVRに影響する可能性がある</li>
          <li>ヘテロスケダスティシティ頑健Z統計量を使用し、この影響を軽減している</li>
          <li>過去のVRパターンが将来も持続する保証はない</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
