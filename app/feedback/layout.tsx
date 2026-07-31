import type { Metadata } from "next";

export const metadata: Metadata = { alternates: { canonical: "/feedback" } };

export default function FeedbackLayout({ children }: { children: React.ReactNode }) {
  return children;
}
