import type { Metadata } from "next";

export const metadata: Metadata = { alternates: { canonical: "/axioms" } };

export default function AxiomsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
