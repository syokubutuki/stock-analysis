import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRiseToDecline, type DeclineDefinition, type RiseToDeclineOptions } from "../rise-to-decline";
import type { PricePoint } from "../types";
import { golden } from "./helpers/golden";

function series(closes: number[]): PricePoint[] {
  return closes.map((close, i) => ({
    time: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: close, high: close, low: close, close, volume: 0,
  }));
}
const options: RiseToDeclineOptions = { lookback: 1, risePct: 5, horizon: 4, excludeOverlap: false };
const prices = series([100, 105, 106, 106, 104, 110, 111, 110, 116, 117, 123]);

test("固定系列: 同値を通過し、打ち切りと0日追跡を含めた待ち時間分布の黄金値", () => {
  const r = computeRiseToDecline(prices, options);
  assert.equal(r.error, null);
  assert.deepEqual(r.events.map((e) => [e.signalDate, e.duration, e.outcome]), [
    ["2026-01-02", 3, "decline"], ["2026-01-06", 2, "decline"],
    ["2026-01-09", 2, "data-end"], ["2026-01-11", 0, "data-end"],
  ]);
  assert.deepEqual(r.days.map((d) => [d.day, d.atRisk, d.declines, d.censored, golden(d.cumulativeProbability!)]), [
    [1, 3, 0, 0, 0], [2, 3, 1, 1, 0.3333333333], [3, 1, 1, 0, 1], [4, 0, 0, 0, 1],
  ]);
  assert.deepEqual([r.rawSignals, r.observed, r.horizonCensored, r.endCensored, r.zeroFollowup, r.median, ...r.quartiles], [4, 2, 0, 2, 1, 3, 2, 3]);
  assert.deepEqual(r.bins.map((b) => b.count), [0, 1, 1, 0]);
});

test("追跡上限日の下落は発生として扱い、上限後の下落を参照しない", () => {
  const p = series([100, 105, 105, 106, 107, 104]);
  const exact = computeRiseToDecline(p, options);
  assert.deepEqual(exact.events.map((e) => [e.duration, e.outcome]), [[4, "decline"]]);
  const before = computeRiseToDecline(p, { ...options, horizon: 3 });
  assert.deepEqual(before.events.map((e) => [e.duration, e.outcome]), [[3, "horizon"]]);
  assert.equal(before.median, null);
  assert.equal(before.days[2].cumulativeProbability, 0);
});

test("末尾の打ち切りしかない場合、未観測の裾を0%で外挿しない", () => {
  const r = computeRiseToDecline(series([100, 105, 106]), options);
  assert.deepEqual(r.days.map((d) => d.cumulativeProbability), [0, null, null, null]);
  assert.equal(r.endCensored, 1);
  assert.equal(r.observed, 0);
  assert.deepEqual(r.quartiles, [null, null]);
  const zero = computeRiseToDecline(series([100, 105]), options);
  assert.equal(zero.zeroFollowup, 1);
  assert.deepEqual(zero.days.map((d) => d.cumulativeProbability), [null, null, null, null]);
});

test("重複除外は早期下落で待機を短縮せず、上限の翌日から再採用する", () => {
  const p = series([100, 106, 104, 111, 117, 124, 131, 130]);
  const r = computeRiseToDecline(p, { ...options, excludeOverlap: true });
  assert.equal(r.rawSignals, 5);
  assert.deepEqual(r.events.map((e) => [e.signalDate, e.duration]), [["2026-01-02", 1], ["2026-01-07", 1]]);
});

test("N日リターンで条件成立しても当日の下落は数えず、翌日以降を追跡する", () => {
  const r = computeRiseToDecline(series([100, 110, 106, 107, 105]), { ...options, lookback: 2, excludeOverlap: true });
  assert.deepEqual(r.events.map((e) => [e.signalDate, e.duration, e.endDate]), [["2026-01-03", 2, "2026-01-05"]]);
});

test("条件一致なし・不十分な履歴・無効入力を区別する", () => {
  assert.equal(computeRiseToDecline(series([100, 100, 100]), options).events.length, 0);
  assert.equal(computeRiseToDecline(series([100, 100, 100]), options).error, null);
  for (const p of [[], series([100]), series([100, NaN]), series([100, 0]), [...prices].reverse()]) {
    assert.ok(computeRiseToDecline(p, options).error);
  }
  for (const patch of [{ lookback: 1.5 }, { horizon: 0 }, { horizon: 253 }, { risePct: NaN }, { risePct: 0 }]) {
    assert.ok(computeRiseToDecline(prices, { ...options, ...patch }).error);
  }
});

test("6種類の定義: 同じ固定系列での成立日・最高終値日の黄金値", () => {
  const p = series([90, 100, 103, 105, 104, 102, 99]);
  const cases: [DeclineDefinition, number, number][] = [
    ["first-down", 1, 3], ["daily-drop", 1, 4], ["consecutive", 1, 4],
    ["drawdown", 2, 4], ["below-signal", 1, 5], ["future-peak", 1, 2],
  ];
  for (const [definition, dropPct, expected] of cases) {
    const r = computeRiseToDecline(p, { ...options, risePct: 10, horizon: 5, definition, dropPct, consecutiveDays: 2 });
    assert.equal(r.error, null);
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].duration, expected, definition);
    assert.equal(r.median, expected, definition);
    assert.equal(r.observed, 1);
  }
});

test("連続下落: 同値と上昇でリセットし、成立したK日目を返す", () => {
  const r = computeRiseToDecline(series([90, 100, 99, 99, 98, 100, 99, 98]), {
    ...options, risePct: 10, horizon: 6, definition: "consecutive", consecutiveDays: 2,
  });
  assert.deepEqual(r.events.map(e => [e.duration, e.outcome]), [[6, "decline"]]);
});

test("下落率: 閾値一致を含み、当日までの高値と条件成立価格を区別する", () => {
  const p = series([90, 100, 110, 108.9, 100, 99]);
  const first = (definition: DeclineDefinition, dropPct = 1) => computeRiseToDecline(p, {
    ...options, risePct: 10, excludeOverlap: true, definition, dropPct,
  }).events[0].duration;
  assert.equal(first("daily-drop"), 2);
  assert.equal(first("drawdown"), 2);
  assert.equal(first("below-signal"), 4);
  const fromOrigin = computeRiseToDecline(series([90, 100, 99]), { ...options, risePct: 10, definition: "drawdown", dropPct: 1 });
  assert.equal(fromOrigin.events[0].outcome, "decline");
});

test("最高終値: 同値は最初の日、起点は除外、未完成窓はKMに混ぜない", () => {
  const r = computeRiseToDecline(series([90, 100, 103, 105, 105, 99, 110]), {
    ...options, risePct: 10, definition: "future-peak",
  });
  assert.deepEqual(r.events.map(e => [e.duration, e.outcome]), [[2, "peak"], [0, "incomplete"]]);
  assert.deepEqual([r.observed, r.incomplete, r.horizonCensored, r.endCensored, r.median], [1, 1, 0, 0, 2]);
  assert.deepEqual(r.days.map(d => d.cumulativeProbability), [0, 1, 1, 1]);
  const falling = computeRiseToDecline(series([90, 100, 99, 98, 97, 96]), { ...options, risePct: 10, definition: "future-peak" });
  assert.equal(falling.events[0].duration, 1);
  const rising = computeRiseToDecline(series([90, 100, 101, 102, 103, 104]), { ...options, risePct: 10, definition: "future-peak" });
  assert.equal(rising.peaksAtHorizon, 1);
});

test("最高終値: 全窓未完成なら中央値・割合を推定せず、完全窓では経験分布を使う", () => {
  const none = computeRiseToDecline(series([90, 100, 102]), { ...options, risePct: 10, definition: "future-peak" });
  assert.equal(none.incomplete, 1);
  assert.equal(none.median, null);
  assert.deepEqual(none.days.map(d => d.cumulativeProbability), [null, null, null, null]);
  const r = computeRiseToDecline(series([90, 100, 110, 105, 104, 103, 110]), { ...options, risePct: 10, definition: "future-peak" });
  assert.deepEqual(r.events.map(e => [e.duration, e.outcome]), [[1, "peak"], [4, "peak"]]);
  assert.deepEqual(r.days.map(d => d.cumulativeProbability), [0.5, 0.5, 0.5, 1]);
  assert.deepEqual([r.median, ...r.quartiles], [1, 1, 4]);
});

test("定義ごとのパラメーター検証: 使わない設定は他モードを妨げない", () => {
  for (const dropPct of [0, 100, NaN]) {
    for (const definition of ["daily-drop", "drawdown"] as const) {
      assert.ok(computeRiseToDecline(prices, { ...options, definition, dropPct }).error);
    }
  }
  for (const consecutiveDays of [0, 1.5, 5, NaN]) {
    assert.ok(computeRiseToDecline(prices, { ...options, definition: "consecutive", consecutiveDays }).error);
  }
  assert.equal(computeRiseToDecline(prices, { ...options, definition: "future-peak", dropPct: NaN, consecutiveDays: NaN }).error, null);
});

test("原系列の区間: 過去L日、起点、結果の日、H日の終端を区別する", () => {
  const r = computeRiseToDecline(series([90, 95, 100, 99, 102, 103, 104]), {
    ...options, lookback: 2, risePct: 10, excludeOverlap: true,
  });
  assert.deepEqual(r.events.map(e => [e.lookbackStartIndex, e.signalIndex, e.duration, e.followupEndIndex, e.availableFollowup]), [[0, 2, 1, 6, 4]]);
  assert.equal(r.events[0].endDate, "2026-01-04");
  // 早期成立（3番目のバー）と、追跡上限（6番目のバー）を混同しない。
  assert.notEqual(r.events[0].signalIndex + r.events[0].duration, r.events[0].followupEndIndex);
  const partial = computeRiseToDecline(series([90, 100, 101]), { ...options, risePct: 10, definition: "future-peak" });
  assert.deepEqual(partial.events.map(e => [e.lookbackStartIndex, e.signalIndex, e.followupEndIndex, e.availableFollowup]), [[0, 1, 2, 1]]);
  const zero = computeRiseToDecline(series([90, 100]), { ...options, risePct: 10 });
  assert.deepEqual(zero.events.map(e => [e.signalIndex, e.followupEndIndex, e.availableFollowup]), [[1, 1, 0]]);
});
