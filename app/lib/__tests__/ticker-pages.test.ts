// `/t/[ticker]` が公開する銘柄解決と実測サマリーの回帰テスト。
//
// なぜ要るか
// ----------
// この2つは **本番のHTMLに直接出る値** でありながら、壊れても画面は壊れない。
//
//  ① `getTickerPageInstrument()` の表記ゆれ吸収
//     ここが黙って undefined を返すと、リダイレクトではなく 404 になる。
//     実際に 2026-08-15 まで `dynamicParams = false` が正規化を殺しており、
//     `/t/7203.T` は 404 を返していた（コードは正しいのに到達しなかった）。
//
//  ② `buildTickerPageSummary()` の直近1年の切り出し
//     取得を `range=10y` に寄せた（アプリ本体とキャッシュキーを共有するため）ので、
//     **窓の切り出しを間違えると10年ぶんの数字が「直近1年」として掲載される**。
//     10年リターンは1年リターンより桁が大きいだけで、見た目は壊れない。
//
// 期待値は helpers/golden.ts の独立実装（logReturnsOf / annualizedSigma）で作る。
// 実装のヘルパーを流用すると、実装が壊れたときテストも同じ向きに壊れる。

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { getInstrumentByTicker } from "../instruments";
import {
  TICKER_PAGE_INSTRUMENTS,
  buildTickerPageSummary,
  getTickerPageInstrument,
} from "../ticker-pages";
import { getUniverse } from "../universes";
import type { PricePoint } from "../types";
import { assertGolden, annualizedSigma, logReturnsOf } from "./helpers/golden";

/** 種付き乱数。再実行で数字が変わるとフィクスチャとして使えない。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `endISO` を最終日とする連続暦日の価格系列。営業日でなくても切り出しの検証には足りる。 */
function makeSeries(endISO: string, days: number): PricePoint[] {
  const random = mulberry32(20260817);
  const end = Date.UTC(
    Number(endISO.slice(0, 4)),
    Number(endISO.slice(5, 7)) - 1,
    Number(endISO.slice(8, 10)),
  );
  const out: PricePoint[] = [];
  let close = 1000;
  for (let i = days - 1; i >= 0; i -= 1) {
    close *= Math.exp((random() - 0.5) * 0.02);
    const time = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ time, open: close, high: close, low: close, close, volume: 0 });
  }
  return out;
}

const TEN_YEARS = makeSeries("2026-08-14", 3653);

describe("getTickerPageInstrument: 表記ゆれを canonical へ寄せる", () => {
  test("canonical・Yahoo記法・小文字がすべて同じ銘柄に解決する", () => {
    const canonical = getTickerPageInstrument("7203");
    assert.ok(canonical, "7203 が解決しない（major100 の構成が変わった可能性）");
    assert.equal(canonical.ticker, "7203");
    // この2つが解決しないと、page.tsx の permanentRedirect が発火しない。
    assert.equal(getTickerPageInstrument("7203.T"), canonical);
    assert.equal(getTickerPageInstrument("  7203.t  "), canonical);
  });

  test("公開対象でないコードは undefined（notFound に落ちる）", () => {
    assert.equal(getTickerPageInstrument("9999999"), undefined);
    assert.equal(getTickerPageInstrument(""), undefined);
  });

  test("上場廃止で実取得が404になる 9613 は公開対象から外れている", () => {
    // PRICE_UNAVAILABLE_TICKERS の除外。sitemap に載せないための手書きリスト（FU20）。
    assert.equal(getTickerPageInstrument("9613"), undefined);
    assert.ok(
      !TICKER_PAGE_INSTRUMENTS.some((i) => i.ticker === "9613"),
      "9613 が公開対象に混ざっている",
    );
  });

  test("公開対象が空になっていない（universes の読み込み失敗を検知する）", () => {
    assert.ok(
      TICKER_PAGE_INSTRUMENTS.length > 50,
      `公開対象が ${TICKER_PAGE_INSTRUMENTS.length} 件しかない`,
    );
  });
});

// FU40: 手動台帳 `PRICE_UNAVAILABLE_TICKERS` の腐り。
//
// **縛れる範囲をはっきりさせておく。** 台帳の腐り方は3つある。
//
//   (A) 新たに取得不能になった銘柄が台帳に載らない
//   (B) 台帳に載せた銘柄が復活しても外れない
//   (C) 台帳が**空振り**になる（`major100` 側の変化で1件も除外しなくなる）
//
// (A) と (B) は実際に価格を取りに行かないと判定できず、S17 が FU20 で
// 「sitemap 生成に外部取得を増やさない」と決めているので**検知は見送った**
// （理由と手での再確認手順は `ticker-pages.ts` の当該コメント）。
// ここで縛れるのは (C) だけである。**この describe が通っても「台帳が正しい」
// ことにはならない。** 保証しているのは「台帳が効いている」ことだけ。
describe("公開集合の導出（FU40: 縛れるのは台帳の空振りだけ）", () => {
  const universeTickers = getUniverse("major100")?.tickers ?? [];
  const resolvable = universeTickers
    .map(({ ticker }) => getInstrumentByTicker(ticker))
    .filter((instrument): instrument is NonNullable<typeof instrument> => Boolean(instrument));
  const published = new Set(TICKER_PAGE_INSTRUMENTS.map((i) => i.ticker));
  const excluded = resolvable.filter((i) => !published.has(i.ticker)).map((i) => i.ticker);

  test("走査が生きている（0件のまま「全部通った」と報告しない）", () => {
    assert.ok(universeTickers.length >= 90, `major100 が ${universeTickers.length} 件しかない`);
    assert.ok(
      resolvable.length === universeTickers.length,
      `instruments へ解決できない銘柄がある: ${universeTickers.length - resolvable.length} 件`,
    );
  });

  test("公開集合が major100 から台帳ぶんだけ引いたものになっている", () => {
    // 2026-09-05 実測: major100 は 99件、除外は 9613 の1件、公開は 98件。
    // ここが「99 / 0 / 99」に動いたら台帳が空振りになっている（(C)）。
    // 逆に除外が増えたら、増やした本人が意図したかを確かめること。
    assert.deepEqual(
      { universe: resolvable.length, excluded: excluded.length, published: published.size },
      { universe: 99, excluded: 1, published: 98 },
    );
  });

  test("実際に除外されているのが 9613 だけである（台帳が効いている）", () => {
    // 台帳の文字列と major100 の表記（`9613.T`）がずれると、この Set は
    // 例外も警告も出さずに**何も除外しなくなる**。それをここで止める。
    assert.deepEqual(excluded, ["9613"]);
    assert.ok(
      universeTickers.some(({ ticker }) => ticker === "9613.T"),
      "major100 から 9613 が消えた。台帳のエントリは死んでいるので外すこと",
    );
  });

  test("公開する全銘柄が canonical 表記で自分自身へ解決する", () => {
    // sitemap は `/t/${instrument.ticker}` を出し、ページは同じ文字列を
    // `getTickerPageInstrument()` に通す。ここがずれると sitemap のURLが 404 になる。
    const broken = TICKER_PAGE_INSTRUMENTS.filter(
      (i) => getTickerPageInstrument(i.ticker)?.ticker !== i.ticker,
    ).map((i) => i.ticker);
    assert.deepEqual(broken, [], `sitemap に載るが解決できないURL: ${broken.join(", ")}`);
  });
});

describe("buildTickerPageSummary: 10年の系列から直近1年だけを切り出す", () => {
  const summary = buildTickerPageSummary(TEN_YEARS);
  assert.ok(summary, "サマリーが null になった");

  // 実装と独立に窓を作る。境界は「最終日の1年前」を含む。
  const window = TEN_YEARS.filter((p) => p.time >= "2025-08-14");

  test("窓の両端と本数が1年ぶんになる（10年ぶんを掲載しない）", () => {
    assert.equal(summary.asOf, "2026-08-14");
    assert.equal(summary.startDate, "2025-08-14");
    assert.equal(summary.observationCount, window.length);
    assert.equal(window.length, 366, "うるう日を含む1年＝366日");
    // 10年全体を集計してしまう退行を、件数で直接止める。
    assert.notEqual(summary.observationCount, TEN_YEARS.length);
  });

  test("現在値・期間リターンが窓の両端から出ている", () => {
    const first = window[0];
    const last = window[window.length - 1];
    assert.equal(summary.currentPrice, last.close);
    assertGolden(summary.periodReturn, Number((last.close / first.close - 1).toPrecision(10)));
  });

  test("年率ボラティリティが独立実装と一致する", () => {
    assertGolden(
      summary.annualizedVolatility,
      Number(annualizedSigma(logReturnsOf(window)).toPrecision(10)),
    );
  });

  test("最大ドローダウンが窓内の走行最高値からの下落率になる", () => {
    let peak = window[0].close;
    let worst = 0;
    for (let i = 1; i < window.length; i += 1) {
      peak = Math.max(peak, window[i].close);
      worst = Math.min(worst, window[i].close / peak - 1);
    }
    assertGolden(summary.maxDrawdown, Number(worst.toPrecision(10)));
    assert.ok(summary.maxDrawdown <= 0, "ドローダウンが正になっている");
  });
});

describe("buildTickerPageSummary: 窓が成立しない入力", () => {
  test("窓に2点そろわない（上場から1年未満）と null", () => {
    // 呼び出し側は null を DataUnavailable（noindex, follow）として扱う。
    assert.equal(buildTickerPageSummary(makeSeries("2026-08-14", 1)), null);
  });

  test("欠損・非正の終値は窓を切る前に落とす", () => {
    const dirty: PricePoint[] = [
      { time: "2025-09-01", open: 0, high: 0, low: 0, close: 0, volume: 0 },
      { time: "2025-09-02", open: 100, high: 100, low: 100, close: Number.NaN, volume: 0 },
      { time: "2026-08-13", open: 100, high: 100, low: 100, close: 100, volume: 0 },
      { time: "2026-08-14", open: 110, high: 110, low: 110, close: 110, volume: 0 },
    ];
    const result = buildTickerPageSummary(dirty);
    assert.ok(result);
    assert.equal(result.observationCount, 2);
    assert.equal(result.startDate, "2026-08-13");
  });

  test("うるう日が最終日でも窓の境界が壊れない", () => {
    // 2024-02-29 の1年前は実在しない 2023-02-29 になるが、ISO文字列の
    // 辞書順比較では 2023-02-28 < 2023-02-29 < 2023-03-01 なので境界として正しく働く。
    const series = makeSeries("2024-02-29", 800);
    const result = buildTickerPageSummary(series);
    assert.ok(result);
    assert.equal(result.asOf, "2024-02-29");
    assert.equal(result.startDate, "2023-03-01");
    assert.equal(
      result.observationCount,
      series.filter((p) => p.time >= "2023-02-29").length,
    );
  });
});
