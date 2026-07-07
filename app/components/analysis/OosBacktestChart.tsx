"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PortfolioData } from "../../hooks/usePortfolioData";
import { alignReturns } from "../../lib/portfolio-risk";
import { runOosBacktest, OosResult } from "../../lib/frontier-backtest";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  data: PortfolioData;
}

const HEIGHT = 360;

const STRAT_COLOR: Record<string, string> = {
  tangency: "#dc2626",
  minVar: "#0ea5e9",
  riskParity: "#7c3aed",
  invVol: "#64748b",
  equal: "#059669",
};

const LOOKBACKS = [126, 252, 504];
const REBALANCES = [5, 21, 63];

export default function OosBacktestChart({ data }: Props) {
  const [open, setOpen] = useState(true);
  const [lookback, setLookback] = useState(252);
  const [rebalance, setRebalance] = useState(21);
  const [rfPct, setRfPct] = useState(0.5);
  const [logScale, setLogScale] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OosResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  // 全共通履歴(表示窓に依存しない)。OOSは推定窓より長い履歴が必要。
  const aligned = useMemo(() => {
    const series = Object.entries(data)
      .filter(([, v]) => v.prices.length > 2)
      .map(([ticker, v]) => ({ ticker, prices: v.prices }));
    if (series.length < 2) return null;
    return alignReturns(series, 100000);
  }, [data]);

  const run = () => {
    if (!aligned) {
      setErr("共通営業日が不足しています(2銘柄以上・共通履歴が必要)。");
      return;
    }
    setRunning(true);
    setErr(null);
    // 同期計算だが「計算中」を先に描画させるため次フレームへ回す
    setTimeout(() => {
      try {
        const res = runOosBacktest(aligned, {
          lookback,
          rebalance,
          rf: rfPct / 100,
          covShrinkage: true,
          muShrinkage: true,
          maxWeight: 1,
        });
        if (!res) setErr(`履歴が不足しています(必要: 推定${lookback}本+検証区間)。期間の長い銘柄で再試行を。`);
        setResult(res);
      } catch (e) {
        setErr(String((e as Error)?.message || e));
        setResult(null);
      } finally {
        setRunning(false);
      }
    }, 30);
  };

  // 結果が出たらチャートを生成(コンテナ出現後に初期化)
  useEffect(() => {
    if (!result || !containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: HEIGHT,
      crosshair: { mode: 0 },
      rightPriceScale: { visible: true, mode: logScale ? 1 : 0 }, // 1=Logarithmic
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;
    for (const s of result.strategies) {
      const series = chart.addSeries(LineSeries, {
        color: STRAT_COLOR[s.key] ?? "#333",
        lineWidth: s.key === "equal" ? 2 : 2,
        title: s.label,
        priceFormat: { type: "custom", formatter: (v: number) => `${v.toFixed(2)}x` },
      });
      series.setData(s.equity as { time: Time; value: number }[]);
    }
    chart.timeScale().fitContent();

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [result, logScale]);

  const ranked = useMemo(() => {
    if (!result) return [];
    return [...result.strategies].sort((a, b) => b.sharpe - a.sharpe);
  }, [result]);
  const bestKey = ranked[0]?.key;

  if (Object.keys(data).length < 2) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 w-full text-left">
        <span className="inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>
          ▶
        </span>
        <span className="font-semibold text-gray-800">配分則のアウトオブサンプル検証(ウォークフォワード)</span>
        <span className="text-xs text-gray-400">
          {result ? `(${result.nAssets}銘柄 / 再配分${result.nRebalances}回 / ${result.dates.length}本)` : ""}
        </span>
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-600">
            <span className="font-medium">推定窓</span>
            <div className="flex gap-1">
              {LOOKBACKS.map((v) => (
                <button
                  key={v}
                  onClick={() => setLookback(v)}
                  className={`px-2 py-0.5 rounded ${lookback === v ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
                >
                  {v}本
                </button>
              ))}
            </div>
            <span className="font-medium ml-1">再配分間隔</span>
            <div className="flex gap-1">
              {REBALANCES.map((v) => (
                <button
                  key={v}
                  onClick={() => setRebalance(v)}
                  className={`px-2 py-0.5 rounded ${rebalance === v ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
                >
                  {v}本
                </button>
              ))}
            </div>
            <span className="font-medium ml-1">Rf</span>
            <input type="range" min={0} max={5} step={0.1} value={rfPct} onChange={(e) => setRfPct(parseFloat(e.target.value))} className="w-24" />
            <span className="tabular-nums w-10">{rfPct.toFixed(1)}%</span>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={logScale} onChange={(e) => setLogScale(e.target.checked)} />
              <span>対数軸</span>
            </label>
            <button
              onClick={run}
              disabled={running || !aligned}
              className="px-3 py-1 bg-gray-800 text-white rounded hover:bg-gray-700 disabled:opacity-50"
            >
              {running ? "計算中…" : result ? "再計算" : "検証を実行"}
            </button>
          </div>

          {err && <div className="text-xs text-red-500">{err}</div>}

          {!result ? (
            <div className="text-xs text-gray-400">
              「検証を実行」を押すと、各配分則を過去だけで推定→直後を保有、を全期間で繰り返した実現成績を比較します(やや時間がかかります)。
            </div>
          ) : (
            <>
              <div ref={containerRef} className="w-full" style={{ height: HEIGHT }} />

              <div className="overflow-x-auto">
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="text-gray-400 text-left border-b border-gray-200">
                      <th className="py-1 pr-2 font-medium">配分則</th>
                      <th className="py-1 px-2 font-medium text-right">実現Sharpe</th>
                      <th className="py-1 px-2 font-medium text-right">CAGR</th>
                      <th className="py-1 px-2 font-medium text-right">年率σ</th>
                      <th className="py-1 px-2 font-medium text-right">最大DD</th>
                      <th className="py-1 pl-2 font-medium text-right">回転(片道)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((s) => (
                      <tr key={s.key} className={`border-b border-gray-100 ${s.key === bestKey ? "bg-emerald-50" : ""}`}>
                        <td className="py-1 pr-2 text-gray-700">
                          <span className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle" style={{ background: STRAT_COLOR[s.key] }} />
                          {s.label}
                          {s.key === bestKey && <span className="ml-1 text-emerald-600 text-[10px]">◎最良</span>}
                        </td>
                        <td className="py-1 px-2 text-right font-semibold text-gray-800">{s.sharpe.toFixed(2)}</td>
                        <td className={`py-1 px-2 text-right ${s.cagr >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                          {s.cagr >= 0 ? "+" : ""}
                          {(s.cagr * 100).toFixed(1)}%
                        </td>
                        <td className="py-1 px-2 text-right text-gray-600">{(s.annVol * 100).toFixed(1)}%</td>
                        <td className="py-1 px-2 text-right text-red-500">{(s.maxDrawdown * 100).toFixed(1)}%</td>
                        <td className="py-1 pl-2 text-right text-gray-500">{(s.turnover * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[10px] text-gray-400 mt-1">
                  推定窓{result.lookback}本・{result.rebalance}本ごと再配分。回転=1回の再配分での片道売買比率(コストの目安)。
                </p>
              </div>

              <AnalysisGuide title="アウトオブサンプル検証(ウォークフォワード)の詳細理論">
                <p className="font-medium text-gray-700">1. 何を見ているか</p>
                <p>
                  効率的フロンティアやシャープ比は<strong>過去データに最適化した「在サンプル」の見かけ</strong>で、将来もそうなる保証はありません。
                  ここでは各配分則を<strong>過去 {result.lookback} 本だけで推定し、その直後の期間を「未知の未来」として保有</strong>する操作を
                  全期間で繰り返し、実際に取れたであろう成績(実現シャープ)を比較します。推定に将来を混ぜないので過学習を避けられます。
                </p>

                <p className="font-medium text-gray-700 mt-3">2. 手順</p>
                <p>
                  時点 t で直近 {result.lookback} 本から各配分則の重み w を推定 → 次の {result.rebalance} 本はその w で保有 → 実現日次リターンは
                  {" Σᵢ wᵢ(exp(rᵢ)−1) "}。これを {result.rebalance} 本ごとに再最適化しながら期末まで進める。累積すると資産曲線(初期=1)になる。
                </p>

                <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li><strong>実現Sharpe が高い=リスク対比で実際に効率的だった</strong>配分則。◎が最良。</li>
                  <li><strong>1/N(等加重)がしばしば上位</strong>に来る。推定誤差が無い分、複雑な最適化を実運用で上回る有名な現象。</li>
                  <li>回転(ターンオーバー)が高い配分則は<strong>売買コストで実質成績が削られる</strong>。表の値にコストを割り引いて評価する。</li>
                  <li>最大DD(ドローダウン)は精神的な耐えやすさ。CAGRが同じならDDが浅い方が続けやすい。</li>
                </ul>

                <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>在サンプルで魅力的でも OOS で 1/N に負ける配分則は、実運用で採用しない判断ができる。</li>
                  <li>推定窓・再配分間隔を変えて頑健性を確認。特定設定でしか勝てないなら過学習を疑う。</li>
                  <li>OOSで安定して勝てる配分則があれば、それを効率的フロンティアの目標配分に採用する裏付けになる。</li>
                </ul>

                <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>売買コスト・スリッページ・税は未計上。回転の高い戦略は実際にはさらに不利。</li>
                  <li>ドリフト無視(再配分日まで目標比率を維持と仮定)。厳密な日次ドリフトは考慮していない。</li>
                  <li>過去の共通営業日でしか検証できない。上場が新しい銘柄があると検証区間が短くなる。過去≠未来。</li>
                </ul>
              </AnalysisGuide>
            </>
          )}
        </div>
      )}
    </div>
  );
}
