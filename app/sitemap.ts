import { MetadataRoute } from "next";

// 本プロジェクトの公開ドメインは stock-analysis-self.vercel.app のみ。
// stock-analysis.vercel.app は別アカウントの無関係なサイト（stock-analysis-ui）が
// 使用しており、当方の所有ではない。sitemap・canonical・Search Console の
// プロパティはすべて下記 BASE に揃える。
const BASE = "https://stock-analysis-self.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: BASE, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE}/axioms`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/portfolio`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE}/strategy`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE}/feedback`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
}
