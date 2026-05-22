"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { logReturns } from "../../lib/transforms";
import { histogram, qqPlot, normalPDF, distributionStats } from "../../lib/distribution";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function ReturnDistribution({ prices }: Props) {
  const histRef = useRef<HTMLCanvasElement>(null);
  const qqRef = useRef<HTMLCanvasElement>(null);

  const closes = prices.map((p) => p.close);
  const lr = logReturns(closes);
  const stats = useMemo(() => distributionStats(lr), [prices]);
  const hist = useMemo(() => histogram(lr, 50), [prices]);
  const qq = useMemo(() => qqPlot(lr), [prices]);

  // ヒストグラム + 正規分布PDF
  useEffect(() => {
    const canvas = histRef.current;
    if (!canvas || hist.length === 0) return;
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

    const margin = { top: 15, right: 15, bottom: 25, left: 50 };
    const pw = width - margin.left - margin.right;
    const ph = height - margin.top - margin.bottom;

    const maxDensity = Math.max(...hist.map((h) => h.density), normalPDF(stats.mean, stats.mean, stats.std));
    const minX = hist[0].x;
    const maxX = hist[hist.length - 1].x;
    const rangeX = maxX - minX || 1;

    const toX = (v: number) => margin.left + ((v - minX) / rangeX) * pw;
    const toY = (v: number) => margin.top + ph - (v / (maxDensity * 1.1)) * ph;

    // ヒストグラム
    const barW = pw / hist.length;
    for (const bin of hist) {
      const x = toX(bin.x) - barW / 2;
      const y = toY(bin.density);
      const h = toY(0) - y;
      ctx.fillStyle = bin.x >= 0 ? "rgba(38, 166, 154, 0.5)" : "rgba(239, 83, 80, 0.5)";
      ctx.fillRect(x, y, barW - 1, h);
    }

    // 正規分布PDF曲線
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= pw; i++) {
      const x = minX + (i / pw) * rangeX;
      const y = normalPDF(x, stats.mean, stats.std);
      const px = margin.left + i;
      const py = toY(y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // 軸ラベル
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.fillText("リターン", width / 2 - 15, height - 4);
    ctx.fillText("密度", margin.left - 25, margin.top + 10);
  }, [hist, stats]);

  // QQプロット
  useEffect(() => {
    const canvas = qqRef.current;
    if (!canvas || qq.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const size = Math.min(parent.clientWidth, 300);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, size, size);

    const margin = 35;
    const ps = size - 2 * margin;

    const allVals = qq.flatMap((p) => [p.theoretical, p.observed]);
    const min = Math.min(...allVals);
    const max = Math.max(...allVals);
    const range = max - min || 1;

    const toP = (v: number) => margin + ((v - min) / range) * ps;
    const toYP = (v: number) => size - margin - ((v - min) / range) * ps;

    // 45度線
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(margin, size - margin);
    ctx.lineTo(size - margin, margin);
    ctx.stroke();
    ctx.setLineDash([]);

    // 点
    ctx.fillStyle = "rgba(37, 99, 235, 0.5)";
    for (const p of qq) {
      ctx.beginPath();
      ctx.arc(toP(p.theoretical), toYP(p.observed), 2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.fillText("理論分位(正規)", size / 2 - 30, size - 5);
    ctx.save();
    ctx.translate(10, size / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("観測分位", -20, 0);
    ctx.restore();
  }, [qq]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">リターン分布</h3>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <div className="text-xs text-gray-500 mb-1">ヒストグラム + 正規分布フィット (青線)</div>
          <div className="w-full rounded border border-gray-100 overflow-hidden">
            <canvas ref={histRef} />
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">Q-Qプロット (vs 正規分布)</div>
          <div className="flex justify-center rounded border border-gray-100 overflow-hidden">
            <canvas ref={qqRef} />
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均</div>
          <div className="font-mono font-medium">{(stats.mean * 100).toFixed(4)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">標準偏差</div>
          <div className="font-mono font-medium">{(stats.std * 100).toFixed(4)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">歪度</div>
          <div className={`font-mono font-medium ${Math.abs(stats.skewness) > 0.5 ? "text-orange-600" : ""}`}>{stats.skewness.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">超過尖度</div>
          <div className={`font-mono font-medium ${stats.kurtosis > 1 ? "text-red-600" : ""}`}>{stats.kurtosis.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Jarque-Bera</div>
          <div className="font-mono font-medium">{stats.jarqueBera.toFixed(2)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">正規性</div>
          <div className={`font-mono font-medium ${stats.jbPValue < 0.05 ? "text-red-600" : "text-green-600"}`}>
            {stats.jbPValue < 0.05 ? "棄却" : "不棄却"}
          </div>
        </div>
      </div>

      <AnalysisGuide title="リターン分布の読み方">
        <p><span className="font-medium">ヒストグラム:</span> 日次対数リターンの出現頻度を表示しています。青い曲線は同じ平均・標準偏差を持つ正規分布のPDFです。正規分布と実際の分布の乖離がテールリスクの正体です。</p>
        <p><span className="font-medium">Q-Qプロット:</span> 観測値の分位と正規分布の理論分位を対比させた散布図です。点が赤い45度線上に乗っていれば正規分布に従っています。</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">両端で45度線から上に離れる(S字):</span> ファットテール。極端な値動きが正規分布の予測より多い。</li>
          <li><span className="font-medium">片方だけ離れる:</span> 非対称なテール。上か下の一方だけリスクが大きい。</li>
        </ul>
        <p><span className="font-medium">Jarque-Bera検定:</span> 歪度と尖度から正規性を検定します。p値が0.05未満なら「正規分布ではない」と判定(棄却)。株式リターンはほぼ常に棄却されます。</p>
        <p><span className="font-medium">トレードへの活用:</span> 超過尖度が大きい銘柄は、VaR等の正規分布ベースのリスク計算が過小評価になります。テールリスクを意識したポジションサイズ管理が必要です。</p>
      </AnalysisGuide>
    </div>
  );
}
