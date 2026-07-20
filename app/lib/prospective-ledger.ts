// 前向き検証台帳: エッジを「凍結」し、凍結日以降に新しく到着したデータだけで採点する。
//
// バックテストの根本問題は「同じデータで発見と検証を行う」こと。ウォークフォワードは
// これを擬似的に避けるが、最も誠実な検証は本物の前向き検証——仮説を日付とともに固定し、
// まだ存在しなかった未来のデータでのみ評価する——である。臨床試験の事前登録
// (pre-registration)の投資版。
//
// 凍結時にIS統計量(μ_IS, σ_IS)をlocalStorageへ保存し、以後の再訪時には
// 「凍結時点より後の取引」だけでOOS成績とSPRT判定(edge-decay.tsと同じ逐次検定)を更新する。
// 凍結後にパラメータを差し替えられないことが、この検証の価値の源泉。

import { mean, std } from "./stats-significance";
import { Side } from "./weekday-trade";
import { EdgeSeries, directedReturns } from "./edge-trades";

const STORAGE_KEY = "prospective-ledger:v1";

export interface LedgerEntry {
  id: string;
  ticker: string;
  edgeId: string;
  edgeLabel: string;
  direction: Side;
  frozenAt: string; // 凍結操作日 "YYYY-MM-DD"
  freezeDataEnd: string; // 凍結時点の最終取引日 = IS/OOS境界(この日以前がIS)
  nIS: number;
  muIS: number;
  sigmaIS: number;
  sharpeIS: number; // 年率
  tradesPerYear: number;
}

export function loadLedger(): LedgerEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LedgerEntry[]) : [];
  } catch {
    return [];
  }
}

function saveLedger(entries: LedgerEntry[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 容量超過などは黙って無視(台帳は補助機能)
  }
}

export function freezeEdge(ticker: string, edge: EdgeSeries): LedgerEntry | null {
  if (edge.trades.length < 30) return null;
  const rawMean = mean(edge.trades.map((t) => t.ret));
  const direction: Side = rawMean >= 0 ? "long" : "short";
  const rets = directedReturns(edge, direction);
  const mu = mean(rets);
  const sd = std(rets);
  if (sd <= 0) return null;
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const entry: LedgerEntry = {
    id: `${ticker}-${edge.id}-${Date.now()}`,
    ticker,
    edgeId: edge.id,
    edgeLabel: edge.label,
    direction,
    frozenAt: iso,
    freezeDataEnd: edge.trades[edge.trades.length - 1].date,
    nIS: rets.length,
    muIS: mu,
    sigmaIS: sd,
    sharpeIS: (mu / sd) * Math.sqrt(edge.tradesPerYear),
    tradesPerYear: edge.tradesPerYear,
  };
  const entries = loadLedger();
  entries.push(entry);
  saveLedger(entries);
  return entry;
}

export function removeEntry(id: string) {
  saveLedger(loadLedger().filter((e) => e.id !== id));
}

export type LedgerVerdict = "alive" | "dead" | "undecided" | "waiting";

export interface LedgerEval {
  entry: LedgerEntry;
  nOOS: number;
  muOOS: number;
  sharpeOOS: number;
  cumOOS: number; // OOS累積リターン(方向調整後)
  logLR: number; // SPRT累積対数尤度比(凍結μ・σを使用)
  sprtUpper: number;
  sprtLower: number;
  verdict: LedgerVerdict;
  equity: { date: string; value: number }[]; // OOSエクイティ(1始まり)
}

const SPRT_ALPHA = 0.05;
const SPRT_BETA = 0.05;

// 現在のカタログから、凍結境界より後の取引だけを取り出して採点する。
export function evaluateEntry(entry: LedgerEntry, catalog: EdgeSeries[]): LedgerEval | null {
  const edge = catalog.find((e) => e.id === entry.edgeId);
  if (!edge) return null;
  const sign = entry.direction === "short" ? -1 : 1;
  const oos = edge.trades.filter((t) => t.date > entry.freezeDataEnd);
  const A = Math.log((1 - SPRT_BETA) / SPRT_ALPHA);
  const B = Math.log(SPRT_BETA / (1 - SPRT_ALPHA));

  const equity: { date: string; value: number }[] = [];
  let w = 1;
  let logLR = 0;
  let verdict: LedgerVerdict = oos.length === 0 ? "waiting" : "undecided";
  const rets: number[] = [];
  for (const t of oos) {
    const r = sign * t.ret;
    rets.push(r);
    w *= 1 + r;
    logLR += (entry.muIS * r - (entry.muIS * entry.muIS) / 2) / (entry.sigmaIS * entry.sigmaIS);
    if (verdict === "undecided") {
      if (logLR >= A) verdict = "alive";
      else if (logLR <= B) verdict = "dead";
    }
    equity.push({ date: t.date, value: w });
  }
  const muOOS = rets.length > 0 ? mean(rets) : 0;
  const sdOOS = rets.length > 1 ? std(rets) : 0;
  return {
    entry,
    nOOS: rets.length,
    muOOS,
    sharpeOOS: sdOOS > 0 ? (muOOS / sdOOS) * Math.sqrt(entry.tradesPerYear) : 0,
    cumOOS: w - 1,
    logLR,
    sprtUpper: A,
    sprtLower: B,
    verdict,
    equity,
  };
}
