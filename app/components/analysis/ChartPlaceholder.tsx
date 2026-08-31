/**
 * 動的読み込み中のパネル本体の代わりに置く箱。
 *
 * 高さをパネルごとに指定するのは、読み込み完了時にチャートが入ってページが
 * 飛び跳ねるのを防ぐため（レイアウトシフト）。値は `app/lib/panel-registry.tsx`
 * の各レコードが持つ。
 */
export default function ChartPlaceholder({ height }: { height: number }) {
  return (
    <div
      className="w-full bg-gray-50 rounded-lg border border-gray-200 flex items-center justify-center text-gray-500"
      style={{ height }}
    >
      読み込み中...
    </div>
  );
}
