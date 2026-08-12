"use client";

// 構造化ガイド(AnalysisGuideEntry)を、パネル内の折りたたみ解説として描画する。
//
// 目的は本文の二重管理をなくすこと。/guide/[slug] とこのパネルは
// app/lib/analysis-guides.ts の同一エントリを唯一のソースとして描く。
// レイアウトは違ってよいが、**本文の文字列をここに書いてはいけない**。
// 新しい文言が要るときは analysis-guides.ts のエントリ側に足すこと。
//
// 使い方:
//   <GuideEntryPanel slug="technical-indicators" title="テクニカル指標の読み方" />
//
// title は AnalysisGuide の見出しと同時に guide_open イベントのラベルになる。
// 既存パネルを移植するときは移植前の見出しをそのまま渡し、計測系列を切らないこと。

import Link from "next/link";
import { getAnalysisGuide } from "../../lib/analysis-guides";
import AnalysisGuide from "./AnalysisGuide";
import TeX from "./TeX";

interface Props {
  /** app/lib/analysis-guides.ts の slug。 */
  slug: string;
  /** 折りたたみの見出し。省略時はエントリの shortTitle から作る。 */
  title?: string;
}

export default function GuideEntryPanel({ slug, title }: Props) {
  const guide = getAnalysisGuide(slug);
  // slug の打ち間違いでパネルから解説が黙って消えないよう、存在チェックを明示する。
  if (!guide) return null;

  return (
    <AnalysisGuide title={title ?? `${guide.shortTitle}の読み方`}>
      <p>{guide.summary}</p>

      <GuideBlock heading="分析方法">
        <ol className="list-decimal space-y-1 pl-5">
          {guide.method.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </GuideBlock>

      <GuideBlock heading="数式と変数">
        <div className="space-y-2">
          {guide.formulas.map((formula) => (
            <div key={formula.label} className="rounded border border-gray-200 bg-white p-2">
              <div className="font-medium text-gray-700">{formula.label}</div>
              <div className="my-1 text-center">
                <TeX block>{formula.tex}</TeX>
              </div>
              <p className="text-fg-muted">{formula.explanation}</p>
            </div>
          ))}
        </div>
      </GuideBlock>

      <GuideBlock heading="用語の定義">
        <dl className="space-y-1">
          {guide.terms.map(({ term, definition }) => (
            <div key={term}>
              <dt className="inline font-medium text-gray-700">{term}: </dt>
              <dd className="inline">{definition}</dd>
            </div>
          ))}
        </dl>
      </GuideBlock>

      <GuideBlock heading="直感的な例">
        <p>{guide.example}</p>
      </GuideBlock>

      <GuideList heading="結果の読み方" items={guide.reading} />
      <GuideList heading="投資への活用" items={guide.investmentUse} />
      <GuideList heading="限界と注意点" items={guide.limitations} />

      <p className="pt-1">
        <Link
          href={`/guide/${guide.slug}`}
          className="font-medium text-blue-700 underline hover:text-blue-900"
        >
          {guide.shortTitle}の解説ページを開く
        </Link>
      </p>
    </AnalysisGuide>
  );
}

function GuideBlock({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1 font-medium text-gray-700">{heading}</h4>
      {children}
    </section>
  );
}

function GuideList({ heading, items }: { heading: string; items: readonly string[] }) {
  return (
    <GuideBlock heading={heading}>
      <ul className="list-disc space-y-1 pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </GuideBlock>
  );
}
