"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeDensityMatrix } from "../../lib/density-matrix";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

export default function DensityMatrixChart({ prices }: Props) {
  const stackedRef = useRef<HTMLCanvasElement>(null);
  const barRef = useRef<HTMLCanvasElement>(null);
  const entropyRef = useRef<HTMLDivElement>(null);
  const entropyChartRef = useRef<IChartApi | null>(null);

  const result = useMemo(() => computeDensityMatrix(prices), [prices]);

  // Stacked area chart (Canvas)
  useEffect(() => {
    const draw = () => {
      if (!stackedRef.current || result.data.length === 0) return;
      const H = 300;
      const init = initCanvas(stackedRef.current, H);
      if (!init) return;
      const { ctx, width, height } = init;

      const ml = 50,
        mr = 20,
        mt = 20,
        mb = 40;
      const plotW = width - ml - mr;
      const plotH = height - mt - mb;
      const n = result.data.length;
      const nRegimes = result.regimes.length;

      const xFrom = (i: number) => ml + (i / (n - 1)) * plotW;
      const yFrom = (v: number) => mt + plotH - v * plotH;

      // Draw stacked areas from bottom (regime 0) to top
      // Each regime stacks on top of the previous cumulative
      for (let r = nRegimes - 1; r >= 0; r--) {
        ctx.beginPath();
        // Top edge: cumulative up to regime r (inclusive)
        for (let i = 0; i < n; i++) {
          let cumTop = 0;
          for (let k = 0; k <= r; k++) {
            cumTop += result.data[i].probabilities[k];
          }
          const x = xFrom(i);
          const y = yFrom(cumTop);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        // Bottom edge: cumulative up to regime r-1
        for (let i = n - 1; i >= 0; i--) {
          let cumBottom = 0;
          for (let k = 0; k < r; k++) {
            cumBottom += result.data[i].probabilities[k];
          }
          const x = xFrom(i);
          const y = yFrom(cumBottom);
          ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = result.regimes[r].color + "cc";
        ctx.fill();
      }

      // Y-axis labels
      ctx.fillStyle = "#666";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let v = 0; v <= 1; v += 0.25) {
        const y = yFrom(v);
        ctx.fillText(`${(v * 100).toFixed(0)}%`, ml - 6, y);
        // Grid line
        ctx.strokeStyle = "#e5e7eb";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(ml, y);
        ctx.lineTo(width - mr, y);
        ctx.stroke();
      }

      // X-axis date labels
      ctx.fillStyle = "#666";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const labelCount = Math.min(6, n);
      for (let li = 0; li < labelCount; li++) {
        const idx = Math.floor((li / (labelCount - 1)) * (n - 1));
        const x = xFrom(idx);
        const label = result.data[idx].time.slice(0, 7); // YYYY-MM
        ctx.fillText(label, x, height - mb + 6);
      }

      // Axis lines
      ctx.strokeStyle = "#999";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ml, mt);
      ctx.lineTo(ml, height - mb);
      ctx.lineTo(width - mr, height - mb);
      ctx.stroke();

      // Legend
      const legendX = ml + 10;
      const legendY = mt + 6;
      for (let r = 0; r < nRegimes; r++) {
        const lx = legendX + r * 80;
        ctx.fillStyle = result.regimes[r].color;
        ctx.fillRect(lx, legendY, 12, 12);
        ctx.fillStyle = "#333";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(result.regimes[r].label, lx + 16, legendY + 1);
      }
    };

    draw();
    const handleResize = () => draw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [result]);

  // Current probability bar (Canvas)
  useEffect(() => {
    const draw = () => {
      if (!barRef.current || result.currentProbabilities.length === 0) return;
      const H = 40;
      const init = initCanvas(barRef.current, H);
      if (!init) return;
      const { ctx, width } = init;

      const ml = 10,
        mr = 10,
        barH = 24,
        barY = 8;
      const barW = width - ml - mr;
      let cumX = ml;

      for (let r = 0; r < result.regimes.length; r++) {
        const p = result.currentProbabilities[r];
        const segW = p * barW;
        ctx.fillStyle = result.regimes[r].color + "dd";
        ctx.fillRect(cumX, barY, segW, barH);

        // Percentage label if wide enough
        if (segW > 40) {
          ctx.fillStyle = "#fff";
          ctx.font = "bold 12px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(
            `${result.regimes[r].label} ${(p * 100).toFixed(1)}%`,
            cumX + segW / 2,
            barY + barH / 2
          );
        }
        cumX += segW;
      }

      // Border
      ctx.strokeStyle = "#d1d5db";
      ctx.lineWidth = 1;
      ctx.strokeRect(ml, barY, barW, barH);
    };

    draw();
    const handleResize = () => draw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [result]);

  // Entropy chart (lightweight-charts)
  useEffect(() => {
    if (!entropyRef.current || result.data.length === 0) return;
    if (entropyChartRef.current) entropyChartRef.current.remove();

    const chart = createChart(entropyRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: {
        vertLines: { color: "#f0f0f0" },
        horzLines: { color: "#f0f0f0" },
      },
      width: entropyRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    entropyChartRef.current = chart;

    const entropySeries = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 2,
      title: "Entropy",
      priceScaleId: "right",
    });
    entropySeries.setData(
      result.data.map((d) => ({
        time: d.time as Time,
        value: d.entropy,
      }))
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (entropyRef.current)
        chart.applyOptions({ width: entropyRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      entropyChartRef.current = null;
    };
  }, [result]);

  if (result.data.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="font-bold text-gray-800 mb-1">
          密度行列 (マルチレジーム確率)
        </h3>
        <p className="text-xs text-gray-500">
          データが不足しています (60日以上必要)
        </p>
      </div>
    );
  }

  // Transition matrix cell color
  const cellBg = (v: number) => {
    const intensity = Math.round(v * 255);
    return `rgba(59, 130, 246, ${(intensity / 255) * 0.6 + 0.05})`;
  };

  // Current dominant regime
  const dominant = result.data[result.data.length - 1].dominantRegime;
  const currentEntropy = result.data[result.data.length - 1].entropy;
  const maxEntropy = Math.log2(result.regimes.length);
  const entropyRatio = maxEntropy > 0 ? currentEntropy / maxEntropy : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        密度行列 (マルチレジーム確率)
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        HMM事後確率による複数レジーム同時保持と混合状態の可視化
      </p>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">支配的レジーム</div>
          <div
            className="font-bold text-lg"
            style={{ color: result.regimes[dominant].color }}
          >
            {result.regimes[dominant].label}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">現在エントロピー</div>
          <div
            className={`font-bold text-lg ${
              entropyRatio > 0.7
                ? "text-red-600"
                : entropyRatio > 0.4
                  ? "text-yellow-600"
                  : "text-green-600"
            }`}
          >
            {currentEntropy.toFixed(3)}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">不確実性</div>
          <div
            className={`font-bold text-lg ${
              entropyRatio > 0.7
                ? "text-red-600"
                : entropyRatio > 0.4
                  ? "text-yellow-600"
                  : "text-green-600"
            }`}
          >
            {(entropyRatio * 100).toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Current regime probability bar */}
      <div className="text-xs text-gray-500 mb-1">現在のレジーム確率</div>
      <div className="w-full mb-3">
        <canvas ref={barRef} />
      </div>

      {/* Stacked area chart */}
      <div className="text-xs text-gray-500 mb-1">
        レジーム確率の時系列 (積み上げ面グラフ)
      </div>
      <div className="w-full rounded border border-gray-100 mb-3">
        <canvas ref={stackedRef} />
      </div>

      {/* Entropy chart */}
      <div className="text-xs text-gray-500 mb-1">
        エントロピー推移 (不確実性の度合い)
      </div>
      <div
        ref={entropyRef}
        className="w-full rounded border border-gray-100 mb-3"
      />

      {/* Transition matrix and regime stats */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        {/* Transition matrix */}
        <div>
          <div className="text-xs text-gray-500 mb-1">遷移行列</div>
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr>
                <th className="p-1 text-left text-gray-400">From \ To</th>
                {result.regimes.map((r) => (
                  <th
                    key={r.id}
                    className="p-1 text-center"
                    style={{ color: r.color }}
                  >
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.regimes.map((fromR, i) => (
                <tr key={fromR.id}>
                  <td
                    className="p-1 font-medium"
                    style={{ color: fromR.color }}
                  >
                    {fromR.label}
                  </td>
                  {result.transitionMatrix[i].map((v, j) => (
                    <td
                      key={j}
                      className="p-1 text-center font-mono rounded"
                      style={{
                        backgroundColor: cellBg(v),
                        color: v > 0.5 ? "#fff" : "#333",
                      }}
                    >
                      {(v * 100).toFixed(1)}%
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Regime stats */}
        <div>
          <div className="text-xs text-gray-500 mb-1">レジーム統計</div>
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr>
                <th className="p-1 text-left text-gray-400">レジーム</th>
                <th className="p-1 text-right text-gray-400">年率リターン</th>
                <th className="p-1 text-right text-gray-400">年率Vol</th>
              </tr>
            </thead>
            <tbody>
              {result.regimes.map((r) => (
                <tr key={r.id}>
                  <td className="p-1 font-medium" style={{ color: r.color }}>
                    {r.label}
                  </td>
                  <td
                    className={`p-1 text-right font-mono ${
                      r.meanReturn >= 0 ? "text-green-600" : "text-red-600"
                    }`}
                  >
                    {(r.meanReturn * 100).toFixed(1)}%
                  </td>
                  <td className="p-1 text-right font-mono text-gray-700">
                    {(r.volatility * 100).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <AnalysisGuide title="密度行列分析の詳細理論">
        <p className="font-medium text-gray-700">1. 密度行列とは</p>
        <p>
          量子力学における密度行列(密度演算子)は、系が複数の量子状態の「混合」にある場合の確率的記述です。
          純粋状態(1つの状態に確定)ではなく、複数の状態が確率的に重ね合わさった「混合状態」を表現できます。
          金融市場への応用では、市場が「上昇トレンド」「下落トレンド」「中立」のどの状態にあるかを確率的に同時保持します。
          日常的な例えでは、天気予報のように「晴れ60%・曇り30%・雨10%」と複数の可能性を同時に持つイメージです。
          従来の単一レジーム分類(「今は上昇トレンド」と断定)ではなく、各レジームの確率を連続的に追跡することで、
          レジーム転換の兆候をより早く捉えることができます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          対数リターン: r_t = ln(P_t / P_{"{t-1}"})
        </p>
        <p>
          K-meansクラスタリングでリターンをK個のレジームに分類し、各クラスタの平均と分散を推定:
          <br />
          各レジームk: 平均 mu_k, 分散 sigma_k^2
        </p>
        <p>
          観測尤度(ガウス分布): L(r_t | k) = (1 / sqrt(2*pi*sigma_k^2)) * exp(-0.5 * ((r_t - mu_k) / sigma_k)^2)
        </p>
        <p>
          Forward Algorithm (予測ステップ): p(z_t=j | r_1:t-1) = sum_i T(i,j) * p(z_{"{t-1}"}=i | r_1:t-1)
          <br />
          ここで T(i,j) はレジームiからjへの遷移確率
        </p>
        <p>
          更新ステップ: p(z_t=j | r_1:t) = L(r_t | j) * p(z_t=j | r_1:t-1) / sum_k L(r_t | k) * p(z_t=k | r_1:t-1)
        </p>
        <p>
          フォン・ノイマンエントロピー(離散近似): S = -sum_k p_k * log2(p_k)
          <br />
          最大値は log2(K) (全レジーム等確率の場合)、最小値は 0 (1つのレジームに確定)
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>密度行列:</strong> 量子力学で混合状態を記述する行列。対角成分が各状態の確率、非対角成分が状態間の干渉を表す</li>
          <li><strong>レジーム:</strong> 市場の状態(上昇・中立・下落など)。リターン分布の統計的特性が異なる期間</li>
          <li><strong>HMM (隠れマルコフモデル):</strong> 観測できない内部状態(レジーム)が確率的に遷移し、各状態から観測値が生成されるモデル</li>
          <li><strong>フォン・ノイマンエントロピー:</strong> 混合状態の不確実性の尺度。シャノンエントロピーの量子版</li>
          <li><strong>遷移行列:</strong> あるレジームから別のレジームへ移行する確率をまとめた行列</li>
          <li><strong>事後確率:</strong> 観測データを踏まえた上での各レジームの確率(ベイズ更新後)</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な理解</p>
        <p>
          密度行列は「天気予報の確信度」のようなものです。
          晴れが100%確実なら純粋状態(エントロピー=0)、晴れ33%・曇り33%・雨34%ならほぼ最大混合(エントロピー最大)です。
          市場でも同様に、明確な上昇トレンドならエントロピーが低く(確信度が高い)、
          方向感のない相場ではエントロピーが高く(不確実性が高い)なります。
          エントロピーが急上昇する局面は、市場参加者の意見が分かれている=レジーム転換の可能性が高い局面です。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>積み上げ面グラフ: 各色の面積が広いほど、そのレジームの確率が高い。色が急激に入れ替わる箇所がレジーム転換点</li>
          <li>エントロピーが低い (0に近い): 1つのレジームが支配的で市場の方向性が明確</li>
          <li>エントロピーが高い (log2(K)に近い): 複数レジームが拮抗し不確実性が高い。トレンド転換の予兆の可能性</li>
          <li>遷移行列の対角成分が大きい: レジームが持続しやすい(安定的な市場)</li>
          <li>遷移行列の非対角成分が大きい: レジーム切替が頻繁(不安定な市場)</li>
          <li>不確実性パーセンテージ: エントロピーを最大値で正規化した値。70%以上は高不確実性</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>レジーム確率に応じたポジション調整: 上昇確率が高い時はロング比率を高め、下落確率が高い時はヘッジを強化</li>
          <li>エントロピーベースのリスク管理: エントロピーが高い(不確実な)局面ではポジションサイズを縮小</li>
          <li>レジーム転換の早期検知: 支配的レジームの確率が低下し始めたら、転換に備えたポジション調整を開始</li>
          <li>遷移行列による持続性判断: 上昇レジームの自己遷移確率が高ければ、トレンドフォロー戦略の有効性が高い</li>
          <li>複数レジームのリスク加重: 各レジームのボラティリティを確率加重してリスク量を推定(条件付きVaR)</li>
          <li>戦略の使い分け: 低エントロピー時はトレンドフォロー、高エントロピー時はミーンリバージョンを検討</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>K-meansによるレジーム分類は簡易的なHMM近似であり、本格的なBaum-Welchアルゴリズムに比べ精度が劣る場合がある</li>
          <li>レジーム数(デフォルト3)は仮定であり、実際の市場状態数は不明。BICなどの情報量基準での選択が望ましい</li>
          <li>事後確率はForwardアルゴリズムのみで計算しており、将来情報を使うスムーザー(Forward-Backward)は含まない</li>
          <li>遷移行列は全期間で一定と仮定しているが、実際には時変である可能性が高い</li>
          <li>量子力学の密度行列との対応はアナロジーであり、市場が量子系であることを意味しない</li>
          <li>急激な価格変動(ブラックスワン)時にはガウス分布の尤度が過小評価され、レジーム判定が遅れる場合がある</li>
          <li>パラメータ推定には十分なデータ長(少なくとも60日)が必要であり、短期間のデータでは信頼性が低い</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
