"use client";

import {
  describeSanityReport,
  hasSanityWarnings,
  PriceSanityReport,
} from "../../lib/price-sanity";

/**
 * 価格データのスケール破損を修復した／休場日の行を除去した／疑いを検出したことを
 * 利用者に開示するバナー。
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
  // 色は「利用者の判断が要るか」で分ける。休場日の行の除去・売買不成立日の告知だけなら
  // 落ち着いた色にする（東証銘柄の多くに常時出るため、警告色だと警告そのものが読まれなくなる）。
  const needsJudgement =
    report.suspects.length > 0 ||
    (report.sessionSuspects ?? []).some((s) => s.kind === "closedDay");
  const className = needsJudgement
    ? "bg-orange-50 border border-orange-200 text-orange-800 rounded-lg p-3 text-xs"
    : hasSanityWarnings(report)
      ? "bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 text-xs"
      : "bg-sky-50 border border-sky-200 text-sky-800 rounded-lg p-3 text-xs";
  return (
    <div className={className}>
      <span className="font-medium">データ品質: </span>
      {message}
      {onOpenPanel ? (
        <button
          type="button"
          onClick={onOpenPanel}
          className="ml-1 underline underline-offset-2 font-medium hover:no-underline"
        >
          手を入れた日の配信値と処理の詳細を見る（「基本」節の「価格データの破損点検」）
        </button>
      ) : (
        <span className="ml-1 opacity-80">
          （手を入れた日の配信値と処理の詳細は「基本」節の「価格データの破損点検」パネルで確認できます）
        </span>
      )}
    </div>
  );
}
