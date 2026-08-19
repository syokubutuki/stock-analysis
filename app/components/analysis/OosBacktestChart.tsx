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
  // μ の定義（対数平均＝既定 vs 算術平均）を同じウォークフォワードで走らせた比較。
  // 接点(最大シャープ)だけが μ に依存し、最小分散/RP/逆ボラ/等加重は Σ だけで決まるので不変。
  const [muCompare, setMuCompare] = useState<OosResult | null>(null);
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
        const base = {
          lookback,
          rebalance,
          rf: rfPct / 100,
          covShrinkage: true,
          muShrinkage: true,
          maxWeight: 1,
        };
        const res = runOosBacktest(aligned, base);
        if (!res) setErr(`履歴が不足しています(必要: 推定${lookback}本+検証区間)。期間の長い銘柄で再試行を。`);
        setResult(res);
        // μ の定義の優劣は理屈で決められないので、同じ窓・同じ乱数条件で算術μ版も走らせる。
        // 評価側は元から単純リターンの複利なので、算術μは「最適化と評価の物差しが揃う」側。
        setMuCompare(res ? runOosBacktest(aligned, { ...base, muMode: "arithmetic" }) : null);
      } catch (e) {
        setErr(String((e as Error)?.message || e));
        setResult(null);
        setMuCompare(null);
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
        <span className="text-xs text-fg-muted">
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
            <div className="text-xs text-fg-muted">
              「検証を実行」を押すと、各配分則を過去だけで推定→直後を保有、を全期間で繰り返した実現成績を比較します(やや時間がかかります)。
            </div>
          ) : (
            <>
              <div ref={containerRef} className="w-full" style={{ height: HEIGHT }} />

              <div className="overflow-x-auto">
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="text-fg-muted text-left border-b border-gray-200">
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
                          {s.key === bestKey && <span className="ml-1 text-emerald-700 text-[10px]">◎最良</span>}
                        </td>
                        <td className="py-1 px-2 text-right font-semibold text-gray-800">{s.sharpe.toFixed(2)}</td>
                        <td className={`py-1 px-2 text-right ${s.cagr >= 0 ? "text-emerald-700" : "text-red-600"}`}>
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
                <p className="text-[10px] text-fg-muted mt-1">
                  推定窓{result.lookback}本・{result.rebalance}本ごと再配分。回転=1回の再配分での片道売買比率(コストの目安)。
                </p>
              </div>

              {/* μ の定義（対数平均 vs 算術平均）の OOS 比較。既定を変える判断はここで測る。 */}
              {muCompare && <MuModeCompare base={result} alt={muCompare} />}

              <MuReversalCheck rf={rfPct / 100} currentTickers={Object.keys(data)} />

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

// ────────────────────────────────────────────────────────────────────────────
// 反転条件の自動判定（複数ユニバース）
// ────────────────────────────────────────────────────────────────────────────
//
// docs/portfolio-analysis-open-issues.md §1.5 が定めた「既定を算術μへ反転してよい条件」:
//
//   銘柄構成の異なるウォッチリスト3本以上で（推定窓 × 再配分間隔を数通り）測り、
//     ① すべてで ΔSharpe ≥ 0
//     ② 平均 ΔSharpe > 0.02
//     ③ 明確な負（≤ −0.02）が1つも無い
//   の3つをすべて満たすなら反転する。
//
// これを手作業でやると1回あたり十数分かかり、「気になったときに測り直す」ができない。
// ここに置いて**ボタン1つで再現できる**ようにしておくと、将来この判断を見直すコストが消える。
//
// 銘柄は自前で /api/stock から取る（ウォッチリストに無い銘柄でも測れるようにするため）。
const DEFAULT_UNIVERSES = [
  { label: "A: 大型ディフェンシブ", tickers: "2914.T,4502.T,9433.T,2502.T" },
  { label: "B: 高ボラグロース", tickers: "6857.T,6920.T,4385.T,3092.T" },
  { label: "C: 業種混合", tickers: "7203.T,8306.T,9432.T,1605.T" },
];
/** 測定する設定（再配分は21本固定。docs §1.5 第2回測定と同じ）。 */
const CHECK_LOOKBACKS = [252, 126, 504];
const CHECK_REBALANCE = 21;

interface UniverseRow {
  label: string;
  tickers: string[];
  /** 推定窓ごとの ΔSharpe（算術μ − 対数μ）。測れなかった設定は NaN。 */
  deltas: number[];
  mean: number;
  min: number;
  note: string;
}

function MuReversalCheck({ rf, currentTickers }: { rf: number; currentTickers: string[] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() =>
    [
      ...DEFAULT_UNIVERSES.map((u) => `${u.label}: ${u.tickers}`),
      currentTickers.length >= 2 ? `D: 今のウォッチリスト: ${currentTickers.join(",")}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  );
  const [rows, setRows] = useState<UniverseRow[] | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setErr(null);
    setRows(null);
    try {
      const specs = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const i = line.lastIndexOf(":");
          const label = i > 0 ? line.slice(0, i).trim() : "ユニバース";
          const tickers = (i > 0 ? line.slice(i + 1) : line)
            .split(/[,\s]+/)
            .map((t) => t.trim())
            .filter(Boolean);
          return { label, tickers };
        })
        .filter((u) => u.tickers.length >= 2);
      if (specs.length === 0) throw new Error("銘柄が読み取れませんでした");

      const out: UniverseRow[] = [];
      for (const u of specs) {
        setProgress(`${u.label} の価格を取得中…`);
        const series: { ticker: string; prices: { time: string; open: number; high: number; low: number; close: number; volume: number }[] }[] = [];
        for (const t of u.tickers) {
          const res = await fetch(`/api/stock?ticker=${encodeURIComponent(t)}&range=10y`);
          const json = await res.json();
          if (res.ok && json.prices?.length > 2) series.push({ ticker: t, prices: json.prices });
        }
        if (series.length < 2) {
          out.push({ label: u.label, tickers: u.tickers, deltas: [], mean: NaN, min: NaN, note: "価格取得に失敗" });
          continue;
        }
        const aligned = alignReturns(series, 100000);
        setProgress(`${u.label} を検証中…`);
        const deltas: number[] = [];
        for (const lb of CHECK_LOOKBACKS) {
          const base = {
            lookback: lb,
            rebalance: CHECK_REBALANCE,
            rf,
            covShrinkage: true,
            muShrinkage: true,
            maxWeight: 1,
          };
          const logRes = runOosBacktest(aligned, base);
          const ariRes = runOosBacktest(aligned, { ...base, muMode: "arithmetic" as const });
          const pick = (r: OosResult | null) => r?.strategies.find((s) => s.key === "tangency")?.sharpe;
          const a = pick(logRes);
          const b = pick(ariRes);
          deltas.push(a != null && b != null ? b - a : NaN);
          // 長い計算の合間に UI へ制御を返す
          await new Promise((r) => setTimeout(r, 0));
        }
        const ok = deltas.filter((d) => Number.isFinite(d));
        out.push({
          label: u.label,
          tickers: aligned.tickers,
          deltas,
          mean: ok.length ? ok.reduce((s, v) => s + v, 0) / ok.length : NaN,
          min: ok.length ? Math.min(...ok) : NaN,
          note: ok.length === 0 ? "履歴不足で測定不能" : "",
        });
      }
      setRows(out);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setRunning(false);
      setProgress("");
    }
  };

  const all = rows?.flatMap((r) => r.deltas.filter((d) => Number.isFinite(d))) ?? [];
  const usable = rows?.filter((r) => r.deltas.some((d) => Number.isFinite(d))) ?? [];
  const grandMean = all.length ? all.reduce((s, v) => s + v, 0) / all.length : NaN;
  const grandMin = all.length ? Math.min(...all) : NaN;
  const cond1 = all.length > 0 && all.every((d) => d >= 0);
  const cond2 = Number.isFinite(grandMean) && grandMean > 0.02;
  const cond3 = all.length > 0 && grandMin > -0.02;
  const enoughUniverses = usable.length >= 3;
  const flip = enoughUniverses && cond1 && cond2 && cond3;

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-semibold text-gray-700 flex items-center gap-1.5"
      >
        <span className="inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : "" }}>
          ▶
        </span>
        既定を算術μへ反転してよいか（複数ユニバースで条件を自動判定）
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-gray-600">
            μ の定義という<strong>全パネルに波及する既定</strong>を、ウォッチリスト1本の測定で
            変えてはいけません。そこで判定条件を先に決めてあります（docs §1.5）——
            <strong>銘柄構成の異なる3ユニバース以上</strong>で
            <strong>①すべて ΔSharpe ≥ 0 ②平均 &gt; 0.02 ③明確な負（≤ −0.02）が無い</strong>、
            の3つをすべて満たしたときだけ反転する。ここはその測定をボタン1つで再現するためのものです。
            1行 = 1ユニバース（「ラベル: 銘柄,銘柄,…」）。推定窓 {CHECK_LOOKBACKS.join("/")} 本 ×
            再配分 {CHECK_REBALANCE} 本で測ります。
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            className="w-full text-[11px] font-mono border border-gray-300 rounded p-1.5"
            spellCheck={false}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={run}
              disabled={running}
              className="px-3 py-1 text-xs rounded bg-gray-800 text-white disabled:bg-gray-400"
            >
              {running ? "測定中…" : "測定する"}
            </button>
            <span className="text-[11px] text-gray-500">
              {running ? progress : "各ユニバースの全銘柄を10年ぶん取得するので数十秒かかります"}
            </span>
          </div>
          {err && <div className="text-[11px] text-red-600">失敗しました（{err}）。</div>}

          {rows && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="text-fg-muted text-left border-b border-gray-200">
                      <th className="py-1 pr-2 font-medium">ウォッチリスト</th>
                      {CHECK_LOOKBACKS.map((lb) => (
                        <th key={lb} className="py-1 px-2 font-medium text-right">
                          {lb}本
                        </th>
                      ))}
                      <th className="py-1 px-2 font-medium text-right">平均</th>
                      <th className="py-1 pl-2 font-medium text-right">最小</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.label} className="border-b border-gray-100">
                        <td className="py-1 pr-2 text-gray-700">
                          {r.label}
                          <span className="text-fg-muted"> （{r.tickers.length}銘柄）</span>
                          {r.note && <span className="text-amber-700"> {r.note}</span>}
                        </td>
                        {r.deltas.length === 0
                          ? CHECK_LOOKBACKS.map((lb) => (
                              <td key={lb} className="py-1 px-2 text-right text-gray-300">
                                —
                              </td>
                            ))
                          : r.deltas.map((d, i) => (
                              <td
                                key={i}
                                className={`py-1 px-2 text-right ${
                                  !Number.isFinite(d)
                                    ? "text-gray-300"
                                    : d < -0.02
                                      ? "text-red-700 font-semibold"
                                      : d >= 0
                                        ? "text-gray-700"
                                        : "text-amber-700"
                                }`}
                              >
                                {Number.isFinite(d) ? `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(3)}` : "—"}
                              </td>
                            ))}
                        <td className="py-1 px-2 text-right font-medium">
                          {Number.isFinite(r.mean) ? `${r.mean >= 0 ? "+" : "−"}${Math.abs(r.mean).toFixed(3)}` : "—"}
                        </td>
                        <td className="py-1 pl-2 text-right text-gray-500">
                          {Number.isFinite(r.min) ? `${r.min >= 0 ? "+" : "−"}${Math.abs(r.min).toFixed(3)}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div
                className={`rounded border px-2 py-1.5 ${
                  flip ? "border-violet-300 bg-violet-50" : "border-gray-300 bg-white"
                }`}
              >
                <div className="text-xs font-semibold text-gray-800">
                  判定: {flip ? "3条件をすべて満たす → 反転してよい" : "条件を満たさない → 既定は対数平均のまま"}
                </div>
                <table className="w-full text-[11px] mt-1">
                  <tbody>
                    <tr>
                      <td className="py-0.5 pr-2 text-gray-600">ユニバース3本以上</td>
                      <td className={enoughUniverses ? "text-gray-700" : "text-red-700"}>
                        {enoughUniverses ? `満たす（${usable.length}本）` : `満たさない（${usable.length}本）`}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-0.5 pr-2 text-gray-600">① 全設定で ΔSharpe ≥ 0</td>
                      <td className={cond1 ? "text-gray-700" : "text-red-700"}>
                        {cond1
                          ? "満たす"
                          : `満たさない（負が ${all.filter((d) => d < 0).length} つ）`}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-0.5 pr-2 text-gray-600">② 平均 ΔSharpe &gt; 0.02</td>
                      <td className={cond2 ? "text-gray-700" : "text-red-700"}>
                        {Number.isFinite(grandMean)
                          ? `${cond2 ? "満たす" : "満たさない"}（${grandMean >= 0 ? "+" : "−"}${Math.abs(grandMean).toFixed(4)}）`
                          : "—"}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-0.5 pr-2 text-gray-600">③ 明確な負（≤ −0.02）が無い</td>
                      <td className={cond3 ? "text-gray-700" : "text-red-700"}>
                        {Number.isFinite(grandMin)
                          ? `${cond3 ? "満たす" : "満たさない"}（最小 ${grandMin >= 0 ? "+" : "−"}${Math.abs(grandMin).toFixed(3)}）`
                          : "—"}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p className="mt-1 text-[11px] text-gray-600">
                  {flip ? (
                    <>
                      条件を満たしました。反転するなら
                      <strong>いつ・なぜ変えたかを docs/portfolio-analysis-open-issues.md に追記</strong>
                      してください（過去のスクリーンショットとの比較可能性が切れるため）。
                    </>
                  ) : (
                    <>
                      <strong>μ の定義は OOS を安定して動かす要因ではない</strong>、というのが
                      現時点の結論です（既定は対数平均のまま）。表示上の実害
                      （g の過小表示）は既に解消済みで、算術μで見たいときは
                      フロンティアのトグルでいつでも切り替えられます。
                      なお<strong>σ が銘柄間で揃っているユニバースでは差がほぼゼロ</strong>になります——
                      μ_log と μ_arith が定数シフトの関係になり、接点の正規化で消えるためです。
                    </>
                  )}
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * μ の定義（対数平均＝既定 vs 算術平均＝教科書）の OOS 比較。
 *
 * 在サンプルでは算術μの方が定義上シャープ比が高くなるが、それは当たり前で意味がない
 * （最大化している目的関数そのもの）。**将来に効くかはウォークフォワードでしか測れない**。
 * μ に依存するのは接点(最大シャープ)だけで、最小分散・リスクパリティ・逆ボラ・等加重は
 * Σ だけで決まるため両者で完全に同一。だから比較すべき行は接点の1行。
 */
function MuModeCompare({ base, alt }: { base: OosResult; alt: OosResult }) {
  const pick = (r: OosResult) => r.strategies.find((s) => s.key === "tangency");
  const a = pick(base);
  const b = pick(alt);
  if (!a || !b) return null;
  const dSharpe = b.sharpe - a.sharpe;
  const dCagr = b.cagr - a.cagr;
  const rows = [
    { label: "接点：μ=対数平均（既定）", s: a, accent: "#2563eb" },
    { label: "接点：μ=算術平均（教科書）", s: b, accent: "#7c3aed" },
  ];
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50 p-3">
      <div className="text-xs font-semibold text-violet-800">
        μ の定義を OOS で比較（接点のみ・他の配分則は Σ だけで決まるので不変）
      </div>
      <div className="overflow-x-auto mt-1.5">
        <table className="w-full text-[11px] tabular-nums">
          <thead>
            <tr className="text-fg-muted text-left border-b border-violet-200">
              <th className="py-1 pr-2 font-medium">推定に使った μ</th>
              <th className="py-1 px-2 font-medium text-right">実現Sharpe</th>
              <th className="py-1 px-2 font-medium text-right">CAGR</th>
              <th className="py-1 px-2 font-medium text-right">年率σ</th>
              <th className="py-1 px-2 font-medium text-right">最大DD</th>
              <th className="py-1 pl-2 font-medium text-right">回転(片道)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-violet-100">
                <td className="py-1 pr-2 text-gray-700">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle"
                    style={{ background: r.accent }}
                  />
                  {r.label}
                </td>
                <td className="py-1 px-2 text-right font-semibold text-gray-800">{r.s.sharpe.toFixed(2)}</td>
                <td className={`py-1 px-2 text-right ${r.s.cagr >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                  {r.s.cagr >= 0 ? "+" : ""}
                  {(r.s.cagr * 100).toFixed(1)}%
                </td>
                <td className="py-1 px-2 text-right text-gray-600">{(r.s.annVol * 100).toFixed(1)}%</td>
                <td className="py-1 px-2 text-right text-red-500">{(r.s.maxDrawdown * 100).toFixed(1)}%</td>
                <td className="py-1 pl-2 text-right text-gray-500">{(r.s.turnover * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11px] text-gray-700 tabular-nums">
        差（算術 − 対数）: Sharpe{" "}
        <strong className={dSharpe > 0 ? "text-emerald-700" : dSharpe < 0 ? "text-red-700" : ""}>
          {dSharpe >= 0 ? "+" : ""}
          {dSharpe.toFixed(3)}
        </strong>
        {" ／ "}CAGR{" "}
        <strong className={dCagr > 0 ? "text-emerald-700" : dCagr < 0 ? "text-red-700" : ""}>
          {dCagr >= 0 ? "+" : ""}
          {(dCagr * 100).toFixed(2)}pp
        </strong>
      </p>
      <p className="mt-1 text-[10px] text-gray-500">
        <strong>読み方</strong>: 在サンプルでは算術μが定義上有利になるので比較の意味がありません
        （最大化している目的関数そのもの）。<strong>ここは将来側の1本勝負</strong>です。
        差が符号も含めて安定しない（推定窓・再配分間隔を変えると入れ替わる）なら、
        <strong>μ の定義は OOS 成績を動かす要因ではない</strong>＝既定を変える理由がない、という結論になります。
        逆に算術μが安定して勝つなら既定を反転すべきで、そのとき効率的フロンティアの
        等高線・g・倍化年数も自動的に厳密化されます。推定窓と再配分間隔を数通り変えて
        <strong>符号の安定性</strong>を確認してください（1つの設定だけで決めないこと）。
      </p>
    </div>
  );
}
