"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { logReturns } from "../../lib/transforms";
import { mutualInformation, timeLaggedMI, transferEntropy, grangerTest } from "../../lib/causal";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function CausalChart({ prices, seriesMode }: Props) {
  const miRef = useRef<HTMLDivElement>(null);
  const miChartRef = useRef<IChartApi | null>(null);
  const flowCanvasRef = useRef<HTMLCanvasElement>(null);

  const { values: extracted } = extractSeries(prices, seriesMode);
  const needsTransform = seriesMode === "close" || seriesMode === "open";
  const lr = needsTransform ? logReturns(extracted) : extracted;
  const allVols = prices.map((p) => p.volume);
  const volumes = allVols.slice(allVols.length - lr.length);
  const volReturns = logReturns(volumes.map((v) => v || 1));

  const autoMI = useMemo(() => timeLaggedMI(lr, 30), [prices, seriesMode]);
  const te = useMemo(() => transferEntropy(volReturns, lr, 1, 8), [prices, seriesMode]);
  const granger = useMemo(() => grangerTest(volReturns, lr, 5), [prices, seriesMode]);
  const miPriceVol = useMemo(() => mutualInformation(lr, volReturns.slice(0, lr.length)), [prices, seriesMode]);

  // Auto-MI chart (nonlinear ACF)
  useEffect(() => {
    if (!miRef.current) return;
    if (miChartRef.current) miChartRef.current.remove();

    const chart = createChart(miRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: miRef.current.clientWidth,
      height: 180,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    miChartRef.current = chart;

    const series = chart.addSeries(HistogramSeries, {
      color: "#3b82f6",
      title: "自己MI (非線形ACF)",
    });
    series.setData(
      autoMI.map((v, i) => ({
        time: `2000-01-${String(i + 1).padStart(2, "0")}` as Time,
        value: v,
      }))
    );

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (miRef.current) chart.applyOptions({ width: miRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); miChartRef.current = null; };
  }, [prices, autoMI]);

  // Information flow diagram (canvas)
  useEffect(() => {
    const canvas = flowCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = 400;
    const height = 200;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    // Two nodes: Price, Volume
    const cx1 = 100, cy1 = 100; // Volume
    const cx2 = 300, cy2 = 100; // Price
    const nodeR = 35;

    // Nodes
    ctx.fillStyle = "#dbeafe";
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx1, cy1, nodeR, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#fef3c7";
    ctx.strokeStyle = "#eab308";
    ctx.beginPath(); ctx.arc(cx2, cy2, nodeR, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();

    ctx.fillStyle = "#374151";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("出来高", cx1, cy1 + 4);
    ctx.fillText("価格", cx2, cy2 + 4);

    // Arrows
    const arrowY1 = cy1 - 15;
    const arrowY2 = cy1 + 15;
    const maxTE = Math.max(te.te_xy, te.te_yx, 0.001);

    // Volume → Price (top arrow)
    const w1 = Math.max(1, (te.te_xy / maxTE) * 5);
    ctx.strokeStyle = te.significance.te_xy_p < 0.05 ? "#22c55e" : "#d1d5db";
    ctx.lineWidth = w1;
    ctx.beginPath();
    ctx.moveTo(cx1 + nodeR + 5, arrowY1);
    ctx.lineTo(cx2 - nodeR - 15, arrowY1);
    ctx.stroke();
    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(cx2 - nodeR - 5, arrowY1);
    ctx.lineTo(cx2 - nodeR - 15, arrowY1 - 5);
    ctx.lineTo(cx2 - nodeR - 15, arrowY1 + 5);
    ctx.fill();

    // Price → Volume (bottom arrow)
    const w2 = Math.max(1, (te.te_yx / maxTE) * 5);
    ctx.strokeStyle = te.significance.te_yx_p < 0.05 ? "#22c55e" : "#d1d5db";
    ctx.lineWidth = w2;
    ctx.beginPath();
    ctx.moveTo(cx2 - nodeR - 5, arrowY2);
    ctx.lineTo(cx1 + nodeR + 15, arrowY2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx1 + nodeR + 5, arrowY2);
    ctx.lineTo(cx1 + nodeR + 15, arrowY2 - 5);
    ctx.lineTo(cx1 + nodeR + 15, arrowY2 + 5);
    ctx.fill();

    // Labels
    ctx.fillStyle = "#374151";
    ctx.font = "10px sans-serif";
    ctx.fillText(`TE: ${te.te_xy.toFixed(4)} (p=${te.significance.te_xy_p.toFixed(3)})`, 200, arrowY1 - 8);
    ctx.fillText(`TE: ${te.te_yx.toFixed(4)} (p=${te.significance.te_yx_p.toFixed(3)})`, 200, arrowY2 + 16);
    ctx.fillText(`Net: ${te.netFlow > 0 ? "出来高→価格" : "価格→出来高"} (${Math.abs(te.netFlow).toFixed(4)})`, 200, 175);

    // Granger result
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText(`Granger: ${granger.direction} (F=${granger.fStatistic.toFixed(2)}, p=${granger.pValue.toFixed(3)}, lag=${granger.optimalLag})`, 200, 195);
  }, [te, granger]);

  // Find optimal tau from auto-MI
  const optimalTau = useMemo(() => {
    for (let i = 1; i < autoMI.length - 1; i++) {
      if (autoMI[i] < autoMI[i - 1] && autoMI[i] < autoMI[i + 1]) return i;
    }
    return 1;
  }, [autoMI]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">因果・情報伝達解析</h3>
      <p className="text-xs text-gray-500 mb-3">相互情報量 / Transfer Entropy / Granger因果性</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">MI (価格↔出来高)</div>
          <div className="font-bold">{miPriceVol.toFixed(4)} bits</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">最適埋め込み遅延 τ</div>
          <div className="font-bold">{optimalTau} 日</div>
          <div className="text-gray-400">auto-MIの最初の極小</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Granger方向</div>
          <div className="font-bold">{granger.direction}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">TE net flow</div>
          <div className="font-bold">{te.netFlow > 0 ? "出来高→価格" : "価格→出来高"}</div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <div className="text-xs text-gray-500 mb-1">自己相互情報量 (非線形ACF) — lag(日)</div>
          <div ref={miRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">情報フローダイアグラム</div>
          <canvas ref={flowCanvasRef} className="rounded border border-gray-100" />
        </div>
      </div>

      <AnalysisGuide title="因果・情報伝達分析の詳細理論">
        <p className="font-medium text-gray-700">1. この分析の概要</p>
        <p>株価と出来高の間に「情報の流れ」があるかを検証する分析です。単なる相関ではなく、「出来高の変化が将来の価格を予測できるか」「その逆はどうか」という因果的な方向性を調べます。</p>
        <p className="mt-1">電話の通話記録に例えると、相関は「AさんとBさんがよく電話する」という事実、Transfer Entropyは「Aさんが先に電話をかけた後にBさんが行動を変える」という方向性のある影響を捉えます。</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"相互情報量: MI(X;Y) = Σ p(x,y) log[p(x,y) / (p(x)p(y))]\n\nTransfer Entropy: TE(X→Y) = Σ p(y_{t+1}, y_t, x_t) log[p(y_{t+1}|y_t,x_t) / p(y_{t+1}|y_t)]\n\nGranger因果性: F = [(RSS_restricted - RSS_full)/p] / [RSS_full/(T-2p-1)]"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>MI(X;Y)</strong>: XとYの相互情報量。0なら独立、大きいほど依存性が強い</li>
          <li><strong>TE(X→Y)</strong>: XからYへの情報移転量。Xの過去がYの予測にどれだけ寄与するか</li>
          <li><strong>RSS</strong>: 残差平方和。制約付きモデル（Xなし）と完全モデル（Xあり）の予測精度の差をF検定する</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>相互情報量（MI）</strong>: 2変数間の非線形依存性の総合指標。ピアソン相関が線形関係のみ捉えるのに対し、あらゆる依存関係を捕捉する</li>
          <li><strong>自己MI</strong>: 自分自身のラグとのMI。非線形版のACF。最初の極小値が最適埋め込み遅延τ</li>
          <li><strong>Transfer Entropy（TE）</strong>: 方向性のある情報の流れを測定する指標。Granger因果性の非線形一般化</li>
          <li><strong>サロゲートテスト</strong>: 時系列をシャッフルしてTEを再計算し、元のTEが偶然では説明できないか検定する方法</li>
          <li><strong>Granger因果性</strong>: 線形VARモデルに基づく古典的因果検定。BICでラグ次数を選択しF検定で有意性を判定する</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>MI {">"} 0.1</strong>: 価格と出来高に意味のある依存関係がある</li>
          <li><strong>TE(出来高→価格) {">"} TE(価格→出来高)</strong>: 出来高が価格に先行して情報を持つ。出来高分析が有効な銘柄</li>
          <li><strong>TE(価格→出来高) {">"} TE(出来高→価格)</strong>: 価格変動が出来高を誘発する。ニュース駆動型の銘柄に多い</li>
          <li><strong>Granger p値 {"<"} 0.05</strong>: 線形的な因果関係が統計的に有意</li>
          <li><strong>TEとGrangerの方向が一致</strong>: 線形・非線形ともに同じ因果方向を支持。信頼度が高い</li>
          <li><strong>TEは有意だがGrangerは非有意</strong>: 非線形的な因果関係が存在。線形モデルでは捉えきれない情報の流れがある</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>出来高先行シグナル</strong>: TE(出来高→価格)が有意な銘柄では、出来高の急増を価格変動の先行指標として活用できる</li>
          <li><strong>テクニカル指標の選択</strong>: 出来高→価格の因果が強い銘柄ではOBV・VWAPなど出来高ベースの指標が有効</li>
          <li><strong>情報の非対称性</strong>: 双方向のTEが共に大きい銘柄は、価格と出来高のフィードバックループが強く、ボラティリティが拡大しやすい</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>サンプルサイズ</strong>: MIとTEの推定にはビニング（離散化）が必要で、データが少ないと推定が不安定になる。最低200点以上推奨</li>
          <li><strong>ビン数の影響</strong>: 離散化のビン数によって結果が変わりうる。本実装では平方根則を採用</li>
          <li><strong>因果 ≠ メカニズム</strong>: 統計的因果は「予測に有用」を意味するだけで、経済的なメカニズムの証明ではない</li>
          <li><strong>Grangerの線形仮定</strong>: Granger因果性は線形VARモデルが前提。非線形な依存関係を見落とす可能性があるため、TEとの併用が重要</li>
        </ul>
      </AnalysisGuide>

      <AxiomPlacement corollaryId="C19" />
    </div>
  );
}
