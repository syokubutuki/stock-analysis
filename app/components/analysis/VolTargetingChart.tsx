"use client";

// ボラティリティ・ターゲティング（信用レバ可変 0〜3倍）vs バイ&ホールド。
// リターン予測を使わず「ボラの予測可能性」だけでSharpe改善を狙う戦略を、
// JKM Sharpe差検定 / スパニング回帰α(Newey–West) / 置換検定(機構) / MZボラ予測力 で検証する。
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
  computeVolTarget,
  DEFAULT_VT_SPEC,
  SIGMA_SOURCE_LABEL,
  type SigmaSource,
  type UsInputs,
  type VolEstimator,
  type VolTargetResult,
  type VolTargetSpec,
} from "../../lib/vol-targeting";
import { useUsDaily } from "../../hooks/useUsDaily";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
const num2 = (v: number) => v.toFixed(2);
const cls = (v: number) => (v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500");

const ESTIMATOR_LABEL: Record<VolEstimator, string> = {
  ewma: "EWMA (λ=0.94)",
  rv20: "実現ボラ20日",
  rv60: "実現ボラ60日",
};

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

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

export default function VolTargetingChart({ prices }: Props) {
  const [estimator, setEstimator] = useState<VolEstimator>("ewma");
  const [sigmaSource, setSigmaSource] = useState<SigmaSource>("own");
  const [targetMode, setTargetMode] = useState<"auto" | "fixed">("auto");
  const [sigmaTarget, setSigmaTarget] = useState(0.2);
  const [maxLev, setMaxLev] = useState(3);
  const [trendFilter, setTrendFilter] = useState(false);
  const [costBps, setCostBps] = useState(5);

  // 外部σ̂ソースの素材（モジュールキャッシュ付きフックなので常時取得してよい）
  const vixData = useUsDaily("^VIX");
  const gspcData = useUsDaily("^GSPC");
  const usInputs = useMemo<UsInputs>(
    () => ({ vix: vixData.prices ?? undefined, us: gspcData.prices ?? undefined }),
    [vixData.prices, gspcData.prices],
  );
  const extReady: Record<SigmaSource, boolean> = {
    own: true,
    vix: !!usInputs.vix,
    usrv: !!usInputs.us,
    hybrid: !!usInputs.vix,
  };

  const spec = useMemo<VolTargetSpec>(
    () => ({
      ...DEFAULT_VT_SPEC,
      estimator,
      sigmaSource,
      targetMode,
      sigmaTargetAnn: sigmaTarget,
      maxLev,
      trendFilter,
      costBps,
    }),
    [estimator, sigmaSource, targetMode, sigmaTarget, maxLev, trendFilter, costBps],
  );

  const result = useMemo<VolTargetResult | null>(
    () => computeVolTarget(prices, spec, usInputs),
    [prices, spec, usInputs],
  );
  const hasResult = result !== null;

  // === エクイティ曲線 + レバ/予測ボラ（横軸=日付なので lightweight-charts, 2ペイン同期）===
  const eqRef = useRef<HTMLDivElement>(null);
  const levRef = useRef<HTMLDivElement>(null);
  const eqChartRef = useRef<IChartApi | null>(null);
  const levChartRef = useRef<IChartApi | null>(null);
  const eqSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const levSeriesRef = useRef<ISeriesApi<"Line">[]>([]);

  useEffect(() => {
    if (!hasResult || !eqRef.current || !levRef.current) return;
    const eqChart = createChart(eqRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f0f0f0" } },
      width: eqRef.current.clientWidth,
      height: 280,
      crosshair: { mode: 0 },
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(0)}%` },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    const levChart = createChart(levRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f0f0f0" } },
      width: levRef.current.clientWidth,
      height: 160,
      crosshair: { mode: 0 },
      timeScale: { timeVisible: false, secondsVisible: false },
      leftPriceScale: { visible: true },
    });
    eqChartRef.current = eqChart;
    levChartRef.current = levChart;
    // 時間軸の相互同期
    let syncing = false;
    const sync = (from: IChartApi, to: IChartApi) => {
      from.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (syncing || !range) return;
        syncing = true;
        to.timeScale().setVisibleLogicalRange(range);
        syncing = false;
      });
    };
    sync(eqChart, levChart);
    sync(levChart, eqChart);
    const onResize = () => {
      if (eqRef.current) eqChart.applyOptions({ width: eqRef.current.clientWidth });
      if (levRef.current) levChart.applyOptions({ width: levRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      eqChart.remove();
      levChart.remove();
      eqChartRef.current = null;
      levChartRef.current = null;
      eqSeriesRef.current = [];
      levSeriesRef.current = [];
    };
  }, [hasResult]);

  useEffect(() => {
    const eqChart = eqChartRef.current, levChart = levChartRef.current;
    if (!eqChart || !levChart || !result) return;
    for (const s of eqSeriesRef.current) eqChart.removeSeries(s);
    for (const s of levSeriesRef.current) levChart.removeSeries(s);
    eqSeriesRef.current = [];
    levSeriesRef.current = [];

    const bhs = eqChart.addSeries(LineSeries, {
      color: "#9ca3af", lineWidth: 1, title: "B&H", priceLineVisible: false, lastValueVisible: true,
    });
    bhs.setData(result.rows.map((r) => ({ time: r.time as Time, value: r.bh })));
    const sts = eqChart.addSeries(LineSeries, {
      color: "#2563eb", lineWidth: 2, title: "ボラ・ターゲット", priceLineVisible: false, lastValueVisible: true,
    });
    sts.setData(result.rows.map((r) => ({ time: r.time as Time, value: r.strat })));
    eqSeriesRef.current = [bhs, sts];

    const levs = levChart.addSeries(LineSeries, {
      color: "#d97706", lineWidth: 2, title: "レバ", priceLineVisible: false, lastValueVisible: true,
    });
    levs.setData(result.rows.map((r) => ({ time: r.time as Time, value: r.lev })));
    const sigs = levChart.addSeries(LineSeries, {
      color: "#7c3aed", lineWidth: 1, title: "予測ボラ(年率)", priceLineVisible: false,
      lastValueVisible: true, priceScaleId: "left",
    });
    sigs.setData(result.rows.map((r) => ({ time: r.time as Time, value: r.sigmaAnn })));
    levSeriesRef.current = [levs, sigs];

    eqChart.timeScale().fitContent();
    levChart.timeScale().fitContent();
  }, [result]);

  // === 定数レバ掃引（横軸=レバなので Canvas2D）===
  const sweepRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = sweepRef.current;
    if (!canvas || !result) return;
    const init = initCanvas(canvas, 220);
    if (!init) return;
    const { ctx, width, height } = init;
    const { ks, annual, sharpe, kStarEmp } = result.sweep;
    const padL = 48, padR = 48, padT = 26, padB = 28;
    const plotW = width - padL - padR, plotH = height - padT - padB;
    const kMax = ks[ks.length - 1];
    const xOf = (k: number) => padL + (k / kMax) * plotW;
    // 年率（左軸）
    const aMin = Math.min(...annual, 0), aMax = Math.max(...annual, 0.01);
    const yOfA = (a: number) => padT + (1 - (a - aMin) / (aMax - aMin)) * plotH;
    // Sharpe（右軸）
    const sVals = sharpe.filter((v) => Number.isFinite(v));
    const sMin = Math.min(...sVals, 0), sMax = Math.max(...sVals, 0.1);
    const yOfS = (s: number) => padT + (1 - (s - sMin) / (sMax - sMin)) * plotH;

    // 0%ライン
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(padL, yOfA(0)); ctx.lineTo(width - padR, yOfA(0)); ctx.stroke();
    ctx.setLineDash([]);

    // 縦マーカー: k=1（灰）/ k*emp（緑）/ 戦略の平均レバ（青）
    const marker = (k: number, color: string, label: string, dy: number) => {
      if (k < 0 || k > kMax) return;
      ctx.strokeStyle = color; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xOf(k), padT); ctx.lineTo(xOf(k), height - padB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(label, xOf(k) + 3, padT + dy);
    };
    marker(1, "#9ca3af", "k=1 (B&H)", 10);
    marker(kStarEmp, "#16a34a", `k*=${kStarEmp.toFixed(2)}`, 22);
    marker(result.meta.avgLev, "#2563eb", `平均レバ=${result.meta.avgLev.toFixed(2)}`, 34);

    // 年率カーブ（青実線）
    ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2; ctx.beginPath();
    ks.forEach((k, i) => { const x = xOf(k), y = yOfA(annual[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
    // Sharpeカーブ（橙破線）
    ctx.strokeStyle = "#d97706"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]); ctx.beginPath();
    ks.forEach((k, i) => { const x = xOf(k), y = yOfS(sharpe[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke(); ctx.setLineDash([]);

    // 軸ラベル
    ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (let k = 0; k <= kMax + 1e-9; k += 0.5) ctx.fillText(k.toFixed(1), xOf(k), height - 12);
    ctx.fillText("定数レバレッジ k", padL + plotW / 2, height - 2);
    ctx.textAlign = "right"; ctx.fillStyle = "#2563eb";
    ctx.fillText(`${(aMax * 100).toFixed(0)}%`, padL - 4, yOfA(aMax) + 4);
    ctx.fillText(`${(aMin * 100).toFixed(0)}%`, padL - 4, yOfA(aMin) + 4);
    ctx.fillText("年率", padL - 4, 10);
    ctx.textAlign = "left"; ctx.fillStyle = "#d97706";
    ctx.fillText(num2(sMax), width - padR + 4, yOfS(sMax) + 4);
    ctx.fillText(num2(sMin), width - padR + 4, yOfS(sMin) + 4);
    ctx.fillText("Sharpe", width - padR + 4, 10);
  }, [result]);

  // === 置換検定ヒストグラム（横軸=ΔSharpe なので Canvas2D）===
  const permRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = permRef.current;
    if (!canvas || !result || !result.perm) return;
    const init = initCanvas(canvas, 130);
    if (!init) return;
    const { ctx, width, height } = init;
    const { dist, actualDelta } = result.perm;
    const lo = Math.min(...dist, actualDelta), hi = Math.max(...dist, actualDelta);
    const span = hi - lo || 1;
    const nBins = 30;
    const bins = new Array(nBins).fill(0);
    for (const v of dist) {
      const b = Math.min(nBins - 1, Math.floor(((v - lo) / span) * nBins));
      bins[b]++;
    }
    const bMax = Math.max(...bins, 1);
    const padB = 16;
    const bw = width / nBins;
    ctx.fillStyle = "#c7d2fe";
    bins.forEach((c, i) => {
      const h = (c / bMax) * (height - padB - 8);
      ctx.fillRect(i * bw + 1, height - padB - h, bw - 2, h);
    });
    // 実測値
    const xAct = ((actualDelta - lo) / span) * width;
    ctx.strokeStyle = "#dc2626"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(xAct, 4); ctx.lineTo(xAct, height - padB); ctx.stroke();
    ctx.fillStyle = "#dc2626"; ctx.font = "10px sans-serif";
    ctx.textAlign = xAct > width * 0.7 ? "right" : "left";
    ctx.fillText(`実測 ΔSharpe=${num2(actualDelta)}`, xAct + (xAct > width * 0.7 ? -4 : 4), 12);
    ctx.fillStyle = "#6b7280"; ctx.textAlign = "left";
    ctx.fillText(num2(lo), 2, height - 4);
    ctx.textAlign = "right";
    ctx.fillText(num2(hi), width - 2, height - 4);
  }, [result]);

  if (!result) {
    return (
      <div className="text-sm text-gray-500 p-4">
        データが不足しています（ウォームアップ後に最低1年分の評価区間が必要です）。
      </div>
    );
  }

  const { metrics, sharpe, annual, alpha, volForecast, perm, meta, costs, sweep, comparison } = result;

  // 総合判定: リスク調整後の優位（Sharpe差 / α / 置換）と、リスク低減（DD・ボラ）
  const sigTests = [sharpe.jkmP, alpha.pOneSided, perm ? perm.pOneSided : null];
  const sigCount = sigTests.filter((p) => p !== null && p < 0.05).length;
  const ddImproved = metrics.strat.maxDD > metrics.bh.maxDD; // 負値なので大きいほど浅い
  const volReduced = metrics.strat.annVol < metrics.bh.annVol;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        リターン予測を使わず、<span className="font-medium">予測ボラ σ̂ に反比例して建玉 k = min(k_max, σ*/σ̂) を毎日調整</span>する
        ボラティリティ・ターゲティング戦略を、信用金利・売買コスト込みでB&Hと比較します。
        「リターンは予測できないがボラは予測できる」という非対称性だけを収益源とし、
        改善が本当にボラ予測に由来するかを置換検定で確かめます（全て t−1 までの情報のみ使用・ルックアヘッドなし）。
      </p>

      {/* コントロール */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <div className="flex items-center gap-1">
          <span className="text-gray-500">σ̂ソース:</span>
          {(Object.keys(SIGMA_SOURCE_LABEL) as SigmaSource[]).map((s) => (
            <button
              key={s}
              onClick={() => extReady[s] && setSigmaSource(s)}
              disabled={!extReady[s]}
              title={
                !extReady[s]
                  ? vixData.loading || gspcData.loading
                    ? "米国データ取得中…"
                    : "米国データの取得に失敗しました"
                  : s === "vix"
                  ? "前夜VIX終値(自銘柄水準に因果較正)"
                  : s === "usrv"
                  ? "^GSPC日次リターンのEWMA(自銘柄水準に因果較正)"
                  : s === "hybrid"
                  ? "max(自銘柄σ̂, 較正済VIX): どちらかの警告に従う防御型"
                  : "自銘柄の過去リターンのみ"
              }
              className={`px-2 py-0.5 rounded border ${sigmaSource === s ? "bg-purple-600 text-white border-purple-600" : extReady[s] ? "bg-white text-gray-600 border-gray-300" : "bg-gray-100 text-gray-300 border-gray-200 cursor-not-allowed"}`}
            >
              {SIGMA_SOURCE_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-500">{sigmaSource === "own" ? "ボラ推定:" : "自銘柄σ̂(較正基準):"}</span>
          {(Object.keys(ESTIMATOR_LABEL) as VolEstimator[]).map((e) => (
            <button
              key={e}
              onClick={() => setEstimator(e)}
              className={`px-2 py-0.5 rounded border ${estimator === e ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
            >
              {ESTIMATOR_LABEL[e]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-500">目標ボラ:</span>
          <button
            onClick={() => setTargetMode("auto")}
            className={`px-2 py-0.5 rounded border ${targetMode === "auto" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
          >
            自動（過去1年平均）
          </button>
          <button
            onClick={() => setTargetMode("fixed")}
            className={`px-2 py-0.5 rounded border ${targetMode === "fixed" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
          >
            固定
          </button>
          {targetMode === "fixed" && (
            <label className="flex items-center gap-1 text-gray-600">
              <input
                type="range" min={0.1} max={0.4} step={0.01} value={sigmaTarget}
                onChange={(e) => setSigmaTarget(Number(e.target.value))}
              />
              <span className="w-10 text-right">{pct1(sigmaTarget)}</span>
            </label>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-500">レバ上限:</span>
          <label className="flex items-center gap-1 text-gray-600">
            <input
              type="range" min={1} max={3} step={0.5} value={maxLev}
              onChange={(e) => setMaxLev(Number(e.target.value))}
            />
            <span className="w-8 text-right">{maxLev.toFixed(1)}倍</span>
          </label>
        </div>
        <label className="flex items-center gap-1 text-gray-600 cursor-pointer">
          <input type="checkbox" checked={trendFilter} onChange={(e) => setTrendFilter(e.target.checked)} />
          SMA200割れでレバ上限1
        </label>
        <div className="flex items-center gap-1">
          <span className="text-gray-500">コスト:</span>
          {[0, 2, 5, 10].map((b) => (
            <button
              key={b}
              onClick={() => setCostBps(b)}
              className={`px-2 py-0.5 rounded border ${costBps === b ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
            >
              {b}bp
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400">
          {meta.startDate}〜{meta.endDate} / {meta.years.toFixed(1)}年 / 信用金利2.6%
        </span>
      </div>

      {/* 総合判定 */}
      <div className={`rounded-lg border p-3 text-sm ${sigCount >= 2 ? "bg-green-50 border-green-300" : sigCount >= 1 || (ddImproved && volReduced) ? "bg-amber-50 border-amber-300" : "bg-gray-50 border-gray-300"}`}>
        <span className="font-medium">総合判定: </span>
        リスク調整後の優位3検定（Sharpe差 / α / 置換）のうち<span className="font-bold">{sigCount}/3</span>が有意（p&lt;0.05）。
        リスク低減は {ddImproved ? "最大DD改善" : "最大DD悪化"}・{volReduced ? "ボラ低減" : "ボラ増加"}。
        {sigCount >= 2
          ? " リスク調整後で統計的に頑健な優位が検出されました。"
          : sigCount === 1
          ? " 一部の検定で優位ですが頑健とは言えません。リスク低減の実利を重視してください。"
          : ddImproved && volReduced
          ? " Sharpe改善は有意水準に届きませんが、リスク低減（DD・ボラ）は達成されています。これが本手法の現実的な期待値です。"
          : " 優位性は検出されませんでした。ボラ予測力（④）が弱い銘柄では効きません。"}
      </div>

      {/* エクイティ + レバ/ボラ（時間軸同期） */}
      <div>
        <div className="text-xs text-gray-500 mb-1">累積リターン（青=ボラ・ターゲット / 灰=B&H, ホイールでズーム）</div>
        <div ref={eqRef} className="w-full" />
        <div className="text-xs text-gray-500 mb-1 mt-2">保有レバレッジ（橙, 右軸） / 予測ボラ年率（紫, 左軸）</div>
        <div ref={levRef} className="w-full" />
      </div>

      {/* 指標比較表 */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-gray-300 text-gray-500 text-xs">
              <th className="text-left py-1 px-2">指標</th>
              <th className="text-right py-1 px-2">ボラ・ターゲット</th>
              <th className="text-right py-1 px-2">バイ&ホールド</th>
              <th className="text-right py-1 px-2">差</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-600">年率リターン</td>
              <td className={`text-right px-2 ${cls(metrics.strat.annualized)}`}>{pct(metrics.strat.annualized)}</td>
              <td className={`text-right px-2 ${cls(metrics.bh.annualized)}`}>{pct(metrics.bh.annualized)}</td>
              <td className={`text-right px-2 font-medium ${cls(annual.delta)}`}>{pct(annual.delta)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-600">年率ボラティリティ</td>
              <td className="text-right px-2 text-gray-700">{pct1(metrics.strat.annVol)}</td>
              <td className="text-right px-2 text-gray-700">{pct1(metrics.bh.annVol)}</td>
              <td className={`text-right px-2 font-medium ${cls(metrics.bh.annVol - metrics.strat.annVol)}`}>{pct(metrics.strat.annVol - metrics.bh.annVol)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-600">年率Sharpe</td>
              <td className={`text-right px-2 ${cls(metrics.strat.sharpe)}`}>{num2(metrics.strat.sharpe)}</td>
              <td className={`text-right px-2 ${cls(metrics.bh.sharpe)}`}>{num2(metrics.bh.sharpe)}</td>
              <td className={`text-right px-2 font-medium ${cls(sharpe.delta)}`}>{num2(sharpe.delta)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-600">最大ドローダウン</td>
              <td className={`text-right px-2 ${cls(metrics.strat.maxDD)}`}>{pct(metrics.strat.maxDD)}</td>
              <td className={`text-right px-2 ${cls(metrics.bh.maxDD)}`}>{pct(metrics.bh.maxDD)}</td>
              <td className={`text-right px-2 font-medium ${cls(metrics.strat.maxDD - metrics.bh.maxDD)}`}>{pct(metrics.strat.maxDD - metrics.bh.maxDD)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-600">平均レバ / 実効目標ボラ</td>
              <td className="text-right px-2 text-gray-700">{meta.avgLev.toFixed(2)}倍 / {pct1(meta.avgTargetAnn)}</td>
              <td className="text-right px-2 text-gray-700">1.00倍 / -</td>
              <td className="text-right px-2 text-gray-500">-</td>
            </tr>
            <tr>
              <td className="py-1 px-2 text-gray-600">コスト累計（金利 / 売買）</td>
              <td className="text-right px-2 text-red-600">−{(costs.carryPaid * 100).toFixed(2)}% / −{(costs.costPaid * 100).toFixed(2)}%</td>
              <td className="text-right px-2 text-gray-700">0% / 0%</td>
              <td className="text-right px-2 text-gray-500">年間回転 {costs.turnoverPerYear.toFixed(1)}単位</td>
            </tr>
          </tbody>
        </table>
        <p className="text-xs text-gray-400 mt-1">
          年率差の95%CI（ペア・ブロックBootstrap）: [{pct(annual.lo)}, {pct(annual.hi)}]、差&gt;0の確率 {(annual.probPositive * 100).toFixed(0)}%。
        </p>
      </div>

      {/* 4検定カード */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* 1. Sharpe差 */}
        <div className="rounded-lg border border-gray-200 p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">① Sharpe差検定</span>
            <PBadge p={sharpe.jkmP} label="JKM" />
          </div>
          <p className="text-xs text-gray-500">リスク調整後の優位。Jobson–Korkie–Memmel検定＋ペア・ブロックBootstrap。</p>
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

        {/* 2. スパニング回帰α */}
        <div className="rounded-lg border border-gray-200 p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">② スパニング回帰 α</span>
            <PBadge p={alpha.pOneSided} label="NW-t" />
          </div>
          <p className="text-xs text-gray-500">
            r<sub>戦略</sub> = α + β·r<sub>B&H</sub> + ε。α&gt;0 なら「B&Hのレバ調整では複製できない付加価値」。Newey–West(ラグ5)。
          </p>
          <div className="text-sm space-y-0.5">
            <div className="flex justify-between"><span className="text-gray-500">α（年率）</span><span className={cls(alpha.alphaAnn)}>{pct(alpha.alphaAnn)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">β / R²</span><span className="text-gray-700">{num2(alpha.beta)} / {num2(alpha.r2)}</span></div>
            {alpha.tNW !== null && (
              <div className="flex justify-between"><span className="text-gray-500">NW t値</span><span className="text-gray-700">{num2(alpha.tNW)}</span></div>
            )}
          </div>
        </div>

        {/* 3. 置換検定（機構） */}
        <div className="rounded-lg border border-gray-200 p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">③ 置換検定（機構の検証）</span>
            <PBadge p={perm ? perm.pOneSided : null} label="perm" />
          </div>
          <p className="text-xs text-gray-500">
            {sigmaSource === "own" ? (
              <>リターンをシャッフルし<span className="font-medium">ボラ・クラスタリングを破壊</span>した{perm ? perm.nPerm : 0}本のヌル系列でΔSharpe を再計算。</>
            ) : (
              <>σ̂系列（{SIGMA_SOURCE_LABEL[sigmaSource]}）は固定したままリターンをシャッフルし、<span className="font-medium">σ̂とリターンの対応を破壊</span>した{perm ? perm.nPerm : 0}本のヌル系列でΔSharpe を再計算。</>
            )}
            実測（赤線）が分布の右端なら、改善は予測情報に由来する本物。
          </p>
          <div className="w-full"><canvas ref={permRef} /></div>
        </div>

        {/* 4. ボラ予測力 */}
        <div className="rounded-lg border border-gray-200 p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">④ ボラ予測力（戦略のエンジン）</span>
            <PBadge p={volForecast.spearman > 0.2 ? 0.01 : 1} label={volForecast.spearman > 0.2 ? "ρ>0.2" : "ρ弱"} />
          </div>
          <p className="text-xs text-gray-500">
            Mincer–Zarnowitz回帰 r² = a + b·σ̂²（理想は b≈1）と、σ̂ と |r| の順位相関。
            これが弱い銘柄ではボラ・ターゲティングは機能しません。
          </p>
          <div className="text-sm space-y-0.5">
            <div className="flex justify-between"><span className="text-gray-500">MZ傾き b（理想≈1）</span><span className="text-gray-700">{num2(volForecast.mzSlope)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">MZ R²</span><span className="text-gray-700">{volForecast.mzR2.toFixed(3)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Spearman ρ(σ̂, |r|)</span><span className={cls(volForecast.spearman)}>{num2(volForecast.spearman)}</span></div>
          </div>
        </div>
      </div>

      {/* σ̂ソース横断比較 */}
      {comparison && (
        <div className="overflow-x-auto">
          <div className="text-xs text-gray-500 mb-1">
            σ̂ソース横断比較（共通評価区間・現在の設定で軽量再計算。紫=選択中）。
            日本株では自銘柄σ̂より前夜VIX/米国実現ボラの方が ρ・ΔDD が良くなるか、が見どころです。
          </div>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-300 text-gray-500 text-xs">
                <th className="text-left py-1 px-2">σ̂ソース</th>
                <th className="text-right py-1 px-2">予測力 ρ</th>
                <th className="text-right py-1 px-2">MZ R²</th>
                <th className="text-right py-1 px-2">ΔSharpe</th>
                <th className="text-right py-1 px-2">ΔDD(pt)</th>
                <th className="text-right py-1 px-2">平均レバ</th>
              </tr>
            </thead>
            <tbody>
              {comparison.map((row) => (
                <tr
                  key={row.source}
                  className={`border-b border-gray-100 ${row.source === sigmaSource ? "bg-purple-50 font-medium" : ""} ${extReady[row.source] ? "cursor-pointer hover:bg-gray-50" : ""}`}
                  onClick={() => extReady[row.source] && setSigmaSource(row.source)}
                >
                  <td className="py-1 px-2 text-gray-700">{row.label}</td>
                  <td className={`text-right px-2 ${cls(row.spearman - 0.2)}`}>{num2(row.spearman)}</td>
                  <td className="text-right px-2 text-gray-700">{row.mzR2.toFixed(3)}</td>
                  <td className={`text-right px-2 ${cls(row.dSharpe)}`}>{num2(row.dSharpe)}</td>
                  <td className={`text-right px-2 ${cls(row.dMaxDD)}`}>{(row.dMaxDD * 100).toFixed(1)}</td>
                  <td className="text-right px-2 text-gray-700">{row.avgLev.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-gray-400 mt-1">
            行クリックでそのソースに切替。ΔDD は最大ドローダウンの改善幅（正=浅くなった）。
            この表は点推定のみ（検定なし）なので、最終判断は上の検定カードで。
          </p>
        </div>
      )}

      {/* 定数レバ掃引 */}
      <div>
        <div className="text-xs text-gray-500 mb-1">
          定数レバレッジ掃引: 幾何年率（青実線, 左軸）と Sharpe（橙破線, 右軸）。
          緑=幾何年率を最大にする実効ケリー k*（イン・サンプル参考値）、青破線=可変レバ戦略の平均レバ。
          理論ケリー μ/σ² = {num2(sweep.kKellyGross)}。
        </div>
        <div className="w-full"><canvas ref={sweepRef} /></div>
        <p className="text-xs text-gray-400 mt-1">
          定数レバでは k を上げるほど分散ドラッグ（k²σ²/2）と信用金利が幾何リターンを削ります。
          可変レバ戦略の価値は「平均レバは k* 近辺のまま、荒れた日だけ下げる」ことでこの曲線の上に出られるかどうかです。
        </p>
      </div>

      <AnalysisGuide title="ボラティリティ・ターゲティングの詳細理論">
        <p className="font-medium text-gray-700">1. ボラティリティ・ターゲティングとは</p>
        <p>
          リターンの方向は予測せず、<span className="font-medium">「明日どれくらい荒れるか」だけを予測してポジションサイズを毎日調整</span>する戦略です。
          日次リターンの自己相関はほぼゼロ（方向は予測不能）ですが、ボラティリティは強くクラスター化します
          （荒れた日の翌日は荒れやすい）。この「リターンは予測できないがリスクは予測できる」という
          非対称性だけを収益源にします。車の運転に例えると、<span className="font-medium">見通しの悪いカーブでは減速し、
          見通しの良い直線では加速する</span>ようなものです。到着時間（リターン）を保ちながら事故（大損失）の確率を下げます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <span className="font-medium">建玉ルール</span>: k<sub>t</sub> = min(k<sub>max</sub>, σ*/σ̂<sub>t</sub>)。
            σ* は目標ボラ（年率）、σ̂<sub>t</sub> は t−1 までの情報による予測ボラ。
            σ̂ が目標の半分なら2倍のレバ、2倍なら半分のポジションになります。
          </li>
          <li>
            <span className="font-medium">EWMA予測ボラ</span>: v<sub>t</sub> = λ·v<sub>t−1</sub> + (1−λ)·r<sub>t−1</sub>²（λ=0.94, RiskMetrics）。
            直近の値動きほど重く効く指数加重の分散推定で、σ̂<sub>t</sub> = √(252·v<sub>t</sub>)。
          </li>
          <li>
            <span className="font-medium">レバレッジの幾何リターン</span>: g(k) ≈ k·μ − ½k²σ² − (k−1)<sup>+</sup>·c。
            第2項が<span className="font-medium">分散ドラッグ</span>（レバの2乗で効く複利の摩耗）、c は信用金利。
            これを最大にする k* = μ/σ² が<span className="font-medium">ケリー基準</span>です。
            μ=6%・σ=20%なら k*=1.5 で、フルケリーですら信用の上限3倍に届きません。
          </li>
          <li>
            <span className="font-medium">自動目標ボラ</span>: σ*<sub>t</sub> = 過去252日の σ̂ の平均（因果的）。
            調整パラメータを持たないため過剰最適化の余地がほぼありません。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">ボラ・クラスタリング</span>: 大きな値動きの後に大きな値動きが続く性質。GARCH効果とも。この分析の前提条件。</li>
          <li><span className="font-medium">スパニング回帰</span>: 戦略リターンをB&Hリターンで回帰し、切片α（B&Hの定数倍では作れない超過分）を測る。Moreira & Muir (2017) の検定方法。</li>
          <li><span className="font-medium">置換検定</span>: データの並び順をシャッフルして「効果の源泉」を壊した偽データで同じ計算を繰り返し、実測値が偶然で出る確率を直接数える検定。</li>
          <li><span className="font-medium">Mincer–Zarnowitz回帰</span>: 予測値で実現値を回帰し、傾きが1に近いほど予測が校正されていると判定する古典的な予測評価法。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">① JKM p&lt;0.05</span>: リスク調整後（Sharpe）でB&Hに有意に勝っている。単一銘柄・10年ではΔSharpe≈0.15程度の改善は有意になりにくいのが正常です。</li>
          <li><span className="font-medium">② α&gt;0（NW-t有意）</span>: 改善が「単にレバを掛けた/落とした」のではなく、タイミングの付加価値であることを意味します。</li>
          <li><span className="font-medium">③ 置換検定</span>: 実測ΔSharpe（赤線）がヌル分布の右端（p&lt;0.05）なら、改善はボラ・クラスタリングの利用に由来する「機構のある」効果。分布の中央なら偶然と区別できません。</li>
          <li><span className="font-medium">④ ボラ予測力</span>: Spearman ρ が 0.2 未満の銘柄では、そもそもエンジンが無いので戦略は機能しません。まずここを見るのが正しい順序です。</li>
          <li>Sharpe差が非有意でも<span className="font-medium">最大DD・年率ボラの低減</span>が出ていれば、実務的な価値（追証回避・心理的継続性）はあります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>④→③→①の順で確認: ボラ予測力がある → 機構が本物 → Sharpe改善が有意、と揃えば信用レバを使う根拠になります。</li>
          <li>平均レバは実効ケリー k*（掃引チャートの緑線）を超えないこと。信用の3倍上限は制約ではなく安全柵です。</li>
          <li>Sharpeが改善したら、目標ボラを引き上げて（=全体を再レバレッジ）同リスクでリターンを上乗せするのが正しい使い方です。</li>
          <li>「SMA200割れでレバ上限1」を併用すると、暴落局面の被弾をさらに抑えられます（トレンドフォローとの併用）。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">リターンの有意な上乗せは原理的に困難</span>: 本手法の主効果はリスク低減です。年率リターン差のCIはたいてい0を跨ぎます。「有意にB&Hを上回る」と言えるのは主にSharpe・DDの次元です。</li>
          <li><span className="font-medium">ギャップリスク</span>: 日次リバランスでは寄り付きの窓（オーバーナイトの急落）は避けられません。レバ3倍中の−33%ギャップで理論上破産します。</li>
          <li><span className="font-medium">急落の一日目は食らう</span>: σ̂ は事後的に上がるため、平穏→急落の初日はフルポジションで被弾します。守れるのは「荒れが続く局面」だけです。</li>
          <li><span className="font-medium">コスト</span>: 信用金利（年2.6%が借入分に常時）と日次リバランスの売買コストがΔSharpeを削ります。バンド制リバランス（±0.25）で回転を抑えています。</li>
          <li><span className="font-medium">実装可能性の批判</span>: Cederburg et al. (2020) は、リアルタイム実装ではボラ管理の優位が多くの資産で消えると報告しています。市場インデックス系が最も生き残りやすい類型です。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 実測から得られた知見（2016〜2026の約10年, 指数・個別の横断比較）</p>
        <p>
          本コンポーネントを個別株（トヨタ 7203.T）と4指数（^N225 / 1321.T / ^GSPC / ^IXIC）に
          既定設定（EWMA・自動目標・レバ上限3・コスト5bp）で適用した実測の要約です。
          期間や設定が変われば数値は変わりますが、構造的な結論は再現されるはずです。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <span className="font-medium">結果を分けるのはボラ予測力（④）で、仮説どおり米国指数が最強</span>:
            Spearman ρ は S&P500 (^GSPC)=0.37・ナスダック (^IXIC)=0.36 に対し、
            日経平均 (^N225)=0.22・日経225ETF (1321.T)=0.23・トヨタ (7203.T)=0.26。
            指数は数百銘柄の集計で銘柄固有ジャンプ（決算等）が打ち消され、
            持続的なボラ・クラスタリング成分だけが残るため予測が効きます。
          </li>
          <li>
            <span className="font-medium">米国指数では教科書どおりに機能</span>: ^GSPC は最大DDが −33.9% → −22.0%（+11.9pt）、
            ^IXIC は +8.2pt 改善し、年率リターンをほぼ落とさずに（^GSPC +0.1% / ^IXIC +0.7%）達成。
            ΔSharpe は両者 +0.07、スパニングα ≈ +3%/年（t≈1.1）、置換検定は p=0.08〜0.10 で
            「改善はボラ・クラスタリング利用に由来する」がほぼ確認水準でした。
          </li>
          <li>
            <span className="font-medium">日本指数では機能しない（構造的理由）</span>: ^N225・1321.T は ρ≈0.22 で、
            ΔSharpe −0.02・最大DDはむしろ悪化。日経の日次リターン（終値→翌終値）の分散は
            前夜の米国ニュースが寄り付きギャップとして一気に流入する部分が大きく、
            ギャップは自銘柄の過去ボラから予測できず日次リバランスでは防御もできないためです。
            1321.T が ^N225 と同結果である事実は、<span className="font-medium">「日本で売買できる現物」に
            置き換えても米国指数の優位は持ち込めない</span>ことを意味します。
          </li>
          <li>
            <span className="font-medium">それでも5%有意には届かない</span>: 最良の ^GSPC ですら3検定とも p&gt;0.05。
            ΔSharpe≈0.1 の検出には数十年の標本が必要という統計的限界の実演であり、手法の欠陥ではありません。
            置換検定 p&lt;0.1（機構の存在）とDD改善の実利をどう評価するかが実践上の判断になります。
          </li>
          <li>
            <span className="font-medium">コスト前提の注意</span>: 本シミュレーションの信用金利2.6%は日本株の制度信用の想定。
            S&P500系を実際に持つ手段（先物・CFD・1557.T等）は資金調達コスト構造が異なり、
            先物ならキャリーは実質金利差程度なので、米国指数に対しては保守的すぎる可能性があります。
          </li>
          <li>
            <span className="font-medium">日本株への応用</span>: ボラ推定の入力を自銘柄の過去ボラから
            「前夜のVIX・米国実現ボラ」に替えれば、ギャップの予測不能性をある程度回避できる見込みがあります
            （カレンダー節のボラティリティ・スピルオーバー分析が示す「米国の荒れ→当日の荒れ」の伝播を利用）。
            → この仮説は<span className="font-medium">σ̂ソース切替（次節）として実装済み</span>です。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">8. VIX入力版（σ̂ソース切替）の理論</p>
        <p>
          「σ̂ソース」で予測ボラの入力を切り替えられます。狙いは第7節の知見への対処です:
          日本株の日次分散は前夜米国発の寄り付きギャップが大きく、<span className="font-medium">自分の過去だけを見るσ̂は
          米国発の荒れを一日遅れでしか察知できない</span>。それなら最初から米国のリスク計を読めばよい、という発想です。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <span className="font-medium">VIXとは</span>: S&P500オプション価格から逆算した「市場が織り込む今後30日の年率ボラ」
            （インプライド・ボラティリティ）。恐怖指数とも呼ばれ、値20なら年率20%の変動を市場が予想している意味。
            実現ボラより平均的に数ポイント高い（ボラ・リスクプレミアム）ことが知られています。
          </li>
          <li>
            <span className="font-medium">前夜整合</span>: 建玉は営業日tの終値時点で決めるため、使える米国情報は
            「決定日より暦日が厳密に小さい最新の米国立会日」の終値（スピルオーバー分析群と同じ規約）。
            当夜の米国セッションは見えないので、利用しているのは<span className="font-medium">VIXの持続性</span>
            （今日高いVIXは明日も高く、明日のギャップも荒れやすい）であり、ルックアヘッドはありません。
          </li>
          <li>
            <span className="font-medium">因果的スケール較正</span>: VIXはS&P500のボラであり水準が自銘柄と違うため、
            σ̂<sub>t</sub> = raw<sub>t</sub> × (過去252日の自銘柄σ̂平均) / (過去252日のraw平均) で
            「タイミング情報は外部、水準は自銘柄」に合わせます。比率は過去情報のみで毎日更新（因果的）。
            リスクプレミアムの上乗せ分もこの比率が自動吸収します。
          </li>
          <li>
            <span className="font-medium">米国実現ボラ（^GSPC EWMA）</span>: VIXの代わりに米国指数の実現ボラを使う変種。
            プレミアム変動が乗らないぶん素直ですが、オプション市場の先読み（イベント前の織り込み）は失われます。
          </li>
          <li>
            <span className="font-medium">ハイブリッド(max)</span>: max(自銘柄σ̂, 較正済VIX)。どちらかが荒れを警告したら
            建玉を落とす防御型。ボラ過大評価に倒すため平均レバは下がり、リターンを犠牲にDD低減を優先します。
          </li>
          <li>
            <span className="font-medium">置換検定の変更</span>: 外部ソースではσ̂系列を固定したままリターンだけを
            シャッフルします（σ̂↔リターンの対応破壊）。ヌル仮説は「外部σ̂は自銘柄の荒れと無関係」。
          </li>
          <li>
            <span className="font-medium">読み方</span>: σ̂ソース横断比較の表で、外部ソースが自銘柄σ̂より
            ρ・ΔDD を改善しているかを見ます。改善するのは「米国主導で荒れる銘柄」（輸出大型株・指数連動）で、
            内需小型・個別材料株ではVIXとの連動が弱く効きません（②スピルオーバーβの弱い銘柄）。
          </li>
          <li>
            <span className="font-medium">実測（2016〜2026, 共通評価区間）</span>: 仮説どおり日本銘柄で外部ソースが優位でした。
            日経平均は自銘柄σ̂だと最大DDが<span className="font-medium">悪化</span>（−4.7pt）するのに、
            前夜VIXに替えると<span className="font-medium">+4.7ptの改善</span>に反転し、MZ R²も 0.058→0.098 とほぼ倍増。
            トヨタ(7203.T)もΔDDが +2.6pt→+7.8pt に拡大し、置換検定は p≈0.10 まで改善（own時 p≈0.37）。
            米国実現ボラはΔSharpe最大（^N225 +0.14 / 7203.T +0.12）だが平均レバが高め。
            ハイブリッド(max)はσ̂を過大評価しがちで中庸でした。
            「日本株のギャップは自分の過去より前夜の米国リスク計で測れ」が実データで裏付けられた形です。
          </li>
          <li>
            <span className="font-medium">注意</span>: VIX自体のジャンプ（米国の突発ニュース）は日本の決定時点では
            やはり一日遅れです。守れるのは「米国発の荒れの持続」であり、初日のギャップは食らいます。
            また較正比率は過去1年窓なので、ボラ構造の急変（銘柄の業態変化等）には約1年遅れて追随します。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
