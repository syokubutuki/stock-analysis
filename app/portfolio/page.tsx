"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  WatchlistItem,
  WatchKind,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  updateWatchlistItem,
  effectiveKind,
} from "../lib/watchlist";
import {
  Horizon,
  HORIZON_CONFIG,
  HORIZONS,
  SignalDigest,
  Position,
  evaluateHeld,
  evaluateTarget,
  HeldEval,
  TargetEval,
  HELD_BADGE_META,
  TARGET_BADGE_META,
} from "../lib/signal-digest";
import {
  PortfolioSnapshot,
  DiffResult,
  getSnapshot,
  saveSnapshot,
  diffAgainstSnapshot,
} from "../lib/portfolio-snapshot";
import { usePortfolioData } from "../hooks/usePortfolioData";
import { usePortfolioDigests } from "../hooks/usePortfolioDigests";
import { useBadgeBacktest } from "../hooks/useBadgeBacktest";
import { useStopCompare } from "../hooks/useStopCompare";
import { classifySignalEvent, SIGNAL_EVENT_META } from "../lib/signal-digest";
import { BacktestResult } from "../lib/badge-backtest";
import AccordionSection, { AccordionItem } from "../components/analysis/AccordionSection";
import dynamic from "next/dynamic";

const PortfolioRiskPanel = dynamic(
  () => import("../components/analysis/PortfolioRiskPanel"),
  { ssr: false }
);
const EfficientFrontierChart = dynamic(
  () => import("../components/analysis/EfficientFrontierChart"),
  { ssr: false }
);
const CapmSmlChart = dynamic(
  () => import("../components/analysis/CapmSmlChart"),
  { ssr: false }
);
const OosBacktestChart = dynamic(
  () => import("../components/analysis/OosBacktestChart"),
  { ssr: false }
);
const ResampledFrontierChart = dynamic(
  () => import("../components/analysis/ResampledFrontierChart"),
  { ssr: false }
);
const BadgeTrackRecordPanel = dynamic(
  () => import("../components/analysis/BadgeTrackRecordPanel"),
  { ssr: false }
);
const StopComparePanel = dynamic(
  () => import("../components/analysis/StopComparePanel"),
  { ssr: false }
);
const WeekdayUsCrossChart = dynamic(
  () => import("../components/analysis/WeekdayUsCrossChart"),
  { ssr: false }
);

type ViewFilter = "all" | "held" | "target" | "changed";

interface Row {
  item: WatchlistItem;
  kind: WatchKind;
  digest: SignalDigest;
  held?: HeldEval;
  target?: TargetEval;
  badge: string;
  badgeColor: string;
  priority: number;
  diff: DiffResult;
  urgent: boolean; // 要対応(損切り警告 / エントリー好機 / 変化あり)
  sparkCloses: number[]; // 直近終値(ミニチャート用)
}

const COLOR_CLASS: Record<string, string> = {
  red: "bg-red-100 text-red-700 border-red-200",
  amber: "bg-amber-100 text-amber-700 border-amber-200",
  green: "bg-green-100 text-green-700 border-green-200",
  gray: "bg-gray-100 text-gray-600 border-gray-200",
};

// 左端の太線(判定色)
const BORDER_CLASS: Record<string, string> = {
  red: "border-l-red-400",
  amber: "border-l-amber-400",
  green: "border-l-green-400",
  gray: "border-l-gray-300",
};

type Tone = "good" | "warn" | "bad" | "neutral";
// 値は常に表示し、色は「注意・警戒」だけを浮かせる(平常はグレー)。
const TONE_TEXT: Record<Tone, string> = {
  good: "text-emerald-600",
  warn: "text-amber-600 font-medium",
  bad: "text-red-600 font-semibold",
  neutral: "text-gray-600",
};

interface SignalStat {
  label: string; // 指標名(短縮)
  display: string; // 表示する実数値
  tone: Tone;
  title: string; // ホバー時の補足
}

// 判定の根拠となる実数値。色は注意/警戒を浮かせるための補助で、数値そのものを見せる。
function signalStats(d: SignalDigest): SignalStat[] {
  const dirArrow = d.direction === "up" ? "↑" : d.direction === "down" ? "↓" : "→";
  const dirTone: Tone = d.highVol ? "bad" : d.direction === "up" ? "good" : d.direction === "down" ? "bad" : "neutral";
  const hurstTone: Tone = d.hurst < 0.45 ? "warn" : "neutral";
  const zTone: Tone = Math.abs(d.meanRevZ) > 2 ? "warn" : "neutral";
  const volTone: Tone = d.volSpike ? "bad" : "neutral";
  const ddTone: Tone = d.drawdownPct < -15 ? "warn" : "neutral";
  return [
    {
      label: "方向",
      display: `${dirArrow}${d.regimeScore >= 0 ? "+" : ""}${d.regimeScore.toFixed(0)}`,
      tone: dirTone,
      title: `レジーム ${d.regime} / スコア${d.regimeScore.toFixed(0)}${d.highVol ? " / 高ボラ" : ""}`,
    },
    { label: "H", display: d.hurst.toFixed(2), tone: hurstTone, title: `Hurst指数 ${d.hurst.toFixed(2)}(<0.5で平均回帰寄り)` },
    { label: "z", display: `${d.meanRevZ >= 0 ? "+" : ""}${d.meanRevZ.toFixed(1)}`, tone: zTone, title: `平均回帰z ${d.meanRevZ.toFixed(2)}` },
    { label: "σ", display: `${d.volForecastPct.toFixed(1)}%`, tone: volTone, title: `GARCH予測σ ${d.volForecastPct.toFixed(2)}%${d.volSpike ? "(急拡大)" : ""}` },
    { label: "DD", display: `${d.drawdownPct.toFixed(0)}%`, tone: ddTone, title: `直近ドローダウン ${d.drawdownPct.toFixed(1)}%` },
  ];
}

export default function PortfolioPage() {
  const router = useRouter();
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [horizon, setHorizon] = useState<Horizon>("swing");
  const [view, setView] = useState<ViewFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // 複数同時に開ける
  const [editing, setEditing] = useState<string | null>(null);

  const toggleExpand = useCallback((ticker: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  }, []);
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot | null>(null);
  const [addInput, setAddInput] = useState("");

  useEffect(() => {
    // 株式原論の合流点(/axioms → /portfolio?add=…)からの銘柄追加を受ける(双方向連携)。
    const add = new URLSearchParams(window.location.search).get("add");
    if (add && add.trim()) {
      const t = add.trim().toUpperCase();
      addToWatchlist(t, t);
      router.replace("/portfolio");
    }
    setWatchlist(getWatchlist());
    setSnapshot(getSnapshot());
  }, [router]);

  const tickers = useMemo(() => watchlist.map((w) => w.ticker), [watchlist]);
  const tickerNames = useMemo(
    () => Object.fromEntries(watchlist.map((w) => [w.ticker, w.name])),
    [watchlist]
  );
  const { data, loading, progress, reload } = usePortfolioData(tickers);

  // 名称の自動補完(整合性): コード追加/URL追加で name=コード のままの項目を、取得済みの
  // 正式名(API)で埋める。ユーザーが設定した名称(name≠コード)は上書きしない。収束保証あり。
  useEffect(() => {
    let changed = false;
    for (const item of watchlist) {
      const fetched = data[item.ticker]?.name;
      if (fetched && fetched !== item.ticker && (!item.name || item.name === item.ticker)) {
        updateWatchlistItem(item.ticker, { name: fetched });
        changed = true;
      }
    }
    if (changed) setWatchlist(getWatchlist());
  }, [data, watchlist]);
  // 分析パネルの一括開閉(既定は全て折りたたみ)。
  const [bulk, setBulk] = useState({ nonce: 0, open: false });
  const onBulk = useCallback((open: boolean) => setBulk((b) => ({ nonce: b.nonce + 1, open })), []);
  const { digests, computing } = usePortfolioDigests(data, horizon);
  const { result: backtest, running: btRunning, progress: btProgress, run: runBacktest } =
    useBadgeBacktest(data, horizon);
  const { result: stopCmp, running: scRunning, progress: scProgress, run: runStopCompare } =
    useStopCompare(data, horizon);

  // 判定 + 差分(蒸留は Worker 済み。ここは軽い評価のみ)
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const item of watchlist) {
      const digest = digests[item.ticker];
      if (!digest) continue; // まだ Worker から届いていない
      const kind = effectiveKind(item);
      const sparkCloses = (data[item.ticker]?.prices ?? [])
        .slice(-40)
        .map((p) => p.close);
      let row: Row;
      if (!digest.ok) {
        out.push({
          item,
          kind,
          digest,
          badge: "データ不足",
          badgeColor: "gray",
          priority: 9,
          diff: { changed: false, reasons: [], isNew: false },
          urgent: false,
          sparkCloses,
        });
        continue;
      }
      if (kind === "held") {
        const held = evaluateHeld(digest, item.position);
        const meta = HELD_BADGE_META[held.badge];
        const diff = diffAgainstSnapshot(digest, meta.label, snapshot);
        const urgent = diff.changed || held.badge === "stop";
        row = { item, kind, digest, held, badge: meta.label, badgeColor: meta.color, priority: meta.priority, diff, urgent, sparkCloses };
      } else {
        const target = evaluateTarget(digest, item.position);
        const meta = TARGET_BADGE_META[target.badge];
        const diff = diffAgainstSnapshot(digest, meta.label, snapshot);
        const urgent = diff.changed || target.badge === "entry";
        row = { item, kind, digest, target, badge: meta.label, badgeColor: meta.color, priority: meta.priority, diff, urgent, sparkCloses };
      }
      out.push(row);
    }
    // 変化あり優先 → バッジ優先度 → 保有を先
    out.sort((a, b) => {
      if (a.diff.changed !== b.diff.changed) return a.diff.changed ? -1 : 1;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.kind === b.kind ? 0 : a.kind === "held" ? -1 : 1;
    });
    return out;
  }, [watchlist, digests, snapshot, data]);

  const visibleRows = useMemo(() => {
    switch (view) {
      case "held":
        return rows.filter((r) => r.kind === "held");
      case "target":
        return rows.filter((r) => r.kind === "target");
      case "changed":
        return rows.filter((r) => r.diff.changed);
      default:
        return rows;
    }
  }, [rows, view]);

  const changedCount = rows.filter((r) => r.diff.changed).length;

  // グループ化: 要対応(上部に浮上)/ 保有 / 狙い。要対応に入った行は各群から除外。
  const groups = useMemo(() => {
    const urgent = visibleRows.filter((r) => r.urgent);
    const held = visibleRows.filter((r) => !r.urgent && r.kind === "held");
    const target = visibleRows.filter((r) => !r.urgent && r.kind === "target");
    return { urgent, held, target };
  }, [visibleRows]);

  const refreshWatchlist = useCallback(() => setWatchlist(getWatchlist()), []);

  const handleSaveBaseline = useCallback(() => {
    const snap = saveSnapshot(rows.map((r) => ({ digest: r.digest, badge: r.badge })));
    setSnapshot(snap);
  }, [rows]);

  const handleAdd = useCallback(() => {
    const t = addInput.trim().toUpperCase();
    if (!t) return;
    setWatchlist(addToWatchlist(t, t));
    setAddInput("");
  }, [addInput]);

  const handleRemove = useCallback((ticker: string) => {
    setWatchlist(removeFromWatchlist(ticker));
  }, []);

  // 銘柄名のインライン編集(横断ヒートマップ等から)。ウォッチリストに永続化。
  const handleRename = useCallback((ticker: string, name: string) => {
    updateWatchlistItem(ticker, { name });
    setWatchlist(getWatchlist());
  }, []);

  const openAnalysis = useCallback(
    (ticker: string) => {
      try {
        localStorage.setItem("sa:lastTicker", ticker);
      } catch {}
      router.push("/");
    },
    [router]
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-4">
        <div className="max-w-7xl mx-auto flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">ポートフォリオ・ダッシュボード</h1>
            <p className="text-sm text-gray-500 mt-1">
              ウォッチリストを横断し、今すべき判断を一覧する
            </p>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <Link
              href="/axioms"
              className="text-sm text-indigo-600 hover:text-indigo-700 border border-indigo-200 rounded-lg px-3 py-1.5 hover:bg-indigo-50"
            >
              株式原論
            </Link>
            <Link
              href="/strategy"
              className="text-sm text-blue-600 hover:text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50"
            >
              戦略ラボ
            </Link>
            <Link
              href="/"
              className="text-sm text-blue-600 hover:text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50"
            >
              ← 個別分析へ
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        {/* コントロール */}
        <div className="flex flex-wrap items-center gap-3">
          {/* 時間軸トグル */}
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {HORIZONS.map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={`px-3 py-1 text-sm rounded-md font-medium transition-colors ${
                  horizon === h ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}
                title={`分析窓 ${HORIZON_CONFIG[h].window}本`}
              >
                {HORIZON_CONFIG[h].label}
              </button>
            ))}
          </div>

          {/* ビューフィルタ */}
          <div className="flex gap-1 text-sm">
            {([
              ["all", "全て"],
              ["held", "保有"],
              ["target", "狙い"],
              ["changed", `変化あり${changedCount > 0 ? ` (${changedCount})` : ""}`],
            ] as [ViewFilter, string][]).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1 rounded-lg font-medium transition-colors ${
                  view === v ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1" />

          {/* 基準スナップショット */}
          <div className="flex items-center gap-2 text-xs text-gray-500">
            {snapshot ? (
              <span>基準: {new Date(snapshot.savedAt).toLocaleString("ja-JP")}</span>
            ) : (
              <span>基準未保存</span>
            )}
            <button
              onClick={handleSaveBaseline}
              className="px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 text-gray-600"
            >
              現在を基準に保存
            </button>
            <button
              onClick={reload}
              disabled={loading}
              className="px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 text-gray-600 disabled:opacity-50"
            >
              再取得
            </button>
          </div>
        </div>

        {/* 追加 */}
        <div className="flex items-center gap-2">
          <input
            value={addInput}
            onChange={(e) => setAddInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="銘柄コードを追加 (例: 7203)"
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm w-52 uppercase focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleAdd}
            className="px-3 py-1.5 bg-gray-800 text-white rounded-lg text-sm hover:bg-gray-700"
          >
            追加
          </button>
          {loading ? (
            <span className="text-xs text-gray-400">
              取得中… {progress.done}/{progress.total}
            </span>
          ) : computing ? (
            <span className="text-xs text-gray-400">
              シグナル計算中… {Object.keys(digests).length}/{tickers.length}
            </span>
          ) : null}
        </div>

        {watchlist.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            ウォッチリストが空です。上の入力欄か、個別分析画面の ★ で銘柄を追加してください。
          </div>
        ) : (
          <>
          {(() => {
            const dn = Object.keys(data).length;
            const items: AccordionItem[] = [];
            if (dn >= 2) items.push({ id: "pf-risk", title: "ポートフォリオ・リスク分析", node: <PortfolioRiskPanel data={data} watchlist={watchlist} horizon={horizon} /> });
            if (dn >= 2) items.push({ id: "pf-frontier", title: "効率的フロンティア・CML", node: <EfficientFrontierChart data={data} window={HORIZON_CONFIG[horizon].window} /> });
            if (dn >= 1) items.push({ id: "pf-capm", title: "CAPM・SML（β / α）", node: <CapmSmlChart data={data} window={HORIZON_CONFIG[horizon].window} /> });
            if (dn >= 2) items.push({ id: "pf-resampled", title: "リサンプリング・フロンティア（Michaud）", node: <ResampledFrontierChart data={data} window={HORIZON_CONFIG[horizon].window} /> });
            if (dn >= 2) items.push({ id: "pf-oos", title: "OOSウォークフォワード検証", node: <OosBacktestChart data={data} /> });
            items.push({ id: "pf-badge", title: "バッジ・トラックレコード", node: (
              <BadgeTrackRecordPanel result={backtest} running={btRunning} progress={btProgress} onRun={runBacktest} horizon={horizon} />
            ) });
            items.push({ id: "pf-stop", title: "ストップ手法の比較", node: (
              <StopComparePanel result={stopCmp} running={scRunning} progress={scProgress} onRun={runStopCompare} horizon={horizon} />
            ) });
            if (tickers.length >= 2) items.push({
              id: "pf-weekday-us-cross",
              title: "曜日 × 前夜米国ビン 交互作用：ウォッチリスト横断",
              subtitle: "選んだ前夜米国ビンの翌日に絞り、銘柄×曜日で日内特性を多面比較",
              node: <WeekdayUsCrossChart tickers={tickers} names={tickerNames} onRename={handleRename} />,
            });
            return items.length > 0 ? (
              <AccordionSection groups={[{ items }]} bulk={bulk} onBulk={onBulk} />
            ) : null;
          })()}

          {(() => {
            const renderRow = (row: Row) => (
              <ListRow
                key={row.item.ticker}
                row={row}
                backtest={backtest}
                expanded={expanded.has(row.item.ticker)}
                editing={editing === row.item.ticker}
                onToggleExpand={() => toggleExpand(row.item.ticker)}
                onToggleEdit={() =>
                  setEditing(editing === row.item.ticker ? null : row.item.ticker)
                }
                onSaved={() => {
                  refreshWatchlist();
                  setEditing(null);
                }}
                onRemove={() => handleRemove(row.item.ticker)}
                onOpenAnalysis={() => openAnalysis(row.item.ticker)}
              />
            );
            const section = (
              title: string,
              count: number,
              rows: Row[],
              accent: string
            ) =>
              rows.length === 0 ? null : (
                <div key={title}>
                  <div className="flex items-center gap-2 mb-1.5 mt-1">
                    <span className={`text-sm font-semibold ${accent}`}>{title}</span>
                    <span className="text-xs text-gray-400">{count}</span>
                  </div>
                  <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100 overflow-hidden">
                    {rows.map(renderRow)}
                  </div>
                </div>
              );
            return (
              <div className="space-y-4">
                {section("要対応", groups.urgent.length, groups.urgent, "text-red-600")}
                {section("保有", groups.held.length, groups.held, "text-gray-700")}
                {section("狙い", groups.target.length, groups.target, "text-gray-700")}
                {groups.urgent.length + groups.held.length + groups.target.length === 0 && (
                  <div className="py-10 text-center text-gray-400 text-sm">
                    該当する銘柄がありません。
                  </div>
                )}
              </div>
            );
          })()}
          </>
        )}

        <p className="text-xs text-gray-400">
          判定はルールベース(等重み)の暫定版です。閾値は調整前提。投資判断はご自身の責任で。
        </p>
      </main>
    </div>
  );
}

// ===================== 行 =====================

function ListRow({
  row,
  backtest,
  expanded,
  editing,
  onToggleExpand,
  onToggleEdit,
  onSaved,
  onRemove,
  onOpenAnalysis,
}: {
  row: Row;
  backtest: BacktestResult | null;
  expanded: boolean;
  editing: boolean;
  onToggleExpand: () => void;
  onToggleEdit: () => void;
  onSaved: () => void;
  onRemove: () => void;
  onOpenAnalysis: () => void;
}) {
  const d = row.digest;
  const pnl = row.held?.pnlPct ?? null;
  const dist = row.target?.distanceToEntryPct ?? null;
  const stats = d.ok ? signalStats(d) : [];
  const reason =
    (row.held?.reasons ?? row.target?.reasons ?? []).join(" / ") || "—";

  return (
    <div className={`border-l-4 ${BORDER_CLASS[row.badgeColor] ?? "border-l-gray-300"} hover:bg-blue-50/30`}>
      {/* 1行目 */}
      <div className="flex items-center gap-3 px-3 py-2">
        <span
          className={`shrink-0 w-[4.5rem] text-center px-1.5 py-0.5 rounded border text-xs font-medium ${COLOR_CLASS[row.badgeColor]}`}
        >
          {row.badge}
        </span>

        <button onClick={onOpenAnalysis} className="text-left min-w-0 flex-1 hover:underline">
          <span className="font-medium text-gray-800">{d.ticker}</span>
          <span className="ml-2 text-xs text-gray-400 truncate">{d.name}</span>
        </button>

        <a
          href={`/axioms?ticker=${encodeURIComponent(d.ticker)}`}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 text-[10px] text-indigo-500 hover:text-indigo-700"
          title="株式原論の合流点で q を分析"
        >
          原論
        </a>

        <PriceSpark closes={row.sparkCloses} />

        <span className="shrink-0 w-20 text-right tabular-nums text-sm text-gray-700">
          {d.close.toLocaleString()}
        </span>

        <span className="shrink-0 w-20 text-right tabular-nums text-sm">
          {pnl !== null ? (
            <span className={pnl >= 0 ? "text-green-600" : "text-red-600"}>
              {pnl >= 0 ? "+" : ""}
              {pnl.toFixed(1)}%
            </span>
          ) : dist !== null ? (
            <span className="text-gray-500 text-xs">
              指値{dist >= 0 ? "+" : ""}
              {dist.toFixed(1)}%
            </span>
          ) : (
            <span className="text-gray-300">—</span>
          )}
        </span>

        <button
          onClick={onToggleExpand}
          className="shrink-0 text-gray-300 hover:text-gray-500 text-xs w-4"
          title="根拠"
        >
          {expanded ? "▾" : "▸"}
        </button>
      </div>

      {/* 2行目: 要約 + シグナル帯 */}
      <div className="flex items-center gap-2 px-3 pb-2 pl-[5.75rem]">
        {row.diff.changed && (
          <span
            className="shrink-0 text-[10px] text-orange-600 font-medium"
            title={row.diff.reasons.join(" / ")}
          >
            ● 変化
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-gray-500">{reason}</span>
        <SignalStats stats={stats} />
        <button onClick={onToggleEdit} className="shrink-0 text-[10px] text-gray-400 hover:text-gray-600">
          編集
        </button>
        <button onClick={onRemove} className="shrink-0 text-gray-300 hover:text-red-400 text-xs leading-none">
          ×
        </button>
      </div>

      {expanded && (
        <div className="bg-gray-50 px-4 py-3 border-t border-gray-100">
          <EvidencePanel row={row} backtest={backtest} />
        </div>
      )}
      {editing && (
        <div className="bg-amber-50/50 px-4 py-3 border-t border-gray-100">
          <PositionEditor item={row.item} onSaved={onSaved} />
        </div>
      )}
    </div>
  );
}

function SignalStats({ stats }: { stats: SignalStat[] }) {
  if (stats.length === 0) return null;
  return (
    <span className="shrink-0 flex items-center gap-2.5 text-[11px] tabular-nums">
      {stats.map((s) => (
        <span key={s.label} title={s.title} className="whitespace-nowrap">
          <span className="text-gray-400">{s.label}</span>{" "}
          <span className={TONE_TEXT[s.tone]}>{s.display}</span>
        </span>
      ))}
    </span>
  );
}

// 直近終値のミニ折れ線。上昇=緑、下落=赤。
function PriceSpark({ closes }: { closes: number[] }) {
  if (closes.length < 2) return <span className="shrink-0 w-20" />;
  const W = 80;
  const H = 22;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const x = (i: number) => (i / (closes.length - 1)) * W;
  const y = (v: number) => H - ((v - min) / range) * (H - 2) - 1;
  const path = closes.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const up = closes[closes.length - 1] >= closes[0];
  return (
    <svg width={W} height={H} className="shrink-0" viewBox={`0 0 ${W} ${H}`}>
      <path d={path} fill="none" stroke={up ? "#16a34a" : "#dc2626"} strokeWidth="1.5" />
    </svg>
  );
}

function EvidencePanel({ row, backtest }: { row: Row; backtest: BacktestResult | null }) {
  const d = row.digest;
  const reasons = row.held?.reasons ?? row.target?.reasons ?? [];
  const activeEvents = d.ok ? classifySignalEvent(d) : [];
  const items: [string, string][] = [
    ["レジーム", `${d.regime} (score ${d.regimeScore.toFixed(0)})`],
    ["Hurst", `${d.hurst.toFixed(2)} (${d.hurst < 0.5 ? "平均回帰寄り" : "トレンド持続"})`],
    ["平均回帰z", d.meanRevZ.toFixed(2)],
    ["GARCH予測σ(1日)", `${d.volForecastPct.toFixed(2)}%${d.volSpike ? " ⚠急拡大" : ""}`],
    ["1日上昇確率", `${(d.upProb * 100).toFixed(0)}%`],
    ["現在DD", `${d.drawdownPct.toFixed(1)}%`],
    ["CVaR95", `${d.cvar95Pct.toFixed(2)}%`],
    ["変化点確率", d.changePointProb.toFixed(2)],
    ["分析本数", `${d.bars}本 (〜${d.asOf})`],
  ];
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-gray-700">
        判定根拠: <span className="text-gray-600">{reasons.join(" / ")}</span>
        {row.diff.changed && (
          <span className="ml-2 text-orange-600">［変化: {row.diff.reasons.join(", ")}］</span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-1 text-xs">
        {items.map(([k, v]) => (
          <div key={k} className="flex justify-between border-b border-gray-200 py-0.5">
            <span className="text-gray-400">{k}</span>
            <span className="text-gray-700 tabular-nums">{v}</span>
          </div>
        ))}
      </div>

      {/* このシグナルの実績(バックテスト済みの場合) */}
      {backtest?.ok && activeEvents.length > 0 && (
        <div className="text-xs text-gray-600 border-t border-gray-200 pt-2 space-y-0.5">
          <span className="text-gray-400">点灯中シグナルの実績(5日後・横断プール):</span>
          {activeEvents.map((ev) => {
            const s = backtest.byEvent[ev]?.find((x) => x.horizon === 5);
            const base = backtest.baseRate.find((x) => x.horizon === 5)?.median ?? 0;
            if (!s || s.n === 0) return null;
            const lift = s.median - base;
            return (
              <div key={ev}>
                <span className="font-medium" style={{ color: "#374151" }}>
                  {SIGNAL_EVENT_META[ev].label}
                </span>
                : 中央値{" "}
                <b className={s.median < 0 ? "text-red-600" : "text-emerald-600"}>
                  {s.median >= 0 ? "+" : ""}
                  {s.median.toFixed(1)}%
                </b>{" "}
                / 続落{(s.pDown * 100).toFixed(0)}% / 地合い比 {lift >= 0 ? "+" : ""}
                {lift.toFixed(1)}pt(n={s.n})
              </div>
            );
          })}
        </div>
      )}
      {!backtest?.ok && activeEvents.length > 0 && (
        <p className="text-[10px] text-gray-400 border-t border-gray-200 pt-2">
          上の「判定の実績」で計算すると、このシグナルの過去実績がここに表示されます。
        </p>
      )}
    </div>
  );
}

// ===================== 建玉エディタ =====================

function PositionEditor({ item, onSaved }: { item: WatchlistItem; onSaved: () => void }) {
  const [kind, setKind] = useState<WatchKind>(effectiveKind(item));
  const [shares, setShares] = useState(item.position?.shares?.toString() ?? "");
  const [cost, setCost] = useState(item.position?.cost?.toString() ?? "");
  const [target, setTarget] = useState(item.position?.target?.toString() ?? "");
  const [stop, setStop] = useState(item.position?.stop?.toString() ?? "");

  const save = () => {
    const num = (s: string) => {
      const n = parseFloat(s);
      return isNaN(n) ? undefined : n;
    };
    const position: Position = {
      shares: num(shares) ?? 0,
      cost: num(cost) ?? 0,
      target: num(target),
      stop: num(stop),
    };
    updateWatchlistItem(item.ticker, { kind, position });
    onSaved();
  };

  const numField = (label: string, value: string, setter: (v: string) => void) => (
    <label className="flex flex-col text-xs text-gray-500">
      {label}
      <input
        type="number"
        value={value}
        onChange={(e) => setter(e.target.value)}
        className="mt-0.5 px-2 py-1 border border-gray-300 rounded w-24 text-sm tabular-nums"
      />
    </label>
  );

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col text-xs text-gray-500">
        種別
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as WatchKind)}
          className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm"
        >
          <option value="held">保有</option>
          <option value="target">狙い</option>
        </select>
      </label>
      {kind === "held" && numField("株数", shares, setShares)}
      {kind === "held" && numField("取得単価", cost, setCost)}
      {numField(kind === "held" ? "ターゲット" : "指値", target, setTarget)}
      {kind === "held" && numField("ストップ", stop, setStop)}
      <button
        onClick={save}
        className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
      >
        保存
      </button>
    </div>
  );
}
