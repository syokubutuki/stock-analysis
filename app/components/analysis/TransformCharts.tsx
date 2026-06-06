"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  AreaSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  logReturns,
  rankTransform,
  volNormalizedReturns,
  cumulativeLogReturns,
  differencing,
  boxCoxTransform,
  drawdown,
  rollingZScore,
} from "../../lib/transforms";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

type TransformMode =
  | "logReturn"
  | "rank"
  | "volNorm"
  | "cumReturn"
  | "diff"
  | "boxcox"
  | "drawdown"
  | "zscore";

const MODE_LABELS: Record<TransformMode, string> = {
  logReturn: "対数リターン",
  rank: "順位変換",
  volNorm: "ボラ正規化",
  cumReturn: "累積リターン",
  diff: "差分変換",
  boxcox: "Box-Cox",
  drawdown: "ドローダウン",
  zscore: "Zスコア",
};

export default function TransformCharts({ prices, seriesMode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [mode, setMode] = useState<TransformMode>("logReturn");
  const [diffOrder, setDiffOrder] = useState(1);
  const [boxcoxLambda, setBoxcoxLambda] = useState(0.5);
  const [zscoreWindow, setZscoreWindow] = useState(60);

  const { values: closes, times } = extractSeries(prices, seriesMode);
  const needsTransform = seriesMode === "close" || seriesMode === "open";

  useEffect(() => {
    if (!containerRef.current || closes.length < 2) return;

    if (chartRef.current) chartRef.current.remove();

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 260,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    let data: number[] = [];
    let dataTimesArr: string[] = [];

    const lr = needsTransform ? logReturns(closes) : closes;
    const lrTimes = needsTransform ? times.slice(1) : times;

    switch (mode) {
      case "logReturn":
        data = lr;
        dataTimesArr = lrTimes;
        break;
      case "rank":
        data = rankTransform(lr);
        dataTimesArr = lrTimes;
        break;
      case "volNorm":
        data = needsTransform ? volNormalizedReturns(closes, 20) : closes;
        dataTimesArr = lrTimes;
        break;
      case "cumReturn":
        data = cumulativeLogReturns(closes);
        dataTimesArr = times; // same length as closes
        break;
      case "diff": {
        const d = differencing(closes, diffOrder);
        data = d;
        dataTimesArr = times.slice(diffOrder);
        break;
      }
      case "boxcox":
        data = boxCoxTransform(closes, boxcoxLambda);
        dataTimesArr = times;
        break;
      case "drawdown":
        data = drawdown(closes);
        dataTimesArr = times;
        break;
      case "zscore":
        data = rollingZScore(closes, zscoreWindow);
        dataTimesArr = times;
        break;
    }

    // Choose chart type based on mode
    if (mode === "logReturn" || mode === "diff") {
      const series = chart.addSeries(HistogramSeries, {
        title: MODE_LABELS[mode],
      });
      series.setData(
        data.map((v, i) => ({
          time: dataTimesArr[i] as Time,
          value: v,
          color: v >= 0 ? "rgba(38, 166, 154, 0.6)" : "rgba(239, 83, 80, 0.6)",
        }))
      );
    } else if (mode === "drawdown") {
      const series = chart.addSeries(AreaSeries, {
        topColor: "rgba(239, 83, 80, 0.05)",
        bottomColor: "rgba(239, 83, 80, 0.3)",
        lineColor: "#ef5350",
        lineWidth: 1,
        title: MODE_LABELS[mode],
      });
      series.setData(
        data.map((v, i) => ({
          time: dataTimesArr[i] as Time,
          value: v * 100,
        }))
      );
    } else if (mode === "volNorm" || mode === "zscore") {
      const series = chart.addSeries(HistogramSeries, {
        title: MODE_LABELS[mode],
      });
      series.setData(
        data.map((v, i) => {
          const absV = Math.abs(v);
          let color: string;
          if (absV > 3) color = v >= 0 ? "rgba(21, 101, 192, 0.8)" : "rgba(198, 40, 40, 0.8)";
          else if (absV > 2) color = v >= 0 ? "rgba(38, 166, 154, 0.7)" : "rgba(239, 83, 80, 0.7)";
          else color = v >= 0 ? "rgba(38, 166, 154, 0.4)" : "rgba(239, 83, 80, 0.4)";
          return { time: dataTimesArr[i] as Time, value: v, color };
        })
      );
    } else if (mode === "cumReturn") {
      const series = chart.addSeries(AreaSeries, {
        topColor: "rgba(99, 102, 241, 0.3)",
        bottomColor: "rgba(99, 102, 241, 0.02)",
        lineColor: "#6366f1",
        lineWidth: 2,
        title: MODE_LABELS[mode],
      });
      series.setData(
        data.map((v, i) => ({
          time: dataTimesArr[i] as Time,
          value: v * 100,
        }))
      );
    } else {
      const series = chart.addSeries(LineSeries, {
        color: "#6366f1",
        lineWidth: 1,
        title: MODE_LABELS[mode],
      });
      series.setData(
        data.map((v, i) => ({
          time: dataTimesArr[i] as Time,
          value: v,
        }))
      );
    }

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current)
        chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [prices, mode, seriesMode, diffOrder, boxcoxLambda, zscoreWindow]);

  // 統計情報
  const lr = needsTransform ? logReturns(closes) : closes;
  const mean = lr.length > 0 ? lr.reduce((a, b) => a + b, 0) / lr.length : 0;
  const std = lr.length > 0
    ? Math.sqrt(lr.reduce((a, v) => a + (v - mean) ** 2, 0) / lr.length)
    : 0;
  const skew = lr.length > 0 && std > 0
    ? lr.reduce((a, v) => a + ((v - mean) / std) ** 3, 0) / lr.length
    : 0;
  const kurt = lr.length > 0 && std > 0
    ? lr.reduce((a, v) => a + ((v - mean) / std) ** 4, 0) / lr.length - 3
    : 0;

  // Drawdown stats
  const dd = drawdown(closes);
  const maxDD = dd.length > 0 ? Math.min(...dd) : 0;
  const currentDD = dd.length > 0 ? dd[dd.length - 1] : 0;

  // Cumulative return
  const cumRet = closes.length >= 2 ? Math.log(closes[closes.length - 1] / closes[0]) : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">スケール・変換</h3>
        <div className="flex gap-1 flex-wrap">
          {(Object.keys(MODE_LABELS) as TransformMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2 py-1 text-xs rounded font-medium transition-colors ${
                mode === m
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {/* Mode-specific parameters */}
      {mode === "diff" && (
        <div className="mb-2 flex items-center gap-2 text-xs">
          <span className="text-gray-500">差分の階数:</span>
          {[1, 2, 3].map((o) => (
            <button
              key={o}
              onClick={() => setDiffOrder(o)}
              className={`px-2 py-0.5 rounded ${
                diffOrder === o
                  ? "bg-indigo-100 text-indigo-700 font-medium"
                  : "bg-gray-50 text-gray-500 hover:bg-gray-100"
              }`}
            >
              {o}次
            </button>
          ))}
        </div>
      )}
      {mode === "boxcox" && (
        <div className="mb-2 flex items-center gap-2 text-xs">
          <span className="text-gray-500">λ:</span>
          {[0, 0.25, 0.5, 1].map((l) => (
            <button
              key={l}
              onClick={() => setBoxcoxLambda(l)}
              className={`px-2 py-0.5 rounded ${
                boxcoxLambda === l
                  ? "bg-indigo-100 text-indigo-700 font-medium"
                  : "bg-gray-50 text-gray-500 hover:bg-gray-100"
              }`}
            >
              {l === 0 ? "ln" : l}
            </button>
          ))}
        </div>
      )}
      {mode === "zscore" && (
        <div className="mb-2 flex items-center gap-2 text-xs">
          <span className="text-gray-500">窓幅:</span>
          {[20, 60, 120, 252].map((w) => (
            <button
              key={w}
              onClick={() => setZscoreWindow(w)}
              className={`px-2 py-0.5 rounded ${
                zscoreWindow === w
                  ? "bg-indigo-100 text-indigo-700 font-medium"
                  : "bg-gray-50 text-gray-500 hover:bg-gray-100"
              }`}
            >
              {w}日
            </button>
          ))}
        </div>
      )}

      <div ref={containerRef} className="w-full rounded border border-gray-100" />

      <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均リターン</div>
          <div className="font-mono font-medium">{(mean * 100).toFixed(4)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">標準偏差</div>
          <div className="font-mono font-medium">{(std * 100).toFixed(4)}%</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">歪度</div>
          <div className={`font-mono font-medium ${Math.abs(skew) > 0.5 ? "text-orange-600" : ""}`}>
            {skew.toFixed(3)}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">尖度(超過)</div>
          <div className={`font-mono font-medium ${kurt > 1 ? "text-red-600" : ""}`}>
            {kurt.toFixed(3)}
          </div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">累積リターン</div>
          <div className={`font-mono font-medium ${cumRet >= 0 ? "text-teal-600" : "text-red-600"}`}>
            {(cumRet * 100).toFixed(2)}%
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">最大ドローダウン</div>
          <div className="font-mono font-medium text-red-600">
            {(maxDD * 100).toFixed(2)}%
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">現在ドローダウン</div>
          <div className={`font-mono font-medium ${currentDD < -0.05 ? "text-red-600" : "text-gray-700"}`}>
            {(currentDD * 100).toFixed(2)}%
          </div>
        </div>
      </div>

      <AnalysisGuide title="スケール変換分析の詳細理論">
        <p className="font-medium text-gray-700">1. スケール変換とは</p>
        <p>株価の生データを分析に適した形に変換する前処理です。変換方法によって異なる側面が可視化され、各変換の統計量を比較することで、データの構造的な特徴を把握できます。</p>
        <p className="mt-1">地図に例えると、対数リターンは「標高差の地図」、順位変換は「標高の順位地図」、ボラ正規化は「その地域の平均的な起伏で割った相対地図」です。同じ地形でも異なる地図を使うと異なる情報が得られます。</p>

        <p className="font-medium text-gray-700 mt-3">2. 各変換の数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded whitespace-pre-line">{"対数リターン: r_t = ln(P_t / P_{t-1})\n  性質: r_{t→t+n} = Σ r_i（加法的）\n\n順位変換: R_t = rank(r_t) / (N+1)\n  R_t ∈ (0, 1)、一様分布に従う\n\nボラティリティ正規化: z_t = r_t / σ_{t,20}\n  σ_{t,20} = std(r_{t-19}, ..., r_t)\n\n累積リターン: C_t = Σ_{i=1}^{t} r_i = ln(P_t / P_0)\n  初期値からの累積的なパフォーマンスを表す\n\n差分変換: Δ^d x_t = (1-B)^d x_t\n  1次: Δx_t = x_t - x_{t-1}\n  2次: Δ²x_t = x_t - 2x_{t-1} + x_{t-2}\n  d次差分でI(d)過程を定常化\n\nBox-Cox変換:\n  y_t = (x_t^λ - 1) / λ  (λ ≠ 0)\n  y_t = ln(x_t)            (λ = 0)\n  λ=0.5 → 平方根変換、λ=1 → 線形\n\nドローダウン: DD_t = (P_t - max_{s≤t} P_s) / max_{s≤t} P_s\n  常に ≤ 0。ピークからの下落率を表す\n\nローリングZスコア: Z_t = (x_t - μ_w) / σ_w\n  μ_w, σ_w は直近w日の平均・標準偏差"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>対数リターン</strong>: {"ln(P_t/P_{t-1})"}で計算。算術リターン（ΔP/P）と異なり、加法的に積み上がる。金融工学の標準的な尺度</li>
          <li><strong>順位変換</strong>: データを順位に変換し0〜1に正規化。ノンパラメトリック分析の基盤。外れ値に完全にロバスト</li>
          <li><strong>ボラティリティ正規化</strong>: 局所的なボラティリティで割ることで、異なるボラティリティ環境下のリターンを同一尺度で比較可能にする</li>
          <li><strong>累積リターン</strong>: 対数リターンを積み上げたもの。初期投資からのトータルリターンの推移を表す。値は対数スケールなので、{"e^C_t - 1"}が実際の収益率</li>
          <li><strong>差分変換</strong>: 非定常な時系列を定常化するための変換。1次差分は「変化量」、2次差分は「変化の変化（加速度）」を表す</li>
          <li><strong>Box-Cox変換</strong>: べき変換の一般化。分散の安定化と正規分布への近似を同時に達成する。λを調整して最適な変換を選ぶ</li>
          <li><strong>ドローダウン</strong>: 資産のピークからの下落率。投資のリスク管理で最も直感的な指標の一つ</li>
          <li><strong>ローリングZスコア</strong>: 移動窓内での相対的な位置を標準偏差で測る。平均回帰の検出やトレンドの強さの評価に使う</li>
          <li><strong>超過尖度</strong>: 尖度から3を引いた値。正規分布なら0。正ならファットテール（極端な値動きが多い）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>対数リターンの平均</strong>: 日次平均 × 252 ≈ 年率リターン。正なら期間中に上昇トレンド</li>
          <li><strong>標準偏差 × √252 {">"} 30%</strong>: 高ボラティリティ銘柄。リスク管理を厳格にすべき</li>
          <li><strong>歪度の絶対値 {">"} 0.5</strong>: 有意な非対称性。負ならダウンサイドリスクが大きい</li>
          <li><strong>超過尖度 {">"} 3</strong>: 強いファットテール。正規分布ベースのリスク計算は不適切</li>
          <li><strong>累積リターンが右肩上がり</strong>: 持続的な上昇トレンド。傾きの変化がトレンド転換を示唆</li>
          <li><strong>差分が0付近で安定</strong>: 定常過程に近い。1次差分で安定しなければ2次差分を試す</li>
          <li><strong>Box-Cox（λ=0.5）後の分布</strong>: 元データより正規分布に近づけば、この変換が有効</li>
          <li><strong>最大ドローダウン {">"} -30%</strong>: 大きなリスクイベントを経験。回復に長期間要する可能性</li>
          <li><strong>Zスコア {">"} +2 / {"<"} -2</strong>: 移動窓内で統計的に異常な水準。平均回帰が期待される</li>
          <li><strong>ボラ正規化で |z_t| {">"} 3</strong>: 極めて稀な動き（約0.3%の確率）。イベント駆動の可能性</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>異常検知</strong>: ボラ正規化リターンやZスコアが±3を超えた日は、通常では説明できない動き。ニュースの確認や一時的なポジション調整を検討</li>
          <li><strong>ドローダウン管理</strong>: 最大ドローダウンに基づくポジションサイジング。例えば最大DDが-20%なら、許容損失額÷20%がポジション上限</li>
          <li><strong>平均回帰戦略</strong>: Zスコアが±2を超えたら逆張りエントリー、0に戻ったらイグジット。窓幅を短く（20日）すると短期の回帰、長く（252日）すると長期の回帰を捉える</li>
          <li><strong>リスク指標の補正</strong>: 超過尖度が大きい銘柄では、正規分布ベースのVaRにCornish-Fisher補正を適用して過小評価を防ぐ</li>
          <li><strong>相関分析の前処理</strong>: 順位変換を使えば、外れ値に頑健なSpearman相関やKendall相関の基盤が得られる</li>
          <li><strong>定常性の確認</strong>: 差分変換で系列が安定するかを確認し、ARIMAの差分次数dを決定する前処理として活用</li>
          <li><strong>分布の正規化</strong>: Box-Cox変換後のデータに対して正規分布ベースの統計手法（t検定、回帰分析等）を適用する</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>対数リターンと算術リターンの差</strong>: 大きな変動（±10%超）では両者の乖離が無視できない。レバレッジ計算では算術リターンが適切な場合がある</li>
          <li><strong>順位変換の情報損失</strong>: 値の大きさの情報が失われるため、「どれだけ大きく動いたか」は把握できない</li>
          <li><strong>ボラ正規化の遅延</strong>: 20日ローリング標準偏差は過去のボラティリティに基づくため、ボラティリティの急変時には正規化が不完全</li>
          <li><strong>差分の過剰適用</strong>: 必要以上に差分を取ると情報が失われる（over-differencing）。ADF検定等で適切な次数を確認すべき</li>
          <li><strong>Box-Coxの前提</strong>: 正の値のみに適用可能。λの最適値はデータに依存するため、対数尤度で選択するのが理想的</li>
          <li><strong>ドローダウンの非対称性</strong>: -50%のドローダウンからの回復には+100%のリターンが必要。下落率と回復の難易度は非線形</li>
          <li><strong>Zスコアの窓幅依存性</strong>: 窓幅が短いとノイズに敏感、長いと構造変化に鈍感。分析目的に応じて適切な窓幅を選ぶ</li>
          <li><strong>定常性の前提</strong>: 各変換は暗黙的に定常性（統計的性質が時間で変わらない）を仮定するが、実際の株価は非定常であることが多い</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
