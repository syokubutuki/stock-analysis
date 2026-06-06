"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { simulateFBM } from "../../lib/fbm";
import { computeDFA } from "../../lib/fractal";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function FBMChart({ prices }: Props) {
  const fanRef = useRef<HTMLCanvasElement>(null);
  const msdRef = useRef<HTMLCanvasElement>(null);

  // DFA Hurst推定
  const hurst = useMemo(() => {
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i].close > 0 && prices[i - 1].close > 0) {
        returns.push(Math.log(prices[i].close / prices[i - 1].close));
      }
    }
    const dfa = computeDFA(returns);
    return dfa.hurstExponent;
  }, [prices]);

  const result = useMemo(() => {
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i].close > 0 && prices[i - 1].close > 0) {
        returns.push(Math.log(prices[i].close / prices[i - 1].close));
      }
    }
    let vol = 0;
    for (const r of returns) vol += r * r;
    vol = Math.sqrt(vol / (returns.length || 1));

    const S0 = prices[prices.length - 1]?.close ?? 100;
    return simulateFBM(hurst, 200, 200, vol, S0, 42);
  }, [hurst, prices]);

  // Fan chart
  useEffect(() => {
    const canvas = fanRef.current;
    if (!canvas) return;
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

    const pad = { top: 20, right: 15, bottom: 25, left: 60 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const days = result.percentiles.p5.length;
    if (days === 0) return;

    const allVals = [...result.percentiles.p5, ...result.percentiles.p95];
    let minY = Math.min(...allVals);
    let maxY = Math.max(...allVals);
    const yRange = maxY - minY || 1;
    minY -= yRange * 0.05;
    maxY += yRange * 0.05;

    const toX = (t: number) => pad.left + (t / (days - 1)) * plotW;
    const toY = (v: number) => pad.top + (1 - (v - minY) / (maxY - minY)) * plotH;

    // 5-95% band
    ctx.fillStyle = "rgba(16, 185, 129, 0.1)";
    ctx.beginPath();
    for (let t = 0; t < days; t++) ctx.lineTo(toX(t), toY(result.percentiles.p95[t]));
    for (let t = days - 1; t >= 0; t--) ctx.lineTo(toX(t), toY(result.percentiles.p5[t]));
    ctx.closePath();
    ctx.fill();

    // 25-75% band
    ctx.fillStyle = "rgba(16, 185, 129, 0.2)";
    ctx.beginPath();
    for (let t = 0; t < days; t++) ctx.lineTo(toX(t), toY(result.percentiles.p75[t]));
    for (let t = days - 1; t >= 0; t--) ctx.lineTo(toX(t), toY(result.percentiles.p25[t]));
    ctx.closePath();
    ctx.fill();

    // Sample paths
    for (let p = 0; p < Math.min(result.paths.length, 5); p++) {
      ctx.strokeStyle = `hsla(${160 + p * 20}, 60%, 50%, 0.3)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let t = 0; t < result.paths[p].length && t < days; t++) {
        t === 0 ? ctx.moveTo(toX(t), toY(result.paths[p][t])) : ctx.lineTo(toX(t), toY(result.paths[p][t]));
      }
      ctx.stroke();
    }

    // Median
    ctx.strokeStyle = "#059669";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let t = 0; t < days; t++) {
      t === 0 ? ctx.moveTo(toX(t), toY(result.percentiles.p50[t])) : ctx.lineTo(toX(t), toY(result.percentiles.p50[t]));
    }
    ctx.stroke();

    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(maxY.toFixed(0), pad.left - 4, pad.top + 8);
    ctx.fillText(minY.toFixed(0), pad.left - 4, height - pad.bottom);
    ctx.textAlign = "center";
    ctx.fillText(`fBM (H=${hurst.toFixed(3)}) 200日シミュレーション`, width / 2, 14);
  }, [result, hurst]);

  // MSD log-log plot
  useEffect(() => {
    const canvas = msdRef.current;
    if (!canvas || result.msdCurve.length === 0) return;
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

    const pad = { top: 20, right: 15, bottom: 30, left: 55 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const pts = result.msdCurve.filter((p) => p.msd > 0 && p.theoretical > 0);
    if (pts.length === 0) return;

    const logTs = pts.map((p) => Math.log10(p.t));
    const logMsds = pts.map((p) => Math.log10(p.msd));
    const logTheos = pts.map((p) => Math.log10(p.theoretical));

    const allLogs = [...logMsds, ...logTheos];
    const minLX = Math.min(...logTs);
    const maxLX = Math.max(...logTs);
    const minLY = Math.min(...allLogs);
    const maxLY = Math.max(...allLogs);

    const toX = (v: number) => pad.left + ((v - minLX) / (maxLX - minLX || 1)) * plotW;
    const toY = (v: number) => pad.top + (1 - (v - minLY) / (maxLY - minLY || 1)) * plotH;

    // Theoretical line
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      i === 0 ? ctx.moveTo(toX(logTs[i]), toY(logTheos[i])) : ctx.lineTo(toX(logTs[i]), toY(logTheos[i]));
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Empirical points
    ctx.fillStyle = "#059669";
    for (let i = 0; i < pts.length; i++) {
      ctx.beginPath();
      ctx.arc(toX(logTs[i]), toY(logMsds[i]), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("log(lag)", width / 2, height - 5);
    ctx.fillText(`MSD log-log (理論傾き = ${(2 * hurst).toFixed(2)})`, width / 2, 14);
    ctx.textAlign = "left";
    ctx.fillStyle = "#059669";
    ctx.fillText("実測MSD", pad.left + 5, pad.top + 12);
    ctx.fillStyle = "#9ca3af";
    ctx.fillText("理論値", pad.left + 65, pad.top + 12);
  }, [result, hurst]);

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        分数ブラウン運動 (fBM) シミュレーション
      </h3>

      <div className="flex flex-wrap gap-2 mb-3">
        <span className={`text-xs px-2 py-1 rounded ${hurst > 0.6 ? "bg-green-100 text-green-700" : hurst < 0.4 ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-700"}`}>
          H = {hurst.toFixed(3)} {hurst > 0.6 ? "(持続性)" : hurst < 0.4 ? "(反持続性)" : "(ランダム)"}
        </span>
        <span className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-600">
          MSD傾き: 2H = {(2 * hurst).toFixed(3)}
        </span>
      </div>

      <canvas ref={fanRef} />
      <canvas ref={msdRef} className="mt-3" />

      <p className="text-xs text-gray-600 mt-2">{result.interpretation}</p>

      <AnalysisGuide title="分数ブラウン運動の詳細理論">
        <p className="font-medium text-gray-700">1. 分数ブラウン運動(fBM)とは</p>
        <p>
          通常のブラウン運動を一般化し、増分間の相関を許すモデルです。
          Hurst指数Hが0.5のとき標準ブラウン運動、H &gt; 0.5で正の相関（持続性）、
          H &lt; 0.5で負の相関（反持続性）を持ちます。
          「今日上がった株は明日も上がりやすい(H&gt;0.5)か、下がりやすい(H&lt;0.5)か」
          を定量化するモデルです。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>{"fBM自己共分散: C(s,t) = 0.5*(|s|^{2H} + |t|^{2H} - |s-t|^{2H})"}</p>
        <p>{"MSD(tau) = E[|B_H(t+tau) - B_H(t)|^2] = sigma^2 * tau^{2H}"}</p>
        <p>{"H>0.5: super-diffusion, H=0.5: normal diffusion, H<0.5: sub-diffusion"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ファンチャート: DFAで推定したHurst指数を用いたfBMパスの分布</li>
          <li>MSD plot: 実測値が理論直線に近ければモデルの妥当性が確認できる</li>
          <li>H &gt; 0.5の場合、ファンが標準BMより広がる（持続性による拡散増大）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>H &gt; 0.5: トレンドフォロー戦略が理論的に有利</li>
          <li>H &lt; 0.5: 平均回帰戦略が理論的に有利</li>
          <li>fBMに基づく予測区間はGBMとは異なり、記憶効果を反映</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Hosking法 O(n²)で生成。nは200日に制限</li>
          <li>fBMはボラティリティの時変性を捕捉しない</li>
          <li>Hurst指数は推定方法（DFA/R-S/GPH等）により異なる場合がある</li>
          <li>fBMは裁定機会を生むためリスク中立測度が存在しない（理論的制約）</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
