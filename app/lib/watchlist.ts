export interface WatchlistItem {
  ticker: string;
  name: string;
  addedAt: number; // Date.now()
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

export function addToWatchlist(ticker: string, name: string): WatchlistItem[] {
  const current = getWatchlist();
  if (current.some((item) => item.ticker === ticker)) {
    return current;
  }
  const updated: WatchlistItem[] = [
    ...current,
    { ticker, name, addedAt: Date.now() },
  ];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated;
}

export function removeFromWatchlist(ticker: string): WatchlistItem[] {
  const current = getWatchlist();
  const updated = current.filter((item) => item.ticker !== ticker);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated;
}

export function isInWatchlist(ticker: string): boolean {
  return getWatchlist().some((item) => item.ticker === ticker);
}
