// series-mode.ts の回帰テスト。
//
// `extractSeries` は分析コンポーネント側から 68 箇所が呼ぶ入口で、
// SERIES_AWARE_SECTIONS の全パネルがこの 6 モードの出力に乗っている。
// 値そのものより **系列の長さと時刻の対応** が壊れると被害が大きい
// （1本ずれた時刻でイベントスタディや曜日集計を回すと、静かに誤った結論が出る）。

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  SERIES_MODE_LABELS,
  SERIES_MODE_UNITS,
  extractSeries,
  extractRatioSeries,
  formatRatioSeriesValue,
  isLevelSeries,
  ratioSeriesDisplayUnit,
  scaleRatioSeriesValue,
  type SeriesMode,
} from "../series-mode";
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

// ---------------------------------------------------------------------------
// FU47: 系列の単位（水準 / 差分 / 比率）
//
// `extractSeries` の戻り値は 6 モードで単位が違うのに型は同じ `number[]` である。
// 受け取る側がそれを見分けられず「リターンだろう」と決め打って `×100` して `%` を
// 付けていたのが FU47（`0331418A` の「平均 1931819.394%」・`7203.T` の「179740.3866%」）。
//
// この単位表は 11 個のコンポーネントが依存する分岐なので、モードを増やしたときに
// **表への追記を忘れたら落ちる**ようにしておく。
// ---------------------------------------------------------------------------
describe("SERIES_MODE_UNITS（FU47: この系列は比率か水準か）", () => {
  test("全モードに単位がある（モードを増やして追記を忘れたら落ちる）", () => {
    for (const mode of ALL_MODES) {
      assert.ok(
        SERIES_MODE_UNITS[mode],
        `${mode} の単位が SERIES_MODE_UNITS に無い`,
      );
    }
    assert.equal(Object.keys(SERIES_MODE_UNITS).length, ALL_MODES.length);
  });

  test("close / open だけが水準である", () => {
    const level = ALL_MODES.filter((m) => isLevelSeries(m));
    assert.deepEqual(level, ["close", "open"]);
  });

  test("diff は差分であって比率ではない（%で見せてよい集合に混ぜない）", () => {
    assert.equal(SERIES_MODE_UNITS.diff, "difference");
  });

  test("リターン系の3モードは比率（×100 して % にしてよい）", () => {
    for (const mode of ["logReturn", "overnightReturn", "intradayReturn"] as SeriesMode[]) {
      assert.equal(SERIES_MODE_UNITS[mode], "ratio", `${mode} が比率でない`);
    }
  });
});

describe("extractRatioSeries（FU47: %で見せる前に比率へ直す）", () => {
  test("close は対数リターンへ直り、時刻が 1 本落ちる", () => {
    const ratio = extractRatioSeries(SLICE, "close");
    // logReturn モードの黄金値と一致するのが正しい（同じ量を2経路で出しているため）
    assertGoldenArray(ratio.values, [
      -0.01263652627, 0.01123763527, 0.02711236682, -0.001043028376,
    ]);
    assert.equal(ratio.values.length, SLICE.length - 1);
    assert.equal(ratio.times[0], SLICE[1].time);
    assert.equal(ratio.values.length, ratio.times.length);
  });

  test("open も対数リターンへ直る（水準はこの 2 モード）", () => {
    const ratio = extractRatioSeries(SLICE, "open");
    // ln(open[t]/open[t-1]) を fixture から独立に計算した値
    assertGoldenArray(ratio.values, [
      -0.001872864441, -0.01520890821, 0.02560992706, 0.009746679444,
    ]);
    assert.equal(ratio.times[0], SLICE[1].time);
  });

  test("比率・差分モードは extractSeries と完全に同じものを返す（素通し）", () => {
    for (const mode of ["diff", "logReturn", "overnightReturn", "intradayReturn"] as SeriesMode[]) {
      assert.deepEqual(
        extractRatioSeries(fx.stock, mode),
        extractSeries(fx.stock, mode),
        `${mode} が素通しになっていない`,
      );
    }
  });

  test("どのモードでも値と時刻の本数が一致する", () => {
    for (const mode of ALL_MODES) {
      const { values, times } = extractRatioSeries(fx.stock, mode);
      assert.equal(values.length, times.length, `${mode} で本数がずれた`);
    }
  });

  test("水準の絶対値が %表示に流れない（FU47 の再発検知）", () => {
    // 基準価額 10,000〜37,945 円の投信を模した系列。extractSeries なら 10^4 台、
    // extractRatioSeries なら 10^-2 台に収まる。×100 して % を付けても意味を保つ。
    const fund: PricePoint[] = fx.stock.slice(0, 60).map((p, i) => {
      const nav = 10000 + i * 50;
      return { time: p.time, open: nav, high: nav, low: nav, close: nav, volume: 0 };
    });
    const raw = extractSeries(fund, "close").values;
    const ratio = extractRatioSeries(fund, "close").values;
    assert.ok(Math.max(...raw.map(Math.abs)) > 1000, "前提が崩れた（水準が小さすぎる）");
    assert.ok(
      Math.max(...ratio.map(Math.abs)) < 0.1,
      "水準がそのまま流れている（×100 すると 1000% を超える）",
    );
  });

  test("1 点しかなければ水準モードは空（下流に NaN を流さない）", () => {
    const one = SLICE.slice(0, 1);
    assert.deepEqual(extractRatioSeries(one, "close"), { values: [], times: [] });
  });

  test("0 や負の価格が混じっても非有限値を返さない", () => {
    const broken: PricePoint[] = [
      { time: "2025-01-06", open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: "2025-01-07", open: 0, high: 0, low: 0, close: 0, volume: 1 },
      { time: "2025-01-08", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    ];
    for (const mode of ALL_MODES) {
      const { values } = extractRatioSeries(broken, mode);
      assert.ok(
        values.every((v) => Number.isFinite(v)),
        `${mode} が非有限値を返した`,
      );
    }
  });
});

describe("extractRatioSeries の表示単位（FU52: diff は円）", () => {
  test("diff だけは100倍せず円で表示する", () => {
    assert.equal(ratioSeriesDisplayUnit("diff"), "円");
    assert.equal(scaleRatioSeriesValue(12.345, "diff"), 12.345);
    assert.equal(formatRatioSeriesValue(12.345, "diff", 2), "12.35円");
  });

  test("水準由来とリターン系は百分率表示を維持する", () => {
    for (const mode of ["close", "open", "logReturn", "overnightReturn", "intradayReturn"] as SeriesMode[]) {
      assert.equal(ratioSeriesDisplayUnit(mode), "%", `${mode} の表示単位`);
      assert.equal(scaleRatioSeriesValue(0.0125, mode), 1.25);
      assert.equal(formatRatioSeriesValue(0.0125, mode, 2), "1.25%");
    }
  });
});
