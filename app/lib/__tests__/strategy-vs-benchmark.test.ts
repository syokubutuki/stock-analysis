// strategy-vs-benchmark.ts の回帰テスト。
//
// 8 箇所（曜日戦略・条件付き戦略・ボラターゲティング等）から使われる「戦略 vs B&H」の
// 共通コスト規約。ここが変わると、独立した分析の超過リターンが一斉に動く。
//
// 特に固定したいのは 2 点:
//   ・コストは対数空間で厳密に控除される（1往復あたり ln(1−c)）。単利近似に戻していないか
//   ・往復回数（回転率）が建玉ベクトルの Σ|Δq|/2 として実測されている
// この 2 つが崩れると、超過リターンの符号が静かに変わる。

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  type CostModel,
  ZERO_COST,
  compareFromPositions,
  compareLogStrategy,
  countRoundTrips,
  maskedDaily,
  positionsFromMask,
  positionsFromSignals,
  proportionalLegLogCost,
  roundTripCost,
} from "../strategy-vs-benchmark";
import fx from "./fixtures/price-fixtures.json";
import { assertGolden, assertGoldenArray, golden, logReturnsOf } from "./helpers/golden";

/** 往復スプレッド 12bp + 片道手数料 5bp（往復 10bp）＝ 22bp。 */
const COST: CostModel = { enabled: true, spreadRT: 0.0012, feeBps: 5 };

/** 週の頭3日だけ建てる決定的なマスク（月〜水保有の型）。 */
const MASK = fx.stock.map((_, i) => i % 5 < 3);

describe("コスト・モデル", () => {
  test("roundTripCost: スプレッド + 片道手数料×2", () => {
    assertGoldenArray(
      [
        roundTripCost(COST),
        roundTripCost(ZERO_COST),
        roundTripCost({ enabled: true, spreadRT: 0.9, feeBps: 100 }),
      ],
      [0.0022, 0, 0.5],
      "3件目は上限 0.5 でクランプされる（入力ミスで資産全損にしない）",
    );
  });

  test("roundTripCost: 無効値・負値は 0 に倒す", () => {
    assert.equal(roundTripCost({ enabled: false, spreadRT: 0.01, feeBps: 10 }), 0);
    assert.equal(roundTripCost({ enabled: true, spreadRT: Number.NaN, feeBps: -5 }), 0);
  });

  test("proportionalLegLogCost: 片道は往復の半分（対数空間）", () => {
    assertGoldenArray(
      [
        proportionalLegLogCost(0.0022),
        proportionalLegLogCost(0.0022, 1),
        proportionalLegLogCost(-1, 0.5),
      ],
      [-0.001101211778, -0.002202423555, 0],
    );
    assertGolden(
      proportionalLegLogCost(0.0022) * 2,
      golden(proportionalLegLogCost(0.0022, 1)),
      "weight は線形に効く",
    );
  });
});

describe("建玉・往復回数の小道具", () => {
  test("countRoundTrips: 連続保有をまとめるか否かで 3 倍差がつく", () => {
    assert.equal(countRoundTrips(MASK, true), 50, "連続選択は1往復");
    assert.equal(countRoundTrips(MASK, false), 150, "1バー1往復");
    assert.equal(countRoundTrips([], true), 0);
    assert.equal(countRoundTrips([true], true), 1);
  });

  test("maskedDaily: 非選択日は現金（0）、side=-1 で符号反転", () => {
    assert.deepEqual(maskedDaily([1, 2, 3], [true, false, true]), [1, 0, 3]);
    assert.deepEqual(maskedDaily([1, 2, 3], [true, true, true], -1), [-1, -2, -3]);
    assert.deepEqual(maskedDaily([Number.NaN, 2], [true, true]), [0, 2]);
  });

  test("positionsFromMask / positionsFromSignals", () => {
    assert.deepEqual(positionsFromMask([true, false, true], -1), [-1, 0, -1]);
    assert.deepEqual(
      positionsFromSignals(10, [1, 3, 8], 3),
      [0, 1, 1, 1, 1, 1, 0, 0, 1, 1],
      "重複シグナルは積み増さず保有期間の延長",
    );
    assert.deepEqual(positionsFromSignals(10, [1], 3, -1), [0, -1, -1, -1, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(positionsFromSignals(5, [0], 0), [0, 0, 0, 0, 0], "hold<1 は建玉ゼロ");
  });
});

describe("compareFromPositions: 建玉ベクトルからの比較（黄金値）", () => {
  const cmp = compareFromPositions({ prices: fx.stock, positions: positionsFromMask(MASK), cost: COST });

  test("コスト控除後の戦略統計", () => {
    assert.equal(cmp.strategy.n, 249);
    assertGolden(cmp.strategy.totalReturn, -0.2202929606);
    assertGolden(cmp.strategy.annualReturn, -0.2229470926);
    assertGolden(cmp.strategy.annualVol, 0.2101124401);
    assertGolden(cmp.strategy.sharpe, -1.061084686);
    assertGolden(cmp.strategy.maxDD, 0.4446773082);
    assertGolden(cmp.strategy.winRate, 0.2771084337);
  });

  test("コスト控除前・B&H・超過リターン", () => {
    assertGolden(cmp.strategyGross.totalReturn, -0.1101717828);
    assertGolden(cmp.buyHold.totalReturn, 0.05168529522);
    assertGolden(cmp.excessTotal, -0.2719782558);
    assertGolden(cmp.excessAnnual, -0.2752551022);
    assertGolden(cmp.excessSharpe, -1.257010107);
    assert.equal(cmp.flipsSign, false, "総取り前から負なので符号反転は起きていない");
  });

  test("回転率とコスト総額", () => {
    assertGolden(cmp.costRT, 0.0022);
    assertGolden(cmp.roundTrips, 50, "Σ|Δq|/2 で実測した往復回数");
    assertGolden(cmp.tripsPerYear, 50.60240964);
    assertGolden(cmp.costTotal, 0.1101211778);
    assertGolden(cmp.costAnnual, 0.1114479389);
  });

  test("規約: コスト総額は対数空間で厳密（−ln(1−c)×往復回数）", () => {
    assertGolden(cmp.costTotal, golden(-Math.log(1 - cmp.costRT) * cmp.roundTrips));
    assert.notEqual(
      golden(cmp.costTotal),
      golden(cmp.costRT * cmp.roundTrips),
      "単利近似に戻していないこと（c² のオーダーで違う）",
    );
  });

  test("規約: B&H も 1 往復ぶんのコストを払う", () => {
    const free = compareFromPositions({
      prices: fx.stock,
      positions: positionsFromMask(MASK),
      cost: ZERO_COST,
    });
    const perTrip = -Math.log(1 - cmp.costRT);
    assertGolden(free.buyHold.totalReturn - cmp.buyHold.totalReturn, golden(perTrip));
  });

  test("建玉ゼロなら戦略リターンもゼロ、往復も 0", () => {
    const flat = compareFromPositions({
      prices: fx.stock,
      positions: fx.stock.map(() => 0),
      cost: COST,
    });
    assert.equal(flat.strategy.totalReturn, 0);
    assert.equal(flat.roundTrips, 0);
    assert.equal(flat.costTotal, 0);
  });

  test("建玉が常に 1 なら B&H と一致する（最終的に畳む 1 往復ぶんも含めて）", () => {
    const hold = compareFromPositions({
      prices: fx.stock,
      positions: fx.stock.map(() => 1),
      cost: COST,
    });
    assert.equal(hold.roundTrips, 1);
    assertGolden(hold.excessTotal, 0);
  });
});

describe("compareLogStrategy: 日次リターン列からの比較（黄金値）", () => {
  const daily = logReturnsOf(fx.stock);
  const cmp = compareLogStrategy({
    strategyDaily: daily.map((r, i) => (MASK[i] ? r : 0)),
    buyHoldDaily: daily,
    cost: COST,
    roundTrips: 50,
  });

  test("compareFromPositions と同じ数値に落ちる（2 経路の一致）", () => {
    assertGolden(cmp.strategy.totalReturn, -0.2202929606);
    assertGolden(cmp.buyHold.totalReturn, 0.05168529522);
    assertGolden(cmp.excessTotal, -0.2719782558);
    assertGolden(cmp.costTotal, 0.1101211778);
    assertGolden(cmp.tripsPerYear, 50.60240964);
  });

  test("roundTrips 未指定なら roundTripsPerBar × バー数", () => {
    const perBar = compareLogStrategy({
      strategyDaily: daily,
      buyHoldDaily: daily,
      cost: COST,
    });
    assert.equal(perBar.roundTrips, daily.length, "既定は毎日建て直す");

    const half = compareLogStrategy({
      strategyDaily: daily,
      buyHoldDaily: daily,
      cost: COST,
      roundTripsPerBar: 0.5,
    });
    assert.equal(half.roundTrips, daily.length * 0.5);
  });

  test("非有限値は落として集計する", () => {
    const cmpNaN = compareLogStrategy({
      strategyDaily: [0.01, Number.NaN, 0.02, Number.POSITIVE_INFINITY],
      buyHoldDaily: [0.01, 0.02],
      cost: ZERO_COST,
    });
    assert.equal(cmpNaN.strategy.n, 2);
    assertGolden(cmpNaN.strategy.totalReturn, 0.03);
  });
});
