"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { logReturns } from "../../lib/transforms";
import { extremeValueAnalysis, higherOrderCumulants, tailDependence } from "../../lib/tail-risk";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function TailRiskChart({ prices, seriesMode }: Props) {
  const qqCanvasRef = useRef<HTMLCanvasElement>(null);
  const returnLevelCanvasRef = useRef<HTMLCanvasElement>(null);

  const { values: lr } = extractSeries(prices, seriesMode);
  const volumes = useMemo(() => {
    const vols = prices.map((p) => p.volume);
    return vols.slice(vols.length - lr.length);
  }, [prices, seriesMode]);
  const volRet = logReturns(volumes.map((v) => v || 1));

  const evt = useMemo(() => extremeValueAnalysis(lr, 0.9), [prices, seriesMode]);
  const cumulants = useMemo(() => higherOrderCumulants(lr), [prices, seriesMode]);
  const tailDep = useMemo(() => tailDependence(lr, volRet.slice(0, lr.length), 0.1), [prices, seriesMode]);

  // GPD Q-Q plot
  useEffect(() => {
    const canvas = qqCanvasRef.current;
    if (!canvas || evt.qqPlot.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const size = 250;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { left: 45, right: 10, top: 20, bottom: 30 };
    const plotW = size - margin.left - margin.right;
    const plotH = size - margin.top - margin.bottom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);

    const maxVal = Math.max(
      ...evt.qqPlot.map((p) => p.theoretical),
      ...evt.qqPlot.map((p) => p.empirical)
    ) || 1;

    // 45-degree line
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top + plotH);
    ctx.lineTo(margin.left + plotW, margin.top);
    ctx.stroke();

    // Points
    ctx.fillStyle = "#ef4444";
    for (const p of evt.qqPlot) {
      const x = margin.left + (p.theoretical / maxVal) * plotW;
      const y = margin.top + plotH - (p.empirical / maxVal) * plotH;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
      ctx.fill();
    }

    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("GPD Q-Q Plot (テイル)", size / 2, 12);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("理論分位点", size / 2, size - 5);
    ctx.save();
    ctx.translate(10, margin.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("経験分位点", 0, 0);
    ctx.restore();
  }, [evt]);

  // Return level plot
  useEffect(() => {
    const canvas = returnLevelCanvasRef.current;
    if (!canvas || evt.returnLevels.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = 300;
    const height = 200;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { left: 55, right: 10, top: 20, bottom: 30 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const levels = evt.returnLevels;
    const maxPeriod = Math.max(...levels.map((l) => l.period));
    const maxLevel = Math.max(...levels.map((l) => Math.abs(l.level)));

    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 2;
    ctx.beginPath();
    levels.forEach((l, i) => {
      const x = margin.left + (Math.log(l.period) / Math.log(maxPeriod)) * plotW;
      const y = margin.top + plotH - (Math.abs(l.level) / maxLevel) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Points with labels
    ctx.fillStyle = "#ef4444";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    levels.forEach((l) => {
      const x = margin.left + (Math.log(l.period) / Math.log(maxPeriod)) * plotW;
      const y = margin.top + plotH - (Math.abs(l.level) / maxLevel) * plotH;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillText(`${l.period}d`, x, y - 8);
      ctx.fillText(`${(Math.abs(l.level) * 100).toFixed(1)}%`, x, y + 14);
    });

    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.fillText("再現期間リターン", width / 2, 12);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("再現期間 (日)", width / 2, height - 5);
  }, [evt]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">テイルリスク解析</h3>
      <p className="text-xs text-gray-500 mb-3">極値統計(EVT) / 高次キュムラント / テイル依存性</p>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">GPD形状 ξ</div>
          <div className="font-bold">{evt.shape.toFixed(3)}</div>
          <div className="text-gray-400">{evt.interpretation}</div>
        </div>
        <div className="p-2 bg-red-50 rounded">
          <div className="text-red-600">VaR 95%</div>
          <div className="font-bold text-red-700">{(evt.var95 * 100).toFixed(2)}%</div>
        </div>
        <div className="p-2 bg-red-50 rounded">
          <div className="text-red-600">ES 95% (CVaR)</div>
          <div className="font-bold text-red-700">
            {isFinite(evt.expectedShortfall95) ? `${(evt.expectedShortfall95 * 100).toFixed(2)}%` : "∞"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">超過尖度</div>
          <div className="font-bold">{cumulants.kurtosis.toFixed(2)}</div>
          <div className="text-gray-400">{cumulants.isGaussian ? "正規分布的" : "非正規"}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">テイル依存 (↓/↑)</div>
          <div className="font-bold">{tailDep.lowerTail.toFixed(3)} / {tailDep.upperTail.toFixed(3)}</div>
        </div>
      </div>

      {/* High-order cumulants */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3 text-xs">
        <div className="p-1 bg-gray-50 rounded text-center">
          <div className="text-gray-400">κ₁ (平均)</div>
          <div className="font-bold">{(cumulants.mean * 100).toFixed(4)}%</div>
        </div>
        <div className="p-1 bg-gray-50 rounded text-center">
          <div className="text-gray-400">κ₂ (分散)</div>
          <div className="font-bold">{(cumulants.variance * 10000).toFixed(4)}</div>
        </div>
        <div className="p-1 bg-gray-50 rounded text-center">
          <div className="text-gray-400">κ₃ (歪度)</div>
          <div className="font-bold">{cumulants.skewness.toFixed(3)}</div>
        </div>
        <div className="p-1 bg-gray-50 rounded text-center">
          <div className="text-gray-400">κ₄ (尖度)</div>
          <div className="font-bold">{cumulants.kurtosis.toFixed(3)}</div>
        </div>
        <div className="p-1 bg-gray-50 rounded text-center">
          <div className="text-gray-400">κ₅</div>
          <div className="font-bold">{cumulants.c5.toFixed(3)}</div>
        </div>
        <div className="p-1 bg-gray-50 rounded text-center">
          <div className="text-gray-400">κ₆</div>
          <div className="font-bold">{cumulants.c6.toFixed(3)}</div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div>
          <canvas ref={qqCanvasRef} className="rounded border border-gray-100" />
        </div>
        <div>
          <canvas ref={returnLevelCanvasRef} className="rounded border border-gray-100" />
        </div>
        <div className="flex-1 text-xs text-gray-600 space-y-2">
          <div className="p-2 bg-red-50 rounded">
            <div className="font-medium text-red-800">VaR (Value at Risk)</div>
            <div>指定信頼水準を超える最大損失の推定。GPDモデルにより正規分布仮定より精密な裾の推定が可能。</div>
          </div>
          <div className="p-2 bg-orange-50 rounded">
            <div className="font-medium text-orange-800">テイル依存性 (価格×出来高)</div>
            <div>下側λ_L={tailDep.lowerTail.toFixed(3)}: 急落時の価格-出来高連動性。Kendall τ={tailDep.kendallTau.toFixed(3)}</div>
          </div>
        </div>
      </div>

      <AnalysisGuide title="テイルリスク分析の詳細理論">
        <p className="font-medium text-gray-700">1. この分析の概要</p>
        <p>通常の統計（平均・標準偏差）では捉えきれない「極端な値動き」のリスクを専門的に評価する分析です。極値統計理論（EVT）で裾の厚さをモデル化し、高次キュムラントで分布の歪みを精密に定量します。</p>
        <p className="mt-1">堤防の設計に例えると、「過去50年で最大の洪水」だけでなく「100年に1度の洪水はどの高さか」を推定するのがEVTです。平均的な水位（平均リターン）だけでは、堤防（リスク管理）を正しく設計できません。</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"GPD (一般化パレート分布):\n  G(x; ξ, β) = 1 - (1 + ξx/β)^{-1/ξ}  (ξ≠0)\n  G(x; 0, β) = 1 - exp(-x/β)  (ξ=0)\n\n再現期間レベル:\n  x_T = u + (β/ξ)·[(T·n_u/n)^ξ - 1]\n  T: 再現期間, u: 閾値, n_u: 超過数, n: 総数\n\n第k次キュムラント:\n  κ_k = d^k/dt^k [log M(t)]_{t=0}\n  M(t) = E[e^{tX}] (モーメント母関数)"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>ξ（形状パラメータ）</strong>: 裾の厚さを決定する最重要パラメータ</li>
          <li><strong>β（尺度パラメータ）</strong>: 裾の広がりのスケール</li>
          <li><strong>u（閾値）</strong>: GPDを適用する損失の下限値</li>
          <li><strong>κ_k</strong>: 第k次キュムラント。κ₃=歪度、κ₄=超過尖度に対応</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>EVT（極値統計理論）</strong>: 確率分布の裾（極端な値）の挙動を専門的に扱う統計理論。Fisher-Tippett-Gnedenkoの定理に基づく</li>
          <li><strong>GPD（一般化パレート分布）</strong>: 閾値を超えた超過量の分布をモデル化。正規分布やt分布では捉えきれない裾を精密にフィットする</li>
          <li><strong>形状パラメータ ξ</strong>: ξ{">"} 0で厚い裾（パレート型、極端な損失が比較的頻繁）、ξ=0で指数型（中程度の裾）、ξ{"<"} 0で有界な裾（損失に上限がある）</li>
          <li><strong>再現期間</strong>: ある水準の損失が「平均的にN日に1回起きる」という頻度の表現</li>
          <li><strong>高次キュムラント</strong>: κ₅・κ₆は正規分布では0。非ゼロの値はガウスからの高次の逸脱を示す</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ξ {">"} 0</strong>: 厚い裾。正規分布が予測するより「ありえない」急落が実際には起こりうる。ξが大きいほど危険</li>
          <li><strong>ξ ≈ 0.2〜0.4</strong>: 日本株の典型的な値。正規分布仮定のVaRは大幅に過小評価される水準</li>
          <li><strong>Q-Qプロットが45度線に乗る</strong>: GPDのフィットが良好。裾のモデルとして信頼できる</li>
          <li><strong>再現期間250日（≈1年）の損失</strong>: 年に1回程度起こりうる最大損失の目安。ストップロスの参考に</li>
          <li><strong>再現期間2500日（≈10年）の損失</strong>: リーマンショック級のイベントに対応する損失水準</li>
          <li><strong>κ₅・κ₆が大きい</strong>: 分布の裾が正規分布から大きく逸脱。VaR・CVaRなどの従来のリスク指標を補正すべき</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ポジションサイジング</strong>: ξが大きい銘柄では正規分布VaRの2〜3倍のリスクバッファを確保する</li>
          <li><strong>ストップロス設定</strong>: 再現期間250日の損失水準を参考にストップロスを設定すると、年1回程度の発動頻度</li>
          <li><strong>ヘッジ判断</strong>: ξ{">"} 0.3の銘柄ではプットオプションの購入など、テイルリスクヘッジを積極的に検討</li>
          <li><strong>ポートフォリオ構築</strong>: ξが小さい（裾が薄い）銘柄を選好することで、ポートフォリオ全体のテイルリスクを低減</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>閾値uの選択</strong>: GPDの推定結果は閾値uに依存する。低すぎるとGPD近似が不正確、高すぎるとデータ不足。Mean Excess Plotで適切な閾値を選定すべき</li>
          <li><strong>データ量の制約</strong>: 極端な事象は定義上まれなため、推定に十分な超過データが必要。最低500日以上のデータが望ましい</li>
          <li><strong>定常性の仮定</strong>: EVTは分布が時間的に不変であることを仮定。市場構造の変化があると推定が歪む</li>
          <li><strong>再現期間の過信</strong>: 再現期間はあくまで確率的な推定であり、「次にいつ起きるか」は予測できない。10年に1度の損失が連続して起こる可能性もある</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
