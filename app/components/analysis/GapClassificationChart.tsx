"use client";

import { useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { classifyGaps } from "../../lib/gap-classification";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const HORIZONS = [1, 3, 5, 10];
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

export default function GapClassificationChart({ prices }: Props) {
  const [horizon, setHorizon] = useState(5);
  const result = useMemo(() => (prices.length < 100 ? null : classifyGaps(prices, horizon)), [prices, horizon]);

  if (prices.length < 100 || !result) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">窓の分類と窓埋め統計（gap-and-go vs fade）</h3>
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span>先行き N:</span>
          {HORIZONS.map((h) => (
            <button key={h} onClick={() => setHorizon(h)} className={`px-2 py-0.5 rounded ${horizon === h ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{h}日</button>
          ))}
        </div>
      </div>

      <div className="text-xs text-gray-500">全窓 {result.totalGaps}件（0.5%以上の窓のみ集計）</div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 px-2">窓タイプ</th>
              <th className="text-right px-2">件数</th>
              <th className="text-right px-2">平均窓幅</th>
              <th className="text-left px-2">窓埋め率</th>
              <th className="text-right px-2">継続(go) {horizon}日</th>
              <th className="text-right px-2">逆行(fade) {horizon}日</th>
            </tr>
          </thead>
          <tbody>
            {result.stats.map((s) => (
              <tr key={s.type} className="border-b border-gray-100">
                <td className="py-1 px-2 font-medium text-gray-700">{s.label}</td>
                <td className="text-right px-2 text-gray-600">{s.n}</td>
                <td className="text-right px-2 text-gray-500">{(s.meanGap * 100).toFixed(2)}%</td>
                <td className="px-2">
                  <div className="flex items-center gap-1">
                    <div className="relative h-3 w-14 bg-gray-100 rounded-sm overflow-hidden">
                      <div className="absolute inset-y-0 left-0 bg-blue-400" style={{ width: `${s.fillRate * 100}%` }} />
                    </div>
                    <span className="text-gray-600 tabular-nums">{(s.fillRate * 100).toFixed(0)}%</span>
                  </div>
                </td>
                <td className={`text-right px-2 font-medium ${s.goFwd >= 0 ? "text-green-600" : "text-red-600"}`}>{s.n ? fmtPct(s.goFwd) : "—"}</td>
                <td className={`text-right px-2 ${s.fadeFwd >= 0 ? "text-green-600" : "text-red-600"}`}>{s.n ? fmtPct(s.fadeFwd) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-400">※「継続/逆行」は窓方向に符号を合わせた成績。プラス＝窓方向に動いた（上窓なら上昇）。</p>

      <AnalysisGuide title="窓の分類と窓埋めの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"寄り付きの窓（前日終値と当日始値の差）を性質ごとに4分類し、『窓は埋まりやすいか（逆張り有利）』『窓方向に伸びやすいか（順張り有利＝gap-and-go）』をタイプ別に検証する。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 分類の定義（窓=|始値−前日終値|/前日終値 ≥0.5%）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>コモン窓</strong>: 1%未満の小さな窓、またはレンジ内で方向感の乏しい窓。日常的に埋まりやすい。</li>
          <li><strong>ブレイクアウェイ窓</strong>: 直近20日のレンジ（高安）を抜けて空けた窓。新トレンドの起点になりやすく埋まりにくい。</li>
          <li><strong>ランナウェイ窓</strong>: 既存の勢い（窓前20日リターン）と同方向の、トレンド途中の窓。継続の勢い。</li>
          <li><strong>イグゾースチョン窓</strong>: 大きく伸びた後（20日で±15%超）にトレンド方向へ空けた窓。過熱・最後の窓で反転しやすい。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>窓埋め率が高いタイプ（コモン）→ <strong>ギャップ逆張り（フェード）</strong>が機能しやすい。</li>
          <li>窓埋め率が低く継続(go)成績がプラスのタイプ（ブレイクアウェイ/ランナウェイ）→ <strong>順張り（gap-and-go）</strong>。</li>
          <li>イグゾースチョン窓は継続が弱く逆行(fade)が効きやすければ、天井/底のサイン。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>分類はヒューリスティック（経験則）。閾値（1%・15%・20日）次第で結果が動く。</li>
          <li>窓埋め判定は日中の経路ではなく当日の高安が前日終値に達したかで近似。</li>
          <li>イグゾースチョンはサンプルが少なくなりがち。件数を確認すること。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
