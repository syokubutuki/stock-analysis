import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSurgePullback, type SurgeOptions } from "../surge-pullback";
import type { PricePoint } from "../types";
import { golden } from "./helpers/golden";

const options: SurgeOptions = { risePct: 5, dropPct: 2, rallyPct: 3, horizon: 4, window: 2,
  basis: "signal", position: "all", newHighOnly: false, excludeOverlap: false };
function series(closes: number[]): PricePoint[] {
  return closes.map((close, i) => ({ time: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: close, high: close + 1, low: close - 1, close, volume: 100 }));
}

test("固定系列: 起点終値からの下落・続伸・打ち切りとKMの黄金値", () => {
  const r = computeSurgePullback(series([100, 100, 105, 109, 102, 102, 108, 108, 107, 106, 112]), options);
  assert.equal(r.error, null);
  assert.deepEqual(r.selected.events.map((e) => [e.index, e.available, e.dropDay, e.rallyDay]), [
    [2, 4, 2, 1], [6, 4, null, 4], [10, 0, null, null],
  ]);
  assert.deepEqual(r.selected.days.map((d) => [d.atRisk, d.events, d.censored, d.cumulativeProbability]), [
    [2, 0, 0, 0], [2, 1, 0, 0.5], [1, 0, 0, 0.5], [1, 0, 1, 0.5],
  ]);
  assert.deepEqual([r.selected.observed, r.selected.horizonCensored, r.selected.endCensored, r.selected.zeroFollowup, r.selected.median], [1, 1, 1, 1, 2]);
  assert.deepEqual(r.selected.first, { drop: 0, rally: 2, neither: 0, tie: 0 });
  assert.equal(r.selected.completeCount, 2);
  assert.deepEqual(r.selected.paths[1] && [r.selected.paths[1].p25, r.selected.paths[1].median, r.selected.paths[1].p75].map((x) => golden(x!)), [0.9523809524, 1.904761905, 2.857142857]);
  assert.equal(golden(r.selected.maxRiseMedian!), 3.756613757);
});

test("下落基準の違いと、日中安値を到達に使わない規約", () => {
  const prices = series([100, 100, 105, 115, 112, 109, 107]);
  prices[3].low = 80;
  const at = (basis: SurgeOptions["basis"]) => computeSurgePullback(prices, { ...options, basis, excludeOverlap: true }).selected.events[0].dropDay;
  assert.equal(at("signal"), null);
  assert.equal(at("peak"), 2);
  assert.equal(at("daily"), 2);
  const gradually = series([100, 100, 105, 104, 103, 102, 101]);
  assert.equal(computeSurgePullback(gradually, options).selected.events[0].dropDay, 3);
  assert.equal(computeSurgePullback(gradually, { ...options, basis: "daily" }).selected.events[0].dropDay, null);
});

test("ローリング高安: 窓落ちと真の更新、同値の直近日、先読みなし", () => {
  const prices = series([100, 110, 105, 104, 104, 120]);
  const r = computeSurgePullback(prices, options);
  assert.deepEqual(r.waves.map((w) => [w.highAge, w.lowAge, w.newHigh, w.newLow, w.highExpired, w.lowExpired]), [
    [0, 1, false, false, false, false],
    [1, 0, false, false, false, true],
    [1, 0, false, true, true, false],
    [0, 0, false, false, true, false],
    [0, 1, true, false, false, false],
  ]);
  assert.deepEqual(r.waves.slice(0, 4), computeSurgePullback(prices.slice(0, 5), options).waves);
  const flat = series([100, 100, 100]).map((p) => ({ ...p, high: 100, low: 100 }));
  assert.equal(computeSurgePullback(flat, options).waves[0].position, null);
});

test("重複除外は下落日でなくH日後まで固定。通常日も急騰を含めず間引く", () => {
  const prices = series([100, 100, 106, 102, 110, 120, 130, 140, 150]);
  const r = computeSurgePullback(prices, { ...options, excludeOverlap: true });
  assert.equal(r.rawSignals, 6);
  assert.deepEqual(r.selected.events.map((e) => e.index), [2, 7]);
  assert.deepEqual(r.baseline.events.map((e) => e.index), [3]);
});

test("境界ぴったりの下落、期間上限、未観測の裾を区別", () => {
  const r = computeSurgePullback(series([90, 90, 100, 100, 98]), options);
  assert.equal(r.selected.events[0].dropDay, 2);
  assert.equal(computeSurgePullback(series([90, 90, 100, 100, 98]), { ...options, horizon: 1 }).selected.observed, 0);
  const tail = computeSurgePullback(series([90, 90, 100, 100]), options);
  assert.deepEqual(tail.selected.days.map((d) => d.cumulativeProbability), [0, null, null, null]);
  assert.equal(tail.selected.completeCount, 0);
  assert.equal(tail.selected.maxRiseMedian, null);
});

test("レンジ位置・高値更新の条件を起点の情報で適用する", () => {
  const prices = series([100, 120, 100, 106, 113, 110, 109]);
  const r = computeSurgePullback(prices, { ...options, newHighOnly: true, position: "upper" });
  assert.deepEqual(r.selected.events.map((e) => e.index), [4]);
  assert.ok(r.selected.events.every((e) => e.position! >= 80));
});

test("空・不正値・昇順違反は明示エラー、該当なしはゼロ件", () => {
  assert.match(computeSurgePullback([], options).error!, /少なくとも/);
  assert.equal(computeSurgePullback(series([100, 100, 100, 100]), options).selected.events.length, 0);
  for (const patch of [{ risePct: NaN }, { dropPct: 100 }, { window: 1 }, { horizon: 1.5 }]) {
    assert.ok(computeSurgePullback(series([100, 100, 105]), { ...options, ...patch }).error);
  }
  assert.ok(computeSurgePullback(series([100, 100, 105]).reverse(), options).error);
});
