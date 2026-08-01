import { MetadataRoute } from "next";
import { ANALYSIS_GUIDES } from "./lib/analysis-guides";
import { SITE_ORIGIN } from "./lib/site-url";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const staticPages: MetadataRoute.Sitemap = [
    { url: SITE_ORIGIN, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_ORIGIN}/guide`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${SITE_ORIGIN}/axioms`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_ORIGIN}/portfolio`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_ORIGIN}/strategy`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
  ];

  const guides: MetadataRoute.Sitemap = ANALYSIS_GUIDES.map((guide) => ({
    url: `${SITE_ORIGIN}/guide/${guide.slug}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.8,
  }));

  return [...staticPages, ...guides];
}
