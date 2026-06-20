"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { clusterRegimes, clusterColor } from "../../lib/regime-clustering";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

export default function RegimeClusteringChart({ prices }: Props) {
  const stripRef = useRef<HTMLCanvasElement>(null);
  const [k, setK] = useState(4);
  const res = useMemo(() => (prices.length < 80 ? null : clusterRegimes(prices, k)), [prices, k]);

  useEffect(() => {
    if (!stripRef.current || !res) return;
    const init = initCanvas(stripRef.current, 56);
    if (!init) return;
    const { ctx, width } = init;
    const n = res.assignTimes.length;
    const w = width / n;
    res.assignTimes.forEach((a, i) => {
      ctx.fillStyle = clusterColor(a.cluster);
      ctx.fillRect(i * w, 16, w + 0.5, 28);
    });
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("レジーム遷移（時系列・色=クラスタ）", 2, 12);
  }, [res]);

  if (prices.length < 80 || !res) return null;
  const cur = res.clusters.find((c) => c.id === res.currentCluster);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">特徴量クラスタリングによるレジーム分類（k-means）</h3>
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span>k:</span>
          {[3, 4, 5].map((v) => (
            <button key={v} onClick={() => setK(v)} className={`px-2 py-0.5 rounded ${k === v ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{v}</button>
          ))}
        </div>
      </div>

      {cur && (
        <div className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: clusterColor(cur.id), background: clusterColor(cur.id) + "14" }}>
          現在のレジーム: <span className="font-bold" style={{ color: clusterColor(cur.id) }}>{cur.label}</span>
          （翌日平均 {cur.fwdMean >= 0 ? "+" : ""}{(cur.fwdMean * 100).toFixed(2)}% / 該当 {cur.n}日）
        </div>
      )}

      <div className="relative"><canvas ref={stripRef} /></div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-gray-500 border-b border-gray-200"><th className="text-left py-1 px-2">レジーム</th><th className="text-right px-2">日数</th><th className="text-right px-2">平均リターン</th><th className="text-right px-2">平均ボラ</th><th className="text-right px-2">翌日平均</th></tr></thead>
          <tbody>
            {res.clusters.map((c) => (
              <tr key={c.id} className={`border-b border-gray-100 ${c.id === res.currentCluster ? "bg-blue-50" : ""}`}>
                <td className="py-1 px-2 font-medium"><span className="inline-block w-2 h-2 rounded-sm mr-1 align-middle" style={{ background: clusterColor(c.id) }} />{c.label}</td>
                <td className="text-right px-2 text-gray-600">{c.n}</td>
                <td className={`text-right px-2 ${c.meanRet >= 0 ? "text-green-600" : "text-red-600"}`}>{(c.meanRet * 100).toFixed(2)}%</td>
                <td className="text-right px-2 text-gray-500">{(c.meanVol * 100).toFixed(1)}%</td>
                <td className={`text-right px-2 font-medium ${c.fwdMean >= 0 ? "text-green-600" : "text-red-600"}`}>{c.fwdMean >= 0 ? "+" : ""}{(c.fwdMean * 100).toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AnalysisGuide title="レジームクラスタリングの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"日々の市場の状態を、リターン・ボラ・レンジ・出来高という特徴で表し、似た日同士を機械的にグループ分け(k-means)する。『今はどの市場タイプか』を同定し、各タイプの先行き傾向を見る。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>特徴: 対数リターン / Garman-Klassボラ / レンジ / 相対出来高(対20日平均)。各々を標準化。</li>
          <li><strong>k-means</strong>: k個の重心に各日を最近傍で割り当て、重心更新を反復。教師なし分類。</li>
          <li>各クラスタの平均特徴と翌日平均リターンを集計。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>現在のレジームの翌日平均がプラス/マイナスで、攻守のバイアスを決める。</li>
          <li>高ボラ・下落レジームに入ったら防御（サイズ縮小・ヘッジ）。低ボラ上昇なら順張り。</li>
          <li>レジーム遷移ストリップで、現在のレジームがどれくらい続いているかを把握。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>k-meansは初期値・kに依存。kを変えて安定性を確認。</li>
          <li>クラスタは過去データで定義。新種のレジームには未対応。</li>
          <li>ラベル（上昇/高ボラ等）は平均特徴からの便宜的な命名。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
