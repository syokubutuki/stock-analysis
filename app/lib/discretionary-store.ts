// 裁量トレードのシナリオ永続化 (localStorage)
//
// ティッカーごとに複数のシナリオ (名前付き) を保存できる。
// 「自分の戦略A vs 戦略B」の比較や、ページ再読込での消失防止が目的。
//
// 注意: 株価は配当・分割で調整後終値が将来変わりうるため、トレードは
// 日付をキーに現在データから価格を引き直す (reconcileTrades)。保存した
// price はドリフト検知用に残す。

import { PricePoint } from "./types";
import { Trade } from "./discretionary-engine";

export interface DiscretionaryScenario {
  id: string;
  name: string;
  initialCash: number;
  costRate: number;
  trades: Trade[];
  createdAt: number;
  updatedAt: number;
}

interface TickerStore {
  schemaVersion: number;
  scenarios: DiscretionaryScenario[];
  activeId: string | null;
}

const SCHEMA_VERSION = 1;
const PREFIX = "sa:discretionary:";

function keyFor(ticker: string): string {
  return PREFIX + ticker.toUpperCase();
}

function loadStore(ticker: string): TickerStore {
  const empty: TickerStore = {
    schemaVersion: SCHEMA_VERSION,
    scenarios: [],
    activeId: null,
  };
  if (typeof window === "undefined") return empty;
  try {
    const raw = localStorage.getItem(keyFor(ticker));
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.scenarios)) return empty;
    return {
      schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION,
      scenarios: parsed.scenarios as DiscretionaryScenario[],
      activeId: parsed.activeId ?? null,
    };
  } catch {
    return empty;
  }
}

function persist(ticker: string, store: TickerStore): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(keyFor(ticker), JSON.stringify(store));
  } catch {
    // quota 超過等は黙って無視
  }
}

// 簡易ユニークID。crypto があれば使い、無ければ時刻+乱数。
function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function listScenarios(ticker: string): DiscretionaryScenario[] {
  return loadStore(ticker).scenarios.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getActiveId(ticker: string): string | null {
  return loadStore(ticker).activeId;
}

export function setActiveId(ticker: string, id: string | null): void {
  const store = loadStore(ticker);
  store.activeId = id;
  persist(ticker, store);
}

// 新規保存。id が一致する既存があれば上書き、無ければ追加。返り値は保存されたシナリオ。
export function saveScenario(
  ticker: string,
  scenario: Omit<DiscretionaryScenario, "id" | "createdAt" | "updatedAt"> & {
    id?: string;
  }
): DiscretionaryScenario {
  const store = loadStore(ticker);
  const now = Date.now();
  const existingIdx = scenario.id
    ? store.scenarios.findIndex((s) => s.id === scenario.id)
    : -1;

  let saved: DiscretionaryScenario;
  if (existingIdx >= 0) {
    saved = {
      ...store.scenarios[existingIdx],
      name: scenario.name,
      initialCash: scenario.initialCash,
      costRate: scenario.costRate,
      trades: scenario.trades,
      updatedAt: now,
    };
    store.scenarios[existingIdx] = saved;
  } else {
    saved = {
      id: scenario.id ?? makeId(),
      name: scenario.name,
      initialCash: scenario.initialCash,
      costRate: scenario.costRate,
      trades: scenario.trades,
      createdAt: now,
      updatedAt: now,
    };
    store.scenarios.push(saved);
  }
  store.activeId = saved.id;
  persist(ticker, store);
  return saved;
}

export function deleteScenario(ticker: string, id: string): void {
  const store = loadStore(ticker);
  store.scenarios = store.scenarios.filter((s) => s.id !== id);
  if (store.activeId === id) store.activeId = null;
  persist(ticker, store);
}

export interface ReconcileResult {
  trades: Trade[]; // 現在データに存在する日付のみ。価格は現在の終値で引き直し済み
  dropped: string[]; // データ窓外/欠落でスキップした日付
  drifted: number; // 保存価格と現在価格が乖離したトレード数 (調整後終値の変化)
}

// 保存トレードを現在の prices に突き合わせる。
// - 日付が現在データに無いものは dropped に回す。
// - price は現在の終値で引き直す (調整後終値ドリフト対策)。
export function reconcileTrades(
  trades: Trade[],
  prices: PricePoint[]
): ReconcileResult {
  const closeByTime = new Map(prices.map((p) => [p.time, p.close]));
  const out: Trade[] = [];
  const dropped: string[] = [];
  let drifted = 0;

  for (const t of trades) {
    const cur = closeByTime.get(t.date);
    if (cur === undefined) {
      dropped.push(t.date);
      continue;
    }
    if (Math.abs(cur - t.price) / (t.price || 1) > 0.005) drifted++;
    out.push({ ...t, price: cur });
  }
  // 念のため日付順
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { trades: out, dropped, drifted };
}
