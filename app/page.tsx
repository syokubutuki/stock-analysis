"use client";

import { useCallback, useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { track } from "@vercel/analytics";
import { useAnalysisData, PeriodKey } from "./hooks/useAnalysisData";
import PeriodSelector from "./components/analysis/PeriodSelector";
import SeriesModeSelector from "./components/analysis/SeriesModeSelector";
import WatchlistPanel from "./components/WatchlistPanel";
import TickerSearchInput from "./components/TickerSearchInput";
import AccordionSection, {
  AnalysisAvailabilityProvider,
} from "./components/analysis/AccordionSection";
import ChartPlaceholder from "./components/analysis/ChartPlaceholder";
import DataQualityNotice from "./components/analysis/DataQualityNotice";
import CollapsibleAnalysis from "./components/analysis/CollapsibleAnalysis";
import DirectionValue from "./components/analysis/DirectionValue";
import { formatSummaryPrice } from "./lib/format";
import { SeriesMode } from "./lib/series-mode";
import {
  CLOSE_ONLY_CAUTION_PANEL_IDS,
  CLOSE_ONLY_UNAVAILABLE_PANEL_IDS,
  panelProps,
  SECTIONS,
  SERIES_AWARE_SECTIONS,
  STANDALONE_PANELS,
  sectionByKey,
  sectionForPanel,
  workspaceProps,
  type PanelRenderContext,
  type SectionKey,
} from "./lib/panel-registry";
import { OPEN_PANEL_EVENT, type OpenPanelDetail } from "./lib/panel-nav";
import { recordTicker } from "./lib/test-ledger";

// 分析パネル 251件の配線（動的 import・所属節・入力の形・終値だけの系列での扱い）は
// すべて `app/lib/panel-registry.tsx` にある。ここに個別のパネルを書かないこと。
//
// 以下の2件はレジストリの外に残している。どちらもパネル一覧の項目ではなく、
// 「その節の地の部分」だからである:
//   - UnifiedChart     … 基本節のヒーローチャート。常時表示でパネルIDを持たない
//   - DataQualityPanel … 破損点検の中身。配置（サマリーの前か後か）と既定の開閉が
//                        その銘柄の破損の有無で決まるため、アコーディオンの項目にできない。
//                        IDと見出しは registry の STANDALONE_PANELS が持つ
const UnifiedChart = dynamic(
  () => import("./components/analysis/UnifiedChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={500} /> }
);
const DataQualityPanel = dynamic(
  () => import("./components/analysis/DataQualityPanel"),
  { ssr: false, loading: () => <ChartPlaceholder height={200} /> }
);

const DATA_QUALITY_PANEL = STANDALONE_PANELS.find((p) => p.id === "data-quality")!;

const SECTION_KEYS = new Set<SectionKey>(SECTIONS.map(({ key }) => key));
const PERIOD_KEYS = new Set<PeriodKey>(["1m", "3m", "6m", "1y", "2y", "3y", "5y", "10y"]);
const SERIES_MODES = new Set<SeriesMode>([
  "close", "diff", "logReturn", "open", "overnightReturn", "intradayReturn",
]);
const DEFAULT_TICKER = "7203.T";
const PANEL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

function replacePanelParam(panel: string | null) {
  const url = new URL(window.location.href);
  if (panel) url.searchParams.set("panel", panel);
  else url.searchParams.delete("panel");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export default function AnalysisPage() {
  const { data, allPrices, filteredPrices, loading, error, fetchStock, period, setPeriod } =
    useAnalysisData();
  const [activeSection, setActiveSection] = useState<SectionKey>("basic");
  const [seriesMode, setSeriesMode] = useState<SeriesMode>("close");
  const [tickerInput, setTickerInput] = useState("");
  const [restored, setRestored] = useState(false);
  // 折りたたみ節: 一括開閉（アクティブ節で共有）
  const [sectionBulk, setSectionBulk] = useState<{ nonce: number; open: boolean }>({
    nonce: 0,
    open: false,
  });
  const bumpBulk = useCallback(
    (open: boolean) => setSectionBulk((b) => ({ nonce: b.nonce + 1, open })),
    []
  );
  // ヘッダー本体は通常フローに置き、ページと一緒に自然にスクロールアウトさせる。
  // 本体が画面外に出た状態で上スクロールしたときだけ、検索窓のみの浮動バーを出す。
  const [showFloat, setShowFloat] = useState(false);
  const headerBarRef = useRef<HTMLDivElement>(null);

  // 初回マウント時は共有URLを最優先し、不足する項目だけ前回状態で補う。
  // 初回利用者には既定銘柄を読み込み、空の分析画面を見せない。
  const restoredRef = useRef(false);
  const initialPanelRef = useRef<string | null>(null);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const urlSection = params.get("sec") as SectionKey | null;
    const urlMode = params.get("mode") as SeriesMode | null;
    const urlPeriod = params.get("period") as PeriodKey | null;
    const urlTicker = params.get("ticker")?.trim() || null;
    const urlPanel = params.get("panel");

    let savedSection: SectionKey | null = null;
    let savedMode: SeriesMode | null = null;
    let savedPeriod: PeriodKey | null = null;
    let savedTicker: string | null = null;
    try {
      savedSection = localStorage.getItem("sa:section") as SectionKey | null;
      savedMode = localStorage.getItem("sa:seriesMode") as SeriesMode | null;
      savedPeriod = localStorage.getItem("sa:period") as PeriodKey | null;
      savedTicker = localStorage.getItem("sa:lastTicker");
    } catch {
      // localStorage 利用不可（プライベートモード等）の場合は無視
    }

    // `panel` は所属セクションが決まっているので、`sec` より優先する。
    // 両者が食い違う共有URL（節をまたぐジャンプの後にコピーされた等）では、以前は
    // 指定された節にそのパネルが無く、60フレーム探して無言で諦めていた。
    const panelSection = urlPanel ? sectionForPanel(urlPanel) : null;
    const nextSection = SECTION_KEYS.has(panelSection as SectionKey)
      ? (panelSection as SectionKey)
      : SECTION_KEYS.has(urlSection as SectionKey)
      ? urlSection
      : SECTION_KEYS.has(savedSection as SectionKey) ? savedSection : "basic";
    const nextMode = SERIES_MODES.has(urlMode as SeriesMode)
      ? urlMode
      : SERIES_MODES.has(savedMode as SeriesMode) ? savedMode : "close";
    const nextPeriod = PERIOD_KEYS.has(urlPeriod as PeriodKey)
      ? urlPeriod
      : PERIOD_KEYS.has(savedPeriod as PeriodKey) ? savedPeriod : "6m";
    const nextTicker = urlTicker ?? savedTicker?.trim() ?? DEFAULT_TICKER;

    setActiveSection(nextSection ?? "basic");
    setSeriesMode(nextMode ?? "close");
    setPeriod(nextPeriod ?? "6m");
    setTickerInput(nextTicker);

    if (urlPanel && PANEL_ID_PATTERN.test(urlPanel)) {
      initialPanelRef.current = urlPanel;
      try { localStorage.setItem(`sa:open:${urlPanel}`, "1"); } catch {}
    }
    fetchStock(nextTicker);
    setRestored(true);
  }, [fetchStock, setPeriod]);

  // 現在の分析状態を共有可能なURLへ反映する。パネルIDは共通ラッパーが管理するため、
  // ここでは既存の panel パラメータを保ったまま他の状態だけを同期する。
  useEffect(() => {
    if (!restored || !data?.ticker) return;
    const url = new URL(window.location.href);
    url.searchParams.set("ticker", data.ticker);
    url.searchParams.set("sec", activeSection);
    url.searchParams.set("period", period);
    url.searchParams.set("mode", seriesMode);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [activeSection, data?.ticker, period, restored, seriesMode]);

  // 共有URLで指定されたパネルを、データ取得とセクション描画の完了後に表示する。
  useEffect(() => {
    const panel = initialPanelRef.current;
    if (!panel || !data?.ticker) return;
    let tries = 0;
    const tick = () => {
      const el = document.getElementById(`panel-${panel}`);
      if (el) {
        initialPanelRef.current = null;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.classList.add("sa-flash");
        setTimeout(() => el.classList.remove("sa-flash"), 1200);
        return;
      }
      if (tries++ < 60) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [activeSection, data?.ticker]);

  const submitTicker = useCallback((ticker: string) => {
    const normalized = ticker.trim();
    if (!normalized) return;
    track("search_ticker", { ticker: normalized });
    fetchStock(normalized);
  }, [fetchStock]);

  const changeSection = useCallback((section: SectionKey) => {
    replacePanelParam(null);
    setActiveSection(section);
    track("section_change", { section });
  }, []);

  // 取得成功した銘柄・現在の表示状態を保存する
  useEffect(() => {
    if (data?.ticker) {
      try {
        localStorage.setItem("sa:lastTicker", data.ticker);
      } catch {}
      // 多重検定台帳(実測): 閲覧した銘柄を記録し、家族サイズに反映する。
      recordTicker(data.ticker);
    }
  }, [data?.ticker]);
  useEffect(() => {
    try {
      localStorage.setItem("sa:section", activeSection);
    } catch {}
  }, [activeSection]);
  useEffect(() => {
    try {
      localStorage.setItem("sa:seriesMode", seriesMode);
    } catch {}
  }, [seriesMode]);
  useEffect(() => {
    try {
      localStorage.setItem("sa:period", period);
    } catch {}
  }, [period]);

  // 浮動検索バーの表示制御。ヘッダー本体が見えている間は出さず、
  // 画面外に出た後の上スクロールでスライドイン / 下スクロールでスライドアウトする。
  // ±6px の閾値はスクロール量の揺れによるちらつき防止。
  useEffect(() => {
    let lastY = window.scrollY;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        const dy = y - lastY;
        const bar = headerBarRef.current;
        const barBottom = bar ? bar.offsetTop + bar.offsetHeight : 200;
        if (y <= barBottom) {
          setShowFloat(false); // ヘッダー本体が見えている → 浮動バー不要
        } else if (dy > 6) {
          setShowFloat(false); // 下スクロール → スライドアウト
        } else if (dy < -6) {
          setShowFloat(true); // 上スクロール → 検索窓だけスライドイン
        }
        lastY = y;
        ticking = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Series Explorer の系列グループから対応する詳細分析セクションへジャンプする。
  // タブを切り替えた後、保留中のアンカー DOM を探してスクロール＆ハイライトする。
  const pendingScrollRef = useRef<string | null>(null);
  const navigateToSection = useCallback((section: string, anchor?: string) => {
    // 折りたたみ化した節では、ジャンプ先パネルを開いた状態でマウントさせるため
    // 事前に localStorage の開閉フラグを立てておく（CollapsibleAnalysis が遅延初期化で読む）。
    if (anchor) {
      try { localStorage.setItem(`sa:open:${anchor}`, "1"); } catch {}
    }
    replacePanelParam(anchor ?? null);
    pendingScrollRef.current = anchor ?? null;
    setActiveSection(section as SectionKey);
  }, []);
  useEffect(() => {
    const id = pendingScrollRef.current;
    if (!id) return;
    pendingScrollRef.current = null;
    // セクション切替→再レンダリング→要素出現のタイミング差を rAF リトライで吸収する
    let tries = 0;
    const tick = () => {
      // 従来の素の div アンカー(sa-*) と、折りたたみパネル(panel-sa-*) の両方に対応
      const el = document.getElementById(id) || document.getElementById(`panel-${id}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.classList.add("sa-flash");
        setTimeout(() => el.classList.remove("sa-flash"), 1200);
        return;
      }
      if (tries++ < 10) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [activeSection]);

  // 別の分析からの「このパネルを開いて」（openAnalysisPanel）が節をまたぐ場合を受ける。
  // CollapsibleAnalysis 側の購読はマウント済みのパネルにしか届かないため、他の節の
  // パネルを指すと誰も応答せず**無言で何も起きない**。ここで節を切り替えて拾う。
  // 同じ節なら CollapsibleAnalysis が処理するので何もしない（二重スクロールを避ける）。
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenPanelDetail>).detail;
      if (!detail?.id) return;
      const target = sectionForPanel(detail.id);
      if (!target || target === activeSection || !SECTION_KEYS.has(target as SectionKey)) return;
      navigateToSection(target, detail.id);
    };
    window.addEventListener(OPEN_PANEL_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(OPEN_PANEL_EVENT, onOpen as EventListener);
  }, [activeSection, navigateToSection]);

  const hasDataQualityIssues =
    (data?.dataQuality?.repaired.length ?? 0) > 0 ||
    (data?.dataQuality?.suspects.length ?? 0) > 0;
  const hasCloseOnlyMarketData = useMemo(
    () => allPrices.length > 0 && allPrices.every((price) =>
      price.volume === 0 &&
      price.open === price.close &&
      price.high === price.close &&
      price.low === price.close
    ),
    [allPrices],
  );

  // 破損点検は「どこをどう直したか」の詳細（表＋修復前後チャート）。
  // 報告は10年の全期間に対するものなので、表示期間ではなく allPrices を渡す。
  // 問題がある場合はサマリーより先に、問題がなければサマリーの後に開示する。
  //
  // 配置は「基本」節の1か所だけにする。以前は全セクションの共通ヘッダ部に置いていたため、
  // どの節へ切り替えてもその節の分析本体の手前に点検パネルが挟まり、破損ゼロの銘柄でも
  // 毎回最上段を占めていた。CLAUDE.md の「手を入れたことは画面に開示する」規約は、
  // 全ページ共通の DataQualityNotice バナー（破損・疑いがあるときだけ描画）が担保する。
  // バナーからは他節にいても onOpenPanel でこのパネルへ戻れる。
  const dataQualityPanel = data ? (
    <CollapsibleAnalysis
      id={DATA_QUALITY_PANEL.id}
      title={DATA_QUALITY_PANEL.title}
      subtitle={DATA_QUALITY_PANEL.subtitle}
      defaultOpen={hasDataQualityIssues}
    >
      <DataQualityPanel
        ticker={data.ticker}
        prices={allPrices}
        report={data.dataQuality}
      />
    </CollapsibleAnalysis>
  ) : null;

  // レジストリへ渡す描画コンテキスト。どのパネルにどれを渡すかは
  // 各レコードの `input` が決める（panelProps）。ここに分岐を持たせない。
  const renderContext = useMemo<PanelRenderContext | null>(
    () =>
      data
        ? {
            filteredPrices,
            allPrices,
            period,
            seriesMode,
            ticker: data.ticker,
            currency: data.currency,
          }
        : null,
    [allPrices, data, filteredPrices, period, seriesMode],
  );

  // 2つの寿命を別々に持つ（FU41）。
  //   summaryScope … 最終足を含む。表示中のバッジが古い数字でないかを決める
  //   openScope    … 銘柄と期間だけ。「すべて開く」がどこまで有効かを決める（U2）
  // 混ぜると、データが後から確定しただけで一括開放が巻き戻る。
  const summaryScope = data
    ? `${data.ticker}:${period}:${filteredPrices.at(-1)?.time ?? "empty"}:${filteredPrices.at(-1)?.close ?? "empty"}`
    : "";
  const openScope = data ? `${data.ticker}:${period}` : "";

  const activeSectionDef = sectionByKey(activeSection);
  const accordionGroups = useMemo(() => {
    if (!renderContext || activeSectionDef?.render !== "panels") return [];
    return activeSectionDef.groups.map((g) => ({
      group: g.group,
      items: g.panels.map((p) => ({
        id: p.id,
        title: p.title,
        node: <p.Component {...panelProps(p.input, renderContext)} />,
      })),
    }));
  }, [activeSectionDef, renderContext]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-4">
        <div className="max-w-7xl mx-auto flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-gray-900">株価構造分析</h1>
            <p className="text-sm text-gray-500 mt-1">
              市場の隠れた構造をデータから抽出する
            </p>
          </div>
          <div className="shrink-0 flex items-center flex-wrap gap-2">
            <Link
              href="/guide"
              className="text-sm text-blue-600 hover:text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50"
            >
              分析ガイド
            </Link>
            <Link
              href="/axioms"
              className="text-sm text-indigo-600 hover:text-indigo-700 border border-indigo-200 rounded-lg px-3 py-1.5 hover:bg-indigo-50"
            >
              株式原論
            </Link>
            <Link
              href="/portfolio"
              className="text-sm text-blue-600 hover:text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50"
            >
              ポートフォリオ
            </Link>
            <Link
              href="/feedback"
              className="text-sm text-blue-600 hover:text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50"
            >
              ご意見・ご要望
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        {/* ヘッダー本体: 検索 + 期間/系列 + セクションタブ。通常フローに置き、
            下スクロールではページと一緒に自然にスクロールアウトする。 */}
        <div
          ref={headerBarRef}
          className="-mx-4 px-4 py-3 border-b border-gray-200 space-y-2"
        >
          <div className="flex items-center gap-3 flex-wrap">
            <TickerSearchInput
              value={tickerInput}
              onChange={setTickerInput}
              onSubmit={submitTicker}
              loading={loading}
            />
            <WatchlistPanel
              currentTicker={data?.ticker ?? null}
              currentName={data?.name ?? null}
              onSelect={(ticker) => {
                setTickerInput(ticker);
                fetchStock(ticker);
              }}
            />
            {data && (
              <>
                <span className="text-gray-600 text-sm font-medium">
                  {data.name}
                </span>
                <PeriodSelector current={period} onChange={setPeriod} />
                {/* セレクタ用の行高は常に確保し、セクション切替時のレイアウトシフトを防ぐ。 */}
                <div className="basis-full min-h-7 min-w-0 w-full">
                  <SeriesModeSelector
                    current={seriesMode}
                    onChange={setSeriesMode}
                    disabled={!SERIES_AWARE_SECTIONS.has(activeSection)}
                  />
                </div>
              </>
            )}
          </div>

          {/* セクションタブ。全幅で横1行のスクロール帯にして、項目数が多くても
              ファーストビューを縦に押し下げない。 */}
          {data && filteredPrices.length > 0 && (
            <div className="flex gap-1 overflow-x-auto pb-1" aria-label="分析の目的を選ぶ">
              {SECTIONS.map(({ key, label, method }) => (
                <button
                  key={key}
                  onClick={() => changeSection(key)}
                  aria-pressed={activeSection === key}
                  className={`shrink-0 whitespace-nowrap px-3 py-1.5 text-left text-sm rounded font-medium leading-tight transition-colors ${
                    activeSection === key
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  <span className="block">{label}</span>
                  <span className={`block text-[11px] font-normal ${
                    activeSection === key ? "text-blue-100" : "text-gray-500"
                  }`}>
                    {method}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 浮動検索バー: ヘッダー本体が画面外のとき、上スクロールで検索窓だけが現れる。
            fixed なのでレイアウトに影響せず、非表示時は transform で画面外に退避。 */}
        <div
          className={`fixed top-0 left-0 right-0 z-30 bg-gray-50/95 backdrop-blur-sm border-b border-gray-200 transition-transform duration-200 ${
            showFloat ? "translate-y-0" : "-translate-y-full"
          }`}
        >
          <div className="max-w-7xl mx-auto px-4 py-2">
            <TickerSearchInput
              value={tickerInput}
              onChange={setTickerInput}
              onSubmit={submitTicker}
              loading={loading}
            />
          </div>
        </div>

        {error && (
          <div className="bg-red-50 text-red-700 rounded-lg p-3 text-sm">
            {error}
          </div>
        )}

        <DataQualityNotice
          report={data?.dataQuality}
          onOpenPanel={() => navigateToSection("basic", "data-quality")}
        />

        {data && filteredPrices.length > 0 && (
          <>
            <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600">
              <span className="font-medium text-gray-800">
                {SECTIONS.find(s => s.key === activeSection)?.label}
              </span>
              <span className="ml-1 text-gray-500">
                （{SECTIONS.find(s => s.key === activeSection)?.method}）
              </span>
              <span className="mt-1 block">
                {SECTIONS.find(s => s.key === activeSection)?.description}
              </span>
            </div>

            <div className="flex flex-col gap-4">
              {activeSection === "basic" && (
                <div className={hasDataQualityIssues ? "order-1" : "order-2"}>
                  {dataQualityPanel}
                </div>
              )}

              {/* サマリー */}
              <div
                className={`grid grid-cols-2 sm:grid-cols-4 gap-3 ${
                  hasDataQualityIssues ? "order-2" : "order-1"
                }`}
              >
                <SummaryCard
                  label="現在値"
                  value={formatSummaryPrice(
                    filteredPrices[filteredPrices.length - 1].close,
                    data.currency
                  )}
                />
                <SummaryCard
                  label="期間始値"
                  value={formatSummaryPrice(filteredPrices[0].close, data.currency)}
                />
                <SummaryCard
                  label="期間変動"
                  value={(() => {
                    const change =
                      ((filteredPrices[filteredPrices.length - 1].close -
                        filteredPrices[0].close) /
                        filteredPrices[0].close) *
                      100;
                    return (
                      <DirectionValue value={change}>
                        {`${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
                      </DirectionValue>
                    );
                  })()}
                />
                <SummaryCard
                  label="データ数"
                  value={`${filteredPrices.length}日`}
                />
              </div>
            </div>

            {/* セクション内容 */}
            {/* セクション内容。パネルの定義は app/lib/panel-registry.tsx が持つ。 */}
            <AnalysisAvailabilityProvider
              active={hasCloseOnlyMarketData}
              unavailableItemIds={CLOSE_ONLY_UNAVAILABLE_PANEL_IDS}
              cautionItemIds={CLOSE_ONLY_CAUTION_PANEL_IDS}
              summaryScope={summaryScope}
              openScope={openScope}
            >
              <div className="space-y-6">
                {activeSection === "basic" && (
                  <>
                    {/* Series Explorer は常時表示のヒーローチャート（ジャンプの起点） */}
                    {hasCloseOnlyMarketData ? (
                      <div
                        className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
                        role="note"
                      >
                        この銘柄は基準価額だけが配信され、始値・高値・安値は終値と同一、出来高は0です。
                        Series Explorerの価格推移は利用できますが、ローソク足の形や出来高は解釈できません。
                      </div>
                    ) : null}
                    <UnifiedChart prices={allPrices} period={period} onNavigate={navigateToSection} />
                  </>
                )}

                {activeSectionDef?.render === "workspace" && activeSectionDef.Workspace && renderContext && (
                  <activeSectionDef.Workspace {...workspaceProps(renderContext)} />
                )}

                {activeSectionDef?.render === "panels" && (
                  <AccordionSection
                    bulk={sectionBulk}
                    onBulk={bumpBulk}
                    groups={accordionGroups}
                  />
                )}
              </div>
            </AnalysisAvailabilityProvider>
          </>
        )}

        {restored && !data && !loading && !error && (
          <div className="py-12">
            <div className="max-w-4xl mx-auto">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 text-sm">
                {SECTIONS.map(({ key, label, method, description }) => (
                  <div key={key} className="p-3 rounded-lg border border-gray-200">
                    <div className="font-medium text-gray-700 mb-0.5">{label}</div>
                    <div className="text-xs text-gray-500 mb-1">{method}</div>
                    <div className="text-xs text-gray-500">{description}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="text-center text-xs text-gray-500 py-8 space-y-1">
        <p>株価データはYahoo Financeより取得。投資判断の参考としてご利用ください。</p>
        <p>
          <Link href="/guide" className="text-blue-500 hover:text-blue-600 underline">
            分析手法の数式・読み方はこちら
          </Link>
          <span aria-hidden="true"> ・ </span>
          <Link href="/feedback" className="text-blue-500 hover:text-blue-600 underline">
            機能改善のご意見・ご要望はこちら
          </Link>
        </p>
      </footer>
    </div>
  );
}

function SummaryCard({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-bold text-gray-800">
        {value}
      </div>
    </div>
  );
}
