"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { PricePoint } from "../../lib/types";
import {
  DerivedCriteria,
  FEATURE_DEFS,
  FeatureRecord,
} from "../../lib/discretionary-criteria";
import {
  buildProfile,
  runCriteriaBacktest,
} from "../../lib/discretionary-backtest";
import AnalysisGuide from "./AnalysisGuide";

const DiscretionaryChart = dynamic(() => import("./DiscretionaryChart"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[360px] bg-gray-50 rounded-lg border border-gray-200 flex items-center justify-center text-gray-400">
      チャート読み込み中...
    </div>
  ),
});

interface Props {
  prices: PricePoint[];
  table: Map<string, FeatureRecord>;
  criteria: DerivedCriteria;
  initialCash: number;
  costRate: number;
  currency: string;
  // あなたが実際にトレードした期間 (look-ahead 警告用)。null可。
  tradeDateRange: { first: string; last: string } | null;
}

function pct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export default function DiscretionaryBacktestPanel({
  prices,
  table,
  criteria,
  initialCash,
  costRate,
  currency,
  tradeDateRange,
}: Props) {
  const buyProfile = useMemo(() => buildProfile(criteria.buy), [criteria.buy]);
  const sellProfile = useMemo(() => buildProfile(criteria.sell), [criteria.sell]);

  // 買い・売り両方の基準が揃っている特徴量のみ使える
  const availableFeatures = useMemo(
    () => FEATURE_DEFS.filter((d) => buyProfile[d.id] && sellProfile[d.id]),
    [buyProfile, sellProfile]
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // availableFeatures 確定後、未選択なら全選択をデフォルトに
  const effectiveSelected = useMemo(() => {
    if (selected.size > 0) return selected;
    return new Set(availableFeatures.map((d) => d.id));
  }, [selected, availableFeatures]);

  const [buyThreshold, setBuyThreshold] = useState(0.5);
  const [sellThreshold, setSellThreshold] = useState(0.5);

  const firstDate = prices.length ? prices[0].time : "";
  const lastDate = prices.length ? prices[prices.length - 1].time : "";
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const applyPrices = useMemo(() => {
    const s = startDate || firstDate;
    const e = endDate || lastDate;
    return prices.filter((p) => p.time >= s && p.time <= e);
  }, [prices, startDate, endDate, firstDate, lastDate]);

  const result = useMemo(() => {
    if (
      applyPrices.length < 2 ||
      availableFeatures.length === 0 ||
      effectiveSelected.size === 0
    ) {
      return null;
    }
    return runCriteriaBacktest({
      applyPrices,
      table,
      buyProfile,
      sellProfile,
      features: [...effectiveSelected],
      buyThreshold,
      sellThreshold,
      initialCash,
      costRate,
    });
  }, [
    applyPrices,
    table,
    buyProfile,
    sellProfile,
    effectiveSelected,
    availableFeatures.length,
    buyThreshold,
    sellThreshold,
    initialCash,
    costRate,
  ]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const base = prev.size > 0 ? prev : new Set(availableFeatures.map((d) => d.id));
      const next = new Set(base);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 適用期間とトレード期間が重なっているか (インサンプル警告)
  const overlapsTraining =
    tradeDateRange &&
    applyPrices.length > 0 &&
    applyPrices[0].time <= tradeDateRange.last &&
    applyPrices[applyPrices.length - 1].time >= tradeDateRange.first;

  if (criteria.buyCount === 0 || criteria.sellCount === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h2 className="font-bold text-gray-900 mb-1">裁量基準の期間適用バックテスト</h2>
        <p className="text-sm text-gray-400 py-4">
          買いと売りの両方を最低1回ずつ打つと、基準をルール化して任意期間に適用できます。
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div>
        <h2 className="font-bold text-gray-900">裁量基準の期間適用バックテスト</h2>
        <p className="text-xs text-gray-500 mt-1">
          逆算した買い/売り基準の中心に近い局面を自動で売買するルールに変換し、任意期間に適用します。
          各日のスコア (基準への近さ 0〜1) が閾値を超えたら全力買い/全力売り。
        </p>
      </div>

      {/* 特徴量選択 */}
      <div>
        <p className="text-xs font-medium text-gray-600 mb-1">使う特徴量</p>
        <div className="flex flex-wrap gap-1.5">
          {availableFeatures.map((d) => {
            const on = effectiveSelected.has(d.id);
            return (
              <button
                key={d.id}
                onClick={() => toggle(d.id)}
                className={`text-xs px-2 py-1 rounded border transition-colors ${
                  on
                    ? "bg-indigo-50 border-indigo-300 text-indigo-700"
                    : "bg-gray-50 border-gray-200 text-gray-400"
                }`}
                title={d.description}
              >
                {d.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 閾値・期間 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
        <label className="block">
          <span className="text-gray-600">買い閾値: {buyThreshold.toFixed(2)}</span>
          <input
            type="range"
            min={0.1}
            max={0.95}
            step={0.05}
            value={buyThreshold}
            onChange={(e) => setBuyThreshold(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <label className="block">
          <span className="text-gray-600">売り閾値: {sellThreshold.toFixed(2)}</span>
          <input
            type="range"
            min={0.1}
            max={0.95}
            step={0.05}
            value={sellThreshold}
            onChange={(e) => setSellThreshold(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <label className="block">
          <span className="text-gray-600">適用開始日</span>
          <input
            type="date"
            min={firstDate}
            max={lastDate}
            value={startDate || firstDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full border border-gray-200 rounded px-2 py-1"
          />
        </label>
        <label className="block">
          <span className="text-gray-600">適用終了日</span>
          <input
            type="date"
            min={firstDate}
            max={lastDate}
            value={endDate || lastDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full border border-gray-200 rounded px-2 py-1"
          />
        </label>
      </div>

      {overlapsTraining && (
        <div className="bg-amber-50 text-amber-700 rounded p-2 text-xs">
          ⚠ 適用期間があなたの実トレード期間と重なっています。これは<strong>インサンプル</strong>(look-ahead)
          で、結果が楽観的に出ます。基準を導いた期間とは別の期間で適用して汎化を確かめてください。
        </div>
      )}

      {result ? (
        <>
          <DiscretionaryChart
            prices={applyPrices}
            height={360}
            overlays={[
              {
                id: "bh",
                title: "Buy & Hold",
                color: "#2563eb",
                priceScaleId: "left",
                data: result.buyHoldCurve,
              },
              {
                id: "rule",
                title: "ルール適用",
                color: "#f97316",
                priceScaleId: "left",
                data: result.humanCurve,
              },
            ]}
            markers={result.trades.map((t) => ({ date: t.date, action: t.action }))}
          />
          <div className="grid grid-cols-3 gap-3 text-center text-sm">
            <div className="bg-blue-50 rounded-lg p-3">
              <div className="text-xs text-blue-600 mb-1">Buy & Hold</div>
              <div className="text-lg font-bold text-blue-700">
                {pct(result.finalBuyHoldPercent)}
              </div>
            </div>
            <div className="bg-orange-50 rounded-lg p-3">
              <div className="text-xs text-orange-600 mb-1">ルール適用</div>
              <div className="text-lg font-bold text-orange-700">
                {pct(result.finalHumanPercent)}
              </div>
            </div>
            <div
              className={`rounded-lg p-3 ${
                result.finalHumanPercent >= result.finalBuyHoldPercent
                  ? "bg-green-50"
                  : "bg-red-50"
              }`}
            >
              <div className="text-xs text-gray-500 mb-1">差 ({result.tradeCount}回売買)</div>
              <div
                className={`text-lg font-bold ${
                  result.finalHumanPercent >= result.finalBuyHoldPercent
                    ? "text-green-600"
                    : "text-red-600"
                }`}
              >
                {pct(result.finalHumanPercent - result.finalBuyHoldPercent)}
              </div>
            </div>
          </div>
        </>
      ) : (
        <p className="text-sm text-gray-400 py-4">
          {availableFeatures.length === 0
            ? "買い・売り両方の基準が揃う特徴量がありません。売買回数を増やしてください。"
            : "適用条件を設定してください。"}
        </p>
      )}

      <p className="text-[11px] text-gray-400">
        ※ 手数料{(costRate * 100).toFixed(2)}%・全力売買・端株なしで計算 (通貨: {currency})。
      </p>

      <AnalysisGuide title="期間適用バックテストの詳細理論">
        <p className="font-medium text-gray-700">1. 何をしているか</p>
        <p>
          逆算で得た「買いの基準 (μ_buy, σ_buy)」「売りの基準 (μ_sell, σ_sell)」を、任意の期間に対する
          自動売買ルールに変換します。あなたの裁量の癖が、その期間でも通用するのか (汎化するのか) を検証する道具です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式 (criteria-score)</p>
        <p>
          ある日 t の特徴ベクトル x(t) と買い基準の近さを、特徴 f ごとのガウシアン近接度の平均で測ります:
        </p>
        <p className="font-mono">
          buyScore(t) = (1/|F|) Σ_f exp( −½ · ((x_f(t) − μ_buy,f) / σ_buf,f)² )
        </p>
        <p>
          x_f が μ_buy,f に一致すると 1、σ_buy,f の数倍離れると 0 に近づきます。sellScore も同様。
          buyScore が買い閾値以上 (かつ sellScore より大) なら全力買い、保有中に sellScore が売り閾値以上なら全力売り。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>橙線 (ルール適用) が青線 (Buy &amp; Hold) を上回れば、あなたの基準はその期間で有効だった。</li>
          <li>矢印は実際の売買タイミング。天井で売り・底で買えているかを目視で確認できる。</li>
          <li>閾値を上げると売買は厳選され回数が減る。下げると頻繁になり手数料負けしやすい。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>自分の裁量ルールが特定銘柄・特定相場でしか効かない「過剰適合」かを判定できる。</li>
          <li>使う特徴量を絞り込み、本当に効いている基準だけのシンプルなルールへ蒸留できる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>インサンプル問題</strong>: 基準を導いた期間と同じ期間で適用すると必ず良く見える。必ず別期間で検証する (重なると警告が出ます)。</li>
          <li>全力売買・端株なしの単純化。実際は分割売買・ポジションサイズで挙動が変わる。</li>
          <li>手数料を高めに設定すると、頻繁売買がいかに不利かが体感できる。</li>
          <li>強気相場で導いた基準は弱気相場で機能しないことが多い (レジーム依存)。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
