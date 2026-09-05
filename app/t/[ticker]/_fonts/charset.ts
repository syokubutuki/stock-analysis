import { SITE_HOST } from "../../../lib/site-url";

/**
 * 同梱サブセット（`NotoSansJP-400.subset.ttf` / `-700`）が収録している文字。
 * `README.md` の焼き直し手順と対になる唯一の定義である。
 *
 * **ここに無い文字を描くと豆腐になる。** そのため `opengraph-image.tsx` は描画前に
 * 必ず `coveredByOgFont()` を通し、外れた文字が1つでもあれば数値なしの汎用画像へ退避する。
 *
 * `opengraph-image.tsx` から切り出してあるのは、テストから読めるようにするためである
 * （あちらは `next/og` と `stock-data.server`（`import "server-only"`）を引くので
 * Node のテストランナーから import できない）。`__tests__/og-font-charset.test.ts` が
 *
 *   ① この文字列が同梱TTF2本の cmap と**厳密に一致する**こと
 *   ② `TICKER_PAGE_INSTRUMENTS` の全銘柄と下の `OG_FIXED_TEXTS` を被覆すること
 *
 * を検査する。**銘柄を1件足すとテストが落ちる**ので、README の手順で焼き直すこと。
 */
export const OG_FONT_CHARSET =
  " %&()+,-./0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" +
  "·−　、。" +
  "いかくこごさすずそただでなのはばほみらりれをァアィイウエオカガキクグケコサザジス" +
  "セソタダチヂッテデトドナニノハバパヒフブプペボマミムモャヤユヨラリルレロン・ー" +
  "一三上中丸事井京任伊住作価信値備共分券動化友味和品商国在地堂場塚塩士外大天学実富" +
  "小属山崎川工市年忠成所技投指数日旭時最月期本村東松析柄株格業構機武気水海測準点物" +
  "率王現生産田直研確積立第米紅素義自船花菱薬藤製西託証話認豊資越車近通造郵重野金鉄" +
  "鉱銘間隠電（）";

const FONT_GLYPHS = new Set(OG_FONT_CHARSET);

/** 渡した文字列がすべてサブセットの範囲に収まるか。1文字でも外れたら false。 */
export function coveredByOgFont(...texts: string[]): boolean {
  return texts.every((text) => [...text].every((char) => FONT_GLYPHS.has(char)));
}

/**
 * OG画像が描く固定文言。**画像に出る日本語はここだけに置くこと。**
 *
 * `opengraph-image.tsx` に直接書くと、サブセットの外の字を含む文言を足したときに
 * `coveredByOgFont()` の検査を素通りして**豆腐がそのまま画像に焼かれる**
 * （`covered()` が見ているのは銘柄名と数値だけで、固定文言は見ていない）。
 * ここに置いておけば `og-font-charset.test.ts` が被覆を検査する。
 */
export const OG_TEXT = {
  siteName: "株価構造分析",
  metaSeparator: " · ",
  tickerCodePrefix: "銘柄コード ",
  currentPriceLabel: "現在値 ",
  periodReturnLabel: "期間リターン",
  volatilityLabel: "年率ボラティリティ",
  maxDrawdownLabel: "最大ドローダウン",
  summaryPending: "実測値を準備中です",
  recentYearPrefix: "直近1年 · ",
  asOfSuffix: "時点",
  recentYearSummary: "直近1年の実測サマリー",
  genericHeaderLeft: "実測データの分析",
  genericTagline: "市場の隠れた構造を、データから。",
  genericFooter: "実測サマリーは銘柄ページでご確認ください",
} as const;

/**
 * 数値・日付の整形が生む文字。`formatSummaryPrice`（`Intl.NumberFormat("ja-JP")`）の
 * 桁区切りと小数点、`signedPercent`/`plainPercent` の符号と `%`、
 * `formatAsOf`（`Intl.DateTimeFormat("ja-JP", { month: "long" })`）の `年` `月` `日`。
 */
export const OG_FORMATTED_GLYPHS = "0123456789,.+-%年月日";

/** 銘柄に依らず画像に出うる文字列の全体。テストはこれと銘柄台帳の和集合を必要集合とする。 */
export const OG_FIXED_TEXTS: readonly string[] = [
  ...Object.values(OG_TEXT),
  SITE_HOST,
  OG_FORMATTED_GLYPHS,
];
