import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import TeX from "../../components/analysis/TeX";
import {
  ANALYSIS_GUIDES,
  getAnalysisGuide,
  guideToolHref,
} from "../../lib/analysis-guides";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return ANALYSIS_GUIDES.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const guide = getAnalysisGuide(slug);
  if (!guide) return {};

  return {
    title: guide.title,
    description: guide.description,
    keywords: guide.keywords,
    alternates: { canonical: `/guide/${guide.slug}` },
    openGraph: {
      title: guide.title,
      description: guide.description,
      type: "article",
      url: `/guide/${guide.slug}`,
    },
    twitter: {
      card: "summary",
      title: guide.title,
      description: guide.description,
    },
  };
}

export default async function GuidePage({ params }: Props) {
  const { slug } = await params;
  const guide = getAnalysisGuide(slug);
  if (!guide) notFound();

  const related = guide.related
    .map((relatedSlug) => getAnalysisGuide(relatedSlug))
    .filter((entry) => entry !== undefined);
  const canonicalUrl = `https://kabugenron.com/guide/${guide.slug}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: guide.title,
    description: guide.description,
    url: canonicalUrl,
    inLanguage: "ja",
    datePublished: "2026-08-01",
    dateModified: "2026-08-01",
    author: { "@type": "Organization", name: "株価構造分析", url: "https://kabugenron.com" },
    publisher: { "@type": "Organization", name: "株価構造分析", url: "https://kabugenron.com" },
    about: guide.keywords.map((name) => ({ "@type": "Thing", name })),
    isPartOf: { "@type": "CollectionPage", name: "株価分析ガイド", url: "https://kabugenron.com/guide" },
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4">
          <Link href="/" className="font-bold text-slate-900 hover:text-blue-700">株価構造分析</Link>
          <Link href="/guide" className="text-sm font-medium text-blue-700 hover:text-blue-900">分析ガイド一覧</Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:py-12">
        <nav aria-label="パンくず" className="text-sm text-slate-500">
          <ol className="flex flex-wrap items-center gap-2">
            <li><Link href="/" className="hover:text-blue-700">ホーム</Link></li>
            <li aria-hidden="true">/</li>
            <li><Link href="/guide" className="hover:text-blue-700">分析ガイド</Link></li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-slate-700">{guide.shortTitle}</li>
          </ol>
        </nav>

        <article className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <header className="border-b border-slate-200 px-5 py-8 sm:px-10 sm:py-10">
            <p className="text-sm font-semibold text-blue-700">{guide.category}</p>
            <h1 className="mt-2 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{guide.title}</h1>
            <p className="mt-5 max-w-3xl text-base leading-8 text-slate-600">{guide.description}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              {guide.keywords.slice(0, 5).map((keyword) => (
                <span key={keyword} className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{keyword}</span>
              ))}
            </div>
          </header>

          <div className="space-y-10 px-5 py-8 sm:px-10 sm:py-10">
            <GuideSection title="この分析で分かること">
              <p>{guide.summary}</p>
            </GuideSection>

            <GuideSection title="分析方法">
              <ol className="list-decimal space-y-3 pl-5">
                {guide.method.map((item) => <li key={item}>{item}</li>)}
              </ol>
            </GuideSection>

            <GuideSection title="数式と変数">
              <div className="space-y-4">
                {guide.formulas.map((formula) => (
                  <div key={formula.label} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <h3 className="font-semibold text-slate-900">{formula.label}</h3>
                    <div className="my-3 rounded-lg bg-white px-2 py-3 text-center text-sm sm:text-base">
                      <TeX block>{formula.tex}</TeX>
                    </div>
                    <p className="text-sm leading-7 text-slate-600">{formula.explanation}</p>
                  </div>
                ))}
              </div>
            </GuideSection>

            <GuideSection title="用語の定義">
              <dl className="space-y-4">
                {guide.terms.map(({ term, definition }) => (
                  <div key={term} className="border-l-2 border-blue-300 pl-4">
                    <dt className="font-semibold text-slate-900">{term}</dt>
                    <dd className="mt-1 text-slate-600">{definition}</dd>
                  </div>
                ))}
              </dl>
            </GuideSection>

            <GuideSection title="直感的な例">
              <div className="rounded-xl bg-blue-50 p-5 text-blue-950">{guide.example}</div>
            </GuideSection>

            <GuideListSection title="結果の読み方" items={guide.reading} />
            <GuideListSection title="投資への活用" items={guide.investmentUse} />
            <GuideListSection title="限界と注意点" items={guide.limitations} tone="warning" />

            <section aria-labelledby="try-analysis" className="rounded-2xl bg-slate-900 p-6 text-white sm:p-8">
              <h2 id="try-analysis" className="text-xl font-bold">実際の株価データで確認する</h2>
              <p className="mt-3 text-sm leading-7 text-slate-300">
                トヨタ自動車を例に、該当パネルを開きます。移動後に銘柄・期間・入力系列を変更できます。
              </p>
              <Link
                href={guideToolHref(guide)}
                className="mt-5 inline-flex rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 hover:bg-blue-50"
              >
                {guide.shortTitle}を実データで見る
              </Link>
            </section>

            <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs leading-6 text-slate-500">
              本ページは分析手法の理解を目的とした情報提供です。将来の価格や利益を保証するものではなく、
              特定銘柄の売買を推奨するものではありません。
            </p>
          </div>
        </article>

        <section aria-labelledby="related-guides" className="mt-10">
          <h2 id="related-guides" className="text-xl font-bold">関連する分析ガイド</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {related.map((entry) => (
              <Link
                key={entry.slug}
                href={`/guide/${entry.slug}`}
                className="rounded-xl border border-slate-200 bg-white p-4 font-semibold text-slate-800 shadow-sm hover:border-blue-300 hover:text-blue-700"
              >
                {entry.shortTitle}
              </Link>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

function GuideSection({ title, children }: { title: string; children: React.ReactNode }) {
  const id = `section-${title}`;
  return (
    <section aria-labelledby={id} className="text-base leading-8 text-slate-700">
      <h2 id={id} className="mb-4 text-2xl font-bold tracking-tight text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

function GuideListSection({
  title,
  items,
  tone = "default",
}: {
  title: string;
  items: string[];
  tone?: "default" | "warning";
}) {
  return (
    <GuideSection title={title}>
      <ul className={`list-disc space-y-3 rounded-xl p-5 pl-10 ${tone === "warning" ? "bg-amber-50 text-amber-950" : "bg-slate-50"}`}>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </GuideSection>
  );
}
