// open-close-edge.ts の `scanExecutionEdges` の回帰テスト。
//
// この関数は2箇所から呼ばれる:
//   ・transform-exec-scan（コスト控除**あり**が既定。表示される順位・年率・p 値の出どころ）
//   ・edge-discount.ts:124（コスト**なし**で呼び、自前で約定ギャップとスプレッドを引く）
// 後者はグロス前提なので、cost 未指定時の値が動くと二重控除や控除漏れになる。
//
// 固定したいのは3点:
//   1. cost 未指定なら従来どおりのグロス（2026-08-31 のコスト導入で計算順序を変えた）
//   2. コストは 1取引あたり (1+r)(1−c)−1 で厳密に効く（cadence が短い型ほど年率で重い）
//   3. 方向はグロス平均の符号で決まる（コスト控除で「買い」の行が負になっても反転しない）
//
// **`bootstrapTopN: 0` を必ず渡すこと。** `blockBootstrapCI` は種なしの `Math.random()` を
// 使うので（stats-significance.ts）、渡さないと CI 列が実行のたびに変わってテストが揺れる。

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { scanExecutionEdges, type EdgeStat } from "../open-close-edge";
import { ZERO_COST } from "../strategy-vs-benchmark";
import fx from "./fixtures/price-fixtures.json";
import { assertGolden, assertGoldenArray, golden } from "./helpers/golden";
import type { PricePoint } from "../types";

const STOCK = fx.stock as PricePoint[];

/** CI をブートストラップしない＝決定論。黄金値を録るための必須条件。 */
const DETERMINISTIC = { bootstrapTopN: 0 } as const;

const pick = (stats: EdgeStat[], id: string): EdgeStat => {
  const s = stats.find((x) => x.def.id === id);
  assert.ok(s, `トレード型 ${id} が見つからない（buildTradeDefs が変わった）`);
  return s;
};

describe("scanExecutionEdges: コスト未指定（グロス）", () => {
  const r = scanExecutionEdges(STOCK, DETERMINISTIC);

  test("検定数と costRT", () => {
    assert.equal(r.nTested, 25, "FDR の母数。トレード型を足したらここが動く");
    assert.equal(r.costRT, 0);
    assert.equal(r.nFlippedByCost, 0);
  });

  test("代表3型の統計量が黄金値どおり", () => {
    const a = pick(r.stats, "intraday");
    const b = pick(r.stats, "overnight");
    const c = pick(r.stats, "cc21");
    assertGoldenArray(
      [a.meanTrade, a.annualized, a.t, a.p, a.pAdj],
      [0.0005657545461, 0.1531874811, 0.7759746309, 0.43850037, 0.8497788367],
      "寄→引(日中デイトレ)",
    );
    assertGoldenArray(
      [b.meanTrade, b.annualized, b.t, b.p],
      [0.0002645075257, 0.0689181717, 0.5048375032, 0.6141212637],
      "引→翌寄(夜間持ち越し)",
    );
    assertGoldenArray(
      [c.meanTrade, c.annualized, c.t, c.p],
      [0.009678919804, 0.12253391, 1.412710377, 0.1591044788],
      "引→引 21日保有",
    );
  });

  test("ZERO_COST を明示しても未指定と同じ", () => {
    const z = scanExecutionEdges(STOCK, { ...DETERMINISTIC, cost: ZERO_COST });
    assert.equal(z.costRT, 0);
    for (const s of z.stats) {
      const base = pick(r.stats, s.def.id);
      assertGolden(s.meanTrade, golden(base.meanTrade), s.def.id);
      assertGolden(s.pAdj, golden(base.pAdj), s.def.id);
      assert.equal(s.direction, base.direction, s.def.id);
    }
  });

  test("グロスでは costDrag が全型ゼロ", () => {
    assert.ok(r.stats.every((s) => s.costDrag === 0));
    assert.ok(r.stats.every((s) => s.grossMeanTrade === s.meanTrade));
  });

  test("往復/年 は 252/cadence", () => {
    assert.equal(pick(r.stats, "intraday").roundTripsPerYear, 252);
    assert.equal(pick(r.stats, "overnight").roundTripsPerYear, 252);
    assert.equal(pick(r.stats, "cc21").roundTripsPerYear, 12);
  });
});

describe("scanExecutionEdges: 往復30bp を控除", () => {
  const gross = scanExecutionEdges(STOCK, DETERMINISTIC);
  const net = scanExecutionEdges(STOCK, {
    ...DETERMINISTIC,
    cost: { enabled: true, spreadRT: 0.003, feeBps: 0 },
  });

  test("costRT と、非正へ落ちた型の数", () => {
    assert.equal(net.costRT, 0.003);
    assert.equal(net.nFlippedByCost, 20, "高回転の型がまとめて落ちる");
  });

  test("1取引への反映は (1+r)(1−c)−1（対数空間控除と同値）", () => {
    for (const s of net.stats) {
      const g = pick(gross.stats, s.def.id);
      assertGolden(s.meanTrade, golden((1 + g.meanTrade) * (1 - 0.003) - 1), s.def.id);
      assertGolden(s.grossMeanTrade, golden(g.meanTrade), s.def.id);
    }
  });

  test("年率の目減りは回転率で決まる（cadence 1 が最も重い）", () => {
    const day = pick(net.stats, "intraday");
    const swing = pick(net.stats, "cc21");
    assertGoldenArray(
      [day.annualized, day.costDrag, swing.annualized, swing.costDrag],
      [-0.4591462893, 0.6123337705, 0.08278285133, 0.03975105868],
    );
    assert.ok(day.flippedByCost, "年252往復の型は 30bp でも非正に落ちる");
    assert.ok(!swing.flippedByCost, "年12往復の型は残る");
    assert.ok(day.costDrag > swing.costDrag * 10, "回転率の差がそのまま年率の差になる");
  });

  test("方向はグロスの符号のまま（控除で反転させない）", () => {
    // 反転させると「コストを引いたらショート推奨に変わった」という読み方を
    // 生む。コストは方向に依らない定率なので、取れるエッジの向きは変わらない。
    for (const s of net.stats) {
      assert.equal(s.direction, pick(gross.stats, s.def.id).direction, s.def.id);
    }
  });

  test("best は「有意に負け続ける型」を選ばない", () => {
    // 控除前は方向調整で平均が必ず非負だったが、控除後は大きく負の平均が
    // 両側検定で有意に出る。meanTrade > 0 の条件がそれを弾く。
    if (net.best) assert.ok(net.best.meanTrade > 0);
  });

  test("検定数はコスト設定に依らない（母数は動かない）", () => {
    assert.equal(net.nTested, gross.nTested);
  });
});
