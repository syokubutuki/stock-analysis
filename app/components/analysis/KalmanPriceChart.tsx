"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { efficientPrice, type SmoothLevel } from "../../lib/efficient-price";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const LEVELS: { key: SmoothLevel; label: string }[] = [
  { key: "weak", label: "弱" },
  { key: "mid", label: "中" },
  { key: "strong", label: "強" },
];
const HORIZONS = [3, 5, 10];

export default function KalmanPriceChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const [level, setLevel] = useState<SmoothLevel>("mid");
  const [horizon, setHorizon] = useState(5);

  const res = useMemo(
    () => efficientPrice(prices, level, horizon),
    [prices, level, horizon]
  );

  useEffect(() => {
    if (!chartRef.current || !res || res.points.length < 2) return;
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
      color: "#9ca3af",
      lineWidth: 1,
      title: "観測価格",
    });
    obs.setData(
      res.points.map((p) => ({ time: p.time as Time, value: p.observed }))
    );
    const eff = chart.addSeries(LineSeries, {
      color: "#2563eb",
      lineWidth: 2,
      title: "効率的価格",
    });
    eff.setData(
      res.points.map((p) => ({ time: p.time as Time, value: p.efficient }))
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

  if (prices.length < 80) return null;

  const sigBox = res
    ? res.currentSignal === "buy"
      ? { t: "買い検討（割安）", c: "border-emerald-300 bg-emerald-50 text-emerald-700" }
      : res.currentSignal === "sell"
        ? { t: "売り検討（割高）", c: "border-red-300 bg-red-50 text-red-700" }
        : { t: "中立", c: "border-gray-200 bg-gray-50 text-gray-600" }
    : null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">
          カルマン効率的価格（ノイズを除いた“本当の値”と乖離）
        </h3>
        <div className="flex items-center gap-2 flex-wrap text-xs text-gray-600">
          <div className="flex items-center gap-1">
            <span>平滑度:</span>
            {LEVELS.map((l) => (
              <button
                key={l.key}
                onClick={() => setLevel(l.key)}
                className={`px-2 py-0.5 rounded ${
                  level === l.key
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 hover:bg-gray-200"
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span>先行き:</span>
            {HORIZONS.map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={`px-2 py-0.5 rounded ${
                  horizon === h
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-100 hover:bg-gray-200"
                }`}
              >
                {h}日
              </button>
            ))}
          </div>
        </div>
      </div>

      {res && sigBox && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className={`p-2 rounded border ${sigBox.c}`}>
            <div className="text-gray-500">現在シグナル</div>
            <div className="font-medium text-sm">{sigBox.t}</div>
            <div className="font-mono text-[10px] text-gray-500">
              乖離 z={res.currentZ.toFixed(2)}
            </div>
          </div>
          <div className="p-2 rounded border border-gray-200 bg-gray-50">
            <div className="text-gray-500">ノイズの大きさ</div>
            <div className="font-mono font-medium">
              {res.sigmaNoisePct.toFixed(2)}%
            </div>
            <div className="text-[10px] text-gray-400">残差の標準偏差</div>
          </div>
          <div className="p-2 rounded border border-gray-200 bg-gray-50">
            <div className="text-gray-500">ノイズ／日次変動</div>
            <div className="font-mono font-medium">
              {(res.noiseRatio * 100).toFixed(0)}%
            </div>
            <div className="text-[10px] text-gray-400">
              1日の値動きに占めるノイズ
            </div>
          </div>
          <div className="p-2 rounded border border-gray-200 bg-gray-50">
            <div className="text-gray-500">エントリー基準</div>
            <div className="font-mono font-medium">|z| &gt; {res.entryThreshold}</div>
          </div>
        </div>
      )}

      <div ref={chartRef} className="w-full rounded border border-gray-100" />

      {res && (
        <div className="border border-gray-100 rounded p-3 text-xs">
          <div className="text-gray-500 mb-2">
            乖離後の{res.fwdHorizon}日先平均リターン（平均回帰が効いていれば、割高後はマイナス・割安後はプラス）
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="p-2 rounded border border-red-100 bg-red-50">
              <div className="text-gray-500">
                割高(z&gt;+{res.entryThreshold}) 後 · n={res.reversion.nHigh}
              </div>
              <div
                className={`font-mono font-medium ${
                  res.reversion.fwdHigh < 0 ? "text-emerald-700" : "text-gray-700"
                }`}
              >
                {res.reversion.fwdHigh >= 0 ? "+" : ""}
                {res.reversion.fwdHigh.toFixed(2)}%
              </div>
              <div className="text-[10px] text-gray-400">
                マイナスなら反落（売り有利）
              </div>
            </div>
            <div className="p-2 rounded border border-emerald-100 bg-emerald-50">
              <div className="text-gray-500">
                割安(z&lt;−{res.entryThreshold}) 後 · n={res.reversion.nLow}
              </div>
              <div
                className={`font-mono font-medium ${
                  res.reversion.fwdLow > 0 ? "text-emerald-700" : "text-gray-700"
                }`}
              >
                {res.reversion.fwdLow >= 0 ? "+" : ""}
                {res.reversion.fwdLow.toFixed(2)}%
              </div>
              <div className="text-[10px] text-gray-400">
                プラスなら反発（買い有利）
              </div>
            </div>
          </div>
        </div>
      )}

      <AnalysisGuide title="カルマン効率的価格の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {
            "終値には『効率的価格(その時点で妥当な真の評価値)』と『測定ノイズ(板の薄さ・寄り引けの跳ね・気配の往復などで生じる一時的なズレ)』が混ざっている。カルマンスムーザーは、価格が滑らかに動くという前提(状態方程式)と、観測はノイズを含むという前提(観測方程式)を使って、両者を確率的に分離する。青線=効率的価格、灰線=観測価格で、その差がノイズ。"
          }
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 数式（局所水準＋速度モデル）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            {"状態: 効率的対数価格 xₜ = xₜ₋₁ + vₜ₋₁ + 過程ノイズ、 速度 vₜ = vₜ₋₁ + 過程ノイズ。"}
          </li>
          <li>{"観測: yₜ(対数終値) = xₜ + 測定ノイズ uₜ、 uₜ〜N(0, R)。"}</li>
          <li>
            {
              "前向きカルマンフィルタで逐次推定し、RTSスムーザーで全期間情報を使って過去を再推定。平滑度は『観測をどれだけ信用するか』R/Q比で決まる(強=Rを大きく=ノイズ扱いを増やす)。"
            }
          </li>
          <li>
            {
              "乖離スコア zₜ = (yₜ − xₜ) / σ(残差のローリング標準偏差)。z>0 は効率的価格より割高、z<0 は割安。"
            }
          </li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>効率的価格</strong>
            : 取引摩擦がなければ付くはずの価格。実際の約定はこれにノイズが乗ったもの。
          </li>
          <li>
            例え: 電子体重計。乗るたびに±0.3kg揺れるが、本当の体重は滑らかにしか変わらない。複数回の揺れを“本当の体重は急に変わらない”という前提で均すのがカルマン。
          </li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>逆張りエントリー</strong>
            : z が +しきい値超で割高→反落狙いの売り、−しきい値割れで割安→反発狙いの買い。下段の『乖離後リターン』で実際に回帰しているかを必ず確認する。
          </li>
          <li>
            <strong>ダマシ除去</strong>
            : 効率的価格(青線)の向きをトレンド判定に使うと、ノイズによる一時的な逆行に振り回されにくい。
          </li>
          <li>
            <strong>ノイズ／日次変動</strong>
            が高い銘柄は、日次の値動きの多くがノイズ＝短期売買の勝率が出にくい。サイズや手法を見直す。
          </li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            平滑化はラグを生む。スムーザーは過去再推定なので最新付近は将来データが無く推定が甘い(右端効果)。直近のz判定は弱含みに見る。
          </li>
          <li>
            平滑度『強』にしすぎると本物のトレンドまでノイズ扱いし、乖離が常に大きく出る。中から始める。
          </li>
          <li>
            乖離後リターンがプラス/マイナスに割れない銘柄は平均回帰が弱く、この逆張りは機能しない（順張り地合い）。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
