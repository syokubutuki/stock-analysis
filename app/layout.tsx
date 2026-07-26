import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  // 当プロジェクトの公開ドメインは stock-analysis-self.vercel.app のみ。
  // stock-analysis.vercel.app は別アカウントの無関係なサイトなので使用しない。
  // sitemap.ts の BASE と必ず一致させること（食い違うとサイトマップが対象範囲外で弾かれる）。
  metadataBase: new URL("https://stock-analysis-self.vercel.app"),
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
  },
  twitter: {
    card: "summary",
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
        {children}
        <Analytics />
      </body>
    </html>
  );
}
