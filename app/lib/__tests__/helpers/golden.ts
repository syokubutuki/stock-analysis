// 黄金値（golden value）方式の共通道具。
//
// 目的は「数式が正しいことの証明」ではなく「意図しない変化の検知」。
// 固定フィクスチャに対する出力を有効桁で丸めて記録し、次に走らせたとき違えば落とす。
//
// ここに置く統計量（β・σ・シャープ）は **実装側と重複した独立の物差し** である。
// 実装のヘルパーを流用すると、実装が壊れたときテストも同じ向きに壊れて検知できない。

import assert from "node:assert/strict";
import type { PricePoint } from "../../types";

/** 黄金値の既定有効桁。IEEE754 の下位ビットの揺れで落ちない程度に絞る。 */
export const GOLDEN_DIGITS = 10;

/** 黄金値として記録・比較するための丸め。NaN / ±Infinity はそのまま通す。 */
export function golden(x: number, digits: number = GOLDEN_DIGITS): number {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return 0;
  return Number(x.toPrecision(digits));
}

/** 実測値を黄金値の桁に丸めてから厳密比較する。 */
export function assertGolden(
  actual: number,
  expected: number,
  message?: string,
  digits: number = GOLDEN_DIGITS,
): void {
  assert.equal(golden(actual, digits), expected, message);
}

/** 配列版。 */
export function assertGoldenArray(
  actual: number[],
  expected: number[],
  message?: string,
  digits: number = GOLDEN_DIGITS,
): void {
  assert.deepEqual(
    actual.map((v) => golden(v, digits)),
    expected,
    message,
  );
}

/** 終値の対数リターン列（独立実装の物差し）。 */
export function logReturnsOf(prices: PricePoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const a = prices[i - 1].close;
    const b = prices[i].close;
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

/** 年率ボラティリティ σ·√252（標本標準偏差、分母 n−1）。 */
export function annualizedSigma(returns: number[]): number {
  if (returns.length < 2) return 0;
  const m = returns.reduce((s, v) => s + v, 0) / returns.length;
  const v = returns.reduce((s, x) => s + (x - m) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}

/** OLS の傾き（市場β）。y を x に回帰する。 */
export function olsBeta(y: number[], x: number[]): number {
  const n = Math.min(y.length, x.length);
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let varx = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    varx += (x[i] - mx) ** 2;
  }
  return varx > 0 ? cov / varx : 0;
}

/** 年率シャープ（無リスク金利 0、対数リターン基準）。 */
export function annualizedSharpe(returns: number[]): number {
  const sigma = annualizedSigma(returns);
  if (sigma === 0) return 0;
  const m = returns.reduce((s, v) => s + v, 0) / returns.length;
  return (m * 252) / sigma;
}
