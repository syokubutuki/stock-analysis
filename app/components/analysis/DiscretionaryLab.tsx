"use client";

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import dynamic from "next/dynamic";
import { PricePoint } from "../../lib/types";
import {
  Trade,
  TradingState,
  TradingAction,
  executeBuy,
  executeSell,
  generateBuyAndHoldCurve,
  generateHumanCurve,
  calculateComparison,
} from "../../lib/discretionary-engine";
import {
  computeFeatureTable,
  deriveCriteria,
} from "../../lib/discretionary-criteria";
import {
  DiscretionaryScenario,
  listScenarios,
  saveScenario,
  deleteScenario,
  reconcileTrades,
  getActiveId,
} from "../../lib/discretionary-store";
import DiscretionaryCriteriaPanel from "./DiscretionaryCriteriaPanel";
import DiscretionaryBacktestPanel from "./DiscretionaryBacktestPanel";
import DiscretionaryPolicyPanel from "./DiscretionaryPolicyPanel";
import AnalysisGuide from "./AnalysisGuide";

const DiscretionaryChart = dynamic(() => import("./DiscretionaryChart"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[400px] bg-gray-50 rounded-lg border border-gray-200 flex items-center justify-center text-gray-400">
      チャート読み込み中...
    </div>
  ),
});

const DEFAULT_CASH = 1_000_000;
const DEFAULT_COST = 0.001; // 0.1%

interface Props {
  prices: PricePoint[];
  ticker: string;
  currency: string;
}

// trades を順に replay して cash/shares を現在価格で再構築する。
function rebuildState(
  trades: Trade[],
  initialCash: number,
  costRate: number
): TradingState {
  let state: TradingState = {
    cash: initialCash,
    shares: 0,
    trades: [],
    initialCash,
    costRate,
  };
  for (const t of trades) {
    state =
      t.action === "buy"
        ? executeBuy(state, t.price, t.date, t.note)
        : executeSell(state, t.price, t.date, t.note);
  }
  return state;
}

function reducer(state: TradingState, action: TradingAction): TradingState {
  switch (action.type) {
    case "BUY":
      return executeBuy(state, action.price, action.date, action.note);
    case "SELL":
      return executeSell(state, action.price, action.date, action.note);
    case "RESET":
      return {
        cash: action.initialCash,
        shares: 0,
        trades: [],
        initialCash: action.initialCash,
        costRate: action.costRate,
      };
    default:
      return state;
  }
}

export default function DiscretionaryLab({ prices, ticker, currency }: Props) {
  const sym = currency === "JPY" ? "¥" : "$";

  const [state, dispatch] = useReducer(reducer, {
    cash: DEFAULT_CASH,
    shares: 0,
    trades: [],
    initialCash: DEFAULT_CASH,
    costRate: DEFAULT_COST,
  });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedPrice, setSelectedPrice] = useState<number | null>(null);
  const [note, setNote] = useState("");

  const [scenarios, setScenarios] = useState<DiscretionaryScenario[]>([]);
  const [scenarioName, setScenarioName] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadInfo, setLoadInfo] = useState<string | null>(null);

  // reducer では LOAD を扱わず、外から setState 相当が必要なので useReducer を再初期化する仕組みにする。
  // シンプルにするため、置換は dispatch をラップした applyState を使う。
  const replaceState = useCallback((next: TradingState) => {
    // RESET で空にしてから replay
    dispatch({ type: "RESET", initialCash: next.initialCash, costRate: next.costRate });
    for (const t of next.trades) {
      dispatch(
        t.action === "buy"
          ? { type: "BUY", price: t.price, date: t.date, note: t.note }
          : { type: "SELL", price: t.price, date: t.date, note: t.note }
      );
    }
  }, []);

  // ティッカー変更時: 保存済みアクティブシナリオを読み込んで reconcile
  useEffect(() => {
    if (!ticker || prices.length === 0) return;
    const list = listScenarios(ticker);
    // ティッカー変更時に保存シナリオを読み込む正規の副作用。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScenarios(list);
    const aid = getActiveId(ticker);
    const active = list.find((s) => s.id === aid) ?? null;
    if (active) {
      const rec = reconcileTrades(active.trades, prices);
      replaceState(rebuildState(rec.trades, active.initialCash, active.costRate));
      setActiveId(active.id);
      setScenarioName(active.name);
      setLoadInfo(
        rec.dropped.length || rec.drifted
          ? `「${active.name}」を読込 (期間外で除外: ${rec.dropped.length}件, 価格ドリフト: ${rec.drifted}件)`
          : `「${active.name}」を読込`
      );
    } else {
      replaceState({
        cash: DEFAULT_CASH,
        shares: 0,
        trades: [],
        initialCash: DEFAULT_CASH,
        costRate: DEFAULT_COST,
      });
      setActiveId(null);
      setScenarioName("");
      setLoadInfo(null);
    }
    setSelectedDate(null);
    setSelectedPrice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  // 特徴テーブルは prices だけに依存 (重い処理を trades 変化で再計算しない)
  const table = useMemo(() => computeFeatureTable(prices), [prices]);
  const criteria = useMemo(
    () => deriveCriteria(prices, state.trades, table),
    [prices, state.trades, table]
  );

  const buyHoldCurve = useMemo(
    () => generateBuyAndHoldCurve(prices, state.initialCash, state.costRate),
    [prices, state.initialCash, state.costRate]
  );
  const humanCurve = useMemo(
    () => generateHumanCurve(prices, state.trades, state.initialCash, state.costRate),
    [prices, state.trades, state.initialCash, state.costRate]
  );
  const comparison = useMemo(() => calculateComparison(prices, state), [prices, state]);

  const lastPrice = prices.length ? prices[prices.length - 1].close : null;
  const currentPrice = selectedPrice ?? lastPrice ?? 0;
  const totalValue = state.cash + state.shares * currentPrice;

  const tradeDateRange = useMemo(() => {
    if (state.trades.length === 0) return null;
    const dates = state.trades.map((t) => t.date).sort();
    return { first: dates[0], last: dates[dates.length - 1] };
  }, [state.trades]);

  const handleDateClick = useCallback((date: string, price: number) => {
    setSelectedDate(date);
    setSelectedPrice(price);
  }, []);

  const handleBuy = () => {
    if (selectedDate && selectedPrice) {
      dispatch({ type: "BUY", price: selectedPrice, date: selectedDate, note: note || undefined });
      setNote("");
    }
  };
  const handleSell = () => {
    if (selectedDate && selectedPrice) {
      dispatch({ type: "SELL", price: selectedPrice, date: selectedDate, note: note || undefined });
      setNote("");
    }
  };
  const handleReset = () => {
    dispatch({ type: "RESET", initialCash: state.initialCash, costRate: state.costRate });
    setSelectedDate(null);
    setSelectedPrice(null);
  };

  const handleParamChange = (initialCash: number, costRate: number) => {
    replaceState(rebuildState(state.trades, initialCash, costRate));
  };

  const handleSave = () => {
    if (!ticker) return;
    const name = scenarioName.trim() || `シナリオ ${new Date().toISOString().slice(0, 10)}`;
    const saved = saveScenario(ticker, {
      id: activeId ?? undefined,
      name,
      initialCash: state.initialCash,
      costRate: state.costRate,
      trades: state.trades,
    });
    setActiveId(saved.id);
    setScenarios(listScenarios(ticker));
    setLoadInfo(`「${name}」を保存しました`);
  };

  const handleLoad = (s: DiscretionaryScenario) => {
    const rec = reconcileTrades(s.trades, prices);
    replaceState(rebuildState(rec.trades, s.initialCash, s.costRate));
    setActiveId(s.id);
    setScenarioName(s.name);
    setSelectedDate(null);
    setSelectedPrice(null);
    setLoadInfo(
      rec.dropped.length || rec.drifted
        ? `「${s.name}」を読込 (期間外で除外: ${rec.dropped.length}件, 価格ドリフト: ${rec.drifted}件)`
        : `「${s.name}」を読込`
    );
  };

  const handleDelete = (s: DiscretionaryScenario) => {
    deleteScenario(ticker, s.id);
    setScenarios(listScenarios(ticker));
    if (activeId === s.id) {
      setActiveId(null);
      setScenarioName("");
    }
  };

  const handleNewScenario = () => {
    replaceState({
      cash: DEFAULT_CASH,
      shares: 0,
      trades: [],
      initialCash: DEFAULT_CASH,
      costRate: DEFAULT_COST,
    });
    setActiveId(null);
    setScenarioName("");
    setSelectedDate(null);
    setSelectedPrice(null);
    setLoadInfo(null);
  };

  const canBuy = !!(selectedDate && selectedPrice && state.cash >= currentPrice);
  const canSell = !!(selectedDate && selectedPrice && state.shares > 0);
  const isWorse = comparison.difference < 0;

  return (
    <div className="space-y-4">
      {/* シナリオ管理 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-bold text-gray-900">裁量トレード・ラボ ({ticker})</h2>
          <button
            onClick={handleNewScenario}
            className="text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2 py-1"
          >
            + 新規シナリオ
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={scenarioName}
            onChange={(e) => setScenarioName(e.target.value)}
            placeholder="シナリオ名 (例: 逆張り戦略)"
            className="text-sm border border-gray-200 rounded px-2 py-1 flex-1 min-w-[180px]"
          />
          <button
            onClick={handleSave}
            className="text-sm bg-indigo-600 text-white rounded px-3 py-1 hover:bg-indigo-700"
          >
            保存
          </button>
        </div>
        {scenarios.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {scenarios.map((s) => (
              <span
                key={s.id}
                className={`inline-flex items-center gap-1 text-xs rounded border px-2 py-1 ${
                  s.id === activeId
                    ? "bg-indigo-50 border-indigo-300 text-indigo-700"
                    : "bg-gray-50 border-gray-200 text-gray-600"
                }`}
              >
                <button onClick={() => handleLoad(s)} title={`${s.trades.length}件の売買`}>
                  {s.name}
                </button>
                <button
                  onClick={() => handleDelete(s)}
                  className="text-gray-400 hover:text-red-500"
                  title="削除"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {loadInfo && <p className="text-[11px] text-gray-400 mt-2">{loadInfo}</p>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* チャート */}
        <div className="lg:col-span-2 space-y-3">
          <DiscretionaryChart
            prices={prices}
            overlays={[
              {
                id: "bh",
                title: "Buy & Hold",
                color: "#2563eb",
                priceScaleId: "left",
                data: buyHoldCurve,
              },
              {
                id: "human",
                title: "あなた",
                color: "#f97316",
                priceScaleId: "left",
                data: humanCurve,
              },
            ]}
            markers={state.trades.map((t) => ({ date: t.date, action: t.action }))}
            selectedDate={selectedDate}
            onDateClick={handleDateClick}
          />
          <p className="text-xs text-gray-400">
            チャートをクリックして日付を選択 → 右の売買ボタンで取引。灰=株価(右軸)、青=放置、橙=あなた(左軸)。
          </p>
          {/* 売買履歴 */}
          {state.trades.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-3 max-h-48 overflow-auto">
              <table className="w-full text-xs">
                <thead className="text-gray-400">
                  <tr>
                    <th className="text-left">日付</th>
                    <th className="text-left">売買</th>
                    <th className="text-right">価格</th>
                    <th className="text-right">株数</th>
                    <th className="text-left pl-2">メモ</th>
                  </tr>
                </thead>
                <tbody>
                  {state.trades.map((t, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td>{t.date}</td>
                      <td className={t.action === "buy" ? "text-green-600" : "text-red-600"}>
                        {t.action === "buy" ? "買い" : "売り"}
                      </td>
                      <td className="text-right font-mono">
                        {sym}{Math.round(t.price).toLocaleString()}
                      </td>
                      <td className="text-right font-mono">{t.shares.toLocaleString()}</td>
                      <td className="pl-2 text-gray-500 truncate max-w-[120px]">{t.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 売買パネル + 比較 */}
        <div className="space-y-3">
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">売買パネル</h3>
              <button
                onClick={handleReset}
                className="text-xs text-gray-400 hover:text-red-500 border border-gray-200 rounded px-2 py-1"
              >
                取引クリア
              </button>
            </div>

            {selectedDate ? (
              <div className="bg-gray-50 rounded-lg p-2 text-sm">
                <span className="text-gray-500">選択中: </span>
                <span className="font-medium">{selectedDate}</span>
                <span className="ml-2 font-bold">
                  {sym}{selectedPrice?.toLocaleString()}
                </span>
              </div>
            ) : (
              <div className="bg-gray-50 rounded-lg p-2 text-sm text-gray-400">
                チャートをクリックして日付を選択
              </div>
            )}

            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="感情ログ (なぜ売買するか・任意)"
              className="w-full text-xs border border-gray-200 rounded px-2 py-1"
            />

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={handleBuy}
                disabled={!canBuy}
                className="py-2.5 bg-green-600 text-white rounded-lg font-bold hover:bg-green-700 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                買い
              </button>
              <button
                onClick={handleSell}
                disabled={!canSell}
                className="py-2.5 bg-red-600 text-white rounded-lg font-bold hover:bg-red-700 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                売り
              </button>
            </div>

            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">現金</span>
                <span className="font-medium">{sym}{Math.round(state.cash).toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">保有株数</span>
                <span className="font-medium">{state.shares.toLocaleString()} 株</span>
              </div>
              <hr />
              <div className="flex justify-between font-bold">
                <span>合計資産</span>
                <span>{sym}{Math.round(totalValue).toLocaleString()}</span>
              </div>
            </div>

            {/* 初期資金・手数料 */}
            <div className="grid grid-cols-2 gap-2 text-xs pt-1">
              <label className="block">
                <span className="text-gray-500">初期資金</span>
                <input
                  type="number"
                  value={state.initialCash}
                  onChange={(e) =>
                    handleParamChange(Number(e.target.value) || DEFAULT_CASH, state.costRate)
                  }
                  className="w-full border border-gray-200 rounded px-2 py-1"
                />
              </label>
              <label className="block">
                <span className="text-gray-500">手数料 %</span>
                <input
                  type="number"
                  step={0.01}
                  value={(state.costRate * 100).toFixed(2)}
                  onChange={(e) =>
                    handleParamChange(state.initialCash, (Number(e.target.value) || 0) / 100)
                  }
                  className="w-full border border-gray-200 rounded px-2 py-1"
                />
              </label>
            </div>
          </div>

          {/* リターン比較 */}
          {state.trades.length > 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
              <h3 className="font-bold">リターン比較</h3>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-blue-50 rounded-lg p-3 text-center">
                  <div className="text-xs text-blue-600 mb-1">放置 (B&H)</div>
                  <div className="text-xl font-bold text-blue-700">
                    {comparison.buyAndHoldPercent >= 0 ? "+" : ""}
                    {comparison.buyAndHoldPercent.toFixed(1)}%
                  </div>
                </div>
                <div className="bg-orange-50 rounded-lg p-3 text-center">
                  <div className="text-xs text-orange-600 mb-1">あなた</div>
                  <div className="text-xl font-bold text-orange-700">
                    {comparison.humanPercent >= 0 ? "+" : ""}
                    {comparison.humanPercent.toFixed(1)}%
                  </div>
                </div>
              </div>
              <div className={`rounded-lg p-3 text-center ${isWorse ? "bg-red-50" : "bg-green-50"}`}>
                <div className={`text-xs mb-1 ${isWorse ? "text-red-600" : "text-green-600"}`}>
                  {isWorse ? "放置していた方が良かった…" : "Buy & Holdに勝利!"}
                </div>
                <div className={`text-2xl font-black ${isWorse ? "text-red-600" : "text-green-600"}`}>
                  {comparison.differencePercent >= 0 ? "+" : ""}
                  {comparison.differencePercent.toFixed(1)}%
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl p-4 text-center text-gray-400 text-sm">
              売買を行うとBuy &amp; Holdとの比較が表示されます
            </div>
          )}
        </div>
      </div>

      {/* 逆算基準 */}
      <DiscretionaryCriteriaPanel criteria={criteria} />

      {/* 期間適用バックテスト */}
      <DiscretionaryBacktestPanel
        prices={prices}
        table={table}
        criteria={criteria}
        initialCash={state.initialCash}
        costRate={state.costRate}
        currency={currency}
        tradeDateRange={tradeDateRange}
      />

      {/* 方策学習 (層B / 実験的) */}
      <DiscretionaryPolicyPanel
        prices={prices}
        table={table}
        trades={state.trades}
        initialCash={state.initialCash}
        costRate={state.costRate}
        currency={currency}
      />

      <AnalysisGuide title="裁量トレード・ラボの使い方">
        <p className="font-medium text-gray-700">1. 体験の流れ</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>チャート上の任意の日をクリックし、買い/売りを打つ。全力買い・全力売り (現金⇄株を全額)。</li>
          <li>橙線 (あなた) と青線 (放置) がリアルタイムで分岐し、頻繁な売買が得か損かが見える。</li>
          <li>売買を打つほど「逆算した基準」が安定し、それを下のバックテストでルール化して別期間に適用できる。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">2. 保存と再利用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>シナリオ名を付けて保存すると、次回もこのタイミングが復元される (ブラウザ内に保存)。</li>
          <li>複数シナリオを保存し「戦略A vs 戦略B」を比較できる。</li>
          <li>配当・分割で過去株価が再調整されると、保存時の価格からズレることがある (読込時に件数を表示)。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>これは「触らなかった世界線」と比べる体験ツール。過去データ上の後知恵であり、将来を保証しない。</li>
          <li>手数料を上げると、人間の頻繁売買がいかに不利かが体感できる。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
