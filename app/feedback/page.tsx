import type { Metadata } from "next";
import Link from "next/link";
import FeedbackForm from "../components/FeedbackForm";

export const metadata: Metadata = {
  title: "ご意見・ご要望 | 株価構造分析",
  description:
    "株価構造分析ツールへの機能改善案・ご要望・バグ報告を受け付けています。",
  robots: { index: false, follow: false },
};

export default function FeedbackPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-4">
        <div className="max-w-3xl mx-auto">
          <Link href="/" className="text-sm text-blue-600 hover:text-blue-700">
            ← 株価構造分析に戻る
          </Link>
          <h1 className="text-xl font-bold text-gray-900 mt-2">ご意見・ご要望</h1>
          <p className="text-sm text-gray-500 mt-1">
            機能改善案・追加してほしい分析・バグ報告などをお聞かせください。
          </p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6">
        <FeedbackForm />
      </main>

      <footer className="text-center text-xs text-gray-400 py-8">
        いただいたご意見は今後の機能改善の参考にさせていただきます。
      </footer>
    </div>
  );
}
