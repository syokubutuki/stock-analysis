"use client";

import { describeSanityReport, PriceSanityReport } from "../../lib/price-sanity";

/**
 * 価格データのスケール破損を修復した／疑いを検出したことを利用者に開示するバナー。
 *
 * サニタイズは `/api/stock` で自動的に走るため、黙っていれば利用者は自分が見ている数値が
 * 書き換えられたデータに基づくことを知れない。分析アプリとして**データに手を入れたことは
 * 必ず画面に出す**。修復も疑いも無い平常時は何も描かない（null を返す）。
 */
export default function DataQualityNotice({ report }: { report?: PriceSanityReport }) {
  const message = describeSanityReport(report);
  if (!message || !report) return null;
  const repairedOnly = report.suspects.length === 0;
  return (
    <div
      className={
        repairedOnly
          ? "bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 text-xs"
          : "bg-orange-50 border border-orange-200 text-orange-800 rounded-lg p-3 text-xs"
      }
    >
      <span className="font-medium">データ品質: </span>
      {message}
    </div>
  );
}
