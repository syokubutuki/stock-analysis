import { Position } from "./signal-digest";

export type WatchKind = "held" | "target";

export interface WatchlistItem {
  ticker: string;
  name: string;
  addedAt: number; // Date.now()
  // 以下は後方互換のため任意。未設定の古いデータは「狙い・建玉なし」として扱う。
  kind?: WatchKind; // 保有 or 狙い
  position?: Position; // 取得単価・株数・ターゲット/ストップ(狙いの場合 target=指値)
}

const STORAGE_KEY = "stock-analysis-watchlist";

export function getWatchlist(): WatchlistItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as WatchlistItem[];
  } catch {
    return [];
  }
}

function save(items: WatchlistItem[]): WatchlistItem[] {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  return items;
}

export function addToWatchlist(ticker: string, name: string): WatchlistItem[] {
  const current = getWatchlist();
  if (current.some((item) => item.ticker === ticker)) {
    return current;
  }
  return save([...current, { ticker, name, addedAt: Date.now() }]);
}

export function removeFromWatchlist(ticker: string): WatchlistItem[] {
  return save(getWatchlist().filter((item) => item.ticker !== ticker));
}

export function isInWatchlist(ticker: string): boolean {
  return getWatchlist().some((item) => item.ticker === ticker);
}

// 建玉・種別の部分更新。ダッシュボードのインライン編集から呼ぶ。
export function updateWatchlistItem(
  ticker: string,
  patch: Partial<Pick<WatchlistItem, "kind" | "position" | "name">>
): WatchlistItem[] {
  const current = getWatchlist();
  return save(
    current.map((item) =>
      item.ticker === ticker ? { ...item, ...patch } : item
    )
  );
}

// item の実効的な種別。kind が未設定なら、建玉があれば held、なければ target。
export function effectiveKind(item: WatchlistItem): WatchKind {
  if (item.kind) return item.kind;
  return item.position && item.position.shares > 0 ? "held" : "target";
}
