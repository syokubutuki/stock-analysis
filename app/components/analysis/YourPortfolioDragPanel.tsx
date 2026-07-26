"use client";

// あなたのポートフォリオの「相関が食べた分」 ── docs/correlation-growth-drag-visualization.md Phase 1
//
// 「相関を無視してリターンを追う」＝ 長期成長率（幾何平均リターン）を削る操作、
// であることを実データで一目で示す。構成は仕様書 §10.5 Phase 1 のとおり:
//
//   G2 ウォーターフォール（期待 → −単独ドラッグ → −相関ドラッグ → 実際の成長率）
//   U5 隠れレバレッジカード（実質何銘柄／√(N/N_eff)／ボラティリティ税の倍率）
//   T1 1銘柄ずつ足していく台帳（期待は伸び続け、g は沈む）
//   S3 倍化年数への翻訳（%ではなく「2倍になるまで何年」で見せる）
//
// 既存資産の再利用: alignReturns（portfolio-risk.ts）で共通日付整列、建玉ウェイトの
// 抽出は PortfolioRiskPanel と同一ロジック。計算は純関数・O(N²) でメインスレッド useMemo。

import { useEffect, useMemo, useRef, useState } from "react";
import { PortfolioData } from "../../hooks/usePortfolioData";
import { WatchlistItem, effectiveKind } from "../../lib/watchlist";
import { Horizon, HORIZON_CONFIG } from "../../lib/signal-digest";
import { alignReturns } from "../../lib/portfolio-risk";
import {
  annualStats,
  decomposeDrag,
  incrementalLedger,
  orderByCorrelation,
  EMPTY_DECOMP,
  type DragDecomp,
  type LedgerMode,
  type LedgerRow,
} from "../../lib/growth-drag";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  data: PortfolioData;
  watchlist: WatchlistItem[];
  horizon: Horizon;
}

type WeightSource = "held" | "equal";

const pct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
const pctAbs = (v: number, d = 1) => `${(Math.abs(v) * 100).toFixed(d)}%`;

// 倍化年数の表示。g ≤ 0 は「永遠に来ない」（仕様書 §S3）。
function yearsLabel(y: number): string {
  if (!isFinite(y)) return "永遠に来ない";
  if (y > 200) return "200年超";
  return `${y.toFixed(1)}年`;
}

function manYen(v: number): string {
  const m = v / 10000;
  if (Math.abs(m) >= 1000) return `${(m / 10000).toFixed(2)}億円`;
  return `${m.toFixed(1)}万円`;
}

export default function YourPortfolioDragPanel({ data, watchlist, horizon }: Props) {
  // 建玉が無いユーザーでも意味を持つように、等ウェイトへ切り替えられる（仕様書 §10.2）。
  const [source, setSource] = useState<WeightSource>("held");
  const [ledgerMode, setLedgerMode] = useState<LedgerMode>("add");

  const base = useMemo(() => {
    const series = Object.entries(data)
      .filter(([, v]) => v.prices.length > 2)
      .map(([ticker, v]) => ({ ticker, prices: v.prices }));
    const names: Record<string, string> = {};
    for (const [t, v] of Object.entries(data)) names[t] = v.name || t;

    const aligned = alignReturns(series, HORIZON_CONFIG[horizon].window);

    // 建玉（保有・株数>0）の時価。PortfolioRiskPanel と同一の抽出ロジック。
    const rawWeights: Record<string, number> = {};
    for (const item of watchlist) {
      if (effectiveKind(item) !== "held") continue;
      const pos = item.position;
      const last = data[item.ticker]?.prices.at(-1)?.close;
      if (pos && pos.shares > 0 && last) rawWeights[item.ticker] = pos.shares * last;
    }
    const heldTickers = aligned.tickers.filter((t) => (rawWeights[t] ?? 0) > 0);
    const totalMV = heldTickers.reduce((s, t) => s + rawWeights[t], 0);

    return { aligned, names, rawWeights, heldTickers, totalMV };
  }, [data, watchlist, horizon]);

  const { aligned, names, rawWeights, heldTickers, totalMV } = base;
  const hasHeld = heldTickers.length >= 2;
  // 建玉が2銘柄未満なら自動的に等ウェイトへ倒す（表示が空になるのを避ける）。
  const effSource: WeightSource = source === "held" && hasHeld ? "held" : "equal";

  // ── 3項分解（G2 / U5 / S3 の共通の元） ────────────────────────────────
  const decomp: DragDecomp = useMemo(() => {
    if (aligned.tickers.length < 2) return EMPTY_DECOMP;
    const st = annualStats(aligned);
    const w = new Array(aligned.tickers.length).fill(0);
    if (effSource === "held") {
      aligned.tickers.forEach((t, i) => {
        const mv = rawWeights[t] ?? 0;
        w[i] = totalMV > 0 ? mv / totalMV : 0;
      });
    } else {
      const n = aligned.tickers.length;
      for (let i = 0; i < n; i++) w[i] = 1 / n;
    }
    return decomposeDrag(st.mu, st.cov, w);
  }, [aligned, effSource, rawWeights, totalMV]);

  // 円換算の基準額。建玉があればその評価額、無ければ100万円を仮の投下資金とする。
  const capital = effSource === "held" && totalMV > 0 ? totalMV : 1_000_000;
  const capitalIsReal = effSource === "held" && totalMV > 0;

  // ── T1 台帳 ────────────────────────────────────────────────────────────
  const ledger: LedgerRow[] = useMemo(() => {
    if (aligned.tickers.length < 2) return [];
    const universe = effSource === "held" ? heldTickers : aligned.tickers;
    if (universe.length < 2) return [];
    // 建玉モードなら最大の建玉を起点に、そこから「似た銘柄」を足していく。
    let seed: string | undefined;
    if (effSource === "held") {
      seed = [...universe].sort((a, b) => (rawWeights[b] ?? 0) - (rawWeights[a] ?? 0))[0];
    }
    const order = orderByCorrelation(aligned, universe, seed);
    return incrementalLedger(aligned, order, ledgerMode, names);
  }, [aligned, effSource, heldTickers, rawWeights, ledgerMode, names]);

  // ── G2 ウォーターフォール（横軸=リターン値の静的図なので Canvas2D） ──────
  const wfCanvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = wfCanvas.current;
    if (!canvas || !decomp.ok) return;
    const draw = () => drawWaterfall(canvas, decomp, capital);
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [decomp, capital]);

  if (aligned.tickers.length < 2) {
    return (
      <div className="py-8 text-center text-gray-400 text-sm">
        共通日付で整列できる銘柄が2つ以上必要です（ウォッチリストに銘柄を追加してください）。
      </div>
    );
  }

  const corrShare =
    decomp.soloDrag + decomp.corrDrag > 1e-9
      ? decomp.corrDrag / (decomp.soloDrag + decomp.corrDrag)
      : 0;

  return (
    <div className="space-y-5">
      {/* コントロール */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-gray-500">
          ウェイトの取り方
          <div className="mt-0.5 flex gap-1 bg-gray-100 rounded p-0.5">
            <button
              onClick={() => setSource("held")}
              disabled={!hasHeld}
              className={`px-2 py-0.5 text-xs rounded ${
                effSource === "held" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"
              } ${!hasHeld ? "opacity-40 cursor-not-allowed" : ""}`}
            >
              建玉ベース
            </button>
            <button
              onClick={() => setSource("equal")}
              className={`px-2 py-0.5 text-xs rounded ${
                effSource === "equal" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"
              }`}
            >
              ウォッチリスト等ウェイト
            </button>
          </div>
        </label>
        <div className="text-[11px] text-gray-400 pb-1">
          {effSource === "held"
            ? `建玉${decomp.nAssets}銘柄・評価額 ¥${Math.round(totalMV).toLocaleString()}`
            : `全${decomp.nAssets}銘柄を等ウェイト（仮の投下資金100万円で円換算）`}
          {" / "}
          直近{HORIZON_CONFIG[horizon].window}本・年率換算
          {!hasHeld && source === "held" && " / 建玉が2銘柄未満のため等ウェイト表示"}
        </div>
      </div>

      {/* ── U5 隠れレバレッジカード ─────────────────────────────────────── */}
      <div className="rounded-lg border-2 border-red-200 bg-red-50 p-4">
        <div className="text-xs text-gray-600">
          {decomp.nAssets} 銘柄に分散したつもり
        </div>
        <div className="mt-1 flex flex-wrap items-end gap-x-8 gap-y-2">
          <div>
            <div className="text-[10px] text-gray-500">実質</div>
            <div className="text-3xl font-bold text-red-700 tabular-nums">
              {decomp.nEff.toFixed(1)} <span className="text-lg">銘柄</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500">隠れレバレッジ</div>
            <div className="text-3xl font-bold text-red-700 tabular-nums">
              {decomp.hiddenLev.toFixed(2)} <span className="text-lg">倍</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500">平均相関</div>
            <div className="text-2xl font-bold text-gray-700 tabular-nums">
              {decomp.avgCorr.toFixed(2)}
            </div>
          </div>
        </div>

        {/* 銘柄アイコン: N 個のうち N_eff 個分だけが点灯する */}
        <div className="mt-3 flex flex-wrap gap-1">
          {Array.from({ length: Math.min(decomp.nAssets, 40) }, (_, i) => {
            const fill = Math.max(0, Math.min(1, decomp.nEff - i));
            return (
              <div
                key={i}
                className="relative w-5 h-5 rounded-sm bg-gray-300 overflow-hidden"
                title={`${i + 1}銘柄目（実効 ${(fill * 100).toFixed(0)}%）`}
              >
                <div
                  className="absolute inset-y-0 left-0 bg-red-500"
                  style={{ width: `${fill * 100}%` }}
                />
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-gray-700">
          払っている<strong>ボラティリティ税</strong>は、本当に分散できていた場合の{" "}
          <strong className="text-red-700 text-base tabular-nums">
            {decomp.taxMultiple.toFixed(1)} 倍
          </strong>
          （N / N_eff = {decomp.nAssets} / {decomp.nEff.toFixed(1)}）。
          灰色の部分が「分散しているつもりだったのに消えている」ぶんです。
        </p>
      </div>

      {/* ── G2 ウォーターフォール ───────────────────────────────────────── */}
      <div>
        <div className="text-xs font-semibold text-gray-700 mb-1.5">
          期待リターンは、どこへ消えたのか（年率・3項分解）
        </div>
        <canvas ref={wfCanvas} className="w-full" />
        <p className="mt-1 text-[11px] text-gray-500">
          青＝期待リターン（見かけ） / 灰＝単独ドラッグ（分散しても残る分） /{" "}
          <strong className="text-red-600">赤＝相関ドラッグ（相関を無視した代償）</strong> /
          緑＝実際に増える速さ。
          {corrShare > 0 && (
            <>
              {" "}ドラッグ全体のうち <strong>{(corrShare * 100).toFixed(0)}%</strong> が相関由来。
            </>
          )}
          {capitalIsReal
            ? ` 円は評価額 ${manYen(totalMV)} に対する年額。`
            : " 円は仮の投下資金100万円に対する年額。"}
        </p>
      </div>

      {/* ── S3 倍化年数への翻訳 ─────────────────────────────────────────── */}
      <div>
        <div className="text-xs font-semibold text-gray-700 mb-1.5">
          「2倍になるまで何年か」への翻訳
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-300 text-gray-500">
                <th className="text-left py-1 px-2 font-medium">シナリオ</th>
                <th className="text-right py-1 px-2 font-medium">期待リターン</th>
                <th className="text-right py-1 px-2 font-medium">ドラッグ</th>
                <th className="text-right py-1 px-2 font-medium">実質成長率 g</th>
                <th className="text-right py-1 px-2 font-medium">資産が2倍になるまで</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-1.5 px-2 text-gray-700">もし相関がゼロだったら</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{pct(decomp.expected)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-gray-500">
                  −{pctAbs(decomp.soloDrag)}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-green-700">
                  {pct(decomp.growthNoCorr)}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-green-700">
                  {yearsLabel(decomp.doublingYearsNoCorr)}
                </td>
              </tr>
              <tr className="bg-red-50">
                <td className="py-1.5 px-2 text-gray-800 font-medium">今のあなた（実測の相関）</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{pct(decomp.expected)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-red-600">
                  −{pctAbs(decomp.soloDrag + decomp.corrDrag)}
                </td>
                <td
                  className={`py-1.5 px-2 text-right tabular-nums font-semibold ${
                    decomp.growth > 0 ? "text-gray-800" : "text-red-700"
                  }`}
                >
                  {pct(decomp.growth)}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums font-bold text-red-700">
                  {yearsLabel(decomp.doublingYears)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          期待リターンは<strong>2行とも同じ</strong>です。変わったのは相関だけ。それでも
          {isFinite(decomp.doublingYearsNoCorr) && isFinite(decomp.doublingYears) ? (
            <>
              {" "}2倍になるまでが <strong>{yearsLabel(decomp.doublingYearsNoCorr)}</strong> から{" "}
              <strong className="text-red-700">{yearsLabel(decomp.doublingYears)}</strong> に延びました。
            </>
          ) : (
            <> 倍化までの時間が大きく変わります。</>
          )}
        </p>
      </div>

      {/* ── T1 1銘柄ずつ足していく台帳 ──────────────────────────────────── */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
          <div className="text-xs font-semibold text-gray-700">
            1銘柄ずつ足していく台帳（相関の高い順＝「似た銘柄をどんどん買う」の再現）
          </div>
          <div className="flex gap-1 bg-gray-100 rounded p-0.5">
            <button
              onClick={() => setLedgerMode("add")}
              className={`px-2 py-0.5 text-xs rounded ${
                ledgerMode === "add" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"
              }`}
            >
              追加（各銘柄に同額を張り足す）
            </button>
            <button
              onClick={() => setLedgerMode("split")}
              className={`px-2 py-0.5 text-xs rounded ${
                ledgerMode === "split" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"
              }`}
            >
              分割（同じ資金をN分割）
            </button>
          </div>
        </div>
        <p className="text-[11px] text-gray-500 mb-2">
          {ledgerMode === "add" ? (
            <>
              <strong>前提</strong>: 1銘柄あたり同じ金額を張り続ける（＝現金を減らす／信用を使う）。
              総建玉は銘柄数ぶんに膨らみます。これが「分散投資したつもりが、実際はレバレッジを掛けていただけ」の正体です。
            </>
          ) : (
            <>
              <strong>前提</strong>: 同じ資金を N 分割する（総建玉は常に100%）。
              こちらは本物の分散で、相関が1未満なら成長率は必ず改善します。上の「追加」と見比べてください。
            </>
          )}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-300 text-gray-500">
                <th className="text-left py-1 px-2 font-medium">追加</th>
                <th className="text-right py-1 px-2 font-medium" title="追加前のバスケットとの相関">
                  既存との相関
                </th>
                <th className="text-right py-1 px-2 font-medium">総建玉</th>
                <th className="text-right py-1 px-2 font-medium">期待リターン</th>
                <th className="text-right py-1 px-2 font-medium">σ_p</th>
                <th className="text-right py-1 px-2 font-medium">ドラッグ</th>
                <th className="text-right py-1 px-2 font-medium">実質成長率 g</th>
                <th className="text-right py-1 px-2 font-medium">2倍まで</th>
                <th className="text-right py-1 px-2 font-medium">N_eff</th>
                <th className="text-right py-1 px-2 font-medium">隠れレバ</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((r, i) => {
                const prev = i > 0 ? ledger[i - 1] : null;
                const expUp = prev ? r.expected > prev.expected + 1e-9 : false;
                const gDown = prev ? r.growth < prev.growth - 1e-9 : false;
                return (
                  <tr
                    key={r.ticker}
                    className={`border-b border-gray-100 ${r.isPeak ? "bg-amber-50" : ""}`}
                  >
                    <td className="py-1.5 px-2 whitespace-nowrap">
                      <span className="text-gray-400">{i + 1}.</span>{" "}
                      <span className="text-gray-800">{r.ticker}</span>{" "}
                      <span className="text-gray-400">{r.name}</span>
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                      {isNaN(r.corrToPrev) ? "—" : r.corrToPrev.toFixed(2)}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-gray-500">
                      {(r.exposure * 100).toFixed(0)}%
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-blue-700">
                      {pct(r.expected)} {expUp && <span className="text-green-600">↑</span>}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                      {pctAbs(r.sigmaP)}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-red-600">
                      −{pctAbs(r.drag)}
                    </td>
                    <td
                      className={`py-1.5 px-2 text-right tabular-nums font-semibold ${
                        r.growth > 0 ? "text-gray-800" : "text-red-700"
                      }`}
                    >
                      {pct(r.growth)} {gDown && <span className="text-red-600">↓</span>}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                      {yearsLabel(r.doublingYears)}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                      {r.nEff.toFixed(2)}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                      {r.hiddenLev.toFixed(2)}×
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {ledger.length > 0 && (
          <p className="mt-1 text-[11px] text-gray-500">
            黄色の行＝成長率が最大になった地点（{ledger.findIndex((r) => r.isPeak) + 1}銘柄目）。
            {ledger.findIndex((r) => r.isPeak) < ledger.length - 1 ? (
              <strong className="text-amber-700">
                {" "}ここから先は、足すほど遅くなります。
              </strong>
            ) : (
              <> この標本ではまだ折り返していません。</>
            )}
            {" "}期待リターンの列（青）は伸び続けるのに、成長率の列が沈んでいく——同じ行の中で矢印が逆を向くのが、この分析の主題です。
          </p>
        )}
      </div>

      <AnalysisGuide title="幾何成長率とボラティリティ・ドラッグの詳細理論">
        <p className="font-medium text-gray-700">1. 手法の概要</p>
        <p>
          「期待リターン」は<strong>足し算の世界</strong>の言葉です。100人が1回ずつ賭けたときの、100人の平均。
          でもあなたの資産は<strong>掛け算</strong>で増えます。今年の結果に来年の結果を掛ける。
          掛け算の世界では、上下に揺れること自体が資産を削ります。+10%と−10%を繰り返すと、
          平均は0%なのに資産は減っていく。この「揺れの分の目減り」を<strong>ボラティリティ税</strong>
          （ボラティリティ・ドラッグ）と呼びます。
        </p>
        <p>
          銘柄を足すと期待リターンは足し算で増えます。でも税は<strong>二乗</strong>で増えます。
          しかも、似た値動きの銘柄を足すと揺れは打ち消し合わず、そのまま積み上がる。
          だから「良さそうな銘柄を見つけるたびに買い足す」は、期待リターンを増やしながら、
          それ以上の速さで税を増やす操作になります。
          <strong>
            10銘柄持っていても、値動きがそっくりなら、それは1銘柄を10倍の大きさで持っているのと同じです。
          </strong>
          このパネルは、その「消えている分」をあなたの実データで測ります。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          対数リターン {" r_t = log(P_t / P_{t−1}) "}、資産の成長は {" W_T = W_0 · exp(Σ r_t) "}。
          算術平均（期待リターン）を μ_a、幾何平均（実質成長率）を g とすると、
          {" log(1+x) ≈ x − x²/2 "} を期待値に取り {" E[x²] ≈ σ² "} として
        </p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">g ≈ μ_a − σ²/2</p>
        <p>
          （対数正規分布なら近似ではなく厳密）。この {" σ²/2 "} がボラティリティ・ドラッグです。
          ポートフォリオの分散は {" σ_p² = Σ_i Σ_j w_i w_j σ_i σ_j ρ_ij "}。
          等ウェイト・共通 σ・共通 ρ なら
        </p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">
          σ_p² = σ²[ 1/N + (1−1/N)ρ ] = σ²/N_eff , N_eff = N/(1+(N−1)ρ)
        </p>
        <p>総建玉 W のときの成長率は3項に分解できます（本パネルのウォーターフォールそのもの）。</p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">
          g(W) = W·μ − W²σ²/(2N) − W²σ²(1−1/N)ρ/2
        </p>
        <p>
          第1項が期待（W に<strong>比例</strong>）、第2項が単独ドラッグ、第3項が相関ドラッグ
          （どちらも W の<strong>二乗</strong>）。実データでは
          {" 単独ドラッグ = Σ w_i²σ_i²/2 "}、{" 相関ドラッグ = σ_p²/2 − 単独ドラッグ "} として計算しています。
        </p>
        <p>
          最適建玉は {" W* = μ / σ_single² "}（{" σ_single = σ/√N_eff "}）、フルケリー比は
          {" λ = W / W* "} で、{" g(λ)/g_max = 2λ − λ² "}。λ=1 で最大、
          <strong>λ=2 で成長率ちょうどゼロ、λ&gt;2 では資産が減っていきます</strong>（期待値は増え続けているのに）。
        </p>
        <p>
          <strong>「相関を無視する」の数学的な意味</strong>: ρ を 0 と誤認して W* を計算すると、
          真の最適の {" √(1+(N−1)ρ) "} 倍の建玉を持つことになります。すなわち
          {" λ_true = √(N/N_eff) "}。N=10, ρ=0.5 なら λ=2.35 で {" 2λ−λ² = −0.82 "}、
          成長率は最大値の −82%、つまり資産は減っていきます。
        </p>
        <p className="text-[11px] text-gray-500">
          実装上の注意: 対数リターンの平均×252 は既に g そのものであって μ_a ではありません。
          本パネルは μ_a を単純リターン {" exp(r)−1 "} の平均から、Σ を対数リターンの共分散から取っています。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>算術平均（期待リターン）</strong>: 各期のリターンを単純に平均したもの。
            「大勢の人の平均」に相当し、あなた1人の資産の伸びとは一致しない。
          </li>
          <li>
            <strong>幾何平均（実質成長率 g）</strong>: 資産が実際に増えていく速さ。
            掛け算の平均。長期投資で意味を持つのはこちらだけ。
          </li>
          <li>
            <strong>ボラティリティ・ドラッグ（ボラティリティ税）</strong>: 算術平均と幾何平均の差 σ²/2。
            値動きが荒いだけで自動的に取られる目減り分。
          </li>
          <li>
            <strong>実効銘柄数 N_eff</strong>: {" (Σw)²/(wᵀRw) "}。
            相関とウェイトの偏りを織り込んだ「実質的に何個の別々の賭けを持っているか」。
          </li>
          <li>
            <strong>N / N_eff</strong>: {" 1+(N−1)ρ "}。
            <strong>払っているボラティリティ税が、本当に分散できていた場合の何倍か</strong>。
          </li>
          <li>
            <strong>隠れレバレッジ</strong>: {" √(N/N_eff) "}。思っていたリスクの何倍を実際に負っているか。
          </li>
          <li>
            <strong>倍化年数</strong>: {" ln2/g "}。成長率を「2倍になるまで何年か」に翻訳したもの。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>卵とカゴとトラック</strong>: 卵を10個のカゴに分けたが、カゴを全部同じトラックに載せている。
            事故れば全部割れる。カゴの数（銘柄数）ではなく<strong>トラックの数（N_eff）</strong>が本当の分散。
          </li>
          <li>
            <strong>占い師</strong>: 別々の10人の占い師に聞く（ρ=0）のと、1人の占い師に10回聞く（ρ=1）のは違う。
            後者は自信が10倍になるだけで、情報は1つ分。
          </li>
          <li>
            <strong>和音とボリューム</strong>: 違う音を重ねると和音（分散）。同じ音を10個重ねても音量が10倍になるだけ
            （レバレッジ）。うるさいだけで曲は豊かにならない。
          </li>
          <li>
            <strong>穴の空いたバケツ</strong>: 期待リターン＝蛇口の水量、ボラ＝バケツの穴。
            相関の高い銘柄を足すと蛇口は太くなるが、穴は<strong>もっと速く</strong>大きくなる（穴は二乗で効く）。
          </li>
          <li>
            <strong>山道の平均時速</strong>: 行き60km/h・帰り20km/hの「平均」は40km/hではなく30km/h（調和平均）。
            平均という言葉が2種類あることの日常例。
          </li>
          <li>
            <strong>階段</strong>: 1段上がって1段下がれば元に戻る。でも「10%上がって10%下がる」は元に戻らない（99%）。
            掛け算の世界では上りと下りが非対称。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            ウォーターフォールで<strong>一番長い赤い棒</strong>が相関ドラッグなら、あなたの成長率を削っている
            主犯は「銘柄の選び方」ではなく「似た銘柄を並べたこと」。
          </li>
          <li>
            N / N_eff = 5.5 なら、<strong>払っている税は本物の分散の5.5倍</strong>。
            銘柄数を増やしても、この数字が下がらなければ分散にはなっていない。
          </li>
          <li>
            隠れレバレッジが 2 を超える＝フルケリー比 λ&gt;2 の目安。
            {" g(λ)/g_max = 2λ−λ² "} が負に入る領域で、<strong>建玉を減らすことが唯一の改善策</strong>。
          </li>
          <li>
            台帳で「期待リターン ↑」と「成長率 ↓」が同じ行で逆を向いたら、その追加は<strong>もう足し算になっていない</strong>。
            黄色い行より下は、買うほど遅くなる領域。
          </li>
          <li>
            倍化年数が「永遠に来ない」と出たら、g ≤ 0。期待リターンが正でも資産は増えません。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>買い増しの前に N_eff の変化を見る</strong>。銘柄数が増えても N_eff が増えないなら、
            それは分散ではなく既存ポジションの増量。
          </li>
          <li>
            <strong>同業種の追加は「分散」ではなく「増し玉」と認識する</strong>。台帳の「既存との相関」列が
            0.6 を超える銘柄の追加は、実質的にレバレッジを上げる操作。
          </li>
          <li>
            <strong>建玉上限を λ&lt;1 から逆算する</strong>。隠れレバレッジが 1 を大きく超えるなら、
            総建玉をその倍率で割った水準まで落とすと成長率が最大に近づく。
          </li>
          <li>
            相関の低い銘柄を1つ加えるほうが、期待リターンの高い似た銘柄を3つ加えるより g を上げることがある。
            台帳の「分割」モードで確かめられる。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>μ の推定誤差は σ の推定誤差よりはるかに大きい</strong>。
            期待リターンの列は過去平均であり、将来の期待値ではない。ケリー最適点そのものは信用できないので、
            判断は必ず <strong>λ&lt;1 の側（建玉を減らす側）に倒す</strong>。
          </li>
          <li>
            <strong>相関は非定常で、テール時に上がる</strong>。ここで使う相関は平時の平均であり、
            暴落時にはさらに 1 へ寄って N_eff は今より小さくなる。危機時の相関は
            「ポートフォリオ・リスク分析」の DCC・危機時相関を参照。
          </li>
          <li>
            {" g ≈ μ−σ²/2 "} は2次近似。テールが厚い（尖度が高い）分布では
            ドラッグを<strong>過小評価</strong>する。実際の目減りはこの表より大きくなりうる。
          </li>
          <li>
            過去相関が将来相関を保証しない。銘柄数が少ない・期間が短いと相関行列の推定誤差が大きく、
            N_eff も不安定になる。
          </li>
          <li>
            台帳の並び順は「相関の高い順」に固定した思考実験であり、推奨する組み入れ順ではない。
            「似た銘柄をどんどん買う」とどうなるかを再現するためのもの。
          </li>
          <li>
            共通営業日でしか整列できないため、上場間もない銘柄があると全体のデータ期間が短くなる。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// G2 ウォーターフォール（Canvas2D・initCanvas パターン）
// 横軸はリターン値（時間軸ではない）ので規約どおり Canvas2D で描く。
// ────────────────────────────────────────────────────────────────────────────
function drawWaterfall(canvas: HTMLCanvasElement, d: DragDecomp, capital: number) {
  const parent = canvas.parentElement;
  if (!parent) return;
  const width = parent.clientWidth;
  const rowH = 46;
  const padT = 10;
  const padB = 30;
  const padL = 104;
  const padR = 12;
  const rows = 4;
  const height = padT + padB + rows * rowH;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);

  const afterSolo = d.expected - d.soloDrag;
  const segments = [
    { from: 0, to: d.expected, label: "期待リターン（見かけ）", value: d.expected, color: "#3b82f6", strong: false },
    { from: d.expected, to: afterSolo, label: "単独ドラッグ（分散しても残る分）", value: -d.soloDrag, color: "#9ca3af", strong: false },
    { from: afterSolo, to: d.growth, label: "相関ドラッグ（相関を無視した代償）", value: -d.corrDrag, color: "#dc2626", strong: true },
    { from: 0, to: d.growth, label: "実際に増える速さ（幾何成長率）", value: d.growth, color: "#16a34a", strong: true },
  ];

  // 定義域
  let lo = 0;
  let hi = 0;
  for (const s of segments) {
    lo = Math.min(lo, s.from, s.to);
    hi = Math.max(hi, s.from, s.to);
  }
  const span = hi - lo || 0.1;
  lo -= span * 0.06;
  hi += span * 0.06;
  const range = hi - lo || 1;
  const plotW = width - padL - padR;
  const xOf = (v: number) => padL + ((v - lo) / range) * plotW;

  // ゼロ線
  const zx = xOf(0);
  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(zx, padT);
  ctx.lineTo(zx, padT + rows * rowH);
  ctx.stroke();

  const barH = 20;
  segments.forEach((s, i) => {
    const yTop = padT + i * rowH + (rowH - barH) / 2 - 3;
    const x0 = xOf(Math.min(s.from, s.to));
    const x1 = xOf(Math.max(s.from, s.to));
    const w = Math.max(x1 - x0, 1.5);

    // 段差をつなぐ点線（前の段の到達点から降りてくる）
    if (i > 0 && i < 3) {
      const cx = xOf(s.from);
      ctx.save();
      ctx.strokeStyle = "#cbd5e1";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, padT + (i - 1) * rowH + (rowH - barH) / 2 - 3 + barH);
      ctx.lineTo(cx, yTop);
      ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = s.color;
    ctx.fillRect(x0, yTop, w, barH);
    if (s.strong) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 - 1.5, yTop - 1.5, w + 3, barH + 3);
    }

    // 左ガター: 値（%）と円換算
    ctx.textAlign = "right";
    ctx.fillStyle = s.value >= 0 ? "#111827" : "#b91c1c";
    ctx.font = "bold 13px ui-monospace, monospace";
    ctx.fillText(`${s.value >= 0 ? "+" : "−"}${(Math.abs(s.value) * 100).toFixed(1)}%`, padL - 10, yTop + 12);
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    const yen = s.value * capital;
    ctx.fillText(
      `${yen >= 0 ? "" : "▲"}${manYen(Math.abs(yen))}`,
      padL - 10,
      yTop + 24
    );

    // ラベル: 棒の右に置き、はみ出すなら棒の中に右寄せ
    ctx.font = s.strong ? "bold 12px sans-serif" : "12px sans-serif";
    const textW = ctx.measureText(s.label).width;
    if (x1 + 8 + textW < width - padR) {
      ctx.textAlign = "left";
      ctx.fillStyle = s.strong ? s.color : "#4b5563";
      ctx.fillText(s.label, x1 + 8, yTop + 14);
    } else {
      ctx.textAlign = "right";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(s.label, x1 - 6, yTop + 14);
    }
  });

  // 目盛り
  ctx.textAlign = "center";
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#9ca3af";
  ctx.strokeStyle = "#e5e7eb";
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = lo + (range * i) / ticks;
    const x = xOf(v);
    ctx.beginPath();
    ctx.moveTo(x, padT + rows * rowH);
    ctx.lineTo(x, padT + rows * rowH + 4);
    ctx.stroke();
    ctx.fillText(`${(v * 100).toFixed(0)}%`, x, padT + rows * rowH + 16);
  }
  ctx.textAlign = "left";
  ctx.fillStyle = "#9ca3af";
  ctx.fillText("年率リターン", padL, height - 4);
}
