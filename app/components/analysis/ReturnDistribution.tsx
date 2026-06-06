"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { histogram, qqPlot, normalPDF, distributionStats } from "../../lib/distribution";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function ReturnDistribution({ prices, seriesMode }: Props) {
  const histRef = useRef<HTMLCanvasElement>(null);
  const qqRef = useRef<HTMLCanvasElement>(null);

  const { values: lr } = extractSeries(prices, seriesMode);
  const stats = useMemo(() => distributionStats(lr), [prices, seriesMode]);
  const hist = useMemo(() => histogram(lr, 50), [prices, seriesMode]);
  const qq = useMemo(() => qqPlot(lr), [prices, seriesMode]);

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

      <AnalysisGuide title="リターン分布分析の詳細理論">
        <p className="font-medium text-gray-700">1. リターン分布分析とは</p>
        <p>株価の日次リターンがどのような確率分布に従っているかを調べる分析です。多くの金融モデルは「リターンは正規分布に従う」と仮定しますが、実際の株式リターンは正規分布より裾が厚く（ファットテール）、非対称であることが知られています。コインの表裏に例えると、正規分布は「公平なコイン」、実際の株式リターンは「稀にだけ出る特殊な面がある偏ったコイン」のようなものです。</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"対数リターン: r_t = ln(P_t / P_{t-1})\n\n歪度: S = (1/n) Σ [(r_t - μ)/σ]³\n尖度(超過): K = (1/n) Σ [(r_t - μ)/σ]⁴ - 3\n\nJarque-Bera検定統計量:\n  JB = (n/6) · [S² + (K²/4)]\n  帰無仮説 H₀: S=0 かつ K=0 (正規分布)\n  JB ~ χ²(2),  p < 0.05 なら正規性を棄却"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>S（歪度）</strong>: 分布の非対称性。負なら左裾が厚い（大幅下落が多い）、正なら右裾が厚い</li>
          <li><strong>K（超過尖度）</strong>: 分布の裾の厚さ。正規分布は0、正の値ほど極端な値動きが多い</li>
          <li><strong>JB</strong>: 歪度と尖度の同時検定統計量。χ²分布に従う</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ヒストグラム</strong>: 日次対数リターンの出現頻度を棒グラフで表示。青い曲線は同じ平均・標準偏差を持つ正規分布のPDF</li>
          <li><strong>Q-Qプロット</strong>: 観測値の分位と正規分布の理論分位を対比させた散布図。45度線上に乗れば正規分布に従う</li>
          <li><strong>ファットテール</strong>: 正規分布が予測するより極端な値（±3σ以上）が頻繁に出現する性質</li>
          <li><strong>Jarque-Bera検定</strong>: 歪度と尖度から正規性を同時検定する手法。株式リターンではほぼ常に棄却される</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ヒストグラムが青い曲線より裾が広い</strong>: ファットテール。正規分布の予測よりも極端な値動きが多い</li>
          <li><strong>Q-Qプロットが両端でS字に離れる</strong>: 両側ファットテール。急騰・急落ともに正規分布より多く発生</li>
          <li><strong>Q-Qプロットが片方だけ離れる</strong>: 非対称なテール。上か下の一方だけリスクが大きい</li>
          <li><strong>歪度 {"<"} -0.5</strong>: 有意な左の偏り。大幅下落のリスクが高い</li>
          <li><strong>超過尖度 {">"} 3</strong>: 非常に厚い裾。正規分布ベースのリスク計算は大幅に過小評価される</li>
          <li><strong>JB検定 p {"<"} 0.05</strong>: 正規分布仮説を棄却。ほぼすべての株式で棄却される</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ポジションサイジング</strong>: 超過尖度が大きい銘柄では、正規分布ベースのVaRが過小評価されるため、ポジションを保守的に設定すべき</li>
          <li><strong>リスク指標の選択</strong>: ファットテールが顕著な銘柄では、VaRではなくCVaR（期待ショートフォール）やEVTベースの指標を使用</li>
          <li><strong>オプション戦略</strong>: 負の歪度が強い銘柄では、プットの理論価値が正規分布モデルより高い（OTMプットの売りに注意）</li>
          <li><strong>テールリスクヘッジ</strong>: 超過尖度が高い銘柄では、深いOTMプットでのテイルリスクヘッジを検討</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>サンプルサイズ依存</strong>: 歪度・尖度の推定は外れ値に非常に敏感。少なくとも1年以上（252日）のデータが望ましい</li>
          <li><strong>非定常性</strong>: 分布の形状は時期によって変動する（ボラティリティクラスタリング）。全期間の統計量は「平均的な分布」に過ぎない</li>
          <li><strong>JB検定の限界</strong>: 歪度と尖度のみで正規性を判定するため、他の形状の逸脱（多峰性など）は検出できない</li>
          <li><strong>対数リターンの前提</strong>: 対数リターンが使用されるため、非常に大きな変動率（-100%に近い下落）では近似精度が低下する</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
