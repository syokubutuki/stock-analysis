import type { Instrument } from "./instruments";
import { getInstrumentByTicker } from "./instruments";
import type { PricePoint } from "./types";
import { getUniverse } from "./universes";

export interface TickerPageSummary {
  asOf: string;
  startDate: string;
  currentPrice: number;
  periodReturn: number;
  annualizedVolatility: number;
  maxDrawdown: number;
  observationCount: number;
}

const majorUniverse = getUniverse("major100")?.tickers ?? [];

/**
 * `major100` に載っているが、実取得が 404 になるので公開しない銘柄。**手で維持する台帳**である。
 *
 * FU40 の判断（2026-09-05）: **自動検知は見送る。台帳は残す。**
 *
 * 台帳を廃止できるか
 * ------------------
 * 廃止しても利用者には無害である。取得に失敗した `/t/[ticker]` は
 * `DataUnavailable`（`noindex, follow` ＋ 説明文・HTTP 200）へ落ち、OG画像も数値なしの
 * カードになる。**それでも残すのは sitemap のため**で、廃止すると
 * `/t/9613` が「恒久的に noindex と分かっているURL」として sitemap に載る。
 * サイトマップに noindex を出し続けるのは Search Console の指摘対象であり、
 * 得られるものが無い。1行の台帳と引き換えにする理由がない。
 *
 * 腐りを自動検知できるか — できない
 * ---------------------------------
 * 腐り方は2方向あり、**どちらも実際に価格を取りに行かないと判定できない**。
 *   (A) 新たに取得不能になった銘柄が台帳に載らない → sitemap に noindex URL が増える
 *   (B) ここに載せた銘柄が復活しても外れない       → 公開できるページを隠し続ける
 * S17 が FU20 で「sitemap 生成に外部取得を増やさない」と決めており（`sitemap.ts` に
 * 理由あり）、その判断は覆さない。Runtime Cache の HIT だけを見る案も、温まり具合で
 * 掲載URLが増減するので採らない。**したがって「検知できない」が結論である。**
 *
 * テストで縛れるのは1方向だけ（`__tests__/ticker-pages.test.ts`）
 * --------------------------------------------------------------
 *   (C) この台帳が**空振りになる**こと ——`major100` からその銘柄が消える、表記が
 *       `9613.T` に変わる等でこの Set が何も除外しなくなる状態は、取得なしで検知できる。
 *       公開件数と除外件数を黄金値で固定してある。
 *   **(A) と (B) は縛れていない。** テストが通ることを「台帳が正しい」と読まないこと。
 *
 * 手で再確認する方法（腐りが疑われたときだけ）
 * --------------------------------------------
 *   npm run dev
 *   curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/api/stock?ticker=9613.T&range=10y"
 * 200 が返れば復活しているので、この Set から外して公開対象へ戻す。
 * 逆に他の銘柄が 404 を返すようになったら、ここへ足す。
 * **2026-09-05 実測: `9613.T` は 404（`Failed to fetch data for 9613.T`）。台帳は現時点で正しい。**
 *
 * 台帳が守る範囲は `/t/[ticker]` と sitemap だけである。`instruments.ts` の
 * `priceSupported` は銘柄**種別**に価格アダプタがあるかを表す別の軸で、`9613` も
 * `true` のままなので、検索候補には従来どおり出る（本アプリ側で取得に失敗する）。
 */
const PRICE_UNAVAILABLE_TICKERS = new Set(["9613"]);

/** `/t/[ticker]` で公開する主要銘柄。実取得で404になる上場廃止銘柄は除外する。 */
export const TICKER_PAGE_INSTRUMENTS: readonly Instrument[] = majorUniverse
  .flatMap(({ ticker }) => {
    const instrument = getInstrumentByTicker(ticker);
    return instrument && !PRICE_UNAVAILABLE_TICKERS.has(instrument.ticker)
      ? [instrument]
      : [];
  });

const tickerPageInstrumentMap = new Map<string, Instrument>();
for (const instrument of TICKER_PAGE_INSTRUMENTS) {
  tickerPageInstrumentMap.set(instrument.ticker, instrument);
  tickerPageInstrumentMap.set(instrument.yahooSymbol, instrument);
}

export function getTickerPageInstrument(value: string): Instrument | undefined {
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  return tickerPageInstrumentMap.get(normalized);
}

/**
 * `YYYY-MM-DD` の1年前を、同じ書式の文字列として返す。
 *
 * `Date` を経由しないのはタイムゾーンで日がずれるのを避けるため。うるう日の
 * `2024-02-29` は `2023-02-29`（実在しない日）になるが、**窓の境界としては正しく働く**。
 * ISO日付は辞書順が時系列順なので、`2023-02-28 < 2023-02-29 < 2023-03-01` の
 * 比較結果は実在の有無に依らない。
 */
function oneYearBefore(isoDate: string): string {
  const [year, rest] = [isoDate.slice(0, 4), isoDate.slice(4)];
  return `${Number(year) - 1}${rest}`;
}

/**
 * 日足終値から、銘柄ページに掲載する直近1年の実測サマリーを計算する。
 * ボラティリティは日次対数リターンの標本標準偏差を √252 倍する。
 *
 * **10年の系列を渡してよい**（というより渡すことを想定している）。
 * 銘柄ページが `range=1y` で取ると、アプリ本体・`/api/stock` が使う `10y` と
 * 別のキャッシュキーになり、誰も温めない専用エントリになってしまうため
 * （`stock-data.server.ts` の `cacheKey()` は range を含む）。
 * 取得は `10y` に寄せ、期間の切り出しはここで行う。
 */
export function buildTickerPageSummary(prices: PricePoint[]): TickerPageSummary | null {
  const usable = prices.filter(
    (price) => Number.isFinite(price.close) && price.close > 0,
  );
  if (usable.length < 2) return null;

  const cutoff = oneYearBefore(usable[usable.length - 1].time);
  const valid = usable.filter((price) => price.time >= cutoff);
  // 上場から1年未満の銘柄は窓に2点そろわない。呼び出し側が「取得できなかった」扱いにする。
  if (valid.length < 2) return null;

  const first = valid[0];
  const last = valid[valid.length - 1];
  const returns: number[] = [];
  let peak = first.close;
  let maxDrawdown = 0;

  for (let i = 1; i < valid.length; i += 1) {
    const previous = valid[i - 1].close;
    const current = valid[i].close;
    returns.push(Math.log(current / previous));
    peak = Math.max(peak, current);
    maxDrawdown = Math.min(maxDrawdown, current / peak - 1);
  }

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      (returns.length - 1)
    : 0;

  return {
    asOf: last.time,
    startDate: first.time,
    currentPrice: last.close,
    periodReturn: last.close / first.close - 1,
    annualizedVolatility: Math.sqrt(variance) * Math.sqrt(252),
    maxDrawdown,
    observationCount: valid.length,
  };
}
