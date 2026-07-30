"use client";

// セクター内選別 ── 系C27 の P0（前提診断）。
//
// この投資家は「金利上昇局面では銀行にドリフトがある」と考えてセクターに集中している。
// 集中の是非を論じる前に、まず**その前提が実データで成り立つか**だけを最小コストで確かめる層。
//
//   ① セクター因子は本当に金利で動いているか（R²・符号・NW t）
//      → ここが崩れたら、以降の銘柄選別（P1: b/σ_ε ランキング）は別の因子で組み直すべき
//   ② μ は測れないが b は測れる、という非対称性を同じ標本で数値化する（C26 との並置）
//   ③ 高相関の「中身」を市場/セクター/固有に割り、生の ρ̄ と残差の ρ̄_ε を並べる
//      → 分散できていないのは共通ファクター（＝欲しいもの）なのか固有部分なのかを切り分ける
//   ④ ③の帰結として、1本集中が捨てている成長率を年率 pp で出す
//
// 描画は数値主体（HTML）。P1 以降で表・誤差バー（Canvas2D）・ローリング b（lightweight-charts）を積む。
// 設計: docs/sector-factor-selection.md

import { useEffect, useMemo, useState } from "react";
import { PricePoint, StockData } from "../../lib/types";
import {
  computeSectorPremise,
  premiseVerdict,
  DEFAULT_PREMISE_PARAMS,
  ASSUMED_SHARPE,
  type FactorSource,
  type PremiseDiag,
} from "../../lib/sector-factor-select";
import { UNIVERSES, getUniverse } from "../../lib/universes";
import { fetchUniverse, parseTickerList } from "../../lib/universe-fetch";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";

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
function ShareBar({ d }: { d: PremiseDiag }) {
  const seg = [
    { w: d.marketShare, color: "bg-slate-400", label: "市場" },
    { w: d.sectorShare, color: "bg-indigo-500", label: "セクター" },
    { w: d.residShare, color: "bg-amber-400", label: "固有" },
  ];
  const total = seg.reduce((s, x) => s + x.w, 0) || 1;
  return (
    <div>
      <div className="flex h-6 w-full overflow-hidden rounded border border-gray-200">
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
      <div className="mt-1 text-[10px] text-gray-500">
        平均的な1銘柄の分散の内訳。
        <b className="text-indigo-600">セクター</b>＝あなたが賭けている部分（払われている）。
        <b className="text-amber-600">固有</b>＝何の見解も持っていない部分（払われていない＝分散すべき）。
      </div>
    </div>
  );
}

export default function SectorFactorSelectChart({ tickers, pricesByTicker, names }: Props) {
  const [uniMode, setUniMode] = useState<UniverseMode>("sec-bank");
  const [pasteRaw, setPasteRaw] = useState("");
  const [pasteTickers, setPasteTickers] = useState<string[]>([]);
  const [factorSource, setFactorSource] = useState<FactorSource>(DEFAULT_PREMISE_PARAMS.factorSource);
  const [windowLen, setWindowLen] = useState(DEFAULT_PREMISE_PARAMS.window);

  const [fetched, setFetched] = useState<{ prices: Record<string, PricePoint[]>; names: Record<string, string> }>({
    prices: {},
    names: {},
  });
  const [fetching, setFetching] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  // 因子系列（市場・セクターETF・金利プロキシ）は銘柄ユニバースと別に取得する。
  const [factorData, setFactorData] = useState<{
    market: PricePoint[];
    sector: PricePoint[] | null;
    rate: PricePoint[] | null;
  } | null>(null);
  const [factorErr, setFactorErr] = useState<string[]>([]);
  const [factorLoading, setFactorLoading] = useState(true);

  const uniTickers = useMemo<string[]>(() => {
    if (uniMode === "watchlist") return tickers;
    if (uniMode === "paste") return pasteTickers;
    return getUniverse(uniMode)?.tickers.map((t) => t.ticker) ?? [];
  }, [uniMode, tickers, pasteTickers]);

  // ── 銘柄ユニバースの取得 ──────────────────────────────────────────
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

  // ── 因子系列の取得（1回だけ）─────────────────────────────────────
  useEffect(() => {
    const ctrl = new AbortController();
    const one = async (tk: string): Promise<PricePoint[] | null> => {
      try {
        const res = await fetch(`/api/stock?ticker=${encodeURIComponent(tk)}&range=10y`, { signal: ctrl.signal });
        const json = (await res.json()) as StockData & { error?: string };
        if (!res.ok || !json.prices?.length) return null;
        return json.prices;
      } catch {
        return null;
      }
    };
    const load = async () => {
      setFactorLoading(true);
      const [market, sector, rate] = await Promise.all([one(MARKET_TICKER), one(SECTOR_TICKER), one(RATE_TICKER)]);
      if (ctrl.signal.aborted) return;
      const errs: string[] = [];
      if (!market) errs.push(`市場指数 ${MARKET_TICKER} を取得できなかった。`);
      if (!sector) errs.push(`セクターETF ${SECTOR_TICKER} を取得できなかった（等加重バスケットで代用する）。`);
      if (!rate) errs.push(`金利プロキシ ${RATE_TICKER} を取得できなかった（前提診断をスキップする）。`);
      setFactorErr(errs);
      setFactorData(market ? { market, sector, rate } : null);
      setFactorLoading(false);
    };
    load();
    return () => ctrl.abort();
  }, []);

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

  const diag = useMemo<PremiseDiag | null>(() => {
    if (!factorData || activeCount < 3) return null;
    return computeSectorPremise(
      activePrices,
      {
        market: factorData.market,
        sector: factorData.sector,
        rate: factorData.rate,
        marketTicker: MARKET_TICKER,
        sectorTicker: SECTOR_TICKER,
        rateTicker: RATE_TICKER,
      },
      { factorSource, window: windowLen }
    );
  }, [factorData, activePrices, activeCount, factorSource, windowLen]);

  const verdict = diag ? premiseVerdict(diag) : null;

  const banner =
    verdict?.level === "ok"
      ? "border-green-300 bg-green-50"
      : verdict?.level === "weak"
        ? "border-amber-300 bg-amber-50"
        : "border-red-300 bg-red-50";
  const bannerText =
    verdict?.level === "ok" ? "text-green-800" : verdict?.level === "weak" ? "text-amber-800" : "text-red-800";

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

        <span className="ml-2 text-gray-500">セクター因子</span>
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

        <span className="ml-2 text-gray-500">窓</span>
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

      {factorErr.length > 0 && (
        <ul className="list-disc space-y-0.5 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
          {factorErr.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      {!diag && !fetching && !factorLoading && (
        <div className="rounded border border-gray-200 px-3 py-4 text-xs text-gray-500">
          {activeCount < 3
            ? "銘柄が3本未満のため診断できない。ユニバースを選ぶか、ウォッチリストに銘柄を追加すること。"
            : "共通営業日が不足しているため診断できない。窓を短くするか、履歴の短い銘柄を外すこと。"}
        </div>
      )}

      {diag && verdict && (
        <>
          {/* ── ① 前提バナー: これがこの層の主役 ───────────────── */}
          <div className={`rounded border px-3 py-2.5 ${banner}`}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className={`text-sm font-bold ${bannerText}`}>{verdict.label}</span>
              {diag.rateAvailable && (
                <span className="font-mono text-xs text-gray-700">
                  セクターの動きのうち金利で説明できるのは{" "}
                  <b className="text-base">{pct(diag.rateR2, 1)}</b>
                  <span className="mx-1 text-gray-400">/</span>
                  金利+10bp → セクター{" "}
                  <b className="text-base">{signPct(diag.rateBeta * 0.1, 2)}</b>
                  <span className="mx-1 text-gray-400">/</span>t = <b>{diag.rateT.toFixed(2)}</b>
                </span>
              )}
            </div>
            <div className={`mt-1 text-[11px] ${bannerText}`}>{verdict.detail}</div>
            <div className="mt-1 text-[10px] text-gray-500">
              金利プロキシ = {diag.rateProxyTicker}（米10年利回り、前営業日までに確定した変化を当日に対応づけ）。
              {diag.rateRescaled && " ※10倍表記を検出したため1/10に補正。"}
              円金利（JGB）は本APIで安定取得できないため代理変数である。この R² 自体が代理の妥当性の指標でもある。
            </div>
          </div>

          {/* ── ② μ は測れないが b は測れる ────────────────────── */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded border border-red-200 bg-red-50/60 px-3 py-2">
              <div className="text-[11px] font-medium text-red-800">μ で選ぶ（C26: 不可能）</div>
              <div className="mt-1 font-mono text-xs text-gray-700">
                SE(μ̂) = σ/√T は観測頻度で縮まない
              </div>
              <div className="mt-1 font-mono text-lg font-bold text-red-700">T* ≈ 144年</div>
              <div className="text-[10px] text-gray-500">
                σ=30%・Δμ=5pp・κ=2 のとき、銘柄間のドリフト差を t&gt;2 で識別するのに必要な期間
              </div>
            </div>
            <div className="rounded border border-green-200 bg-green-50/60 px-3 py-2">
              <div className="text-[11px] font-medium text-green-800">b で選ぶ（C27: 可能）</div>
              <div className="mt-1 font-mono text-xs text-gray-700">
                SE(b̂) = σ_ε/(σ_F√T) は観測頻度で縮む
              </div>
              <div className="mt-1 font-mono text-lg font-bold text-green-700">
                この標本で {(diag.nObs / 250).toFixed(1)}年 ＝ {diag.nObs}日
              </div>
              <div className="text-[10px] text-gray-500">
                同じ標本で Δb=0.30 は t≈9 で分離できる。銘柄別の b̂ とその誤差は P1 で表にする
              </div>
            </div>
          </div>

          {/* ── ③ 高相関の中身 ──────────────────────────────── */}
          <div className="rounded border border-gray-200 px-3 py-2.5">
            <div className="mb-2 text-[11px] font-medium text-gray-700">
              「分散できていない」の中身 ─ 高い相関は敵か味方か
            </div>
            <ShareBar d={diag} />
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
                sub="露出（b）は一切削らずに落ちる分・上界"
                tone={diag.sigmaCutK5 !== null ? "good" : "neutral"}
              />
              <Stat
                label="拾える成長率（年率）"
                value={diag.growthGainK5 !== null ? `+${(diag.growthGainK5 * 100).toFixed(1)}pp` : "—"}
                sub={`g*=SR²/2, SR=${ASSUMED_SHARPE} を仮定`}
                tone={diag.growthGainK5 !== null ? "good" : "neutral"}
              />
            </div>
            <div className="mt-2 rounded bg-gray-50 px-2 py-1.5 text-[11px] leading-relaxed text-gray-600">
              {diag.meanRhoResid === null || diag.sigmaCutK5 === null ? (
                <>
                  生の相関は <b>{diag.meanRho.toFixed(2)}</b>。ただし残差相関 ρ̄_ε は
                  <b>この構成では識別できない</b>。パネル内の平均を引いた残差は、真の相関が何であっても
                  平均ペア相関が恒等的に <b>−1/(N−1) = {(-1 / Math.max(1, diag.universeSize - 1)).toFixed(3)}</b>{" "}
                  になり情報が消えるため。セクターETFが取得できれば外生因子として使えるので、
                  取得エラーを解消するか窓を短くして再試行すること。
                </>
              ) : (
                <>
                  生の相関 <b>{diag.meanRho.toFixed(2)}</b> のうち、共通ファクターを取り除くと残差の相関は{" "}
                  <b>{diag.meanRhoResid.toFixed(2)}</b> まで落ちる。
                  {diag.meanRho - diag.meanRhoResid > 0.2 ? (
                    <>
                      {" "}
                      つまり<b>相関が高いのは、あなたが欲しくて買っている共通部分</b>のせいであって、
                      分散の失敗ではない。ただし固有部分（{pct(diag.residShare, 0)}）は何の見解も持っていない
                      払われないリスクなので、ここだけは分散できる ──
                      <b className="text-green-700">
                        {" "}
                        セクターに集中したまま5本に分ければ σ が {pct(diag.sigmaCutK5, 1)} 落ちる
                      </b>
                      。1本集中はこれを捨てている（ただしこの利得は上界。ETF の構成に自銘柄が含まれるぶん
                      ρ̄_ε は下方に偏る）。
                    </>
                  ) : (
                    <>
                      {" "}
                      共通ファクターを除いても相関が高いままで、固有部分にも強い連動が残っている。
                      この場合は本数を増やしてもσがあまり落ちないため、分散の余地は小さい。
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          {/* ── 標本と診断 ───────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="標本"
              value={`${diag.nObs}日`}
              sub={`${diag.dateFrom} 〜 ${diag.dateTo}`}
            />
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

          {/* 実際に診断へ入った銘柄（共通営業日が取れなかった銘柄は落ちている）。 */}
          <div className="flex flex-wrap gap-1">
            {diag.usedTickers.map((t) => (
              <span
                key={t}
                className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] text-gray-600"
                title={t}
              >
                {activeNames[t] ?? t}
              </span>
            ))}
          </div>

          {diag.warnings.length > 0 && (
            <ul className="list-disc space-y-1 rounded border border-gray-200 bg-gray-50 px-4 py-2 text-[11px] text-gray-600">
              {diag.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <div className="rounded border border-indigo-200 bg-indigo-50/50 px-3 py-2 text-[11px] text-indigo-900">
            <b>次の層（P1）</b>: この前提の上に、銘柄別の b̂±SE・S = b/σ_ε のランキング・推奨ウェイト
            w ∝ b/σ_ε² を積む。
            {verdict.level !== "ok" && (
              <b className="text-red-700">
                {" "}
                ただし現状は前提の裏づけが取れていないため、P1 へ進む前に因子（金利プロキシ・セクター定義・期間）を
                見直すべき。
              </b>
            )}
          </div>
        </>
      )}

      <AnalysisGuide title="セクター内選別の詳細理論（前提診断）">
        <p className="font-medium text-gray-700">1. この分析は何をしているか</p>
        <p>
          特定セクター（銀行など）に意図的に集中している投資家に対して、「その集中の根拠になっている前提が、
          実データで成り立っているか」だけを先に確かめる層です。「どの銘柄が上がるか」はまだ問いません。
          先に問うのは <b>「あなたが賭けているファクターは、あなたが思っている駆動因子で動いているか」</b> です。
        </p>
        <p>
          銀行に集中する理由が「金利上昇局面のドリフト」であるなら、銀行セクターの値動きは金利の動きで
          ある程度説明できていなければおかしい。それを R²・回帰係数の符号・t 値で測ります。
          ここが崩れているなら、銘柄選別をどれだけ精密にやっても土台が無いことになります。
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
          <li>{"b_i: セクター感応度。選別の主役"}</li>
          <li>{"ε_i: 固有リターン。この投資家が何の見解も持っていない部分"}</li>
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
          β &gt; 0 かつ有意なら「金利上昇＝セクター上昇」が成り立っています。R² はセクターの動きのうち
          金利で説明できる割合です。標準誤差は Newey-West（HAC, lag=5）で、残差の自己相関と
          不均一分散に頑健にしています。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. なぜ μ ではなく b で選ぶのか（この分析の核心）</p>
        <p>
          系C26 が示した通り、個別銘柄の期待ドリフト μ は測れません。対数リターンの標本平均は
          {" "}<span className="font-mono">{"μ̂ = log(P_T/P_0)/T"}</span>{" "}
          という<b>両端2点だけの恒等式</b>なので、日足を分足にしても値が変わらず、
          精度 <span className="font-mono">{"SE(μ̂) = σ/√T"}</span> は観測頻度でまったく縮みません。
          σ=30%・Δμ=5pp を t&gt;2 で識別するには約144年かかります。
        </p>
        <p>
          ところが回帰係数の精度は <span className="font-mono">{"SE(b̂) = σ_ε/(σ_F·√T)"}</span> で、
          毎日の観測が情報として入るぶん<b>頻度で縮みます</b>。
          日次3年・σ_ε≈1.0%/日・σ_F≈1.6%/日なら SE(b̂)≈0.023 で、b=1.30 と b=1.00 の差は t≈9 で分離できます。
        </p>
        <p>
          <b>同じ3年のデータで、μ の差は見えず b の差ははっきり見える。</b>
          この非対称性だけが、セクター内選別を成立させる足場です。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>ファクター感応度 b</b>: セクター全体が1%動いたとき、その銘柄が何%動くか。「連動の強さ」
          </li>
          <li>
            <b>固有ボラ σ_ε</b>: 市場でもセクターでも説明できない、その銘柄だけの値動きの大きさ
          </li>
          <li>
            <b>直交化</b>: ある系列から別の系列で説明できる成分を回帰で取り除くこと。ここでは
            セクター因子から市場成分を抜き、「銀行だけの動き」を作るのに使う
          </li>
          <li>
            <b>leave-one-out</b>: 銘柄 i の b を測るとき、因子バスケットから i 自身を除くこと。
            自分を含むバスケットに自分を回帰すると b̂ が構造的に上振れするため
          </li>
          <li>
            <b>実効独立数 N_eff</b>: <span className="font-mono">{"N/(1+(N−1)ρ̄)"}</span>。
            N本持っていても相関のせいで「実質何本ぶんの分散になっているか」
          </li>
          <li>
            <b>Newey-West 標準誤差</b>: 残差に自己相関・不均一分散があっても妥当な誤差評価を与える方法
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 直感的な例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>b はエンジンの排気量ではなくギア比</b>。同じアクセル（金利上昇）でどれだけ加速するかを決める。
            ギア比が高い車が速いのは坂を登るときだけで、<b>下りでも同じだけ速く落ちる</b>。
            だから b が高い銘柄が「良い銘柄」なのではなく、あなたの見立てが当たったときだけ良い銘柄です。
          </li>
          <li>
            <b>相関には二種類ある</b>。全員が同じ船に乗っているから一緒に揺れる（＝ファクター、欲しい揺れ）のと、
            全員が別々の理由で偶然同じ方向に揺れる（＝固有、要らない揺れ）。
            この分析は、あなたのポートフォリオの揺れがどちらなのかを分離します。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>緑「前提と整合」</b>: 金利上昇がセクター上昇と有意に結びついている。感応度による選別（P1）へ進んでよい
          </li>
          <li>
            <b>黄「裏づけが弱い」</b>: R² が 2% 未満、または |t| &lt; 2。セクターは動いていても駆動因子は金利以外の
            可能性が高い。因子や期間を変えて再確認すること
          </li>
          <li>
            <b>赤「符号が逆／検証不能」</b>: 金利上昇でセクターが有意に下がっている、または金利プロキシが取れていない。
            この状態で銘柄選別に進んでも、増幅する対象そのものが存在しない
          </li>
          <li>
            <b>ρ̄ と ρ̄_ε の差</b>: 差が大きい（0.2以上）ほど、高相関の正体は共通ファクターであり、
            「分散できていない」という悩みの大半は<b>あなたが意図して買ったもの</b>です
          </li>
          <li>
            <b>σ低減と成長率</b>: 固有部分だけを5本に分散したときの効果。露出 b を一切削らずに拾える分なので、
            ここがプラスである限り1本集中に合理性はありません
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>まず前提を確認してから銘柄を考える</b>。バナーが赤・黄のうちは、どの銘柄を選ぶかより
            「何に賭けているのか」を定義し直すほうが期待値が大きい
          </li>
          <li>
            <b>集中の単位を「セクター」に置き、「銘柄」には置かない</b>。
            セクターに集中したまま5〜8本に分けるのが、露出を保ったままリスクだけ削る唯一の方法
          </li>
          <li>
            <b>固有シェアが大きいセクターほど分散の価値が高い</b>。バーの黄色が広いなら本数を増やす効果が大きい
          </li>
          <li>
            <b>選別は増幅であって創出ではない</b>。期待値の源泉はあなたの金利観であり、
            銘柄選別はその倍率を決めるだけ。労力配分としては金利観の検証のほうが重要です
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">8. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>金利プロキシは代理変数</b>。円金利（JGB 10年）が本APIで安定取得できないため、米10年利回り
            (^TNX) を使っています。日米金利の連動が弱い局面では R² が過小に出ます
          </li>
          <li>
            <b>時差の扱い</b>: 米国の当日終値は日本の翌営業日にしか効かないため、前営業日までに確定した変化を
            当日に対応づけています。ここを揃えないと見かけの有意性が水増しされます
          </li>
          <li>
            <b>ETFモードの自己混入</b>: ETF には各銘柄自身が時価加重で含まれるため、b̂ にわずかな上方バイアスが
            残ります（メガバンクほど大きい）。厳密には等加重(leave-one-out)モードを使ってください
          </li>
          <li>
            <b>生存者バイアス</b>: 地銀は統合・再編で消えた行が多く、現在のリストは過去の勝者に偏っています。
            全銘柄が終端まで生存している場合は警告を出します
          </li>
          <li>
            <b>σ低減の数値は等相関近似</b>: 全ペアの残差相関が等しいと仮定した概算です。
            成長率 pp への換算は SR={ASSUMED_SHARPE} という<b>仮定</b>を置いています（推定値ではありません）
          </li>
          <li>
            <b>R² が高いことは将来を保証しない</b>: これは「過去に金利で動いていた」という記述であって、
            「これから金利が上がる」でも「上がれば同じだけ動く」でもありません。
            b の時間安定性は P2、床（等加重）に勝てるかは P3 で検証します
          </li>
        </ul>
      </AnalysisGuide>

      <AxiomPlacement corollaryId="C29" />
    </div>
  );
}
