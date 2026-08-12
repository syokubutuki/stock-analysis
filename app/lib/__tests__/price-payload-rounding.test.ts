// 配信ペイロードの価格丸め（2026-08-11 の P1 で入った `toPrecision(8)`）の回帰テスト。
//
// ## なぜソースを「テキストとして」読むのか
//
// 丸めは `app/lib/stock-data.server.ts` の `roundPricePayload()` にあるが、この関数は
// export されておらず、同ファイルは Next のバンドラ別名である `import "server-only"` を
// 含むため Node からは import できない（server-only は実パッケージとして存在しない）。
// 実コードを import 可能にするには当該ファイルの改修が要る。
//
// そこで本テストは 2 段構えにしている:
//   ① 契約の検査 —— 有効桁数の定数と、丸めが「修復の後段」で OHLC 4本値に当たっていることを
//      ソーステキストで固定する。桁を変えると必ず落ちる（`docs/site-improvement-round3.md`
//      の FU10 は桁数の引き下げを検討中なので、そのとき黄金値の録り直しを強制するのが狙い）。
//   ② 影響の黄金値 —— 同じ丸めをフィクスチャに当て、σ・β・シャープが動かないことを固定する。
//
// ①が実装の変更を検知し、②が「その丸めが統計量を壊していないこと」を保証する。
// 実コードそのものを走らせてはいないので、そこは本テストの限界である。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { repairPriceGlitches } from "../price-sanity";
import type { PricePoint } from "../types";
import fx from "./fixtures/price-fixtures.json";
import {
  annualizedSharpe,
  annualizedSigma,
  assertGolden,
  logReturnsOf,
  olsBeta,
} from "./helpers/golden";

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "stock-data.server.ts"),
  "utf8",
);

/** 契約として固定した有効桁数。ここを変えるならソース側と黄金値の両方を録り直すこと。 */
const EXPECTED_DIGITS = 8;

function roundPayload(prices: PricePoint[], digits: number): PricePoint[] {
  return prices.map((p) => ({
    ...p,
    open: Number(p.open.toPrecision(digits)),
    high: Number(p.high.toPrecision(digits)),
    low: Number(p.low.toPrecision(digits)),
    close: Number(p.close.toPrecision(digits)),
  }));
}

describe("配信ペイロードの丸め: 実装側の契約", () => {
  test("有効桁数は 8 のまま", () => {
    const match = SOURCE.match(/const PRICE_SIGNIFICANT_DIGITS = (\d+);/);
    assert.ok(match, "stock-data.server.ts に PRICE_SIGNIFICANT_DIGITS の宣言が見つからない");
    assert.equal(
      Number(match[1]),
      EXPECTED_DIGITS,
      "有効桁を変えたなら、本ファイルの黄金値を録り直し、SANITIZER_VERSION の要否も判断すること",
    );
  });

  test("丸めは OHLC の4本値すべてに当たっている（出来高には当てない）", () => {
    for (const field of ["open", "high", "low", "close"] as const) {
      assert.match(
        SOURCE,
        new RegExp(`${field}: Number\\(price\\.${field}\\.toPrecision\\(PRICE_SIGNIFICANT_DIGITS\\)\\)`),
        `${field} に丸めが当たっていない`,
      );
    }
    assert.ok(
      !/volume:\s*Number\(price\.volume\.toPrecision/.test(SOURCE),
      "出来高は整数なので有効桁で丸めない",
    );
  });

  test("丸めは修復の後段に置かれている（順序が逆だと破損検出が鈍る）", () => {
    assert.match(
      SOURCE,
      /const fixed = repairPriceGlitches\(data\.prices\);[\s\S]*prices: roundPricePayload\(fixed\.prices\)/,
      "repairPriceGlitches → roundPricePayload の順序が崩れている",
    );
  });
});

describe("配信ペイロードの丸め: 統計量への影響（黄金値）", () => {
  const clean = fx.benchmarkClean;
  const rounded = roundPayload(clean, EXPECTED_DIGITS);
  const stockReturns = logReturnsOf(fx.stock);
  const cleanReturns = logReturnsOf(clean);
  const roundedReturns = logReturnsOf(rounded);

  test("価格そのものの相対誤差は有効8桁ぶんに収まる", () => {
    let maxRelative = 0;
    for (let i = 0; i < clean.length; i++) {
      for (const key of ["open", "high", "low", "close"] as const) {
        maxRelative = Math.max(maxRelative, Math.abs(rounded[i][key] / clean[i][key] - 1));
      }
    }
    assert.ok(maxRelative < 5e-8, `相対誤差 ${maxRelative} が有効8桁の範囲を超えている`);
  });

  test("年率σ・市場β・シャープが丸めで動かない", () => {
    assertGolden(annualizedSigma(cleanReturns), 0.2314322185, "丸め前の年率σ");
    assertGolden(annualizedSigma(roundedReturns), 0.2314322224, "丸め後の年率σ");

    assertGolden(olsBeta(stockReturns, cleanReturns), 1.099837669, "丸め前のβ");
    assertGolden(olsBeta(stockReturns, roundedReturns), 1.099837642, "丸め後のβ");

    assertGolden(annualizedSharpe(cleanReturns), -0.1228106433, "丸め前のシャープ");
    assertGolden(annualizedSharpe(roundedReturns), -0.1228106364, "丸め後のシャープ");
  });

  test("統計量の相対変化は日次σ（約2e-2）より6桁以上小さい", () => {
    const relSigma = Math.abs(
      annualizedSigma(roundedReturns) / annualizedSigma(cleanReturns) - 1,
    );
    const relBeta = Math.abs(
      olsBeta(stockReturns, roundedReturns) / olsBeta(stockReturns, cleanReturns) - 1,
    );
    assert.ok(relSigma < 1e-6, `σ の相対変化 ${relSigma}`);
    assert.ok(relBeta < 1e-6, `β の相対変化 ${relBeta}`);
  });

  test("丸めた系列でも同じ破損が同じ倍率で検出される", () => {
    // 現行の実装順（修復 → 丸め）が将来入れ替わっても破損検出が鈍らないことの確認。
    const { report } = repairPriceGlitches(roundPayload(fx.benchmarkRaw, EXPECTED_DIGITS));
    assert.equal(report.repaired.length, 1);
    assert.equal(report.repaired[0].factor, 0.1);
    assert.equal(report.repaired[0].from, "2025-09-17");
    assert.equal(report.repaired[0].to, "2025-09-18");
    assert.equal(report.suspects.length, 0);
  });
});
