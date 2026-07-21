// 曜日固定エグジットのクロスセクション版：ウォッチリスト横断で「週内のどこで降りるのが最良か」
// -------------------------------------------------------------------------------
// 単一銘柄では「水曜で降りるのが最良」に見えても、それが後知恵の1銘柄ノイズなのか、
// 銘柄をまたいで共通の構造なのかは分からない。そこで各銘柄のトレード週（月曜Open建玉）を
// プールし、「建てから h 日目の引けで降りる」戦略の平均リターンを銘柄×週で集計する。
//
// ただし同じ週は全銘柄がまとめて動く（横断相関）ので、素朴に「銘柄×週=独立標本」と数えると
// 標準誤差が過小＝偽の有意になる。intraday-basket.ts の clusterStat で「同一週=1クラスタ」
// （週の建て日 entryTime をキー）としてクラスタ頑健SEと実効標本数 nEff を出す。
//
// buildTradeWeeks（optimal-exit.ts）と clusterStat（intraday-basket.ts）を流用。

import { PricePoint } from "./types";
import { buildTradeWeeks, ExitSide, EntryTiming, OPTIMAL_EXIT_CONST } from "./optimal-exit";
import { clusterStat } from "./intraday-basket";
import { mean, std } from "./stats-significance";

const { H_MAX } = OPTIMAL_EXIT_CONST;
const DAY_LABEL = ["月", "火", "水", "木", "金"];
export const exitDayLabel = (h: number) => `${h}日目${DAY_LABEL[h - 1] ? `(${DAY_LABEL[h - 1]})` : ""}`;

export interface TickerPrices {
  ticker: string;
  name?: string;
  prices: PricePoint[];
}

export interface DayCell {
  day: number; // 1..H_MAX（0 は「金曜まで持つ」を別枠で持つ）
  mean: number; // 銘柄×週プールの平均リターン
  se: number; // クラスタ頑健SE（同一週=1クラスタ）
  t: number; // mean / se
  nObs: number; // 銘柄×週 のべ数
  nWeeks: number; // クラスタ数（独立週数）
  nEff: number; // 実効標本数
  sharpe: number; // プール週次リターンの年率Sharpe（記述用）
  winRate: number;
}

export interface ExitCrossResult {
  ok: boolean;
  reason?: string;
  nTickers: number;
  from: string;
  to: string;
  byDay: DayCell[]; // h=1..H_MAX
  hold: DayCell; // 週の最終ノードまで保持（金曜まで持つ）
  bestDay: number; // Sharpe最大の固定日
  perTicker: { ticker: string; name: string; bestDay: number; bestSharpe: number; holdSharpe: number }[];
  side: ExitSide;
}

// プールしたリターン列とクラスタキー（週）から DayCell を作る
function toDayCell(day: number, vals: number[], weeks: string[]): DayCell {
  const cs = clusterStat(vals, weeks);
  const m = mean(vals);
  const sd = std(vals);
  return {
    day,
    mean: cs ? cs.mean : m,
    se: cs ? cs.se : 0,
    t: cs && cs.se > 0 ? cs.mean / cs.se : 0,
    nObs: vals.length,
    nWeeks: cs ? cs.nDays : 0,
    nEff: cs ? cs.nEff : 0,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(52) : 0,
    winRate: vals.length ? vals.filter((r) => r > 0).length / vals.length : 0,
  };
}

// 単一銘柄の「h日目固定エグジット」Sharpe（perTicker の異質性表示用）
function tickerSharpeByDay(weeks: ReturnType<typeof buildTradeWeeks>): { best: number; bestSharpe: number; holdSharpe: number } {
  let best = 1;
  let bestSharpe = -Infinity;
  for (let h = 1; h <= H_MAX; h++) {
    const rs = weeks.map((w) => w.ret[Math.min(h, w.z.length) - 1]);
    const sd = std(rs);
    const sh = sd > 0 ? (mean(rs) / sd) * Math.sqrt(52) : 0;
    if (sh > bestSharpe) { bestSharpe = sh; best = h; }
  }
  const holdRs = weeks.map((w) => w.ret[w.z.length - 1]);
  const holdSd = std(holdRs);
  const holdSharpe = holdSd > 0 ? (mean(holdRs) / holdSd) * Math.sqrt(52) : 0;
  return { best, bestSharpe, holdSharpe };
}

export interface ExitCrossOptions {
  side?: ExitSide;
  entryTiming?: EntryTiming;
  entryDow?: number;
}

export function computeExitCross(stocks: TickerPrices[], opts: ExitCrossOptions = {}): ExitCrossResult {
  const side = opts.side ?? "long";
  const build = { side, entryTiming: opts.entryTiming ?? "open", entryDow: opts.entryDow ?? 1 };

  const empty: ExitCrossResult = {
    ok: false,
    nTickers: 0,
    from: "",
    to: "",
    byDay: [],
    hold: toDayCell(0, [], []),
    bestDay: 1,
    perTicker: [],
    side,
  };

  const usable = stocks.filter((s) => s.prices.length >= 200);
  if (usable.length < 2) return { ...empty, reason: "有効な銘柄が不足（2銘柄以上・各200本以上必要）" };

  // h日目ごとのプール標本（vals=リターン, weeks=建て週の日付キー）
  const dayVals: number[][] = Array.from({ length: H_MAX }, () => []);
  const dayWeeks: string[][] = Array.from({ length: H_MAX }, () => []);
  const holdVals: number[] = [];
  const holdWeeks: string[] = [];
  const perTicker: ExitCrossResult["perTicker"] = [];

  let from = "";
  let to = "";
  let nUsed = 0;

  for (const s of usable) {
    const weeks = buildTradeWeeks(s.prices, build);
    if (weeks.length < 30) continue;
    nUsed++;
    const f0 = s.prices[0].time;
    const t0 = s.prices[s.prices.length - 1].time;
    if (!from || f0 < from) from = f0;
    if (!to || t0 > to) to = t0;

    for (const w of weeks) {
      const L = w.z.length;
      for (let h = 1; h <= H_MAX; h++) {
        dayVals[h - 1].push(w.ret[Math.min(h, L) - 1]);
        dayWeeks[h - 1].push(w.entryTime);
      }
      holdVals.push(w.ret[L - 1]);
      holdWeeks.push(w.entryTime);
    }

    const ts = tickerSharpeByDay(weeks);
    perTicker.push({ ticker: s.ticker, name: s.name ?? s.ticker, bestDay: ts.best, bestSharpe: ts.bestSharpe, holdSharpe: ts.holdSharpe });
  }

  if (nUsed < 2) return { ...empty, reason: "トレード週の取れる銘柄が不足" };

  const byDay = dayVals.map((v, i) => toDayCell(i + 1, v, dayWeeks[i]));
  let bestDay = 1;
  for (let h = 2; h <= H_MAX; h++) if (byDay[h - 1].sharpe > byDay[bestDay - 1].sharpe) bestDay = h;

  return {
    ok: true,
    nTickers: nUsed,
    from,
    to,
    byDay,
    hold: toDayCell(0, holdVals, holdWeeks),
    bestDay,
    perTicker: perTicker.sort((a, b) => a.bestDay - b.bestDay),
    side,
  };
}

export { H_MAX };
