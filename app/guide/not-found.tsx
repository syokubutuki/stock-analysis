import Link from "next/link";

export default function GuideNotFound() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-20 text-center">
      <p className="text-sm font-semibold text-blue-700">404</p>
      <h1 className="mt-2 text-3xl font-bold text-slate-900">分析ガイドが見つかりません</h1>
      <p className="mt-4 text-slate-600">URLが変更されたか、まだ公開されていない分析です。</p>
      <Link href="/guide" className="mt-8 inline-flex rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">
        分析ガイド一覧へ戻る
      </Link>
    </main>
  );
}
