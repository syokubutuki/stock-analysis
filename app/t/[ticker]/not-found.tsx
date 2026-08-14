import Link from "next/link";

export default function TickerNotFound() {
  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-20 text-center">
      <p className="text-sm font-semibold text-blue-700">404</p>
      <h1 className="mt-2 text-3xl font-bold text-slate-900">銘柄ページが見つかりません</h1>
      <p className="mt-4 leading-7 text-slate-600">
        URLの銘柄コードが正しくないか、この銘柄はまだ個別ページの公開対象ではありません。
      </p>
      <Link href="/" className="mt-8 inline-flex rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">
        銘柄を検索する
      </Link>
    </main>
  );
}
