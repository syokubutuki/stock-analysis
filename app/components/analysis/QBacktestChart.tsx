"use client";

// 合流点の検証 ─ 提案 q を過去に適用し、買い持ちと比べて W を改善したかを実証する。
//
// 合流点(TodayQProposal)は q を「主張」するだけだった。命題4は分析の価値を
// 「q の改善度」で測れと言う以上、その主張自体が検証されねばならない。ここがそれ。
//
// 公準3(非先読み)の厳守が生命線: 各リバランスで過去データのみから q を解き直す
// 純ウォークフォワード(q-backtest.ts)。重いので Web Worker で実行する。

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import type { QBacktestResult } from "../../lib/axioms/q-backtest";
import type {
  QBacktestWorkerRequest,
  QBacktestWorkerResponse,
} from "../../lib/axioms/q-backtest.worker";
import AnalysisGuide from "./AnalysisGuide";
import TeX from "./TeX";

// 銘柄切替時は親が key={ticker} で作り直すため、ticker 自体は受け取らない。
interface Props {
  prices: PricePoint[];
}

const STEP_OPTIONS = [
  { days: 5, label: "週次" },
  { days: 21, label: "月次" },
  { days: 63, label: "四半期" },
];

function pct(v: number) {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}

/** 戦略 vs 買い持ちの指標を1行で対比する。勝っている側を色で示す。 */
function MetricRow({
  label,
  s,
  b,
  format,
  higherIsBetter = true,
}: {
  label: string;
  s: number;
  b: number;
  format: (v: number) => string;
  higherIsBetter?: boolean;
}) {
  const sWins = higherIsBetter ? s > b : s < b;
  return (
    <tr className="border-t border-gray-100">
      <td className="py-1 pr-2 text-gray-600">{label}</td>
      <td
        className={`py-1 pr-2 text-right tabular-nums ${
          sWins ? "font-bold text-emerald-600" : "text-gray-700"
        }`}
      >
        {format(s)}
      </td>
      <td
        className={`py-1 text-right tabular-nums ${
          !sWins ? "font-bold text-gray-800" : "text-gray-500"
        }`}
      >
        {format(b)}
      </td>
    </tr>
  );
}

export default function QBacktestChart({ prices }: Props) {
  const [stepDays, setStepDays] = useState(21);
  const [result, setResult] = useState<QBacktestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const stratRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bhRef = useRef<ISeriesApi<"Line"> | null>(null);

  // 銘柄が変わったら結果は無効 → 親が key={ticker} で作り直す(状態は自然にリセット)。

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const run = () => {
    if (running || prices.length < 600) return;
    setRunning(true);
    setError(null);
    setProgress(0);

    workerRef.current?.terminate();
    const worker = new Worker(
      new URL("../../lib/axioms/q-backtest.worker.ts", import.meta.url)
    );
    workerRef.current = worker;
    const reqId = ++reqIdRef.current;

    worker.onmessage = (ev: MessageEvent<QBacktestWorkerResponse>) => {
      const d = ev.data;
      if (d.reqId !== reqIdRef.current) return; // 古い応答は捨てる
      if (d.progress !== undefined && d.result === null && d.ok) {
        setProgress(d.progress);
        return;
      }
      if (!d.ok) {
        setError(d.error ?? "検証に失敗しました");
        setResult(null);
      } else {
        setResult(d.result);
        if (!d.result) setError("データが不足しています（日次600本以上が必要）");
      }
      setRunning(false);
      worker.terminate();
      workerRef.current = null;
    };

    const req: QBacktestWorkerRequest = { reqId, prices, stepDays, minHistory: 500 };
    worker.postMessage(req);
  };

  // チャート生成(コンテナが出現してから)。
  useEffect(() => {
    if (!result || !containerRef.current) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 260,
      layout: { background: { color: "#ffffff" }, textColor: "#334155" },
      grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
      rightPriceScale: { borderColor: "#e2e8f0" },
      timeScale: { borderColor: "#e2e8f0", timeVisible: false },
    });
    chartRef.current = chart;
    stratRef.current = chart.addSeries(LineSeries, {
      color: "#4f46e5",
      lineWidth: 2,
      title: "合流点の q",
    });
    bhRef.current = chart.addSeries(LineSeries, {
      color: "#94a3b8",
      lineWidth: 1,
      title: "買い持ち",
    });

    stratRef.current.setData(result.points.map((p) => ({ time: p.time, value: p.strategy })));
    bhRef.current.setData(result.points.map((p) => ({ time: p.time, value: p.buyHold })));
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
  }, [result]);

  const beats = result ? result.strategy.growthRate > result.buyHold.growthRate : false;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-gray-900">
            合流点の検証 ─ この q は本当に W を改善するか
          </h2>
          <p className="mt-0.5 text-[11px] text-gray-500">
            各リバランス時点で「その時までのデータだけ」から q を解き直す純ウォークフォワード（公準3）。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {STEP_OPTIONS.map((o) => (
              <button
                key={o.days}
                onClick={() => setStepDays(o.days)}
                disabled={running}
                className={`rounded px-2 py-0.5 text-xs disabled:opacity-40 ${
                  stepDays === o.days ? "bg-indigo-600 text-white" : "bg-gray-100 hover:bg-gray-200"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <button
            onClick={run}
            disabled={running || prices.length < 600}
            className="rounded-lg bg-indigo-600 px-3 py-1 text-sm text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {running ? "検証中…" : "検証を実行"}
          </button>
        </div>
      </div>

      {running && (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full bg-indigo-500 transition-all"
              style={{ width: `${(progress * 100).toFixed(0)}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] text-gray-500">
            {(progress * 100).toFixed(0)}% ─ 各時点で q を解き直しています（Kelly・分散比・曜日FDR・HMM信念すべて再推定）
          </p>
        </div>
      )}

      {error && <p className="mt-3 text-xs text-rose-600">{error}</p>}

      {!result && !running && !error && (
        <p className="mt-3 text-xs text-gray-500">
          {prices.length < 600
            ? "データが不足しています（日次600本以上が必要）。"
            : "「検証を実行」で、合流点の q を過去に適用した資産曲線を買い持ちと比較します（約10秒）。"}
        </p>
      )}

      {result && (
        <>
          <div ref={containerRef} className="mt-3 w-full" />

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[11px] text-gray-400">
                    <th className="text-left font-normal">指標</th>
                    <th className="text-right font-normal">合流点の q</th>
                    <th className="text-right font-normal">買い持ち</th>
                  </tr>
                </thead>
                <tbody>
                  <MetricRow
                    label="時間平均成長率 g（C21）"
                    s={result.strategy.growthRate}
                    b={result.buyHold.growthRate}
                    format={(v) => `${(v * 100).toFixed(1)}%/年`}
                  />
                  <MetricRow
                    label="年率リターン"
                    s={result.strategy.annualReturn}
                    b={result.buyHold.annualReturn}
                    format={pct}
                  />
                  <MetricRow
                    label="トータル"
                    s={result.strategy.totalReturn}
                    b={result.buyHold.totalReturn}
                    format={pct}
                  />
                  <MetricRow
                    label="シャープ"
                    s={result.strategy.sharpe}
                    b={result.buyHold.sharpe}
                    format={(v) => v.toFixed(2)}
                  />
                  <MetricRow
                    label="最大DD"
                    s={result.strategy.maxDrawdown}
                    b={result.buyHold.maxDrawdown}
                    format={pct}
                    higherIsBetter
                  />
                </tbody>
              </table>
            </div>

            <div className="space-y-1 text-xs text-gray-600">
              <div>
                <span className="text-gray-400">リバランス: </span>
                {result.nRebalances} 回（各回 q を再導出）
              </div>
              <div>
                <span className="text-gray-400">平均建玉 |q|: </span>
                {(result.avgExposure * 100).toFixed(0)}%
              </div>
              <div>
                <span className="text-gray-400">不参加(q=0)の期間: </span>
                {(result.flatShare * 100).toFixed(0)}%
              </div>
              <div>
                <span className="text-gray-400">累計コスト: </span>
                −{(result.totalCost * 100).toFixed(2)}%（公準5）
              </div>
            </div>
          </div>

          <p
            className={`mt-3 rounded-lg p-3 text-xs leading-relaxed ${
              beats ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"
            }`}
          >
            {beats ? (
              <>
                合流点の q は、時間平均成長率で買い持ちを上回った（
                {(result.strategy.growthRate * 100).toFixed(1)}% vs{" "}
                {(result.buyHold.growthRate * 100).toFixed(1)}%/年）。
                平均建玉 {(result.avgExposure * 100).toFixed(0)}% でこれを達成しており、
                21系の P の記述は q の改善という形で価値を生んだ（命題4）。
              </>
            ) : (
              <>
                合流点の q は、時間平均成長率で買い持ちに届かなかった（
                {(result.strategy.growthRate * 100).toFixed(1)}% vs{" "}
                {(result.buyHold.growthRate * 100).toFixed(1)}%/年）。
                <b>これは失敗ではなく情報である</b>：この銘柄・この期間では、21系の記述は
                「ただ持つ」以上に q を改善できなかった（命題4は価値ゼロと判定する）。
                ただしリスク調整後（シャープ・最大DD）や平均建玉
                {(result.avgExposure * 100).toFixed(0)}% を併せて見ること
                ── 少ない建玉で近い成長を得ているなら、資本効率としては優位でありうる。
              </>
            )}
          </p>
        </>
      )}

      <AnalysisGuide title="この検証の読み方と限界（株式原論）">
        <p className="font-medium text-gray-700">1. なぜ検証が要るのか</p>
        <p>
          命題4は「分析の価値は q を改善する度合いでのみ測られる」と述べる。ならば合流点が出す q
          自体も、その基準に晒されねばならない。ここは原論が自分の主張を自分の物差しで測る場所。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 公準3（非先読み）の厳守</p>
        <p>
          「最終データで作った q を過去に当てはめる」のは公準3違反であり、成績を必ず過大評価する。
          本検証は各リバランス時点 t で <TeX>{"\\mathrm{synthesizeQ}(P_{0:t})"}</TeX>{" "}
          を解き直す純ウォークフォワード。Kelly の <TeX>{"\\mu/\\sigma^2"}</TeX>、分散比、曜日 FDR、HMM
          信念のすべてが、その時点の情報だけで再推定される。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. なぜ主指標が g なのか</p>
        <p>
          C21（非エルゴード性）より、我々が実際に生きるのはアンサンブル平均{" "}
          <TeX>{"\\mathbb{E}[W]"}</TeX> ではなく時間平均{" "}
          <TeX>{"g = \\mathbb{E}[\\log(1+r)]"}</TeX>。ゆえに勝敗は g で判定する。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>g が買い持ちを下回るなら、この銘柄では素直に持つ方が良い（合流点を使わない根拠）。</li>
          <li>平均建玉が小さいのに g が近いなら、余った資本を他へ回せる（資本効率の優位）。</li>
          <li>不参加の期間が長いなら、それ自体がこの銘柄のエッジの薄さを示す。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>単一銘柄・単一経路の1回の実験</b>にすぎない。勝敗はノイズでも容易に反転する
            （信頼区間や複数銘柄での再現は未実装）。
          </li>
          <li>
            合流点のロジック自体は私が設計したもので、その設計は全期間を見た上で決めている
            （<b>設計レベルの後知恵</b>は walk-forward でも消えない）。
          </li>
          <li>リバランス間隔を変えると結果は変わる。特定の間隔だけが良い場合は過学習を疑う。</li>
          <li>コストは Corwin-Schultz 推定（C10）。実際の約定はスリッページでさらに悪化しうる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">公理的位置づけ（株式原論）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>立脚する公準/命題</b>: 命題4（分析の価値定理）＋公準3（非先読み）＋C21（時間平均）。</li>
          <li><b>測る P の性質</b>: 合流点の q を適用した実現経路 <TeX>{"W(T)"}</TeX>。</li>
          <li><b>変える q の選択</b>: 「合流点に従うか否か」というメタな q の選択。</li>
          <li><b>摩擦の扱い</b>: リバランスごとに <TeX>{"|\\Delta q|"}</TeX> × 片道スプレッドを控除。</li>
        </ul>
      </AnalysisGuide>
    </section>
  );
}
