import { MetadataRoute } from "next";
import { ANALYSIS_GUIDES } from "./lib/analysis-guides";
import { SITE_ORIGIN } from "./lib/site-url";
import { TICKER_PAGE_INSTRUMENTS } from "./lib/ticker-pages";

// 価格取得の可否を sitemap 生成時には検査しない。98銘柄の外部取得をビルドや
// リクエストへ追加すると、上流障害で sitemap 自体が不安定になり、生成も遅くなる。
// Runtime Cache の HIT だけに限定すると、温まり具合で掲載URLが増減するため採らない。
// 代わりにページ側と同じ TICKER_PAGE_INSTRUMENTS（既知の取得不能銘柄を除く手動台帳）を
// 唯一の公開集合とし、ticker-pages.test.ts が既知の除外と台帳の空洞化を固定する。

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const staticPages: MetadataRoute.Sitemap = [
    { url: SITE_ORIGIN, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_ORIGIN}/guide`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${SITE_ORIGIN}/axioms`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
  ];

  const guides: MetadataRoute.Sitemap = ANALYSIS_GUIDES.map((guide) => ({
    url: `${SITE_ORIGIN}/guide/${guide.slug}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.8,
  }));

  const tickerPages: MetadataRoute.Sitemap = TICKER_PAGE_INSTRUMENTS.map((instrument) => ({
    url: `${SITE_ORIGIN}/t/${instrument.ticker}`,
    lastModified: now,
    changeFrequency: "daily",
    priority: 0.8,
  }));

  return [...staticPages, ...guides, ...tickerPages];
}
