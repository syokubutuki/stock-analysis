"use client";

import { useEffect, useState } from "react";
import { PAYWALL_ENABLED, type Tier } from "./tiers";

/**
 * 現在の閲覧者の権限を返す。
 *
 * 現状はスタブ。認証（Clerk / NextAuth）と Stripe を入れたら、
 * この関数の中だけを差し替える。呼び出し側（AccordionSection 等）は変更不要。
 *
 * PAYWALL_ENABLED が false の間は常に "pro" を返すため、
 * 既存ユーザーの見え方は一切変わらない。
 *
 * 開発時に有料状態を確認したい場合は、ブラウザのコンソールで
 *   localStorage.setItem("dev-tier", "free")
 * とすると無料枠として描画される（PAYWALL_ENABLED が true のときのみ有効）。
 */
export function useEntitlement(): Tier {
  const [tier, setTier] = useState<Tier>(PAYWALL_ENABLED ? "free" : "pro");

  useEffect(() => {
    if (!PAYWALL_ENABLED) return;
    try {
      const dev = localStorage.getItem("dev-tier");
      if (dev === "pro" || dev === "free") setTier(dev);
    } catch {
      // localStorage が使えない環境では無料枠のまま
    }
  }, []);

  return tier;
}
