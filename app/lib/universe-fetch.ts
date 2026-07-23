// ユニバース一括取得: クロスセクション分析用に、多数の銘柄を同時実行数制限つきで取得する。
// ウォッチリストに追加せず、その場限りのユニバース(プリセット/貼り付け)を読み込むための
// 自己完結フェッチャ。/api/stock?ticker=X&range=10y を使う(usePortfolioData と同じ経路)。
//
// 3層キャッシュで Yahoo 負荷を抑える: L1=モジュール内Map(セッション内・最速) →
// L2=IndexedDB(ページ再読込を跨ぐ永続・TTL 8h) → L3=Yahoo(実取得)。
// 初回だけ実取得し、以後の再読込はキャッシュ命中で Yahoo ゼロ。新規追加銘柄だけ差分取得。
import { PricePoint, StockData } from "./types";
import { getCached, putCached, DEFAULT_TTL_MS } from "./price-cache";

export interface UniStock {
  prices: PricePoint[];
  name: string;
  error?: string;
}

const CONCURRENCY = 4;
const cache = new Map<string, UniStock>(); // L1: セッション内メモリキャッシュ

export interface FetchUniverseOptions {
  onProgress?: (done: number, total: number, fromCache: number) => void;
  signal?: AbortSignal;
  ttlMs?: number; // これより新しい IndexedDB キャッシュは Yahoo を叩かず再利用
  forceRefresh?: boolean; // true でキャッシュを無視して実取得(手動更新)
}

async function fetchOne(
  ticker: string,
  signal?: AbortSignal,
  ttlMs = DEFAULT_TTL_MS,
  forceRefresh = false,
): Promise<{ stock: UniStock; cached: boolean }> {
  // L1: メモリ
  if (!forceRefresh) {
    const mem = cache.get(ticker);
    if (mem) return { stock: mem, cached: true };
    // L2: IndexedDB(永続)
    const idb = await getCached(ticker, ttlMs);
    if (idb) {
      const stock: UniStock = { prices: idb.prices, name: idb.name };
      cache.set(ticker, stock);
      return { stock, cached: true };
    }
  }
  // L3: Yahoo 実取得
  try {
    const res = await fetch(`/api/stock?ticker=${encodeURIComponent(ticker)}&range=10y`, { signal });
    const json = (await res.json()) as StockData & { error?: string };
    if (!res.ok) return { stock: { prices: [], name: ticker, error: json.error || "取得失敗" }, cached: false };
    const stock: UniStock = { prices: json.prices ?? [], name: json.name ?? ticker };
    cache.set(ticker, stock);
    // write-through(await しない: 描画をブロックしない)
    if (stock.prices.length > 0) void putCached(ticker, stock.name, stock.prices);
    return { stock, cached: false };
  } catch {
    if (signal?.aborted) return { stock: { prices: [], name: ticker, error: "中断" }, cached: false };
    return { stock: { prices: [], name: ticker, error: "通信エラー" }, cached: false };
  }
}

// 同時実行数を制限しながら全ティッカーを取得。onProgress(done,total,fromCache) で進捗通知。
export async function fetchUniverse(
  tickers: string[],
  onProgressOrOpts?: FetchUniverseOptions | ((done: number, total: number) => void),
  signalArg?: AbortSignal,
): Promise<Record<string, UniStock>> {
  // 後方互換: 旧シグネチャ (tickers, onProgress, signal) を許容
  const opts: FetchUniverseOptions =
    typeof onProgressOrOpts === "function"
      ? { onProgress: (d, t) => onProgressOrOpts(d, t), signal: signalArg }
      : onProgressOrOpts ?? {};
  const { onProgress, signal, ttlMs = DEFAULT_TTL_MS, forceRefresh = false } = opts;

  const out: Record<string, UniStock> = {};
  const queue = [...tickers];
  let done = 0;
  let fromCache = 0;
  const total = tickers.length;

  async function worker() {
    while (queue.length > 0) {
      if (signal?.aborted) return;
      const t = queue.shift();
      if (!t) return;
      const { stock, cached } = await fetchOne(t, signal, ttlMs, forceRefresh);
      out[t] = stock;
      done++;
      if (cached) fromCache++;
      onProgress?.(done, total, fromCache);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, () => worker()));
  return out;
}

// "7203.T 6758,9984" のような自由入力を正規化(コード→.T補完・大文字化・重複除去)。
export function parseTickerList(raw: string): string[] {
  const toks = raw
    .split(/[\s,、\n\r\t]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
    .map((t) => (/^\d{4}$/.test(t) ? `${t}.T` : t)); // 4桁数字は東証とみなし .T 補完
  return [...new Set(toks)];
}
