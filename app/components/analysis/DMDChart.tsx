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
import { computeDMD } from "../../lib/dmd";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

const MODE_COLORS = ["#3b82f6", "#ef4444", "#22c55e"];

export default function DMDChart({ prices, seriesMode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const { values, times } = extractSeries(prices, seriesMode);

  const dmdResult = useMemo(
    () => computeDMD(values, 5),
    [prices, seriesMode]
  );

  const topModes = dmdResult.modes.slice(0, 3);

  useEffect(() => {
    if (!containerRef.current || dmdResult.modes.length === 0) return;

    if (chartRef.current) chartRef.current.remove();

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: {
        vertLines: { color: "#f0f0f0" },
        horzLines: { color: "#f0f0f0" },
      },
      width: containerRef.current.clientWidth,
      height: 350,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    // Original series (gray)
    const origSeries = chart.addSeries(LineSeries, {
      color: "#9ca3af",
      lineWidth: 1,
      title: "原系列",
    });
    origSeries.setData(
      values.map((v, i) => ({
        time: times[i] as Time,
        value: v,
      }))
    );

    // Top 3 mode reconstructions
    topModes.forEach((mode, idx) => {
      const series = chart.addSeries(LineSeries, {
        color: MODE_COLORS[idx],
        lineWidth: 2,
        title: `モード${idx + 1}`,
      });
      series.setData(
        mode.reconstruction.map((v, i) => ({
          time: times[i] as Time,
          value: v,
        }))
      );
    });

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
  }, [prices, seriesMode, dmdResult]);

  const formatPeriod = (p: number) =>
    !isFinite(p) ? "トレンド" : `${p.toFixed(1)}日`;

  const growthColor = (g: number) => {
    if (g > 1.005) return "text-green-600";
    if (g < 0.995) return "text-red-600";
    return "text-gray-600";
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        DMD (動的モード分解)
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        時系列から支配的な振動モードを抽出し、周期・成長率・寄与度を分析
      </p>

      <div
        ref={containerRef}
        className="w-full rounded border border-gray-100"
      />

      {dmdResult.modes.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50 text-gray-600">
                <th className="px-3 py-1.5 text-left font-medium">モード</th>
                <th className="px-3 py-1.5 text-right font-medium">周期</th>
                <th className="px-3 py-1.5 text-right font-medium">成長率</th>
                <th className="px-3 py-1.5 text-right font-medium">寄与度</th>
              </tr>
            </thead>
            <tbody>
              {dmdResult.modes.map((mode, i) => (
                <tr
                  key={i}
                  className={`border-t border-gray-100 ${
                    i < 3 ? "bg-blue-50/30" : ""
                  }`}
                >
                  <td className="px-3 py-1.5 font-medium">
                    {i < 3 && (
                      <span
                        className="inline-block w-2 h-2 rounded-full mr-1.5"
                        style={{ backgroundColor: MODE_COLORS[i] }}
                      />
                    )}
                    #{i + 1}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {formatPeriod(mode.period)}
                  </td>
                  <td
                    className={`px-3 py-1.5 text-right font-mono ${growthColor(
                      mode.growthRate
                    )}`}
                  >
                    {mode.growthRate.toFixed(4)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    {mode.contribution.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dmdResult.modes.length === 0 && (
        <p className="text-xs text-gray-400 mt-2">
          データが不足しているため、DMDを計算できません（最低30点必要）。
        </p>
      )}

      <AnalysisGuide title="動的モード分解 (DMD) の詳細理論">
        <p className="font-medium text-gray-700">1. DMDとは</p>
        <p>
          動的モード分解 (Dynamic Mode Decomposition)
          は、時系列データから支配的な「振動モード」を抽出するデータ駆動型の手法です。
          元々は流体力学のシミュレーションデータ解析のために開発されましたが、
          金融時系列にも適用でき、価格変動に内在する周期的パターンや
          トレンド成分を分離して把握できます。フーリエ変換と異なり、
          各モードに「成長率（減衰率）」が付随するため、
          どの振動成分が強まっているか・弱まっているかを同時に分析できます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          {"時系列 x(t) を列ベクトルとして並べた行列 X = [x₁, x₂, ..., xₙ₋₁] と X' = [x₂, x₃, ..., xₙ] を構成します。"}
        </p>
        <p>
          {"DMDでは X' ≈ A·X となる最適な線形作用素 A を求めます。"}
        </p>
        <p>
          {"具体的には、X の特異値分解 X = UΣV* を行い、低ランク近似した空間上での射影 Ã = U*·X'·V·Σ⁻¹ を計算します。"}
        </p>
        <p>
          {"Ã の固有値 λᵢ から各モードの特性が得られます:"}
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"周期 = 2π / arg(λᵢ): 固有値の偏角から振動周期を算出"}</li>
          <li>{"成長率 = |λᵢ|: 固有値の絶対値が1より大きければ成長、小さければ減衰"}</li>
          <li>{"寄与度 = 対応する特異値の2乗の割合: そのモードが全体の変動をどれだけ説明するか"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>Hankel行列:</strong>{" "}
            時系列を遅延座標で埋め込んだ行列。1次元の時系列を多次元の「スナップショット」に変換します。写真を時間をずらして重ね合わせるイメージです。
          </li>
          <li>
            <strong>特異値分解 (SVD):</strong>{" "}
            行列を「回転」「拡大縮小」「回転」の3つの操作に分解する手法。データの中で最も重要な方向（主成分）を見つけます。
          </li>
          <li>
            <strong>固有値:</strong>{" "}
            線形変換の「伸び率と回転角」を表す数。複素数の場合、絶対値が伸び率、偏角が回転角（＝振動周波数）に対応します。コマの回転速度と、そのコマが大きくなるか小さくなるかを同時に表すようなものです。
          </li>
          <li>
            <strong>寄与度:</strong>{" "}
            各モードが全体の変動をどれだけ説明しているかの割合。大きいほどそのモードが価格変動の主要な構成要素であることを意味します。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の解釈</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>周期が「トレンド」:</strong>{" "}
            実固有値に対応し、振動を伴わない一方向の動き（上昇トレンドまたは下降トレンド）を表します。
          </li>
          <li>
            <strong>周期が数値（例: 20日）:</strong>{" "}
            その日数を1サイクルとする振動成分です。20日周期なら約1ヶ月ごとに同様のパターンが繰り返されます。
          </li>
          <li>
            <strong>成長率 &gt; 1.0（緑色）:</strong>{" "}
            そのモードは時間とともに振幅が増大しています。その振動成分が強まっていることを意味します。
          </li>
          <li>
            <strong>成長率 &lt; 1.0（赤色）:</strong>{" "}
            そのモードは減衰しています。その振動パターンが弱まっており、消えゆく動きです。
          </li>
          <li>
            <strong>成長率 ≈ 1.0（灰色）:</strong>{" "}
            安定した振動で、一定の振幅で繰り返されています。
          </li>
          <li>
            <strong>寄与度:</strong>{" "}
            50%を超えるモードがあれば、そのモードが価格変動の主成分です。寄与度が分散している場合、複数の要因が混在しています。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 直感的な例え</p>
        <p>
          DMDは、オーケストラの演奏から各楽器の音を個別に聞き分けるようなものです。
          価格変動という「合奏」の中から、短期の高周波ノイズ（バイオリンの細かいトレモロ）、
          中期のスイング（チェロの旋律）、長期トレンド（コントラバスの持続音）を
          それぞれ分離して聴くことができます。さらに、各楽器の音量が
          大きくなっているか小さくなっているか（成長率）も分かります。
        </p>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            トレンドモードの成長率が1を大きく超えている場合、トレンドフォロー戦略が有効な局面です。
          </li>
          <li>
            特定の周期モード（例: 20日）の寄与度が高い場合、その周期に合わせた逆張り（周期の底で買い、天井で売り）が検討できます。
          </li>
          <li>
            複数の振動モードが同時に成長している場合、ボラティリティが高まる兆候として警戒が必要です。
          </li>
          <li>
            すべてのモードが減衰している場合、値動きが小さくなり、レンジ相場からのブレイクアウトが近い可能性があります。
          </li>
          <li>
            寄与度の高いモードの周期を把握し、ポジションの保有期間やリバランスのタイミングの参考にできます。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            DMDは本質的に線形手法です。金融時系列の非線形性（急騰・暴落など）は完全には捉えられません。
          </li>
          <li>
            抽出されたモードの周期は過去データに基づくものであり、将来も同じ周期が継続する保証はありません。
          </li>
          <li>
            データ点数が少ない場合（30点未満）、計算が不安定になるため結果が得られません。
          </li>
          <li>
            埋め込み次元の選択により結果が変わる可能性があります。本実装では自動設定を使用しています。
          </li>
          <li>
            成長率が1を大きく超えるモードが見られても、それが直ちにバブルを意味するわけではありません。レジーム変化の可能性も考慮してください。
          </li>
          <li>
            EMD（経験的モード分解）やウェーブレット変換など、他の分解手法と併用して多角的に分析することを推奨します。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
