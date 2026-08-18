"use client";

import {
  DIRECTION_GLYPH,
  DIRECTION_LABEL,
  DIRECTION_TEXT_CLASS,
  directionOf,
} from "../../lib/chart-colors";

/**
 * 上昇・下落を**色以外の手がかりでも**読めるようにする共通表示（A4）。
 *
 * ## なぜ要るか
 * 数値の正負が `text-green-600 / text-red-600` の塗り分けだけで表されている箇所が多く、
 * 1型・2型色覚では区別できない。さらに `#16a34a` は白背景で **3.30:1** しかなく、
 * 本文としての AA（4.5:1）にも届いていなかった。
 *
 * ## 何を足しているか
 * 1. **記号** `▲ / ▼`（`DIRECTION_GLYPH`）— 形で読める
 * 2. **符号** `+ / −` を常に明示（`withSign`）— 正の値が無印にならない
 * 3. **読み上げ** `aria-label` に「上昇」「下落」— 色も形も届かない利用者向け
 * 4. 色は AA を満たす `DIRECTION_TEXT_CLASS` に寄せる
 *
 * 記号は `aria-hidden` にしていない。読み上げでは `aria-label` の日本語が優先され、
 * 記号は読み上げ対象から外れる。
 */
export function directionClass(value: number, eps = 0): string {
  return DIRECTION_TEXT_CLASS[directionOf(value, eps)];
}

/**
 * 数値の向きを表す記号だけを描く。既存のセルの中身を変えずに第2の手がかりを足せる。
 * `eps` 未満は「変化なし」として `→` を出す。
 */
export function DirectionGlyph({ value, eps = 0 }: { value: number; eps?: number }) {
  const d = directionOf(value, eps);
  return (
    <span aria-label={DIRECTION_LABEL[d]} className="mr-0.5 inline-block">
      {DIRECTION_GLYPH[d]}
    </span>
  );
}

/**
 * 記号 + 本体をまとめて描く。`children` には既存の整形済み文字列を渡す。
 * 表のセルにそのまま置ける（`className` で `text-right` 等を足す）。
 */
export default function DirectionValue({
  value,
  children,
  eps = 0,
  className = "",
  showGlyph = true,
}: {
  value: number;
  children: React.ReactNode;
  eps?: number;
  className?: string;
  showGlyph?: boolean;
}) {
  return (
    <span className={`${directionClass(value, eps)} ${className}`.trim()}>
      {showGlyph && <DirectionGlyph value={value} eps={eps} />}
      {children}
    </span>
  );
}
