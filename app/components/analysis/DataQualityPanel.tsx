"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  createSeriesMarkers,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint, StockData } from "../../lib/types";
import { PriceGlitch, PriceSanityReport } from "../../lib/price-sanity";
import { BENCHMARK_PRESETS } from "../../hooks/useBenchmarkPrices";
import AnalysisGuide from "./AnalysisGuide";

/**
 * 価格データの破損点検パネル。「どこの破損を、どう修復したか」を数値と図で開示する。
 *
 * バナー（DataQualityNotice）は1行の告知でしかなく、しかも**検索した銘柄しか見ない**。
 * 実際に破損していた 1306.T はベンチマークなので、β を見ている画面には出てこない。
 * そこでこのパネルは分析対象に加えて**ベンチマーク指数群も明示的に点検**する。
 */

const CHART_HEIGHT = 260;
/** 破損区間の前後に表示する営業日数。 */
const CONTEXT_DAYS = 20;

interface Target {
  ticker: string;
  label: string;
  prices: PricePoint[];
  report?: PriceSanityReport;
  error?: string;
}

interface Props {
  ticker: string;
  prices: PricePoint[];
  report?: PriceSanityReport;
}

export default function DataQualityPanel({ ticker, prices, report }: Props) {
  const [benchTargets, setBenchTargets] = useState<Target[] | null>(null);
  const [scanning, setScanning] = useState(false);

  // ベンチマーク指数の点検は明示操作にする（自動で4本取ると、ベンチマークを使わない
  // 画面でも毎回4リクエスト増える）。
  const scanBenchmarks = useCallback(async () => {
    setScanning(true);
    const out: Target[] = [];
    for (const b of BENCHMARK_PRESETS) {
      if (b.ticker === ticker) continue;
      try {
        const res = await fetch(`/api/stock?ticker=${encodeURIComponent(b.ticker)}&range=10y`);
        const json = (await res.json()) as StockData & { error?: string };
        if (!res.ok) {
          out.push({ ticker: b.ticker, label: b.label, prices: [], error: json.error || "取得失敗" });
          continue;
        }
        out.push({
          ticker: b.ticker,
          label: b.label,
          prices: json.prices ?? [],
          report: json.dataQuality,
        });
      } catch {
        out.push({ ticker: b.ticker, label: b.label, prices: [], error: "通信エラー" });
      }
    }
    setBenchTargets(out);
    setScanning(false);
  }, [ticker]);

  const selfTarget: Target = useMemo(
    () => ({ ticker, label: "分析対象", prices, report }),
    [ticker, prices, report]
  );

  const all: Target[] = useMemo(
    () => [selfTarget, ...(benchTargets ?? [])],
    [selfTarget, benchTargets]
  );

  const repairedTargets = all.filter((t) => (t.report?.repaired.length ?? 0) > 0);
  const suspectTargets = all.filter((t) => (t.report?.suspects.length ?? 0) > 0);
  const checkedCount = all.filter((t) => !t.error).length;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-medium text-gray-800">価格データの破損点検</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            配信元のスケール破損を検出・修復した記録。1点の異常値で σ・β・相関・最適化がすべて壊れるため、
            修復した箇所は必ず開示する。
          </p>
        </div>
        <button
          onClick={scanBenchmarks}
          disabled={scanning}
          className="px-3 py-1.5 bg-gray-800 text-white rounded-lg text-xs hover:bg-gray-700 disabled:opacity-50"
        >
          {scanning ? "点検中…" : benchTargets ? "ベンチマークを再点検" : "ベンチマーク指数も点検する"}
        </button>
      </div>

      {/* 総括 */}
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <Badge
          tone={repairedTargets.length > 0 ? "warn" : "ok"}
          label={`修復 ${repairedTargets.length} 銘柄`}
        />
        <Badge
          tone={suspectTargets.length > 0 ? "info" : "ok"}
          label={`要確認 ${suspectTargets.length} 銘柄`}
        />
        <Badge tone="neutral" label={`点検済 ${checkedCount} 系列`} />
        {benchTargets === null && (
          <span className="text-gray-400 self-center">
            ※ 現在は分析対象のみ点検。破損していた 1306.T のような
            <span className="font-medium">ベンチマーク</span>は上のボタンで点検
          </span>
        )}
      </div>

      {repairedTargets.length === 0 && suspectTargets.length === 0 && (
        <p className="mt-3 text-xs text-gray-500">
          点検した {checkedCount} 系列に破損は見つからなかった（書き換えは一切していない）。
        </p>
      )}

      {/* 修復の詳細 */}
      {repairedTargets.map((t) => (
        <div key={`rep-${t.ticker}`} className="mt-4 border-t border-gray-100 pt-3">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-800">{t.ticker}</span>
            <span className="text-xs text-gray-500">{t.label}</span>
            {t.report?.sigmaBefore != null && t.report?.sigmaAfter != null && (
              <span className="text-xs text-amber-700">
                {`年率σ ${(t.report.sigmaBefore * 100).toFixed(1)}% → ${(t.report.sigmaAfter * 100).toFixed(1)}%`}
                {t.report.sigmaAfter > 0 &&
                  `（膨張 ${(t.report.sigmaBefore / t.report.sigmaAfter).toFixed(1)}倍を解消）`}
              </span>
            )}
          </div>
          {t.report!.repaired.map((g) => (
            <GlitchDetail key={`${t.ticker}-${g.from}`} glitch={g} prices={t.prices} />
          ))}
        </div>
      ))}

      {/* 未修復の疑い */}
      {suspectTargets.length > 0 && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <p className="text-sm font-medium text-gray-800">未修復（要人間判断）</p>
          <p className="text-xs text-gray-500 mt-0.5">
            ±35%（かつσ相対でも極端）な変動だが、スケール破損と断定できないため
            <span className="font-medium">値は一切書き換えていない</span>。
            本物の急変動か、未調整の分割かを目視で判断する。
          </p>
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-100">
                <th className="text-left py-1">銘柄</th>
                <th className="text-left py-1">日付</th>
                <th className="text-right py-1">当日リターン</th>
              </tr>
            </thead>
            <tbody>
              {suspectTargets.flatMap((t) =>
                t.report!.suspects.map((s) => (
                  <tr key={`${t.ticker}-${s.time}`} className="border-b border-gray-50">
                    <td className="py-1 text-gray-700">{t.ticker}</td>
                    <td className="py-1 text-gray-700">{s.time}</td>
                    <td className="py-1 text-right text-gray-700">
                      {`${(Math.expm1(s.logReturn) * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 取得できなかった系列 */}
      {all.filter((t) => t.error).length > 0 && (
        <p className="mt-3 text-xs text-gray-400">
          {`点検できなかった系列: ${all.filter((t) => t.error).map((t) => `${t.ticker}(${t.error})`).join(", ")}`}
        </p>
      )}

      <Guide />
    </div>
  );
}

function Badge({ tone, label }: { tone: "ok" | "warn" | "info" | "neutral"; label: string }) {
  const cls = {
    ok: "bg-green-50 text-green-700 border-green-200",
    warn: "bg-amber-50 text-amber-800 border-amber-200",
    info: "bg-orange-50 text-orange-800 border-orange-200",
    neutral: "bg-gray-50 text-gray-600 border-gray-200",
  }[tone];
  return <span className={`px-2 py-0.5 rounded border ${cls}`}>{label}</span>;
}

/** 1つの破損区間の詳細: 修復前後の実値表 + 修復前後を重ねた価格チャート。 */
function GlitchDetail({ glitch, prices }: { glitch: PriceGlitch; prices: PricePoint[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  // 破損区間の前後を切り出し、修復前(配信値)と修復後の2本を作る。
  // 変数名に window を使うとグローバルの window を隠してしまうので view とする。
  const view = useMemo(() => {
    const idx = prices.findIndex((p) => p.time === glitch.from);
    if (idx < 0) return null;
    const start = Math.max(0, idx - CONTEXT_DAYS);
    const end = Math.min(prices.length, idx + glitch.days + CONTEXT_DAYS);
    const slice = prices.slice(start, end);
    const beforeByTime = new Map(glitch.points.map((p) => [p.time, p.closeBefore]));
    return {
      after: slice.map((p) => ({ time: p.time as Time, value: p.close })),
      // 修復後の系列のうち、破損日だけを配信値に差し替えたもの＝修復前の見え方。
      before: slice.map((p) => ({
        time: p.time as Time,
        value: beforeByTime.get(p.time) ?? p.close,
      })),
      glitchTimes: glitch.points.map((p) => p.time),
    };
  }, [prices, glitch]);

  useEffect(() => {
    if (!containerRef.current || !view) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: CHART_HEIGHT,
      crosshair: { mode: 0 },
      // 破損値(1/10)と正常値が同じ軸に乗るので、既定の余白では軸下端が負値まで伸びて
      // 価格軸として無意味になる。余白を詰めて実データの範囲に寄せる。
      rightPriceScale: { visible: true, scaleMargins: { top: 0.08, bottom: 0.04 } },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    // 2本の最終値ラベル・水平線は同じ値なので右端で重なって読めない。凡例は title に任せる。
    const seriesOpts = { lineWidth: 2 as const, lastValueVisible: false, priceLineVisible: false };

    const beforeSeries = chart.addSeries(LineSeries, {
      ...seriesOpts,
      color: "#dc2626",
      title: "配信値(修復前)",
    });
    beforeSeries.setData(view.before);

    const afterSeries = chart.addSeries(LineSeries, {
      ...seriesOpts,
      color: "#16a34a",
      title: "修復後",
    });
    afterSeries.setData(view.after);

    // 破損日にマーカーを立てる（系列に存在する時刻にのみ置ける）。
    createSeriesMarkers(
      afterSeries,
      view.glitchTimes.map((t) => ({
        time: t as Time,
        position: "belowBar" as const,
        color: "#dc2626",
        shape: "arrowUp" as const,
        text: "破損",
      }))
    );

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
  }, [view]);

  const factorLabel = glitch.factor < 1 ? `1/${Math.round(1 / glitch.factor)}` : `${Math.round(glitch.factor)}倍`;

  return (
    <div className="mt-3">
      <p className="text-xs text-gray-700">
        {`破損区間: ${glitch.from}${glitch.days > 1 ? ` 〜 ${glitch.to}` : ""}（${glitch.days}営業日）`}
        <span className="ml-2 text-gray-500">
          {`倍率 ${factorLabel} → 価格を ${factorLabel} で割り戻し、出来高に ${factorLabel} を掛けて復元`}
        </span>
      </p>
      <p className="text-xs text-gray-400 mt-0.5">
        {`正常な水準の基準: ${glitch.anchorBefore}（直前）と ${glitch.anchorAfter}（復帰日）`}
      </p>

      <table className="mt-2 w-full text-xs">
        <thead>
          <tr className="text-gray-500 border-b border-gray-100">
            <th className="text-left py-1">日付</th>
            <th className="text-right py-1">配信値(終値)</th>
            <th className="text-right py-1">修復値(終値)</th>
            <th className="text-right py-1">配信値(出来高)</th>
            <th className="text-right py-1">修復値(出来高)</th>
          </tr>
        </thead>
        <tbody>
          {glitch.points.map((p) => (
            <tr key={p.time} className="border-b border-gray-50">
              <td className="py-1 text-gray-700">{p.time}</td>
              <td className="py-1 text-right text-red-600">{p.closeBefore.toFixed(2)}</td>
              <td className="py-1 text-right text-green-700">{p.closeAfter.toFixed(2)}</td>
              <td className="py-1 text-right text-red-600">{fmtVol(p.volumeBefore)}</td>
              <td className="py-1 text-right text-green-700">{fmtVol(p.volumeAfter)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div ref={containerRef} className="mt-2 w-full" />
      <p className="text-xs text-gray-400 mt-1">
        赤＝配信値のまま（破損日で崖のように落ち、翌日に跳ね返る）／緑＝修復後（水準が連続する）。
        赤の往復2点だけで日次分散が跳ね上がり、回帰の分母 Var(M) を膨らませて β をゼロに潰す。
      </p>
    </div>
  );
}

function fmtVol(v: number): string {
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}億`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
  return String(v);
}

function Guide() {
  return (
    <AnalysisGuide title="破損点検の詳細理論">
      <p className="font-medium text-gray-700">1. 何を点検しているか</p>
      <p>
        株価データは配信元（Yahoo Finance）から取得しているが、配信データには稀に
        <span className="font-medium">スケール破損</span>
        ——「数営業日だけ価格が 1/10 になる」類の誤りが混じる。原因は分割（株式分割）の調整を
        一部の行にだけ誤って当ててしまうことで、実例として TOPIX ETF（1306.T）は
        2026-03-30〜03-31 の2営業日だけ生値・調整後終値の両方が 1/10 になっており、
        同時に出来高が約10倍になっていた（10:1 分割の調整が2行にだけ当たった形）。
      </p>
      <p>
        この破損は「見た目が少し変」という程度の問題ではない。
        <span className="font-medium">1点の異常値が全ての統計量を無意味にする</span>。
      </p>

      <p className="font-medium text-gray-700 mt-3">2. なぜ1点で全部壊れるか（数式）</p>
      <p>{"日次対数リターンを r_t = ln(P_t / P_{t-1}) とする。価格が t..s-1 の区間だけ倍率 k で"}</p>
      <p>{"  P̃_t = k · P_t   (k = 1/10 など)"}</p>
      <p>{"と壊れていると、区間の入口と出口に巨大な偽のリターンが立つ:"}</p>
      <p>{"  r̃_t = ln k + r_t ≈ ln(1/10) = −2.30"}</p>
      <p>{"  r̃_s = −ln k + r_s ≈ +2.30"}</p>
      <p>{"区間内部のリターンは k が約分されて正しいまま（r̃_i = r_i）である点が重要。"}</p>
      <p>
        {"分散は偏差の2乗和なので、この2点は (2.30)² ≈ 5.3 を2つ持ち込む。T=2500日なら"}
      </p>
      <p>{"  Δσ² ≈ 2 · (ln k)² / T = 2 · 5.3 / 2500 ≈ 0.0042"}</p>
      <p>{"日次σは √0.0042 ≈ 6.5% 増える。元のσが 1.3% なら 12% 台に化ける（年率 21% → 193%）。"}</p>
      <p>
        {"さらに致命的なのは回帰。市場βは β = Cov(r_i, r_M) / Var(r_M) で、破損した系列を"}
        {"ベンチマーク M に使うと分母 Var(r_M) だけが100倍に膨らみ、分子は対応する日が"}
        {"1日ずれているので同じだけ増えない。結果 β → 0 に潰れる。"}
      </p>
      <p>
        {"実測: 7203.T の市場β（1306.T 基準・10年・n=2460）は 破損あり 0.049 → 修復後 1.096。"}
        {"気づかなければ「この銘柄は市場と無関係」という完全に誤った結論が出る。"}
      </p>

      <p className="font-medium text-gray-700 mt-3">3. 直感的な例え</p>
      <p>
        体重を毎日記録していて、2日だけ「kg」を「両」で書いてしまったとする。折れ線は谷に落ちて
        すぐ戻る。平均体重はほぼ変わらないが、
        <span className="font-medium">「体重の変動幅」は10倍に見える</span>
        。さらに「気温と体重の関係」を調べると、体重側のばらつきが巨大すぎて気温との関係が
        埋もれ、「気温は体重と無関係」という結論になる。これが β がゼロに潰れる現象と同じ。
      </p>

      <p className="font-medium text-gray-700 mt-3">4. 判定条件（誤検出を避ける設計）</p>
      <p>
        修復は「本物の相場変動では起こりえない」条件を
        <span className="font-medium">すべて</span>満たす場合に限る。
      </p>
      <ul className="list-disc pl-4 space-y-1">
        <li>{"大きさ: |ln r| > 0.3（±35%）"}</li>
        <li>{"往復: 5営業日以内に元の水準へ戻り、戻りの日も |ln r| > 0.3。残差が入口ジャンプの25%未満"}</li>
        <li>{"倍率: 含意される倍率が 1/10・1/100・1/2 等の「切りのいい」スケール比に対数で5%以内で一致"}</li>
        <li>{"材料性: |ln k| がその系列のロバストσ（MAD/0.6745）の10倍を超える"}</li>
      </ul>
      <p>
        {"倍率の推定は往復の両端から取って平均する。入口は ln(P̃_t/P_{t-1}) = ln k + r_t、"}
        {"出口は ln(P̃_{s-1}/P_s) = ln k − r_s なので、平均すると真のリターンの寄与が相殺され"}
        {"ln k の精度が上がる。その上で切りのいい比に丸めるので、修復後の区間内リターンに"}
        {"人工的な段差が入らない。"}
      </p>

      <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>
          <span className="font-medium">修復 0 銘柄</span>
          ：書き換えは一切していない。表示している数値は配信値そのまま。
        </li>
        <li>
          <span className="font-medium">修復あり</span>
          ：表の「配信値」と「修復値」を見比べれば、どの日をどう直したかが1円単位で分かる。
          チャートの赤（配信値）が崖になっていて緑（修復後）が連続していれば、修復は妥当。
        </li>
        <li>
          <span className="font-medium">年率σの膨張倍率</span>
          が判定の検算になる。膨張が 5倍・10倍なら本物の破損。
          <span className="font-medium">1.1倍程度なら誤検出を疑う</span>
          ——壊れていないものを直した可能性が高い。実際に開発中、^TNX（米10年金利）の
          2020-03-09（COVID ショックで金利が急落し数日で戻した）を倍率 2/3 として
          誤検出したことがあり、σ改善が 1.1倍しかない点が誤りの手掛かりだった。
          この教訓から 1 に近い倍率は候補から外してある。
        </li>
        <li>
          <span className="font-medium">要確認（未修復）</span>
          ：極端な変動だが機械判断を放棄した箇所。値は書き換えていない。本物の暴落・
          ストップ安・未調整の分割などが混ざる。
        </li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>
          <span className="font-medium">β・相関・最適化を読む前にここを見る。</span>
          修復のあった系列をベンチマークに使っていた場合、修復前に出した β・SML・効率的
          フロンティア・最小分散ウェイトはすべて捨てる必要がある。
        </li>
        <li>
          ベンチマークは検索対象の銘柄ではないので、
          <span className="font-medium">「ベンチマーク指数も点検する」を押して確認する</span>
          。破損していた 1306.T はまさにこの位置にいた。
        </li>
        <li>
          σが過大評価されるとポジションサイズ（ケリー基準・ボラターゲティング）が過小になる。
          修復前のσで建玉を決めていたなら、必要な露出を取り逃していた可能性がある。
        </li>
        <li>
          「要確認」に出た日は本物の急変動である可能性が高い。イベントスタディや
          テイルリスク分析ではむしろ<span className="font-medium">残すべき情報</span>
          であり、外れ値として捨てると尾の推定を歪める。
        </li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>
          <span className="font-medium">判定は保守側に倒してある。</span>
          正しいデータを黙って書き換える方が、破損を見逃すより有害だという判断。
          端数倍率の破損・水準が戻らない破損（未調整の分割）は修復せず「要確認」に回る。
        </li>
        <li>
          往復を検出条件にしているため、
          <span className="font-medium">系列の末尾で起きた破損は（まだ戻っていないので）修復できない</span>
          。直近の日付が「要確認」に出ている場合は特に注意。
        </li>
        <li>
          日中足（分足）には適用していない。ここで扱う破損は分割調整の当て間違いで、
          調整後終値を持つ日足に固有の現象。日中足の異常ティックは別クラスの問題。
        </li>
        <li>
          出来高は「価格と逆向きに誤スケールされている」という前提で戻している
          （1306.T では 251.8M × 0.1 ≒ 25M で平常水準と整合した）。この前提が崩れる
          破損では出来高だけずれる可能性がある。
        </li>
        <li>
          点検はこのアプリが取得した10年分に対して行う。期間を絞って表示していても、
          点検自体は全期間を見ている。
        </li>
      </ul>
    </AnalysisGuide>
  );
}
