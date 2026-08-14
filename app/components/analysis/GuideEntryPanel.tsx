"use client";

// 構造化ガイド(AnalysisGuideEntry)を、パネル内の折りたたみ解説として描画する。
//
// 目的は本文の二重管理をなくすこと。/guide/[slug] とこのパネルは
// app/lib/analysis-guides.ts の同一エントリを唯一のソースとして描く。
// レイアウトは違ってよいが、**本文の文字列をここに書いてはいけない**。
// 新しい文言が要るときは analysis-guides.ts のエントリ側に足すこと。
// （見出し・タブ名・enum のラベルは本文ではなく UI の部品なのでここに置く。）
//
// 使い方:
//   <GuideEntryPanel slug="technical-indicators" title="テクニカル指標の読み方" />
//
// title は AnalysisGuide の見出しと同時に guide_open イベントのラベルになる。
// 既存パネルを移植するときは移植前の見出しをそのまま渡し、計測系列を切らないこと。
//
// 描画方針(2026-08):
//   8ブロックを縦に積むと分析パネル内で数画面ぶんの高さになり、誰も最後まで読まない。
//   ヘッダーカード + 4タブ(概要/数式/用語/実践)に畳み、各ブロックは文字列の羅列ではなく
//   図として描く。図はすべてインラインSVG/CSSで、外部画像もフォントも増やさない:
//     - 分野アイコン : entry.category → 線画グリフ + 色調(CATEGORY_STYLES)
//     - 手順フロー図 : entry.method → 連結された番号付きステップ
//     - 数式カード   : entry.formulas → 本組み + TeXソースのコピー
//     - 信号色分け   : reading=青 / investmentUse=緑 / limitations=琥珀
//   いずれもエントリの構造から自動で決まるので、ガイドを足しても手当ては要らない。

import { useCallback, useId, useRef, useState } from "react";
import Link from "next/link";
import type { AnalysisGuideEntry } from "../../lib/analysis-guides";
import { getAnalysisGuide } from "../../lib/analysis-guides";
import AnalysisGuide from "./AnalysisGuide";
import TeX from "./TeX";

interface Props {
  /** app/lib/analysis-guides.ts の slug。 */
  slug: string;
  /** 折りたたみの見出し。省略時はエントリの shortTitle から作る。 */
  title?: string;
}

const TABS = [
  { key: "overview", label: "概要" },
  { key: "formula", label: "数式" },
  { key: "terms", label: "用語" },
  { key: "practice", label: "実践" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/** enum 値を画面表示に開く。値が増えたら原文をそのまま出してでも落とさない。 */
const PERIOD_LABELS: Record<string, string> = { "1y": "1年", "5y": "5年", "10y": "10年" };
const SERIES_MODE_LABELS: Record<string, string> = {
  close: "終値",
  open: "始値",
  diff: "差分",
  logReturn: "対数リターン",
  overnightReturn: "夜間リターン",
  intradayReturn: "日中リターン",
};

export default function GuideEntryPanel({ slug, title }: Props) {
  const guide = getAnalysisGuide(slug);
  // slug の打ち間違いでパネルから解説が黙って消えないよう、存在チェックを明示する。
  if (!guide) return null;

  return (
    // bare: 中身が自前でカードを持つので、AnalysisGuide 既定の灰色の箱は外す。
    <AnalysisGuide title={title ?? `${guide.shortTitle}の読み方`} bare>
      <GuideCard guide={guide} />
    </AnalysisGuide>
  );
}

function GuideCard({ guide }: { guide: AnalysisGuideEntry }) {
  const [tab, setTab] = useState<TabKey>("overview");
  const baseId = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const style = categoryStyle(guide.category);

  // ← → でタブを移動する(role=tab の期待挙動)。
  const onTabKeyDown = useCallback((event: React.KeyboardEvent) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    setTab((current) => {
      const index = TABS.findIndex((t) => t.key === current);
      const next = TABS[(index + delta + TABS.length) % TABS.length].key;
      tabRefs.current[next]?.focus();
      return next;
    });
  }, []);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white text-[13px] leading-6 text-slate-700 shadow-sm">
      <header className={`border-b border-slate-200 bg-gradient-to-br px-4 py-4 ${style.header}`}>
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${style.glyph}`}
          >
            <CategoryIcon category={guide.category} />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${style.chip}`}>
                {guide.category}
              </span>
              <MetaChip label="推奨期間" value={PERIOD_LABELS[guide.period] ?? guide.period} />
              <MetaChip
                label="入力系列"
                value={SERIES_MODE_LABELS[guide.seriesMode] ?? guide.seriesMode}
              />
            </div>

            <h4 className="mt-1.5 text-[15px] font-bold leading-6 tracking-tight text-slate-900">
              {guide.shortTitle}
            </h4>
            {/* 幅の広いパネルでも1行が長くなりすぎないよう、読み幅を制限する。 */}
            <p className="mt-1 max-w-3xl text-slate-600">{guide.summary}</p>

            <div className="mt-2 flex flex-wrap gap-1">
              {guide.keywords.slice(0, 5).map((keyword) => (
                <span
                  key={keyword}
                  className="rounded border border-slate-200 bg-white/70 px-1.5 py-0.5 text-[11px] text-slate-500"
                >
                  {keyword}
                </span>
              ))}
            </div>
          </div>
        </div>
      </header>

      <div
        role="tablist"
        aria-label={`${guide.shortTitle}の解説`}
        onKeyDown={onTabKeyDown}
        className="flex items-center gap-0.5 border-b border-slate-200 bg-slate-50/80 px-2"
      >
        {TABS.map(({ key, label }) => {
          const active = tab === key;
          return (
            <button
              key={key}
              ref={(node) => {
                tabRefs.current[key] = node;
              }}
              role="tab"
              type="button"
              id={`${baseId}-tab-${key}`}
              aria-selected={active}
              aria-controls={`${baseId}-panel-${key}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
                active
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`${baseId}-panel-${tab}`}
        aria-labelledby={`${baseId}-tab-${tab}`}
        className="space-y-4 px-4 py-4"
      >
        {tab === "overview" && (
          <>
            <Block heading="分析方法" icon={<StepsGlyph />}>
              <MethodFlow steps={guide.method} accent={style.step} />
            </Block>
            <Block heading="直感的な例" icon={<BulbGlyph />}>
              <figure className="rounded-lg border border-blue-100 bg-blue-50/70 p-3 text-blue-950">
                {guide.example}
              </figure>
            </Block>
          </>
        )}

        {tab === "formula" && (
          <Block heading="数式と変数" icon={<SigmaGlyph />}>
            <div className="space-y-2.5">
              {guide.formulas.map((formula) => (
                <FormulaCard key={formula.label} {...formula} />
              ))}
            </div>
          </Block>
        )}

        {tab === "terms" && (
          <Block heading="用語の定義" icon={<BookGlyph />}>
            <dl className="grid gap-2 sm:grid-cols-2">
              {guide.terms.map(({ term, definition }) => (
                <div
                  key={term}
                  className="rounded-lg border border-slate-200 border-l-2 border-l-blue-400 bg-slate-50/60 p-3"
                >
                  <dt className="font-semibold text-slate-900">{term}</dt>
                  <dd className="mt-0.5 text-slate-600">{definition}</dd>
                </div>
              ))}
            </dl>
          </Block>
        )}

        {tab === "practice" && (
          <>
            <SignalList heading="結果の読み方" items={guide.reading} tone="reading" />
            <SignalList heading="投資への活用" items={guide.investmentUse} tone="use" />
            <SignalList heading="限界と注意点" items={guide.limitations} tone="warning" />
          </>
        )}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/80 px-4 py-2.5">
        <span className="text-[11px] text-slate-400">{guide.category}</span>
        <Link
          href={`/guide/${guide.slug}`}
          className="inline-flex items-center gap-1 font-semibold text-blue-700 hover:text-blue-900"
        >
          {guide.shortTitle}の解説ページ
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <path d="M5 12h13M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </footer>
    </div>
  );
}

/* ---------------------------------------------------------------- 部品 */

function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white/80 px-2 py-0.5 text-[11px] text-slate-500">
      <span className="text-slate-400">{label}</span>
      <span className="font-medium text-slate-700">{value}</span>
    </span>
  );
}

function Block({
  heading,
  icon,
  children,
}: {
  heading: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h5 className="mb-2 flex items-center gap-1.5 font-semibold text-slate-900">
        <span aria-hidden="true" className="text-slate-400">
          {icon}
        </span>
        {heading}
      </h5>
      {children}
    </section>
  );
}

/** method[] を「連結された番号付きステップ」として描く手順フロー図。 */
function MethodFlow({ steps, accent }: { steps: readonly string[]; accent: string }) {
  return (
    <ol className="space-y-0">
      {steps.map((step, index) => (
        <li key={step} className="relative flex gap-3 pb-3 last:pb-0">
          {/* ステップ同士をつなぐ縦線。最後の1件では描かない。 */}
          {index < steps.length - 1 && (
            <span
              aria-hidden="true"
              className="absolute left-[11px] top-6 bottom-0 w-px bg-gradient-to-b from-slate-300 to-slate-200"
            />
          )}
          <span
            aria-hidden="true"
            className={`relative z-10 mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${accent}`}
          >
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 pt-0.5">{step}</span>
        </li>
      ))}
    </ol>
  );
}

function FormulaCard({
  label,
  tex,
  explanation,
}: {
  label: string;
  tex: string;
  explanation: string;
}) {
  return (
    <figure className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
      <figcaption className="flex items-start justify-between gap-2">
        <span className="font-semibold text-slate-900">{label}</span>
        <CopyTexButton tex={tex} />
      </figcaption>
      <div className="my-2 overflow-x-auto rounded-md border border-slate-200 bg-white px-3 py-3 text-center">
        <TeX block>{tex}</TeX>
      </div>
      <p className="text-slate-600">{explanation}</p>
    </figure>
  );
}

/** TeX ソースをそのままクリップボードへ。数式を他所へ写すときの手打ちを省く。 */
function CopyTexButton({ tex }: { tex: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(tex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // クリップボードが使えない環境(非セキュアコンテキスト等)では黙って何もしない。
    }
  }, [tex]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label="TeXソースをコピー"
      className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-800"
    >
      {copied ? (
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
          <path d="M4 12.5l5 5L20 6.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M15 5H6a2 2 0 0 0-2 2v9" strokeLinecap="round" />
        </svg>
      )}
      {copied ? "コピー済" : "TeX"}
    </button>
  );
}

const SIGNAL_TONES = {
  reading: {
    wrap: "border-sky-100 bg-sky-50/60",
    heading: "text-sky-900",
    icon: "text-sky-500",
    dot: "bg-sky-400",
  },
  use: {
    wrap: "border-emerald-100 bg-emerald-50/60",
    heading: "text-emerald-900",
    icon: "text-emerald-500",
    dot: "bg-emerald-400",
  },
  warning: {
    wrap: "border-amber-200 bg-amber-50/70",
    heading: "text-amber-900",
    icon: "text-amber-500",
    dot: "bg-amber-400",
  },
} as const;

/** 読み方=青 / 活用=緑 / 注意=琥珀。役割を色で分け、走り読みでも取り違えないようにする。 */
function SignalList({
  heading,
  items,
  tone,
}: {
  heading: string;
  items: readonly string[];
  tone: keyof typeof SIGNAL_TONES;
}) {
  const t = SIGNAL_TONES[tone];
  return (
    <section className={`rounded-lg border p-3 ${t.wrap}`}>
      <h5 className={`mb-1.5 flex items-center gap-1.5 font-semibold ${t.heading}`}>
        <span aria-hidden="true" className={t.icon}>
          {tone === "reading" ? <EyeGlyph /> : tone === "use" ? <TargetGlyph /> : <AlertGlyph />}
        </span>
        {heading}
      </h5>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span aria-hidden="true" className={`mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} />
            <span className="min-w-0 flex-1">{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------- 分野アイコンと色調 */

interface CategoryStyle {
  /** ヘッダー背景のグラデーション。 */
  header: string;
  /** アイコン枠。 */
  glyph: string;
  /** 分野バッジ。 */
  chip: string;
  /** 手順フロー図の番号バッジ。 */
  step: string;
}

const CATEGORY_STYLES: Record<string, CategoryStyle> = {
  基本分析: tone("blue"),
  テクニカル: tone("indigo"),
  OHLC分析: tone("cyan"),
  リスク分析: tone("rose"),
  ボラティリティ: tone("amber"),
  "分布・依存性": tone("violet"),
  フラクタル分析: tone("teal"),
  情報理論: tone("sky"),
  行動ファイナンス: tone("fuchsia"),
  カレンダー分析: tone("emerald"),
  頑健性検証: tone("slate"),
};

// Tailwind は class 文字列を静的に走査するため、色名から動的生成せず全パターンを書き出す。
function tone(name: string): CategoryStyle {
  const map: Record<string, CategoryStyle> = {
    blue: {
      header: "from-blue-50 via-white to-white",
      glyph: "border-blue-100 bg-blue-50 text-blue-600",
      chip: "bg-blue-100 text-blue-800",
      step: "border-blue-200 bg-blue-50 text-blue-700",
    },
    indigo: {
      header: "from-indigo-50 via-white to-white",
      glyph: "border-indigo-100 bg-indigo-50 text-indigo-600",
      chip: "bg-indigo-100 text-indigo-800",
      step: "border-indigo-200 bg-indigo-50 text-indigo-700",
    },
    cyan: {
      header: "from-cyan-50 via-white to-white",
      glyph: "border-cyan-100 bg-cyan-50 text-cyan-600",
      chip: "bg-cyan-100 text-cyan-800",
      step: "border-cyan-200 bg-cyan-50 text-cyan-700",
    },
    rose: {
      header: "from-rose-50 via-white to-white",
      glyph: "border-rose-100 bg-rose-50 text-rose-600",
      chip: "bg-rose-100 text-rose-800",
      step: "border-rose-200 bg-rose-50 text-rose-700",
    },
    amber: {
      header: "from-amber-50 via-white to-white",
      glyph: "border-amber-100 bg-amber-50 text-amber-600",
      chip: "bg-amber-100 text-amber-900",
      step: "border-amber-200 bg-amber-50 text-amber-800",
    },
    violet: {
      header: "from-violet-50 via-white to-white",
      glyph: "border-violet-100 bg-violet-50 text-violet-600",
      chip: "bg-violet-100 text-violet-800",
      step: "border-violet-200 bg-violet-50 text-violet-700",
    },
    teal: {
      header: "from-teal-50 via-white to-white",
      glyph: "border-teal-100 bg-teal-50 text-teal-600",
      chip: "bg-teal-100 text-teal-800",
      step: "border-teal-200 bg-teal-50 text-teal-700",
    },
    sky: {
      header: "from-sky-50 via-white to-white",
      glyph: "border-sky-100 bg-sky-50 text-sky-600",
      chip: "bg-sky-100 text-sky-800",
      step: "border-sky-200 bg-sky-50 text-sky-700",
    },
    fuchsia: {
      header: "from-fuchsia-50 via-white to-white",
      glyph: "border-fuchsia-100 bg-fuchsia-50 text-fuchsia-600",
      chip: "bg-fuchsia-100 text-fuchsia-800",
      step: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700",
    },
    emerald: {
      header: "from-emerald-50 via-white to-white",
      glyph: "border-emerald-100 bg-emerald-50 text-emerald-600",
      chip: "bg-emerald-100 text-emerald-800",
      step: "border-emerald-200 bg-emerald-50 text-emerald-700",
    },
    slate: {
      header: "from-slate-100 via-white to-white",
      glyph: "border-slate-200 bg-slate-100 text-slate-600",
      chip: "bg-slate-200 text-slate-800",
      step: "border-slate-300 bg-slate-100 text-slate-700",
    },
  };
  return map[name];
}

function categoryStyle(category: string): CategoryStyle {
  return CATEGORY_STYLES[category] ?? tone("slate");
}

/** 分野ごとの線画グリフ。未知の分野は汎用の折れ線に落とす。 */
function CategoryIcon({ category }: { category: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {categoryPath(category)}
    </svg>
  );
}

function categoryPath(category: string) {
  switch (category) {
    case "基本分析": // 右肩上がりの折れ線
      return (
        <>
          <path d="M3 19h18" />
          <path d="M4 15l5-5 4 4 7-8" />
          <path d="M20 6h-4M20 6v4" />
        </>
      );
    case "テクニカル": // 棒 + シグナル線
      return (
        <>
          <path d="M4 20V11M9 20V6M14 20v-6M19 20V9" />
          <path d="M3 8l5-3 5 5 6-4" strokeDasharray="2 2" />
        </>
      );
    case "OHLC分析": // ローソク足
      return (
        <>
          <path d="M7 4v3M7 17v3M17 3v4M17 16v5" />
          <rect x="4.5" y="7" width="5" height="10" rx="1" />
          <rect x="14.5" y="7" width="5" height="9" rx="1" />
        </>
      );
    case "リスク分析": // 盾
      return (
        <>
          <path d="M12 3l7 3v5.5c0 4.3-2.9 7.8-7 8.5-4.1-.7-7-4.2-7-8.5V6z" />
          <path d="M12 9v4" />
          <path d="M12 16h.01" />
        </>
      );
    case "ボラティリティ": // 荒い波形
      return (
        <>
          <path d="M2 12h3l2.5-7 3 14 3-10 2.5 6 2-3h4" />
        </>
      );
    case "分布・依存性": // 釣鐘曲線 + 基線
      return (
        <>
          <path d="M2 18c4.5 0 4-11 10-11s5.5 11 10 11" />
          <path d="M2 21h20" />
          <path d="M12 7v14" strokeDasharray="2 2" />
        </>
      );
    case "フラクタル分析": // 入れ子の四角
      return (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <rect x="7" y="7" width="10" height="10" rx="1.5" />
          <rect x="10.5" y="10.5" width="3" height="3" rx="0.5" />
        </>
      );
    case "情報理論": // 発信する信号
      return (
        <>
          <circle cx="12" cy="12" r="2" />
          <path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6" />
          <path d="M5.4 5.4a9.4 9.4 0 0 0 0 13.2M18.6 5.4a9.4 9.4 0 0 1 0 13.2" />
        </>
      );
    case "行動ファイナンス": // 人物
      return (
        <>
          <circle cx="12" cy="8" r="3.4" />
          <path d="M5 20v-.6a7 7 0 0 1 14 0v.6" />
        </>
      );
    case "カレンダー分析": // 暦
      return (
        <>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" />
          <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
        </>
      );
    case "頑健性検証": // 検証済みバッジ
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M8 12.5l2.6 2.6L16 9.7" />
        </>
      );
    default:
      return (
        <>
          <path d="M3 19h18" />
          <path d="M4 14l5-5 4 4 7-7" />
        </>
      );
  }
}

/* ------------------------------------------------------ 見出し用グリフ */

function glyph(children: React.ReactNode) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const StepsGlyph = () =>
  glyph(
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <path d="M6 8.5v7M11 6h9M11 18h9" />
    </>
  );

const BulbGlyph = () =>
  glyph(
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5.9 1.2.9 1.9v.2h5.2v-.2c0-.7.3-1.4.9-1.9A6 6 0 0 0 12 3z" />
    </>
  );

const SigmaGlyph = () =>
  glyph(
    <>
      <path d="M17 5H7l6 7-6 7h10" />
    </>
  );

const BookGlyph = () =>
  glyph(
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
      <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5" />
    </>
  );

const EyeGlyph = () =>
  glyph(
    <>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  );

const TargetGlyph = () =>
  glyph(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.6" />
    </>
  );

const AlertGlyph = () =>
  glyph(
    <>
      <path d="M12 4.2 2.8 19.2h18.4z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  );
