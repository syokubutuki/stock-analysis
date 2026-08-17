import type { NextConfig } from "next";
import { LEGACY_HOST } from "./app/lib/site-url";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: LEGACY_HOST }],
        headers: [{ key: "X-Robots-Tag", value: "noindex, follow" }],
      },
      // 銘柄ページのHTMLを Vercel CDN に載せる。`/api/stock` と同じ手口で、
      // `Vercel-CDN-Cache-Control` は CDN 専用ヘッダなのでクライアントには渡らず、
      // Next がページに付ける `Cache-Control` とも衝突しない。
      //
      // **検証済みSEOクローラはこのキャッシュを BYPASS する**（`cacheReason: crawler`）。
      // つまりこれはクローラ対策ではなく、人間の再訪・SNS展開・プレビュー取得に効く。
      // クローラの初回応答を支えるのは getStockData の Runtime Cache（fresh 8時間）で、
      // そちらは取得を 10y に寄せてアプリ本体と共有させた（ticker-pages.ts の注記）。
      //
      // s-maxage が `/api/stock` の 3600 より短いのは、価格取得に失敗したときの
      // DataUnavailable（noindex, follow）も同じレスポンスとして載るため。長く焼かない。
      {
        // 1セグメントだけに一致する。`/t/:ticker/opengraph-image`（R3b）には当たらないので、
        // OG画像は自分のキャッシュ方針を別に決められる。
        source: "/t/:ticker",
        headers: [
          {
            key: "Vercel-CDN-Cache-Control",
            value: "public, s-maxage=900, stale-while-revalidate=86400",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
