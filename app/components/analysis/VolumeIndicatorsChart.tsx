"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { createChart, LineSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeVolIndicators, VolIndicator } from "../../lib/volume-indicators";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const INDS: { key: VolIndicator; label: string; bounded?: boolean }[] = [
  { key: "vpt", label: "VPT" },
  { key: "ad", label: "Chaikin A/D" },
  { key: "mfi", label: "MFI(14)", bounded: true },
  { key: "force", label: "Force Index" },
  { key: "eom", label: "EOM(14)" },
];

// 直近20日の傾き（符号）
function slope(vals: number[]): number {
  const n = vals.length;
  if (n < 2) return 0;
  return vals[n - 1] - vals[0];
}

export default function VolumeIndicatorsChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<IChartApi | null>(null);
  const [ind, setInd] = useState<VolIndicator>("mfi");

  const data = useMemo(() => computeVolIndicators(prices), [prices]);

  const divergence = useMemo(() => {
    if (data.length < 21) return null;
    const last20Price = prices.slice(-20).map((p) => p.close);
    const last20Ind = data.slice(-20).map((d) => d[ind]);
    const ps = slope(last20Price), is = slope(last20Ind);
    if (ps > 0 && is < 0) return "弱気ダイバージェンス（価格↑だが指標↓）";
    if (ps < 0 && is > 0) return "強気ダイバージェンス（価格↓だが指標↑）";
    return null;
  }, [data, prices, ind]);

  useEffect(() => {
    if (!chartRef.current || data.length < 2) return;
    if (apiRef.current) apiRef.current.remove();
    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth, height: 220,
      timeScale: { timeVisible: false },
    });
    apiRef.current = chart;
    const meta = INDS.find((m) => m.key === ind)!;
    const line = chart.addSeries(LineSeries, { color: "#7c3aed", lineWidth: 2, title: meta.label });
    line.setData(data.map((d) => ({ time: d.time as Time, value: d[ind] })));
    if (meta.bounded) {
      for (const lv of [20, 80]) {
        const g = chart.addSeries(LineSeries, { color: "#d1d5db", lineWidth: 1, lineStyle: 2 });
        g.setData(data.map((d) => ({ time: d.time as Time, value: lv })));
      }
    }
    chart.timeScale().fitContent();
    const onResize = () => chartRef.current && chart.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); apiRef.current = null; };
  }, [data, ind]);

  if (prices.length < 30) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">出来高系指標の拡張（VPT/A-D/MFI/Force/EOM）</h3>

      <div className="flex gap-1 flex-wrap">
        {INDS.map((m) => (
          <button key={m.key} onClick={() => setInd(m.key)} className={`px-2.5 py-1 text-xs rounded font-medium ${ind === m.key ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{m.label}</button>
        ))}
      </div>

      {divergence && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          ⚠ {divergence} — 価格と出来高指標の乖離は転換の先行サインになりうる。
        </div>
      )}

      <div ref={chartRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="出来高系指標の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"価格だけでは見えない『買い需要/売り需要の質』を出来高と組み合わせて測り、価格と指標の乖離（ダイバージェンス）から転換を先取りする。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 各指標</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>VPT</strong>(Volume Price Trend): Σ V·(C−Cprev)/Cprev。価格変化率を出来高で重み付けした累積。</li>
          <li><strong>Chaikin A/D</strong>: Σ ((C−L)−(H−C))/(H−L)·V。引けがレンジのどこかで買い/売りの蓄積を測る。</li>
          <li><strong>MFI</strong>(Money Flow Index): 典型価格(H+L+C)/3×出来高の正/負フローからRSI同様に算出。0-100、80超で買われ過ぎ・20未満で売られ過ぎ。</li>
          <li><strong>Force Index</strong>: (C−Cprev)·V を13日EMA。価格変化の勢いを出来高で増幅。</li>
          <li><strong>EOM</strong>(Ease of Movement): 値動き÷(出来高/レンジ)。小さな出来高で大きく動く＝動きやすさ。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>価格が高値更新でも指標が切り下がる＝弱気ダイバージェンス（上昇の勢い喪失）→ 利確/警戒。</li>
          <li>価格が安値更新でも指標が切り上がる＝強気ダイバージェンス→ 反発の芽。</li>
          <li>MFIの20/80は逆張りの目安。A/D・VPTのトレンドは資金の流出入の方向。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>累積系（VPT/A-D）は起点依存で絶対値に意味は薄い。傾き・乖離を見る。</li>
          <li>ダイバージェンスは早すぎることが多い。単独でなく価格構造と併用。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
