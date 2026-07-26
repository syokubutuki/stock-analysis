import { MetadataRoute } from "next";

// 公開URLは stock-analysis.vercel.app と stock-analysis-self.vercel.app の
// 2つのエイリアスが両方200を返す。sitemap・Search Console 登録・canonical は
// 下記 BASE に一本化して重複コンテンツ扱いを避ける。
const BASE = "https://stock-analysis.vercel.app";

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
