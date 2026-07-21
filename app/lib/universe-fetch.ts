// ユニバース一括取得: クロスセクション分析用に、多数の銘柄を同時実行数制限つきで取得する。
// ウォッチリストに追加せず、その場限りのユニバース(プリセット/貼り付け)を読み込むための
// 自己完結フェッチャ。/api/stock?ticker=X&range=10y を使う(usePortfolioData と同じ経路)。
import { PricePoint, StockData } from "./types";

export interface UniStock {
  prices: PricePoint[];
  name: string;
  error?: string;
}

const CONCURRENCY = 4;
const cache = new Map<string, UniStock>(); // セッション内メモリキャッシュ

async function fetchOne(ticker: string, signal?: AbortSignal): Promise<UniStock> {
  const cached = cache.get(ticker);
  if (cached) return cached;
  try {
    const res = await fetch(`/api/stock?ticker=${encodeURIComponent(ticker)}&range=10y`, { signal });
    const json = (await res.json()) as StockData & { error?: string };
    if (!res.ok) return { prices: [], name: ticker, error: json.error || "取得失敗" };
    const result: UniStock = { prices: json.prices ?? [], name: json.name ?? ticker };
    cache.set(ticker, result);
    return result;
  } catch (e) {
    if (signal?.aborted) return { prices: [], name: ticker, error: "中断" };
    return { prices: [], name: ticker, error: "通信エラー" };
  }
}

// 同時実行数を制限しながら全ティッカーを取得。onProgress(done,total) で進捗通知。
export async function fetchUniverse(
  tickers: string[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Record<string, UniStock>> {
  const out: Record<string, UniStock> = {};
  const queue = [...tickers];
  let done = 0;
  const total = tickers.length;

  async function worker() {
    while (queue.length > 0) {
      if (signal?.aborted) return;
      const t = queue.shift();
      if (!t) return;
      out[t] = await fetchOne(t, signal);
      done++;
      onProgress?.(done, total);
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
