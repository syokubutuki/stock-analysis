"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { logReturns } from "../../lib/transforms";
import { computeHHS, computeSTFT, rollingSpectralEntropy } from "../../lib/hilbert-huang-spectrum";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function HilbertHuangChart({ prices, seriesMode }: Props) {
  const hhsCanvasRef = useRef<HTMLCanvasElement>(null);
  const stftCanvasRef = useRef<HTMLCanvasElement>(null);
  const entropyRef = useRef<HTMLDivElement>(null);
  const entropyChartRef = useRef<IChartApi | null>(null);

  const { values, times } = extractSeries(prices, seriesMode);
  const needsTransform = seriesMode === "close" || seriesMode === "open";
  const lr = needsTransform ? logReturns(values) : values;
  const lrTimes = needsTransform ? times.slice(1) : times;

  const hhs = useMemo(() => computeHHS(lr, 35), [prices, seriesMode]);
  const stft = useMemo(() => computeSTFT(lr, 64, 4), [prices, seriesMode]);
  const specEntropy = useMemo(
    () => rollingSpectralEntropy(lr, Math.min(64, Math.floor(lr.length / 3))),
    [prices, seriesMode]
  );

  // HHS heatmap
  useEffect(() => {
    const canvas = hhsCanvasRef.current;
    if (!canvas || hhs.maxEnergy === 0) return;
    drawHeatmap(canvas, hhs.energy, hhs.periodAxis, hhs.timeAxis.length, "HHS");
  }, [hhs]);

  // STFT heatmap
  useEffect(() => {
    const canvas = stftCanvasRef.current;
    if (!canvas || stft.maxMag === 0) return;
    const mag2d = stft.magnitude;
    const maxVal = stft.maxMag;
    drawHeatmap(canvas, mag2d, stft.periodAxis, stft.timeIndices.length, "STFT", maxVal);
  }, [stft]);

  // Spectral entropy chart
  useEffect(() => {
    if (!entropyRef.current || specEntropy.entropy.length === 0) return;
    if (entropyChartRef.current) entropyChartRef.current.remove();

    const chart = createChart(entropyRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: entropyRef.current.clientWidth,
      height: 120,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    entropyChartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 2,
      title: "スペクトルエントロピー",
    });

    const data = specEntropy.indices
      .filter((idx) => idx < lrTimes.length)
      .map((idx, i) => ({
        time: lrTimes[idx] as Time,
        value: specEntropy.entropy[i],
      }));
    series.setData(data);
    chart.timeScale().fitContent();

    const handleResize = () => {
      if (entropyRef.current) chart.applyOptions({ width: entropyRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      entropyChartRef.current = null;
    };
  }, [prices, specEntropy]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">Hilbert-Huang Spectrum / STFT / スペクトルエントロピー</h3>
      <p className="text-xs text-gray-500 mb-3">
        適応的時間-周波数解析（HHS）と固定窓スペクトログラム（STFT）の比較 + 周波数複雑性
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <div>
          <div className="text-xs text-gray-500 mb-1">Hilbert-Huang Spectrum（適応的）</div>
          <canvas ref={hhsCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">STFT Spectrogram（固定窓=64日）</div>
          <canvas ref={stftCanvasRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-1">ローリング・スペクトルエントロピー (0=単一周波数, 1=白色雑音)</div>
      <div ref={entropyRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="HHS・STFT・スペクトルエントロピーの詳細理論">
        <p className="font-medium text-gray-700">1. この分析の概要</p>
        <p>時系列データを「時間×周波数」の2次元平面で可視化する手法です。どの時期にどの周期の成分が強かったかを一目で把握できます。HHS（適応的）とSTFT（古典的）の2つのスペクトログラムを比較し、スペクトルエントロピーで周波数構造の複雑さを定量化します。</p>
        <p className="mt-1">プリズムで白色光を虹に分解するように、株価の動きを異なる「周期の成分」に分解して可視化します。HHSはプリズムの精度が時々刻々と変わる適応的な分解、STFTは固定精度の分解です。</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"Hilbert変換: H[x(t)] = (1/π) P.V. ∫ x(τ)/(t-τ) dτ\n\n解析信号: z(t) = x(t) + i·H[x(t)] = a(t)·exp(iθ(t))\n  瞬時振幅: a(t) = |z(t)|,  瞬時周波数: f(t) = (1/2π)·dθ/dt\n\nスペクトルエントロピー: SE = -Σ p_k·log₂(p_k) / log₂(N)\n  p_k = S(f_k) / Σ S(f_k) (正規化パワースペクトル)"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>H[x(t)]</strong>: Hilbert変換。信号の位相を90°シフトした成分を得る</li>
          <li><strong>a(t)</strong>: 瞬時振幅。各時刻での振動の強さ</li>
          <li><strong>f(t)</strong>: 瞬時周波数。各時刻での局所的な振動周期</li>
          <li><strong>SE</strong>: スペクトルエントロピー。0〜1に正規化され、0=単一周波数、1=白色雑音</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>HHS（Hilbert-Huang Spectrum）</strong>: EMDで分解した各IMFにHilbert変換を適用し、瞬時周波数と振幅を時間-周波数平面にプロットした適応的スペクトル</li>
          <li><strong>STFT（短時間フーリエ変換）</strong>: 固定窓（64日）でFFTをスライドさせた古典的スペクトログラム。時間分解能と周波数分解能がトレードオフ</li>
          <li><strong>IMF（内在モード関数）</strong>: EMDにより抽出された振動成分。各IMFは局所的に単一の周波数成分を持つ</li>
          <li><strong>スペクトルエントロピー</strong>: パワースペクトルを確率分布とみなしたShannon Entropy。周波数構造の「複雑さ」を1つの数値で表す</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ヒートマップの暖色帯</strong>: その時期・周期にパワーが集中している。支配的な振動成分がある</li>
          <li><strong>HHSの暖色帯がSTFTより鮮明</strong>: 非線形・非定常な構造をHHSがよりよく捉えている</li>
          <li><strong>SE {"<"} 0.5</strong>: 周波数が集中。特定の周期で規則的に振動する市場状態（レンジ相場やサイクル）</li>
          <li><strong>SE {">"} 0.8</strong>: 周波数が分散。白色雑音に近いランダムな市場状態</li>
          <li><strong>SEの急低下</strong>: 急落・急騰時に特定周波数にパワーが集中。市場のパニックや一方的なトレンド形成を示唆</li>
          <li><strong>SEの急上昇</strong>: 既存の周期構造が崩壊し、ランダムな状態に戻ったことを示す</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>戦略切替</strong>: SE低下時は特定サイクルに乗る周期戦略が有効、SE高時はモメンタムやブレイクアウト戦略に切り替え</li>
          <li><strong>周期の特定</strong>: HHSで暖色帯が集中する周期を読み取り、その周期に合わせた売買タイミングの参考にする</li>
          <li><strong>レジーム判定</strong>: SEのローリング推移をレジーム検出（HMMなど）と併用し、市場状態を多角的に判定</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>端点効果</strong>: EMDおよびHilbert変換は系列の両端でアーティファクトが生じやすい。直近数十日の結果は信頼性が低下する</li>
          <li><strong>STFTの時間-周波数トレードオフ</strong>: 窓長64日は中周期の分解能を重視した設定。短周期の分解能は限定的</li>
          <li><strong>モードミキシング</strong>: EMDが類似周波数の成分を分離できない場合がある。EEMD（アンサンブルEMD）で改善可能だが計算コストが増大</li>
          <li><strong>スペクトルエントロピーの窓長依存</strong>: 計算窓の長さによってSEの値が変わる。絶対値より時間的な変化に注目すべき</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function drawHeatmap(
  canvas: HTMLCanvasElement,
  data: number[][],
  periodAxis: number[],
  nTime: number,
  label: string,
  externalMax?: number
) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.parentElement?.clientWidth || 400;
  const height = 200;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const margin = { left: 40, right: 10, top: 10, bottom: 20 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const nPeriods = data.length;
  let maxVal = externalMax || 0;
  if (!externalMax) {
    for (let p = 0; p < nPeriods; p++) {
      for (let t = 0; t < data[p].length; t++) {
        if (data[p][t] > maxVal) maxVal = data[p][t];
      }
    }
  }
  if (maxVal === 0) maxVal = 1;

  const cellW = plotW / nTime;
  const cellH = plotH / nPeriods;

  for (let p = 0; p < nPeriods; p++) {
    for (let t = 0; t < Math.min(data[p].length, nTime); t++) {
      const intensity = Math.min(data[p][t] / maxVal, 1);
      const r = Math.round(intensity * 255);
      const g = Math.round(intensity * 80);
      const b = Math.round((1 - intensity) * 200 + intensity * 50);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(
        margin.left + t * cellW,
        margin.top + (nPeriods - 1 - p) * cellH,
        Math.ceil(cellW) + 1,
        Math.ceil(cellH) + 1
      );
    }
  }

  // Period axis labels
  ctx.fillStyle = "#6b7280";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i < nPeriods; i += Math.floor(nPeriods / 5)) {
    const y = margin.top + (nPeriods - 1 - i) * cellH + cellH / 2;
    ctx.fillText(`${periodAxis[i].toFixed(0)}d`, margin.left - 3, y + 3);
  }

  ctx.textAlign = "center";
  ctx.fillText(label, margin.left + plotW / 2, height - 2);
}
