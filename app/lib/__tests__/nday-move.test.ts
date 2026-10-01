// 値動き条件別の将来分布・売買検証（cond-nday-move）の数値テスト。
// 合成系列だけを使う（Yahoo は叩かない）。期待値は手計算か、実装とは別に書いた式で出す。

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PricePoint } from "../types";
import {
  type MoveCondition, adoptEvents, auditPrices, conditionAt, preEventSigma, scanTriggers, zScore, SIGMA_WINDOW,
} from "../nday-move";
import { computeDistribution } from "../nday-move-paths";
import {
  type CapitalModel, type TradeOptions, computeTrades, simulateAccount, placeboTiming, forwardSamples, comparePredictive,
} from "../nday-move-trades";
import {
  type RobustnessConfig, DEFAULT_CSCV, concentration, expandGrid, neighborsOf, parseNumberList, runRobustness, selectionInflation,
} from "../nday-move-robustness";
import { cscvPbo } from "../cscv-pbo";
import { kaplanMeierDaily, survivalQuantile } from "../survival";
import { parseExport, priceFingerprint, toCsv, buildExport, type NdayMoveSettings } from "../nday-move-export";
import { golden } from "./helpers/golden";
import { makeNormal, mulberry32 } from "./helpers/rng";

// ───────────── 合成データの道具 ─────────────

function day(i: number): string {
  const d = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** 終値だけを指定（始値は前日終値、出来高あり）。 */
function closesSeries(closes: number[]): PricePoint[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return { time: day(i), open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1000 };
  });
}

/** [始値, 終値] を指定。 */
function ocSeries(bars: [number, number][]): PricePoint[] {
  return bars.map(([open, close], i) => ({
    time: day(i), open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1000,
  }));
}

/** 休場日の擬似行（出来高0・4本値が前日終値）に置き換える。 */
function makeNoTrade(prices: PricePoint[], index: number): PricePoint[] {
  const out = prices.map((p) => ({ ...p }));
  const c = out[index - 1].close;
  out[index] = { ...out[index], open: c, high: c, low: c, close: c, volume: 0 };
  return out;
}

/** 平日だけの日付で、seed 付きの対数正規ランダムウォーク。 */
function randomWalk(bars: number, seed: number, drift = 0, vol = 0.015, startYear = 2016): PricePoint[] {
  const normal = makeNormal(mulberry32(seed));
  const out: PricePoint[] = [];
  let close = 1000;
  let t = Date.UTC(startYear, 0, 4);
  while (out.length < bars) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const gap = normal() * vol * 0.4;
      const open = close * Math.exp(gap);
      const next = open * Math.exp(drift + normal() * vol * 0.9);
      out.push({
        time: new Date(t).toISOString().slice(0, 10), open, close: next,
        high: Math.max(open, next) * 1.002, low: Math.min(open, next) * 0.998, volume: 5000,
      });
      close = next;
    }
    t += 86_400_000;
  }
  return out;
}

const DOWN5: MoveCondition = { direction: "down", lookback: 2, threshold: 5, unit: "pct", trigger: "edge" };
const NO_COST_CAPITAL: CapitalModel = { initialCapital: 1_000_000, allocationPct: 100, lotSize: 0 };
const tradeOptions = (holdDays: number, commissionPct = 0, slippagePct = 0, capital = NO_COST_CAPITAL): TradeOptions => ({
  holdDays, cost: { commissionPct, slippagePct }, capital,
});
const whole = (p: PricePoint[]) => ({ start: 0, end: p.length - 1 });

// ───────────── 条件とイベント ─────────────

describe("条件の判定とイベントの拾い方", () => {
  const prices = closesSeries([100, 100, 100, 95, 94, 96, 90, 90, 95, 100]);

  test("立ち上がりと成立日すべてを区別し、閾値ちょうど（−5%）を含める", () => {
    const edge = scanTriggers(prices, DOWN5, whole(prices));
    assert.equal(edge.conditionDays, 3); // t=3(−5%), 4(−6%), 7(−6.25%)
    assert.deepEqual(edge.triggers.map((t) => t.index), [3, 7]);
    const every = scanTriggers(prices, { ...DOWN5, trigger: "every" }, whole(prices));
    assert.deepEqual(every.triggers.map((t) => t.index), [3, 4, 7]);
    assert.equal(golden(edge.triggers[0].movePct), -5);
  });

  test("データ先頭で既に成立していた日は、立ち上がりか分からないので除外する", () => {
    const p = closesSeries([100, 100, 94, 93, 100]);
    const scan = scanTriggers(p, DOWN5, whole(p));
    assert.equal(scan.leading?.index, 2);
    assert.deepEqual(scan.triggers, []);
    assert.equal(scan.conditionDays, 2);
  });

  test("分析期間の開始前の価格は判定に使ってよい（as-of）: 前日の成立が分かれば先頭除外にならない", () => {
    const p = closesSeries([100, 100, 94, 93, 100]);
    const scan = scanTriggers(p, DOWN5, { start: 3, end: 4 });
    assert.equal(scan.leading, null);
    assert.deepEqual(scan.triggers, []); // t=3 は前日から続く成立
    assert.equal(scan.conditionDays, 1);
    assert.equal(scan.firstSignalIndex, 3);
  });

  test("重複除外は採用日 t の次を t+H+1 から探す（実際の値動きで間隔を変えない）", () => {
    const fake = [3, 7, 10, 14].map((index) => ({ index, date: day(index), movePct: -6, z: null }));
    const r = adoptEvents(fake, 4, true);
    assert.deepEqual(r.adopted.map((t) => t.index), [3, 10]);
    assert.deepEqual(r.overlapExcluded.map((t) => t.index), [7, 14]);
    assert.equal(adoptEvents(fake, 4, false).adopted.length, 4);
  });

  test("σ単位: 事前ボラは判定区間 [t−n, t] を含めない", () => {
    const base = randomWalk(120, 7);
    const t = 100;
    const n = 5;
    const sigma = preEventSigma(base, t, n) as number;
    // 判定区間内の値動きを極端に変えても σ̂ は変わらない
    const shocked = base.map((p, i) => (i > t - n && i <= t ? { ...p, close: p.close * 0.7 } : p));
    assert.equal(preEventSigma(shocked, t, n), sigma);
    const z = zScore(shocked, t, n) as number;
    assert.ok(z < 0);
    assert.equal(golden(z), golden(Math.log(shocked[t].close / shocked[t - n].close) / (sigma * Math.sqrt(n))));
    assert.equal(conditionAt(base, n + SIGMA_WINDOW - 1, { ...DOWN5, unit: "sigma", lookback: n, threshold: 1 }), null);
  });

  test("監査: 投信型・休場日の擬似行・4本値同値（出来高あり）を区別し、壊れた日付は集計しない", () => {
    const fund = closesSeries([100, 101, 102]).map((p) => ({ ...p, open: p.close, high: p.close, low: p.close, volume: 0 }));
    assert.equal(auditPrices(fund).closeOnly, true);
    let p = makeNoTrade(closesSeries([100, 101, 102, 103]), 2);
    p = p.map((x, i) => (i === 3 ? { ...x, open: 103, high: 103, low: 103, close: 103 } : x));
    const audit = auditPrices(p);
    assert.equal(audit.closeOnly, false);
    assert.deepEqual(audit.noTradeBars, [2]);
    // 0本目は合成系列の作り方で始値=終値（4本値同値・出来高あり）になっている
    assert.deepEqual(audit.singlePriceBars, [0, 3]);
    const broken = closesSeries([100, 101]);
    broken[1] = { ...broken[1], time: broken[0].time };
    assert.ok(auditPrices(broken).error);
    assert.ok(auditPrices([]).error);
  });
});

// ───────────── ① 分布 ─────────────

describe("① 条件成立後の分布", () => {
  // t=2 で 94/100 = −6%（前日 t=1 は 0%）→ 立ち上がり。H=4。
  const bars: [number, number][] = [[100, 100], [100, 100], [99, 94], [95, 96], [96, 93], [93, 96], [96, 95], [95, 95]];
  const prices = ocSeries(bars);
  const cond: MoveCondition = { ...DOWN5, lookback: 1 };

  test("経路・極値（同値は最初の日）・初回の前日割れ・高値からの反落・翌朝の窓", () => {
    const r = computeDistribution(prices, auditPrices(prices), cond, whole(prices), { horizon: 4, excludeOverlap: true, drawdownPct: 3 });
    assert.equal(r.error, null);
    assert.equal(r.events.length, 1);
    const e = r.events[0];
    assert.equal(e.index, 2);
    assert.deepEqual(e.pathPct.map((v) => golden(v)), [0, golden(100 * (96 / 94 - 1)), golden(100 * (93 / 94 - 1)), golden(100 * (96 / 94 - 1)), golden(100 * (95 / 94 - 1))]);
    assert.equal(e.minDay, 2);
    assert.equal(e.maxDay, 1); // 96 が k=1 と k=3 で同値 → 最初の日
    assert.deepEqual(e.firstDown, { time: 2, observed: true });
    assert.deepEqual(e.drawdown, { time: 2, observed: true }); // 1 − 93/96 = 3.125% ≥ 3%
    assert.equal(golden(e.gapPct as number), golden(100 * (95 / 94 - 1)));
    assert.equal(golden(e.finalPct as number), golden(100 * (95 / 94 - 1)));
    assert.equal(r.maxDayHist[1], 1);
    assert.equal(r.minDayHist[2], 1);
    assert.equal(r.medoid, 0);
  });

  test("0日目も極値の候補に含め、H日目の極値は窓の端として数える", () => {
    // 0日目 94 と 2日目 94 が同値の最低 → 0日目。最高は H=4 日目。
    const p = closesSeries([100, 100, 94, 96, 94, 97, 98]);
    const r = computeDistribution(p, auditPrices(p), cond, whole(p), { horizon: 4, excludeOverlap: true, drawdownPct: 3 });
    const e = r.events[0];
    assert.equal(e.minDay, 0);
    assert.equal(e.maxDay, 4);
    assert.equal(r.minDayHist[0], 1);
    assert.equal(r.maxDayHist[4], 1);
    // 同値の終値は「前日割れ」ではない。反落 3% にも届かない → どちらも打ち切り（time = A = 4）
    assert.deepEqual(e.firstDown, { time: 2, observed: true });
    assert.deepEqual(e.drawdown, { time: 4, observed: false });
  });

  test("観測が足りない末尾の事例は一覧に残し、分布から除き、KMでは打ち切りにする", () => {
    const p = closesSeries([100, 100, 94, 96, 97, 100, 100, 93, 95]);
    const r = computeDistribution(p, auditPrices(p), cond, whole(p), { horizon: 4, excludeOverlap: true, drawdownPct: 3 });
    assert.deepEqual(r.events.map((e) => [e.index, e.available, e.complete]), [[2, 4, true], [7, 1, false]]);
    assert.deepEqual([r.counts.complete, r.counts.incomplete], [1, 1]);
    assert.equal(r.minDayHist.reduce((a, b) => a + b, 0), 1);
    // 2件とも1日目に下落せず（96>94, 95>93）。1件目は4日目まで下落なし、2件目は1日で打ち切り
    assert.deepEqual(r.firstDownKM.map((d) => [d.day, d.atRisk, d.events, d.censored]), [[1, 2, 0, 1], [2, 1, 0, 0], [3, 1, 0, 0], [4, 1, 0, 1]]);
    assert.equal(r.firstDownMedian, null);
    assert.equal(r.events[1].finalPct, null);
  });

  test("未来を書き換えても、観測窓がそれより前で閉じる事例は変わらない", () => {
    const base = randomWalk(400, 11, 0, 0.02);
    const opts = { horizon: 10, excludeOverlap: true, drawdownPct: 3 };
    const c: MoveCondition = { ...DOWN5, lookback: 5, threshold: 4 };
    const a = computeDistribution(base, auditPrices(base), c, whole(base), opts);
    const cut = 300;
    const mutated = base.map((p, i) => (i >= cut ? { ...p, open: p.open * 1.3, close: p.close * (i % 2 ? 0.8 : 1.25) } : p));
    const b = computeDistribution(mutated, auditPrices(mutated), c, whole(mutated), opts);
    const early = (r: typeof a) => r.events.filter((e) => e.index + 10 < cut).map((e) => JSON.stringify([e.index, e.pathPct, e.minDay, e.maxDay, e.firstDown, e.drawdown]));
    assert.ok(early(a).length > 3);
    assert.deepEqual(early(b), early(a));
  });

  test("無条件の比較基準は、期間内の全営業日を起点にした完全窓から作る", () => {
    const p = closesSeries([100, 100, 94, 96, 97, 100, 101]);
    const r = computeDistribution(p, auditPrices(p), cond, whole(p), { horizon: 2, excludeOverlap: true, drawdownPct: 3 });
    // 起点は判定できる最初の日 t=1 から end−H=4 まで → 4本
    assert.equal(r.baseline[2].n, 4);
  });

  test("投信型でも終値だけで分布は計算でき、翌朝の窓は出さない", () => {
    const fund = closesSeries([100, 100, 94, 96, 93, 96, 95]).map((x) => ({ ...x, open: x.close, high: x.close, low: x.close, volume: 0 }));
    const r = computeDistribution(fund, auditPrices(fund), cond, whole(fund), { horizon: 4, excludeOverlap: true, drawdownPct: 3 });
    assert.equal(r.error, null);
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].gapPct, null);
  });
});

// ───────────── ② 売買 ─────────────

describe("② 実行可能な買いのみの売買", () => {
  // t=2: 94/100 = −6%（前日 0%）→ シグナル。t=5: 92/98 = −6.1%（前日 +2.08%）→ シグナル。
  const bars: [number, number][] = [[100, 100], [100, 100], [99, 94], [95, 96], [97, 98], [98, 92], [90, 91], [92, 93], [93, 93]];
  const prices = ocSeries(bars);
  const cond: MoveCondition = { ...DOWN5, lookback: 1 };

  test("t日の引けで判定 → t+1 の寄りで買い → t+h の引けで売る（h=2）", () => {
    const r = computeTrades(prices, auditPrices(prices), cond, whole(prices), tradeOptions(2));
    assert.equal(r.error, null);
    assert.deepEqual(r.trades.map((t) => [t.signalIndex, t.entryIndex, t.entryPrice, t.exitIndex, t.exitPrice, t.status]), [
      [2, 3, 95, 4, 98, "closed"],
      [5, 6, 90, 7, 93, "closed"],
    ]);
    assert.equal(r.evalStart, 2); // 判定できる最初の日 t=1 の翌日から口座を開く
    const expected = 1_000_000 * (98 / 95) * (93 / 90);
    assert.equal(golden(r.equity.at(-1)!.strategy), golden(expected));
    assert.equal(golden(r.strategy!.finalValue), golden(expected));
    // 買い持ちは口座を開いた日の寄り（99）で買う
    assert.equal(r.buyHoldEntryIndex, 2);
    assert.equal(golden(r.buyHold!.finalValue), golden(1_000_000 * 93 / 99));
    assert.equal(r.stats.closed, 2);
    assert.equal(golden(r.stats.winRate as number), 1);
  });

  test("h=1 は同じ日の寄りで買って引けで売る", () => {
    const r = computeTrades(prices, auditPrices(prices), cond, whole(prices), tradeOptions(1));
    assert.deepEqual(r.trades.map((t) => [t.entryIndex, t.exitIndex, golden(t.grossReturn)]), [[3, 3, golden(96 / 95 - 1)], [6, 6, golden(91 / 90 - 1)]]);
  });

  test("費用: 片道 c を買いと売りの両方に掛ける（対数で 2·ln(1−c)）。買い持ちも1往復分を払う", () => {
    const r = computeTrades(prices, auditPrices(prices), cond, whole(prices), tradeOptions(2, 0.05, 0.05));
    const c = 0.001;
    assert.equal(golden(r.cost), golden(c));
    assert.equal(golden(r.trades[0].netLog), golden(Math.log(98 / 95) + 2 * Math.log(1 - c)));
    assert.equal(golden(r.strategy!.finalValue), golden(1_000_000 * (1 - c) ** 4 * (98 / 95) * (93 / 90)));
    assert.equal(golden(r.buyHold!.finalValue), golden(1_000_000 * (1 - c) ** 2 * (93 / 99)));
    // 取引1回の平均が0になる片道費用: 2·ln(1−c*) = −mean(ln(exit/entry))
    const meanG = (Math.log(98 / 95) + Math.log(93 / 90)) / 2;
    assert.equal(golden(r.breakEven.tradeOneWayPct as number), golden(100 * (1 - Math.exp(-meanG / 2))));
  });

  test("保有中のシグナルは無視して数え、決済日の引けのシグナルは翌日に建ててよい", () => {
    // t=2 シグナル、t=3 も成立（every）→ 保有中、t=6 は立ち上がり
    const p = closesSeries([100, 100, 94, 88, 90, 91, 85, 86, 87, 88]);
    const every = computeTrades(p, auditPrices(p), { ...cond, trigger: "every" }, whole(p), tradeOptions(3));
    assert.deepEqual(every.trades.map((t) => [t.signalIndex, t.entryIndex, t.exitIndex]), [[2, 3, 5], [6, 7, 9]]);
    assert.deepEqual(every.skipped.map((s) => [s.index, s.reason]), [[3, "holding"]]);
    // h=4: 1本目の決済日 t=6 の引けで次のシグナル → t=7 の寄りで建て、期末は未決済
    const edge = computeTrades(p, auditPrices(p), cond, whole(p), tradeOptions(4));
    assert.deepEqual(edge.trades.map((t) => [t.signalIndex, t.entryIndex, t.exitIndex, t.status]), [[2, 3, 6, "closed"], [6, 7, 9, "open"]]);
    assert.equal(edge.stats.closed, 1);
    assert.equal(edge.stats.open, 1);
  });

  test("約定できない日（休場日の擬似行）の寄りでは買わず、決済予定日なら次の立会日へ延ばす", () => {
    const skipEntry = makeNoTrade(prices, 3);
    const a = computeTrades(skipEntry, auditPrices(skipEntry), cond, whole(skipEntry), tradeOptions(2));
    assert.deepEqual(a.skipped.map((s) => [s.index, s.reason]), [[2, "entry-no-trade"]]);
    const delayExit = makeNoTrade(prices, 4);
    const b = computeTrades(delayExit, auditPrices(delayExit), cond, whole(delayExit), tradeOptions(2));
    assert.deepEqual([b.trades[0].exitIndex, b.trades[0].exitDelayed], [5, true]);
  });

  test("期間末のシグナルは翌営業日が無いので約定しない（件数に残す）", () => {
    const p = closesSeries([100, 100, 100, 94]);
    const r = computeTrades(p, auditPrices(p), cond, whole(p), tradeOptions(2));
    assert.deepEqual(r.skipped.map((s) => [s.index, s.reason]), [[3, "no-next-bar"]]);
    assert.equal(r.trades.length, 0);
    // 取引なし: 資産は初期資金のまま
    assert.ok(r.equity.every((e) => e.strategy === 1_000_000));
  });

  test("単元株: 株数は単元の倍数、足りなければ見送る", () => {
    const lot: CapitalModel = { initialCapital: 10_000, allocationPct: 100, lotSize: 100 };
    const r = computeTrades(prices, auditPrices(prices), cond, whole(prices), tradeOptions(2, 0, 0, lot));
    assert.deepEqual(r.trades.map((t) => t.shares), [100, 100]);
    const poor = computeTrades(prices, auditPrices(prices), cond, whole(prices), tradeOptions(2, 0, 0, { ...lot, initialCapital: 5000 }));
    assert.deepEqual(poor.skipped.map((s) => s.reason), ["insufficient-capital", "insufficient-capital"]);
  });

  test("未来を書き換えても、それより前の建玉判断・約定・資産は変わらない（先読みなし）", () => {
    const base = randomWalk(600, 23, 0, 0.02);
    const c: MoveCondition = { direction: "down", lookback: 5, threshold: 3, unit: "pct", trigger: "edge" };
    const a = computeTrades(base, auditPrices(base), c, whole(base), tradeOptions(5, 0.05, 0.05));
    const cut = 400;
    const mutated = base.map((p, i) => (i >= cut ? { ...p, open: p.open * 0.7, high: p.high * 1.5, low: p.low * 0.5, close: p.close * (i % 3 ? 1.4 : 0.6) } : p));
    const b = computeTrades(mutated, auditPrices(mutated), c, whole(mutated), tradeOptions(5, 0.05, 0.05));
    const before = (r: typeof a) => r.trades.filter((t) => t.exitIndex < cut).map((t) => JSON.stringify(t));
    assert.ok(before(a).length > 5);
    assert.deepEqual(before(b), before(a));
    const entriesUpTo = (r: typeof a) => r.trades.filter((t) => t.entryIndex <= cut).map((t) => t.entryIndex);
    assert.deepEqual(entriesUpTo(b), entriesUpTo(a));
    const eqBefore = (r: typeof a) => r.equity.filter((e) => e.index < cut).map((e) => e.strategy);
    assert.deepEqual(eqBefore(b), eqBefore(a));
  });

  test("無作為タイミングと予測力の比較は、同じ seed で同じ結果になる", () => {
    const base = randomWalk(700, 31);
    const c: MoveCondition = { direction: "down", lookback: 5, threshold: 3, unit: "pct", trigger: "edge" };
    const r1 = computeTrades(base, auditPrices(base), c, whole(base), tradeOptions(5));
    const r2 = computeTrades(base, auditPrices(base), c, whole(base), tradeOptions(5));
    assert.ok(r1.placebo && r1.predictive?.ci95);
    assert.deepEqual(r1.placebo!.totals, r2.placebo!.totals);
    assert.deepEqual(r1.predictive!.ci95, r2.predictive!.ci95);
    assert.ok(r1.placebo!.percentile >= 0 && r1.placebo!.percentile <= 1);
    // 予測力の標本: 平均の差はシグナルと無条件の平均の差そのもの
    const p = r1.predictive!;
    assert.equal(golden(p.diffMean as number), golden((p.signal.mean as number) - (p.unconditional.mean as number)));
  });

  test("プラセボの取引は重ならず、件数と保有日数が実際と同じ", () => {
    const base = randomWalk(300, 5);
    const noTrade = new Uint8Array(base.length);
    const r = placeboTiming(base, noTrade, 10, 5, 0, 10, base.length - 1, 0, 20, 99);
    assert.ok(r);
    assert.equal(r!.completed, 20);
    assert.equal(r!.trades, 10);
  });

  test("forwardSamples は約定できない日を起点にせず、決済日が約定できなければ次の立会日で売る", () => {
    const p = makeNoTrade(ocSeries([[100, 100], [100, 101], [101, 102], [102, 103], [103, 104]]), 2);
    const noTrade = new Uint8Array(p.length);
    noTrade[2] = 1;
    const s = forwardSamples(p, noTrade, [0, 1, 2], 1, 0, p.length - 1);
    // 起点0: 買い=1の寄り(100)、売り=1の引け(101)。起点1: 買いが約定不可(2)で除外。起点2: 買い=3の寄り、売り=3の引け
    assert.deepEqual(s.map((x) => [x.index, golden(x.netReturn)]), [[0, golden(101 / 100 - 1)], [2, golden(103 / 102 - 1)]]);
    const cmp = comparePredictive(s, s, 0, 2, 1, 10, 1);
    assert.equal(cmp.ci95, null); // 件数が足りなければ区間を出さない
  });
});

// ───────────── ③ 頑健性 ─────────────

describe("③ 頑健性と過剰適合", () => {
  test("候補格子の展開と数値の並びの入力", () => {
    assert.deepEqual(parseNumberList("3, 5、10 20"), [3, 5, 10, 20]);
    const specs = expandGrid({ directions: ["down", "up"], lookbacks: [3, 5, 5, 0], thresholds: [3, 5], holds: [3, 1.5] });
    assert.equal(specs.length, 2 * 2 * 2 * 1); // 重複・非整数・範囲外を除く
  });

  const prices = randomWalk(6 * 250, 101, 0.0002, 0.018);
  const config: RobustnessConfig = {
    grid: { directions: ["down", "up"], lookbacks: [3, 5], thresholds: [2, 4], holds: [3, 5] },
    unit: "pct", trigger: "edge",
    cost: { commissionPct: 0, slippagePct: 0.05 },
    capital: NO_COST_CAPITAL,
    walkForward: { minTrainYears: 2, minTrades: 3 },
    cscv: { ...DEFAULT_CSCV, minTradesMedian: 5, minDistinct: 4 },
  };

  test("ウォークフォワード: 検証期間以降の価格を書き換えても、その期の選択は変わらない（漏れがない）", () => {
    const a = runRobustness(prices, auditPrices(prices), whole(prices), config);
    assert.equal(a.error, null);
    assert.equal(a.walkForward.status, "ok");
    assert.ok(a.walkForward.folds.length >= 3);
    const fold = a.walkForward.folds[1];
    const cut = prices.findIndex((p) => p.time >= fold.testStartDate);
    const mutated = prices.map((p, i) => (i >= cut ? { ...p, open: p.open * 1.2, close: p.close * (i % 2 ? 0.7 : 1.3) } : p));
    const b = runRobustness(mutated, auditPrices(mutated), whole(mutated), config);
    const sel = (r: typeof a, k: number) => JSON.stringify([r.walkForward.folds[k].selected, r.walkForward.folds[k].trainSharpe, r.walkForward.folds[k].trainTrades]);
    assert.equal(sel(b, 0), sel(a, 0));
    assert.equal(sel(b, 1), sel(a, 1));
  });

  test("訓練期間の境界パージ: 決済が訓練末を越える取引を建てない", () => {
    const noTrade = new Uint8Array(prices.length);
    const end = 400;
    // 395 は 395+5 = 400 = 訓練末で決済できるので建てる。396 と 399 は訓練末を越えるので建てない。
    const signals = [100, 200, 395, 396, 399].map((index) => ({ index, movePct: -5, holdDays: 5 }));
    const sim = simulateAccount({ prices, noTrade, singlePrice: noTrade, signals, cost: 0, capital: NO_COST_CAPITAL, evalStart: 50, end, purgeBeyondEnd: true });
    assert.ok(sim.trades.every((t) => t.exitIndex <= end && t.status === "closed"));
    assert.deepEqual(sim.trades.map((t) => t.signalIndex), [100, 200, 395]);
    assert.deepEqual(sim.skipped.map((s) => [s.index, s.reason]), [[396, "holding"], [399, "holding"]]);
    const afterExit = simulateAccount({ prices, noTrade, singlePrice: noTrade, signals: [396, 399].map((index) => ({ index, movePct: -5, holdDays: 5 })), cost: 0, capital: NO_COST_CAPITAL, evalStart: 50, end, purgeBeyondEnd: true });
    assert.deepEqual(afterExit.skipped.map((s) => [s.index, s.reason]), [[396, "purged"], [399, "purged"]]);
    assert.equal(afterExit.trades.length, 0);
  });

  test("全候補を同じ評価期間で評価し、CSCV の前提を満たせば PBO を返す", () => {
    const r = runRobustness(prices, auditPrices(prices), whole(prices), config);
    assert.equal(r.candidates.length, 16);
    assert.equal(r.cscvStatus.ok, true, r.cscvStatus.reasons.join(" / "));
    assert.ok(r.cscv);
    assert.equal(r.cscv!.combinations, 12870);
    assert.ok(r.cscv!.pbo >= 0 && r.cscv!.pbo <= 1);
  });

  test("標本が足りなければ PBO を計算せず、理由を返す", () => {
    const short = randomWalk(300, 3);
    const r = runRobustness(short, auditPrices(short), whole(short), { ...config, cscv: DEFAULT_CSCV });
    assert.equal(r.cscv, null);
    assert.equal(r.cscvStatus.ok, false);
    assert.ok(r.cscvStatus.reasons.length > 0);
    assert.equal(r.walkForward.status, "insufficient");
  });

  test("利益の集中: 年別の合計、上位の取引を除いた合計", () => {
    const mk = (entryDate: string, netLog: number) => ({ entryDate, netLog, status: "closed" }) as never;
    const c = concentration([mk("2020-01-05", 0.1), mk("2020-06-01", -0.02), mk("2021-03-01", 0.03), mk("2022-02-01", 0.01)]);
    assert.deepEqual(c.byYear.map((y) => [y.year, y.trades, golden(y.sumLog)]), [[2020, 2, golden(0.08)], [2021, 1, 0.03], [2022, 1, 0.01]]);
    assert.deepEqual(c.withoutTop.map((w) => [w.k, golden(w.totalLog)]), [[1, golden(0.02)], [3, golden(-0.02)]]);
    assert.equal(golden(c.top10ShareOfGains as number), golden(0.1 / 0.14));
    assert.deepEqual([c.leaveOneYearOut!.minYear, c.leaveOneYearOut!.maxYear], [2020, 2022]);
  });

  test("近傍は同じ方向で n・p・h のどれか1つだけを1段ずらした候補", () => {
    const grid = { directions: ["down" as const], lookbacks: [3, 5, 10], thresholds: [3, 5], holds: [5] };
    const cands = expandGrid(grid).map((s) => ({ ...s, signals: 0, trades: 0, meanNet: null, medianNet: null, winRate: null, sumNetLog: 0, logGrowth: 0, cagr: null, sharpe: s.lookback, maxDrawdown: 0, exposure: 0 }));
    const nb = neighborsOf(cands, grid, { direction: "down", lookback: 5, threshold: 3, hold: 5 });
    assert.deepEqual(nb!.neighbors.map((c) => [c.lookback, c.threshold]).sort(), [[10, 3], [3, 3], [5, 5]].sort());
    assert.equal(neighborsOf(cands, grid, { direction: "up", lookback: 5, threshold: 3, hold: 5 }), null);
  });

  test("最良を選ぶ水増しの目安 SE·√(2 ln N)", () => {
    assert.equal(golden(selectionInflation(0.04, 50, 96) as number), golden((0.04 / Math.sqrt(50)) * Math.sqrt(2 * Math.log(96))));
    assert.equal(selectionInflation(0.04, 1, 96), null);
  });
});

// ───────────── CSCV ─────────────

describe("CSCV による PBO（Bailey et al.）", () => {
  test("手計算: N=2・S=2 の2通り。訓練最良が検証で最下位 → ω=1/3、λ=ln(1/2)、PBO=1", () => {
    // 列1: A=[1,3](SR 1.414) B=[0,0](SR 0) / 列2: A=[0,2](SR 0.707) B=[1,2](SR 2.121)
    const r = cscvPbo([[1, 3, 0, 0], [0, 2, 1, 2]], 2, 1);
    assert.equal(r.combinations, 2);
    assert.deepEqual(r.logits.map((l) => golden(l)), [golden(Math.log(0.5)), golden(Math.log(0.5))]);
    assert.equal(r.pbo, 1);
    assert.deepEqual(r.oosSelected.map((v) => golden(v)), [0, golden(0.5 / Math.sqrt(0.5))]);
    assert.equal(r.probLoss, 0);
    assert.deepEqual(r.selectedCount, [1, 1]);
  });

  test("組合せの数は C(S, S/2)。余りの行は古い側から落とす", () => {
    const cols = [Array.from({ length: 35 }, (_, i) => Math.sin(i)), Array.from({ length: 35 }, (_, i) => Math.cos(i))];
    const r8 = cscvPbo(cols, 8, 1);
    assert.equal(r8.combinations, 70);
    assert.equal(r8.blockLength, 4);
    assert.equal(r8.dropped, 3);
  });

  test("全候補が同一なら全て同順位（ω=1/2・λ=0）で、λ≤0 の定義により PBO=1", () => {
    const col = Array.from({ length: 40 }, (_, i) => ((i * 7) % 5) - 2);
    const r = cscvPbo([col, [...col], [...col]], 4, 1);
    assert.ok(r.logits.every((l) => Math.abs(l) < 1e-12));
    assert.equal(r.pbo, 1);
    assert.equal(r.distinctN, 1);
  });

  test("本物の優位を1本植えると PBO は小さく、ランダムだけなら多数のデータの平均で約0.5になる", () => {
    const normal = makeNormal(mulberry32(2024));
    const T = 1600;
    const noise = () => Array.from({ length: T }, () => normal() * 0.01);
    const planted = [Array.from({ length: T }, () => 0.004 + normal() * 0.01), ...Array.from({ length: 11 }, noise)];
    const good = cscvPbo(planted, 8);
    assert.ok(good.pbo < 0.1, `planted PBO=${good.pbo}`);
    assert.ok(good.selectedCount[0] > good.combinations * 0.9);
    // 1つのデータの PBO は組合せどうしが塊を共有するため 0.5 から大きくずれうる（1例で 0.19）。
    // 較正は「優位の無い多数のデータで平均すると 0.5」で見る。
    const pbos: number[] = [];
    for (let k = 0; k < 40; k++) pbos.push(cscvPbo(Array.from({ length: 12 }, () => Array.from({ length: 800 }, () => normal() * 0.01)), 8).pbo);
    const meanPbo = pbos.reduce((a, b) => a + b, 0) / pbos.length;
    assert.ok(meanPbo > 0.4 && meanPbo < 0.6, `mean random PBO=${meanPbo}`);
  });
});

// ───────────── 生存時間 ─────────────

describe("Kaplan–Meier（共通関数）", () => {
  test("同日の発生と打ち切りをその日のリスク集合に含め、尽きた先は外挿しない", () => {
    const days = kaplanMeierDaily([
      { time: 1, event: true }, { time: 2, event: true }, { time: 2, event: false }, { time: 3, event: false }, { time: 0, event: false },
    ], 4);
    assert.deepEqual(days.map((d) => [d.day, d.atRisk, d.events, d.censored]), [[1, 4, 1, 0], [2, 3, 1, 1], [3, 1, 0, 1], [4, 0, 0, 0]]);
    assert.deepEqual(days.map((d) => (d.cumulativeProbability === null ? null : golden(d.cumulativeProbability))), [0.25, 0.5, 0.5, null]);
    assert.equal(survivalQuantile(days, 0.5), 2);
    assert.equal(survivalQuantile(days, 0.75), null);
  });
});

// ───────────── 出力と再現 ─────────────

describe("出力と再現", () => {
  const prices = randomWalk(50, 9);

  test("価格の指紋は水準の遡及調整（全体の定数倍）に動じず、値の書き換えには反応する", () => {
    const a = priceFingerprint(prices, 0, 49);
    const scaled = prices.map((p) => ({ ...p, close: p.close * 0.97 }));
    assert.equal(priceFingerprint(scaled, 0, 49).fingerprint, a.fingerprint);
    const edited = prices.map((p, i) => (i === 20 ? { ...p, close: p.close * 1.01 } : p));
    assert.notEqual(priceFingerprint(edited, 0, 49).fingerprint, a.fingerprint);
    assert.equal(a.bars, 50);
  });

  test("CSV は BOM 付きで、カンマ・引用符・改行を引用する", () => {
    assert.equal(toCsv(["a", "b"], [["x,y", 'q"t'], [1.5, null]]), '﻿a,b\r\n"x,y","q""t"\r\n1.5,\r\n');
  });

  test("書き出した JSON を読み戻すと条件が復元され、銘柄やデータの違いを警告する", () => {
    const settings: NdayMoveSettings = {
      direction: "down", lookback: 5, threshold: 5, unit: "pct", trigger: "edge", horizon: 10, excludeOverlap: true,
      drawdownPct: 3, holdDays: 5, cost: { commissionPct: 0, slippagePct: 0.05 }, capital: NO_COST_CAPITAL,
      startDate: prices[0].time, endDate: prices[49].time,
      grid: { directions: ["down"], lookbacks: [5], thresholds: [5], holds: [5] },
      walkForward: { minTrainYears: 3, minTrades: 10 }, cscvS: 16, seed: 1,
    };
    const env = buildExport({
      generatedAt: "2026-09-30T00:00:00Z", ticker: "8306.T", sanitizerVersion: 3, dataQuality: null,
      data: priceFingerprint(prices, 0, 49), analysis: priceFingerprint(prices, 0, 49), settings, notes: [], results: {},
    });
    const text = JSON.stringify(env);
    const same = parseExport(text, { ticker: "8306.T", prices });
    assert.equal(same.error, null);
    assert.deepEqual(same.settings, settings);
    assert.deepEqual(same.warnings, []);
    const other = parseExport(text, { ticker: "7322.T", prices });
    assert.equal(other.warnings.length, 1);
    const changed = parseExport(text, { ticker: "8306.T", prices: prices.map((p, i) => (i === 10 ? { ...p, close: p.close * 1.02 } : p)) });
    assert.equal(changed.warnings.length, 1);
    assert.ok(parseExport("{", { ticker: "8306.T", prices }).error);
    assert.ok(parseExport(JSON.stringify({ kind: "other" }), { ticker: "8306.T", prices }).error);
  });
});
