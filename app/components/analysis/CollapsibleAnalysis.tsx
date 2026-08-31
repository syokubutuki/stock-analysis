"use client";

import { useEffect, useRef, useState } from "react";
import { track } from "@vercel/analytics";
import { OPEN_PANEL_EVENT, type OpenPanelDetail } from "../../lib/panel-nav";
import {
  DIRECTION_GLYPH,
  DIRECTION_LABEL,
  DIRECTION_TEXT_CLASS,
} from "../../lib/chart-colors";

/**
 * 一度開いて計算済みのパネルが見出しに残す短い所見。
 *
 * **バッジは「判断」だけを出す。「量」は出さない**（FU34）。
 * 移設前は `売られすぎ`（判断）と `標本 231件`（計算できた量）が同じ見た目で
 * 混在しており、利用者にはどちらも同じ強さの手がかりに見えていた。
 * `finding` に `up` / `down` を必須にすることで、方向を持たない量を
 * バッジに載せる書き方そのものを型で塞いでいる。量はパネルを開いた中で示すこと。
 */
export type PanelResultSummary =
  | { status: "finding"; direction: "up" | "down"; label: string }
  | { status: "none" };

interface Props {
  /** localStorage 永続化・アンカー用の安定ID（銘柄に依存しない） */
  id: string;
  /** 常時表示する見出し */
  title: string;
  /** 見出し下の補足（任意） */
  subtitle?: string;
  /** 初期状態（省略時は閉じる） */
  defaultOpen?: boolean;
  /**
   * 親からの一括開閉命令。nonce が変わるたびに open の値へ強制的に揃える。
   * 「すべて開く / すべて閉じる」に使う。
   */
  bulk?: { nonce: number; open: boolean };
  /**
   * 一括開放の寿命を決める鍵（銘柄＋期間）。値が変わると、保存済みの個別開閉だけを
   * 残して一括開放ぶんを捨てる（U2）。省略すると寿命の管理をしない。
   */
  openScope?: string;
  /** 一度開いて計算済みのパネルだけが提供する短い所見。未計算なら表示しない。 */
  summary?: PanelResultSummary;
  children: React.ReactNode;
}

const storageKey = (id: string) => `sa:open:${id}`;

/** 保存済みの開閉状態。読めなければ既定値。 */
function persistedOpen(id: string, defaultOpen: boolean): boolean {
  try {
    const saved = localStorage.getItem(storageKey(id));
    if (saved === "1") return true;
    if (saved === "0") return false;
  } catch {
    // localStorage 利用不可時は既定値
  }
  return defaultOpen;
}

function updatePanelQuery(id: string, open: boolean) {
  const url = new URL(window.location.href);
  if (open) {
    url.searchParams.set("panel", id);
  } else if (url.searchParams.get("panel") === id) {
    url.searchParams.delete("panel");
  } else {
    return;
  }
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

/**
 * 分析ひとつを折りたたみ可能なパネルで包む。
 * - タイトルは常時表示、中身は開いたときだけマウントする（閉じると
 *   アンマウントして重い日中足 fetch / Web Worker 計算を止める）。
 * - 開閉状態は「分析ID」で localStorage に保存する。銘柄コードに紐づけない
 *   ので、別銘柄を再検索しても「開いている分析の集合」はそのまま維持され、
 *   中身だけ新しい銘柄で再計算される。
 */
export default function CollapsibleAnalysis({
  id,
  title,
  subtitle,
  defaultOpen = false,
  bulk,
  openScope,
  summary,
  children,
}: Props) {
  // 保存済み開閉状態を復元する。この節はデータ取得後にのみクライアント描画され
  // SSRされないため、遅延初期化で localStorage を直接読んでよい（初期フラッシュ無し）。
  const [open, setOpen] = useState(() => persistedOpen(id, defaultOpen));

  // 親からの一括開閉命令に追従する。マウント時点の nonce を初期値にしておき、
  // 初回レンダリングでは発火させない（localStorage 復元を上書きしないため）。
  // 「すべて開く」は重い全パネル計算を伴うため、現在の openScope 内だけの一時状態にする。
  // 個別開閉は利用者が選んだ分析集合なので従来どおり銘柄をまたいで永続化する一方、
  // 一括開放は localStorage に書かない。
  const lastBulkNonce = useRef<number | null>(bulk ? bulk.nonce : null);
  useEffect(() => {
    if (!bulk) return;
    if (lastBulkNonce.current === bulk.nonce) return;
    lastBulkNonce.current = bulk.nonce;
    setOpen(bulk.open);
    if (!bulk.open) {
      try {
        localStorage.setItem(storageKey(id), "0");
      } catch {}
    }
  }, [bulk, id]);

  // 一括開放の寿命。銘柄・期間が変わったら保存済みの個別開閉だけに戻す。
  //
  // 以前はこれを親（AccordionSection）の React key に S15 の summaryScope を混ぜて
  // 実現していたが、summaryScope は**最終足の時刻と終値を含む**ため、データが後から
  // 確定しただけで全パネルが再マウントされていた（「すべて開く」の直後に全部閉じる
  // 現象の正体）。バッジの寿命（＝表示中の数字が古くないか）と一括開放の寿命
  // （＝利用者の操作がどこまで有効か）は別物なので、鍵も別にしてある → FU41。
  //
  // **エフェクトではなくレンダー中に倒すこと**（FU42）。エフェクトで閉じると、
  // 閉じる前に一度だけ「開いたまま新しいデータで」children が描画される。
  // 再マウントが無くなったぶん、この1回が丸ごと無駄な計算になり、56件を
  // 一括開放した節で期間を変えると**メインスレッドが 10.5 秒固まった**
  // （main の再マウント方式では 1.5 秒。両方を本番ビルドで実測）。
  // レンダー中の setState は React が子を描く前に同じコンポーネントを描き直すので、
  // 捨てる結果を計算しなくて済む。
  const [lastOpenScope, setLastOpenScope] = useState(openScope);
  if (lastOpenScope !== openScope) {
    setLastOpenScope(openScope);
    setOpen(persistedOpen(id, defaultOpen));
  }

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey(id), next ? "1" : "0");
      } catch {}
      updatePanelQuery(id, next);
      if (next) track("panel_open", { panel: id });
      return next;
    });
  };

  // 他コンポーネントからの「この分析を開いて」という命令に追従する。
  // 中身をマウントしてからスクロールするため次フレームまで待つ。
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenPanelDetail>).detail;
      if (!detail || detail.id !== id) return;
      setOpen(true);
      try {
        localStorage.setItem(storageKey(id), "1");
      } catch {}
      updatePanelQuery(id, true);
      track("panel_open", { panel: id });
      requestAnimationFrame(() =>
        sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    };
    window.addEventListener(OPEN_PANEL_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(OPEN_PANEL_EVENT, onOpen as EventListener);
  }, [id]);

  const direction = summary?.status === "finding" ? summary.direction : "flat";

  return (
    <section
      ref={sectionRef}
      id={`panel-${id}`}
      className="bg-white rounded-lg border border-gray-200 overflow-hidden scroll-mt-36"
    >
      <button
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        <span
          className="inline-block text-gray-500 transition-transform duration-200 shrink-0"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-gray-800 truncate">
            {title}
          </span>
          {subtitle && (
            <span className="block text-xs text-fg-muted truncate">
              {subtitle}
            </span>
          )}
        </span>
        {summary && (
          <span
            className={`shrink-0 rounded-full border border-current px-2 py-0.5 text-[11px] font-medium ${DIRECTION_TEXT_CLASS[direction]}`}
            aria-label={
              summary.status === "finding"
                ? `所見あり: ${summary.label}（${DIRECTION_LABEL[direction]}）`
                : "所見なし"
            }
          >
            <span aria-hidden="true">{DIRECTION_GLYPH[direction]}</span>{" "}
            {summary.status === "finding" ? summary.label : "所見なし"}
          </span>
        )}
      </button>
      {open && <div className="px-4 pb-4 border-t border-gray-100 pt-4">{children}</div>}
    </section>
  );
}
