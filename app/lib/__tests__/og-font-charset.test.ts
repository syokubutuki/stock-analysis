// OG画像のフォントサブセットと銘柄台帳の同期を固定する（FU28）。
//
// なぜこのテストが要るのか
// ------------------------
// `/t/[ticker]/opengraph-image.tsx` が描くカードの日本語は、同梱サブセット
// （`_fonts/NotoSansJP-{400,700}.subset.ttf`）にある字しか出せない。収録範囲は
// `TICKER_PAGE_INSTRUMENTS` **98銘柄**の `name`/`market`/`currency`/`ticker` と
// 固定文言に厳密に一致させてあり、**その一致は人間が手で保っている。**
//
// 壊れ方は2通りあり、どちらも画面は壊れず例外も出ない。
//
//  ① 銘柄を足してサブセットを焼き直さない → `coveredByOgFont()` が false になり、
//     **その銘柄だけ数値の入ったカードが出なくなる**（汎用画像へ静かに退化する）。
//     豆腐は出ないので、SNS でカードを見るまで誰も気づかない。
//
//  ② 文字列（`OG_FONT_CHARSET`）だけ書き足してフォントを焼き直さない →
//     `coveredByOgFont()` が true を返し、**豆腐がそのまま画像に焼かれる。**
//     ①より悪い。この機構が防いでいるはずのものが素通りする。
//
// ① は「必要集合 ⊆ 申告」、② は「申告 = フォント実体の cmap」で止める。
// 落ちたときは `_fonts/README.md`「焼き直しの手順」に従い、
// **フォントの再生成と `OG_FONT_CHARSET` の更新を必ず両方**行うこと。
// 片方だけ直すと、もう片方の壊れ方に移るだけである。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  OG_FIXED_TEXTS,
  OG_FONT_CHARSET,
  OG_TEXT,
  coveredByOgFont,
} from "../../t/[ticker]/_fonts/charset";
import { TICKER_PAGE_INSTRUMENTS } from "../ticker-pages";
import { cmapCodePoints } from "./helpers/ttf-cmap";

const FONTS_DIR = fileURLToPath(new URL("../../t/%5Bticker%5D/_fonts/", import.meta.url));
const OG_SOURCE = readFileSync(
  fileURLToPath(new URL("../../t/%5Bticker%5D/opengraph-image.tsx", import.meta.url)),
  "utf8",
);

const CHARSET = new Set(OG_FONT_CHARSET);

/** 銘柄台帳が要求する文字 → それを持ち込んでいる銘柄。落ちたとき犯人を名指しするため。 */
function instrumentGlyphs(): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const instrument of TICKER_PAGE_INSTRUMENTS) {
    const fields = [
      instrument.name,
      instrument.market,
      instrument.currency,
      instrument.ticker,
    ];
    for (const field of fields) {
      for (const char of field) {
        const list = owners.get(char) ?? [];
        if (!list.includes(instrument.ticker)) list.push(instrument.ticker);
        owners.set(char, list);
      }
    }
  }
  return owners;
}

/** 落ちたときに「何をすればよいか」まで書く。ファイル冒頭を読み直させないため。 */
function rebakeHint(missing: string[], source: string): string {
  return [
    `フォントサブセットに無い文字が ${missing.length} 字ある（${source}）: ${missing.join("")}`,
    "",
    "直し方（app/t/[ticker]/_fonts/README.md の「焼き直しの手順」）:",
    "  1. _fonts/charset.ts の OG_FONT_CHARSET に不足文字を足す",
    "  2. その文字列を charset.txt に置き、README の fontTools コマンドで",
    "     NotoSansJP-{400,700}.subset.ttf を焼き直す",
    "  3. base64 化して _fonts/subset-base64.ts を差し替える",
    "",
    "**1 だけ直してはいけない。** 申告だけ広げるとフォントに無い字が「収録済み」に",
    "なり、豆腐がそのまま画像に焼かれる（このファイル冒頭の②）。",
  ].join("\n");
}

describe("スキャナの生存確認（0件のまま「全部通った」と報告しない）", () => {
  test("銘柄台帳と文字集合が空になっていない", () => {
    assert.ok(
      TICKER_PAGE_INSTRUMENTS.length >= 90,
      `公開銘柄が ${TICKER_PAGE_INSTRUMENTS.length} 件しかない（台帳の読み込み失敗）`,
    );
    assert.ok(CHARSET.size >= 250, `OG_FONT_CHARSET が ${CHARSET.size} 字しかない`);
  });

  test("銘柄由来の必要文字を実際に拾えている", () => {
    const owners = instrumentGlyphs();
    // 2026-09-05 実測: 98銘柄から186種。件数そのものではなく「拾えている」ことを見る。
    // ticker（数字）+ market（東証）+ currency（JPY）だけなら十数種にしかならないので、
    // 150種を超えている時点で name も読めている。
    assert.ok(owners.size >= 150, `銘柄由来の文字が ${owners.size} 種しか拾えていない`);
    assert.ok(owners.has("東"), "「東」が拾えていない（market を読めていない）");
    assert.ok(owners.has("J"), "「J」が拾えていない（currency を読めていない）");
    assert.ok(owners.get("7")?.includes("7203"), "ticker を読めていない");
  });
});

describe("必要集合 ⊆ 申告（銘柄を1件足したら落ちる）", () => {
  test("全銘柄の name / market / currency / ticker がサブセットに収まる", () => {
    const owners = instrumentGlyphs();
    const missing = [...owners.keys()].filter((char) => !CHARSET.has(char));
    const culprits = missing.map((c) => `${c}→${owners.get(c)!.join(",")}`).join(" / ");
    assert.deepEqual(
      missing,
      [],
      `${rebakeHint(missing, "銘柄台帳")}\n\n該当銘柄: ${culprits}`,
    );
  });

  test("coveredByOgFont() が実際に全銘柄を通す（退避へ落ちる銘柄が無い）", () => {
    const rejected = TICKER_PAGE_INSTRUMENTS.filter(
      (i) => !coveredByOgFont(i.name, i.market, i.currency, i.ticker),
    ).map((i) => `${i.ticker} ${i.name}`);
    assert.deepEqual(rejected, [], `汎用画像へ退避する銘柄がある:\n${rejected.join("\n")}`);
  });

  test("画像に描く固定文言がサブセットに収まる", () => {
    // 銘柄名と違い、固定文言は実行時に covered() を通らない。ここが唯一の門番で、
    // 収録外の字を含むラベルを足すと**豆腐がそのまま焼かれる**。
    const missing = [...new Set(OG_FIXED_TEXTS.join(""))].filter((c) => !CHARSET.has(c));
    assert.deepEqual(missing, [], rebakeHint(missing, "固定文言 OG_FIXED_TEXTS"));
  });

  test("収録外の文字は弾かれる（門番が素通ししていない）", () => {
    assert.equal(coveredByOgFont("株価構造分析"), true);
    assert.equal(coveredByOgFont("森"), false, "収録外の漢字を通してしまった");
    assert.equal(coveredByOgFont("株価", "森"), false, "1つでも外れたら false のはず");
  });
});

describe("申告 = フォント実体（文字列だけ書き足す壊れ方を止める）", () => {
  for (const weight of ["400", "700"]) {
    test(`NotoSansJP-${weight}.subset.ttf の cmap が OG_FONT_CHARSET と厳密一致する`, () => {
      const font = readFileSync(`${FONTS_DIR}NotoSansJP-${weight}.subset.ttf`);
      const codePoints = cmapCodePoints(font);
      assert.ok(codePoints.size >= 250, `cmap が ${codePoints.size} 字しか読めていない`);

      const declared = new Set([...OG_FONT_CHARSET].map((c) => c.codePointAt(0)!));
      const onlyDeclared = [...declared]
        .filter((c) => !codePoints.has(c))
        .map((c) => String.fromCodePoint(c));
      const onlyFont = [...codePoints]
        .filter((c) => !declared.has(c))
        .map((c) => String.fromCodePoint(c));

      // 申告にあってフォントに無い＝豆腐が焼かれる側。こちらは事故である。
      assert.deepEqual(
        onlyDeclared,
        [],
        `OG_FONT_CHARSET にあるがフォントに無い（豆腐になる）: ${onlyDeclared.join("")}\n` +
          "README の手順でサブセットを焼き直すこと。",
      );
      // フォントにあって申告に無い＝使えるのに使わない側。無害だが、焼き直しの
      // 取りこぼし（charset を戻し忘れた等）の証拠なので同じく落とす。
      assert.deepEqual(
        onlyFont,
        [],
        `フォントにあるが OG_FONT_CHARSET に無い: ${onlyFont.join("")}\n` +
          "焼き直しの際に片方だけ更新した可能性がある。",
      );
    });
  }

  test("400 と 700 が同じ文字集合を持つ（片方だけ焼き直していない）", () => {
    const sets = ["400", "700"].map((w) =>
      cmapCodePoints(readFileSync(`${FONTS_DIR}NotoSansJP-${w}.subset.ttf`)),
    );
    const only400 = [...sets[0]].filter((c) => !sets[1].has(c)).map((c) => String.fromCodePoint(c));
    const only700 = [...sets[1]].filter((c) => !sets[0].has(c)).map((c) => String.fromCodePoint(c));
    assert.deepEqual([only400, only700], [[], []], "太さで収録文字が食い違っている");
  });
});

describe("画像に描く日本語が OG_TEXT を経由している（門番を迂回させない）", () => {
  // 固定文言を `opengraph-image.tsx` に直接書くと、上の「固定文言」検査の網から外れる。
  // JSX のテキストノードと文字列属性だけを見るので、`export const alt`（HTML属性・
  // 画像には描かれない）と `[ticker-og]` のログ文言は対象外になる。

  test("スキャナが生きている（OG_TEXT の参照を実際に拾えている）", () => {
    const refs = [...OG_SOURCE.matchAll(/OG_TEXT\.([A-Za-z]+)/g)].map((m) => m[1]);
    // 2026-09-05 実測: 14キー・15参照（siteName はカード2種で使う）。
    assert.ok(refs.length >= 12, `OG_TEXT の参照が ${refs.length} 件しか無い`);
    const unknown = refs.filter((key) => !(key in OG_TEXT));
    assert.deepEqual(unknown, [], `OG_TEXT に無いキーを参照している: ${unknown.join(", ")}`);
  });

  test("JSX の文字列属性に日本語の直書きが無い", () => {
    const raw = [...OG_SOURCE.matchAll(/\s([A-Za-z]+)="([^"]*)"/g)]
      .filter((m) => /[　-鿿＀-￯]/.test(m[2]))
      .map((m) => `${m[1]}="${m[2]}"`);
    assert.deepEqual(raw, [], `OG_TEXT へ移すこと:\n${raw.join("\n")}`);
  });

  test("JSX のテキストノードに日本語の直書きが無い", () => {
    const raw = [...OG_SOURCE.matchAll(/>([^<>{}]*[　-鿿][^<>{}]*)</g)]
      .map((m) => m[1].trim())
      .filter((t) => t.length > 0);
    assert.deepEqual(raw, [], `OG_TEXT へ移すこと:\n${raw.join("\n")}`);
  });
});
