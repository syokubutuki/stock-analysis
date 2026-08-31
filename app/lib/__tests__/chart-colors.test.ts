// `app/lib/chart-colors.ts` と `app/globals.css` の `@theme inline` が持つ
// **同じ値の二重管理**を固定する（FU29）。
//
// なぜ二重に持っているか
// ----------------------
// Canvas2D は色を文字列で直接渡すため CSS 変数を読めない。Tailwind のクラスも届かない
// （FU12 で `#9ca3af` が170ファイルに散らばっていたのはこれが理由）。したがって
// Canvas 側は同じ値を TypeScript の定数として複製するしかない。
//
// 何が起きうるか
// --------------
// **片方だけ変えると、同じ画面の中で HTML の文字と Canvas の軸ラベルの色が食い違う。**
// 例外は出ず、コントラスト比が落ちても誰も気づかない。`chart-colors.ts` の冒頭に
// 対応表はあるが、これまで**テストで縛られていなかった**。
//
// なぜ全部を縛らないか
// --------------------
// 対応表のうち `surface` だけは「相当」であって同値ではない
// （Canvas 背景 `#fafafa` / `--color-surface-canvas` `#f9fafb`）。
// 同値だと宣言している2つだけを縛る。増やすときは対応表のほうを先に直すこと。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CHART_COLORS,
  DIRECTION_COLORS,
  DIRECTION_GLYPH,
  DIRECTION_TEXT_CLASS,
  directionOf,
} from "../chart-colors";

const CSS = readFileSync(fileURLToPath(new URL("../../globals.css", import.meta.url)), "utf8");

function themeToken(name: string): string {
  const m = CSS.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
  assert.ok(m, `globals.css に --color-${name} が無い（@theme inline の書き方が変わった）`);
  return m[1].toLowerCase();
}

describe("Canvas の配色と CSS トークンの二重管理（FU29）", () => {
  test("Canvas 内テキストの色が --color-fg-muted と一致する", () => {
    // ここがずれると、同じパネルの中で HTML の説明文と Canvas の軸ラベルが別の灰色になる。
    assert.equal(CHART_COLORS.ink, themeToken("fg-muted"));
  });

  test("装飾グリッドの色が --color-border-default と一致する", () => {
    assert.equal(CHART_COLORS.grid, themeToken("border-default"));
  });

  test("Canvas 背景は CSS トークンと同値ではない（相当であって一致ではない）", () => {
    // 対応表が「相当」と書いているとおり。ここが偶然一致したら対応表を格上げしてよい。
    assert.notEqual(CHART_COLORS.surface, themeToken("surface-canvas"));
  });
});

describe("方向の第2の手がかり（A4: 色が見えなくても同じ結論に達すること）", () => {
  test("up / down / flat のすべてに記号がある", () => {
    for (const key of Object.keys(DIRECTION_COLORS) as (keyof typeof DIRECTION_COLORS)[]) {
      assert.ok(DIRECTION_GLYPH[key], `${key} に記号が無い`);
      assert.ok(DIRECTION_TEXT_CLASS[key], `${key} にテキスト色クラスが無い`);
    }
  });

  test("記号は3つとも別の字である（色を落としても区別が付くこと）", () => {
    assert.equal(new Set(Object.values(DIRECTION_GLYPH)).size, 3);
  });

  test("directionOf の不感帯 eps が効く（色と記号を同じ判定から出すための入口）", () => {
    // FU36 の本体は S20 だが、この関数の契約はここで固定しておく。
    assert.equal(directionOf(0.3), "up");
    assert.equal(directionOf(0.3, 0.5), "flat");
    assert.equal(directionOf(-0.3, 0.5), "flat");
    assert.equal(directionOf(NaN), "flat");
    assert.equal(directionOf(0), "flat");
  });
});
