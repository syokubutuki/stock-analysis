"use client";

import { useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { computeBreakoutStats, donchianPositions } from "../../lib/breakout-stats";
import AnalysisGuide from "./AnalysisGuide";
import StrategyVsBenchmark from "./StrategyVsBenchmark";
import { representativeSpread } from "../../lib/spread-estimator";

interface Props {
  prices: PricePoint[];
}

const HORIZONS = [5, 10, 20];
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const fmtRate = (v: number) => `${(v * 100).toFixed(0)}%`;

export default function BreakoutStatsChart({ prices }: Props) {
  const [horizon, setHorizon] = useState(10);
  const [lookback, setLookback] = useState(20);
  const [side, setSide] = useState<"up" | "down">("up");
  const res = useMemo(() => (prices.length < 100 ? null : computeBreakoutStats(prices, horizon)), [prices, horizon]);

  // ブレイク後 horizon 日だけ建てる戦略の建玉ベクトル（往復回数が実測できる）
  const positions = useMemo(
    () => (prices.length < 100 ? [] : donchianPositions(prices, lookback, horizon, side)),
    [prices, lookback, horizon, side]
  );
  const spreadRT = useMemo(() => (prices.length < 100 ? 0 : representativeSpread(prices)), [prices]);

  if (prices.length < 100 || !res) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">ブレイクアウト統計（ドンチャン・前日高安）</h3>
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span>先行き N:</span>
          {HORIZONS.map((h) => (
            <button key={h} onClick={() => setHorizon(h)} className={`px-2 py-0.5 rounded ${horizon === h ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{h}日</button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 px-2">ブレイク</th>
              <th className="text-right px-2">件数</th>
              <th className="text-left px-2">引け維持率(だまし回避)</th>
              <th className="text-right px-2">{horizon}日先(方向調整)</th>
            </tr>
          </thead>
          <tbody>
            {res.donchian.map((d) => [
              <tr key={`u${d.lookback}`} className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-700">{d.lookback}日高値 上抜け</td>
                <td className="text-right px-2 text-gray-600">{d.upN}</td>
                <td className="px-2 text-gray-600">{fmtRate(d.upHold)}</td>
                <td className={`text-right px-2 font-medium ${d.upFwd >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtPct(d.upFwd)}</td>
              </tr>,
              <tr key={`d${d.lookback}`} className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-700">{d.lookback}日安値 下抜け</td>
                <td className="text-right px-2 text-gray-600">{d.downN}</td>
                <td className="px-2 text-gray-600">{fmtRate(d.downHold)}</td>
                <td className={`text-right px-2 font-medium ${d.downFwd >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtPct(d.downFwd)}</td>
              </tr>,
            ])}
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-700">前日高値 上抜け</td>
              <td className="text-right px-2 text-gray-600">{res.priorHL.brokeHighN}</td>
              <td className="px-2 text-gray-600">{fmtRate(res.priorHL.highHoldRate)}</td>
              <td className={`text-right px-2 font-medium ${res.priorHL.highFwd >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtPct(res.priorHL.highFwd)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-700">前日安値 下抜け</td>
              <td className="text-right px-2 text-gray-600">{res.priorHL.brokeLowN}</td>
              <td className="px-2 text-gray-600">{fmtRate(res.priorHL.lowHoldRate)}</td>
              <td className={`text-right px-2 font-medium ${res.priorHL.lowFwd >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtPct(res.priorHL.lowFwd)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-400">※「方向調整」: 下抜けは下落で当たりのため符号反転。プラス＝ブレイク方向に動いた。引け維持率＝日中ブレイクが引けでも維持された割合（高いほどだましが少ない）。</p>

      {/* ブレイク追随戦略を B&H と比較（往復回数を実測してコストを実額控除） */}
      <div className="pt-2 border-t border-gray-100 space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h4 className="text-sm font-medium text-gray-700">
            ブレイク追随戦略 vs バイ&ホールド（{lookback}日{side === "up" ? "高値上抜け" : "安値下抜け"}後 {horizon}日保有）
          </h4>
          <div className="flex items-center gap-2 text-xs text-gray-600">
            <div className="flex items-center gap-1">
              <span>期間:</span>
              {[20, 55].map((lb) => (
                <button
                  key={lb}
                  onClick={() => setLookback(lb)}
                  className={`px-2 py-0.5 rounded ${lookback === lb ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
                >
                  {lb}日
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <span>方向:</span>
              <button
                onClick={() => setSide("up")}
                className={`px-2 py-0.5 rounded ${side === "up" ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
              >
                上抜け買い
              </button>
              <button
                onClick={() => setSide("down")}
                className={`px-2 py-0.5 rounded ${side === "down" ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
              >
                下抜け売り
              </button>
            </div>
          </div>
        </div>
        <StrategyVsBenchmark
          mode="positions"
          prices={prices}
          positions={positions}
          spreadRT={spreadRT}
          label="ブレイク追随"
        />
      </div>

      <AnalysisGuide title="ブレイクアウト統計の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"高値/安値のブレイクに『追随して順張りすべきか、だましとして逆張りすべきか』を、過去の全ブレイクから検証する。ドンチャン・チャネル（N日高安）と前日高安の2種で見る。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ドンチャン・ブレイク</strong>: 当日高値が過去N日(20/55)の最高値を超える（上抜け）／安値が最安値を割る（下抜け）。タートルズの古典。</li>
          <li><strong>引け維持率</strong>: 日中でブレイクした日のうち、引けでもブレイク水準を保った割合。高い＝だましが少なく本物。</li>
          <li><strong>方向調整N日先</strong>: ブレイク方向に符号を合わせた先行きリターン（プラス＝追随成功）。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>引け維持率が高く方向調整リターンがプラス＝<strong>ブレイク順張りが有効</strong>。引けでの追随エントリー。</li>
          <li>維持率が低い＝だましが多い。ブレイク逆張り（フェード）や、引け確定を待つ方が良い。</li>
          <li>20日と55日で挙動が違えば、短期ブレイクと中期ブレイクで戦略を分ける。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>日足ベースのため日中のブレイク→戻りの経路は分からない（時刻分析は別途）。</li>
          <li>トレンド相場ではブレイク順張り、レンジ相場では逆張りが有利になりやすく、環境依存。</li>
          <li>上の「ブレイク追随戦略 vs B&H」パネルで取引コストを実額控除できる。ブレイク戦略は往復が多いので、回転率とコスト後の超過リターンを必ず確認すること（表の方向調整リターンはコスト前）。</li>
          <li>戦略パネルの建玉は「ブレイク日の引けで建て、N日保有、重複は保有延長」という単純規則。ストップやトレーリングは入れていないので、実運用の出口規則とは別物。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
