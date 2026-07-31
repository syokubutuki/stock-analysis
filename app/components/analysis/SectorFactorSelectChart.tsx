"use client";

// セクター内選別 ── 系C29。P0（前提診断）＋ P1（銘柄別 b̂ と S=b/σ_ε ランキング）。
//
// この投資家は「金利上昇局面では銀行にドリフトがある」と考えてセクターに集中している。
// 集中の是非を論じる前に前提を確かめ（P0）、そのうえで「セクター内のどれを買うか」を
// 測れる量だけで決める（P1）。
//
// P1 の設計で外してはいけない点:
//   銀行株は分散の 46% が市場由来で、セクター由来（22%）より大きい（P0 実測）。
//   b だけを見て選ぶと **金利プレイのつもりで単に高βの銘柄を買う**事故が起きる。
//   よって b と市場β は常に並置し、純度（セクター寄与/システマティック寄与）を必ず併記する。
//
// 描画は CLAUDE.md の規約どおり、横軸が時間でないので Canvas2D と HTML 表。
// 設計: docs/sector-factor-selection.md

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  computeSectorSelect,
  premiseVerdict,
  DEFAULT_SELECT_PARAMS,
  ASSUMED_SHARPE,
  type FactorSource,
  type SectorSelectResult,
  type AssetFactorFit,
} from "../../lib/sector-factor-select";
import { UNIVERSES, getUniverse } from "../../lib/universes";
import { fetchUniverse, parseTickerList } from "../../lib/universe-fetch";
import { useBenchmarkPrices } from "../../hooks/useBenchmarkPrices";
import SectorStabilityPanel, {
  useSectorStability,
  StabilityVerdictBadge,
  DEFAULT_STABILITY_CONTROLS,
  type StabilityControls,
} from "./SectorFactorStabilityPanel";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";
import DataQualityNotice from "./DataQualityNotice";

interface Props {
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
}

type UniverseMode = "watchlist" | "paste" | string;

const MARKET_TICKER = "1306.T"; // TOPIX ETF
const SECTOR_TICKER = "1615.T"; // 東証銀行業ETF
const RATE_TICKER = "^TNX"; // 米10年利回り（円金利は本APIで安定取得できないための代理）

const WINDOWS = [250, 500, 750, 1250];

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const signPct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;

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

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "bad" | "warn" | "neutral";
}) {
  const c =
    tone === "good"
      ? "text-green-700"
      : tone === "bad"
        ? "text-red-700"
        : tone === "warn"
          ? "text-amber-700"
          : "text-gray-800";
  return (
    <div className="rounded border border-gray-200 px-2.5 py-1.5">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-sm font-bold font-mono ${c}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400 leading-tight">{sub}</div>}
    </div>
  );
}

/** 分散の内訳を1本の積み上げバーで見せる（市場 / セクター / 固有）。 */
function ShareBar({ market, sector, resid }: { market: number; sector: number; resid: number }) {
  const seg = [
    { w: market, color: "bg-slate-400", label: "市場" },
    { w: sector, color: "bg-indigo-500", label: "セクター" },
    { w: resid, color: "bg-amber-400", label: "固有" },
  ];
  const total = seg.reduce((s, x) => s + x.w, 0) || 1;
  return (
    <div className="flex h-5 w-full overflow-hidden rounded border border-gray-200">
      {seg.map((s) => (
        <div
          key={s.label}
          className={`${s.color} flex items-center justify-center`}
          style={{ width: `${(s.w / total) * 100}%` }}
          title={`${s.label} ${pct(s.w / total)}`}
        >
          {s.w / total > 0.12 && (
            <span className="text-[10px] font-medium text-white">
              {s.label} {pct(s.w / total, 0)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** 純度の細いバー（表のセル内）。 */
function PurityBar({ v }: { v: number }) {
  const color = v >= 0.5 ? "bg-indigo-500" : v >= 0.25 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-1">
      <div className="h-1.5 w-10 overflow-hidden rounded bg-gray-200">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(100, v * 100)}%` }} />
      </div>
      <span className="font-mono text-[10px]">{pct(v, 0)}</span>
    </div>
  );
}

export default function SectorFactorSelectChart({ tickers, pricesByTicker, names }: Props) {
  const [uniMode, setUniMode] = useState<UniverseMode>("sec-bank");
  const [pasteRaw, setPasteRaw] = useState("");
  const [pasteTickers, setPasteTickers] = useState<string[]>([]);
  const [factorSource, setFactorSource] = useState<FactorSource>(DEFAULT_SELECT_PARAMS.factorSource);
  const [windowLen, setWindowLen] = useState(DEFAULT_SELECT_PARAMS.window);
  const [shrink, setShrink] = useState(DEFAULT_SELECT_PARAMS.shrink);
  const [topK, setTopK] = useState(DEFAULT_SELECT_PARAMS.topK);

  const [fetched, setFetched] = useState<{ prices: Record<string, PricePoint[]>; names: Record<string, string> }>({
    prices: {},
    names: {},
  });
  const [fetching, setFetching] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  // 因子系列は必ず /api/stock 経由（＝取得層のサニタイズを通す）。CLAUDE.md「価格データの取得」。
  const market = useBenchmarkPrices(MARKET_TICKER);
  const sector = useBenchmarkPrices(SECTOR_TICKER);
  const rate = useBenchmarkPrices(RATE_TICKER);
  const factorLoading = market.loading || sector.loading || rate.loading;

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
        for (const [tk, v] of Object.entries(res)) {
          if (v.prices.length > 0) {
            prices[tk] = v.prices;
            nm[tk] = v.name;
          }
        }
        const preset = getUniverse(uniMode);
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
  const activeNames = useMemo<Record<string, string>>(
    () => (uniMode === "watchlist" ? (names ?? {}) : fetched.names),
    [uniMode, names, fetched.names]
  );
  const activeCount = Object.keys(activePrices).length;
  const heldSet = useMemo(() => new Set(tickers), [tickers]);

  const factorPrices = useMemo(
    () =>
      market.prices
        ? {
            market: market.prices,
            sector: sector.prices,
            rate: rate.prices,
            marketTicker: MARKET_TICKER,
            sectorTicker: SECTOR_TICKER,
            rateTicker: RATE_TICKER,
          }
        : null,
    [market.prices, sector.prices, rate.prices]
  );

  const result = useMemo<SectorSelectResult | null>(() => {
    if (!factorPrices || activeCount < 3) return null;
    return computeSectorSelect(activePrices, factorPrices, {
      factorSource,
      window: windowLen,
      shrink,
      topK,
    });
  }, [factorPrices, activePrices, activeCount, factorSource, windowLen, shrink, topK]);

  // ── P2: 持続性の層（同じ画面に差し込む。docs/sector-factor-stability.md §7.6）──
  const [p2Controls, setP2Controls] = useState<StabilityControls>(DEFAULT_STABILITY_CONTROLS);
  const stability = useSectorStability(
    activePrices,
    factorPrices,
    p2Controls,
    useMemo(() => ({ factorSource, topK }), [factorSource, topK]),
    activeNames,
    activeCount >= 3
  );

  const diag = result?.premise ?? null;
  const verdict = diag ? premiseVerdict(diag) : null;

  const banner =
    verdict?.level === "ok"
      ? "border-green-300 bg-green-50"
      : verdict?.level === "weak"
        ? "border-amber-300 bg-amber-50"
        : "border-red-300 bg-red-50";
  const bannerText =
    verdict?.level === "ok" ? "text-green-800" : verdict?.level === "weak" ? "text-amber-800" : "text-red-800";

  // ── L1b: b の誤差バー図（収縮前→後の矢印つき）────────────────────────
  const barRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = barRef.current;
    if (!cv || !result) return;
    const rowH = 20;
    const init = initCanvas(cv, Math.max(140, result.assets.length * rowH + 46));
    if (!init) return;
    const { ctx, width, height } = init;
    const padL = 96;
    const padR = 16;
    const padT = 26;
    const plotW = width - padL - padR;

    const lo = Math.min(0, ...result.assets.map((a) => a.bLo));
    const hi = Math.max(...result.assets.map((a) => a.bHi));
    const span = hi - lo || 1;
    const x = (v: number) => padL + ((v - lo) / span) * plotW;

    // 目盛
    ctx.strokeStyle = "#e5e7eb";
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    const step = span > 2 ? 0.5 : 0.25;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      ctx.beginPath();
      ctx.moveTo(x(v), padT - 8);
      ctx.lineTo(x(v), height - 12);
      ctx.stroke();
      ctx.fillText(v.toFixed(2), x(v), padT - 12);
    }
    // 横断平均
    ctx.strokeStyle = "#6366f1";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x(result.bMean), padT - 8);
    ctx.lineTo(x(result.bMean), height - 12);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#6366f1";
    ctx.fillText("横断平均", x(result.bMean), height - 2);

    result.assets.forEach((a, i) => {
      const y = padT + i * rowH + rowH / 2;
      ctx.textAlign = "right";
      ctx.fillStyle = heldSet.has(a.ticker) ? "#1d4ed8" : "#374151";
      ctx.font = heldSet.has(a.ticker) ? "bold 10px sans-serif" : "10px sans-serif";
      const label = (activeNames[a.ticker] ?? a.ticker).slice(0, 10);
      ctx.fillText(label, padL - 8, y + 3);

      // 95%CI
      ctx.strokeStyle = a.purity >= 0.25 ? "#94a3b8" : "#fca5a5";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x(a.bLo), y);
      ctx.lineTo(x(a.bHi), y);
      ctx.stroke();
      for (const e of [a.bLo, a.bHi]) {
        ctx.beginPath();
        ctx.moveTo(x(e), y - 3);
        ctx.lineTo(x(e), y + 3);
        ctx.stroke();
      }
      // 収縮の矢印 b → b_JS
      if (Math.abs(a.bShrunk - a.b) > span * 0.004) {
        ctx.strokeStyle = "#c7d2fe";
        ctx.beginPath();
        ctx.moveTo(x(a.b), y);
        ctx.lineTo(x(a.bShrunk), y);
        ctx.stroke();
      }
      // 点推定
      ctx.fillStyle = a.purity >= 0.25 ? "#4f46e5" : "#dc2626";
      ctx.beginPath();
      ctx.arc(x(a.b), y, 3.2, 0, Math.PI * 2);
      ctx.fill();
      // 収縮後
      ctx.fillStyle = "#818cf8";
      ctx.beginPath();
      ctx.arc(x(a.bShrunk), y, 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [result, activeNames, heldSet]);

  // ── L1c: 市場β × セクターβ の散布（この画面の主張）─────────────────
  const scatRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = scatRef.current;
    if (!cv || !result) return;
    const init = initCanvas(cv, 300);
    if (!init) return;
    const { ctx, width, height } = init;
    const padL = 48;
    const padR = 14;
    const padT = 14;
    const padB = 34;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const xs = result.assets.map((a) => a.cMkt);
    const ys = result.assets.map((a) => a.b);
    const xLo = Math.min(0, ...xs) - 0.1;
    const xHi = Math.max(...xs) + 0.1;
    const yLo = Math.min(0, ...ys) - 0.1;
    const yHi = Math.max(...ys) + 0.1;
    const X = (v: number) => padL + ((v - xLo) / (xHi - xLo)) * plotW;
    const Y = (v: number) => padT + plotH - ((v - yLo) / (yHi - yLo)) * plotH;

    // 象限の基準は横断中央値
    const med = (a: number[]) => {
      const s = [...a].sort((p, q) => p - q);
      return s[Math.floor(s.length / 2)];
    };
    const mx = med(xs);
    const my = med(ys);

    // 象限の塗り分け（右上=高β高セクター, 左上=純粋な金利プレイ）
    ctx.fillStyle = "#eef2ff";
    ctx.fillRect(padL, padT, X(mx) - padL, Y(my) - padT); // 左上
    ctx.fillStyle = "#fef2f2";
    ctx.fillRect(X(mx), Y(my), padL + plotW - X(mx), padT + plotH - Y(my)); // 右下

    ctx.strokeStyle = "#cbd5e1";
    ctx.beginPath();
    ctx.moveTo(X(mx), padT);
    ctx.lineTo(X(mx), padT + plotH);
    ctx.moveTo(padL, Y(my));
    ctx.lineTo(padL + plotW, Y(my));
    ctx.stroke();

    // 枠と軸ラベル
    ctx.strokeStyle = "#d1d5db";
    ctx.strokeRect(padL, padT, plotW, plotH);
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("市場β（TOPIXへの感応度）→", padL + plotW / 2, height - 8);
    ctx.save();
    ctx.translate(12, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("セクターβ b（金利プレイの強さ）→", 0, 0);
    ctx.restore();

    for (let i = 0; i <= 4; i++) {
      const vx = xLo + ((xHi - xLo) * i) / 4;
      const vy = yLo + ((yHi - yLo) * i) / 4;
      ctx.fillStyle = "#9ca3af";
      ctx.textAlign = "center";
      ctx.fillText(vx.toFixed(2), X(vx), padT + plotH + 14);
      ctx.textAlign = "right";
      ctx.fillText(vy.toFixed(2), padL - 5, Y(vy) + 3);
    }

    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "#4f46e5";
    ctx.fillText("純粋な金利プレイ", padL + 6, padT + 12);
    ctx.textAlign = "right";
    ctx.fillStyle = "#dc2626";
    ctx.fillText("実は市場を買っているだけ", padL + plotW - 6, padT + plotH - 6);

    // 点
    result.assets.forEach((a) => {
      const held = heldSet.has(a.ticker);
      ctx.fillStyle = a.purity >= 0.5 ? "#4f46e5" : a.purity >= 0.25 ? "#f59e0b" : "#dc2626";
      ctx.beginPath();
      ctx.arc(X(a.cMkt), Y(a.b), held ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
      if (held) {
        ctx.strokeStyle = "#1d4ed8";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.fillStyle = "#374151";
      ctx.font = held ? "bold 9px sans-serif" : "9px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText((activeNames[a.ticker] ?? a.ticker).slice(0, 8), X(a.cMkt) + 7, Y(a.b) + 3);
    });
  }, [result, activeNames, heldSet]);

  const topAssets: AssetFactorFit[] = result ? result.assets.slice(0, topK) : [];
  /** P2 が「持続性を測れていない」と判定したら、推奨ウェイトは参考値として灰色化する。 */
  const tiltUnusable = stability.result?.persistence.indistinguishableFromNull ?? false;

  return (
    <div className="space-y-3">
      {/* ── 操作 ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-500">ユニバース</span>
        <select
          value={uniMode}
          onChange={(e) => setUniMode(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1"
        >
          <option value="sec-bank">業種:銀行（純）</option>
          {UNIVERSES.filter((u) => u.id !== "sec-bank").map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
          <option value="watchlist">ウォッチリスト</option>
          <option value="paste">貼り付け</option>
        </select>

        <span className="ml-1 text-gray-500">セクター因子</span>
        <div className="inline-flex overflow-hidden rounded border border-gray-300">
          {(["etf", "basket"] as FactorSource[]).map((s) => (
            <button
              key={s}
              onClick={() => setFactorSource(s)}
              className={`px-2 py-1 ${factorSource === s ? "bg-indigo-600 text-white" : "bg-white text-gray-600"}`}
            >
              {s === "etf" ? `ETF(${SECTOR_TICKER})` : "等加重(L-O-O)"}
            </button>
          ))}
        </div>

        <span className="ml-1 text-gray-500">窓</span>
        <div className="inline-flex overflow-hidden rounded border border-gray-300">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setWindowLen(w)}
              className={`px-2 py-1 ${windowLen === w ? "bg-indigo-600 text-white" : "bg-white text-gray-600"}`}
            >
              {(w / 250).toFixed(0)}年
            </button>
          ))}
        </div>

        <label className="ml-1 flex items-center gap-1">
          <input type="checkbox" checked={shrink} onChange={(e) => setShrink(e.target.checked)} />
          <span className="text-gray-600">JS収縮</span>
        </label>

        <span className="ml-1 text-gray-500">採用 k</span>
        <input
          type="range"
          min={1}
          max={Math.max(2, result?.assets.length ?? 8)}
          value={topK}
          onChange={(e) => setTopK(Number(e.target.value))}
          className="w-24"
        />
        <span className="font-mono text-gray-700">{topK}本</span>
      </div>

      {uniMode === "paste" && (
        <div className="flex items-center gap-2 text-xs">
          <input
            value={pasteRaw}
            onChange={(e) => setPasteRaw(e.target.value)}
            placeholder="8306.T 8316 8411 …"
            className="flex-1 rounded border border-gray-300 px-2 py-1 font-mono"
          />
          <button
            onClick={() => setPasteTickers(parseTickerList(pasteRaw))}
            className="rounded bg-gray-700 px-2 py-1 text-white"
          >
            読み込む
          </button>
        </div>
      )}

      {(fetching || factorLoading) && (
        <div className="text-xs text-gray-500">
          {factorLoading ? "因子系列（市場・セクターETF・金利）を取得中…" : `銘柄取得中 ${progress.done}/${progress.total}`}
        </div>
      )}

      {/* 因子側の破損開示。検索した銘柄のバナーには出ないので、ここで必ず見せる。 */}
      <DataQualityNotice report={market.dataQuality} />
      <DataQualityNotice report={sector.dataQuality} />
      <DataQualityNotice report={rate.dataQuality} />

      {[market, sector, rate].some((f) => f.error) && (
        <ul className="list-disc space-y-0.5 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
          {market.error && <li>市場指数 {MARKET_TICKER} を取得できなかった: {market.error}</li>}
          {sector.error && <li>セクターETF {SECTOR_TICKER} を取得できなかった（等加重バスケットで代用）。</li>}
          {rate.error && <li>金利プロキシ {RATE_TICKER} を取得できなかった（前提診断をスキップ）。</li>}
        </ul>
      )}

      {!result && !fetching && !factorLoading && (
        <div className="rounded border border-gray-200 px-3 py-4 text-xs text-gray-500">
          {activeCount < 3
            ? "銘柄が3本未満のため診断できない。ユニバースを選ぶか、ウォッチリストに銘柄を追加すること。"
            : "共通営業日が不足しているため診断できない。窓を短くするか、履歴の短い銘柄を外すこと。"}
        </div>
      )}

      {result && diag && verdict && (
        <>
          {/* ── P0-① 前提バナー ────────────────────────────── */}
          <div className={`rounded border px-3 py-2.5 ${banner}`}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className={`text-sm font-bold ${bannerText}`}>{verdict.label}</span>
              {diag.rateAvailable && (
                <span className="font-mono text-xs text-gray-700">
                  セクターの動きのうち金利で説明できるのは <b className="text-base">{pct(diag.rateR2, 1)}</b>
                  <span className="mx-1 text-gray-400">/</span>
                  金利+10bp → セクター <b className="text-base">{signPct(diag.rateBeta * 0.1, 2)}</b>
                  <span className="mx-1 text-gray-400">/</span>t = <b>{diag.rateT.toFixed(2)}</b>
                </span>
              )}
            </div>
            <div className={`mt-1 text-[11px] ${bannerText}`}>{verdict.detail}</div>
            <div className="mt-1 text-[10px] text-gray-500">
              金利プロキシ = {diag.rateProxyTicker}（米10年利回り、前営業日までに確定した変化を当日に対応づけ）。
              {diag.rateRescaled && " ※10倍表記を検出したため1/10に補正。"}
              円金利（JGB）は本APIで安定取得できないため代理変数である。
            </div>
          </div>

          {/* ── P1-① μ は測れないが b は測れる（実測値で）────────── */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded border border-red-200 bg-red-50/60 px-3 py-2">
              <div className="text-[11px] font-medium text-red-800">μ で選ぶ（C26: 不可能）</div>
              <div className="mt-1 font-mono text-xs text-gray-700">SE(μ̂) = σ/√T は観測頻度で縮まない</div>
              <div className="mt-1 font-mono text-lg font-bold text-red-700">
                観測 {pct(result.muSpreadObs, 0)} ／ ヌル {pct(result.muSpreadNull, 0)}
              </div>
              <div className="text-[10px] text-gray-500">
                μ̂ の銘柄間スプレッド（最大−最小）の実測値と、
                <b>真の μ が全銘柄同一でもノイズだけで出る大きさ</b>（勝者の呪い E[max−min]≈SE·2√(2 ln N)）。
                {result.muSpreadRatio < 1 ? (
                  <b className="text-red-700">
                    {" "}
                    実測はヌルの {result.muSpreadRatio.toFixed(2)} 倍 ＝ 過去リターンの順位はノイズと区別できない。
                  </b>
                ) : (
                  <>
                    {" "}実測はヌルの {result.muSpreadRatio.toFixed(2)} 倍。ヌルを超えてはいるが、
                    個別 μ の識別には Δμ=5pp あたり <b>{Math.round(result.muYearsFor5pp)}年</b>を要する。
                  </>
                )}
              </div>
            </div>
            <div className="rounded border border-green-200 bg-green-50/60 px-3 py-2">
              <div className="text-[11px] font-medium text-green-800">b で選ぶ（C29: 可能）</div>
              <div className="mt-1 font-mono text-xs text-gray-700">SE(b̂) = σ_ε/(σ_F√T) は観測頻度で縮む</div>
              <div className="mt-1 font-mono text-lg font-bold text-green-700">t = {result.spreadT.toFixed(1)}</div>
              <div className="text-[10px] text-gray-500">
                同じ標本・同じ2銘柄の b の差（Δb = {(result.assets[0].b - result.assets[result.assets.length - 1].b).toFixed(2)}）の t 値
              </div>
            </div>
          </div>

          {/* ── L2-A 判定バッジ（順位表を読む前に信用度を見せる）───── */}
          <StabilityVerdictBadge state={stability} />

          {/* ── P1-② ランキング表 ─────────────────────────── */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-gray-300 text-gray-500">
                  <th className="px-1.5 py-1 text-left">#</th>
                  <th className="px-1.5 py-1 text-left">銘柄</th>
                  <th className="px-1.5 py-1 text-right">セクターβ b̂ ± SE</th>
                  <th className="px-1.5 py-1 text-right">t</th>
                  <th className="px-1.5 py-1 text-right">市場β</th>
                  <th className="px-1.5 py-1 text-left">純度</th>
                  <th className="px-1.5 py-1 text-right">σ_ε</th>
                  <th className="px-1.5 py-1 text-right">S = b/σ_ε</th>
                  <th className="px-1.5 py-1 text-right">R²</th>
                  <th className="px-1.5 py-1 text-center">順位95%CI</th>
                  <th className="px-1.5 py-1 text-right">推奨w</th>
                </tr>
              </thead>
              <tbody>
                {result.assets.map((a) => {
                  const adopted = a.rank <= topK;
                  const held = heldSet.has(a.ticker);
                  return (
                    <tr
                      key={a.ticker}
                      className={`border-b border-gray-100 ${adopted ? "bg-indigo-50/50" : ""} ${held ? "ring-1 ring-inset ring-blue-300" : ""}`}
                    >
                      <td className="px-1.5 py-1 font-mono text-gray-500">{a.rank}</td>
                      <td className="px-1.5 py-1">
                        <span className={held ? "font-bold text-blue-700" : "text-gray-800"}>
                          {activeNames[a.ticker] ?? a.ticker}
                        </span>
                        {held && <span className="ml-1 text-[9px] text-blue-500">保有</span>}
                      </td>
                      <td className="px-1.5 py-1 text-right font-mono">
                        {a.b.toFixed(2)}
                        <span className="text-gray-400"> ± {a.bSe.toFixed(3)}</span>
                        {shrink && Math.abs(a.bShrunk - a.b) > 0.005 && (
                          <span className="ml-1 text-indigo-500">→{a.bShrunk.toFixed(2)}</span>
                        )}
                      </td>
                      <td className="px-1.5 py-1 text-right font-mono text-gray-600">{a.bT.toFixed(1)}</td>
                      <td className="px-1.5 py-1 text-right font-mono text-slate-600">{a.cMkt.toFixed(2)}</td>
                      <td className="px-1.5 py-1">
                        <PurityBar v={a.purity} />
                      </td>
                      <td className="px-1.5 py-1 text-right font-mono text-gray-600">{pct(a.sigmaEps, 0)}</td>
                      <td className="px-1.5 py-1 text-right font-mono font-bold text-indigo-700">
                        {a.score.toFixed(2)}
                      </td>
                      <td className="px-1.5 py-1 text-right font-mono text-gray-500">{pct(a.r2, 0)}</td>
                      <td className="px-1.5 py-1 text-center font-mono text-gray-500">
                        {a.rankLo === a.rankHi ? a.rankLo : `${a.rankLo}–${a.rankHi}`}
                      </td>
                      {/* 持続性が測れていないなら推奨wは参考値。灰色化して明示する
                          （DriftIdentifiabilityChart と同じ流儀）。 */}
                      <td
                        className={`px-1.5 py-1 text-right font-mono ${tiltUnusable ? "text-gray-400" : ""}`}
                        title={tiltUnusable ? "持続性を測れていないため参考値" : undefined}
                      >
                        {a.weight > 0 ? (
                          tiltUnusable ? (
                            pct(a.weight, 1)
                          ) : (
                            <b>{pct(a.weight, 1)}</b>
                          )
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="rounded bg-gray-50 px-2 py-1.5 text-[11px] leading-relaxed text-gray-600">
            <b>読み方</b>: ランクは <b>S = b/σ_ε</b>（露出 ÷ 払われないリスク）。b が最大の銘柄ではない点に注意 ──
            b の大きさはサイジングで作れるので選別の論点ではない。
            <b className="text-red-700"> 純度</b>は「セクター寄与 ÷（市場寄与＋セクター寄与）」で、
            低い銘柄は b が大きくても<b>金利ではなく市場全体に連動しているだけ</b>。
            順位95%CI が広い銘柄は、その順位がノイズの範囲にある。
          </div>

          {/* ── P1-③ 市場β × セクターβ 散布 ──────────────────── */}
          <div>
            <div className="mb-1 text-[11px] font-medium text-gray-700">
              金利プレイか、ただの高βか ─ 市場β × セクターβ
            </div>
            <canvas ref={scatRef} />
            <div className="mt-1 text-[10px] text-gray-500">
              左上（青）＝市場βが低くセクターβが高い＝<b>純粋な金利プレイ</b>。
              右下（赤）＝セクターβが低く市場βが高い＝<b>金利プレイのつもりで市場を買っている</b>。
              点の色は純度（青≥50% / 橙≥25% / 赤&lt;25%）、青い縁取りは保有銘柄。
              このユニバースでは分散の {pct(diag.marketShare, 0)} が市場由来・{pct(diag.sectorShare, 0)} が
              セクター由来なので、<b>b だけを見て選ぶと市場βを買ってしまう危険が大きい</b>。
            </div>
          </div>

          {/* ── P1-④ b の誤差バー ────────────────────────── */}
          <div>
            <div className="mb-1 text-[11px] font-medium text-gray-700">
              b̂ の95%信頼区間と James-Stein 収縮
            </div>
            <canvas ref={barRef} />
            <div className="mt-1 text-[10px] text-gray-500">
              区間が重なっている銘柄同士は、b の差に意味がない。小さい点は収縮後の b（横断平均へ寄せた値）。
              収縮率 <b>{pct(result.shrinkFactor, 0)}</b> ＝ 見かけの銘柄間差のうち推定ノイズと整合する割合。
              赤い区間は純度25%未満（＝金利プレイとして読んではいけない銘柄）。
            </div>
          </div>

          {/* ── 採用集合の要約 ──────────────────────────── */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label={`採用 ${topK}本の加重 b`}
              value={topAssets.reduce((s, a) => s + a.weight * a.b, 0).toFixed(2)}
              sub="w ∝ b/σ_ε² で加重した露出"
              tone="good"
            />
            <Stat
              label={`採用 ${topK}本の加重 市場β`}
              value={topAssets.reduce((s, a) => s + a.weight * a.cMkt, 0).toFixed(2)}
              sub="ここが大きいなら金利でなく市場を買っている"
              tone={topAssets.reduce((s, a) => s + a.weight * a.cMkt, 0) > 1.2 ? "warn" : "neutral"}
            />
            <Stat
              label="収縮率（ノイズ割合）"
              value={pct(result.shrinkFactor, 0)}
              sub="大きいほど順位は信用できない"
              tone={result.shrinkFactor > 0.3 ? "bad" : "good"}
            />
            <Stat
              label="順位ブート"
              value={`${result.nBootDone}回`}
              sub={`ブロック長 ${result.params.blockLen}日`}
            />
          </div>

          {/* ── P2: 持続性の層（L2-A〜D ＋ 建玉への翻訳）──────────── */}
          <SectorStabilityPanel
            state={stability}
            controls={p2Controls}
            setControls={setP2Controls}
            names={activeNames}
            heldSet={heldSet}
          />

          {/* ── P0-② 分散の内訳と相関 ───────────────────────── */}
          <div className="rounded border border-gray-200 px-3 py-2.5">
            <div className="mb-2 text-[11px] font-medium text-gray-700">
              「分散できていない」の中身 ─ 高い相関は敵か味方か
            </div>
            <ShareBar market={diag.marketShare} sector={diag.sectorShare} resid={diag.residShare} />
            <div className="mt-1 text-[10px] text-gray-500">
              平均的な1銘柄の分散の内訳。<b className="text-indigo-600">セクター</b>＝賭けている部分（払われている）。
              <b className="text-amber-600">固有</b>＝何の見解も持っていない部分（払われていない＝分散すべき）。
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                label="生の平均相関 ρ̄"
                value={diag.meanRho.toFixed(2)}
                sub={`実効独立数 ${diag.nEffRaw.toFixed(1)} / ${diag.universeSize}本`}
                tone="bad"
              />
              <Stat
                label="残差の平均相関 ρ̄_ε"
                value={diag.meanRhoResid !== null ? diag.meanRhoResid.toFixed(2) : "識別不能"}
                sub={
                  diag.nEffResid !== null
                    ? `実効独立数 ${diag.nEffResid.toFixed(1)} / ${diag.universeSize}本`
                    : "外生因子（ETF）が要る"
                }
                tone={diag.meanRhoResid !== null ? "good" : "warn"}
              />
              <Stat
                label="5本に分けたときのσ低減"
                value={diag.sigmaCutK5 !== null ? `−${pct(diag.sigmaCutK5, 1)}` : "—"}
                sub="露出を削らずに落ちる分・上界"
                tone={diag.sigmaCutK5 !== null ? "good" : "neutral"}
              />
              <Stat
                label="拾える成長率（年率）"
                value={diag.growthGainK5 !== null ? `+${(diag.growthGainK5 * 100).toFixed(1)}pp` : "—"}
                sub={`g*=SR²/2, SR=${ASSUMED_SHARPE} を仮定`}
                tone={diag.growthGainK5 !== null ? "good" : "neutral"}
              />
            </div>
          </div>

          {/* ── 標本と警告 ───────────────────────────── */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="標本" value={`${diag.nObs}日`} sub={`${diag.dateFrom} 〜 ${diag.dateTo}`} />
            <Stat label="銘柄数" value={`${diag.universeSize}本`} sub={`終端生存 ${diag.survivorsToEnd}本`} />
            <Stat
              label="使用した因子"
              value={diag.usedFactorSource === "etf" ? `ETF ${SECTOR_TICKER}` : "等加重 L-O-O"}
              sub={
                diag.etfVsBasketCorr !== null
                  ? `ETFと等加重の相関 ${diag.etfVsBasketCorr.toFixed(3)}`
                  : "ETF未取得のため等加重"
              }
            />
            <Stat label="金利対応日数" value={diag.rateAvailable ? `${diag.rateN}日` : "—"} sub={diag.rateProxyTicker} />
          </div>

          {(diag.warnings.length > 0 || result.warnings.length > 0) && (
            <ul className="list-disc space-y-1 rounded border border-gray-200 bg-gray-50 px-4 py-2 text-[11px] text-gray-600">
              {result.warnings.map((w, i) => (
                <li key={`s${i}`}>{w}</li>
              ))}
              {diag.warnings.map((w, i) => (
                <li key={`p${i}`}>{w}</li>
              ))}
            </ul>
          )}

          <div className="rounded border border-indigo-200 bg-indigo-50/50 px-3 py-2 text-[11px] text-indigo-900">
            <b>次の層（P3）</b>: b̂ の統計誤差は小さく（t={result.spreadT.toFixed(1)}）、順位の持続性も P2 で測った
            {stability.result && (
              <>
                （π({stability.result.persistence.decisionH}日) ={" "}
                <b>{stability.result.persistence.piPoint.toFixed(2)}</b>）
              </>
            )}
            。残る問いは<b>「その順位に賭けて床（等加重）に勝てるか」</b>で、これは順位が持続することとは別の主張である。
            P3 でウォークフォワードの超過を検定し、その手前に
            <b>「市場ヘッジ後の純度と成長率」</b>（採用集合の加重市場βが 1 を超えるなら、σ² の大半は賭けていないものから来ている）
            を置く。
            <b className="text-red-700"> 現時点の推奨ウェイトは前向き検証を経ていない</b>ため、
            発注に使う前に P3 の判定を待つこと。
          </div>
        </>
      )}

      <AnalysisGuide title="セクター内選別の詳細理論（前提診断＋感応度ランキング）">
        <p className="font-medium text-gray-700">1. この分析は何をしているか</p>
        <p>
          特定セクター（銀行など）に意図的に集中している投資家に対して、
          <b>「セクター内のどの銘柄を・どの比率で持つか」</b>を、測れる量だけで決めます。
          「どの銘柄が一番上がるか」は問いません（それは原理的に測れないため。下記3参照）。
        </p>
        <p>
          手順は2段です。まず<b>前提の検証</b>: 賭けているセクターが、思っている駆動因子（金利）で
          実際に動いているか。次に<b>感応度による選別</b>: 各銘柄がそのファクターにどれだけ連動し、
          その連動を得るためにどれだけ「払われないリスク」を負っているか。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>個別銘柄のリターンを、市場・セクター・固有の3つに分解します。</p>
        <p className="font-mono text-[11px] bg-white/70 rounded px-2 py-1">
          {"r_i,t = α_i + c_i·M_t + b_i·F_t + ε_i,t"}
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"M_t: 市場ファクター（TOPIX ETF 1306.T の対数リターン）"}</li>
          <li>
            {"F_t: セクター・ファクター。銀行業ETF(1615.T)または等加重バスケットを、市場 M に回帰した残差"}
            （＝市場と無相関にした「銀行だけの動き」）
          </li>
          <li>{"c_i: 市場β / b_i: セクター感応度（選別の主役）/ ε_i: 固有リターン"}</li>
        </ul>
        <p>市場とセクターを直交化してあるので、分散はきれいに3つに割れます。</p>
        <p className="font-mono text-[11px] bg-white/70 rounded px-2 py-1">
          {"Var(r_i) = c_i²Var(M) + b_i²Var(F) + Var(ε_i)"}
        </p>
        <p>前提の検証は、セクター因子を金利プロキシの変化に回帰して行います。</p>
        <p className="font-mono text-[11px] bg-white/70 rounded px-2 py-1">
          {"F_t = a + β·Δy_{t-1} + u_t   （Δy = 前営業日までに確定した10年利回りの変化, 単位 pp）"}
        </p>
        <p>
          標準誤差はすべて Newey-West（HAC, lag=5）で、残差の自己相関と不均一分散に頑健にしています。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. なぜ μ ではなく b で選ぶのか（この分析の核心）</p>
        <p>
          系C26 が示した通り、個別銘柄の期待ドリフト μ は測れません。対数リターンの標本平均は
          {" "}<span className="font-mono">{"μ̂ = log(P_T/P_0)/T"}</span>{" "}
          という<b>両端2点だけの恒等式</b>なので、日足を分足にしても値が変わらず、
          精度 <span className="font-mono">{"SE(μ̂) = σ/√T"}</span> は観測頻度でまったく縮みません。
        </p>
        <p>
          ところが回帰係数の精度は <span className="font-mono">{"SE(b̂) = σ_ε/(σ_F·√T)"}</span> で、
          毎日の観測が情報として入るぶん<b>頻度で縮みます</b>。
          画面上段の2枚のカードが、これを<b>あなたのユニバースの実測値</b>で並べたものです
          （μ の差を識別するのに必要な年数 vs 同じ標本での b の差の t 値）。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. ランク基準 S = b/σ_ε の導出</p>
        <p>投資家がセクターに見解 E[F]=m&gt;0 を持つとき、シャープレシオは</p>
        <p className="font-mono text-[11px] bg-white/70 rounded px-2 py-1">
          {"SR_i = b_i·m / √(b_i²σ_F² + σ_ε,i²) = m / √(σ_F² + (σ_ε,i/b_i)²)"}
        </p>
        <p>
          となり、<b>m が順位から消えます</b>。つまり「金利上昇がどれだけ強いか」を推定しなくてよく、
          必要なのは <b>m &gt; 0 の符号だけ</b>。順序は σ_ε/b の小ささだけで決まるので、
          ランク基準は <b>S = b/σ_ε</b>（＝情報比）になります。
        </p>
        <p>
          <b>b が最大の銘柄を選ぶのは誤りです。</b> b の大きさはレバレッジと等価（2b を半分の建玉で持つのと
          b を満額で持つのは同じ露出）なので、大きさはサイジングで作れます。選別で問うべきは
          「同じ露出を、より少ない<b>払われないリスク</b>で得られるか」です。
        </p>
        <p>最適ウェイトは1ファクター模型の下で Sherman-Morrison により閉形式になります。</p>
        <p className="font-mono text-[11px] bg-white/70 rounded px-2 py-1">
          {"Σ = σ_F²bb' + D ⇒ w ∝ Σ⁻¹b = D⁻¹b/(1+σ_F²b'D⁻¹b) ⇒ w_i ∝ b_i/σ_ε,i²"}
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 「純度」がなぜ要るか（この画面で最も事故りやすい点）</p>
        <p>
          このユニバースでは<b>分散の約46%が市場由来で、セクター由来（約22%）より大きい</b>のが実測値です。
          つまり銀行株を買うことの大半は「日本株を買うこと」であって「金利に賭けること」ではありません。
        </p>
        <p>
          この状態で b だけを見て選ぶと、<b>金利プレイのつもりで単に高βの銘柄を買う</b>事故が起きます。
          そこで純度を定義します。
        </p>
        <p className="font-mono text-[11px] bg-white/70 rounded px-2 py-1">
          {"純度 = b²Var(F) / ( c²Var(M) + b²Var(F) )"}
        </p>
        <p>
          1 に近いほど純粋な金利プレイ、0 に近いほど「市場を買っているだけ」。散布図の左上（市場β低・
          セクターβ高）が狙うべき領域で、右下は避けるべき領域です。
        </p>

        <p className="font-medium text-gray-700 mt-3">6. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>セクターβ b</b>: セクター全体が1%動いたとき、その銘柄が何%動くか</li>
          <li><b>市場β c</b>: 市場（TOPIX）が1%動いたとき何%動くか。F は市場に直交化済みなので、この係数は単回帰の市場βと一致する</li>
          <li><b>固有ボラ σ_ε</b>: 市場でもセクターでも説明できない、その銘柄だけの値動きの大きさ（年率）</li>
          <li><b>James-Stein 収縮</b>: 推定値を横断平均に寄せる操作。収縮率が「見かけの差のうちノイズの割合」の推定になる</li>
          <li><b>順位95%CI</b>: ブロック・ブートストラップ（時間の塊ごと再標本化して横断相関を保存）で b を測り直したときに、その銘柄の順位が収まる範囲</li>
          <li><b>leave-one-out</b>: 銘柄 i の b を測るとき因子バスケットから i 自身を除くこと。自分を含むバスケットに自分を回帰すると b̂ が構造的に上振れする</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 直感的な例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>b はエンジンの排気量ではなくギア比</b>。同じアクセル（金利上昇）でどれだけ加速するかを決める。
            ギア比が高い車が速いのは坂を登るときだけで、<b>下りでも同じだけ速く落ちる</b>。
          </li>
          <li>
            <b>純度は「その車が本当に坂道用か」</b>。速いけれど平地でも速いだけの車（高β）を、
            坂道に強い車（高純度）と取り違えないための指標です。
          </li>
          <li>
            <b>相関には二種類ある</b>。全員が同じ船に乗っているから一緒に揺れる（＝ファクター、欲しい揺れ）のと、
            別々の理由で偶然同じ方向に揺れる（＝固有、要らない揺れ）。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">8. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>前提バナー</b>: 緑なら選別へ進んでよい。黄・赤なら銘柄より先に「何に賭けているか」を定義し直す</li>
          <li><b>S の順位</b>: 上から買う候補。ただし<b>順位95%CI が広い銘柄は順位に意味がない</b></li>
          <li><b>b̂ の誤差バーが重なる銘柄同士</b>: b の差は測れていない。並び順を信じない</li>
          <li><b>収縮率</b>: 30% を超えたら、見かけの差の相当部分がノイズ。等加重に寄せるべき</li>
          <li><b>純度が25%未満（赤）</b>: b が大きくても金利プレイではない。散布図の右下に居る銘柄</li>
          <li><b>採用k本の加重市場β</b>: これが 1.2 を超えるなら、選んだ束は実質「レバレッジをかけた日本株」です</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">9. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>ランクは b でなく S = b/σ_ε で見る</b>。b の大きさは建玉の大きさで作れる</li>
          <li><b>推奨ウェイト w ∝ b/σ_ε² を配分の出発点にする</b>。均等でも b 順でもない</li>
          <li><b>k は 5〜8 本</b>。セクター露出を保ったまま固有リスクだけ削れる（下段のσ低減）</li>
          <li><b>純度の低い銘柄を外す</b>。金利観に賭けたいなら、市場βで薄めない</li>
          <li>
            <b>選別は増幅であって創出ではない</b>。期待値の源泉はあなたの金利観であり、
            銘柄選別はその倍率を決めるだけ。労力配分としては金利観の検証のほうが重要です
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">10. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>まだ前向き検証をしていない</b>。ここに出ている b・S・ウェイトはすべて<b>同じ期間で測った値</b>で、
            「この順位が来年も続くか」は未検証です（P2/P3 で扱う）。発注に使う前に必ずその判定を見てください
          </li>
          <li>
            <b>b̂ の律速は統計誤差ではなく時変性</b>。SE は小さいので「測れるか」はもう問題ではなく、
            バランスシートや金融政策レジームの変化で b 自体が動くことのほうが効きます
          </li>
          <li>
            <b>金利プロキシは代理変数</b>。円金利が本APIで安定取得できないため米10年利回りを使っています。
            日米金利の連動が弱い局面では R² が過小に出ます
          </li>
          <li>
            <b>ETFモードの自己混入</b>: ETF には各銘柄自身が時価加重で含まれるため b̂ にわずかな上方バイアスが
            残ります（メガバンクほど大きい）。厳密には等加重(leave-one-out)モードを使ってください
          </li>
          <li>
            <b>生存者バイアス</b>: 地銀は統合・再編で消えた行が多く、現在のリストは過去の勝者に偏っています
          </li>
          <li>
            <b>推奨ウェイトは long-only ＋1銘柄上限をかけた後の値</b>で、厳密な最適解ではありません
          </li>
          <li>
            <b>R² が高いことは将来を保証しない</b>: これは「過去にこう動いていた」という記述であって、
            「これから金利が上がる」でも「上がれば同じだけ動く」でもありません
          </li>
        </ul>
      </AnalysisGuide>

      <AxiomPlacement corollaryId="C29" />
    </div>
  );
}
