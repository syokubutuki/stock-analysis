"use client";

// 曜日トレード（月曜に建て・金曜に手仕舞い、週末をまたがない）が
// バイ&ホールドに対して「どれくらい統計的に優位か」を4つの検定で定量化して見せる。
// 詳しい理論は末尾の AnalysisGuide を参照。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeVsBH,
  type CostMode,
  type Timing,
  type VsBHResult,
} from "../../lib/weekday-vs-bh";
import { representativeSpread, type SpreadEstimator } from "../../lib/spread-estimator";
import { roundTripCost } from "../../lib/strategy-vs-benchmark";
import AnalysisGuide from "./AnalysisGuide";
import { CHART_COLORS } from "../../lib/chart-colors";

interface Props {
  prices: PricePoint[];
}

const TIMING_LABEL: Record<Timing, string> = { open: "始値", close: "終値" };
const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const pct3 = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(3)}%`;
const num2 = (v: number) => v.toFixed(2);
// 往復コストは bp（=0.01%）で読むほうが手数料表と突き合わせやすい
const bp = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 10000).toFixed(1)}bp`;
const bpAbs = (v: number) => `${(v * 10000).toFixed(1)}bp`;
const cls = (v: number) => (v > 0 ? "text-green-700" : v < 0 ? "text-red-600" : "text-gray-500");

// p値 → 星付き表示
function pStars(p: number | null): { text: string; sig: boolean } {
  if (p === null || Number.isNaN(p)) return { text: "-", sig: false };
  const star = p < 0.01 ? "***" : p < 0.05 ? "**" : p < 0.1 ? "*" : "";
  return { text: `${p < 0.001 ? "<0.001" : p.toFixed(3)}${star}`, sig: p < 0.05 };
}

function PBadge({ p, label }: { p: number | null; label: string }) {
  const s = pStars(p);
  const c = s.sig ? "bg-green-100 text-green-700 border-green-300" : "bg-gray-100 text-gray-500 border-gray-300";
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium ${c}`}>
      {label} <span className="opacity-80">p={s.text}</span>
    </span>
  );
}

export default function WeekdayVsBuyHoldChart({ prices }: Props) {
  const [entryTiming, setEntryTiming] = useState<Timing>("open");
  const [exitTiming, setExitTiming] = useState<Timing>("close");
  // コスト控除は既定 OFF。主役は下の Break-even パネル（コスト推定の誤差から独立した判断材料）で、
  // このトグルは「自分の実際のコストを入れて4検定を再計算する」ための副次的な操作系。
  const [deduct, setDeduct] = useState(false);
  const [feeBps, setFeeBps] = useState(0);
  const [costMode, setCostMode] = useState<CostMode>("time-varying");
  const [spreadEstimator, setSpreadEstimator] = useState<SpreadEstimator>("cs");
  const [spreadWindow, setSpreadWindow] = useState(21);
  const [entryMultiplier, setEntryMultiplier] = useState(1.5);

  const spreadRT = useMemo(
    () => representativeSpread(prices, spreadWindow, spreadEstimator),
    [prices, spreadWindow, spreadEstimator],
  );
  const costRT = useMemo(
    () => roundTripCost({ enabled: deduct && costMode === "constant", spreadRT, feeBps }),
    [deduct, costMode, spreadRT, feeBps],
  );

  const result = useMemo<VsBHResult | null>(
    () => computeVsBH(prices, {
      entryTiming,
      exitTiming,
      costRT,
      costEnabled: deduct,
      costMode,
      spreadEstimator,
      spreadWindow,
      feeBps,
      entryCostMultiplier: costMode === "time-varying" ? entryMultiplier : 1,
    }),
    [prices, entryTiming, exitTiming, costRT, deduct, costMode, spreadEstimator, spreadWindow, feeBps, entryMultiplier],
  );
  const hasResult = result !== null; // コンテナは result 有効時のみ描画されるので初期化effectの依存に入れる

  // === エクイティ曲線（横軸=日付なので lightweight-charts）===
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line">[]>([]);

  useEffect(() => {
    if (!hasResult || !containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 280,
      crosshair: { mode: 0 },
      rightPriceScale: { visible: true },
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(0)}%` },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    chartRef.current = chart;
    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
    };
  }, [hasResult]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !result) return;
    for (const s of seriesRef.current) chart.removeSeries(s);
    seriesRef.current = [];
    const bhRows = result.equity.map((e) => ({ time: e.time as Time, value: e.bh }));
    const stRows = result.equity.map((e) => ({ time: e.time as Time, value: e.strat }));
    const bhs = chart.addSeries(LineSeries, {
      color: CHART_COLORS.neutral, lineWidth: 1, title: "B&H", priceLineVisible: false, lastValueVisible: true,
    });
    bhs.setData(bhRows);
    const sts = chart.addSeries(LineSeries, {
      color: "#2563eb", lineWidth: 2, title: "月→金戦略", priceLineVisible: false, lastValueVisible: true,
    });
    sts.setData(stRows);
    seriesRef.current = [bhs, sts];
    if (containerRef.current && containerRef.current.clientWidth > 0) {
      chart.applyOptions({ width: containerRef.current.clientWidth });
    }
    chart.timeScale().fitContent();
  }, [result]);

  if (!result) {
    return (
      <div className="text-sm text-gray-500 p-4">
        データが不足しています（40営業日・5トレード以上が必要）。
      </div>
    );
  }

  const { metrics, weekend, robust, sharpe, annual, meta, breakeven, costDynamics } = result;
  const be = breakeven;
  const absorbs = be.perRoundTripMean > 0; // コストを吸収できるエッジがそもそも有るか
  const sigAtZero = be.perRoundTripSig95 > 0; // コストゼロで片側5%有意か
  const isVariableCost = costDynamics.mode === "time-varying";
  const pathScale = costDynamics.pathScaleMean;
  const pathAbsorbs = pathScale !== null && pathScale > 0;
  const headerAbsorbs = isVariableCost ? pathAbsorbs : absorbs;
  const estimatorLabel = costDynamics.estimator === "cs" ? "CS" : "AR";
  const turnoverRatio = be.tripsPerYearBH > 0 ? be.tripsPerYearStrat / be.tripsPerYearBH : 0;
  // exitTiming="open" だと週末ギャップは戦略の保有区間に含まれる＝「週末を避ける」物語が成立しない
  const avoidsWeekend = exitTiming === "close";
  const excessTotal = metrics.strat.totalReturn - metrics.bh.totalReturn;
  const excessAnnual = metrics.strat.annualized - metrics.bh.annualized;

  // 総合判定: 主要4検定のうち有意(p<0.05・片側は優位方向)な数
  const verdicts = [
    weekend.pOneSided,
    robust.wilcoxonP,
    sharpe.jkmP,
    annual.probPositive !== undefined ? (annual.lo > 0 ? 0.01 : 1) : null,
  ];
  const sigCount = verdicts.filter((p) => p !== null && p < 0.05).length;

  return (
    <div className="space-y-4">
      {/* 説明 */}
      <p className="text-sm text-gray-600">
        「月曜に建て・金曜に手仕舞い、週末をまたがない（金→月は現金）」戦略が
        <span className="font-medium">バイ&ホールド（常時保有）</span>にどれくらい統計的に優位かを検定します。
        両者の差は<span className="font-medium">戦略が捨てる区間（主に週末ギャップ）</span>だけなので、
        その非重複部分を直接検定します。
      </p>

      {/* タイミング選択 */}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <div className="flex items-center gap-1">
          <span className="text-gray-500">月曜の建て:</span>
          {(["open", "close"] as Timing[]).map((t) => (
            <button
              key={t}
              onClick={() => setEntryTiming(t)}
              className={`px-2 py-0.5 rounded border ${entryTiming === t ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
            >
              {TIMING_LABEL[t]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-500">金曜の手仕舞い:</span>
          {(["open", "close"] as Timing[]).map((t) => (
            <button
              key={t}
              onClick={() => setExitTiming(t)}
              className={`px-2 py-0.5 rounded border ${exitTiming === t ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
            >
              {TIMING_LABEL[t]}
            </button>
          ))}
        </div>
        <span className="text-xs text-fg-muted">
          {meta.nWeeks}週 / {meta.years.toFixed(1)}年
        </span>
      </div>

      {/* 総合判定 */}
      <div className={`rounded-lg border p-3 text-sm ${sigCount >= 3 ? "bg-green-50 border-green-300" : sigCount >= 1 ? "bg-amber-50 border-amber-300" : "bg-gray-50 border-gray-300"}`}>
        <span className="font-medium">総合判定: </span>
        主要4検定のうち<span className="font-bold">{sigCount}/4</span>が有意（p&lt;0.05）。
        {sigCount >= 3
          ? " 戦略のB&Hに対する優位性は統計的に頑健です。"
          : sigCount >= 1
          ? " 一部の検定で優位ですが、頑健とは言い切れません。"
          : " 統計的に有意な優位性は検出されませんでした（差は偶然の範囲）。"}
        {meta.costApplied && (
          <span className="text-xs text-gray-600">
            {" "}（{isVariableCost ? `時変${estimatorLabel}` : `往復 ${bpAbs(meta.costRT)}`} コスト控除後）
          </span>
        )}
      </div>

      {/* Break-even（損益分岐コスト）— コスト控除の ON/OFF に依らず常時表示 */}
      <div className="rounded-lg border border-gray-200 p-3 space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-sm font-medium text-gray-700">{isVariableCost ? "このエッジが吸収できる時変コスト系列" : "このエッジが吸収できる往復コスト"}</span>
          <span
            className={`text-xs rounded border px-1.5 py-0.5 ${
              headerAbsorbs ? "bg-amber-50 text-amber-800 border-amber-300" : "bg-gray-100 text-gray-600 border-gray-300"
            }`}
          >
            {isVariableCost
              ? (pathAbsorbs ? `系列倍率 λ*=${pathScale!.toFixed(2)}×` : "吸収余地なし")
              : (absorbs ? `損益分岐 ${bpAbs(be.perRoundTripMean)}` : "吸収余地なし")}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-600">{isVariableCost ? "定数・対称換算 c*" : "期待値がゼロになる c*"}</td>
                <td className={`text-right px-2 font-mono ${cls(be.perRoundTripMean)}`}>{bp(be.perRoundTripMean)}</td>
                <td className="px-2 text-xs text-gray-500">
                  {absorbs
                    ? `年率換算 ${pct(-Math.log(1 - be.perRoundTripMean) * be.tripsPerYearStrat)} まで払える`
                    : "コストゼロでも B&H に負けている（週次超過の平均が負）"}
                </td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-600">95%で有意でなくなる c*(95%)</td>
                <td className={`text-right px-2 font-mono ${cls(be.perRoundTripSig95)}`}>{bp(be.perRoundTripSig95)}</td>
                <td className="px-2 text-xs text-gray-500">
                  {sigAtZero
                    ? "これ未満のコストなら片側5%で優位が残る"
                    : "コストゼロでも有意でない（片側5%を満たさない）"}
                </td>
              </tr>
              {isVariableCost && (
                <>
                  <tr className="border-b border-gray-100">
                    <td className="py-1 px-2 text-gray-600">時変系列の損益分岐 λ*</td>
                    <td className={`text-right px-2 font-mono ${pathAbsorbs ? "text-green-700" : "text-red-600"}`}>
                      {pathScale === null ? "-" : `${pathScale.toFixed(2)}×`}
                    </td>
                    <td className="px-2 text-xs text-gray-500">
                      Σv<sub>w</sub> / Σk<sub>w</sub>。1未満なら推定コスト系列を全額吸収できない
                    </td>
                  </tr>
                  <tr className="border-b border-gray-100">
                    <td className="py-1 px-2 text-gray-600">v<sub>w</sub> と k<sub>w</sub> の共変動</td>
                    <td className="text-right px-2 font-mono text-gray-700">
                      Cov {(costDynamics.covarianceValueCost * 1e8).toFixed(2)} bp²
                    </td>
                    <td className="px-2 text-xs text-gray-500">
                      σ(k)/σ(v)={(costDynamics.sigmaCostOverValue * 100).toFixed(1)}%
                      {" "}／ λ(95%)={costDynamics.pathScaleSig95.toFixed(2)}×
                    </td>
                  </tr>
                </>
              )}
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-600">推定往復スプレッド</td>
                <td className="text-right px-2 font-mono text-gray-700">{bpAbs(be.spreadRT)}</td>
                <td className="px-2 text-xs text-gray-500">
                  {estimatorLabel} ローリング中央値（窓{costDynamics.window}日）。手数料は別途
                  {absorbs && be.spreadRT > 0 && (
                    <span className="text-red-700">
                      {" "}／ エッジの {(be.spreadRT / be.perRoundTripMean).toFixed(1)} 倍
                    </span>
                  )}
                </td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 px-2 text-gray-600">推定スプレッドでの年ドラッグ</td>
                <td className="text-right px-2 font-mono text-red-700">−{(be.annualDragAtSpread * 100).toFixed(2)}%</td>
                <td className="px-2 text-xs text-gray-500">
                  {isVariableCost
                    ? `1日ラグの時変${estimatorLabel}、入り k=${costDynamics.entryMultiplier.toFixed(1)} を約定日ごとに集計`
                    : `年 ${be.tripsPerYearStrat.toFixed(0)} 往復 × 往復 ${bpAbs(be.spreadRT)}`}
                </td>
              </tr>
              <tr>
                <td className="py-1 px-2 text-gray-600">回転率</td>
                <td className="text-right px-2 font-mono text-gray-700">{be.tripsPerYearStrat.toFixed(0)} 往復/年</td>
                <td className="px-2 text-xs text-gray-500">
                  B&H は {be.tripsPerYearBH.toFixed(2)} 往復/年 ＝
                  <span className="font-medium text-gray-700"> {turnoverRatio.toFixed(0)}倍</span>の通行料を払う
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* コスト感度: ONにすると選択モデルで4検定すべてを再計算 */}
        <div className="space-y-2 text-xs text-gray-600 pt-2 border-t border-gray-100">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-1.5 cursor-pointer" title="選択したコスト系列を各約定から控除し、4検定を再計算する">
              <input type="checkbox" checked={deduct} onChange={(e) => setDeduct(e.target.checked)} />
              <span className={deduct ? "font-medium text-gray-800" : ""}>取引コストを控除して4検定を再計算</span>
            </label>
            <div className="flex items-center gap-1">
              <span className="text-gray-500">モデル</span>
              {(["time-varying", "constant"] as CostMode[]).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  onClick={() => setCostMode(mode)}
                  className={`px-2 py-0.5 rounded border ${costMode === mode ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
                >
                  {mode === "time-varying" ? "時変" : "定数"}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5">
              <span className="text-gray-500">片道手数料</span>
              <input type="number" min={0} max={200} step={1} value={feeBps}
                onChange={(e) => setFeeBps(Math.max(0, Number(e.target.value) || 0))}
                className="w-16 px-1.5 py-0.5 border border-gray-200 rounded font-mono text-right"
                disabled={!deduct}
              />
              <span className="text-gray-500">bps</span>
            </label>
          </div>
          {isVariableCost && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded bg-gray-50 p-2">
              <div className="flex items-center gap-1">
                <span>推定量</span>
                {(["cs", "ar"] as SpreadEstimator[]).map((estimator) => (
                  <button type="button" key={estimator} onClick={() => setSpreadEstimator(estimator)}
                    className={`px-2 py-0.5 rounded border ${spreadEstimator === estimator ? "bg-gray-700 text-white border-gray-700" : "bg-white text-gray-600 border-gray-300"}`}>
                    {estimator === "cs" ? "CS" : "AR"}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5">
                <span>ローリング窓 {spreadWindow}日</span>
                <input type="range" min={5} max={63} step={1} value={spreadWindow}
                  onChange={(e) => setSpreadWindow(Number(e.target.value))} className="w-24" />
              </label>
              <label className="flex items-center gap-1.5">
                <span>入り倍率 k={entryMultiplier.toFixed(1)}</span>
                <input type="range" min={1} max={3} step={0.1} value={entryMultiplier}
                  onChange={(e) => setEntryMultiplier(Number(e.target.value))} className="w-24" />
              </label>
              <span>
                約定日の平均 c<sub>t</sub> <span className="font-mono">{bpAbs(costDynamics.averageBaseCostRT)}</span>
                {costDynamics.warmupLegs > 0 && <> ／ 推定前 {costDynamics.warmupLegs}レグはスプレッド0</>}
              </span>
            </div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-gray-500">
            <span>
              {isVariableCost ? "適用系列" : "適用中の1往復コスト"}{" "}
              <span className="font-mono">{isVariableCost ? `1日ラグ ${estimatorLabel}` : bpAbs(meta.costRT)}</span>
            </span>
            <span>期間内の往復 <span className="font-mono">{meta.roundTrips.toFixed(0)}</span> 回</span>
          </div>
          {isVariableCost && (
            <p className="text-amber-800">
              k は日足から推定できない外生パラメータです。既定1.5は根拠のある推定値ではなく、感度分析の基準点です。
            </p>
          )}
        </div>

        <p className="text-xs text-gray-500">
          {isVariableCost ? (
            pathAbsorbs ? (
              <>
                推定した時変コスト系列を <span className="font-mono">{pathScale!.toFixed(2)}倍</span>まで吸収できます。
                λ*&gt;1 なら基準系列を全額払っても期待値は正、λ*&lt;1 なら不足です。CS/AR・窓・kを動かして感度を確認してください。
              </>
            ) : (
              <>
                v<sub>w</sub> の合計が正でないため、<span className="font-medium">コストをゼロにしても B&H に届きません</span>。
                時変コスト系列を吸収できる正の λ* はありません。
              </>
            )
          ) : absorbs ? (
            <>
              自分の証券会社の往復コスト（スプレッド＋手数料×2）が <span className="font-mono">{bpAbs(be.perRoundTripMean)}</span> より
              小さいかどうかで判断してください。単一の ON/OFF より「何bpまで耐えられるか」が判断材料になります。
            </>
          ) : (
            <>
              週次超過の平均が負なので、<span className="font-medium">コストをゼロにしても B&H に届きません</span>。
              {avoidsWeekend
                ? "この銘柄・期間では、週末を避けること自体がリターンを捨てる方向に働いています。"
                : "現在の設定では週末ギャップを保有するため、そもそも「週末を避ける」戦略ではありません。"}
            </>
          )}
        </p>
      </div>

      {/* エクイティ曲線 */}
      <div>
        <div className="text-xs text-gray-500 mb-1">
          累積リターン（青=月→金戦略 / 灰=B&H, ホイールでズーム）
          {meta.costApplied
            ? (isVariableCost ? `／1日ラグ時変${estimatorLabel}控除後` : `／往復 ${bpAbs(meta.costRT)} 控除後`)
            : "／コスト控除なし"}
        </div>
        <div ref={containerRef} className="w-full" />
      </div>

      {/* 指標比較表 */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-gray-300 text-gray-500 text-xs">
              <th className="text-left py-1 px-2">指標</th>
              <th className="text-right py-1 px-2">月→金戦略</th>
              <th className="text-right py-1 px-2">バイ&ホールド</th>
              <th className="text-right py-1 px-2">差</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-600">総リターン</td>
              <td className={`text-right px-2 ${cls(metrics.strat.totalReturn)}`}>{pct(metrics.strat.totalReturn)}</td>
              <td className={`text-right px-2 ${cls(metrics.bh.totalReturn)}`}>{pct(metrics.bh.totalReturn)}</td>
              <td className={`text-right px-2 font-medium ${cls(excessTotal)}`}>{pct(excessTotal)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-600">年率リターン</td>
              <td className={`text-right px-2 ${cls(metrics.strat.annualized)}`}>{pct(metrics.strat.annualized)}</td>
              <td className={`text-right px-2 ${cls(metrics.bh.annualized)}`}>{pct(metrics.bh.annualized)}</td>
              <td className={`text-right px-2 font-medium ${cls(excessAnnual)}`}>{pct(excessAnnual)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-600">年率Sharpe</td>
              <td className={`text-right px-2 ${cls(metrics.strat.sharpe)}`}>{num2(metrics.strat.sharpe)}</td>
              <td className={`text-right px-2 ${cls(metrics.bh.sharpe)}`}>{num2(metrics.bh.sharpe)}</td>
              <td className={`text-right px-2 font-medium ${cls(sharpe.delta)}`}>{num2(sharpe.delta)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-600">最大DD</td>
              <td className={`text-right px-2 ${cls(metrics.strat.maxDD)}`}>{pct(metrics.strat.maxDD)}</td>
              <td className={`text-right px-2 ${cls(metrics.bh.maxDD)}`}>{pct(metrics.bh.maxDD)}</td>
              <td className={`text-right px-2 font-medium ${cls(metrics.strat.maxDD - metrics.bh.maxDD)}`}>{pct(metrics.strat.maxDD - metrics.bh.maxDD)}</td>
            </tr>
            <tr>
              <td className="py-1 px-2 text-gray-600">市場滞在率</td>
              <td className="text-right px-2 text-gray-700">{(metrics.strat.exposure * 100).toFixed(0)}%</td>
              <td className="text-right px-2 text-gray-700">100%</td>
              <td className="text-right px-2 text-gray-500">{((metrics.strat.exposure - 1) * 100).toFixed(0)}%</td>
            </tr>
          </tbody>
        </table>
        <p className="text-xs text-fg-muted mt-1">
          戦略は市場滞在率が低い（週末は現金）ため、総リターンではなく<span className="font-medium">Sharpe（リスク調整後）</span>での比較が公平です。
        </p>
      </div>

      {/* 4検定カード */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* 1. 週末ギャップ検定 */}
        <div className="rounded-lg border border-gray-200 p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">① 週末ギャップ検定</span>
            <PBadge p={weekend.pOneSided} label="片側t" />
          </div>
          <p className="text-xs text-gray-500">週次の超過リターン e = 戦略 − B&H の平均が正か（片側t検定）。</p>
          <div className="text-sm space-y-0.5">
            <div className="flex justify-between"><span className="text-gray-500">週次超過（平均）</span><span className={cls(weekend.excessMeanWeekly)}>{pct3(weekend.excessMeanWeekly)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">捨てた区間の平均（対数）</span><span className={cls(weekend.meanSkip)}>{pct3(weekend.meanSkip)}</span></div>
            {weekend.weekendGapMean !== null && (
              <div className="flex justify-between"><span className="text-gray-500">うち週末ギャップ平均</span><span className={cls(weekend.weekendGapMean)}>{pct3(weekend.weekendGapMean)}</span></div>
            )}
            {weekend.bootLo !== null && weekend.bootHi !== null && (
              <div className="flex justify-between"><span className="text-gray-500">超過平均の95%CI(Boot)</span><span className="text-gray-700">[{pct3(weekend.bootLo)}, {pct3(weekend.bootHi)}]</span></div>
            )}
          </div>
        </div>

        {/* 2. Sharpe差検定 */}
        <div className="rounded-lg border border-gray-200 p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">② Sharpe差検定</span>
            <PBadge p={sharpe.jkmP} label="JKM" />
          </div>
          <p className="text-xs text-gray-500">リスク調整後の優位。Jobson–Korkie–Memmel検定＋Bootstrap。</p>
          <div className="text-sm space-y-0.5">
            <div className="flex justify-between"><span className="text-gray-500">Sharpe差（年率）</span><span className={cls(sharpe.delta)}>{num2(sharpe.delta)}</span></div>
            {sharpe.jkmZ !== null && (
              <div className="flex justify-between"><span className="text-gray-500">JKM統計量 z</span><span className="text-gray-700">{num2(sharpe.jkmZ)}</span></div>
            )}
            {sharpe.bootLo !== null && sharpe.bootHi !== null && (
              <div className="flex justify-between"><span className="text-gray-500">差の95%CI(Boot)</span><span className="text-gray-700">[{num2(sharpe.bootLo)}, {num2(sharpe.bootHi)}]</span></div>
            )}
            {sharpe.bootProbPositive !== null && (
              <div className="flex justify-between"><span className="text-gray-500">差&gt;0 の確率(Boot)</span><span className="text-gray-700">{(sharpe.bootProbPositive * 100).toFixed(0)}%</span></div>
            )}
          </div>
        </div>

        {/* 3. 頑健検定 */}
        <div className="rounded-lg border border-gray-200 p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">③ 週次ペア差の頑健検定</span>
            <PBadge p={robust.wilcoxonP} label="Wilcoxon" />
          </div>
          <p className="text-xs text-gray-500">非正規・外れ値に頑健。符号順位＋符号検定（片側 中央値&gt;0）。</p>
          <div className="text-sm space-y-0.5">
            <div className="flex justify-between"><span className="text-gray-500">超過が正の週の割合</span><span className={cls(robust.posFraction - 0.5)}>{(robust.posFraction * 100).toFixed(1)}%</span></div>
            {robust.wilcoxonZ !== null && (
              <div className="flex justify-between"><span className="text-gray-500">Wilcoxon z</span><span className="text-gray-700">{num2(robust.wilcoxonZ)}</span></div>
            )}
            <div className="flex justify-between items-center"><span className="text-gray-500">符号検定</span><PBadge p={robust.signP} label="sign" /></div>
          </div>
        </div>

        {/* 4. 年率差Bootstrap CI */}
        <div className="rounded-lg border border-gray-200 p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">④ 年率差 Bootstrap CI</span>
            <PBadge p={annual.lo > 0 ? 0.01 : 1} label={annual.lo > 0 ? "CI>0" : "CI∋0"} />
          </div>
          <p className="text-xs text-gray-500">年率リターン差の95%信頼区間。CIが0を跨がなければ有意。</p>
          <div className="text-sm space-y-0.5">
            <div className="flex justify-between"><span className="text-gray-500">年率差（点推定）</span><span className={cls(annual.delta)}>{pct(annual.delta)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">95%CI</span><span className="text-gray-700">[{pct(annual.lo)}, {pct(annual.hi)}]</span></div>
            <div className="flex justify-between"><span className="text-gray-500">差&gt;0 の確率(Boot)</span><span className="text-gray-700">{(annual.probPositive * 100).toFixed(0)}%</span></div>
          </div>
        </div>
      </div>

      <AnalysisGuide title="対バイ&ホールド優位性検定の詳細理論">
        <p className="font-medium text-gray-700">1. 何を検定しているか</p>
        <p>
          「月曜に建て・金曜に手仕舞い、週末をまたがない」戦略が、単純に持ち続ける
          バイ&ホールド（B&H）よりも統計的に優れているかを判定します。素朴に両者の総リターンを
          並べるだけでは「その差が偶然か実力か」が分からないため、確率的な検定で優位性を測ります。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. なぜ単純な2標本検定ではダメか（重複の罠）</p>
        <p>
          この戦略は B&H の保有区間の<span className="font-medium">部分集合</span>です（両者とも平日は保有し、
          違いは週末だけ）。標本が大きく重なり、かつ日次リターンには自己相関があるため、
          日次リターンを2群に分けて t検定すると p値が過小評価され、偽陽性を招きます。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 差の分解（この分析の核）</p>
        <p>
          すべてを価格イベント間の区間（segment）に分解します。営業日 i について、
          日中区間 r<sub>intraday</sub> = log(終値<sub>i</sub>/始値<sub>i</sub>)、
          夜間区間 r<sub>overnight</sub> = log(始値<sub>i+1</sub>/終値<sub>i</sub>)。
          対数リターンは加法的なので、全期間について厳密に次が成り立ちます:
        </p>
        <p className="pl-2">{"log(B&H資産) − log(戦略資産) = Σ_(戦略が捨てた区間) log(1+r)"}</p>
        <p>
          戦略が捨てる区間は、月曜の建て前・金曜の手仕舞い後、そして<span className="font-medium">週末ギャップ（金曜終値→月曜始値）</span>です。
          したがって「戦略が B&H に勝つ」⟺「捨てた区間の平均リターンが負」。これはいわゆる
          <span className="font-medium">週末効果</span>そのもので、重複しない差の部分だけを取り出して検定できます。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 4つの検定</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <span className="font-medium">① 週末ギャップ検定</span>: 週次の超過リターン e<sub>w</sub> = 戦略<sub>w</sub> − B&H<sub>w</sub>
            （= −捨てた区間）の平均が正かを<span className="font-medium">片側t検定</span>。系列相関に頑健な
            <span className="font-medium">移動ブロック・ブートストラップ</span>で95%信頼区間も推定。ブロック長 L ≈ n<sup>1/3</sup>。
          </li>
          <li>
            <span className="font-medium">② Sharpe差検定</span>: 戦略は週末に現金化して滞在率が低いので、総リターンではなく
            リスク調整後の Sharpe で公平に比較。<span className="font-medium">Jobson–Korkie–Memmel</span>の解析検定
            θ = (1/T)[2(1−ρ) + ½(SR<sub>a</sub>² + SR<sub>b</sub>² − 2·SR<sub>a</sub>SR<sub>b</sub>ρ²)]、z = (SR<sub>a</sub>−SR<sub>b</sub>)/√θ。
            iid正規を仮定するため、ペア・ブロックBootstrapも併記して頑健化。
          </li>
          <li>
            <span className="font-medium">③ 週次ペア差の頑健検定</span>: 分布が非正規・外れ値が多い場合に備え、
            <span className="font-medium">Wilcoxon符号順位検定</span>と<span className="font-medium">符号検定</span>で
            「超過の中央値が0より大きいか」を検定。平均に依存しないので少数の極端な週に振り回されません。
          </li>
          <li>
            <span className="font-medium">④ 年率差 Bootstrap CI</span>: 年率リターン差そのものの95%信頼区間を
            ペア・ブロックBootstrapで推定。区間が0を跨がなければ実務的に意味のある差と解釈できます。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 取引コストと損益分岐（Break-even）</p>
        <p>
          この戦略は<span className="font-medium">年52往復</span>、B&H は期間全体で1往復（年0.1往復）です。
          同じエッジでも戦略は<span className="font-medium">500倍以上の通行料</span>を払うので、
          コストは注記ではなく検定の内部に入れないと結論が変わります。実際、週次超過の σ が 1.3% ・
          n=520週のとき、往復0.3%のコストは t 統計量を <span className="font-mono">−5.06</span> 動かします。
          シグナル自体の t が 1 未満のことは珍しくないので、<span className="font-medium">コストのほうが結論を支配します</span>。
        </p>
        <p>
          コストは建玉額に比例するので、富の推移は {"W ← W·(1+r)·(1−c)"}、対数をとると
          {" ln W ← ln W + r + ln(1−c)"}。つまり<span className="font-medium">1往復あたり ln(1−c) を対数リターンに足す</span>のが
          厳密な控除です（近似ではありません）。ここで
        </p>
        <p className="pl-2">{"c = 往復スプレッド + 2 × 片道手数料"}</p>
        <p>
          定数モデルでは片道1レグを {"ln(1−c)/2"} とし、建玉が変わる区間の先頭に課金します。
          時変モデルでは約定日 i ごとにローリング推定した c<sub>i</sub> を使い、
        </p>
        <p className="pl-2">{"ℓ_entry,i = (k/2)·ln(1−c_i),    ℓ_exit,i = (1/2)·ln(1−c_i)"}</p>
        <p>
          とします。入り倍率 k は月曜寄りの広い板を模した外生パラメータです。日足高安だけでは寄り付きスプレッドを
          分離できないため、既定1.5は推定値ではなく感度分析の基準点です。B&H の期間先頭買い・末尾売りにも
          entry / exit の同じ係数を適用します。
        </p>
        <p>
          c<sub>i</sub> は Corwin–Schultz（CS）または Abdi–Ranaldo（AR）のローリング系列です。
          両推定量は表示日 j の計算に j+1 日の高安を使うため、約定日 i には推定点 i−2 を割り当てます。
          最後に参照する価格日は i−1 となり、約定日の値動きとコストが同じ未来情報を共有しません。
          これは「昨日までの道路状況だけで今日の通行料を決める」1日ラグです。
        </p>
        <p>
          週ごとの週末回避価値を v<sub>w</sub>、時変・非対称な純コストを k<sub>w</sub> とすると、
          定数モデルの bp 表示とは別に、コスト系列を何倍まで吸収できるかを
        </p>
        <p className="pl-2">{"λ* = Σ_w v_w / Σ_w k_w"}</p>
        <p>
          で表示します。λ*=1 が推定系列をちょうど払える境界、1未満は全額を吸収できない状態です。
          λ(95%) は {"mean(v−λk)−1.645·sd(v−λk)/√n=0"} を数値的に解いた片側95%境界です。
          従来の c* と c*(95%) は比較可能性のため「定数・対称コストへ換算した参考値」として残します。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Cov(v<sub>w</sub>, k<sub>w</sub>) が正なら、回避価値が大きい週ほど通行料も高い傾向です。</li>
          <li>CS は負値を0へクリップするため右に歪みます。ARへ切り替え、結論の感度を確認してください。</li>
          <li>Bootstrap は v と k を別々に引き直さず、合成後の系列をブロック再標本化するため時系列相関を保ちます。</li>
          <li>c* が負、または λ* が負なら、コストゼロでも B&H に届かず吸収余地はありません。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>各カードの緑バッジ（p&lt;0.05）は「その検定で有意に優位」を意味します。星は *** p&lt;0.01 / ** p&lt;0.05 / * p&lt;0.1。</li>
          <li><span className="font-medium">総合判定</span>で 4検定中いくつが有意かを表示。3つ以上なら優位性は頑健と考えられます。</li>
          <li>週末ギャップ検定の「捨てた区間の平均」が明確に負なら、戦略の優位は週末効果に由来すると分かります。</li>
          <li>Sharpe差のBootstrap「差&gt;0の確率」が95%以上なら、リスク調整後でも優位である確信度が高い。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 検定どうしの結論が割れたとき</p>
        <p>
          検定はコストへの感度が違うため、控除後に結論が割れることがあります。定数モデルの t は
          <span className="font-mono">Δt = −c√n/σ</span> の純粋な位置シフトですが、時変モデルでは
          Var(k) と Cov(v,k) も分散へ入り、この式どおりには動きません。Wilcoxon と符号検定は
          大きさを順位・符号へ落とすため、同じコスト系列でも t と異なる反応をします。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <span className="font-medium">符号検定だけ生き残った場合</span>: 「勝つ週の数は多いが、1回の負けが大きい」ことを意味します。
            期待値の判断には t と年率差を優先してください。
          </li>
          <li>
            <span className="font-medium">t だけ負けた場合</span>: 外れ値1週に引きずられている可能性があります。
            Bootstrap CI と中央値を確認してください。
          </li>
          <li>
            <span className="font-medium">JKM（②）は他と同じようには動きません</span>。θ が SR<sub>a</sub> を含むため、
            コストで分子だけでなく分母 √θ も動きます。統計量を平行移動して済ませられないので、
            本実装ではコスト控除後の系列から全部を再計算しています。
          </li>
          <li>
            約定日（月曜・金曜）に課金するため、コストONでは戦略の日次σがわずかに増えます。
            したがって Sharpe の低下は「平均だけシフトさせた場合」よりわずかに大きくなります。これは忠実さの代償です。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">8. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>優位が頑健なら、週末リスク（金曜終値→月曜始値の裸のギャップ）を避ける運用に合理性があります。</li>
          <li>建て/手仕舞いのタイミング（始値/終値）を切り替え、どの区切りが最も優位かを比較できます。</li>
          <li>Sharpeが改善しても総リターンが劣る場合は、余った現金（週末）を別資産に回すことで初めて実利になります。</li>
          <li>
            定数モデルでは c* が自分の往復コストより大きいこと、時変モデルでは λ*&gt;1 が最低条件です。どちらも期間・推定量を変えて再現するか確認してください。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">9. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <span className="font-medium">回転率の非対称性が主要因</span>: 戦略は年52往復、B&H は年0.1往復＝
            500倍以上の通行料を払います。この差が超過リターンの主な決定要因なので、
            上の Break-even パネルを必ず見てから他の数値を読んでください。
          </li>
          <li>
            <span className="font-medium">日足推定の限界</span>: CS/AR は日中平均に近い粗い推定で、実際の月曜寄り・金曜引けの板、
            スリッページ、市場インパクトを観測していません。窓と推定量を変えた感度分析が必要です。
          </li>
          <li>
            <span className="font-medium">入り倍率 k は外生</span>: 既定1.5に統計的根拠はありません。k=1〜3を動かし、
            結論が特定の値だけで成立していないか確認してください。
          </li>
          <li>
            <span className="font-medium">スリッページ・市場インパクト・税は含みません</span>。
            実現益課税は回転率に比例して効くので、課税口座では戦略側がさらに不利になります。
          </li>
          <li><span className="font-medium">祝日の扱い</span>: 月曜が休場の週はその週の建てを見送る（既存シミュレータと同じ定義）。連休の週末ギャップは通常より大きくなります。</li>
          <li><span className="font-medium">構造変化</span>: 週末効果は時代・銘柄で消えたり反転したりします。期間セレクタを変えて安定性を確認してください。</li>
          <li><span className="font-medium">単一銘柄・多重検定</span>: タイミングを総当たりで探すと偶然の「勝ち」を拾いやすい。複数銘柄・期間での再現性を重視してください。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
