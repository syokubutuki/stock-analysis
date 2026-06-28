"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { waveletDenoise, type DenoiseStrength } from "../../lib/wavelet-denoise";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const STRENGTHS: { key: DenoiseStrength; label: string }[] = [
  { key: "weak", label: "弱" },
  { key: "mid", label: "中" },
  { key: "strong", label: "強" },
];

export default function WaveletDenoiseChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const [strength, setStrength] = useState<DenoiseStrength>("mid");

  const res = useMemo(() => waveletDenoise(prices, strength), [prices, strength]);

  useEffect(() => {
    if (!chartRef.current || !res || res.time.length < 2) return;
    if (apiRef.current) apiRef.current.remove();
    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 280,
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;
    const obs = chart.addSeries(LineSeries, {
      color: "#cbd5e1",
      lineWidth: 1,
      title: "観測価格",
    });
    obs.setData(
      res.time.map((t, i) => ({ time: t as Time, value: res.observed[i] }))
    );
    const den = chart.addSeries(LineSeries, {
      color: "#7c3aed",
      lineWidth: 2,
      title: "ノイズ除去後",
    });
    den.setData(
      res.time.map((t, i) => ({ time: t as Time, value: res.denoised[i] }))
    );
    chart.timeScale().fitContent();
    const onResize = () =>
      chartRef.current &&
      chart.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      apiRef.current = null;
    };
  }, [res]);

  if (prices.length < 64) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">
          ウェーブレット・ノイズ除去（ダマシを減らしたトレンド抽出）
        </h3>
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span>除去強度:</span>
          {STRENGTHS.map((s) => (
            <button
              key={s.key}
              onClick={() => setStrength(s.key)}
              className={`px-2 py-0.5 rounded ${
                strength === s.key
                  ? "bg-violet-600 text-white"
                  : "bg-gray-100 hover:bg-gray-200"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {res && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div
            className={`p-2 rounded border ${
              res.trendUp
                ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                : "border-red-300 bg-red-50 text-red-700"
            }`}
          >
            <div className="text-gray-500">現在のトレンド方向</div>
            <div className="font-medium text-sm">
              {res.trendUp ? "上昇 ▲" : "下降 ▼"}
            </div>
            <div className="text-[10px] text-gray-400">除去後系列の傾き</div>
          </div>
          <div className="p-2 rounded border border-gray-200 bg-gray-50">
            <div className="text-gray-500">ダマシ削減率</div>
            <div className="font-mono font-medium">
              {res.whipsawReduction.toFixed(0)}%
            </div>
            <div className="text-[10px] text-gray-400">
              方向転換 {res.rawFlips}→{res.denoisedFlips}回
            </div>
          </div>
          <div className="p-2 rounded border border-gray-200 bg-gray-50">
            <div className="text-gray-500">推定ノイズ</div>
            <div className="font-mono font-medium">
              {res.sigmaNoisePct.toFixed(2)}%
            </div>
            <div className="text-[10px] text-gray-400">残差の標準偏差</div>
          </div>
          <div className="p-2 rounded border border-gray-200 bg-gray-50">
            <div className="text-gray-500">現在乖離</div>
            <div className="font-mono font-medium">
              {res.currentDeviationPct >= 0 ? "+" : ""}
              {res.currentDeviationPct.toFixed(2)}%
            </div>
            <div className="text-[10px] text-gray-400">観測−除去後</div>
          </div>
        </div>
      )}

      <div ref={chartRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="ウェーブレット・ノイズ除去の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {
            "価格を異なる時間スケール(細かい揺れ〜大きなうねり)に分解し、『細かいスケールに散らばった小さな成分=ノイズ』だけを削って再構成する。移動平均と違い、急な本物の転換は残しつつ、こまかいギザギザだけを消せるのが特徴。紫線=ノイズ除去後の価格。"
          }
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            {
              "対数価格をHaarウェーブレットで多重分解 → 各スケールの『詳細係数』を得る。ノイズは多数の小さい係数に薄く広がり、信号は少数の大きな係数に集中する(スパース性)。"
            }
          </li>
          <li>
            {
              "ノイズ標準偏差 σ = MAD(最細スケールの詳細係数)/0.6745。MAD=中央絶対偏差で外れ値に頑健。"
            }
          </li>
          <li>{"普遍閾値 λ = σ·√(2 ln N)、 N=データ数。"}</li>
          <li>
            {
              "ソフト閾値: 係数 d → sign(d)·max(|d|−λ, 0)。閾値以下を0、超えた分も λ だけ縮める。残りを逆変換して除去後系列に。"
            }
          </li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>ウェーブレット</strong>
            : 短い波の“ものさし”。長いものさしで大きなうねりを、短いものさしで細かい揺れを測り、スケール別に分ける。
          </li>
          <li>
            <strong>ソフト閾値</strong>
            : ノイズフロア。小さな音(ノイズ)を消し、大きな音(信号)だけ残すノイズゲートと同じ発想。
          </li>
          <li>
            例え: 写真のノイズリダクション。のっぺりさせず輪郭(トレンド転換)を残してザラつきだけ消す。
          </li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>トレンドフォロー</strong>
            : 除去後系列の傾き符号をエントリー方向に使うと、生の価格×移動平均クロスより『ダマシ(往復)』が減る。削減率はその効果の目安。
          </li>
          <li>
            <strong>転換点の確度</strong>
            : 除去後の線が向きを変えたら、ノイズではない本物の転換の可能性が高い。
          </li>
          <li>
            <strong>現在乖離</strong>
            がプラス大=ノイズで上に跳ねている＝短期の戻り売り余地、マイナス大=押し目買い余地の目安。
          </li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            右端(最新)はデータが片側しかなく、後から係数が変わると線が動く(再構成のにじみ)。直近の転換判定は確定でない。
          </li>
          <li>
            除去強度『強』はトレンドの初動まで削りがち。弱いほど反応は速いがダマシは残る。
          </li>
          <li>
            Haarは階段状の癖が出る。あくまでノイズ低減の補助であり、単独のシグナルにせず他指標と併用する。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
