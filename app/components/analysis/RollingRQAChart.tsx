"use client";

import { useMemo, useRef, useEffect, useState } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { rollingRQA, type RollingRQAResult } from "../../lib/attractor-investment";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function RollingRQAChart({ prices, seriesMode }: Props) {
  const detLamRef = useRef<HTMLDivElement>(null);
  const entropyRef = useRef<HTMLDivElement>(null);
  const detLamChartRef = useRef<IChartApi | null>(null);
  const entropyChartRef = useRef<IChartApi | null>(null);
  const [windowSize, setWindowSize] = useState(100);

  const { values, times } = extractSeries(prices, seriesMode);

  const result: RollingRQAResult = useMemo(
    () => rollingRQA(values, times, windowSize, 1, 3, 3),
    [values, times, windowSize]
  );

  // DET + LAM chart
  useEffect(() => {
    if (!detLamRef.current || result.data.length === 0) return;
    if (detLamChartRef.current) detLamChartRef.current.remove();

    const chart = createChart(detLamRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: detLamRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    detLamChartRef.current = chart;

    const detSeries = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      title: "DET (決定性)",
    });
    const lamSeries = chart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 2,
      title: "LAM (層状性)",
    });
    const rrSeries = chart.addSeries(LineSeries, {
      color: "#9ca3af",
      lineWidth: 1,
      title: "RR (再帰率)",
    });

    detSeries.setData(result.data.map(d => ({ time: d.time as Time, value: d.det })));
    lamSeries.setData(result.data.map(d => ({ time: d.time as Time, value: d.lam })));
    rrSeries.setData(result.data.map(d => ({ time: d.time as Time, value: d.recurrenceRate })));
    chart.timeScale().fitContent();

    const handleResize = () => {
      if (detLamRef.current) chart.applyOptions({ width: detLamRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); detLamChartRef.current = null; };
  }, [result]);

  // Entropy + Trapping Time chart
  useEffect(() => {
    if (!entropyRef.current || result.data.length === 0) return;
    if (entropyChartRef.current) entropyChartRef.current.remove();

    const chart = createChart(entropyRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: entropyRef.current.clientWidth,
      height: 160,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    entropyChartRef.current = chart;

    const entropySeries = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 2,
      title: "ENTR (エントロピー)",
    });
    const ttSeries = chart.addSeries(LineSeries, {
      color: "#22c55e",
      lineWidth: 2,
      title: "TT (トラッピング時間)",
      priceScaleId: "right2",
    });

    entropySeries.setData(result.data.map(d => ({ time: d.time as Time, value: d.diagEntropy })));
    ttSeries.setData(result.data.map(d => ({ time: d.time as Time, value: d.trappingTime })));
    chart.timeScale().fitContent();

    const handleResize = () => {
      if (entropyRef.current) chart.applyOptions({ width: entropyRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); entropyChartRef.current = null; };
  }, [result]);

  // Current values
  const latest = result.data.length > 0 ? result.data[result.data.length - 1] : null;
  const avg = result.data.length > 0
    ? {
        det: result.data.reduce((a, d) => a + d.det, 0) / result.data.length,
        lam: result.data.reduce((a, d) => a + d.lam, 0) / result.data.length,
      }
    : { det: 0, lam: 0 };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        ローリングRQA (リカレンス定量化分析)
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        リカレンスプロットの統計指標を時系列化し、レジーム転換を検出
      </p>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3 text-xs">
        <div className="p-2 bg-blue-50 rounded">
          <div className="text-blue-600">DET (現在)</div>
          <div className="font-bold">{latest ? `${(latest.det * 100).toFixed(1)}%` : "—"}</div>
        </div>
        <div className="p-2 bg-orange-50 rounded">
          <div className="text-orange-600">LAM (現在)</div>
          <div className="font-bold">{latest ? `${(latest.lam * 100).toFixed(1)}%` : "—"}</div>
        </div>
        <div className="p-2 bg-purple-50 rounded">
          <div className="text-purple-600">ENTR (現在)</div>
          <div className="font-bold">{latest ? latest.diagEntropy.toFixed(2) : "—"}</div>
        </div>
        <div className="p-2 bg-green-50 rounded">
          <div className="text-green-600">TT (現在)</div>
          <div className="font-bold">{latest ? latest.trappingTime.toFixed(1) : "—"}</div>
        </div>
        <div className="p-2 bg-red-50 rounded">
          <div className="text-red-600">シグナル数</div>
          <div className="font-bold">{result.signals.length}</div>
        </div>
      </div>

      {/* Window control */}
      <div className="flex gap-4 mb-3 text-xs">
        <label className="flex items-center gap-2">
          <span className="text-gray-500">窓幅:</span>
          <input
            type="range" min={50} max={200} step={10} value={windowSize}
            onChange={e => setWindowSize(Number(e.target.value))}
            className="w-24 accent-blue-600"
          />
          <span className="text-gray-700 font-medium w-10">{windowSize}日</span>
        </label>
      </div>

      {/* Charts */}
      <div className="space-y-3 mb-3">
        <div>
          <div className="text-xs text-gray-500 mb-1">DET (決定性) / LAM (層状性) / RR (再帰率)</div>
          <div ref={detLamRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">ENTR (対角線エントロピー) / TT (トラッピング時間)</div>
          <div ref={entropyRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      {/* Signals */}
      {result.signals.length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-medium text-gray-700 mb-1">検出されたシグナル (直近5件)</div>
          <div className="space-y-1">
            {result.signals.slice(-5).map((sig, i) => (
              <div key={i} className={`text-xs p-2 rounded ${
                sig.type === "det_drop" ? "bg-red-50 text-red-700" :
                sig.type === "lam_spike" ? "bg-orange-50 text-orange-700" :
                sig.type === "det_lam_diverge" ? "bg-yellow-50 text-yellow-700" :
                "bg-purple-50 text-purple-700"
              }`}>
                <span className="font-medium">{sig.time}</span> — {sig.description}
              </div>
            ))}
          </div>
        </div>
      )}

      <AnalysisGuide title="ローリングRQAの詳細解説">
        <div className="space-y-3">
          <div>
            <p className="font-medium text-gray-700 mb-1">リカレンス定量化分析 (RQA) とは</p>
            <p>リカレンスプロット (RP) は、位相空間上で状態が再帰する（近い場所に戻る）パターンを可視化したものです。RP上の幾何学的構造から、系の力学的特性を定量化するのがRQAです。</p>
            <div className="bg-gray-50 rounded p-2 my-2 font-mono text-xs">
              リカレンス行列: R(i,j) = Θ(ε - ||v(i) - v(j)||)<br/>
              　v(i) = Takens埋め込みベクトル, ε = 閾値, Θ = ヘヴィサイド関数
            </div>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">各RQA指標の意味</p>
            <ul className="list-disc pl-4 space-y-2 text-xs">
              <li>
                <span className="font-medium text-blue-600">DET (決定性)</span> — 対角線構造に含まれる再帰点の割合
                <div className="bg-gray-50 rounded p-1 mt-1 font-mono">
                  DET = Σ(l≥2) l·P(l) / Σ l·P(l)<br/>
                  P(l) = 対角線長lの出現頻度
                </div>
                <p className="mt-1">対角線 = 「似た軌道が似た方向に並行して進む」パターン。<span className="font-medium">DETが高い = 系に決定論的ルールがある = 予測可能</span>。</p>
              </li>
              <li>
                <span className="font-medium text-orange-600">LAM (層状性)</span> — 垂直線構造に含まれる再帰点の割合
                <div className="bg-gray-50 rounded p-1 mt-1 font-mono">
                  LAM = Σ(v≥2) v·P(v) / Σ v·P(v)<br/>
                  P(v) = 垂直線長vの出現頻度
                </div>
                <p className="mt-1">垂直線 = 「ある状態に長時間留まる(層状態)」。<span className="font-medium">LAMが高い = 状態が固着 = トレンドの持続</span>。</p>
              </li>
              <li>
                <span className="font-medium text-green-600">TT (トラッピング時間)</span> — 垂直線の平均長さ
                <div className="bg-gray-50 rounded p-1 mt-1 font-mono">
                  TT = Σ(v≥2) v·P(v) / Σ(v≥2) P(v)
                </div>
                <p className="mt-1">一つの状態に平均何ステップ滞留するか。<span className="font-medium">TTが長い = モメンタムが強い</span>。</p>
              </li>
              <li>
                <span className="font-medium text-purple-600">ENTR (対角線エントロピー)</span> — 対角線長分布のShannon Entropy
                <div className="bg-gray-50 rounded p-1 mt-1 font-mono">
                  ENTR = -Σ p(l) · ln(p(l))<br/>
                  p(l) = P(l) / Σ P(l)
                </div>
                <p className="mt-1">対角線長の多様性。<span className="font-medium">ENTRが高い = 多様な時間スケールの構造が混在 = 市場の不確実性増大</span>。</p>
              </li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">投資シグナルの読み方</p>
            <div className="overflow-x-auto">
              <table className="text-xs border-collapse w-full">
                <thead>
                  <tr className="bg-gray-100">
                    <th className="border p-1 text-left">パターン</th>
                    <th className="border p-1 text-left">解釈</th>
                    <th className="border p-1 text-left">アクション</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td className="border p-1 text-red-600">DET急減</td><td className="border p-1">予測可能な構造が崩壊</td><td className="border p-1">ポジション縮小・リスクオフ</td></tr>
                  <tr><td className="border p-1 text-orange-600">LAM急増</td><td className="border p-1">状態の固着・トレンド持続</td><td className="border p-1">トレンドフォロー維持</td></tr>
                  <tr><td className="border p-1 text-yellow-600">DET低+LAM高</td><td className="border p-1">予測不能だが固着</td><td className="border p-1">ボラティリティ急変の前兆</td></tr>
                  <tr><td className="border p-1 text-purple-600">ENTR急増</td><td className="border p-1">不確実性が急増</td><td className="border p-1">ストップ幅拡大・様子見</td></tr>
                  <tr><td className="border p-1 text-green-600">DET高+TT長</td><td className="border p-1">安定的なトレンド</td><td className="border p-1">モメンタム戦略有効</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </AnalysisGuide>
    </div>
  );
}
