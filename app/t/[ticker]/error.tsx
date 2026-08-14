"use client";

export default function TickerError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-20 text-center">
      <p className="text-sm font-semibold text-amber-700">表示中にエラーが発生しました</p>
      <h1 className="mt-2 text-3xl font-bold text-slate-900">銘柄サマリーを表示できません</h1>
      <p className="mt-4 leading-7 text-slate-600">
        一時的なデータ取得エラーの可能性があります。時間をおいて、もう一度お試しください。
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-8 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
      >
        再試行
      </button>
    </main>
  );
}
