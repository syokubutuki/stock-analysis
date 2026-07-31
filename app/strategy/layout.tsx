import type { Metadata } from "next";

export const metadata: Metadata = { alternates: { canonical: "/strategy" } };

export default function StrategyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
