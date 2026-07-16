"use client";

// KaTeX 数式レンダラ。株式原論(/axioms)の公式・導出をプレーンテキストから本組みへ。
//
// 使い方:
//   <TeX>{"f^* = \\frac{\\mu}{\\sigma^2}"}</TeX>        インライン
//   <TeX block>{"W = \\int_0^T q\\,dP - C"}</TeX>        ディスプレイ(中央・大)
//
// 数式ソースは LaTeX。日本語は \text{} に入れず、散文は TSX 側に置く
// (CJK フォントが KaTeX の数式フォントに無いため)。

import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

interface Props {
  /** LaTeX ソース。 */
  children: string;
  /** true でディスプレイ数式(中央寄せ・大きめ)。既定はインライン。 */
  block?: boolean;
  className?: string;
}

export default function TeX({ children, block, className }: Props) {
  // throwOnError:false で不正な TeX もソースを赤字表示にとどめ、ページを壊さない。
  const html = useMemo(
    () =>
      katex.renderToString(children, {
        displayMode: !!block,
        throwOnError: false,
        strict: false,
      }),
    [children, block]
  );

  return (
    <span
      // 長い式は横スクロールに逃がす(モバイルで本文を押し広げない)。
      className={`${block ? "block overflow-x-auto py-1" : "inline-block"} ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
