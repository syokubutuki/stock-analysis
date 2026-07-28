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

// ───────────────────────── 建玉の時価とウェイト ─────────────────────────
//
// 「保有(held) かつ 株数>0 の銘柄について 株数 × 直近終値 を時価とする」という
// たった数行の手続きだが、PortfolioRiskPanel / YourPortfolioDragPanel /
// CorrelationDragChart の3箇所に写経されていた。条件（kind の判定・株数>0・
// 終値の有無）が1箇所でもズレると**パネル間でウェイトが食い違う**ので共通化する。

/**
 * 建玉の時価（ticker → 株数 × 直近終値）。保有でない・株数0・価格が無い銘柄は入らない。
 * 第1引数は `PortfolioData` をそのまま渡せる形にしてある（prices さえあればよい）。
 */
export function heldMarketValues(
  pricesByTicker: Record<string, { prices: { close: number }[] }>,
  watchlist: WatchlistItem[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of watchlist) {
    if (effectiveKind(item) !== "held") continue;
    const pos = item.position;
    const last = pricesByTicker[item.ticker]?.prices.at(-1)?.close;
    if (pos && pos.shares > 0 && last) out[item.ticker] = pos.shares * last;
  }
  return out;
}

/**
 * 指定した銘柄リストの順に並べた構成比（合計1）。
 *
 * 合計は**渡された tickers の範囲だけ**で取る。整列（alignReturns）から落ちた銘柄を
 * 分母に入れてしまうとウェイトの合計が1にならないので、ここは呼び出し側の
 * 銘柄リストに厳密に合わせる。建玉が無ければ weights は null。
 */
export function heldWeightsFor(
  tickers: string[],
  byTicker: Record<string, number>
): { weights: number[] | null; total: number; count: number } {
  let total = 0;
  let count = 0;
  for (const t of tickers) {
    const mv = byTicker[t] ?? 0;
    if (mv > 0) {
      total += mv;
      count++;
    }
  }
  if (!(total > 0)) return { weights: null, total: 0, count };
  return { weights: tickers.map((t) => (byTicker[t] ?? 0) / total), total, count };
}
