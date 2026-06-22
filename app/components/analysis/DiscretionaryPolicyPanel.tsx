"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { PricePoint } from "../../lib/types";
import { Trade, generateBuyAndHoldCurve, generateHumanCurve } from "../../lib/discretionary-engine";
import { FeatureRecord } from "../../lib/discretionary-criteria";
import { runPolicyModel, scoresToTrades, PolicyResult } from "../../lib/discretionary-policy";
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
  trades: Trade[];
  initialCash: number;
  costRate: number;
  currency: string;
}

function pct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export default function DiscretionaryPolicyPanel({
  prices,
  table,
  trades,
  initialCash,
  costRate,
  currency,
}: Props) {
  const [result, setResult] = useState<PolicyResult | null>(null);
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState(false);

  const buyCount = trades.filter((t) => t.action === "buy").length;
  const sellCount = trades.filter((t) => t.action === "sell").length;
  const canRun = buyCount >= 1 && sellCount >= 1;

  const run = () => {
    setRunning(true);
    // 重い計算なので次フレームで実行し、ボタンのローディング表示を反映させる
    setTimeout(() => {
      const r = runPolicyModel(prices, trades, table);
      setResult(r);
      setRan(true);
      setRunning(false);
    }, 30);
  };

  // OOS スコアからルール売買→資産曲線 (予測がある区間のみで比較)
  const sim = useMemo(() => {
    if (!result) return null;
    const firstIdx = result.oosScore.findIndex((s) => s !== null);
    if (firstIdx < 0) return null;
    const startDate = result.dates[firstIdx];
    const applyPrices = prices.filter((p) => p.time >= startDate);
    const tr = scoresToTrades(applyPrices, result.dates, result.oosScore);
    const human = generateHumanCurve(applyPrices, tr, initialCash, costRate);
    const bh = generateBuyAndHoldCurve(applyPrices, initialCash, costRate);
    const fh = human.length ? human[human.length - 1].value : initialCash;
    const fb = bh.length ? bh[bh.length - 1].value : initialCash;
    return {
      applyPrices,
      trades: tr,
      human,
      bh,
      startDate,
      humanPct: initialCash > 0 ? (fh / initialCash - 1) * 100 : 0,
      bhPct: initialCash > 0 ? (fb / initialCash - 1) * 100 : 0,
    };
  }, [result, prices, initialCash, costRate]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-gray-900">裁量の方策学習 (policy-clone) <span className="text-xs font-normal text-amber-600">実験的</span></h2>
          <p className="text-xs text-gray-500 mt-1">
            あなたの売買から「建玉状態 (買い→売りの間はロング)」をラベルにして GBDT を学習し、
            「この人ならこの局面でロングを持つか?」を全期間に補間します。評価はウォークフォワード (過去のみで学習→未来予測)。
          </p>
        </div>
        <button
          onClick={run}
          disabled={!canRun || running}
          className="shrink-0 text-sm bg-indigo-600 text-white rounded px-3 py-1.5 hover:bg-indigo-700 disabled:opacity-30"
        >
          {running ? "学習中…" : "学習を実行"}
        </button>
      </div>

      {!canRun && (
        <p className="text-sm text-gray-400 py-2">
          買いと売りを最低1回ずつ打つと学習できます。
        </p>
      )}

      {ran && !result && (
        <p className="text-sm text-gray-400 py-2">
          学習に十分なサンプル (特徴が揃う30日以上) がありません。
        </p>
      )}

      {result && (
        <>
          {result.warning && (
            <div className="bg-amber-50 text-amber-700 rounded p-2 text-xs">⚠ {result.warning}</div>
          )}

          <div className="grid grid-cols-3 gap-3 text-center text-sm">
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">OOS AUC</div>
              <div className="text-lg font-bold text-gray-800">{result.oosAuc.toFixed(3)}</div>
              <div className="text-[10px] text-gray-400">0.5=ランダム</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">ロング状態の割合</div>
              <div className="text-lg font-bold text-gray-800">{(result.posRate * 100).toFixed(0)}%</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">学習サンプル</div>
              <div className="text-lg font-bold text-gray-800">{result.nSamples}日</div>
            </div>
          </div>

          {/* 特徴量重要度 */}
          <div>
            <p className="text-xs font-medium text-gray-600 mb-1">特徴量の重要度 (この人が何を見て建玉しているか)</p>
            <div className="space-y-1">
              {result.importance.slice(0, 6).map((f) => (
                <div key={f.id} className="flex items-center gap-2 text-xs">
                  <span className="w-24 text-gray-600 shrink-0">{f.label}</span>
                  <div className="flex-1 h-3 bg-gray-100 rounded">
                    <div
                      className="h-3 bg-indigo-400 rounded"
                      style={{ width: `${Math.min(100, f.value * 100)}%` }}
                    />
                  </div>
                  <span className="w-10 text-right font-mono text-gray-500">
                    {(f.value * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ウォークフォワード資産曲線 */}
          {sim && (
            <>
              <p className="text-xs font-medium text-gray-600">
                ウォークフォワード適用 ({sim.startDate}〜 / 学習済み区間のみで売買)
              </p>
              <DiscretionaryChart
                prices={sim.applyPrices}
                height={340}
                overlays={[
                  { id: "bh", title: "Buy & Hold", color: "#2563eb", priceScaleId: "left", data: sim.bh },
                  { id: "policy", title: "方策モデル", color: "#8b5cf6", priceScaleId: "left", data: sim.human },
                ]}
                markers={sim.trades.map((t) => ({ date: t.date, action: t.action }))}
              />
              <div className="grid grid-cols-3 gap-3 text-center text-sm">
                <div className="bg-blue-50 rounded-lg p-3">
                  <div className="text-xs text-blue-600 mb-1">Buy & Hold</div>
                  <div className="text-lg font-bold text-blue-700">{pct(sim.bhPct)}</div>
                </div>
                <div className="bg-violet-50 rounded-lg p-3">
                  <div className="text-xs text-violet-600 mb-1">方策モデル</div>
                  <div className="text-lg font-bold text-violet-700">{pct(sim.humanPct)}</div>
                </div>
                <div
                  className={`rounded-lg p-3 ${
                    sim.humanPct >= sim.bhPct ? "bg-green-50" : "bg-red-50"
                  }`}
                >
                  <div className="text-xs text-gray-500 mb-1">差 ({sim.trades.length}回売買)</div>
                  <div
                    className={`text-lg font-bold ${
                      sim.humanPct >= sim.bhPct ? "text-green-600" : "text-red-600"
                    }`}
                  >
                    {pct(sim.humanPct - sim.bhPct)}
                  </div>
                </div>
              </div>
              <p className="text-[11px] text-gray-400">
                ※ 手数料{(costRate * 100).toFixed(2)}%・全力売買 (通貨: {currency})。学習期間 (序盤) は予測なしのため現金保有。
              </p>
            </>
          )}
        </>
      )}

      <AnalysisGuide title="方策学習 (policy-clone) の詳細理論">
        <p className="font-medium text-gray-700">1. 何をしているか</p>
        <p>
          逆算の基準表 (平均±標準偏差) は各特徴量を独立に見ますが、実際の裁量は
          「RSIが低く<strong>かつ</strong>出来高が多いとき」のような特徴量の組み合わせで判断します。
          そこで勾配ブースティング木 (GBDT) で特徴量の相互作用ごと学習し、
          「この人ならこの局面でロングを持つか?」を全期間に補間します。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 少数ラベル問題への対処</p>
        <p>
          買い/売りの「瞬間」だけをラベルにすると正例が数個しかなく過学習します。
          代わりに<strong>建玉状態</strong>をラベルにします: 買った日から売る日までは y=1 (ロング)、
          売ってから次に買うまでは y=0 (手仕舞い)。これでスパースなクリックが全日ラベルの密な
          二値分類になり、クラス不均衡は scale_pos_weight = (負例数/正例数) で補正します。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 評価 (ウォークフォワード)</p>
        <p>
          時刻 t の予測は「t より前のデータだけ」で学習したモデルで行います (embargo
          {" "}5本で直前のリークを遮断)。これを step=21本ごとに再学習しながら未来へ進めます。
          こうして得た out-of-sample スコアの ROC-AUC が真の汎化性能です。
        </p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>AUC</strong>: 0.5 がランダム、1.0 が完璧。0.6 を超えれば一定の再現性がある。</li>
          <li><strong>重要度</strong>: あなたが無意識に最も重視している特徴量。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>自分の裁量に一貫した「型」があるか (AUCが高いか) を客観視できる。</li>
          <li>型が再現可能なら、方策モデルを擬似的な自動売買シグナルとして使える。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>売買回数が少ないと、建玉状態でラベルを密化してもなお不安定 (警告を表示)。</li>
          <li>AUCが0.5前後なら、あなたの売買はこの特徴量空間ではほぼランダムだったことを意味する。</li>
          <li>過去の自分を真似るだけで、その裁量が利益を生むかは別問題 (上の資産曲線で確認)。</li>
          <li>レジーム転換後は過去の型が通用しないことがある。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
