"use client";

import { describeSanityReport, PriceSanityReport } from "../../lib/price-sanity";

/**
 * 価格データのスケール破損を修復した／疑いを検出したことを利用者に開示するバナー。
 *
 * サニタイズは `/api/stock` で自動的に走るため、黙っていれば利用者は自分が見ている数値が
 * 書き換えられたデータに基づくことを知れない。分析アプリとして**データに手を入れたことは
 * 必ず画面に出す**。修復も疑いも無い平常時は何も描かない（null を返す）。
 *
 * 詳細パネル（DataQualityPanel）は「基本」節の1か所にしか無い。全節共通の開示は
 * このバナーが担うので、他の節から詳細を見たい人のために `onOpenPanel` で導線を出す。
 */
export default function DataQualityNotice({
  report,
  onOpenPanel,
}: {
  report?: PriceSanityReport;
  /** 詳細パネルへジャンプする（「基本」節へ切り替えて開く）。省略時は文言のみ。 */
  onOpenPanel?: () => void;
}) {
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
      {onOpenPanel ? (
        <button
          type="button"
          onClick={onOpenPanel}
          className="ml-1 underline underline-offset-2 font-medium hover:no-underline"
        >
          修復した日の配信値・修復値と修復前後のチャートを見る（「基本」節の「価格データの破損点検」）
        </button>
      ) : (
        <span className="ml-1 opacity-80">
          （修復した日の配信値・修復値と修復前後のチャートは「基本」節の「価格データの破損点検」パネルで確認できます）
        </span>
      )}
    </div>
  );
}
