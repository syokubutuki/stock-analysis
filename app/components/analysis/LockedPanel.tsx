"use client";

import Link from "next/link";

interface Props {
  id: string;
  title: string;
  subtitle?: string;
}

/**
 * 無料枠では開けないパネルの代替表示。
 *
 * 意図的に「中身を一切描画しない」設計にしている。
 * ぼかし画像やダミーの数値を置くと、
 *   - 計算コストは払うのに結果は見せない（無駄）
 *   - DOM に本物の値が残り、開発者ツールで読める（実質無料）
 * のどちらかになる。ここでは node を評価すらしない。
 *
 * また煽り文（「これを見れば勝てる」等）は置かない。
 * 有料で売るのは計算と可視化であって、当たる保証ではない。
 */
export default function LockedPanel({ title, subtitle }: Props) {
  return (
    <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/40 p-4">
      <div className="flex items-start gap-3">
        <svg
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M10 1a4 4 0 00-4 4v2H5a2 2 0 00-2 2v7a2 2 0 002 2h10a2 2 0 002-2V9a2 2 0 00-2-2h-1V5a4 4 0 00-4-4zm2 6V5a2 2 0 10-4 0v2h4z"
            clipRule="evenodd"
          />
        </svg>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-700">{title}</p>
          {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
          <p className="mt-1.5 text-xs text-gray-500">
            この分析は Pro で利用できます。無料枠では基本分析・テクニカル・OHLC・
            分布・リスク指標と、検証用のパネル（ヌル較正・ウォークフォワード・
            検出力・エッジ減衰）をご利用いただけます。
          </p>
          <Link
            href="/pricing"
            className="mt-2 inline-block text-xs font-medium text-blue-600 hover:underline"
          >
            Pro の内容を見る →
          </Link>
        </div>
      </div>
    </div>
  );
}
