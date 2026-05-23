"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { logReturns } from "../../lib/transforms";
import { computeAnalyticSignal, analyticSignalStats } from "../../lib/analytic-signal";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function AnalyticSignalChart({ prices }: Props) {
  const ampRef = useRef<HTMLDivElement>(null);
  const freqRef = useRef<HTMLDivElement>(null);
  const phaseCanvasRef = useRef<HTMLCanvasElement>(null);
  const ampChartRef = useRef<IChartApi | null>(null);
  const freqChartRef = useRef<IChartApi | null>(null);

  const closes = prices.map((p) => p.close);
  const times = prices.map((p) => p.time);
  const lr = logReturns(closes);
  const lrTimes = times.slice(1);

  const result = useMemo(() => computeAnalyticSignal(lr), [prices]);
  const stats = useMemo(() => analyticSignalStats(result), [result]);

  // 瞬時振幅チャート（対数リターン + エンベロープ）
  useEffect(() => {
    if (!ampRef.current) return;
    if (ampChartRef.current) ampChartRef.current.remove();

    const chart = createChart(ampRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: ampRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    ampChartRef.current = chart;

    // 対数リターン
    const returnSeries = chart.addSeries(LineSeries, {
      color: "#94a3b8",
      lineWidth: 1,
      title: "log return",
    });
    returnSeries.setData(
      lr.map((v, i) => ({ time: lrTimes[i] as Time, value: v }))
    );

    // 瞬時振幅 (上側エンベロープ)
    const ampSeries = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 2,
      title: "瞬時振幅 A(t)",
    });
    ampSeries.setData(
      result.amplitude.map((v, i) => ({ time: lrTimes[i] as Time, value: v }))
    );

    // 瞬時振幅 (下側エンベロープ、反転)
    const ampNegSeries = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 2,
      title: "-A(t)",
    });
    ampNegSeries.setData(
      result.amplitude.map((v, i) => ({ time: lrTimes[i] as Time, value: -v }))
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (ampRef.current)
        chart.applyOptions({ width: ampRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      ampChartRef.current = null;
    };
  }, [prices, result]);

  // 瞬時周波数チャート
  useEffect(() => {
    if (!freqRef.current) return;
    if (freqChartRef.current) freqChartRef.current.remove();

    const chart = createChart(freqRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: freqRef.current.clientWidth,
      height: 160,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    freqChartRef.current = chart;

    // 瞬時周期 (日) — 上限をクリップして表示
    const maxDisplay = 60;
    const periodSeries = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      title: "瞬時周期 (日)",
    });
    periodSeries.setData(
      result.instPeriod.map((v, i) => ({
        time: lrTimes[i] as Time,
        value: Math.min(v, maxDisplay),
      }))
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (freqRef.current)
        chart.applyOptions({ width: freqRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      freqChartRef.current = null;
    };
  }, [prices, result]);

  // 位相の極座標プロット (Canvas)
  useEffect(() => {
    const canvas = phaseCanvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const size = 280;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const cx = size / 2;
    const cy = size / 2;
    const maxR = size / 2 - 30;

    // 背景
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);

    // 同心円ガイド
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    for (let r = 0.25; r <= 1; r += 0.25) {
      ctx.beginPath();
      ctx.arc(cx, cy, maxR * r, 0, 2 * Math.PI);
      ctx.stroke();
    }
    // 十字線
    ctx.beginPath();
    ctx.moveTo(cx - maxR, cy);
    ctx.lineTo(cx + maxR, cy);
    ctx.moveTo(cx, cy - maxR);
    ctx.lineTo(cx, cy + maxR);
    ctx.stroke();

    // データの正規化
    const maxAmp = Math.max(...result.amplitude) || 1;
    const n = result.amplitude.length;

    // 軌跡を描画（時間を色のグラデーションで表現）
    for (let i = 1; i < n; i++) {
      const r1 = (result.amplitude[i - 1] / maxAmp) * maxR;
      const r2 = (result.amplitude[i] / maxAmp) * maxR;
      // unwrappedのphaseをmod 2πに戻して表示
      const theta1 = result.phase[i - 1] % (2 * Math.PI);
      const theta2 = result.phase[i] % (2 * Math.PI);

      const x1 = cx + r1 * Math.cos(theta1);
      const y1 = cy - r1 * Math.sin(theta1);
      const x2 = cx + r2 * Math.cos(theta2);
      const y2 = cy - r2 * Math.sin(theta2);

      const t = i / n;
      const r = Math.round(59 + t * 100);
      const g = Math.round(130 - t * 80);
      const b = Math.round(246 - t * 150);

      ctx.strokeStyle = `rgba(${r},${g},${b},0.6)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // 最新の点を強調
    const lastR = (result.amplitude[n - 1] / maxAmp) * maxR;
    const lastTheta = result.phase[n - 1] % (2 * Math.PI);
    const lastX = cx + lastR * Math.cos(lastTheta);
    const lastY = cy - lastR * Math.sin(lastTheta);
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4, 0, 2 * Math.PI);
    ctx.fill();

    // ラベル
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("0", cx + maxR + 12, cy + 4);
    ctx.fillText("π/2", cx, cy - maxR - 6);
    ctx.fillText("π", cx - maxR - 12, cy + 4);
    ctx.fillText("3π/2", cx, cy + maxR + 14);
  }, [result]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        解析信号 (Analytic Signal) / 瞬時周波数
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        Hilbert変換で対数リターンを複素解析信号に拡張 — 振動の瞬時状態を抽出
      </p>

      {/* 統計カード */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
        <StatCard label="平均振幅" value={`${(stats.meanAmplitude * 100).toFixed(3)}%`} />
        <StatCard label="振幅の標準偏差" value={`${(stats.stdAmplitude * 100).toFixed(3)}%`} />
        <StatCard label="平均周波数" value={`${stats.meanFrequency.toFixed(4)} c/d`} />
        <StatCard label="中央周期" value={`${stats.medianPeriod.toFixed(1)} 日`} />
        <StatCard
          label="周波数安定性"
          value={stats.freqStability < 0.5 ? "安定" : stats.freqStability < 1.0 ? "中程度" : "不安定"}
          sub={`CV=${stats.freqStability.toFixed(2)}`}
        />
      </div>

      {/* 瞬時振幅チャート */}
      <div className="text-xs text-gray-500 mb-1">
        瞬時振幅 A(t) = |z(t)| (赤) とリターン信号 (灰)
      </div>
      <div ref={ampRef} className="w-full rounded border border-gray-100" />

      {/* 瞬時周波数チャート */}
      <div className="mt-3 text-xs text-gray-500 mb-1">
        瞬時周期 T(t) = 1/f(t) [日] — 振動サイクルの長さの時間変化
      </div>
      <div ref={freqRef} className="w-full rounded border border-gray-100" />

      {/* 位相の極座標プロット */}
      <div className="mt-3 flex flex-col sm:flex-row gap-4 items-start">
        <div>
          <div className="text-xs text-gray-500 mb-1">
            解析信号の極座標表現 z(t) = A(t)e^(i*phi(t))
          </div>
          <canvas
            ref={phaseCanvasRef}
            className="rounded border border-gray-100"
          />
          <div className="text-xs text-gray-400 mt-1">
            半径=振幅, 角度=位相, 色=時間(青→赤), 赤点=最新
          </div>
        </div>
        <div className="text-xs text-gray-600 space-y-2 flex-1 min-w-0">
          <div className="p-2 bg-blue-50 rounded">
            <div className="font-medium text-blue-800">瞬時振幅が大きい区間</div>
            <div>ボラティリティが高い局面。EWMA volatilityと比較して、解析信号の振幅はより素早く反応する。</div>
          </div>
          <div className="p-2 bg-green-50 rounded">
            <div className="font-medium text-green-800">瞬時周期が長い区間</div>
            <div>ゆっくりした大きな波。機関投資家のトレンドフォローやマクロ要因が支配的。</div>
          </div>
          <div className="p-2 bg-orange-50 rounded">
            <div className="font-medium text-orange-800">瞬時周期が短い区間</div>
            <div>高頻度の往復。短期投機的なノイズが支配的。テクニカル分析の信頼性が低下。</div>
          </div>
        </div>
      </div>

      <AnalysisGuide title="解析信号と瞬時周波数の読み方">
        <p>
          <span className="font-medium">解析信号とは:</span> 実数の株価リターン x(t)
          にHilbert変換 H[x](t) を虚部として付加した複素信号 z(t) = x(t) + i*H[x](t) です。
          これにより、振動の「振幅」と「位相」を各時点で独立に取り出せます。
        </p>
        <p>
          <span className="font-medium">Hilbert変換の本質:</span> 各周波数成分の位相を90度ずらす演算です。
          cos(wt) を sin(wt) に変換するのと同じことを、全周波数に対して同時に行います。
          周波数領域では「負の周波数成分を消去する」ことに相当します。
        </p>
        <p>
          <span className="font-medium">瞬時振幅 A(t):</span> リターン系列の包絡線(エンベロープ)。
          EWMAボラティリティが過去の加重平均であるのに対し、瞬時振幅はより局所的な振動の強さを直接表します。
        </p>
        <p>
          <span className="font-medium">瞬時周波数 f(t):</span> 位相の時間微分 f(t) = (1/2π) dφ/dt。
          FFTが「全期間の平均周波数」しか返さないのに対し、瞬時周波数は各時点での振動速度を与えます。
          逆数が瞬時周期で、「今この瞬間の振動サイクルが何日か」を意味します。
        </p>
        <p>
          <span className="font-medium">極座標プロット:</span> 複素平面上で z(t) の軌跡を描画しています。
          半径が振幅、角度が位相です。安定した振動は一定半径での回転として現れ、
          ボラティリティの変化は半径の伸縮として現れます。
        </p>
        <p>
          <span className="font-medium">注意点:</span> 生のリターン系列は広帯域なので、
          瞬時周波数が物理的に無意味な値を取ることがあります(Bedrosianの定理)。
          より厳密にはEMDで狭帯域IMFに分解してからHilbert変換を適用します(EMDチャート参照)。
        </p>
      </AnalysisGuide>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="p-2 bg-gray-50 rounded text-xs">
      <div className="text-gray-500">{label}</div>
      <div className="font-bold text-gray-800">{value}</div>
      {sub && <div className="text-gray-400">{sub}</div>}
    </div>
  );
}
