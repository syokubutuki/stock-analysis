"use client";

import { useEffect, useRef, useState } from "react";

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
  children: React.ReactNode;
}

const storageKey = (id: string) => `sa:open:${id}`;

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
  children,
}: Props) {
  // 保存済み開閉状態を復元する。この節はデータ取得後にのみクライアント描画され
  // SSRされないため、遅延初期化で localStorage を直接読んでよい（初期フラッシュ無し）。
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey(id));
      if (saved === "1") return true;
      if (saved === "0") return false;
    } catch {
      // localStorage 利用不可時は既定値
    }
    return defaultOpen;
  });

  // 親からの一括開閉命令に追従する（初回nonceは無視する）
  const lastBulkNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!bulk) return;
    if (lastBulkNonce.current === bulk.nonce) return;
    lastBulkNonce.current = bulk.nonce;
    setOpen(bulk.open);
    try {
      localStorage.setItem(storageKey(id), bulk.open ? "1" : "0");
    } catch {}
  }, [bulk, id]);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey(id), next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  return (
    <section
      id={`panel-${id}`}
      className="bg-white rounded-lg border border-gray-200 overflow-hidden scroll-mt-24"
    >
      <button
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        <span
          className="inline-block text-gray-400 transition-transform duration-200 shrink-0"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-gray-800 truncate">
            {title}
          </span>
          {subtitle && (
            <span className="block text-xs text-gray-400 truncate">
              {subtitle}
            </span>
          )}
        </span>
      </button>
      {open && <div className="px-4 pb-4 border-t border-gray-100 pt-4">{children}</div>}
    </section>
  );
}
