"use client";

import { useMemo, useRef, useEffect } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { distributionStats } from "../../lib/distribution";
import { acf } from "../../lib/autocorrelation";
import { ljungBoxTest } from "../../lib/distribution-extended";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

interface StylizedFact {
  name: string;
  description: string;
  value: string;
  status: "confirmed" | "partial" | "absent";
  detail: string;
}

export default function StylizedFactsChart({ prices, seriesMode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { values, times } = extractSeries(prices, seriesMode);

  const facts = useMemo(() => {
    if (values.length < 50) return [];

    // Log returns
    const logReturns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i].close > 0 && prices[i - 1].close > 0) {
        logReturns.push(Math.log(prices[i].close / prices[i - 1].close));
      }
    }

    if (logReturns.length < 30) return [];

    const stats = distributionStats(logReturns);
    const acfReturns = acf(logReturns, 20);
    const absReturns = logReturns.map(Math.abs);
    const acfAbs = acf(absReturns, 20);
    const sqReturns = logReturns.map((r) => r * r);
    const acfSq = acf(sqReturns, 20);
    const ljungReturns = ljungBoxTest(logReturns, 10);
    const ljungAbs = ljungBoxTest(absReturns, 10);

    // Gain/loss asymmetry
    const gains = logReturns.filter((r) => r > 0);
    const losses = logReturns.filter((r) => r < 0);
    const avgGain = gains.length > 0 ? gains.reduce((s, v) => s + v, 0) / gains.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, v) => s + v, 0) / losses.length : 0;
    const gainLossRatio = avgLoss !== 0 ? Math.abs(avgGain / avgLoss) : 1;

    // Volatility clustering: sum of abs ACF at lags 1-10
    const volClusterScore = acfAbs.slice(1, 11).reduce((s, p) => s + Math.abs(p.value), 0);

    // Leverage effect: correlation of returns and future abs returns
    let leverageCorr = 0;
    {
      const n = logReturns.length - 1;
      let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
      for (let i = 0; i < n; i++) {
        const x = logReturns[i];
        const y = absReturns[i + 1];
        sx += x; sy += y; sxy += x * y; sx2 += x * x; sy2 += y * y;
      }
      const denom = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
      leverageCorr = denom > 0 ? (n * sxy - sx * sy) / denom : 0;
    }

    const results: StylizedFact[] = [];

    // 1. Fat tails (尖度 > 0)
    const excessK = stats.kurtosis;
    results.push({
      name: "ファットテール",
      description: "リターン分布は正規分布より裾が厚い",
      value: `超過尖度 = ${excessK.toFixed(2)}`,
      status: excessK > 1 ? "confirmed" : excessK > 0 ? "partial" : "absent",
      detail: excessK > 1
        ? `正規分布(0)より大幅に厚い裾。極端な値動きが理論より頻出。`
        : excessK > 0
          ? `若干のファットテール。大きな変動がやや多い。`
          : `ファットテールなし（珍しい結果）。`,
    });

    // 2. Absence of autocorrelation
    const maxAbsACF = Math.max(...acfReturns.slice(1, 6).map((p) => Math.abs(p.value)));
    const noAutocorr = maxAbsACF < 2 / Math.sqrt(logReturns.length);
    results.push({
      name: "リターンの非自己相関",
      description: "リターンに有意な自己相関がない（効率的市場）",
      value: `最大|ACF(1-5)| = ${maxAbsACF.toFixed(4)}`,
      status: noAutocorr ? "confirmed" : maxAbsACF < 0.1 ? "partial" : "absent",
      detail: noAutocorr
        ? `リターンの自己相関はほぼゼロ。過去のリターンから将来を予測困難。`
        : `弱い自己相関が検出。短期的な予測可能性の示唆。`,
    });

    // 3. Volatility clustering
    results.push({
      name: "ボラティリティ・クラスタリング",
      description: "大きな変動の後には大きな変動が続く",
      value: `|ACF|合計(1-10) = ${volClusterScore.toFixed(3)}`,
      status: volClusterScore > 0.5 ? "confirmed" : volClusterScore > 0.2 ? "partial" : "absent",
      detail: volClusterScore > 0.5
        ? `強いボラティリティの持続性。GARCH型のモデルが適切。`
        : volClusterScore > 0.2
          ? `中程度のクラスタリング。条件付きボラティリティモデルが部分的に有効。`
          : `クラスタリングは弱い。`,
    });

    // 4. Asymmetry of gains and losses
    results.push({
      name: "利益/損失の非対称性",
      description: "下落は上昇より大きく急激に起きやすい",
      value: `歪度 = ${stats.skewness.toFixed(3)}, G/L比 = ${gainLossRatio.toFixed(3)}`,
      status: stats.skewness < -0.3 ? "confirmed" : stats.skewness < 0 ? "partial" : "absent",
      detail: stats.skewness < -0.3
        ? `顕著な負の歪度。暴落が暴騰より大きい傾向。`
        : stats.skewness < 0
          ? `弱い負の歪度。やや下方リスクが大きい。`
          : `正の歪度または対称。下落の非対称性は見られない。`,
    });

    // 5. Leverage effect
    results.push({
      name: "レバレッジ効果",
      description: "下落時にボラティリティが上昇する",
      value: `Corr(r_t, |r_{t+1}|) = ${leverageCorr.toFixed(4)}`,
      status: leverageCorr < -0.1 ? "confirmed" : leverageCorr < 0 ? "partial" : "absent",
      detail: leverageCorr < -0.1
        ? `下落するとボラティリティが増加する傾向が明確。GJR-GARCH/EGARCHが有効。`
        : leverageCorr < 0
          ? `弱いレバレッジ効果。`
          : `レバレッジ効果なし（株式以外で一般的）。`,
    });

    // 6. Long memory in volatility
    const longMemAcf = acfAbs.length > 15 ? acfAbs[15].value : 0;
    results.push({
      name: "ボラティリティの長期記憶",
      description: "ボラティリティの自己相関が長期間持続する",
      value: `|r|のACF(15) = ${longMemAcf.toFixed(4)}`,
      status: longMemAcf > 0.05 ? "confirmed" : longMemAcf > 0.02 ? "partial" : "absent",
      detail: longMemAcf > 0.05
        ? `ボラティリティが長期にわたり持続。FIGARCH/HAR型モデルが適切。`
        : longMemAcf > 0.02
          ? `中程度の長期記憶。`
          : `ボラティリティの長期記憶は弱い。`,
    });

    return results;
  }, [prices, seriesMode, values]);

  // Scorecard canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || facts.length === 0) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 30 + facts.length * 38;
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

    facts.forEach((fact, i) => {
      const y = 20 + i * 38;

      // Status indicator
      const statusColor =
        fact.status === "confirmed" ? "#16a34a" :
        fact.status === "partial" ? "#d97706" : "#dc2626";
      const statusLabel =
        fact.status === "confirmed" ? "検出" :
        fact.status === "partial" ? "弱い" : "未検出";

      ctx.fillStyle = statusColor;
      ctx.beginPath();
      ctx.arc(16, y, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#fff";
      ctx.font = "bold 8px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(fact.status === "confirmed" ? "O" : fact.status === "partial" ? "△" : "X", 16, y + 3);

      // Fact name and value
      ctx.fillStyle = "#333";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(fact.name, 30, y - 2);

      ctx.fillStyle = "#666";
      ctx.font = "10px sans-serif";
      ctx.fillText(fact.value, 30, y + 12);

      // Status text
      ctx.fillStyle = statusColor;
      ctx.font = "10px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(statusLabel, width - 10, y + 4);
    });
  }, [facts]);

  const confirmedCount = facts.filter((f) => f.status === "confirmed").length;
  const partialCount = facts.filter((f) => f.status === "partial").length;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        Stylized Facts（金融時系列の典型的性質）
      </h3>

      {facts.length > 0 && (
        <div className="bg-gray-50 rounded p-2 text-xs text-gray-600 mb-3">
          6つの定型的事実のうち <span className="font-bold text-green-700">{confirmedCount}個検出</span>
          {partialCount > 0 && <>, <span className="text-yellow-700">{partialCount}個は弱い</span></>}
        </div>
      )}

      <canvas ref={canvasRef} />

      {/* 詳細テキスト */}
      {facts.length > 0 && (
        <div className="mt-3 space-y-2">
          {facts.map((fact, i) => (
            <div key={i} className="text-xs text-gray-500">
              <span className="font-medium text-gray-700">{fact.name}:</span> {fact.detail}
            </div>
          ))}
        </div>
      )}

      <AnalysisGuide title="Stylized Factsの詳細理論">
        <p className="font-medium text-gray-700">1. Stylized Factsとは</p>
        <p>
          「金融時系列の定型的事実」は、市場や期間を問わず広く観測される統計的性質のことです。
          1960年代のMandelbrotの研究から始まり、Cont(2001)がまとめた6つの性質が標準的です。
          これらは「市場がどう動くか」の基本法則であり、あらゆる金融モデルの前提条件です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 6つの定型的事実</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ファットテール</strong>: 正規分布より極端な値動きが頻繁に起きる。超過尖度 {">"} 0</li>
          <li><strong>リターンの非自己相関</strong>: 過去のリターンは将来を予測しない（効率的市場）</li>
          <li><strong>ボラティリティ・クラスタリング</strong>: |r_t|の自己相関が高い → GARCHで捕捉</li>
          <li><strong>利益/損失の非対称性</strong>: 下落の方が大きく急激（負の歪度）</li>
          <li><strong>レバレッジ効果</strong>: 下落→ボラ上昇（Black, 1976）。Corr(r_t, σ_{"{t+1}"}) {"<"} 0</li>
          <li><strong>ボラティリティの長期記憶</strong>: |r_t|のACFがゆっくり減衰（べき乗則的）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>緑(検出): その性質が統計的に明確に確認された</li>
          <li>黄(弱い): 傾向はあるが統計的に弱い</li>
          <li>赤(未検出): その性質が見られない（異常ではなく、銘柄特性の可能性）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ファットテール → VaRを正規分布で計算するとリスクを過小評価</li>
          <li>非自己相関 → テクニカル分析の有効性に疑問（この銘柄では）</li>
          <li>ボラクラスタリング → GARCH予測でリスク管理を動的に行うべき</li>
          <li>レバレッジ効果 → 下落局面ではオプション（プット）が割高になりやすい</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>対数リターンで計測するのが標準（価格水準では非定常性が混入）</li>
          <li>期間が短いと検出力が不足する（最低1年分推奨）</li>
          <li>個別株は市場インデックスより性質が不安定なことがある</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
