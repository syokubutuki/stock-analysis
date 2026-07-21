// 動的・多重検定台帳: 静的な TEST_INVENTORY(理論上の母数)に対し、
// 「あなたが実際に何を探索したか」を数える実測レイヤ。
// -------------------------------------------------------------
// 静的台帳の弱点は、(1)全分析を一律に数えるが実際に開いたのは一部、(2)常に「1銘柄分」で、
// 銘柄を替えて渡り歩いた探索を数えない、の2点。ここでは副作用の少ない2つの信号だけで
// 実際の家族(family)を近似する:
//   ・開いた分析: localStorage の `sa:open:<id>`==="1"(AccordionSection/Collapsibleが書く)
//   ・閲覧した銘柄: fetch 成功のたび recordTicker で貯める集合
// 実測母数 M_live = (開いた検定分析の検定数合計) × (閲覧銘柄数)。
// 「開いた分析 × 見た銘柄」の直積は上限寄りの近似だが、静的な「1銘柄・全分析」より
// はるかに現実の探索に近い。過小評価(母数を小さく見せる)より過大評価の側に倒すのが安全側。
import { TEST_INVENTORY } from "./test-registry";

const TICKERS_KEY = "test-ledger:v1:tickers";
const OPEN_PREFIX = "sa:open:";

// ---------------------------------------------------------------
// 銘柄の記録
// ---------------------------------------------------------------
export function recordTicker(ticker: string): void {
  if (typeof window === "undefined" || !ticker) return;
  try {
    const set = new Set(getExaminedTickers());
    if (set.has(ticker)) return;
    set.add(ticker);
    window.localStorage.setItem(TICKERS_KEY, JSON.stringify([...set]));
  } catch {
    // localStorage 不可時は黙って無視(台帳は補助機能)
  }
}

export function getExaminedTickers(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(TICKERS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------
// 開いた分析の検出(sa:open:<id> === "1")
// ---------------------------------------------------------------
export function getOpenedAnalysisIds(): string[] {
  if (typeof window === "undefined") return [];
  const out: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(OPEN_PREFIX)) continue;
      if (window.localStorage.getItem(key) === "1") out.push(key.slice(OPEN_PREFIX.length));
    }
  } catch {
    return out;
  }
  return out;
}

export function resetLedger(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TICKERS_KEY);
    // 開閉フラグ(sa:open:*)はUI状態でもあるので消さない。銘柄集合だけリセット。
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------
// 実測サマリ
// ---------------------------------------------------------------
export interface LiveLedger {
  nTickers: number; // 閲覧した銘柄数(最低1)
  tickers: string[];
  openedInventoryIds: string[]; // 開いた かつ 検定を走らせる分析(TEST_INVENTORYに載っている)
  nOpenedInventory: number;
  nInventoryTotal: number; // 台帳に載っている検定分析の総数
  perTickerTests: number; // 開いた分析の検定数合計(1銘柄あたり)
  liveTests: number; // = perTickerTests × nTickers(実測の家族サイズ)
  staticTests: number; // 静的台帳の全検定数(1銘柄)
  expectedFalse: number; // M_live × α
  probAtLeastOne: number; // 1−(1−α)^(M_live/effDivisor)
  bonferroniAlpha: number; // 0.05 / M_live
}

export function liveLedger(alpha: number, effDivisor: number): LiveLedger {
  const tickers = getExaminedTickers();
  const nTickers = Math.max(1, tickers.length);
  const openedIds = new Set(getOpenedAnalysisIds());

  const openedInventory = TEST_INVENTORY.filter((it) => openedIds.has(it.analysisId));
  const perTickerTests = openedInventory.reduce((s, it) => s + it.count, 0);
  const staticTests = TEST_INVENTORY.reduce((s, it) => s + it.count, 0);
  const liveTests = perTickerTests * nTickers;
  const mEff = Math.max(1, liveTests / Math.max(1, effDivisor));

  return {
    nTickers,
    tickers,
    openedInventoryIds: openedInventory.map((it) => it.analysisId),
    nOpenedInventory: openedInventory.length,
    nInventoryTotal: TEST_INVENTORY.length,
    perTickerTests,
    liveTests,
    staticTests,
    expectedFalse: liveTests * alpha,
    probAtLeastOne: liveTests > 0 ? 1 - Math.pow(1 - alpha, mEff) : 0,
    bonferroniAlpha: liveTests > 0 ? 0.05 / liveTests : 0.05,
  };
}
