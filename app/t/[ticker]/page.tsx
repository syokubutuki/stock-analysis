import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { cache, Suspense } from "react";
import DataQualityNotice from "../../components/analysis/DataQualityNotice";
import { formatSummaryPrice } from "../../lib/format";
import { getStockData } from "../../lib/stock-data.server";
import {
  buildTickerPageSummary,
  getTickerPageInstrument,
  TICKER_PAGE_INSTRUMENTS,
} from "../../lib/ticker-pages";
import type { Instrument } from "../../lib/instruments";
import type { StockData } from "../../lib/types";

type Props = { params: Promise<{ ticker: string }> };

// FU21（キャッシュ方針）の判断: **force-dynamic を維持する。**
//
// ISR（revalidate）へ寄せることは、このページの範囲では選べない。
// stock-source.server.ts の上流 fetch が `cache: "no-store"` なので、`revalidate` を
// 付けても Next は各銘柄で `DYNAMIC_SERVER_USAGE` を投げて動的へ落ちる。実測すると
// ビルドが98銘柄ぶん Yahoo を叩いたうえで1ページも prerender されない（`ƒ` のまま）。
// しかも例外は本ファイルの try/catch が拾ってしまうため、静かに「取得できませんでした」
// を焼き付けかねない。ISR を成立させるには stock-source.server.ts の no-store を外すか
// Cache Components を有効化する必要があり、どちらも /api/stock 全体に波及する。
//
// したがってキャッシュは getStockData の Runtime Cache（fresh 8時間・保持7日）が担う。
// OG画像（opengraph-image.tsx）はこの層を共有したうえで、CDN 側の s-maxage を明示して
// 1銘柄あたりの画像生成を8時間に1回へ抑える。
export const dynamic = "force-dynamic";
export const dynamicParams = false;

const loadStockData = cache((symbol: string) => getStockData(symbol, "1y"));

export function generateStaticParams() {
  return TICKER_PAGE_INSTRUMENTS.map(({ ticker }) => ({ ticker }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { ticker: requestedTicker } = await params;
  const instrument = getTickerPageInstrument(requestedTicker);
  if (!instrument) notFound();
  if (requestedTicker !== instrument.ticker) {
    permanentRedirect(`/t/${encodeURIComponent(instrument.ticker)}`);
  }

  const canonicalPath = `/t/${instrument.ticker}`;
  const description = `${instrument.name}（${instrument.ticker}）の直近1年の株価、期間リターン、年率ボラティリティ、最大ドローダウンを実測値で確認できます。`;
  const title = `${instrument.name}（${instrument.ticker}）株価分析`;
  return {
    title,
    description,
    alternates: { canonical: canonicalPath },
    // images は指定しない。opengraph-image.tsx（ファイル規約）が銘柄別の画像を
    // og:image / twitter:image の両方に流し込む。ここで images を書くと上書きしてしまう。
    openGraph: { title, description, type: "website", url: canonicalPath },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function TickerPage({ params }: Props) {
  const { ticker: requestedTicker } = await params;
  const instrument = getTickerPageInstrument(requestedTicker);
  if (!instrument) notFound();
  if (requestedTicker !== instrument.ticker) {
    permanentRedirect(`/t/${encodeURIComponent(instrument.ticker)}`);
  }

  return (
    <Suspense fallback={<TickerPageLoading />}>
      <TickerPageContent instrument={instrument} />
    </Suspense>
  );
}

async function TickerPageContent({ instrument }: { instrument: Instrument }) {
  let data: StockData;
  try {
    data = await loadStockData(instrument.yahooSymbol);
  } catch (error) {
    console.error(`[ticker-page] failed to load ${instrument.yahooSymbol}`, error);
    return <DataUnavailable instrument={instrument} />;
  }

  const summary = buildTickerPageSummary(data.prices);
  if (!summary) return <DataUnavailable instrument={instrument} />;

  const analysisHref = `/?ticker=${encodeURIComponent(instrument.yahooSymbol)}&period=1y`;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4">
          <Link href="/" className="font-bold text-slate-900 hover:text-blue-700">
            株価構造分析
          </Link>
          <Link href={analysisHref} className="text-sm font-semibold text-blue-700 hover:text-blue-900">
            詳細分析を開く
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:py-12">
        <nav aria-label="パンくず" className="text-sm text-slate-500">
          <ol className="flex flex-wrap items-center gap-2">
            <li><Link href="/" className="hover:text-blue-700">ホーム</Link></li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-slate-700">{instrument.name}</li>
          </ol>
        </nav>

        <article className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <header className="border-b border-slate-200 px-5 py-8 sm:px-10 sm:py-10">
            <p className="text-sm font-semibold text-blue-700">
              {instrument.market} · {instrument.currency}
            </p>
            <h1 className="mt-2 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
              {instrument.name}
            </h1>
            <p className="mt-2 font-mono text-base text-slate-500">銘柄コード {instrument.ticker}</p>
            <p className="mt-5 max-w-3xl text-sm leading-7 text-slate-600 sm:text-base">
              直近1年の日足終値から、値動きの大きさと下落幅を同じ基準で集計した実測サマリーです。
              将来の値動きを予測するものではありません。
            </p>
          </header>

          <div className="space-y-8 px-5 py-8 sm:px-10 sm:py-10">
            <DataQualityNotice report={data.dataQuality} />

            <section aria-labelledby="price-summary">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <h2 id="price-summary" className="text-xl font-bold">直近1年の実測値</h2>
                <p className="text-sm text-slate-500">基準日 {formatDate(summary.asOf)}</p>
              </div>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <SummaryCard
                  label="現在値"
                  value={`${formatSummaryPrice(summary.currentPrice, data.currency)} ${data.currency}`}
                />
                <SummaryCard label="期間リターン" value={formatPercent(summary.periodReturn)} />
                <SummaryCard label="年率ボラティリティ" value={formatPercent(summary.annualizedVolatility, false)} />
                <SummaryCard label="最大ドローダウン" value={formatPercent(summary.maxDrawdown)} />
              </dl>
              <p className="mt-4 text-sm leading-7 text-slate-500">
                対象期間 {formatDate(summary.startDate)}〜{formatDate(summary.asOf)}・{summary.observationCount.toLocaleString("ja-JP")}営業日
              </p>
            </section>

            <section aria-labelledby="metric-definitions" className="rounded-xl bg-slate-50 p-5 sm:p-6">
              <h2 id="metric-definitions" className="text-lg font-bold">数値の定義</h2>
              <dl className="mt-4 space-y-4 text-sm leading-7 text-slate-700">
                <div>
                  <dt className="font-semibold text-slate-900">期間リターン</dt>
                  <dd>期間初日の終値から基準日の終値までの騰落率です。配当の再投資効果は含みません。</dd>
                </div>
                <div>
                  <dt className="font-semibold text-slate-900">年率ボラティリティ</dt>
                  <dd>日次対数リターンの標本標準偏差を、年間252営業日として年率換算した値です。値動きの方向ではなく、振れ幅を表します。</dd>
                </div>
                <div>
                  <dt className="font-semibold text-slate-900">最大ドローダウン</dt>
                  <dd>期間中の終値の最高値から、その後の終値までの最も大きな下落率です。ザラ場の安値は含みません。</dd>
                </div>
              </dl>
            </section>

            <section aria-labelledby="open-analysis" className="rounded-2xl bg-slate-900 p-6 text-white sm:p-8">
              <h2 id="open-analysis" className="text-xl font-bold">この銘柄を詳しく分析する</h2>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
                詳細画面では期間や入力系列を切り替え、各統計パネルの計算根拠と限界を確認できます。
                共有用の分析URLとこの概要ページは役割を分け、このページを検索向けの正規URLとしています。
              </p>
              <Link
                href={analysisHref}
                className="mt-5 inline-flex rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 hover:bg-blue-50"
              >
                {instrument.name}の詳細分析を開く
              </Link>
            </section>

            <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-6 text-amber-950">
              掲載値は過去データの集計であり、特定銘柄の売買を推奨するものではありません。
              ページ下部の免責事項もあわせてご確認ください。
            </p>
          </div>
        </article>
      </main>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="mt-2 text-2xl font-bold tabular-nums text-slate-900">{value}</dd>
    </div>
  );
}

function DataUnavailable({ instrument }: { instrument: Instrument }) {
  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-20 text-center">
      <meta name="robots" content="noindex, follow" />
      <p className="text-sm font-semibold text-amber-700">価格データを取得できませんでした</p>
      <h1 className="mt-2 text-3xl font-bold text-slate-900">{instrument.name}（{instrument.ticker}）</h1>
      <p className="mt-4 leading-7 text-slate-600">
        一時的な上流障害またはメンテナンスの可能性があります。時間をおいて再度お試しください。
        銘柄ページ自体は公開対象ですが、数値が確認できない間は検索登録を抑止します。
      </p>
      <Link href="/" className="mt-8 inline-flex rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">
        ホームへ戻る
      </Link>
    </main>
  );
}

function TickerPageLoading() {
  return (
    <main className="mx-auto min-h-screen max-w-5xl animate-pulse px-4 py-12" aria-busy="true">
      <p className="sr-only">銘柄データを読み込んでいます</p>
      <div className="h-5 w-36 rounded bg-slate-200" />
      <div className="mt-8 h-10 w-2/3 rounded bg-slate-200" />
      <div className="mt-4 h-5 w-32 rounded bg-slate-200" />
      <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-28 rounded-xl bg-slate-200" />
        ))}
      </div>
    </main>
  );
}

function formatPercent(value: number, showPositiveSign = true): string {
  const sign = showPositiveSign && value >= 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}
