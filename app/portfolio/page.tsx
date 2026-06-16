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
  computeDigest,
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
}

const COLOR_CLASS: Record<string, string> = {
  red: "bg-red-100 text-red-700 border-red-200",
  amber: "bg-amber-100 text-amber-700 border-amber-200",
  green: "bg-green-100 text-green-700 border-green-200",
  gray: "bg-gray-100 text-gray-600 border-gray-200",
};

export default function PortfolioPage() {
  const router = useRouter();
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [horizon, setHorizon] = useState<Horizon>("swing");
  const [view, setView] = useState<ViewFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot | null>(null);
  const [addInput, setAddInput] = useState("");

  useEffect(() => {
    setWatchlist(getWatchlist());
    setSnapshot(getSnapshot());
  }, []);

  const tickers = useMemo(() => watchlist.map((w) => w.ticker), [watchlist]);
  const { data, loading, progress, reload } = usePortfolioData(tickers);

  // 蒸留 + 判定 + 差分
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const item of watchlist) {
      const fetched = data[item.ticker];
      if (!fetched || fetched.prices.length === 0) continue;
      const name = fetched.name || item.name;
      const kind = effectiveKind(item);
      const digest = computeDigest(fetched.prices, item.ticker, name, horizon);
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
        });
        continue;
      }
      if (kind === "held") {
        const held = evaluateHeld(digest, item.position);
        const meta = HELD_BADGE_META[held.badge];
        const diff = diffAgainstSnapshot(digest, meta.label, snapshot);
        row = { item, kind, digest, held, badge: meta.label, badgeColor: meta.color, priority: meta.priority, diff };
      } else {
        const target = evaluateTarget(digest, item.position);
        const meta = TARGET_BADGE_META[target.badge];
        const diff = diffAgainstSnapshot(digest, meta.label, snapshot);
        row = { item, kind, digest, target, badge: meta.label, badgeColor: meta.color, priority: meta.priority, diff };
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
  }, [watchlist, data, horizon, snapshot]);

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
          <Link
            href="/"
            className="shrink-0 text-sm text-blue-600 hover:text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50"
          >
            ← 個別分析へ
          </Link>
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
          {loading && (
            <span className="text-xs text-gray-400">
              取得中… {progress.done}/{progress.total}
            </span>
          )}
        </div>

        {watchlist.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            ウォッチリストが空です。上の入力欄か、個別分析画面の ★ で銘柄を追加してください。
          </div>
        ) : (
          <div className="overflow-x-auto bg-white rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                  <th className="px-3 py-2 font-medium">判定</th>
                  <th className="px-3 py-2 font-medium">銘柄</th>
                  <th className="px-3 py-2 font-medium text-right">現在値</th>
                  <th className="px-3 py-2 font-medium text-right">損益/距離</th>
                  <th className="px-3 py-2 font-medium">レジーム</th>
                  <th className="px-3 py-2 font-medium text-right">Hurst</th>
                  <th className="px-3 py-2 font-medium text-right">z</th>
                  <th className="px-3 py-2 font-medium text-right">予測σ</th>
                  <th className="px-3 py-2 font-medium text-right">DD</th>
                  <th className="px-3 py-2 font-medium">変化</th>
                  <th className="px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <RowView
                    key={row.item.ticker}
                    row={row}
                    expanded={expanded === row.item.ticker}
                    editing={editing === row.item.ticker}
                    onToggleExpand={() =>
                      setExpanded(expanded === row.item.ticker ? null : row.item.ticker)
                    }
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
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-gray-400">
          判定はルールベース(等重み)の暫定版です。閾値は調整前提。投資判断はご自身の責任で。
        </p>
      </main>
    </div>
  );
}

// ===================== 行 =====================

function RowView({
  row,
  expanded,
  editing,
  onToggleExpand,
  onToggleEdit,
  onSaved,
  onRemove,
  onOpenAnalysis,
}: {
  row: Row;
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

  return (
    <>
      <tr className="border-b border-gray-100 hover:bg-blue-50/40">
        <td className="px-3 py-2">
          <span
            className={`inline-block px-2 py-0.5 rounded border text-xs font-medium ${COLOR_CLASS[row.badgeColor]}`}
          >
            {row.badge}
          </span>
        </td>
        <td className="px-3 py-2">
          <button onClick={onOpenAnalysis} className="text-left hover:underline">
            <span className="font-medium text-gray-800">{d.ticker}</span>
            <span className="block text-xs text-gray-400 truncate max-w-[10rem]">{d.name}</span>
          </button>
          <span className="text-[10px] text-gray-400">{row.kind === "held" ? "保有" : "狙い"}</span>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{d.close.toLocaleString()}</td>
        <td className="px-3 py-2 text-right tabular-nums">
          {pnl !== null ? (
            <span className={pnl >= 0 ? "text-green-600" : "text-red-600"}>
              {pnl >= 0 ? "+" : ""}
              {pnl.toFixed(1)}%
            </span>
          ) : dist !== null ? (
            <span className="text-gray-500">
              指値{dist >= 0 ? "+" : ""}
              {dist.toFixed(1)}%
            </span>
          ) : (
            <span className="text-gray-300">—</span>
          )}
        </td>
        <td className="px-3 py-2">
          <DirChip direction={d.direction} score={d.regimeScore} highVol={d.highVol} />
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          <span className={d.hurst < 0.45 ? "text-amber-600" : d.hurst > 0.55 ? "text-blue-600" : "text-gray-600"}>
            {d.hurst.toFixed(2)}
          </span>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          <span className={Math.abs(d.meanRevZ) > 2 ? "font-medium text-gray-900" : "text-gray-500"}>
            {d.meanRevZ >= 0 ? "+" : ""}
            {d.meanRevZ.toFixed(1)}
          </span>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          <span className={d.volSpike ? "text-red-600 font-medium" : "text-gray-500"}>
            {d.volForecastPct.toFixed(1)}%
          </span>
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-gray-500">{d.drawdownPct.toFixed(1)}%</td>
        <td className="px-3 py-2">
          {row.diff.changed ? (
            <span
              className="inline-block w-2 h-2 rounded-full bg-orange-500"
              title={row.diff.reasons.join(" / ")}
            />
          ) : null}
        </td>
        <td className="px-3 py-2 whitespace-nowrap text-xs">
          <button onClick={onToggleExpand} className="text-blue-600 hover:underline mr-2">
            {expanded ? "閉じる" : "根拠"}
          </button>
          <button onClick={onToggleEdit} className="text-gray-500 hover:underline mr-2">
            編集
          </button>
          <button onClick={onRemove} className="text-gray-300 hover:text-red-400">
            ×
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-gray-50">
          <td colSpan={11} className="px-4 py-3">
            <EvidencePanel row={row} />
          </td>
        </tr>
      )}
      {editing && (
        <tr className="bg-amber-50/50">
          <td colSpan={11} className="px-4 py-3">
            <PositionEditor item={row.item} onSaved={onSaved} />
          </td>
        </tr>
      )}
    </>
  );
}

function DirChip({ direction, score, highVol }: { direction: string; score: number; highVol: boolean }) {
  const map: Record<string, { label: string; cls: string }> = {
    up: { label: "上昇", cls: "text-green-600" },
    down: { label: "下落", cls: "text-red-600" },
    flat: { label: "横ばい", cls: "text-gray-500" },
  };
  const m = map[direction] ?? map.flat;
  return (
    <span className="text-xs">
      <span className={m.cls}>{m.label}</span>
      <span className="text-gray-400"> {score.toFixed(0)}</span>
      {highVol && <span className="ml-1 text-red-500">高ボラ</span>}
    </span>
  );
}

function EvidencePanel({ row }: { row: Row }) {
  const d = row.digest;
  const reasons = row.held?.reasons ?? row.target?.reasons ?? [];
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
