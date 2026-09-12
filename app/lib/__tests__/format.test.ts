// format.ts の formatSummaryPrice() の回帰テスト。
//
// サマリーカード（app/page.tsx）・銘柄ページ（/t/[ticker]）・OG 画像の3か所が同じ関数を通す。
// 固定したいのは「通貨の最小桁を最低とし、有効数字 6 桁まで小数を残す」規則そのもので、
// FU7（カード間で桁が揃わない）を S23 で **許容** と判断した根拠の値をここに置く
// （docs/display-details-inventory.md §4.1 の実測値）。規則を変えるときはここが落ちる。

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { formatSummaryPrice } from "../format";

describe("formatSummaryPrice(): 通貨の最小桁 + 有効数字6桁", () => {
  test("JPY: 実際の呼値は桁が少なく、分割調整後の過去終値は小数が残る（FU7 の不揃いの正体）", () => {
    // 7203.T 10y の実測（2026-09-11）: 現在値 / 期間始値
    assert.equal(formatSummaryPrice(3031, "JPY"), "3,031");
    assert.equal(formatSummaryPrice(900.872, "JPY"), "900.872");
    // 1306.T 1y の実測
    assert.equal(formatSummaryPrice(419.7, "JPY"), "419.7");
    assert.equal(formatSummaryPrice(312.104, "JPY"), "312.104");
  });

  test("JPY: 低位銘柄の桁は落とさない（許容の決め手）", () => {
    assert.equal(formatSummaryPrice(419.7, "JPY"), "419.7");
    assert.equal(formatSummaryPrice(12.34, "JPY"), "12.34");
  });

  test("JPY: 投信の基準価額は整数のまま", () => {
    assert.equal(formatSummaryPrice(37174, "JPY"), "37,174");
    assert.equal(formatSummaryPrice(10000, "JPY"), "10,000");
  });

  test("USD: 最小桁 2 を必ず出し、6桁を超える小数は切る", () => {
    assert.equal(formatSummaryPrice(150, "USD"), "150.00");
    assert.equal(formatSummaryPrice(150.25, "USD"), "150.25");
    assert.equal(formatSummaryPrice(1234.5678, "USD"), "1,234.57");
    assert.equal(formatSummaryPrice(0.012345678, "USD"), "0.0123457");
  });

  test("未知の通貨コードでも落ちない（最小桁 2 に退避）", () => {
    assert.equal(formatSummaryPrice(1.5, "XXX_NOT_A_CURRENCY"), "1.50");
  });
});
