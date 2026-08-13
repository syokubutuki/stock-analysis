// stats-significance.ts の回帰テスト。
//
// app/lib 内から 57 箇所が参照する統計基盤で、ここが壊れると全アノマリー分析の
// p 値・FDR 補正・ブートストラップ CI が一斉に狂う。しかも「値が少しずれる」形で壊れるため、
// 目視では気づけない。実際に `incompleteBeta` の対称変換が欠けていた時期があり、
// |t| が小さいとき p 値が不当に小さく出ていた（`app/lib/us-jp-path-overlays` 系で発覚）。
// その事故ケースを筆頭に固定する。

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  benjaminiHochberg,
  blockBootstrapCI,
  fSurvival,
  incompleteBeta,
  mean,
  median,
  quantileSorted,
  std,
  studentTwoSidedP,
  tTest,
} from "../stats-significance";
import fx from "./fixtures/price-fixtures.json";
import { assertGolden, assertGoldenArray, logReturnsOf } from "./helpers/golden";
import { withSeededRandom } from "./helpers/rng";

const stockReturns = logReturnsOf(fx.stock);

describe("incompleteBeta / studentTwoSidedP", () => {
  test("回帰: |t| が小さいときの p 値（対称変換の欠落で 0.59 と出ていた事故）", () => {
    // ソースのコメントが記録している実例。x = df/(df+t²) → 1 の側に落ちるケース。
    assertGolden(studentTwoSidedP(0.03, 702), 0.9760755799, "t=0.03, df=702 の両側 p は 0.976");
    assert.ok(
      studentTwoSidedP(0.03, 702) > 0.9,
      "「差がほぼ無い」ケースの p が 0.9 を下回るなら対称変換が壊れている",
    );
  });

  test("p 値は |t| について単調に減る（x→1 側と x→0 側をまたいで確認）", () => {
    const ts = [0, 0.03, 0.2, 0.5, 1, 1.5, 2, 3, 5, 10];
    const ps = ts.map((t) => studentTwoSidedP(t, 250));
    for (let i = 1; i < ps.length; i++) {
      assert.ok(ps[i] <= ps[i - 1], `t=${ts[i]} で単調性が崩れた: ${ps[i - 1]} → ${ps[i]}`);
    }
  });

  test("代表点の黄金値", () => {
    assertGoldenArray(
      [
        studentTwoSidedP(1.96, 1e6),
        studentTwoSidedP(2.5, 30),
        studentTwoSidedP(0.5, 10),
        studentTwoSidedP(-3.1, 250),
        studentTwoSidedP(0, 5),
      ],
      [0.0499960676, 0.01811564907, 0.6278936057, 0.002156740203, 1],
    );
  });

  test("正則化不完全ベータの解析解と一致する", () => {
    // I_0.5(2,2) = 0.5（対称）、I_0.25(0.5,0.5) = (2/π)·arcsin(√0.25) = 1/3（逆正弦分布）
    assertGolden(incompleteBeta(2, 2, 0.5), 0.5);
    assertGolden(incompleteBeta(0.5, 0.5, 0.25), 0.3333333333);
    assertGolden(incompleteBeta(5, 3, 0.9), 0.9743085);
    assert.equal(incompleteBeta(3, 3, 0), 0);
    assert.equal(incompleteBeta(3, 3, 1), 1);
  });

  test("退化入力は p=1（棄却しない側）に倒す", () => {
    assert.equal(studentTwoSidedP(Number.NaN, 100), 1);
    assert.equal(studentTwoSidedP(2, 0), 1);
  });
});

describe("fSurvival", () => {
  test("代表点の黄金値", () => {
    assertGoldenArray(
      [fSurvival(4.0, 4, 245), fSurvival(1.0, 3, 100), fSurvival(12.5, 1, 20)],
      [0.003666833893, 0.3961862496, 0.002076914492],
    );
  });

  test("F(1,df) の上側確率は t 検定の両側 p と一致する", () => {
    // F = t² の関係。曜日構造の判定を F でやる箇所（cal-null-anatomy）の前提。
    assertGolden(fSurvival(2.5 ** 2, 1, 30), 0.01811564907);
  });

  test("退化入力は 1", () => {
    assert.equal(fSurvival(-1, 3, 10), 1);
    assert.equal(fSurvival(2, 0, 10), 1);
  });
});

describe("記述統計", () => {
  test("mean / std / median / quantileSorted の黄金値", () => {
    assertGolden(mean(stockReturns), 0.0002164165413);
    assertGolden(std(stockReturns), 0.01685198137);
    assertGolden(median(stockReturns), -0.0006003619627);

    const sorted = [...stockReturns].sort((a, b) => a - b);
    assertGoldenArray(
      [quantileSorted(sorted, 0.05), quantileSorted(sorted, 0.95)],
      [-0.02576629263, 0.02694336771],
    );
  });

  test("縮退入力", () => {
    assert.equal(mean([]), 0);
    assert.equal(std([1]), 0);
    assert.equal(median([]), 0);
    assert.equal(quantileSorted([], 0.5), 0);
    assert.equal(quantileSorted([1, 2, 3, 4], 0.5), 2.5, "偶数個は線形補間");
  });
});

describe("tTest", () => {
  test("フィクスチャ収益列の黄金値", () => {
    const result = tTest(stockReturns);
    assert.ok(result !== null);
    assertGolden(result.t, 0.2026465223);
    assertGolden(result.p, 0.8395774753);
  });

  test("標本が足りない・分散ゼロなら null", () => {
    assert.equal(tTest([1, 2]), null);
    assert.equal(tTest([1, 1, 1, 1]), null);
  });
});

describe("benjaminiHochberg", () => {
  test("黄金値（Benjamini-Hochberg 1995 の原典例）", () => {
    assertGoldenArray(
      benjaminiHochberg([0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216]),
      [0.01, 0.04, 0.084, 0.084, 0.084, 0.1, 0.1057142857, 0.216, 0.216, 0.216],
    );
  });

  test("補正は単調で、生 p 以上・1 以下", () => {
    const raw = [0.5, 0.01, 0.3, 0.002, 0.9];
    const adj = benjaminiHochberg(raw);
    for (let i = 0; i < raw.length; i++) {
      assert.ok(adj[i] >= raw[i], "補正後が生 p を下回ってはならない");
      assert.ok(adj[i] <= 1);
    }
    // 生 p の順序を保つ
    const order = raw.map((p, i) => i).sort((a, b) => raw[a] - raw[b]);
    for (let k = 1; k < order.length; k++) {
      assert.ok(adj[order[k]] >= adj[order[k - 1]]);
    }
  });

  test("空配列", () => {
    assert.deepEqual(benjaminiHochberg([]), []);
  });
});

describe("blockBootstrapCI", () => {
  test("シードを固定した黄金値", () => {
    // 内部で Math.random を直接呼ぶので、mulberry32 に差し替えて再現性を作る。
    const ci = withSeededRandom(12345, () => blockBootstrapCI(stockReturns, 400));
    assert.ok(ci !== null);
    assertGolden(ci.lo, -0.002278188568);
    assertGolden(ci.hi, 0.002592817494);
    assertGolden(ci.stable, 0.5525);
    assert.ok(ci.lo < mean(stockReturns) && mean(stockReturns) < ci.hi, "点推定を CI が挟む");
  });

  test("同じシードなら何度でも同じ値（乱数の漏れが無いことの確認）", () => {
    const a = withSeededRandom(777, () => blockBootstrapCI(stockReturns, 200));
    const b = withSeededRandom(777, () => blockBootstrapCI(stockReturns, 200));
    assert.deepEqual(a, b);
  });

  test("標本が5未満なら null", () => {
    assert.equal(blockBootstrapCI([1, 2, 3, 4]), null);
  });
});
