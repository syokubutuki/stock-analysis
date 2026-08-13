// series-mode.ts の回帰テスト。
//
// `extractSeries` は分析コンポーネント側から 68 箇所が呼ぶ入口で、
// SERIES_AWARE_SECTIONS の全パネルがこの 6 モードの出力に乗っている。
// 値そのものより **系列の長さと時刻の対応** が壊れると被害が大きい
// （1本ずれた時刻でイベントスタディや曜日集計を回すと、静かに誤った結論が出る）。

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SERIES_MODE_LABELS, extractSeries, type SeriesMode } from "../series-mode";
import type { PricePoint } from "../types";
import fx from "./fixtures/price-fixtures.json";
import { assertGoldenArray } from "./helpers/golden";

const SLICE = fx.stock.slice(0, 5);
const ALL_MODES: SeriesMode[] = [
  "close",
  "open",
  "diff",
  "logReturn",
  "overnightReturn",
  "intradayReturn",
];

describe("extractSeries: 6 モードの黄金値", () => {
  test("close / open は原系列をそのまま返す", () => {
    assertGoldenArray(extractSeries(SLICE, "close").values, [
      2790.570145, 2755.528898, 2786.669171, 2863.2559, 2860.271,
    ]);
    assertGoldenArray(extractSeries(SLICE, "open").values, [
      2800, 2794.760887, 2752.577222, 2823.980944, 2851.639953,
    ]);
  });

  test("diff / logReturn は先頭 1 本を落とす", () => {
    assertGoldenArray(extractSeries(SLICE, "diff").values, [
      -35.04124684, 31.14027252, 76.58672912, -2.984900214,
    ]);
    assertGoldenArray(extractSeries(SLICE, "logReturn").values, [
      -0.01263652627, 0.01123763527, 0.02711236682, -0.001043028376,
    ]);
  });

  test("overnightReturn = ln(open[t]/close[t-1])", () => {
    assertGoldenArray(extractSeries(SLICE, "overnightReturn").values, [
      0.001500624752, -0.001071757191, 0.0133005346, -0.004065152777,
    ]);
  });

  test("intradayReturn = ln(close[t]/open[t]) で本数は落ちない", () => {
    assertGoldenArray(extractSeries(SLICE, "intradayReturn").values, [
      -0.003373489193, -0.01413715102, 0.01230939246, 0.01381183222, 0.003022124401,
    ]);
  });
});

describe("extractSeries: 長さと時刻の対応", () => {
  test("値と時刻の本数は常に一致する", () => {
    for (const mode of ALL_MODES) {
      const { values, times } = extractSeries(fx.stock, mode);
      assert.equal(values.length, times.length, `${mode} で本数がずれた`);
    }
  });

  test("先頭を落とすモードは times も 1 本目から始まる", () => {
    const shifted: SeriesMode[] = ["diff", "logReturn", "overnightReturn"];
    for (const mode of shifted) {
      const { values, times } = extractSeries(SLICE, mode);
      assert.equal(values.length, SLICE.length - 1, `${mode} の本数`);
      assert.equal(times[0], SLICE[1].time, `${mode} の先頭時刻は 2 本目の日付`);
    }
    for (const mode of ["close", "open", "intradayReturn"] as SeriesMode[]) {
      const { values, times } = extractSeries(SLICE, mode);
      assert.equal(values.length, SLICE.length);
      assert.equal(times[0], SLICE[0].time);
    }
  });

  test("1 点しかなければ差分系のモードは空", () => {
    const one = SLICE.slice(0, 1);
    assert.deepEqual(extractSeries(one, "diff"), { values: [], times: [] });
    assert.equal(extractSeries(one, "close").values.length, 1);
  });
});

describe("extractSeries: 非正の価格", () => {
  test("0 や負の価格が混じっても対数を取らず 0 を返す（NaN を下流に流さない）", () => {
    const broken: PricePoint[] = [
      { time: "2025-01-06", open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: "2025-01-07", open: 0, high: 0, low: 0, close: 0, volume: 1 },
      { time: "2025-01-08", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    ];
    for (const mode of ["logReturn", "overnightReturn", "intradayReturn"] as SeriesMode[]) {
      const { values } = extractSeries(broken, mode);
      assert.ok(
        values.every((v) => Number.isFinite(v)),
        `${mode} が非有限値を返した`,
      );
    }
    assert.deepEqual(extractSeries(broken, "logReturn").values, [0, 0]);
  });
});

describe("SERIES_MODE_LABELS", () => {
  test("全モードに日本語ラベルがある", () => {
    for (const mode of ALL_MODES) {
      assert.equal(typeof SERIES_MODE_LABELS[mode], "string");
      assert.ok(SERIES_MODE_LABELS[mode].length > 0);
    }
    assert.equal(Object.keys(SERIES_MODE_LABELS).length, ALL_MODES.length);
  });
});
