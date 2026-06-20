"use client";

import { useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { patternEdges } from "../../lib/candle-patterns";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const HORIZONS = [1, 3, 5, 10];
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

export default function CandlePatternEdgeChart({ prices }: Props) {
  const [horizon, setHorizon] = useState(5);
  const result = useMemo(() => (prices.length < 100 ? null : patternEdges(prices, horizon)), [prices, horizon]);

  if (prices.length < 100 || !result) return null;
  const maxAbs = Math.max(1e-9, ...result.edges.map((e) => Math.abs(e.meanFwd)));
  const retBg = (v: number) => {
    const t = Math.min(1, Math.abs(v) / maxAbs);
    return v >= 0 ? `rgba(22,163,74,${0.08 + t * 0.5})` : `rgba(220,38,38,${0.08 + t * 0.5})`;
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">ローソク足パターンの統計的エッジ</h3>
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span>先行き N:</span>
          {HORIZONS.map((h) => (
            <button key={h} onClick={() => setHorizon(h)} className={`px-2 py-0.5 rounded ${horizon === h ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{h}日</button>
          ))}
        </div>
      </div>

      {result.recentBanner.length > 0 && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          直近5日に検出:{" "}
          {result.recentBanner.map((b, i) => (
            <span key={i} className="mr-2">
              <span className="font-bold">{b.label}</span>({b.time})
              {" → "}過去の{horizon}日先 {fmtPct(b.edge.meanFwd)}・勝率{(b.edge.winRate * 100).toFixed(0)}%
            </span>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 px-2">パターン</th>
              <th className="text-right px-2">出現</th>
              <th className="text-right px-2">{horizon}日先(方向調整)</th>
              <th className="text-right px-2">中央値</th>
              <th className="text-left px-2">勝率</th>
              <th className="text-left px-2">有意性</th>
            </tr>
          </thead>
          <tbody>
            {result.edges.map((e) => (
              <tr key={e.meta.kind} className="border-b border-gray-100">
                <td className="py-1 px-2 font-medium text-gray-700">
                  <span className={`mr-1 ${e.meta.bias === "bull" ? "text-green-600" : "text-red-600"}`}>
                    {e.meta.bias === "bull" ? "▲" : "▼"}
                  </span>
                  {e.meta.label}
                </td>
                <td className="text-right px-2 text-gray-600">{e.n}</td>
                <td className="text-right px-2 font-medium" style={{ background: retBg(e.meanFwd) }}>{fmtPct(e.meanFwd)}</td>
                <td className="text-right px-2 text-gray-500">{fmtPct(e.medianFwd)}</td>
                <td className="px-2">
                  <div className="flex items-center gap-1">
                    <div className="relative h-3 w-14 bg-gray-100 rounded-sm overflow-hidden">
                      <div className={`absolute inset-y-0 left-0 ${e.winRate >= 0.5 ? "bg-green-400" : "bg-red-400"}`} style={{ width: `${e.winRate * 100}%` }} />
                      <div className="absolute inset-y-0 left-1/2 w-px bg-gray-400" />
                    </div>
                    <span className="text-gray-600 tabular-nums">{(e.winRate * 100).toFixed(0)}%</span>
                  </div>
                </td>
                <td className="px-2"><StatBadge n={e.n} p={e.p} significant={e.significant} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-400">※「方向調整」: 弱気パターンは下落で当たりのため符号を反転し、プラス＝パターン的中として比較。</p>

      <AnalysisGuide title="ローソク足パターン統計的エッジの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"包み線・はらみ・ハンマー・明けの明星といった伝統的なローソク足パターンが、本当にその後の値動きを当てるのかを、過去の全出現から検証する。『効くと言われている』を『何回出て、その後平均何%・勝率何%・偶然ではないか』に置き換える。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>各日でパターンを検出（実体・ヒゲ比率や前後足の関係で定義）。出現日の終値で建て、N日先終値までのリターンを集計。</li>
          <li><strong>方向調整</strong>: 弱気パターンは下落で“的中”のため符号を反転。プラス＝パターン通りに動いた。</li>
          <li><strong>有意性</strong>: 平均=0 のt検定 → 全パターン同時検定の偽陽性を Benjamini-Hochberg FDR で補正。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>有意</strong>バッジが付き、平均・勝率が高いパターンだけを実戦で使う。灰色「参考」はエッジ無しとみなす。</li>
          <li>上部バナーで直近の検出と過去成績を確認し、エントリー検討に直結させる。</li>
          <li>出現数(n)が多いほど信頼できる。nが小さい派手なパターンは過信しない。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>多パターン×多ホライズンを試すと偶然の“当たり”が出る。FDR補正後で判断すること。</li>
          <li>パターン定義（ヒゲ比率の閾値等）に依存し、定義を変えると結果も動く。</li>
          <li>相場環境（トレンド/レンジ）で効きが変わる。トレンドフィルタとの併用が望ましい。</li>
          <li>取引コスト未控除。短いNでは特に実効リターンが目減りする。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
