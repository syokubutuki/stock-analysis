import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import Disclaimer from "./components/Disclaimer";
import DomainMigrationNotice from "./components/DomainMigrationNotice";
import { SITE_ORIGIN } from "./lib/site-url";
import "./globals.css";

export const metadata: Metadata = {
  // 正規ドメインは kabugenron.com。stock-analysis-self.vercel.app は移行元としてのみ残す。
  // stock-analysis.vercel.app は別アカウントの無関係なサイトなので使用しない。
  // sitemap.ts と site-url.ts の SITE_ORIGIN を必ず一致させる。
  metadataBase: new URL(SITE_ORIGIN),
  alternates: { canonical: "/" },
  verification: {
    google: "ofoMx5OtnknPc6zhkrBc9iHZOWR69gj9HdjcPOf0B0o",
  },
  title: "株価構造分析 | 市場の隠れた構造をデータから抽出",
  description:
    "株価時系列の構造分析ツール。FFT・ウェーブレット・EMD・DFA・エントロピー・Recurrence Plotなど多角的な分析で市場の隠れた構造を可視化。",
  keywords: [
    "株価分析",
    "時系列分析",
    "構造分析",
    "ウェーブレット",
    "フラクタル",
    "DFA",
    "エントロピー",
    "リカレンスプロット",
    "FFT",
    "EMD",
  ],
  openGraph: {
    title: "株価構造分析 | 市場の隠れた構造をデータから抽出",
    description:
      "FFT・ウェーブレット・EMD・DFA・エントロピーなど多角的な手法で株価時系列の構造を可視化。",
    type: "website",
    locale: "ja_JP",
    url: SITE_ORIGIN,
  },
  twitter: {
    card: "summary_large_image",
    title: "株価構造分析",
    description:
      "市場の隠れた構造をデータから抽出する分析ツール。",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>
        <DomainMigrationNotice />
        {children}
        <Disclaimer />
        <Analytics />
      </body>
    </html>
  );
}
