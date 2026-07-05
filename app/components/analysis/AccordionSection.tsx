"use client";

import CollapsibleAnalysis from "./CollapsibleAnalysis";

export interface AccordionItem {
  /** localStorage 永続化・アンカー用の安定ID（銘柄非依存）。Series Explorer の
   *  ジャンプ先アンカー(sa-*)に対応させる場合はその文字列を id に使う。 */
  id: string;
  title: string;
  subtitle?: string;
  node: React.ReactNode;
}

export interface AccordionGroup {
  /** グループ見出し（省略可） */
  group?: string;
  items: AccordionItem[];
}

interface Props {
  groups: AccordionGroup[];
  filter: string;
  onFilterChange: (v: string) => void;
  bulk: { nonce: number; open: boolean };
  onBulk: (open: boolean) => void;
}

/**
 * 分析セクションを折りたたみパネルのリストとして描画する共通コンポーネント。
 * タイトル絞り込み・すべて開く/閉じる・件数表示のツールバー付き。
 */
export default function AccordionSection({
  groups,
  filter,
  onFilterChange,
  bulk,
  onBulk,
}: Props) {
  const q = filter.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({
      ...g,
      items: q ? g.items.filter((it) => it.title.toLowerCase().includes(q)) : g.items,
    }))
    .filter((g) => g.items.length > 0);
  const total = filtered.reduce((s, g) => s + g.items.length, 0);

  return (
    <>
      {/* ツールバー: 絞り込み + 一括開閉 */}
      <div className="flex flex-wrap items-center gap-2 bg-white rounded-lg border border-gray-200 px-3 py-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="分析名で絞り込み"
          className="flex-1 min-w-[180px] text-sm border border-gray-300 rounded px-2 py-1"
        />
        {filter && (
          <button
            onClick={() => onFilterChange("")}
            className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1"
          >
            クリア
          </button>
        )}
        <span className="text-xs text-gray-400">{total}件</span>
        <button
          onClick={() => onBulk(true)}
          className="text-xs text-blue-600 hover:bg-blue-50 border border-blue-200 rounded px-2 py-1"
        >
          すべて開く
        </button>
        <button
          onClick={() => onBulk(false)}
          className="text-xs text-gray-600 hover:bg-gray-100 border border-gray-300 rounded px-2 py-1"
        >
          すべて閉じる
        </button>
      </div>

      {filtered.map((g, gi) => (
        <div key={g.group ?? gi} className="space-y-2">
          {g.group && (
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide px-1">
              {g.group}
            </h3>
          )}
          {g.items.map((it) => (
            <CollapsibleAnalysis
              key={it.id}
              id={it.id}
              title={it.title}
              subtitle={it.subtitle}
              bulk={bulk}
            >
              {it.node}
            </CollapsibleAnalysis>
          ))}
        </div>
      ))}

      {total === 0 && (
        <div className="text-sm text-gray-400 py-8 text-center">
          「{filter}」に一致する分析はありません。
        </div>
      )}
    </>
  );
}
