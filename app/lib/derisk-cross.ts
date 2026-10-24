// ストレス退避規則の横断版（/portfolio `pf-derisk`）。`docs/derisk-rule-design.md` §6 P3。
//
// 問い: ウォッチリストの各銘柄は、次の立会日の寄りで持つか現金か。
// 計算層は 1銘柄版と同じ `computeDerisk`（状態機械は銘柄ごとに独立）。ここでやるのは
//   ・4灯のうち市場共通の2灯（VIX 比・KRE dd60）を1回だけ出す（全銘柄で同じ値になる）
//   ・銘柄固有の2灯（5日/60日ボラ比・60日高値比）と状態を銘柄ごとの行にする
//   ・並び（現金 → 点灯数の多い順 → 保有が先）と集計（保有 N のうち現金 M・警戒 K）
// 成績（年率・最大DD）は出さない。横断で並べると「成績の良い銘柄だけ従う」誘惑が生まれ、
// 規則の意味（状態を避ける保険）が壊れるため。成績は1銘柄版で見る。
//
// 純粋関数。React・fetch を持ち込まない。

import type { PricePoint } from "./types";
import {
  computeDerisk,
  RESEARCH_PARAMS,
  type DeriskParams,
  type DeriskState,
  type Light,
} from "./derisk-rule";

export type CrossKind = "held" | "target";

export interface DeriskCrossItem {
  ticker: string;
  name: string;
  kind: CrossKind;
  prices: PricePoint[];
}

export interface DeriskCrossRow {
  ticker: string;
  name: string;
  kind: CrossKind;
  /** 次の立会日の状態。4指標が揃わなければ最終行の状態。どちらも無ければ null */
  state: DeriskState | null;
  /** state が「次の立会日」のものか（false なら最終行＝データ最終日の朝の状態） */
  isNext: boolean;
  historyStart: string | null;
  /** 終値のみ系列（投信）。4灯と状態は出せるが寄り約定は仮定できない */
  closeOnly: boolean;
  /** 価格行が足りない等で計算できなかった理由 */
  skipped: string | null;
}

export interface DeriskCrossSummary {
  total: number;
  computed: number;
  cash: number;
  /** 保有中で 1 灯以上 */
  warn: number;
  held: number;
  heldCash: number;
  heldWarn: number;
}

export interface DeriskCrossResult {
  params: DeriskParams;
  rows: DeriskCrossRow[];
  /** 市場共通の2灯（最初に計算できた銘柄の値。全銘柄で同じ asof なら同じ値） */
  common: { vix: Light; kre: Light; vixAsOf: string; kreAsOf: string; usStale: boolean } | null;
  /** 行の多数派の判断日 */
  nextTime: string | null;
  /** 判断日が銘柄で異なる（暦の違い・データ最終日の違い） */
  nextTimeDiffers: boolean;
  summary: DeriskCrossSummary;
}

export const MIN_ROWS = 120;

export function isCloseOnlySeries(prices: PricePoint[]): boolean {
  return prices.length > 0 && prices.every((p) => p.volume === 0 && p.open === p.close && p.high === p.close && p.low === p.close);
}

/** 並び: 現金 → 点灯数の多い順 → 保有が先 → ティッカー。計算できなかった行は末尾。 */
export function compareCrossRows(a: DeriskCrossRow, b: DeriskCrossRow): number {
  if (!a.state || !b.state) return (a.state ? 0 : 1) - (b.state ? 0 : 1) || a.ticker.localeCompare(b.ticker);
  const cashA = a.state.holding ? 0 : 1, cashB = b.state.holding ? 0 : 1;
  if (cashA !== cashB) return cashB - cashA;
  if (a.state.stress !== b.state.stress) return b.state.stress - a.state.stress;
  const heldA = a.kind === "held" ? 0 : 1, heldB = b.kind === "held" ? 0 : 1;
  if (heldA !== heldB) return heldA - heldB;
  return a.ticker.localeCompare(b.ticker);
}

export function buildDeriskCross(
  items: readonly DeriskCrossItem[],
  vix: PricePoint[],
  kre: PricePoint[],
  params: DeriskParams = RESEARCH_PARAMS,
): DeriskCrossResult {
  const rows: DeriskCrossRow[] = [];
  let common: DeriskCrossResult["common"] = null;
  for (const it of items) {
    const closeOnly = isCloseOnlySeries(it.prices);
    if (it.prices.length < MIN_ROWS) {
      rows.push({ ticker: it.ticker, name: it.name, kind: it.kind, state: null, isNext: false, historyStart: null, closeOnly, skipped: `価格が ${it.prices.length} 行（${MIN_ROWS} 行必要）` });
      continue;
    }
    const r = computeDerisk({ target: it.prices, vix, kre, ticker: it.ticker, params });
    const state = r.next ?? r.latest;
    if (!state) {
      rows.push({ ticker: it.ticker, name: it.name, kind: it.kind, state: null, isNext: false, historyStart: null, closeOnly, skipped: "4指標が揃う行がありません" });
      continue;
    }
    rows.push({ ticker: it.ticker, name: it.name, kind: it.kind, state, isNext: r.next !== null, historyStart: r.historyStart, closeOnly, skipped: null });
    if (!common) {
      const vixL = state.lights.find((l) => l.key === "vixRatio");
      const kreL = state.lights.find((l) => l.key === "kreDd60");
      if (vixL && kreL) common = { vix: vixL, kre: kreL, vixAsOf: state.vixAsOf, kreAsOf: state.kreAsOf, usStale: state.usStale };
    }
  }
  rows.sort(compareCrossRows);

  // 判断日の多数派
  const dateCount = new Map<string, number>();
  for (const r of rows) if (r.state) dateCount.set(r.state.time, (dateCount.get(r.state.time) ?? 0) + 1);
  let nextTime: string | null = null, best = 0;
  for (const [d, c] of dateCount) if (c > best || (c === best && nextTime !== null && d > nextTime)) { best = c; nextTime = d; }
  const nextTimeDiffers = dateCount.size > 1;

  const summary: DeriskCrossSummary = { total: items.length, computed: 0, cash: 0, warn: 0, held: 0, heldCash: 0, heldWarn: 0 };
  for (const r of rows) {
    const held = r.kind === "held";
    if (held) summary.held++;
    if (!r.state) continue;
    summary.computed++;
    const cash = !r.state.holding;
    const warn = r.state.holding && r.state.stress > 0;
    if (cash) { summary.cash++; if (held) summary.heldCash++; }
    if (warn) { summary.warn++; if (held) summary.heldWarn++; }
  }
  return { params, rows, common, nextTime, nextTimeDiffers, summary };
}
