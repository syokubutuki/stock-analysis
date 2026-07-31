import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "新ドメインへのデータ引き継ぎ | 株価構造分析",
  robots: { index: false, follow: false },
  alternates: { canonical: "/domain-migration" },
};

export default function DomainMigrationLayout({ children }: { children: React.ReactNode }) {
  return children;
}
