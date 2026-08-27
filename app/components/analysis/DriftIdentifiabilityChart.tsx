"use client";

import { DirectionGlyph } from "./DirectionValue";

// 個別銘柄のドリフトは同定できるか（μ の識別限界）── 系C26。
//
// C25（特性ソート・ポートフォリオ）の手前に残る問い「ドリフトの高い個別銘柄を選べばよいのでは？」
// に正面から答える。SE(μ̂)=σ/√T は頻度では縮まず、N 銘柄から最大を選べば真のμが同一でも
// 勝者は SE·√(2 ln N) だけ上振れて見える。既定の結論は「同定不能」。

import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, LineSeries, type IChartApi, type Time } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeDriftIdentifiability,
  DEFAULT_DRIFT_ID_PARAMS,
  requiredYears,
  type DriftIdParams,
  type DriftIdResult,
} from "../../lib/drift-identifiability";
import { UNIVERSES, getUniverse } from "../../lib/universes";
import { fetchUniverse, parseTickerList } from "../../lib/universe-fetch";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";
import { CHART_COLORS } from "../../lib/chart-colors";

interface Props {
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
}

type UniverseMode = "watchlist" | "paste" | string;

const pct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
const pctAbs = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const num2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : "∞");
const yearsFmt = (v: number) =>
  !Number.isFinite(v) ? "∞" : v >= 10000 ? `${(v / 1000).toFixed(0)}千年` : v >= 100 ? `${Math.round(v)}年` : `${v.toFixed(1)}年`;

function Stat({
  label, value, tone, sub, directionValue,
}: { label: string; value: string; tone?: "good" | "bad" | "neutral"; sub?: string; directionValue?: number }) {
  const c = tone === "good" ? "text-green-700" : tone === "bad" ? "text-red-700" : "text-gray-800";
  return (
    <div className="rounded border border-gray-200 px-2.5 py-1.5">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-sm font-bold font-mono ${c}`}>{directionValue !== undefined && <DirectionGlyph value={directionValue} />}{value}</div>
      {sub && <div className="text-[10px] text-fg-muted">{sub}</div>}
    </div>
  );
}

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

export default function DriftIdentifiabilityChart({ tickers, pricesByTicker, names }: Props) {
  const [kappa, setKappa] = useState(DEFAULT_DRIFT_ID_PARAMS.kappa);
  const [targetExcess, setTargetExcess] = useState(DEFAULT_DRIFT_ID_PARAMS.targetExcess);
  const [lookbackYears, setLookbackYears] = useState(DEFAULT_DRIFT_ID_PARAMS.lookbackYears);
  const [rebalanceDays, setRebalanceDays] = useState(DEFAULT_DRIFT_ID_PARAMS.rebalanceDays);
  const [quantile, setQuantile] = useState(DEFAULT_DRIFT_ID_PARAMS.quantile);
  const [costBps, setCostBps] = useState(DEFAULT_DRIFT_ID_PARAMS.costBps);

  const [uniMode, setUniMode] = useState<UniverseMode>("watchlist");
  const [pasteRaw, setPasteRaw] = useState("");
  const [pasteTickers, setPasteTickers] = useState<string[]>([]);
  const [fetched, setFetched] = useState<{ prices: Record<string, PricePoint[]>; names: Record<string, string> }>({ prices: {}, names: {} });
  const [fetching, setFetching] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [freqTicker, setFreqTicker] = useState<string>("__MKT__");

  const uniTickers = useMemo<string[]>(() => {
    if (uniMode === "watchlist") return tickers;
    if (uniMode === "paste") return pasteTickers;
    return getUniverse(uniMode)?.tickers.map((t) => t.ticker) ?? [];
  }, [uniMode, tickers, pasteTickers]);

  useEffect(() => {
    if (uniMode === "watchlist" || uniTickers.length === 0) return;
    const ctrl = new AbortController();
    const load = async () => {
      setFetching(true);
      setProgress({ done: 0, total: uniTickers.length });
      try {
        const res = await fetchUniverse(uniTickers, (done, total) => setProgress({ done, total }), ctrl.signal);
        if (ctrl.signal.aborted) return;
        const prices: Record<string, PricePoint[]> = {};
        const nm: Record<string, string> = {};
        const preset = getUniverse(uniMode);
        for (const [tk, v] of Object.entries(res)) {
          if (v.prices.length > 0) { prices[tk] = v.prices; nm[tk] = v.name; }
        }
        if (preset) for (const t of preset.tickers) if (!nm[t.ticker]) nm[t.ticker] = t.name;
        setFetched({ prices, names: nm });
      } finally {
        if (!ctrl.signal.aborted) setFetching(false);
      }
    };
    load();
    return () => ctrl.abort();
  }, [uniMode, uniTickers]);

  const activePrices = useMemo<Record<string, PricePoint[]>>(
    () =>
      uniMode === "watchlist"
        ? pricesByTicker
        : uniMode === "paste" && pasteTickers.length === 0
          ? {}
          : fetched.prices,
    [uniMode, pricesByTicker, pasteTickers, fetched.prices]
  );
  const activeNames = uniMode === "watchlist" ? (names ?? {}) : fetched.names;
  const activeCount = Object.keys(activePrices).length;

  const result = useMemo<DriftIdResult | null>(() => {
    if (activeCount < 3) return null;
    const params: DriftIdParams = {
      ...DEFAULT_DRIFT_ID_PARAMS,
      kappa,
      targetExcess,
      lookbackYears,
      rebalanceDays,
      quantile,
      costBps,
    };
    return computeDriftIdentifiability(activePrices, params);
  }, [activeCount, activePrices, kappa, targetExcess, lookbackYears, rebalanceDays, quantile, costBps]);

  // ── winner's curse のヌル分布（横軸=年率ドリフト・時間軸でないので Canvas2D）
  const histCanvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = histCanvas.current;
    if (!cv || !result || !result.ok || result.winner.hist.length === 0) return;
    const draw = () => {
      const init = initCanvas(cv, 190);
      if (!init) return;
      const { ctx, width, height } = init;
      const padL = 40, padR = 14, padT = 14, padB = 28;
      const w = width - padL - padR;
      const h = height - padT - padB;
      const hist = result.winner.hist;
      const obs = result.winner.topLeadObserved;
      const xLo = Math.min(hist[0].binLo, obs);
      const xHi = Math.max(hist[hist.length - 1].binHi, obs);
      const span = xHi - xLo || 1;
      const maxC = Math.max(...hist.map((b) => b.count)) || 1;
      const X = (v: number) => padL + ((v - xLo) / span) * w;
      const Y = (c: number) => padT + h - (c / maxC) * h;

      ctx.strokeStyle = "#e5e7eb";
      ctx.beginPath();
      ctx.moveTo(padL, padT + h);
      ctx.lineTo(padL + w, padT + h);
      ctx.stroke();

      for (const b of hist) {
        const x0 = X(b.binLo);
        const x1 = X(b.binHi);
        ctx.fillStyle = "#cbd5e1";
        ctx.fillRect(x0, Y(b.count), Math.max(1, x1 - x0 - 1), padT + h - Y(b.count));
      }
      // 95分位
      const q95 = result.winner.topLeadNull95;
      ctx.strokeStyle = "#f59e0b";
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(X(q95), padT);
      ctx.lineTo(X(q95), padT + h);
      ctx.stroke();
      ctx.setLineDash([]);
      // 観測
      ctx.strokeStyle = "#dc2626";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(X(obs), padT);
      ctx.lineTo(X(obs), padT + h);
      ctx.stroke();
      ctx.lineWidth = 1;

      ctx.fillStyle = "#6b7280";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      for (let k = 0; k <= 4; k++) {
        const v = xLo + (span * k) / 4;
        ctx.fillText(pct(v, 0), X(v), padT + h + 14);
      }
      ctx.textAlign = "left";
      ctx.fillStyle = "#dc2626";
      ctx.fillText(`観測 ${pct(obs)}`, Math.min(X(obs) + 4, width - 90), padT + 10);
      ctx.fillStyle = "#f59e0b";
      ctx.fillText("ヌル95%", Math.min(X(q95) + 4, width - 60), padT + 24);
      ctx.fillStyle = "#6b7280";
      ctx.fillText("頻度", 6, padT + 8);
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [result]);

  // ── 前向き検証の資産曲線（横軸=時間 → lightweight-charts）
  const wfContainer = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = wfContainer.current;
    if (!el || !result || !result.ok || !result.wf) return;
    const chart: IChartApi = createChart(el, {
      width: el.clientWidth,
      height: 240,
      layout: { background: { color: "#ffffff" }, textColor: "#374151" },
      grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
      rightPriceScale: { mode: 1, borderColor: "#e5e7eb" },
      timeScale: { borderColor: "#e5e7eb" },
    });
    const floor = chart.addSeries(LineSeries, { color: CHART_COLORS.neutral, lineWidth: 2, priceLineVisible: false });
    floor.setData(result.wf.equityFloor.map((p) => ({ time: p.time as Time, value: p.value })));
    const tilt = chart.addSeries(LineSeries, {
      color: result.wf.passes ? "#16a34a" : "#2563eb", lineWidth: 2, priceLineVisible: false,
    });
    tilt.setData(result.wf.equityTilt.map((p) => ({ time: p.time as Time, value: p.value })));
    chart.timeScale().fitContent();
    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); };
  }, [result]);

  const ladder = result?.freqLadders[freqTicker] ?? result?.freqLadders["__MKT__"] ?? [];
  const w = result?.winner;
  const sh = result?.shrink;

  return (
    <div className="space-y-4">
      {/* ユニバース */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-gray-500">
          ユニバース
          <select value={uniMode} onChange={(e) => setUniMode(e.target.value)}
            className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm">
            <option value="watchlist">ウォッチリスト（{tickers.length}銘柄）</option>
            {UNIVERSES.map((u) => (<option key={u.id} value={u.id}>{u.label}</option>))}
            <option value="paste">貼り付け</option>
          </select>
        </label>
        {uniMode === "paste" && (
          <div className="flex items-end gap-1">
            <textarea value={pasteRaw} onChange={(e) => setPasteRaw(e.target.value)}
              placeholder="7203 6758 9984 ..."
              className="px-2 py-1 border border-gray-300 rounded text-xs w-52 h-9 resize-none" />
            <button onClick={() => setPasteTickers(parseTickerList(pasteRaw))}
              className="px-2 py-1.5 bg-gray-700 text-white rounded text-xs hover:bg-gray-600">読込</button>
          </div>
        )}
        {fetching && <span className="text-xs text-fg-muted">取得中… {progress.done}/{progress.total}</span>}
      </div>

      {/* パラメータ */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-gray-500">
          t ハードル κ（C16）
          <input type="number" value={kappa} step="0.5" onChange={(e) => setKappa(parseFloat(e.target.value) || 0)}
            className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm w-20 tabular-nums" />
        </label>
        <label className="flex flex-col text-xs text-gray-500">
          検出したい超過Δμ（年率）
          <select value={targetExcess} onChange={(e) => setTargetExcess(parseFloat(e.target.value))}
            className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm">
            <option value={0.02}>+2pp</option>
            <option value={0.05}>+5pp</option>
            <option value={0.1}>+10pp</option>
            <option value={0.2}>+20pp</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-gray-500">
          前向き検証の推定窓
          <select value={lookbackYears} onChange={(e) => setLookbackYears(parseFloat(e.target.value))}
            className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm">
            <option value={1}>過去1年</option>
            <option value={2}>過去2年</option>
            <option value={3}>過去3年</option>
            <option value={5}>過去5年</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-gray-500">
          リバランス
          <select value={rebalanceDays} onChange={(e) => setRebalanceDays(parseInt(e.target.value))}
            className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm">
            <option value={21}>月次(21日)</option>
            <option value={63}>四半期(63日)</option>
            <option value={126}>半年(126日)</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-gray-500">
          上位分位
          <select value={quantile} onChange={(e) => setQuantile(parseFloat(e.target.value))}
            className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm">
            <option value={0.2}>上位20%</option>
            <option value={0.3}>上位30%</option>
            <option value={0.5}>上位50%</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-gray-500">
          片道コスト(bp)
          <input type="number" value={costBps} step="5" onChange={(e) => setCostBps(parseFloat(e.target.value) || 0)}
            className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm w-20 tabular-nums" />
        </label>
      </div>

      {activeCount < 3 && (
        <div className="py-8 text-center text-fg-muted text-sm">
          識別限界の測定には最低3銘柄が必要です。ユニバースを大型30などに切り替えてください。
        </div>
      )}
      {result && !result.ok && <div className="text-sm text-amber-600">{result.reason}</div>}

      {result && result.ok && w && sh && (
        <>
          {/* 判定 */}
          <div
            className={`rounded-lg px-3 py-2.5 border ${
              result.verdict.identifiableCount === 0
                ? "bg-red-50 border-red-200"
                : "bg-green-50 border-green-200"
            }`}
          >
            <div className="text-sm font-bold text-gray-800">
              {result.verdict.identifiableCount === 0
                ? "判定：個別銘柄のドリフトは同定不能"
                : `判定：${result.verdict.identifiableCount}銘柄が識別可能（|t|>${result.kappa} かつ FDR q<0.1）`}
            </div>
            <p className="mt-1 text-[11px] text-gray-600 leading-relaxed">
              観測期間 <b>{result.panel.years.toFixed(1)}年</b>・{result.panel.nTickers}銘柄。
              市場（等加重）に対する超過ドリフト Δμ を |t|&gt;{result.kappa} で拾えた銘柄は
              <b>{result.verdict.identifiableCount}/{result.panel.nTickers}</b>。
              目標 Δμ=+{(result.targetExcess * 100).toFixed(0)}pp を検出するのに必要な年数は中央値
              <b> {yearsFmt(result.verdict.medianRequiredYears)}</b>（検出力が足りている銘柄は
              {result.verdict.poweredCount}/{result.panel.nTickers}）。
              {result.verdict.identifiableCount === 0 &&
                "「ドリフトの高い銘柄を選ぶ」は、この期間の価格データからは実行できない。"}
            </p>
          </div>

          {/* 概況 */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <Stat label="パネル" value={`${result.panel.nTickers}銘柄`} sub={`${result.panel.from}〜${result.panel.to}`} />
            <Stat label="床（等加重）μ" value={pct(result.market.muLog)} sub={`t=${num2(result.market.tMu)} / σ=${pctAbs(result.market.sigma)}`} />
            <Stat label="平均 SE(μ̂)" value={`±${pctAbs(sh.meanSe)}`} tone="bad" sub="σ/√T。頻度では縮まない" />
            <Stat
              label="μ̂ の見かけの散らばり"
              value={pctAbs(w.spreadObserved)}
              sub={`ヌルでも ${pctAbs(w.spreadNullMean)} 出る`}
            />
            <Stat
              label="勝者の上振れ（ノイズ分）"
              value={pctAbs(w.topLeadNullMean)}
              tone="bad"
              sub={`理論 SE·√(2lnN)=${pctAbs(w.theoryApprox)}`}
            />
            <Stat
              label="終端まで生存"
              value={`${result.survivorsToEnd}/${result.panel.nTickers}`}
              tone={result.survivorsToEnd / result.panel.nTickers > 0.9 ? "bad" : "neutral"}
              sub={result.panel.dropped.length ? `除外${result.panel.dropped.length}銘柄` : "point-in-time"}
            />
          </div>

          {/* L1: 銘柄別ドリフト表 */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1.5">
              ① 銘柄別ドリフト（μ̂ 降順）── ランキングは出るが、95%CI と必要年数を見る
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 pr-2">銘柄</th>
                    <th className="text-right px-2">μ̂(対数)</th>
                    <th className="text-right px-2">σ̂</th>
                    <th className="text-right px-2">SE(μ̂)</th>
                    <th className="text-right px-2">μ̂の95%CI</th>
                    <th className="text-right px-2">超過Δμ</th>
                    <th className="text-right px-2">t(Δμ)</th>
                    <th className="text-right px-2">FDR q</th>
                    <th className="text-right px-2">必要年数T*</th>
                    <th className="text-right px-2">α(t)</th>
                    <th className="text-right px-2">順位95%CI</th>
                    <th className="text-center px-2">判定</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr
                      key={r.ticker}
                      onClick={() => setFreqTicker(r.ticker)}
                      className={`border-b border-gray-100 cursor-pointer hover:bg-blue-50/40 ${
                        freqTicker === r.ticker ? "bg-blue-50/60" : ""
                      }`}
                    >
                      <td className="text-left py-1 pr-2 font-medium text-gray-700">
                        {activeNames[r.ticker] ?? r.ticker}
                        <span className="ml-1 text-[10px] text-fg-muted">{r.ticker}</span>
                      </td>
                      <td className="text-right px-2 tabular-nums font-semibold">{pct(r.muLog)}</td>
                      <td className="text-right px-2 tabular-nums text-gray-500">{pctAbs(r.sigma)}</td>
                      <td className="text-right px-2 tabular-nums text-red-600">±{pctAbs(r.seMu)}</td>
                      <td className="text-right px-2 tabular-nums text-gray-500 whitespace-nowrap">
                        [{pct(r.ciMuLo, 0)}, {pct(r.ciMuHi, 0)}]
                      </td>
                      <td className={`text-right px-2 tabular-nums ${r.excessMu > 0 ? "text-green-700" : "text-red-600"}`}>
                        <DirectionGlyph value={r.excessMu} />{pct(r.excessMu)}
                      </td>
                      <td className="text-right px-2 tabular-nums">{num2(r.tExcess)}</td>
                      <td className={`text-right px-2 tabular-nums ${r.qExcess < 0.1 ? "text-green-700" : "text-fg-muted"}`}>
                        {r.qExcess.toFixed(3)}
                      </td>
                      <td className="text-right px-2 tabular-nums text-amber-700">{yearsFmt(r.requiredYearsObserved)}</td>
                      <td className="text-right px-2 tabular-nums text-gray-500">
                        {pct(r.alpha, 0)} ({num2(r.tAlpha)})
                      </td>
                      <td className="text-right px-2 tabular-nums text-gray-500">
                        {r.rankLo}–{r.rankHi}
                        <span className="ml-1 text-[10px] text-fg-muted">({(r.pRankTop * 100).toFixed(0)}%)</span>
                      </td>
                      <td className="text-center px-2">
                        {r.identifiable ? (
                          <span className="text-green-700 font-semibold">識別可</span>
                        ) : (
                          <span className="text-fg-muted">誤差内</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[11px] text-gray-500">
              <b>必要年数 T* = (κ·σ_ex/Δμ)²</b> はその銘柄の観測 Δμ を |t|&gt;{result.kappa} にするのに要る年数。
              観測期間 {result.panel.years.toFixed(1)}年 を超えていれば、その順位は誤差の産物。
              <b>順位95%CI</b> はブート再標本での順位範囲、括弧内は1位になる確率。
              行クリックで③の頻度ラダーが切り替わる。
            </p>
          </div>

          {/* L2: winner's curse */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1.5">
              ② 勝者の呪い ── 「真のドリフトが全銘柄同じ」というヌルでも、トップはこれだけ抜けて見える
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
              <Stat label="観測: トップ − 平均" value={pct(w.topLeadObserved)} />
              <Stat label="ヌルの平均" value={pct(w.topLeadNullMean)} tone="bad" sub="全員同じμでもこれだけ出る" />
              <Stat label="ヌル片側p" value={w.pTopLead.toFixed(3)} tone={w.pTopLead < 0.05 ? "good" : "bad"}
                sub={w.pTopLead < 0.05 ? "ヌルを超えている" : "ヌルの中＝差は無い"} />
              <Stat label="トップのノイズ割合" value={`${(w.noiseShare * 100).toFixed(0)}%`} tone="bad"
                sub="見かけのリードのうち誤差で説明される分" />
            </div>
            <div className="w-full">
              <canvas ref={histCanvas} />
            </div>
            <p className="mt-1.5 text-[11px] text-gray-500">
              ヌルは各銘柄の平均を差し引いた（＝真の μ を全銘柄同一にした）リターン行列の移動ブロック再標本（
              ブロック{DEFAULT_DRIFT_ID_PARAMS.blockDays}日・{w.nBoot}回・日付は全銘柄共通に抽出するので横断相関は保存）。
              灰=ヌル分布／橙破線=ヌル95%／赤=観測。赤が灰の山の中にあるなら、
              <b>「一番上がった銘柄」は実力ではなく順位付けの副産物</b>。
              観測スプレッド（最大−最小）{pctAbs(w.spreadObserved)} に対しヌルは平均{pctAbs(w.spreadNullMean)}・
              95%点{pctAbs(w.spreadNull95)}（片側p={w.pSpread.toFixed(3)}）。
            </p>
          </div>

          {/* L3: Merton の非対称性 */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1.5">
              ③ Merton の非対称性 ── データを細かくしても μ の精度は1ミリも上がらない
              <span className="ml-2 font-normal text-fg-muted">
                対象: {freqTicker === "__MKT__" ? "市場（等加重）" : (activeNames[freqTicker] ?? freqTicker)}
              </span>
              <button
                onClick={() => setFreqTicker("__MKT__")}
                className="ml-2 px-1.5 py-0.5 border border-gray-300 rounded text-[10px] text-gray-500 hover:bg-gray-50 font-normal"
              >
                市場に戻す
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 pr-2">サンプリング頻度</th>
                    <th className="text-right px-2">観測数 n</th>
                    <th className="text-right px-2">μ̂（年率）</th>
                    <th className="text-right px-2">SE(μ̂)</th>
                    <th className="text-right px-2">σ̂（年率）</th>
                    <th className="text-right px-2">SE(σ̂)</th>
                  </tr>
                </thead>
                <tbody>
                  {ladder.map((f) => (
                    <tr key={f.days} className="border-b border-gray-100">
                      <td className="text-left py-1 pr-2 text-gray-700">{f.label}</td>
                      <td className="text-right px-2 tabular-nums text-gray-500">{f.nObs}</td>
                      <td className="text-right px-2 tabular-nums font-semibold">{pct(f.muAnn)}</td>
                      <td className="text-right px-2 tabular-nums text-red-600">±{pctAbs(f.seMuAnn)}</td>
                      <td className="text-right px-2 tabular-nums">{pctAbs(f.sigmaAnn)}</td>
                      <td className="text-right px-2 tabular-nums text-green-700">±{pctAbs(f.seSigmaAnn, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[11px] text-gray-500">
              <b>μ̂ の列はほぼ動かない</b>（対数リターンの標本平均は μ̂=log(P_T/P_0)/T ＝両端の2点しか使わない恒等式。
              集計単位の端数を捨てる分しか差が出ない）。SE(μ̂)=σ/√T も同じ。一方
              <b>SE(σ̂)≈σ/√(2n) は観測数 n に比例して縮む</b>（日次→四半期で {ladder.length >= 4 && ladder[0].seSigmaAnn > 0
                ? `約${(ladder[3].seSigmaAnn / ladder[0].seSigmaAnn).toFixed(1)}倍に悪化`
                : "悪化"}）。
              日中足・分足へ進めても、この非対称性は同じ向きに続く。
              <b>σ は測れる、μ は測れない</b>──これが C5/C6（ボラでサイジング）が効いて
              「ドリフト当て」が効かない理由。
            </p>
          </div>

          {/* L4: 収縮 */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1.5">
              ④ 見かけの差のうち、何割が本物か（James-Stein 収縮）
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="残存比率 c" value={sh.c.toFixed(3)} tone={sh.c < 0.2 ? "bad" : "neutral"}
                sub={`ノイズ ${((1 - sh.c) * 100).toFixed(0)}%`} />
              <Stat label="収縮前スプレッド" value={pctAbs(sh.spreadBefore)} sub="μ̂ 最大−最小" />
              <Stat label="収縮後スプレッド" value={pctAbs(sh.spreadAfter)} tone="bad" sub="c を掛けた残り" />
              <Stat label="順位のブート Spearman" value={sh.rankSpearman.toFixed(2)}
                tone={sh.rankSpearman < 0.5 ? "bad" : "neutral"} sub="1に近いほど順位が安定" />
            </div>
            <div className="mt-2 space-y-1">
              {result.rows.map((r) => {
                const lo = Math.min(...result.rows.map((x) => Math.min(x.muLog, x.muShrunk)));
                const hi = Math.max(...result.rows.map((x) => Math.max(x.muLog, x.muShrunk)));
                const span = hi - lo || 1;
                const xr = ((r.muLog - lo) / span) * 100;
                const xs = ((r.muShrunk - lo) / span) * 100;
                return (
                  <div key={r.ticker} className="flex items-center gap-2">
                    <div className="w-24 shrink-0 text-[10px] text-gray-500 truncate">
                      {activeNames[r.ticker] ?? r.ticker}
                    </div>
                    <div className="relative flex-1 h-3 bg-gray-100 rounded">
                      <div className="absolute top-0 h-3 w-[2px] bg-gray-400" style={{ left: `${xr}%` }} title={`μ̂ ${pct(r.muLog)}`} />
                      <div className="absolute top-0 h-3 w-[2px] bg-indigo-600" style={{ left: `${xs}%` }} title={`収縮後 ${pct(r.muShrunk)}`} />
                    </div>
                    <div className="w-28 shrink-0 text-right text-[10px] tabular-nums text-gray-500">
                      {pct(r.muLog, 0)} → <span className="text-indigo-700">{pct(r.muShrunk, 0)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-gray-500">
              灰=観測 μ̂／藍=収縮後。c = max(0, 1 − (N−3)·s̄²/Σ(μ̂−μ̄)²) は「散らばりのうち推定誤差でない分」。
              c が 0 に近いなら、<b>最良の推定は「全銘柄が同じドリフト」</b>＝順位に意味は無い。
              James-Stein は共通因子で縮めるので順位そのものは保つが、順位の<b>安定性</b>は右上の
              Spearman と①の順位95%CI で見る。
            </p>
          </div>

          {/* L5: 前向き検証 */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1.5">
              ⑤ 前向き検証 ──「過去{lookbackYears}年のドリフト上位」を実際に買い続けたら床に勝てたか
            </div>
            {result.wf ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-2">
                  <Stat label="チルト年率" value={pct(result.wf.annTilt)} />
                  <Stat label="床（等加重）年率" value={pct(result.wf.annFloor)} />
                  <Stat label="床の底上げΔμ" value={pct(result.wf.excessAnn)}
                    tone={result.wf.excessAnn > 0 ? "good" : "bad"} directionValue={result.wf.excessAnn} />
                  <Stat label="コスト控除後" value={pct(result.wf.netExcessAnn)}
                    tone={result.wf.netExcessAnn > 0 ? "good" : "bad"} directionValue={result.wf.netExcessAnn} sub={`回転 ${result.wf.turnoverPerYear.toFixed(1)}x/年`} />
                  <Stat label="t値" value={num2(result.wf.tExcess)} sub={`p=${result.wf.pExcess.toFixed(3)} / ${result.wf.nPeriods}期`} />
                  <Stat label="判定" value={result.wf.passes ? "床超え" : "床未達"}
                    tone={result.wf.passes ? "good" : "bad"} />
                </div>
                <div ref={wfContainer} className="w-full" />
                <p className="mt-1.5 text-[11px] text-gray-500">
                  灰=床（等加重・同じコスト会計）／{result.wf.passes ? "緑" : "青"}=過去ドリフト上位{(quantile * 100).toFixed(0)}%チルト・対数軸。
                  ①〜④は「過去の μ̂ に情報が無い」ことを示すが、これは<b>実際に建てたらどうなるか</b>を直接測る最終確認。
                  C25 の他の特性（モメンタム・低ボラ等）と同じ土俵に「過去ドリフト」を載せた形。
                </p>
              </>
            ) : (
              <p className="text-[11px] text-amber-600">
                前向き検証に十分な期間がありません（推定窓{lookbackYears}年＋8リバランス以上が必要）。推定窓を短くしてください。
              </p>
            )}
          </div>

          {result.survivorsToEnd / result.panel.nTickers > 0.9 && (
            <p className="text-[11px] text-amber-600 bg-amber-50 rounded px-2 py-1">
              ⚠ ほぼ全銘柄が終端まで生存＝いま見ているリストは「過去の勝者」。
              上場廃止・統合で消えた銘柄が入っていないので、②のヌル p 値は本来より甘く（有意に）出る。
              真の識別限界はここで測った値よりさらに厳しい。
            </p>
          )}

          <DriftIdGuide kappa={result.kappa} />
          <AxiomPlacement corollaryId="C26" />
        </>
      )}
    </div>
  );
}

function DriftIdGuide({ kappa }: { kappa: number }) {
  const t144 = requiredYears(0.3, 0.05, 2);
  return (
    <AnalysisGuide title="個別銘柄のドリフト同定（μ の識別限界）の詳細理論">
      <p className="font-medium text-gray-700">1. 何を検証しているか</p>
      <p>
        C24 で「市場に参加する床」、C25 で「特性ソート・ポートフォリオによる床の底上げ」を見た。
        その手前に誰もが抱く問いが残っている──<b>「そんな面倒なことをせず、ドリフト（年率の上昇率）が
        高い銘柄を選んで持てばいいのでは？」</b>。この分析はその問いに、期待ではなく<b>推定誤差の側から</b>答える。
      </p>

      <p className="font-medium text-gray-700 mt-3">2. 用語の定義</p>
      <ul className="list-disc pl-4 space-y-1">
        <li><b>ドリフト μ</b>: 価格の対数の1年あたりの平均上昇量。「その銘柄が長期的に持つ上昇の勢い」。</li>
        <li><b>σ（ボラティリティ）</b>: 1年あたりの値動きの散らばり。</li>
        <li><b>SE（標準誤差）</b>: 推定値のブレ幅。「μ̂＝12%、SE＝9%」なら真の μ は −6%〜30% のどこか。</li>
        <li><b>t値</b>: 推定値÷SE。|t|&gt;{kappa} で初めて「誤差では説明できない」と言う（C16 の誤差割引）。</li>
        <li><b>勝者の呪い（winner&apos;s curse）</b>: 多数から最大値を選ぶと、選んだという行為自体が上振れを生む現象。</li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">3. 数式（識別限界の中心）</p>
      <p>{"価格が幾何ブラウン運動 dP/P = μ dt + σ dW に従うとき、T 年の観測から得られる μ̂ は"}</p>
      <p>{"μ̂ = (1/T)·log(P_T/P_0),   SE(μ̂) = σ/√T"}</p>
      <p>
        分子は<b>期間の両端2点しか使っていない</b>。途中を日足で刻もうが分足で刻もうが μ̂ は同じ値になる
        （対数リターンの和は telescoping で log(P_T/P_0) に潰れる）。だから
        <b>サンプリング頻度を上げても μ の精度は 1 ミリも上がらない</b>。一方 σ̂ は観測数 n に対し
        SE(σ̂)≈σ/√(2n) で縮む。これが Merton(1980) の非対称性で、③の表がその実測。
      </p>
      <p>{"必要年数: Δμ を |t|>κ で検出するには T* = (κ·σ_ex/Δμ)² 年"}</p>
      <p>
        σ=30%/年・Δμ=+5pp・κ=2 なら <b>T* ≈ {Math.round(t144)}年</b>。一人の投資家の一生では届かない。
      </p>
      <p>{"勝者の呪い: 真のμが全銘柄同一でも E[μ̂_max − μ̄] ≈ SE·√(2 ln N)"}</p>
      <p>
        N=20・SE=9.5pp なら約 <b>23pp/年</b>。「過去5年で年30%上がった銘柄」の 30% のうち
        20pp 以上が、選抜という操作が生んだ幻でありうる。
      </p>

      <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>
          <b>コインの偏りを当てる</b>: 100回投げれば「表が出やすいか」はそこそこ分かる。だが
          株のドリフトは「1年に1回しか投げられないコイン」で、10年でたった10回。
          細かく見る（1日ごとに覗く）ことは、投げる回数を増やすことにはならない。
        </li>
        <li>
          <b>クラス50人で一番身長が伸びた子</b>: 全員の成長率が本当は同じでも、測定誤差だけで
          「一番伸びた子」は必ず生まれる。その子を選んで「成長率が高い」と言うのが勝者の呪い。
        </li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
      <ul className="list-disc pl-4 space-y-1">
        <li><b>①の95%CI</b>: 銘柄間で CI がほぼ全部重なっていれば、ランキングの上下に意味は無い。</li>
        <li><b>①の必要年数 T*</b>: 観測期間より長ければ、その順位は「まだ判定不能」を意味する。</li>
        <li><b>①の順位95%CI</b>: 1位の銘柄の順位 CI が 1–20 なら、その1位は再標本でどこにでも行く。</li>
        <li><b>②の赤線</b>: 灰の山の中なら「差は無い」。灰の右端を突き抜けて初めて構造的な差の候補。</li>
        <li><b>④の c</b>: 0 に近いほど「全銘柄が同じドリフト」が最良の推定。</li>
        <li><b>⑤の t値</b>: ①〜④が理論、⑤が実弾。過去ドリフト上位を買い続けて床に勝てなければ結論は確定。</li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>
          <b>「値上がりしそうな銘柄を当てる」を戦略の中心に置かない</b>。価格データからドリフトは同定できない。
          同定できないものを判断の軸にすると、動いているのはノイズだけになる。
        </li>
        <li>
          <b>測れるもので建玉を決める</b>: σ（ボラ）・ρ（相関）・β・コストは短期間で精度良く測れる。
          C5（ボラ逆数サイジング）・C2/C20（分散）・C10（コスト）が実効的なのはそのため。
        </li>
        <li>
          <b>床（C24）に居続け、底上げは束（C25）で狙う</b>。個別のドリフト当てを諦めることは
          消極的な妥協ではなく、識別限界から導かれる<b>唯一の帰結</b>。
        </li>
        <li>
          過去実績の高い銘柄を買いたくなったら、①の T* と②のノイズ割合を見る。
          「この判断に必要な年数」が寿命を超えているなら、それは判断ではなく賭け。
        </li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>
          <b>「同定できない」は「差が無い」ではない</b>。真のドリフト差は存在しうる。ここで言えるのは
          「価格系列だけでは、この期間では、判別できない」まで。財務・事業内容など価格外の情報は別の話。
        </li>
        <li>
          <b>生存者バイアス</b>: 現在のウォッチリスト／プリセットは「消えなかった銘柄」。廃止・統合された
          銘柄が入っていないため、②のヌルは甘く出る＝真の識別限界はここで測った値よりさらに厳しい。
        </li>
        <li>
          <b>μ は定常でない</b>。仮に長期間の観測ができても、その間に企業も市場も変質する。
          T* が数十年なら「その頃には対象が別物」という二重の壁がある。
        </li>
        <li>
          ⑤の前向き検証は「過去ドリフト」という1特性のみ。他の特性は C25（pf-selection-tilt）で扱う。
        </li>
        <li>
          共通日付パネルを使うため、上場が新しい銘柄や欠測の多い銘柄は自動除外される（除外数は概況に表示）。
        </li>
      </ul>
    </AnalysisGuide>
  );
}
