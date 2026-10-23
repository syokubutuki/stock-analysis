// derisk-rule.ts（ストレス退避規則）の回帰テスト。docs/derisk-rule-design.md §4。
//
// 2層で縛る:
//   1. 合成系列: 状態機械と特徴量の**向き**（同日退避・復帰カウントのリセット・min_periods の非対称・
//      ddof=1・asof の「厳密に小さい」・初日コスト）を、手計算の値で直接確かめる。
//   2. 黄金値: 研究側 Python（research/bank-derisk/export_fixture.py、common.py には依存しない独立実装）が
//      data_max の 8306.T・^VIX・KRE を 2018-01-01 以降に切って出した stress / w / 指標と、全行で一致する。
//      意図的に計算を変えたらここが落ちるのが正常。

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  RESEARCH_PARAMS,
  computeDerisk,
  computeMetrics,
  drawdownFromRollingHigh,
  jpFeatures,
  netReturns,
  nextTradingDay,
  ratioToRollingMean,
  runHysteresis,
  sampleStd,
} from "../derisk-rule";
import { asofIndex } from "../asof-align";
import type { PricePoint } from "../types";
import { assertGolden, assertGoldenArray, golden } from "./helpers/golden";
import { makeNormal, mulberry32 } from "./helpers/rng";
import fx from "./fixtures/derisk-golden.json";

// ───────────────────────── 状態機械 ─────────────────────────

describe("runHysteresis", () => {
  test("2灯でその日から現金、消灯5日目に保有へ戻る。途中の1灯でカウントがリセットされる", () => {
    const stress = [0, 1, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
    const { w, calm } = runHysteresis(stress, RESEARCH_PARAMS);
    assert.deepEqual(Array.from(w), [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    // i=3..6 で 1..4、i=7 でリセット、i=8..12 で 1..5（5 で復帰し、保有中は 0 と報告）
    assert.deepEqual(Array.from(calm), [0, 0, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0]);
  });

  test("kOut=1 なら 1灯でもカウントが進む。kOut=0 では進まない", () => {
    const stress = [2, 1, 1, 1, 1, 1];
    assert.deepEqual(Array.from(runHysteresis(stress, { kIn: 2, calmN: 5, kOut: 1 }).w), [0, 0, 0, 0, 0, 1]);
    assert.deepEqual(Array.from(runHysteresis(stress, { kIn: 2, calmN: 5, kOut: 0 }).w), [0, 0, 0, 0, 0, 0]);
  });

  test("初期状態を引き継いで1歩進められる（次の立会日の判定に使う）", () => {
    const first = runHysteresis([2, 0, 0], RESEARCH_PARAMS);
    assert.deepEqual(first.final, { cur: 0, calm: 2 });
    const step = runHysteresis([0], RESEARCH_PARAMS, first.final);
    assert.equal(step.calm[0], 3);
    assert.equal(step.w[0], 0);
  });
});

// ───────────────────────── 特徴量 ─────────────────────────

describe("特徴量の定義", () => {
  test("sampleStd は ddof=1", () => {
    // 平均 3、偏差二乗和 10、n−1 = 4 → √2.5
    assertGolden(sampleStd([1, 2, 3, 4, 5]), golden(Math.sqrt(2.5)));
    assert.ok(Number.isNaN(sampleStd([1])));
  });

  test("ratioToRollingMean は窓が揃うまで NaN、揃ったら x ÷ 窓平均", () => {
    const out = ratioToRollingMean([10, 10, 10, 20], 3);
    assert.ok(Number.isNaN(out[0]) && Number.isNaN(out[1]));
    assertGolden(out[2], 1);
    assertGolden(out[3], golden(20 / ((10 + 10 + 20) / 3)));
  });

  test("drawdownFromRollingHigh の min_periods（日本側 20 と KRE 側 60 の非対称）", () => {
    const x = Array.from({ length: 70 }, (_, i) => 100 + i);
    const kre = drawdownFromRollingHigh(x, 60, 60);
    assert.ok(Number.isNaN(kre[58]), "59本では未定義");
    assertGolden(kre[59], 0, "60本目で定義（自身が最高値なので 0）");
    const jp = drawdownFromRollingHigh(x, 60, 20);
    assert.ok(Number.isNaN(jp[18]));
    assertGolden(jp[19], 0);
  });

  test("jpFeatures: 行 t は t−1 までの終値だけを使い、dd60 は 20本・volRatio は 61本目から", () => {
    const rand = makeNormal(mulberry32(7));
    const closes: number[] = [100];
    for (let i = 1; i < 80; i++) closes.push(closes[i - 1] * Math.exp(0.01 * rand()));
    const f = jpFeatures(closes);
    assert.equal(f.volRatio.length, 81, "t = 0..n（n は次の立会日）");
    assert.ok(Number.isNaN(f.dd60[19]) && !Number.isNaN(f.dd60[20]));
    assert.ok(Number.isNaN(f.volRatio[60]) && !Number.isNaN(f.volRatio[61]));
    // 独立実装: t=61 の volRatio = sd(r[56..60]) / sd(r[1..60])
    const r = closes.map((c, i) => (i === 0 ? NaN : Math.log(c) - Math.log(closes[i - 1])));
    const sd = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
    };
    assertGolden(f.volRatio[61], golden(sd(r.slice(56, 61)) / sd(r.slice(1, 61))));
    // dd60[t] は c[t−1] / max(c[t−60..t−1]) − 1。t=80（次の立会日）は最終終値を使う
    const mx = Math.max(...closes.slice(20, 80));
    assertGolden(f.dd60[80], golden(closes[79] / mx - 1));
  });

  test("asofIndex は同じ日付を使わない（厳密に小さい最新）", () => {
    const idx = asofIndex(["2024-01-10", "2024-01-11"], ["2024-01-09", "2024-01-10", "2024-01-12"]);
    assert.deepEqual(Array.from(idx), [0, 1]);
    assert.equal(asofIndex(["2024-01-01"], ["2024-01-01"])[0], -1);
  });
});

// ───────────────────────── 評価 ─────────────────────────

describe("純リターンと指標", () => {
  test("初日に片道1回分のコストを課し、回転には初日を含めない", () => {
    const net = netReturns([1, 1, 0, 1], [0.01, 0.02, 0.03, 0.04], 0.001);
    assertGoldenArray(Array.from(net), [0.009, 0.02, -0.001, 0.039]);
    const m = computeMetrics(net, [1, 1, 0, 1]);
    assertGolden(m.turnover, golden(2 / (4 / 245)));
    assertGolden(m.inMarket, 0.75);
  });

  test("最大DDは対数エクイティの指数の最高値比", () => {
    const m = computeMetrics([0.1, -0.2, 0.05], [1, 1, 1]);
    assertGolden(m.maxDrawdown, golden(Math.exp(-0.2) - 1));
    assertGolden(m.total, golden(Math.exp(-0.05) - 1));
  });
});

// ───────────────────────── 暦 ─────────────────────────

describe("nextTradingDay", () => {
  test("東証銘柄は休場日表で飛ばす（2026-04-28 → 4/29 昭和の日を跨いで 4/30）", () => {
    assert.equal(nextTradingDay("2026-04-28", "8306.T"), "2026-04-30");
    assert.equal(nextTradingDay("2026-10-23", "8306.T"), "2026-10-26", "金曜 → 月曜");
  });
  test("東証暦に従わない系列は翌平日", () => {
    assert.equal(nextTradingDay("2026-04-28"), "2026-04-29");
  });
});

// ───────────────────────── 合成系列での結合 ─────────────────────────

function weekdays(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function series(times: string[], closes: number[]): PricePoint[] {
  return times.map((time, i) => ({ time, open: closes[i], high: closes[i], low: closes[i], close: closes[i], volume: 0 }));
}

describe("computeDerisk（合成）", () => {
  const times = weekdays("2024-01-01", 200);
  const rand = makeNormal(mulberry32(11));
  const closes: number[] = [100];
  for (let i = 1; i < 200; i++) closes.push(closes[i - 1] * Math.exp(0.005 * rand()));
  const flat = (v: number) => times.map(() => v);

  test("暖機: 有効行の先頭は 61 本目（日本側 volRatio が律速）。最終行は評価できないが状態は出る", () => {
    const res = computeDerisk({ target: series(times, closes), vix: series(times, flat(15)), kre: series(times, flat(50)), ticker: "TEST.T" });
    assert.equal(res.historyStart, times[61]);
    assert.equal(res.rows.at(-1)?.time, times[199]);
    assert.equal(res.rows.at(-1)?.yOo, null);
    assert.equal(res.latest?.time, times[199]);
    assert.equal(res.metrics?.rule.nDays, res.rows.length - 1);
    // 無風なら全期間保有、買い持ちとの差は初日の片道コストだけ
    assert.ok(res.rows.every((r) => r.w === 1 && r.stress === 0));
    assert.equal(res.episodes.length, 0);
    assertGolden(res.rows[0].net as number, golden((res.rows[0].yOo as number) - 0.0005));
    assertGolden(res.rows[1].net as number, golden(res.rows[1].yOo as number));
  });

  test("VIX の急騰と 60日高値からの −15% で 2灯 → その日から現金。エピソードが記録される", () => {
    const vix = flat(15);
    for (let i = 150; i < 200; i++) vix[i] = 30; // 日付 times[150] 以降（asof で翌立会日から効く）
    const shocked = [...closes];
    for (let i = 150; i < 200; i++) shocked[i] = closes[149] * 0.8; // 行 151 から dd60 = −20%
    const res = computeDerisk({ target: series(times, shocked), vix: series(times, vix), kre: series(times, flat(50)), ticker: "TEST.T" });
    const row151 = res.rows.find((r) => r.time === times[151]);
    assert.ok(row151 && row151.stress >= 2 && row151.w === 0, "2灯の日の寄りから現金");
    assert.equal(res.episodes.length, 1);
    assert.equal(res.episodes[0].start, times[151]);
    assert.ok(res.episodes[0].litAtEntry.includes("vixRatio") && res.episodes[0].litAtEntry.includes("dd60"));
    assert.ok(res.latest && !res.latest.holding);
  });

  test("次の立会日: 米国の最終行が日本の最終日より古ければ usStale", () => {
    const fresh = computeDerisk({ target: series(times, closes), vix: series(times, flat(15)), kre: series(times, flat(50)), ticker: "TEST.T" });
    assert.ok(fresh.next);
    assert.equal(fresh.next!.time, nextTradingDay(times[199], "TEST.T"));
    assert.equal(fresh.next!.usAsOf, times[199]);
    assert.equal(fresh.next!.usStale, false);
    const stale = computeDerisk({ target: series(times, closes), vix: series(times.slice(0, 198), flat(15)), kre: series(times, flat(50)), ticker: "TEST.T" });
    assert.equal(stale.next!.usAsOf, times[197]);
    assert.equal(stale.next!.usStale, true);
  });

  test("startTime 以前の行は暖機にだけ使い、状態機械と評価から外す", () => {
    const res = computeDerisk({ target: series(times, closes), vix: series(times, flat(15)), kre: series(times, flat(50)), ticker: "TEST.T", startTime: times[100] });
    assert.equal(res.historyStart, times[100]);
  });
});

// ───────────────────────── 黄金値（Python 独立実装との一致） ─────────────────────────

describe("黄金値: 8306.T 2018〜（research/bank-derisk/export_fixture.py）", () => {
  const toPP = (p: { time: string; open?: number; close: number }): PricePoint => ({
    time: p.time, open: p.open ?? p.close, high: Math.max(p.open ?? p.close, p.close), low: Math.min(p.open ?? p.close, p.close), close: p.close, volume: 0,
  });
  const res = computeDerisk({
    target: fx.target.map(toPP), vix: fx.vix.map(toPP), kre: fx.kre.map(toPP),
    ticker: fx.meta.ticker, params: fx.params, costOneWay: fx.costOneWay,
  });
  const ex = fx.expected;

  test("有効行の日付・点灯数・建玉が全行一致する", () => {
    assert.equal(res.historyStart, ex.historyStart);
    assert.equal(res.rows.length, ex.rows.length);
    assert.deepEqual(res.rows.map((r) => r.time), ex.rows.map((r) => r.time));
    assert.deepEqual(res.rows.map((r) => r.stress), ex.rows.map((r) => r.stress));
    assert.deepEqual(res.rows.map((r) => r.w), ex.rows.map((r) => r.w));
  });

  test("最終行の状態と4指標の値", () => {
    assert.ok(res.latest);
    assert.equal(res.latest!.time, ex.latest.time);
    assert.equal(res.latest!.stress, ex.latest.stress);
    assert.equal(res.latest!.holding, ex.latest.holding);
    const byKey = Object.fromEntries(res.latest!.lights.map((l) => [l.key, l.value]));
    assertGolden(byKey.vixRatio, ex.latest.vixRatio);
    assertGolden(byKey.volRatio, ex.latest.volRatio);
    assertGolden(byKey.dd60, ex.latest.dd60);
    assertGolden(byKey.kreDd60, ex.latest.kreDd60);
    assert.equal(res.latest!.vixAsOf, ex.latest.vixAsOf);
    assert.equal(res.latest!.kreAsOf, ex.latest.kreAsOf);
  });

  // 期待値は Python 側で有効10桁に丸めてある。実測も同じ桁に丸めて厳密比較する。
  const D = 10;
  const eq = (actual: number, expected: number | null, label: string) => {
    assert.equal(golden(actual, D), golden(expected as number, D), label);
  };
  const cmp = (actual: { nDays: number; cagr: number; vol: number; sharpe: number; maxDrawdown: number; inMarket: number; turnover: number; total: number }, expected: typeof ex.metrics.rule, label: string) => {
    assert.equal(actual.nDays, expected.nDays, `${label} nDays`);
    eq(actual.cagr, expected.cagr, `${label} cagr`);
    eq(actual.vol, expected.vol, `${label} vol`);
    eq(actual.sharpe, expected.sharpe, `${label} sharpe`);
    eq(actual.maxDrawdown, expected.maxDrawdown, `${label} maxDrawdown`);
    eq(actual.inMarket, expected.inMarket, `${label} inMarket`);
    eq(actual.turnover, expected.turnover, `${label} turnover`);
    eq(actual.total, expected.total, `${label} total`);
  };

  test("成績（5bp）・コスト感度・時代別", () => {
    assert.ok(res.metrics);
    assert.equal(res.metrics!.rule.nDays, ex.nEval);
    cmp(res.metrics!.rule, ex.metrics.rule, "rule");
    cmp(res.metrics!.buyHold, ex.metrics.buyHold, "buyHold");
    assert.equal(res.costSensitivity.length, ex.costSensitivity.length);
    res.costSensitivity.forEach((c, i) => {
      assert.equal(c.costBp, ex.costSensitivity[i].costBp);
      cmp(c.rule, ex.costSensitivity[i].rule, `cost ${c.costBp}bp`);
    });
    assert.equal(res.byEra.length, ex.byEra.length);
    res.byEra.forEach((e, i) => {
      const exp = ex.byEra[i];
      assert.equal(e.label, exp.label);
      if (exp.rule === null) { assert.equal(e.rule, null); assert.equal(e.buyHold, null); return; }
      cmp(e.rule!, exp.rule, `era ${e.label} rule`);
      cmp(e.buyHold!, exp.buyHold!, `era ${e.label} buyHold`);
    });
  });

  test("現金化エピソード", () => {
    assert.equal(res.episodes.length, ex.episodes.length);
    res.episodes.forEach((e, i) => {
      const x = ex.episodes[i];
      assert.equal(e.start, x.start);
      assert.equal(e.end, x.end);
      assert.equal(e.days, x.days);
      assert.deepEqual(e.litAtEntry, x.litAtEntry);
      if (x.bhReturn === null) assert.equal(e.bhReturn, null);
      else eq(e.bhReturn as number, x.bhReturn, `episode ${i} bhReturn`);
    });
  });
});
