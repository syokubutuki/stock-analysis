import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
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
      <body>{children}</body>
    </html>
  );
}
