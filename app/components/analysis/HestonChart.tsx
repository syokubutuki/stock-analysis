"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { fitHeston, simulateHeston } from "../../lib/heston";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function HestonChart({ prices }: Props) {
  const priceCanvasRef = useRef<HTMLCanvasElement>(null);
  const volCanvasRef = useRef<HTMLCanvasElement>(null);

  const returns = useMemo(() => {
    const r: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i].close > 0 && prices[i - 1].close > 0) {
        r.push(Math.log(prices[i].close / prices[i - 1].close));
      }
    }
    return r;
  }, [prices]);

  const result = useMemo(() => {
    const params = fitHeston(returns);
    const lastPrice = prices[prices.length - 1]?.close ?? 100;
    return simulateHeston(params, lastPrice, 60, 500, 42);
  }, [returns, prices]);

  // Price fan chart
  useEffect(() => {
    const canvas = priceCanvasRef.current;
    if (!canvas) return;
    drawFanChart(canvas, result.percentiles, result.paths.map(p => p.price), "Heston 60日価格予測");
  }, [result]);

  // Vol paths
  useEffect(() => {
    const canvas = volCanvasRef.current;
    if (!canvas || result.paths.length === 0) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 140;
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

    const pad = { top: 15, right: 10, bottom: 20, left: 50 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const days = result.paths[0].vol.length;
    let maxVol = 0;
    for (const path of result.paths) {
      for (const v of path.vol) if (v > maxVol) maxVol = v;
    }
    maxVol *= 1.1;

    const toX = (t: number) => pad.left + (t / (days - 1)) * plotW;
    const toY = (v: number) => pad.top + (1 - v / maxVol) * plotH;

    // θ line
    const thetaVol = Math.sqrt(result.params.theta);
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, toY(thetaVol));
    ctx.lineTo(width - pad.right, toY(thetaVol));
    ctx.stroke();
    ctx.setLineDash([]);

    // Vol paths
    const colors = ["#2563eb", "#059669", "#d97706", "#7c3aed", "#db2777"];
    for (let p = 0; p < Math.min(result.paths.length, 5); p++) {
      ctx.strokeStyle = colors[p];
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      for (let t = 0; t < days; t++) {
        const x = toX(t);
        const y = toY(result.paths[p].vol[t]);
        t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText((maxVol * 100).toFixed(0) + "%", pad.left - 4, pad.top + 8);
    ctx.fillText(`θ=${(thetaVol * 100).toFixed(1)}%`, pad.left - 4, toY(thetaVol) - 3);
    ctx.textAlign = "center";
    ctx.fillText("確率ボラティリティ経路 (5パス)", width / 2, 12);
  }, [result]);

  const p = result.params;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        Heston 確率ボラティリティモデル
      </h3>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3">
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">κ (回帰速度)</div>
          <div className="font-mono text-xs">{p.kappa.toFixed(2)}</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">θ (長期vol)</div>
          <div className="font-mono text-xs">{(Math.sqrt(p.theta) * 100).toFixed(1)}%</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">ξ (vol of vol)</div>
          <div className="font-mono text-xs">{p.xi.toFixed(3)}</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">ρ (相関)</div>
          <div className="font-mono text-xs">{p.rho.toFixed(3)}</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">v₀ (現在vol)</div>
          <div className="font-mono text-xs">{(Math.sqrt(p.v0) * 100).toFixed(1)}%</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">Feller条件</div>
          <div className={`text-xs font-semibold ${result.fellerCondition ? "text-green-700" : "text-red-700"}`}>
            {result.fellerCondition ? "満たす" : "不満足"}
          </div>
        </div>
      </div>

      <div className="text-xs text-gray-600 mb-3">{result.interpretation}</div>

      <canvas ref={priceCanvasRef} />
      <div className="mt-2">
        <canvas ref={volCanvasRef} />
      </div>

      <AnalysisGuide title="Hestonモデルの詳細理論">
        <p className="font-medium text-gray-700">1. Hestonモデルとは</p>
        <p>
          Heston(1993)モデルはボラティリティ自体がランダムに変動する「確率ボラティリティモデル」です。
          GBMではσが一定ですが、Hestonではσ²がCIR過程（平均回帰するランダム過程）に従います。
          「天気のように、ボラティリティも上がったり下がったりする」イメージです。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          {"dS/S = μdt + √v_t dW_S (価格過程)"}
          <br />
          {"dv_t = κ(θ - v_t)dt + ξ√v_t dW_v (分散過程)"}
          <br />
          {"Corr(dW_S, dW_v) = ρ (通常ρ<0: レバレッジ効果)"}
        </p>

        <p className="font-medium text-gray-700 mt-3">3. パラメータの意味</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>κ: ボラの長期平均θへの回帰速度。大きいほど速くθに戻る</li>
          <li>θ: ボラティリティの長期平均水準</li>
          <li>ξ: ボラのボラティリティ（vol of vol）。大きいほどvolの変動が激しい</li>
          <li>ρ: 価格とvolの相関。ρ{"<"}0でレバレッジ効果（下落→vol上昇）</li>
          <li>Feller条件: 2κθ {">"} ξ²なら分散が常に正（理論的に重要）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. GBMとの違い</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ボラティリティ・クラスタリングを自然にモデル化</li>
          <li>ρ{"<"}0でファットテールと負の歪度を生成</li>
          <li>オプション価格のボラティリティスマイルを説明可能</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>パラメータ推定はモーメント法（簡易版）。厳密にはMLEやMCMCが必要</li>
          <li>ジャンプは含まれない（Bates(1996)モデル=Heston+Jump）</li>
          <li>Feller条件不満足でもEuler-Maruyama法で近似シミュレーション可能</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function drawFanChart(
  canvas: HTMLCanvasElement,
  percentiles: { p5: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[] },
  paths: number[][],
  title: string
) {
  const parent = canvas.parentElement;
  if (!parent) return;
  const width = parent.clientWidth;
  const height = 240;
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

  const days = percentiles.p5.length;
  if (days === 0) return;

  const allVals = [...percentiles.p5, ...percentiles.p95];
  let minY = Math.min(...allVals);
  let maxY = Math.max(...allVals);
  const yRange = maxY - minY || 1;
  minY -= yRange * 0.05;
  maxY += yRange * 0.05;

  const toX = (t: number) => pad.left + (t / (days - 1)) * plotW;
  const toY = (v: number) => pad.top + (1 - (v - minY) / (maxY - minY)) * plotH;

  // Bands
  ctx.fillStyle = "rgba(37, 99, 235, 0.1)";
  ctx.beginPath();
  for (let t = 0; t < days; t++) ctx.lineTo(toX(t), toY(percentiles.p95[t]));
  for (let t = days - 1; t >= 0; t--) ctx.lineTo(toX(t), toY(percentiles.p5[t]));
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(37, 99, 235, 0.2)";
  ctx.beginPath();
  for (let t = 0; t < days; t++) ctx.lineTo(toX(t), toY(percentiles.p75[t]));
  for (let t = days - 1; t >= 0; t--) ctx.lineTo(toX(t), toY(percentiles.p25[t]));
  ctx.closePath();
  ctx.fill();

  // Sample paths
  for (let p = 0; p < Math.min(paths.length, 5); p++) {
    ctx.strokeStyle = `hsl(${220 + p * 30}, 60%, 60%)`;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    for (let t = 0; t < Math.min(paths[p].length, days); t++) {
      const x = toX(t);
      const y = toY(paths[p][t]);
      t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Median
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let t = 0; t < days; t++) {
    const x = toX(t);
    const y = toY(percentiles.p50[t]);
    t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = "#666";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(maxY.toFixed(0), pad.left - 4, pad.top + 8);
  ctx.fillText(minY.toFixed(0), pad.left - 4, height - pad.bottom);
  ctx.textAlign = "center";
  ctx.fillText("0日", pad.left, height - 8);
  ctx.fillText(`${days - 1}日`, width - pad.right, height - 8);
  ctx.fillText(title, width / 2, 14);
}
