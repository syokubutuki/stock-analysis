// 価格データの永続キャッシュ(IndexedDB)。
// -------------------------------------------------------------
// ユニバース(数十〜百銘柄)をページ再読み込みのたびに Yahoo から取り直すと、負荷が大きく遅い。
// 日足は1日1回しか更新されないので、取得済みを IndexedDB に保存し TTL 内は再利用する。
// これで「初回だけ取得→以後の再読込は Yahoo ゼロ」になり、新規追加銘柄だけ差分取得で済む。
//
// なぜ IndexedDB か: localStorage は同期・5〜10MB上限で 100銘柄×10年(≈15MB)が溢れる。
// IndexedDB は非同期・大容量でブラウザ再読込を跨いで残る。個人用途なのでサーバ不要。
import { PricePoint } from "./types";

const DB_NAME = "stock-analysis-cache";
const STORE = "prices";
const VERSION = 1;

export interface CachedPrices {
  ticker: string;
  name: string;
  prices: PricePoint[];
  fetchedAt: number; // epoch ms
}

// 既定TTL: 8時間(日足は1日1回更新。場中に何度開いても最大数回の再取得で収まる)。
export const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null); // SSR / 非対応
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "ticker" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

// 単一銘柄: TTL内なら返す。古い/無い/エラーは null。
export async function getCached(ticker: string, maxAgeMs = DEFAULT_TTL_MS): Promise<CachedPrices | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(ticker);
      req.onsuccess = () => {
        const v = req.result as CachedPrices | undefined;
        if (v && v.prices?.length > 0 && Date.now() - v.fetchedAt <= maxAgeMs) resolve(v);
        else resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    } finally {
      db.close();
    }
  });
}

// 複数銘柄をまとめて読む(TTL内のヒットのみ返す)。
export async function getManyCached(
  tickers: string[],
  maxAgeMs = DEFAULT_TTL_MS,
): Promise<Record<string, CachedPrices>> {
  const db = await openDb();
  if (!db) return {};
  return new Promise((resolve) => {
    const out: Record<string, CachedPrices> = {};
    try {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      let pending = tickers.length;
      if (pending === 0) { resolve({}); db.close(); return; }
      const now = Date.now();
      for (const t of tickers) {
        const req = store.get(t);
        req.onsuccess = () => {
          const v = req.result as CachedPrices | undefined;
          if (v && v.prices?.length > 0 && now - v.fetchedAt <= maxAgeMs) out[t] = v;
          if (--pending === 0) { resolve(out); db.close(); }
        };
        req.onerror = () => { if (--pending === 0) { resolve(out); db.close(); } };
      }
    } catch {
      resolve(out);
      db.close();
    }
  });
}

// 書き込み(write-through)。失敗は黙って無視(キャッシュは補助)。
export async function putCached(ticker: string, name: string, prices: PricePoint[]): Promise<void> {
  if (!prices || prices.length === 0) return;
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ ticker, name, prices, fetchedAt: Date.now() } as CachedPrices);
      tx.oncomplete = () => { resolve(); db.close(); };
      tx.onerror = () => { resolve(); db.close(); };
      tx.onabort = () => { resolve(); db.close(); };
    } catch {
      resolve();
      db.close();
    }
  });
}

export interface CacheStats { count: number; totalBars: number; oldestAt: number | null; newestAt: number | null; }

export async function cacheStats(): Promise<CacheStats> {
  const db = await openDb();
  if (!db) return { count: 0, totalBars: 0, oldestAt: null, newestAt: null };
  return new Promise((resolve) => {
    const stats: CacheStats = { count: 0, totalBars: 0, oldestAt: null, newestAt: null };
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          const v = cur.value as CachedPrices;
          stats.count++;
          stats.totalBars += v.prices?.length ?? 0;
          stats.oldestAt = stats.oldestAt === null ? v.fetchedAt : Math.min(stats.oldestAt, v.fetchedAt);
          stats.newestAt = stats.newestAt === null ? v.fetchedAt : Math.max(stats.newestAt, v.fetchedAt);
          cur.continue();
        } else {
          resolve(stats);
          db.close();
        }
      };
      req.onerror = () => { resolve(stats); db.close(); };
    } catch {
      resolve(stats);
      db.close();
    }
  });
}

export async function clearCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => { resolve(); db.close(); };
      tx.onerror = () => { resolve(); db.close(); };
    } catch {
      resolve();
      db.close();
    }
  });
}
