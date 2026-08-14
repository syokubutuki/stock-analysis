"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import CollapsibleAnalysis from "./CollapsibleAnalysis";
import LockedPanel from "./LockedPanel";
import { canViewPanel } from "../../lib/tiers";
import { useEntitlement } from "../../lib/entitlement";

interface AnalysisAvailability {
  unavailableItemIds: ReadonlySet<string>;
  cautionItemIds: ReadonlySet<string>;
}

const EMPTY_ITEM_IDS = new Set<string>();
const DEFAULT_AVAILABILITY: AnalysisAvailability = {
  unavailableItemIds: EMPTY_ITEM_IDS,
  cautionItemIds: EMPTY_ITEM_IDS,
};
const AnalysisAvailabilityContext = createContext<AnalysisAvailability>(DEFAULT_AVAILABILITY);

interface AnalysisAvailabilityProviderProps extends AnalysisAvailability {
  active: boolean;
  children: ReactNode;
}

export function AnalysisAvailabilityProvider({
  active,
  unavailableItemIds,
  cautionItemIds,
  children,
}: AnalysisAvailabilityProviderProps) {
  const value = useMemo(
    () => active ? { unavailableItemIds, cautionItemIds } : DEFAULT_AVAILABILITY,
    [active, unavailableItemIds, cautionItemIds],
  );
  return (
    <AnalysisAvailabilityContext.Provider value={value}>
      {children}
    </AnalysisAvailabilityContext.Provider>
  );
}

function AnalysisDataLimitation({ unavailable }: { unavailable: boolean }) {
  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      role="note"
    >
      {unavailable
        ? "このデータは始値・高値・安値が基準価額と同一で、出来高も0です。この分析に必要な市場内の値動きや売買量を観測できないため、結果を表示しません。終値ベースの分析を利用してください。"
        : "このデータでは市場内のOHLC内訳と出来高を観測できません。このパネル内の出来高・日中／夜間・ギャップ関連の結果は解釈せず、終値ベースの結果だけを参照してください。"}
    </div>
  );
}

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
  bulk: { nonce: number; open: boolean };
  onBulk: (open: boolean) => void;
}

/**
 * 分析セクションを折りたたみパネルのリストとして描画する共通コンポーネント。
 * すべて開く/閉じる・件数表示のツールバー付き。
 *
 * 全パネル（244件）がここを通るため、無料/有料のゲートもここ1箇所で行う。
 * page.tsx 側の呼び出しは変更不要。境界の定義は `app/lib/tiers.ts`。
 */
export default function AccordionSection({
  groups,
  bulk,
  onBulk,
}: Props) {
  const tier = useEntitlement();
  const availability = useContext(AnalysisAvailabilityContext);
  const filtered = groups.filter((g) => g.items.length > 0);
  const total = filtered.reduce((s, g) => s + g.items.length, 0);
  const locked = filtered.reduce(
    (s, g) => s + g.items.filter(
      (it) => !availability.unavailableItemIds.has(it.id) && !canViewPanel(it.id, tier),
    ).length,
    0
  );

  return (
    <>
      {/* ツールバー: 一括開閉 */}
      <div className="flex flex-wrap items-center gap-2 bg-white rounded-lg border border-gray-200 px-3 py-2">
        <span className="text-xs text-fg-muted mr-auto">
          {total}件
          {locked > 0 && (
            <span className="ml-2 text-amber-600">（うち {locked} 件は Pro）</span>
          )}
        </span>
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
          {g.items.map((it) => {
            const unavailable = availability.unavailableItemIds.has(it.id);
            const caution = availability.cautionItemIds.has(it.id);
            if (unavailable) {
              return (
                <CollapsibleAnalysis
                  key={it.id}
                  id={it.id}
                  title={it.title}
                  subtitle={it.subtitle}
                  bulk={bulk}
                >
                  <AnalysisDataLimitation unavailable />
                </CollapsibleAnalysis>
              );
            }
            return canViewPanel(it.id, tier) ? (
              <CollapsibleAnalysis
                key={it.id}
                id={it.id}
                title={it.title}
                subtitle={it.subtitle}
                bulk={bulk}
              >
                {caution ? <AnalysisDataLimitation unavailable={false} /> : null}
                {it.node}
              </CollapsibleAnalysis>
            ) : (
              // ロック時は it.node を描画しない。計算も走らせず DOM にも出さない。
              <LockedPanel key={it.id} id={it.id} title={it.title} subtitle={it.subtitle} />
            );
          })}
        </div>
      ))}
    </>
  );
}
