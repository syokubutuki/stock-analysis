"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeVWTechnical } from "../../lib/volume-price-dynamics";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; }

export default function VolumeWeightedTechChart({ prices }: Props) {
  const rsiRef = useRef<HTMLDivElement>(null);
  const macdRef = useRef<HTMLDivElement>(null);
  const rsiApi = useRef<IChartApi | null>(null);
  const macdApi = useRef<IChartApi | null>(null);
  const result = useMemo(() => computeVWTechnical(prices), [prices]);

  useEffect(() => {
    if (!rsiRef.current || result.dates.length === 0) return;
    const chart = createChart(rsiRef.current, {
      width: rsiRef.current.clientWidth, height: 250,
      layout: { textColor: "#374151", fontSize: 11 },
      grid: { vertLines: { color: "#f3f4f6" }, horzLines: { color: "#f3f4f6" } },
      rightPriceScale: { borderColor: "#e5e7eb" }, timeScale: { borderColor: "#e5e7eb" },
    });
    rsiApi.current = chart;

    const rsiSeries = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 1, title: "RSI(14)" });
    const vwRsiSeries = chart.addSeries(LineSeries, { color: "#ef4444", lineWidth: 2, title: "VW-RSI(14)" });

    rsiSeries.setData(result.dates.map((t, i) => ({ time: t as Time, value: result.rsi[i] })).filter(d => d.value > 0));
    vwRsiSeries.setData(result.dates.map((t, i) => ({ time: t as Time, value: result.vwRsi[i] })).filter(d => d.value > 0));
    chart.timeScale().fitContent();

    const h = () => { if (rsiRef.current) chart.applyOptions({ width: rsiRef.current.clientWidth }); };
    window.addEventListener("resize", h);
    return () => { window.removeEventListener("resize", h); chart.remove(); rsiApi.current = null; };
  }, [result]);

  useEffect(() => {
    if (!macdRef.current || result.dates.length === 0) return;
    const chart = createChart(macdRef.current, {
      width: macdRef.current.clientWidth, height: 250,
      layout: { textColor: "#374151", fontSize: 11 },
      grid: { vertLines: { color: "#f3f4f6" }, horzLines: { color: "#f3f4f6" } },
      rightPriceScale: { borderColor: "#e5e7eb" }, timeScale: { borderColor: "#e5e7eb" },
    });
    macdApi.current = chart;

    const macdSeries = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 1, title: "MACD" });
    const vwMacdSeries = chart.addSeries(LineSeries, { color: "#ef4444", lineWidth: 2, title: "VW-MACD" });

    macdSeries.setData(result.dates.map((t, i) => ({ time: t as Time, value: result.macd[i] })));
    vwMacdSeries.setData(result.dates.map((t, i) => ({ time: t as Time, value: result.vwMacd[i] })));
    chart.timeScale().fitContent();

    const h = () => { if (macdRef.current) chart.applyOptions({ width: macdRef.current.clientWidth }); };
    window.addEventListener("resize", h);
    return () => { window.removeEventListener("resize", h); chart.remove(); macdApi.current = null; };
  }, [result]);

  if (result.dates.length === 0) return null;

  const divs = result.divergence.slice(0, 10);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">出来高加重テクニカル指標</h3>
      <p className="text-xs text-gray-500">通常のRSI/MACDと出来高で加重した版を比較。乖離は出来高を伴わない動きを示唆。</p>

      <div className="text-xs text-gray-600 font-medium">RSI vs 出来高加重RSI</div>
      <div ref={rsiRef} />
      <div className="text-xs text-gray-600 font-medium">MACD vs 出来高加重MACD</div>
      <div ref={macdRef} />

      {divs.length > 0 && (
        <div>
          <div className="text-xs text-gray-600 font-medium mb-1">直近の乖離ポイント (上位10)</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead><tr className="border-b border-gray-200">
                <th className="py-1 px-2 text-left text-gray-500">日付</th>
                <th className="py-1 px-2 text-center text-gray-500">指標</th>
                <th className="py-1 px-2 text-center text-gray-500">通常</th>
                <th className="py-1 px-2 text-center text-gray-500">出来高加重</th>
                <th className="py-1 px-2 text-center text-gray-500">乖離</th>
              </tr></thead>
              <tbody>
                {divs.map((d, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    <td className="py-1 px-2 font-mono text-gray-600">{d.date}</td>
                    <td className="py-1 px-2 text-center font-medium">{d.type.toUpperCase()}</td>
                    <td className="py-1 px-2 text-center font-mono">{d.standard.toFixed(2)}</td>
                    <td className="py-1 px-2 text-center font-mono">{d.vw.toFixed(2)}</td>
                    <td className={`py-1 px-2 text-center font-mono font-medium ${d.diff > 0 ? "text-green-600" : "text-red-600"}`}>{d.diff > 0 ? "+" : ""}{d.diff.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <AnalysisGuide title="出来高加重テクニカル指標の詳細理論">
        <p className="font-medium text-gray-700">1. 出来高加重テクニカルとは</p>
        <p>従来のテクニカル指標（RSI・MACD）は全ての取引日を均等に扱いますが、出来高加重版は「大きな出来高を伴った日の動きをより重要視」します。出来高は市場参加者の確信度の代理変数であり、出来高が多い日の価格変動はより「本物」のシグナルである可能性が高いです。</p>
        <p className="mt-1">投票に例えると、通常のRSIは「1人1票」ですが、VW-RSIは「投票数（出来高）に応じた加重投票」です。大勢が参加した日の判定をより重視することで、少数の取引で動いた「見せかけのシグナル」を割り引くことができます。</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"VW-RSI:\n  VW_gain_t = max(0, ΔP_t) × V_t / V_avg\n  VW_loss_t = max(0, -ΔP_t) × V_t / V_avg\n  VW-RSI = 100 × EMA(VW_gain) / [EMA(VW_gain) + EMA(VW_loss)]\n\nVW-MACD:\n  VWP_t = Σ(P_i × V_i) / Σ(V_i)  (出来高加重価格)\n  VW-MACD = EMA_12(VWP) - EMA_26(VWP)\n  Signal = EMA_9(VW-MACD)\n\n乖離: Δ = VW指標 - 通常指標"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>V_t / V_avg</strong>: 当日出来高を平均出来高で正規化した重み。出来高が平均の2倍なら重みも2倍</li>
          <li><strong>VWP_t</strong>: 出来高加重価格。出来高が集中した価格帯に引き寄せられる</li>
          <li><strong>Δ（乖離）</strong>: 出来高加重と通常版の差。出来高の偏りによるシグナルの質を評価</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>RSI（相対力指数）</strong>: 一定期間の上昇幅と下落幅の比率から算出される0〜100の指標。70以上で買われ過ぎ、30以下で売られ過ぎ</li>
          <li><strong>MACD</strong>: 短期EMAと長期EMAの差。トレンドの方向と強さを示す。シグナル線とのクロスが売買シグナル</li>
          <li><strong>EMA（指数移動平均）</strong>: 直近のデータに指数的に大きな重みを置く移動平均。単純移動平均より反応が速い</li>
          <li><strong>VWAP</strong>: 出来高加重平均価格。機関投資家が執行コストを評価する際の基準価格</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>VW-RSI {">"} RSI</strong>: 上昇時に出来高が伴っている。買い圧力が本物で、トレンドの信頼性が高い</li>
          <li><strong>VW-RSI {"<"} RSI</strong>: 上昇が出来高を伴っていない。少数の取引で価格が動いており、トレンドが脆弱</li>
          <li><strong>VW-MACD {">"} MACD</strong>: 出来高が多い日に上昇が集中。機関投資家の買いが示唆される</li>
          <li><strong>乖離が急拡大</strong>: 出来高と価格の関係に異変。トレンド転換の予兆となることがある</li>
          <li><strong>VW-RSIが70超でRSIは70未満</strong>: 出来高を考慮すると実質的に買われ過ぎ。注意が必要</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>トレンド確認</strong>: 価格上昇＋VW-RSI{">"} RSI（出来高を伴った上昇）なら、トレンドフォローのエントリーに自信が持てる</li>
          <li><strong>ダイバージェンス検出</strong>: 価格が上昇しているがVW-RSIが低下している場合、出来高を伴わない脆弱な上昇であり、反転リスクが高い</li>
          <li><strong>売買タイミング</strong>: VW-MACDのシグナルクロスは、通常MACDより偽シグナルが少ない傾向がある</li>
          <li><strong>乖離テーブルの活用</strong>: RSI乖離・MACD乖離の大きさから、出来高を伴わない異常な動きを定量的にスクリーニングできる</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>出来高の信頼性</strong>: 寄り付き・引けのオークションや大口のブロック取引で出来高が歪む場合がある</li>
          <li><strong>低流動性銘柄</strong>: 出来高が極端に少ない銘柄では出来高加重が不安定になり、ノイズが増幅される</li>
          <li><strong>パラメータの固定</strong>: RSI(14)・MACD(12,26,9)は経験的に広く使われる設定だが、銘柄や市場環境によって最適値は異なる</li>
          <li><strong>出来高のトレンド</strong>: 長期的に出来高が増減する銘柄では、V_avgの計算期間によって結果が変わる</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
