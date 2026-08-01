import type { Metadata } from "next";
import Link from "next/link";
import { ANALYSIS_GUIDES } from "../lib/analysis-guides";

export const metadata: Metadata = {
  title: "株価分析ガイド｜数式・読み方・投資への活用",
  description:
    "DFA・Hurst指数、自己相関、GARCH、エントロピー、曜日効果、ウォークフォワード分析など、株価分析手法を数式と具体例で解説します。",
  alternates: { canonical: "/guide" },
  openGraph: {
    title: "株価分析ガイド｜数式・読み方・投資への活用",
    description: "株価分析手法の意味、計算式、結果の読み方、限界を体系的に解説します。",
    url: "/guide",
  },
};

export default function GuideIndexPage() {
  const categories = Array.from(new Set(ANALYSIS_GUIDES.map((guide) => guide.category)));

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "株価分析ガイド",
    description: metadata.description,
    url: "https://kabugenron.com/guide",
    hasPart: ANALYSIS_GUIDES.map((guide) => ({
      "@type": "TechArticle",
      headline: guide.title,
      url: `https://kabugenron.com/guide/${guide.slug}`,
    })),
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <Link href="/" className="font-bold text-slate-900 hover:text-blue-700">
            株価構造分析
          </Link>
          <nav aria-label="主要ナビゲーション" className="flex items-center gap-3 text-sm">
            <Link href="/axioms" className="text-slate-600 hover:text-blue-700">株式原論</Link>
            <Link href="/portfolio" className="text-slate-600 hover:text-blue-700">ポートフォリオ</Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10 sm:py-14">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold tracking-wide text-blue-700">ANALYSIS GUIDE</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">株価分析ガイド</h1>
          <p className="mt-4 text-base leading-8 text-slate-600 sm:text-lg">
            分析手法の名前だけで終わらず、計算方法、変数の意味、直感的な例、結果の読み方、
            投資への活用、限界までを一つのページで確認できます。
          </p>
        </div>

        <div className="mt-8 flex flex-wrap gap-2" aria-label="掲載カテゴリ">
          {categories.map((category) => (
            <span key={category} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600">
              {category}
            </span>
          ))}
        </div>

        <section aria-labelledby="guide-list-heading" className="mt-10">
          <h2 id="guide-list-heading" className="sr-only">分析ガイド一覧</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {ANALYSIS_GUIDES.map((guide) => (
              <article key={guide.slug} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-xs font-semibold text-blue-700">{guide.category}</p>
                <h2 className="mt-2 text-xl font-bold leading-7 text-slate-900">
                  <Link href={`/guide/${guide.slug}`} className="hover:text-blue-700">
                    {guide.shortTitle}
                  </Link>
                </h2>
                <p className="mt-3 flex-1 text-sm leading-7 text-slate-600">{guide.description}</p>
                <Link
                  href={`/guide/${guide.slug}`}
                  className="mt-5 inline-flex items-center text-sm font-semibold text-blue-700 hover:text-blue-900"
                >
                  数式と読み方を見る <span aria-hidden="true" className="ml-1">→</span>
                </Link>
              </article>
            ))}
          </div>
        </section>

        <aside className="mt-10 rounded-2xl bg-slate-900 p-6 text-white">
          <h2 className="text-lg font-bold">実データで確かめる</h2>
          <p className="mt-2 text-sm leading-7 text-slate-300">
            各ガイドからトヨタ自動車の実データを読み込んだ該当分析へ移動できます。
            銘柄、期間、入力系列は分析画面で変更できます。
          </p>
          <Link href="/?ticker=7203.T" className="mt-4 inline-flex rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-blue-50">
            分析画面を開く
          </Link>
        </aside>
      </main>
    </div>
  );
}
