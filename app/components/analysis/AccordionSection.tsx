"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import CollapsibleAnalysis, { type PanelResultSummary } from "./CollapsibleAnalysis";
import LockedPanel from "./LockedPanel";
import { canViewPanel } from "../../lib/tiers";
import { useEntitlement } from "../../lib/entitlement";

/**
 * パネルごとの要約の置き場。
 *
 * Context の値に Map をそのまま載せると、**要約が1件届くたびに Context が変わり
 * すべての `CollapsibleAnalysis` が浅く再描画される**（FU35）。7パネルでは無害だが、
 * 300パネルへ横展開すると1回の計算完了ごとに全件の再描画が走る。
 * 購読をパネル単位に分け、要約が変わったパネルだけを起こすためにこの store がある。
 *
 * 中身は Context の値の外（この store のインスタンス）に持つので、
 * **Context の値は scope が変わるときしか変化しない**。
 */
class PanelSummaryStore {
  private entries = new Map<string, { scope: string; summary: PanelResultSummary }>();
  private subscribers = new Map<string, Set<() => void>>();

  /**
   * 要約は**記録した scope とセットで持つ**。scope（銘柄・期間・最終足）が変われば
   * 古い要約は読めなくなるので、まとめて捨てる操作が要らない。
   * 捨てる操作を持つとレンダー中かエフェクト中のどちらかで呼ぶことになり、
   * 前者は純粋でなく、後者は子のエフェクト（＝新しい scope での報告）より後に走って
   * **報告されたばかりの要約を消してしまう**。持たないのが一番安全である。
   */
  read = (itemId: string, scope: string): PanelResultSummary | undefined => {
    const entry = this.entries.get(itemId);
    return entry && entry.scope === scope ? entry.summary : undefined;
  };

  subscribe = (itemId: string, onChange: () => void) => {
    let set = this.subscribers.get(itemId);
    if (!set) {
      set = new Set();
      this.subscribers.set(itemId, set);
    }
    const target = set;
    target.add(onChange);
    return () => {
      target.delete(onChange);
      if (target.size === 0) this.subscribers.delete(itemId);
    };
  };

  report = (itemId: string, scope: string, summary: PanelResultSummary) => {
    const previous = this.entries.get(itemId);
    if (previous && previous.scope === scope && sameSummary(previous.summary, summary)) return;
    this.entries.set(itemId, { scope, summary });
    this.subscribers.get(itemId)?.forEach((onChange) => onChange());
  };
}

function sameSummary(a: PanelResultSummary, b: PanelResultSummary): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "none" || b.status === "none") return true;
  return a.direction === b.direction && a.label === b.label;
}

interface AnalysisAvailability {
  unavailableItemIds: ReadonlySet<string>;
  cautionItemIds: ReadonlySet<string>;
  /** バッジの寿命（銘柄＋期間＋最終足）。表示中の数字が古くないかを決める */
  summaryScope?: string;
  /** 一括開放の寿命（銘柄＋期間）。利用者の操作がどこまで有効かを決める → FU41 */
  openScope?: string;
  summaryStore: PanelSummaryStore;
  reportResultSummary: (itemId: string, summary: PanelResultSummary) => void;
}

const EMPTY_ITEM_IDS = new Set<string>();
const DEFAULT_AVAILABILITY: AnalysisAvailability = {
  unavailableItemIds: EMPTY_ITEM_IDS,
  cautionItemIds: EMPTY_ITEM_IDS,
  summaryScope: undefined,
  openScope: undefined,
  summaryStore: new PanelSummaryStore(),
  reportResultSummary: () => {},
};
const AnalysisAvailabilityContext = createContext<AnalysisAvailability>(DEFAULT_AVAILABILITY);

interface AnalysisAvailabilityProviderProps {
  active: boolean;
  unavailableItemIds: ReadonlySet<string>;
  cautionItemIds: ReadonlySet<string>;
  summaryScope: string;
  openScope: string;
  children: ReactNode;
}

export function AnalysisAvailabilityProvider({
  active,
  unavailableItemIds,
  cautionItemIds,
  summaryScope,
  openScope,
  children,
}: AnalysisAvailabilityProviderProps) {
  // store 自体は生涯1つ。state に持つのは、ref をレンダー中に読まないためである。
  const [summaryStore] = useState(() => new PanelSummaryStore());

  // **識別子が summaryScope に紐づいているのは意図的である。**
  // `useAnalysisResultSummary` の effect はこの関数を依存に持つので、scope が変わると
  // 必ず再実行され、新しい scope での要約がその場で報告し直される。scope をまたいで
  // 同じ判断になるパネル（`売られすぎ` → `売られすぎ`）でもバッジが消えないのは
  // これが理由。安定化させると、そのケースだけ静かにバッジが出なくなる。
  const reportResultSummary = useCallback(
    (itemId: string, summary: PanelResultSummary) => {
      summaryStore.report(itemId, summaryScope, summary);
    },
    [summaryStore, summaryScope],
  );

  const value = useMemo(
    () => ({
      unavailableItemIds: active ? unavailableItemIds : EMPTY_ITEM_IDS,
      cautionItemIds: active ? cautionItemIds : EMPTY_ITEM_IDS,
      summaryScope,
      openScope,
      summaryStore,
      reportResultSummary,
    }),
    [
      active,
      unavailableItemIds,
      cautionItemIds,
      summaryScope,
      openScope,
      summaryStore,
      reportResultSummary,
    ],
  );
  return (
    <AnalysisAvailabilityContext.Provider value={value}>
      {children}
    </AnalysisAvailabilityContext.Provider>
  );
}

/**
 * パネル本体が既存計算から得た要約を、閉じた後も見出しに残す。
 * 本体がマウントされる前には呼ばれないため、事前計算は発生しない。
 *
 * 第1引数のIDは `app/lib/panel-registry.tsx` のレコードと一致していなければ
 * ならない。ずれるとバッジが**無言で出なくなる**ので、
 * `app/lib/__tests__/page-wiring.test.ts` が突き合わせている（FU33）。
 */
export function useAnalysisResultSummary(itemId: string, summary: PanelResultSummary) {
  const { reportResultSummary } = useContext(AnalysisAvailabilityContext);
  const status = summary.status;
  const direction = summary.status === "finding" ? summary.direction : null;
  const label = summary.status === "finding" ? summary.label : null;
  useEffect(() => {
    reportResultSummary(
      itemId,
      status === "finding" && direction !== null && label !== null
        ? { status: "finding", direction, label }
        : { status: "none" },
    );
  }, [itemId, reportResultSummary, status, direction, label]);
}

/** 自分のIDぶんだけを購読する。他パネルの要約が届いても再描画されない（FU35）。 */
function usePanelSummary(itemId: string): PanelResultSummary | undefined {
  const { summaryStore, summaryScope } = useContext(AnalysisAvailabilityContext);
  const scope = summaryScope ?? "";
  const subscribe = useCallback(
    (onChange: () => void) => summaryStore.subscribe(itemId, onChange),
    [summaryStore, itemId],
  );
  const read = useCallback(
    () => summaryStore.read(itemId, scope),
    [summaryStore, itemId, scope],
  );
  return useSyncExternalStore(subscribe, read, read);
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
 * パネル1件ぶん。**自分の要約だけを購読するために独立したコンポーネントにしてある**
 * （FU35）。ここを `AccordionSection` にインライン展開すると、1件の要約が届くたびに
 * 全パネルが再描画される状態へ戻る。
 */
function AccordionPanel({
  item,
  bulk,
}: {
  item: AccordionItem;
  bulk: { nonce: number; open: boolean };
}) {
  const availability = useContext(AnalysisAvailabilityContext);
  const summary = usePanelSummary(item.id);
  const unavailable = availability.unavailableItemIds.has(item.id);
  const caution = availability.cautionItemIds.has(item.id);

  if (unavailable) {
    // 非対応がバッジに優先する。本体をマウントしないので要約もそもそも生成されない。
    return (
      <CollapsibleAnalysis
        id={item.id}
        title={item.title}
        subtitle={item.subtitle}
        bulk={bulk}
        openScope={availability.openScope}
      >
        <AnalysisDataLimitation unavailable />
      </CollapsibleAnalysis>
    );
  }
  return (
    <CollapsibleAnalysis
      id={item.id}
      title={item.title}
      subtitle={item.subtitle}
      bulk={bulk}
      openScope={availability.openScope}
      summary={summary}
    >
      {caution ? <AnalysisDataLimitation unavailable={false} /> : null}
      {item.node}
    </CollapsibleAnalysis>
  );
}

/**
 * 分析セクションを折りたたみパネルのリストとして描画する共通コンポーネント。
 * すべて開く/閉じる・件数表示のツールバー付き。
 *
 * 全パネルがここを通るため、無料/有料のゲートもここ1箇所で行う。
 * パネルの定義は `app/lib/panel-registry.tsx`、有料境界の定義は `app/lib/tiers.ts`。
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
          {g.items.map((it) =>
            availability.unavailableItemIds.has(it.id) || canViewPanel(it.id, tier) ? (
              <AccordionPanel key={it.id} item={it} bulk={bulk} />
            ) : (
              // ロック時は it.node を描画しない。計算も走らせず DOM にも出さない。
              <LockedPanel key={it.id} id={it.id} title={it.title} subtitle={it.subtitle} />
            ),
          )}
        </div>
      ))}
    </>
  );
}
