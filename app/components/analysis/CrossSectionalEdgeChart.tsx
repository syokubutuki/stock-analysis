"use client";

// クロスセクション・ロングショート ── 小エッジの棲息域。
// ウォッチリスト全銘柄を毎リバランス日に横断ランクし、上位ロング/下位ショートの市場中立
// ブックを作る。IC・実効ブレッドス・基本法則IR vs 実現シャープ・コスト分岐点・point-in-time
// 在籍(生存者バイアス診断)を出す。理論の詳細は末尾の AnalysisGuide を参照。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart, LineSeries, type IChartApi, type ISeriesApi, type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeCrossSectional, DEFAULT_X_PARAMS, XSIGNAL_LABEL, XSIGNAL_DESC,
  type XSignalId, type XResult,
} from "../../lib/cross-sectional-edge";
import { UNIVERSES, getUniverse } from "../../lib/universes";
import { fetchUniverse, parseTickerList } from "../../lib/universe-fetch";
import { MARGIN_KIND_ORDER, MARGIN_KIND_LABEL, resolveMarginRate, type MarginKind } from "../../lib/rakuten-margin";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
}

type UniverseMode = "watchlist" | "paste" | string; // string=プリセットid

const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
const num2 = (v: number) => v.toFixed(2);
const cls = (v: number) => (v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500");

function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: "good" | "bad" | "neutral"; sub?: string }) {
  const c = tone === "good" ? "text-green-700" : tone === "bad" ? "text-red-700" : "text-gray-800";
  return (
    <div className="rounded border border-gray-200 px-2.5 py-1.5">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-sm font-bold font-mono ${c}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400">{sub}</div>}
    </div>
  );
}

export default function CrossSectionalEdgeChart({ tickers, pricesByTicker, names }: Props) {
  const [signal, setSignal] = useState<XSignalId>(DEFAULT_X_PARAMS.signal);
  const [rebalanceDays, setRebalanceDays] = useState(DEFAULT_X_PARAMS.rebalanceDays);
  const [quantile, setQuantile] = useState(DEFAULT_X_PARAMS.quantile);
  const [costBps, setCostBps] = useState(DEFAULT_X_PARAMS.costBps);
  const [costModel, setCostModel] = useState<"flat" | "rakuten">("flat");
  const [marginKind, setMarginKind] = useState<MarginKind>("system");

  // ユニバース: ウォッチリスト / プリセット(大型30・主要60) / 貼り付け
  const [uniMode, setUniMode] = useState<UniverseMode>("watchlist");
  const [pasteRaw, setPasteRaw] = useState("");
  const [pasteTickers, setPasteTickers] = useState<string[]>([]);
  const [fetched, setFetched] = useState<{ prices: Record<string, PricePoint[]>; names: Record<string, string> }>({ prices: {}, names: {} });
  const [fetching, setFetching] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  // 選択ユニバースのティッカー列
  const uniTickers = useMemo<string[]>(() => {
    if (uniMode === "watchlist") return tickers;
    if (uniMode === "paste") return pasteTickers;
    return getUniverse(uniMode)?.tickers.map((t) => t.ticker) ?? [];
  }, [uniMode, tickers, pasteTickers]);

  // 非ウォッチリスト時は自前で取得
  useEffect(() => {
    if (uniMode === "watchlist") return;
    if (uniTickers.length === 0) { setFetched({ prices: {}, names: {} }); return; }
    const ctrl = new AbortController();
    setFetching(true);
    setProgress({ done: 0, total: uniTickers.length });
    fetchUniverse(uniTickers, (done, total) => setProgress({ done, total }), ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        const prices: Record<string, PricePoint[]> = {};
        const nm: Record<string, string> = {};
        const preset = getUniverse(uniMode);
        for (const [tk, v] of Object.entries(res)) {
          if (v.prices.length > 0) { prices[tk] = v.prices; nm[tk] = v.name; }
        }
        if (preset) for (const t of preset.tickers) if (!nm[t.ticker]) nm[t.ticker] = t.name;
        setFetched({ prices, names: nm });
      })
      .finally(() => { if (!ctrl.signal.aborted) setFetching(false); });
    return () => ctrl.abort();
  }, [uniMode, uniTickers]);

  const activePrices = uniMode === "watchlist" ? pricesByTicker : fetched.prices;
  const activeNames = uniMode === "watchlist" ? (names ?? {}) : fetched.names;
  const activeCount = Object.keys(activePrices).length;

  const result = useMemo<XResult>(
    () => computeCrossSectional(activePrices, activeNames, {
      ...DEFAULT_X_PARAMS, signal, rebalanceDays, quantile, costBps, costModel, marginKind,
    }),
    [activePrices, activeNames, signal, rebalanceDays, quantile, costBps, costModel, marginKind],
  );
  const ready = result.ok;

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line">[]>([]);

  useEffect(() => {
    if (!ready || !containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth, height: 260, crosshair: { mode: 0 },
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(0)}%` },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    chartRef.current = chart;
    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }); };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); chartRef.current = null; seriesRef.current = []; };
  }, [ready]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !result.ok) return;
    for (const s of seriesRef.current) chart.removeSeries(s);
    seriesRef.current = [];
    const gross = chart.addSeries(LineSeries, { color: "#9ca3af", lineWidth: 1, title: "グロス", priceLineVisible: false });
    gross.setData(result.equity.map((e) => ({ time: e.time as Time, value: e.gross })));
    const net = chart.addSeries(LineSeries, { color: "#2563eb", lineWidth: 2, title: "ネット", priceLineVisible: false });
    net.setData(result.equity.map((e) => ({ time: e.time as Time, value: e.net })));
    seriesRef.current = [gross, net];
    if (containerRef.current && containerRef.current.clientWidth > 0) chart.applyOptions({ width: containerRef.current.clientWidth });
    chart.timeScale().fitContent();
  }, [result]);

  const irGap = result.ok ? result.sharpeRealizedGross - result.irTheoretical : 0;

  // ユニバース選択 UI（結果の有無に関わらず常に表示する）
  const universeSelector = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-gray-500">ユニバース:</span>
        <button onClick={() => setUniMode("watchlist")} className={`px-2 py-0.5 rounded border ${uniMode === "watchlist" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}>
          ウォッチリスト({tickers.length})
        </button>
        {UNIVERSES.map((u) => (
          <button key={u.id} onClick={() => setUniMode(u.id)} className={`px-2 py-0.5 rounded border ${uniMode === u.id ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`} title={u.note}>
            {u.label}
          </button>
        ))}
        <button onClick={() => setUniMode("paste")} className={`px-2 py-0.5 rounded border ${uniMode === "paste" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}>
          貼り付け
        </button>
        {fetching && <span className="text-blue-600">取得中… {progress.done}/{progress.total}</span>}
        {!fetching && uniMode !== "watchlist" && <span className="text-gray-400">{activeCount}銘柄 読込済</span>}
      </div>
      {uniMode === "paste" && (
        <div className="flex flex-wrap items-center gap-2">
          <textarea
            value={pasteRaw} onChange={(e) => setPasteRaw(e.target.value)}
            placeholder="7203.T 6758.T 9984 ... (空白/カンマ/改行区切り・4桁は.T補完・廃止銘柄を含めれば point-in-time が効く)"
            className="flex-1 min-w-[280px] h-16 text-xs border border-gray-300 rounded p-1.5 font-mono"
          />
          <button onClick={() => setPasteTickers(parseTickerList(pasteRaw))} className="px-2 py-1 text-xs rounded bg-blue-600 text-white">
            読み込み({parseTickerList(pasteRaw).length})
          </button>
        </div>
      )}
    </div>
  );

  if (fetching && activeCount === 0) {
    return (
      <div className="space-y-3">
        {universeSelector}
        <div className="text-xs text-gray-500 p-3">ユニバースを取得中… {progress.done}/{progress.total}（10年分×{progress.total}銘柄。初回は時間がかかります）</div>
      </div>
    );
  }
  if (!result.ok) {
    return (
      <div className="space-y-3">
        {universeSelector}
        <div className="text-xs text-gray-500 p-3">{result.reason ?? "データ待ち"}</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {universeSelector}
      <p className="text-sm text-gray-600">
        {uniMode === "watchlist" ? "ウォッチリスト" : getUniverse(uniMode)?.label ?? "貼り付け"}の
        <span className="font-medium">全{activeCount}銘柄</span>を毎リバランス日に横断ランクし、
        <span className="font-medium">上位{(quantile * 100).toFixed(0)}%ロング / 下位{(quantile * 100).toFixed(0)}%ショート</span>の
        ダラー中立ブックを作ります。単名では breadth≈1 で頭打ちの小エッジを、多数同時ベットで初めて使える形にする
        ── 基本法則 <span className="font-medium">IR ≈ IC·√BR</span> の実践です。
        {activeCount >= 30 && <span className="text-green-700">（{activeCount}銘柄＝breadthが十分で、小エッジのICも検出しやすい）</span>}
      </p>

      {/* コントロール */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          シグナル
          <select className="border rounded px-1 py-0.5" value={signal} onChange={(e) => setSignal(e.target.value as XSignalId)}>
            {(Object.keys(XSIGNAL_LABEL) as XSignalId[]).map((s) => <option key={s} value={s}>{XSIGNAL_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          リバランス
          {[1, 5, 21].map((d) => (
            <button key={d} onClick={() => setRebalanceDays(d)} className={`px-1.5 py-0.5 rounded border ${rebalanceDays === d ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}>
              {d === 1 ? "毎日" : d === 5 ? "週次" : "月次"}
            </button>
          ))}
        </label>
        <label className="flex items-center gap-1">
          上下{(quantile * 100).toFixed(0)}%
          <input type="range" min={0.1} max={0.5} step={0.05} value={quantile} onChange={(e) => setQuantile(Number(e.target.value))} />
        </label>
        <label className="flex items-center gap-1">
          コスト
          <button onClick={() => setCostModel("flat")} className={`px-1.5 py-0.5 rounded border ${costModel === "flat" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}>フラット</button>
          <button onClick={() => setCostModel("rakuten")} className={`px-1.5 py-0.5 rounded border ${costModel === "rakuten" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`} title="楽天証券の実コスト: 代表スプレッド往復 + 信用金利/貸株料 + 諸経費">楽天実コスト</button>
        </label>
        {costModel === "flat" ? (
          <label className="flex items-center gap-1">
            片道
            {[0, 2, 5, 10].map((c) => (
              <button key={c} onClick={() => setCostBps(c)} className={`px-1.5 py-0.5 rounded border ${costBps === c ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}>{c}bp</button>
            ))}
          </label>
        ) : (
          <label className="flex items-center gap-1">
            信用区分
            <select className="border rounded px-1 py-0.5" value={marginKind} onChange={(e) => setMarginKind(e.target.value as MarginKind)}>
              {MARGIN_KIND_ORDER.map((k) => <option key={k} value={k}>{MARGIN_KIND_LABEL[k]}</option>)}
            </select>
            <span className="text-gray-400">
              買{(resolveMarginRate(marginKind).longRate * 100).toFixed(2)}%/貸株{(resolveMarginRate(marginKind).shortRate * 100).toFixed(2)}%
            </span>
          </label>
        )}
      </div>
      <p className="text-[11px] text-gray-500">{XSIGNAL_DESC[signal]}</p>

      {/* 生存者バイアス診断(point-in-time) */}
      <div className={`rounded border p-2 text-[11px] ${result.survivorWarn ? "bg-amber-50 border-amber-300 text-amber-800" : "bg-gray-50 border-gray-200 text-gray-600"}`}>
        <b>在籍(point-in-time):</b> {result.spans.length}銘柄中 {result.nExtendToEnd}銘柄が終端まで生存。
        {result.survivorWarn
          ? " 全銘柄が現存 = 生存者バイアスの可能性。廃止・上場来消滅した銘柄を含めると横断エッジは弱まる方向に補正されます(各銘柄のデータ期間を在籍窓として尊重し、退場後は自動除外しています)。"
          : " データが途中で終わる銘柄は退場日以降ブックから自動除外(廃止銘柄を正しく扱えています)。"}
      </div>

      {/* 主要指標 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="IC(平均・順位相関)" value={num2(result.icMean)} tone={result.icMean > 0 ? "good" : "bad"} sub={`t=${num2(result.icT)}→実効${num2(result.icTEff)} / 的中${(result.hitRate * 100).toFixed(0)}%`} />
        <Stat label="実効ブレッドス(相関後)" value={`${result.breadthPerYearEff.toFixed(0)}`} sub={`素朴${result.breadthPerYear.toFixed(0)}→相関/時間で目減り`} />
        <Stat label="理論IR(相関ディスカウント後)" value={num2(result.irTheoreticalDiscounted)} tone="neutral" sub={`素朴 ${num2(result.irTheoretical)}`} />
        <Stat label="実現シャープ(ネット)" value={num2(result.sharpeRealizedNet)} tone={result.sharpeRealizedNet > 0.5 ? "good" : "neutral"} sub={`グロス ${num2(result.sharpeRealizedGross)}${result.realCost ? " / 楽天実コスト後" : ""}`} />
        <Stat label="年率リターン(ネット)" value={pct(result.annNet)} tone={result.annNet > 0 ? "good" : "bad"} sub={`グロス ${pct(result.annGross)}`} />
        <Stat label="最大DD" value={pct(result.maxDD)} tone="bad" />
        <Stat label="コスト分岐 vs スプレッド" value={`${isFinite(result.costBreakevenBps) ? result.costBreakevenBps.toFixed(1) : "—"} / ${result.medSpreadBps.toFixed(0)}bp`} tone={result.spreadSurvives ? "good" : "bad"} sub={result.spreadSurvives ? "スプレッド超で生存" : "スプレッドで消失"} />
        <Stat label="市場β(中立性)" value={num2(result.marketBeta)} tone={Math.abs(result.marketBeta) < 0.2 ? "good" : "bad"} sub={`回転 ${result.turnoverPerYear.toFixed(0)}回/年`} />
      </div>

      {/* IR ギャップの解釈 */}
      <div className={`rounded-lg border p-3 text-sm ${result.icT >= 2 && result.spreadSurvives ? "bg-green-50 border-green-300" : result.icT >= 2 ? "bg-amber-50 border-amber-300" : "bg-gray-50 border-gray-300"}`}>
        <span className="font-medium">読み方: </span>
        IC={num2(result.icMean)}(t={num2(result.icT)})。
        {result.icT >= 2
          ? "横断シグナルは統計的に有意です。"
          : "横断シグナルは有意水準に届いていません。"}
        {" "}基本法則の理論IR {num2(result.irTheoretical)} に対し実現シャープ(グロス) {num2(result.sharpeRealizedGross)}
        {Math.abs(irGap) < 0.3 ? "(ほぼ整合)" : irGap < 0 ? "(実現が下振れ=分散不足/相関/執行の摩擦)" : "(実現が上振れ=たまたま or 非独立ベット)"}。
        {" "}<span className="font-medium">
          {result.icT >= 2 && !result.spreadSurvives
            ? `だがコスト分岐 ${result.costBreakevenBps.toFixed(1)}bp < 代表スプレッド ${result.medSpreadBps.toFixed(0)}bp ── エッジは実在してもスプレッドで消えます。これが小型株の「エッジはあるが容量・コストの壁」の正体です。`
            : result.spreadSurvives
            ? `コスト分岐 ${result.costBreakevenBps.toFixed(1)}bp が代表スプレッド ${result.medSpreadBps.toFixed(0)}bp を上回り、執行コスト後も生き残る余地があります。`
            : `コスト分岐点は${isFinite(result.costBreakevenBps) ? `${result.costBreakevenBps.toFixed(1)}bp` : "—"}(代表スプレッド ${result.medSpreadBps.toFixed(0)}bp)。`}
        </span>
      </div>

      {/* Task1: 相関ディスカウントの内訳 */}
      <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-3 text-[11px] space-y-1">
        <div className="font-medium text-gray-700 text-xs">理論IRの相関ディスカウント（素朴なブレッドスの補正）</div>
        <p className="text-gray-600">
          基本法則の素朴な理論IR {num2(result.irTheoretical)} は「銘柄×リバランスを全部独立」と数える楽観値。
          実際は<b>同日は銘柄がまとめて動き(横断相関 ρ_xs={num2(result.rhoXs)})</b>、
          <b>シグナルが持続するとリバランスが重複する(時間実効率 {(result.temporalEff * 100).toFixed(0)}%)</b>ため、
          独立ベットは目減りします。
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-gray-700">
          <div>横断相関 ρ_xs <b>{num2(result.rhoXs)}</b><div className="text-gray-400">1リバラ実効 {result.kEffPerRebalance.toFixed(1)}/{result.avgBreadth.toFixed(0)}銘柄</div></div>
          <div>時間実効率 <b>{(result.temporalEff * 100).toFixed(0)}%</b><div className="text-gray-400">実効独立リバラ {result.essRebalances.toFixed(0)}/{result.nPeriods}</div></div>
          <div>年間独立ベット <b>{result.breadthPerYearEff.toFixed(0)}</b><div className="text-gray-400">素朴 {result.breadthPerYear.toFixed(0)} から</div></div>
          <div>理論IR <b className="text-gray-900">{num2(result.irTheoretical)}→{num2(result.irTheoreticalDiscounted)}</b><div className="text-gray-400">実現グロス {num2(result.sharpeRealizedGross)}</div></div>
        </div>
        <p className="text-gray-500">
          ディスカウント後の理論IR {num2(result.irTheoreticalDiscounted)} が実現グロス {num2(result.sharpeRealizedGross)} に近いほど、
          「基本法則が実際に効いている(=独立ベットの数を正直に数えれば説明できる)」ことを意味します。
          {result.params.signal === "momentum" && " モメンタムはシグナルが遅く、リバランス重複で時間実効率が大きく落ちます。"}
        </p>
      </div>

      {/* Task2: 楽天実コストの内訳 */}
      {result.realCost && (
        <div className={`rounded-lg border p-3 text-sm space-y-2 ${result.realCostSurvives ? "bg-green-50 border-green-300" : "bg-red-50 border-red-300"}`}>
          <div className="flex items-center justify-between flex-wrap gap-1">
            <span className="font-medium text-gray-800">楽天証券・実コスト検証（{MARGIN_KIND_LABEL[result.marginKind]}）</span>
            <span className={`text-xs font-bold ${result.realCostSurvives ? "text-green-700" : "text-red-700"}`}>
              {result.realCostSurvives ? "実コスト後も生存" : "実コストで消失"}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Stat label="スプレッド往復(微細構造)" value={`−${(result.spreadDragAnnual * 100).toFixed(1)}%`} tone="bad" sub="bid-askバウンス/年" />
            <Stat label="金利+貸株料" value={`−${(result.financeDragAnnual * 100).toFixed(1)}%`} tone="bad" sub="買方金利+貸株料/年" />
            <Stat label="諸経費" value={`−${(result.otherDragAnnual * 100).toFixed(2)}%`} tone="neutral" sub="事務管理+名義書換/年" />
            <Stat label="実コスト後 年率" value={pct(result.annNetReal)} tone={result.annNetReal > 0 ? "good" : "bad"} sub={`グロス ${pct(result.annGross)}`} />
          </div>
          <p className="text-[11px] text-gray-600">
            グロス年率 {pct(result.annGross)} から実コスト合計 <b>−{(result.totalDragAnnual * 100).toFixed(1)}%/年</b> を引くと
            <b className={result.annNetReal > 0 ? "text-green-700" : "text-red-700"}> {pct(result.annNetReal)}</b>
            （実コスト後シャープ {num2(result.sharpeRealizedNetReal)}）。
            {" "}最大の殺し手は<b>スプレッド往復（−{(result.spreadDragAnnual * 100).toFixed(1)}%）</b>で、これは
            「終値で建てられず bid-ask を跨ぐ」という短期リバーサルの微細構造そのもの。回転
            {result.turnoverPerYear.toFixed(0)}回/年 × 代表スプレッド{result.medSpreadBps.toFixed(0)}bp が効いています。
            {result.marginKind === "ichinichi" && " ※いちにち信用は金利0だが日計り限定(翌日持ち越し不可)なので、終値→翌終値の本戦略には本来使えません(下限の目安として表示)。"}
          </p>
        </div>
      )}

      {/* エクイティ */}
      <div>
        <div className="text-xs text-gray-500 mb-1">
          市場中立ブックの累積リターン（灰=グロス / 青=ネット{result.realCost ? "・楽天実コスト" : `・フラット${costBps}bp`}, ホイールでズーム）— {result.from}〜{result.to} / {result.years.toFixed(1)}年 / {result.nPeriods}リバランス
        </div>
        <div ref={containerRef} className="w-full" />
      </div>

      {/* 在籍テーブル */}
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-500">銘柄別 在籍期間(point-in-time)</summary>
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 px-1.5">銘柄</th>
                <th className="text-left px-1.5">在籍開始</th>
                <th className="text-left px-1.5">在籍終了</th>
                <th className="text-right px-1.5">本数</th>
                <th className="text-center px-1.5">終端生存</th>
              </tr>
            </thead>
            <tbody>
              {result.spans.map((sp) => (
                <tr key={sp.ticker} className="border-b border-gray-100">
                  <td className="py-1 px-1.5">{sp.name}<span className="text-gray-400 ml-1">{sp.ticker}</span></td>
                  <td className="px-1.5 font-mono text-gray-600">{sp.from}</td>
                  <td className="px-1.5 font-mono text-gray-600">{sp.to}</td>
                  <td className="text-right px-1.5 font-mono">{sp.nBars}</td>
                  <td className="text-center px-1.5">{sp.extendsToEnd ? "✓" : <span className="text-amber-600">退場</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <AnalysisGuide title="クロスセクション・ロングショートの詳細理論">
        <p className="font-medium text-gray-700">1. なぜ横断なのか(小エッジの棲息域)</p>
        <p>
          単一銘柄・時間軸のエッジは、同時ベット数(breadth)が実質1しかありません。運用の基本法則
          <span className="font-medium"> IR = IC·√BR</span>(情報比 = 情報係数 × 独立ベット数の平方根)より、
          breadth=1ではどんなに時間をかけても情報比は上がらず、本当に小さいエッジは検出も運用もできません
          (「検出力の壁」参照)。そこで毎日ユニバース全体を横断ランクし、多数の銘柄に同時に小さく賭ける。
          1本1本の的中率(IC)は0.02〜0.05でも、数十〜数百の独立ベットを束ねれば意味のある情報比になります。
          これがルネサンス/スタットアーブ流の「容量制限付きの小さなエッジ」の実像です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"各リバランス日 t に各銘柄のシグナル s_i(t) を因果的に計算(t日終値までの情報のみ)。"}</li>
          <li>{"横断ランクで上位qをロング・下位qをショート。等加重・ダラー中立: Σw_long = +L/2, Σw_short = −L/2(Lは総エクスポージャ)。"}</li>
          <li>{"ブック期リターン = Σ_i w_i·r_i(t→t+h)。"}</li>
          <li>{"IC = Spearman( s_i(t), r_i(t→t+h) ) を銘柄横断で計算。IC の t 値 = mean(IC)/std(IC)·√(期数)。"}</li>
          <li>{"素朴な理論IR = mean(IC)·√(年あたり独立ベット数 BR)、BR ≈ 平均採用銘柄数 × 年間リバランス回数。"}</li>
          <li>{"コスト分岐点 c* : mean(期リターン) − c*·2·mean(片道回転) = 0 を解いた片道コスト。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">2.5 理論IRの相関ディスカウント（重要）</p>
        <p>
          素朴な BR は「銘柄×リバランスを全部独立」と数えるため楽観的です。独立ベット数は2方向で目減りします。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"横断(同日クラスタ): 同じ日は銘柄がまとめて動く。残差相関 ρ_xs(=対等加重ファクターを引いた残差の平均ペア相関)を使い、1リバランスの実効ベット数を k_eff = k/(1+(k−1)ρ_xs) に縮める。ダラー中立ブックは共通ファクターをヘッジ済みなので ρ_xs は小さめ。"}</li>
          <li>{"時間(リバランス重複): シグナルが持続すると連続するリバランスの建玉が重なり、独立な期数が減る。ブック期リターンの自己相関から実効独立リバランス数 ess = nPeriods/(1+2Σ w_k ρ_k)(Bartlett加重)を求め、時間実効率 = ess/nPeriods とする。モメンタムのように遅いシグナルほど大きく落ちる。"}</li>
          <li>{"誠実な理論IR = mean(IC)·√(k_eff × ess独立リバランス/年)。ICの t 値も ess で目減りさせた実効t=IC情報比·√ess を併記。"}</li>
        </ul>
        <p>これは他分析の「実効標本 nEff」と同じ規律で、他所で横断相関を割り引いているのに理論IRだけ素朴、という不整合を正すものです。</p>

        <p className="font-medium text-gray-700 mt-3">2.6 楽天証券・実コスト検証（微細構造）</p>
        <p>
          「片道◯bp」の抽象コストではなく、楽天証券の実レートで検証します(単一ソース rakuten-margin.ts)。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"スプレッド往復(微細構造の本体): 終値プリントでは約定できず bid-ask を跨ぐため、片道で半スプレッドを払う。期コスト = Σ|Δw| × 半スプレッド = 2·回転·(medSpread/2)。短期リバーサルの見かけ益の多くはこの bid-ask バウンスで、実際には獲れない。"}</li>
          <li>{"信用金利+貸株料: 買建に買方金利(制度2.80%)、売建に貸株料(1.10%)。ダラー中立(半分ずつ)なら年率 ≒ 0.5·2.80% + 0.5·1.10% = 1.95%。保有日数ぶん日割りで控除。"}</li>
          <li>{"諸経費: 事務管理費(0.11円/株/月・建玉notional)+ 名義書換料(買建・権利日跨ぎ)。低位株ほど相対負担が重い。"}</li>
          <li>{"いちにち信用は金利0だが日計り限定で翌日持ち越し不可。終値→翌終値の本戦略には本来使えない(0コストの下限目安)。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 実装したシグナル</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">短期リバーサル:</span> 前日/5日の相対負け組を買い勝ち組を売る。最も頑健だが回転が速く容量が小さい古典的小エッジ。</li>
          <li><span className="font-medium">クロスセクション・モメンタム:</span> 12-1月の相対勝ち組を買う。中期の持続。</li>
          <li><span className="font-medium">低ボラ:</span> 直近実現ボラの低い銘柄を買う。低ボラ・アノマリー。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. point-in-time と生存者バイアス(#5)</p>
        <p>
          各銘柄の在籍期間(既定=データが存在する期間)を窓として尊重し、上場前・退場後はブックに含めません。
          <span className="font-medium">廃止された銘柄をユニバースに含めれば、その退場日以降は自動的に外れ、生存者バイアスを避けられます</span>。
          全銘柄が現在まで生きている場合は警告を出します──「勝ち残った銘柄だけ」で測った横断エッジは実際より強く見えるためです。
          正しい検証には、当時のユニバース構成(時点構成メンバー)と廃止銘柄が要ります。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方・活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">IC の t 値 ≥ 2</span> で横断シグナルは有意。単名のエッジ検定より遥かに検出力が高い(breadthのおかげ)。</li>
          <li><span className="font-medium">理論IR vs 実現シャープ</span>: 大きく乖離するなら、ベットが独立でない(全銘柄が同じ因子で動く)か、執行摩擦で削れている。</li>
          <li><span className="font-medium">市場β ≈ 0</span> を確認。中立でなければ、成績は横断エッジでなく市場の方向で説明できてしまう。</li>
          <li><span className="font-medium">コスト分岐点</span>が現実の手数料+スプレッドより低いなら、そのシグナルは紙上のエッジ。回転を落とす(週次/月次)か低回転シグナルへ。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">メガキャップ vs 小型:</span> 大型は裁定が効きエッジ(IC)が小さいが、スプレッドが薄くコスト後も残りやすい。小型は裁定が緩くICが大きく出やすいが、スプレッド・容量の壁が厳しく「コスト分岐 &lt; スプレッド」でエッジが消えることが多い。さらに<span className="font-medium">小型ほど生存者バイアスが深刻</span>(消えた敗者が現構成リストに無い)なので、現構成での高ICは割り引いて見ること。真の検証には廃止銘柄を含む時点構成メンバーが要ります。</li>
          <li>ウォッチリストは少数(数〜数十銘柄)で、真のクロスセクション(数百〜千)より breadth が小さく検出力も限定的です。銘柄を増やすほど IC の t 値は上がります。</li>
          <li>ショートには貸株料・逆日歩・規制があり(rakuten-margin参照)、ここでは片道コストの往復近似のみ。実務のショートコストは別途重い。</li>
          <li>容量: リバーサル系は回転が速く、平方根インパクトで容量が小さい。個別の容量は単名の「エッジ容量推定」を各脚に当てて概算してください。</li>
          <li>生存者バイアスの完全な排除には時点構成メンバーと廃止銘柄データが必要で、現状はユーザーが供給した銘柄群のデータ期間で近似しています。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
