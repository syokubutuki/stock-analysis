// cornish-fisher.ts の computeVolCone() の回帰テスト。
//
// 固定したいのは「現在値」が **時系列の末尾** であること。
// 初版（806e814・2026-06-04）はローリングボラをソートした後の末尾を「現在値」に取っていたため、
// 現在値が常に歴史的最大値になり、全銘柄・全窓で 100%ile・解釈文が常に「高水準」だった
// （S23 の棚卸し `docs/display-details-inventory.md` §1.4）。
// 可視テキスト・代替テキスト・図の3つが同じ値を描くので、画面の突き合わせでは見つからない。
// ここでは物差しを **独立実装** して突き合わせる（AGENTS.md「実装側のヘルパーを流用しない」）。

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { computeVolCone } from "../cornish-fisher";
import { makeNormal, mulberry32 } from "./helpers/rng";
import { assertGoldenArray, golden } from "./helpers/golden";

/**
 * 決定的な合成リターン列。前半 400 日は高ボラ（日次 2.5%）、後半 200 日は低ボラ（日次 0.8%）。
 * 「直近が歴史的に低い」局面を作ることで、ソート後の末尾（最大値）を現在値にしていれば
 * 100%ile、時系列の末尾なら低い分位になる、という向きの違いが最大になる。
 */
function syntheticReturns(): number[] {
  const normal = makeNormal(mulberry32(20260911));
  const out: number[] = [];
  for (let i = 0; i < 400; i++) out.push(0.025 * normal());
  for (let i = 0; i < 200; i++) out.push(0.008 * normal());
  return out;
}

/** 独立実装: 末尾 w 本の標本標準偏差 × √252。 */
function latestRollingVol(returns: number[], w: number): number {
  const slice = returns.slice(returns.length - w);
  const mu = slice.reduce((a, b) => a + b, 0) / w;
  const s2 = slice.reduce((a, b) => a + (b - mu) ** 2, 0) / (w - 1);
  return Math.sqrt(s2 * 252);
}

/** 独立実装: 全ローリングボラのうち current 以下の割合（0〜100）。 */
function percentileOfLatest(returns: number[], w: number): number {
  const vols: number[] = [];
  for (let i = w; i <= returns.length; i++) {
    const slice = returns.slice(i - w, i);
    const mu = slice.reduce((a, b) => a + b, 0) / w;
    const s2 = slice.reduce((a, b) => a + (b - mu) ** 2, 0) / (w - 1);
    vols.push(Math.sqrt(s2 * 252));
  }
  const cur = latestRollingVol(returns, w);
  let rank = 0;
  for (const v of vols) if (v <= cur) rank++;
  return (rank / vols.length) * 100;
}

describe("computeVolCone(): 現在値は時系列の末尾である", () => {
  const returns = syntheticReturns();
  const cone = computeVolCone(returns);

  test("窓は 7 本すべて計算される（生存確認）", () => {
    assert.deepEqual(cone.windows, [5, 10, 20, 40, 60, 120, 252]);
    assert.equal(cone.currentVol.length, 7);
    assert.equal(cone.currentPercentile.length, 7);
  });

  test("currentVol = 末尾 w 本の年率標本標準偏差（独立実装と一致）", () => {
    for (let k = 0; k < cone.windows.length; k++) {
      const w = cone.windows[k];
      assert.equal(
        golden(cone.currentVol[k]),
        golden(latestRollingVol(returns, w)),
        `窓 ${w} 日の現在値が末尾のローリングボラと一致しない`,
      );
    }
  });

  test("currentPercentile = 現在値の分位（独立実装と一致）", () => {
    for (let k = 0; k < cone.windows.length; k++) {
      const w = cone.windows[k];
      assert.equal(
        golden(cone.currentPercentile[k]),
        golden(percentileOfLatest(returns, w)),
        `窓 ${w} 日のパーセンタイルが独立実装と一致しない`,
      );
    }
  });

  test("直近が低ボラ局面なら 100%ile にはならない（ソート後の末尾を取る退行の検知）", () => {
    // 5〜120 日窓は後半の低ボラ区間だけで計算されるので、歴史的に低い側に落ちる。
    for (let k = 0; k < cone.windows.length; k++) {
      if (cone.windows[k] > 200) continue;
      assert.ok(
        cone.currentPercentile[k] < 50,
        `窓 ${cone.windows[k]} 日: 低ボラ局面なのに ${cone.currentPercentile[k].toFixed(0)}%ile`,
      );
    }
    assert.ok(cone.interpretation.includes("低水準"), cone.interpretation);
  });

  test("黄金値: 現在値とパーセンタイル", () => {
    assertGoldenArray(
      cone.currentVol,
      [0.1475093691, 0.1649461268, 0.1303808133, 0.1175677996, 0.1145029175, 0.1142407852, 0.2110907948],
      "currentVol",
    );
    assertGoldenArray(
      cone.currentPercentile,
      [29.86577181, 33.1641286, 27.88296041, 20.1426025, 16.26617375, 10.6029106, 0.5730659026],
      "currentPercentile",
    );
  });
});
