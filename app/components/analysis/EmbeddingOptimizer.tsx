"use client";

import { useMemo, useRef, useEffect, useState } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  autoMutualInformation,
  falseNearestNeighbors,
} from "../../lib/attractor-investment";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function EmbeddingOptimizer({ prices, seriesMode }: Props) {
  const amiCanvasRef = useRef<HTMLCanvasElement>(null);
  const fnnCanvasRef = useRef<HTMLCanvasElement>(null);
  const [maxLag, setMaxLag] = useState(30);

  const { values } = extractSeries(prices, seriesMode);

  const amiResult = useMemo(
    () => autoMutualInformation(values, maxLag),
    [values, maxLag]
  );

  const fnnResult = useMemo(
    () => falseNearestNeighbors(values, amiResult.optimalTau, 10),
    [values, amiResult.optimalTau]
  );

  // Draw AMI chart
  useEffect(() => {
    const canvas = amiCanvasRef.current;
    if (!canvas || amiResult.lags.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement?.clientWidth || 400;
    const height = 220;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const m = { left: 55, right: 20, top: 30, bottom: 35 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const maxAMI = Math.max(...amiResult.ami, 0.001);
    const maxLagVal = amiResult.lags[amiResult.lags.length - 1] || 1;

    const toX = (lag: number) => m.left + (lag / maxLagVal) * plotW;
    const toY = (v: number) => m.top + plotH - (v / maxAMI) * plotH;

    // Grid
    ctx.strokeStyle = "#f0f0f0";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = m.top + (plotH / 5) * i;
      ctx.beginPath(); ctx.moveTo(m.left, y); ctx.lineTo(m.left + plotW, y); ctx.stroke();
    }

    // AMI curve
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    amiResult.lags.forEach((lag, i) => {
      const x = toX(lag);
      const y = toY(amiResult.ami[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill under curve
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = "#3b82f6";
    ctx.beginPath();
    ctx.moveTo(toX(amiResult.lags[0]), m.top + plotH);
    amiResult.lags.forEach((lag, i) => ctx.lineTo(toX(lag), toY(amiResult.ami[i])));
    ctx.lineTo(toX(amiResult.lags[amiResult.lags.length - 1]), m.top + plotH);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Optimal tau marker
    const optIdx = amiResult.firstMinIdx;
    const optX = toX(amiResult.lags[optIdx]);
    const optY = toY(amiResult.ami[optIdx]);

    // Vertical dashed line
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(optX, m.top); ctx.lineTo(optX, m.top + plotH); ctx.stroke();
    ctx.setLineDash([]);

    // Circle at optimal point
    ctx.fillStyle = "#ef4444";
    ctx.beginPath(); ctx.arc(optX, optY, 6, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(optX, optY, 3, 0, 2 * Math.PI); ctx.fill();

    // Label
    ctx.fillStyle = "#ef4444";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`optimal τ = ${amiResult.optimalTau}`, optX, optY - 12);

    // 1/e threshold line
    const threshY = toY(amiResult.ami[0] / Math.E);
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 0.8;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(m.left, threshY); ctx.lineTo(m.left + plotW, threshY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("1/e 閾値", m.left + 3, threshY - 3);

    // Title and axes
    ctx.fillStyle = "#374151";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("自己相互情報量 (AMI)", width / 2, 14);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("遅延 τ (ラグ)", width / 2, height - 5);
    ctx.save();
    ctx.translate(12, m.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("MI(τ) [nats]", 0, 0);
    ctx.restore();

    // X-axis ticks
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    for (let lag = 0; lag <= maxLagVal; lag += Math.max(1, Math.floor(maxLagVal / 6))) {
      ctx.fillText(String(lag), toX(lag), height - 20);
    }
  }, [amiResult]);

  // Draw FNN chart
  useEffect(() => {
    const canvas = fnnCanvasRef.current;
    if (!canvas || fnnResult.dimensions.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement?.clientWidth || 400;
    const height = 220;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const m = { left: 55, right: 20, top: 30, bottom: 35 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const dims = fnnResult.dimensions;
    const maxDim = dims[dims.length - 1] || 1;
    const maxFNN = Math.max(...fnnResult.fnnRatio, 0.01);

    const toX = (d: number) => m.left + ((d - 1) / (maxDim - 1 || 1)) * plotW;
    const toY = (v: number) => m.top + plotH - (v / maxFNN) * plotH;

    // Grid
    ctx.strokeStyle = "#f0f0f0";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = m.top + (plotH / 5) * i;
      ctx.beginPath(); ctx.moveTo(m.left, y); ctx.lineTo(m.left + plotW, y); ctx.stroke();
    }

    // 5% threshold
    const threshY = toY(0.05 * maxFNN / maxFNN);
    if (0.05 <= maxFNN) {
      const ty = toY(0.05);
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(m.left, ty); ctx.lineTo(m.left + plotW, ty); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#22c55e";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText("5% 閾値", m.left + plotW - 3, ty - 4);
    }

    // Bar chart
    const barW = plotW / (maxDim + 1) * 0.7;
    dims.forEach((d, i) => {
      const x = toX(d) - barW / 2;
      const y = toY(fnnResult.fnnRatio[i]);
      const h = m.top + plotH - y;

      const isOptimal = d === fnnResult.optimalDim;
      ctx.fillStyle = isOptimal ? "#ef4444" : "#8b5cf6";
      ctx.globalAlpha = isOptimal ? 0.9 : 0.6;
      ctx.fillRect(x, y, barW, h);
      ctx.globalAlpha = 1;

      // Value labels
      ctx.fillStyle = "#374151";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${(fnnResult.fnnRatio[i] * 100).toFixed(0)}%`, toX(d), y - 4);
    });

    // Optimal dim marker
    ctx.fillStyle = "#ef4444";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    const optX = toX(fnnResult.optimalDim);
    ctx.fillText(`d* = ${fnnResult.optimalDim}`, optX, m.top + 15);

    // Title and axes
    ctx.fillStyle = "#374151";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("偽最近傍率 (FNN)", width / 2, 14);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("埋め込み次元 d", width / 2, height - 5);
    ctx.save();
    ctx.translate(12, m.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("FNN率", 0, 0);
    ctx.restore();

    // X-axis ticks
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    dims.forEach(d => ctx.fillText(String(d), toX(d), height - 20));
  }, [fnnResult]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        埋め込みパラメータ最適化 (AMI + FNN)
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        Takens埋め込みの遅延τと次元dをデータ駆動で決定
      </p>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-xs">
        <div className="p-2 bg-blue-50 rounded">
          <div className="text-blue-600">最適遅延 τ</div>
          <div className="font-bold text-lg">{amiResult.optimalTau}</div>
          <div className="text-blue-500">AMI最初の極小</div>
        </div>
        <div className="p-2 bg-purple-50 rounded">
          <div className="text-purple-600">最適埋め込み次元 d</div>
          <div className="font-bold text-lg">{fnnResult.optimalDim}</div>
          <div className="text-purple-500">FNN率 {"<"} 5%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">AMI(0)</div>
          <div className="font-bold">{amiResult.ami[0]?.toFixed(3) ?? "—"}</div>
          <div className="text-gray-400">初期相互情報量</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">FNN(d*)</div>
          <div className="font-bold">
            {fnnResult.fnnRatio.length > 0
              ? `${(fnnResult.fnnRatio[fnnResult.optimalDim - 1] * 100).toFixed(1)}%`
              : "—"}
          </div>
          <div className="text-gray-400">最適次元でのFNN率</div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex gap-4 mb-3 text-xs">
        <label className="flex items-center gap-2">
          <span className="text-gray-500">最大ラグ:</span>
          <input
            type="range" min={10} max={60} value={maxLag}
            onChange={e => setMaxLag(Number(e.target.value))}
            className="w-24 accent-blue-600"
          />
          <span className="text-gray-700 font-medium w-6">{maxLag}</span>
        </label>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <div>
          <canvas ref={amiCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <canvas ref={fnnCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      <AnalysisGuide title="埋め込みパラメータ最適化の詳細解説">
        <div className="space-y-3">
          <div>
            <p className="font-medium text-gray-700 mb-1">1. 自己相互情報量 (AMI) — 最適τの選択</p>
            <p>Takens埋め込みの遅延パラメータτを最適に選ぶ手法です。</p>
            <div className="bg-gray-50 rounded p-2 my-2 font-mono text-xs">
              AMI(τ) = Σ p(x(t), x(t+τ)) · log[ p(x(t), x(t+τ)) / (p(x(t)) · p(x(t+τ))) ]
            </div>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li><span className="font-medium">AMI(τ) が大きい</span> → x(t) と x(t+τ) の間に強い統計的依存性がある → 座標軸が冗長 → アトラクタが対角線方向に潰れる</li>
              <li><span className="font-medium">AMI(τ) が小さい</span> → 独立に近い → 座標軸が十分に広がる</li>
              <li><span className="font-medium">最初の極小値</span> = 独立性と関連性のバランスが最適。ここがτの推奨値</li>
              <li><span className="font-medium">1/e 閾値</span> = AMI(0)の約37%。極小が不明確な場合のフォールバック</li>
            </ul>
            <p className="text-xs mt-1">線形自己相関の最初のゼロ交差と異なり、AMIは<span className="font-medium">非線形依存性</span>も捉えます。</p>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">2. 偽最近傍法 (FNN) — 最適埋め込み次元の選択</p>
            <p>埋め込み次元dが不十分だと、本来離れている点が低次元への射影によって「偽の近傍」になります。</p>
            <div className="bg-gray-50 rounded p-2 my-2 font-mono text-xs">
              d次元で最近傍の点対 (i, j) に対し:<br/>
              FNN判定: |x(i + d·τ) - x(j + d·τ)| / dist_d(i, j) {">"} R_threshold<br/>
              (R_threshold = 15.0 が標準)<br/><br/>
              FNN率(d) = 偽近傍の数 / 全近傍対の数
            </div>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li><span className="font-medium">FNN率が高い</span> → 次元が不足 → 位相空間上の構造が正しく展開されていない</li>
              <li><span className="font-medium">FNN率 {"<"} 5%</span> → 十分な次元 → それ以上次元を上げても改善しない</li>
              <li><span className="font-medium">低次元(d=3〜5)で飽和</span> → 低次元の決定論的構造あり → <span className="text-green-600">テクニカル分析が有効な銘柄</span></li>
              <li><span className="font-medium">高次元(d{">"}10)でも飽和しない</span> → ランダム性が支配的 → <span className="text-red-600">系統的予測が困難</span></li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">3. 投資判断への接続</p>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li>ここで決定されたτとdが、以降の<span className="font-medium">全てのアトラクタ解析の基盤パラメータ</span>となります</li>
              <li>FNN飽和次元そのものが銘柄の「力学的複雑さ」の指標: 低次元飽和 = パターンが存在 = テクニカル分析向き</li>
              <li>AMIの形状自体も情報: 緩やかに減衰 → 長期記憶あり / 急減衰 → 短期記憶のみ</li>
            </ul>
          </div>
        </div>
      </AnalysisGuide>
    </div>
  );
}
