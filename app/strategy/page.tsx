"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PricePoint, StockData } from "../lib/types";
import { getWatchlist, WatchlistItem } from "../lib/watchlist";
import {
  Horizon,
  HORIZONS,
  HORIZON_CONFIG,
  SignalThresholds,
  DEFAULT_THRESHOLDS,
} from "../lib/signal-digest";
import {
  simulateAll,
  StrategyMode,
  MODE_LABEL,
  StratParams,
  DEFAULT_STRAT_PARAMS,
  ExitRule,
  EXIT_LABEL,
} from "../lib/strategy-sim";
import { useFeatureSeries } from "../hooks/useFeatureSeries";
import AnalysisGuide from "../components/analysis/AnalysisGuide";
import StrategyCharts from "../components/analysis/StrategyCharts";

export default function StrategyLabPage() {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [ticker, setTicker] = useState<string>("");
  const [prices, setPrices] = useState<PricePoint[] | null>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [horizon, setHorizon] = useState<Horizon>("swing");
  const [mode, setMode] = useState<StrategyMode>("stepAside");
  const [th, setTh] = useState<SignalThresholds>(DEFAULT_THRESHOLDS);
  const [params, setParams] = useState<StratParams>(DEFAULT_STRAT_PARAMS);
  const [entryFrac, setEntryFrac] = useState(0.5); // single モードのエントリー位置(0-1)

  useEffect(() => {
    const wl = getWatchlist();
    setWatchlist(wl);
    if (wl.length > 0) setTicker(wl[0].ticker);
  }, []);

  // 選択銘柄を取得
  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setPrices(null);
    setLoading(true);
    fetch(`/api/stock?ticker=${encodeURIComponent(ticker)}&range=10y`)
      .then((r) => r.json())
      .then((j: StockData & { error?: string }) => {
        if (cancelled) return;
        if (j.error) {
          setPrices([]);
          setName(ticker);
        } else {
          setPrices(j.prices ?? []);
          setName(j.name ?? ticker);
        }
      })
      .catch(() => !cancelled && setPrices([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  const { features, computing } = useFeatureSeries(prices, horizon);

  const entryIndex = Math.round(entryFrac * Math.max(0, features.length - 2));
  const sim = useMemo(
    () => simulateAll(features, th, params, mode, entryIndex),
    [features, th, params, mode, entryIndex]
  );

  const reset = useCallback(() => {
    setTh(DEFAULT_THRESHOLDS);
    setParams(DEFAULT_STRAT_PARAMS);
  }, []);

  const holdRet = features.length > 1 ? (sim.hold[features.length - 1] - 1) * 100 : 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-4">
        <div className="max-w-6xl mx-auto flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">戦略ラボ</h1>
            <p className="text-sm text-gray-500 mt-1">
              判断を価格に重ね、バイ&ホールドと比較。閾値を動かして最適点を探す
            </p>
          </div>
          <Link
            href="/portfolio"
            className="shrink-0 text-sm text-blue-600 hover:text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50"
          >
            ← ダッシュボード
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        {/* 銘柄・時間軸・モード */}
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
          >
            {watchlist.length === 0 && <option value="">ウォッチリストが空</option>}
            {watchlist.map((w) => (
              <option key={w.ticker} value={w.ticker}>
                {w.ticker} {w.name}
              </option>
            ))}
          </select>

          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {HORIZONS.map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={`px-3 py-1 text-sm rounded-md font-medium ${
                  horizon === h ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"
                }`}
              >
                {HORIZON_CONFIG[h].label}
              </button>
            ))}
          </div>

          <div className="flex gap-1 text-sm">
            {(Object.keys(MODE_LABEL) as StrategyMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1 rounded-lg font-medium ${
                  mode === m ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>

          {(loading || computing) && (
            <span className="text-xs text-gray-400">
              {loading ? "取得中…" : "計算中…"}
            </span>
          )}
        </div>

        {features.length < 2 ? (
          <div className="py-16 text-center text-gray-400 text-sm">
            {watchlist.length === 0
              ? "ウォッチリストに銘柄を追加してください。"
              : "銘柄を選ぶと、特徴量を計算してチャートを表示します。"}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_18rem] gap-4">
            {/* チャート */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
              <div className="text-sm font-medium text-gray-700">
                {ticker} {name}
              </div>
              <StrategyCharts features={features} sim={sim} mode={mode} />

              {/* 統計 */}
              {mode === "single" && sim.single ? (
                <div className="text-xs">
                  <div className="text-gray-500 mb-1">
                    エントリー: {features[sim.single.entryIndex].time} /
                    期末まで保有なら {sim.single.holdToEndPct >= 0 ? "+" : ""}
                    {sim.single.holdToEndPct.toFixed(1)}%
                  </div>
                  <table className="w-full">
                    <thead>
                      <tr className="text-gray-400 text-left">
                        <th className="py-1">出口ルール</th>
                        <th className="py-1 text-right">出口日</th>
                        <th className="py-1 text-right">保有日数</th>
                        <th className="py-1 text-right">リターン</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sim.single.results.map((r) => (
                        <tr key={r.rule} className="border-t border-gray-100">
                          <td className="py-1">{EXIT_LABEL[r.rule]}</td>
                          <td className="py-1 text-right tabular-nums">{features[r.exitIndex].time}</td>
                          <td className="py-1 text-right tabular-nums">{r.daysHeld}日</td>
                          <td className={`py-1 text-right tabular-nums ${r.retPct >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                            {r.retPct >= 0 ? "+" : ""}
                            {r.retPct.toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="overflow-x-auto text-xs">
                  <table className="w-full">
                    <thead>
                      <tr className="text-gray-400 text-left">
                        <th className="py-1">戦略</th>
                        <th className="py-1 text-right">総リターン</th>
                        <th className="py-1 text-right">最大DD</th>
                        <th className="py-1 text-right">取引回数</th>
                        <th className="py-1 text-right">勝率</th>
                        <th className="py-1 text-right">投資比率</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-gray-100 text-gray-500">
                        <td className="py-1">Buy&Hold</td>
                        <td className={`py-1 text-right tabular-nums ${holdRet >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                          {holdRet >= 0 ? "+" : ""}
                          {holdRet.toFixed(1)}%
                        </td>
                        <td className="py-1 text-right tabular-nums">—</td>
                        <td className="py-1 text-right tabular-nums">—</td>
                        <td className="py-1 text-right tabular-nums">—</td>
                        <td className="py-1 text-right tabular-nums">100%</td>
                      </tr>
                      {(["model", "fixed", "atr"] as ExitRule[]).map((r) => {
                        const s = sim.byRule[r].stat;
                        return (
                          <tr key={r} className="border-t border-gray-100">
                            <td className="py-1">{EXIT_LABEL[r]}</td>
                            <td className={`py-1 text-right tabular-nums ${s.totalReturnPct >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                              {s.totalReturnPct >= 0 ? "+" : ""}
                              {s.totalReturnPct.toFixed(1)}%
                            </td>
                            <td className="py-1 text-right tabular-nums text-red-600">{s.maxDDPct.toFixed(1)}%</td>
                            <td className="py-1 text-right tabular-nums">{s.nTrades}</td>
                            <td className="py-1 text-right tabular-nums">{(s.winRate * 100).toFixed(0)}%</td>
                            <td className="py-1 text-right tabular-nums text-gray-400">{(s.exposure * 100).toFixed(0)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* スライダー */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3 self-start">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">閾値を調整</span>
                <button onClick={reset} className="text-xs text-blue-600 hover:underline">
                  既定に戻す
                </button>
              </div>

              {mode === "single" && (
                <Slider
                  label="エントリー位置"
                  value={entryFrac}
                  min={0}
                  max={1}
                  step={0.01}
                  display={features[entryIndex]?.time ?? ""}
                  onChange={setEntryFrac}
                />
              )}

              <ThSlider label="Hurst下限(過熱)" k="hurstMeanRevert" th={th} setTh={setTh} min={0.3} max={0.55} step={0.01} />
              <ThSlider label="z 行きすぎ(過熱)" k="zExtreme" th={th} setTh={setTh} min={1} max={3} step={0.1} />
              <ThSlider label="z 売られすぎ(押し目)" k="zOversold" th={th} setTh={setTh} min={-3} max={-0.5} step={0.1} />
              <ThSlider label="ボラ急拡大比" k="volSpikeRatio" th={th} setTh={setTh} min={1} max={2} step={0.05} />
              <ThSlider label="変化点確率" k="changePointProb" th={th} setTh={setTh} min={0.1} max={0.6} step={0.05} />
              <ThSlider label="上昇スコア閾値" k="dirUp" th={th} setTh={setTh} min={0} max={60} step={5} />
              <ThSlider label="下落スコア閾値" k="dirDown" th={th} setTh={setTh} min={-60} max={0} step={5} />

              <div className="border-t border-gray-100 pt-2">
                <span className="text-xs text-gray-500">機械ストップ</span>
              </div>
              <Slider
                label="固定ストップ %"
                value={params.fixedStopPct}
                min={0.02}
                max={0.15}
                step={0.01}
                display={`−${(params.fixedStopPct * 100).toFixed(0)}%`}
                onChange={(v) => setParams((p) => ({ ...p, fixedStopPct: v }))}
              />
              <Slider
                label="ATR 倍率"
                value={params.atrK}
                min={1}
                max={4}
                step={0.25}
                display={`${params.atrK.toFixed(2)}×`}
                onChange={(v) => setParams((p) => ({ ...p, atrK: v }))}
              />
            </div>
          </div>
        )}

        <AnalysisGuide title="戦略ラボの使い方と注意">
          <p className="font-medium text-gray-700">1. 何ができるか</p>
          <p>
            シグナル判定を実際の値動きに重ね、いつ・どんな判断(エントリー▲/出口▼)が出たかを可視化します。
            その判断に従った場合の損益を<strong>バイ&ホールドや機械ストップと比較</strong>し、判断が有効だったか検証します。
            閾値スライダーを動かすと即座に再計算され、最適点を探せます。
          </p>
          <p className="font-medium text-gray-700 mt-3">2. 3つのモード</p>
          <ul className="list-disc pl-4 space-y-1">
            <li><strong>常時ロング・悪化で退避</strong>: 基本保有し、悪化シグナルで現金化→回復で再投資。損切り判断がホールドより効くかを見る。</li>
            <li><strong>シグナルで売買(完全戦略)</strong>: エントリーシグナルで建て、出口ルールで手仕舞いを繰り返す。</li>
            <li><strong>1トレード追跡</strong>: 指定したエントリー日からの1回の取引で、各出口ルールがいつ・どの損益で出たかを比較。</li>
          </ul>
          <p className="font-medium text-gray-700 mt-3">3. 指標</p>
          <ul className="list-disc pl-4 space-y-1">
            <li><strong>総リターン</strong>: 期間全体の損益。Buy&Hold を上回るかが第一の目安。</li>
            <li><strong>最大DD</strong>: 戦略の最大ドローダウン。小さいほど精神的に続けやすい。</li>
            <li><strong>投資比率</strong>: 期間中どれだけ建玉していたか。低リスクでリターンを取れているかの参考。</li>
          </ul>
          <p className="font-medium text-gray-700 mt-3">4. 注意点</p>
          <ul className="list-disc pl-4 space-y-1">
            <li>過去データへの当てはめ。スライダーで好成績にしすぎると<strong>過剰最適化</strong>(将来は再現しない)。</li>
            <li>終値ベース・手数料/スリッページ未考慮。寄り引けギャップは反映されない。</li>
            <li>特徴量はポイントインタイム(先読みなし)だが、対象は直近約2年。レジームが変われば結果も変わる。</li>
          </ul>
        </AnalysisGuide>
      </main>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="flex justify-between text-xs text-gray-600 mb-0.5">
        <span>{label}</span>
        <span className="tabular-nums text-gray-800 font-medium">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-blue-600"
      />
    </label>
  );
}

function ThSlider({
  label,
  k,
  th,
  setTh,
  min,
  max,
  step,
}: {
  label: string;
  k: keyof SignalThresholds;
  th: SignalThresholds;
  setTh: (fn: (prev: SignalThresholds) => SignalThresholds) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <Slider
      label={label}
      value={th[k]}
      min={min}
      max={max}
      step={step}
      display={th[k].toFixed(2)}
      onChange={(v) => setTh((prev) => ({ ...prev, [k]: v }))}
    />
  );
}
