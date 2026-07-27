// Canvas2D チャートの軸目盛り・等高線の刻み幅を決める共有ユーティリティ。
// ────────────────────────────────────────────────────────────────────────────
// 各コンポーネントに同じ関数を書き写していたものを一本化した（GrowthIntuitionPanel /
// CorrelationDragChart / EfficientFrontierChart）。lightweight-charts は目盛りを自前で
// 打つので、これが必要になるのは Canvas2D の図だけ。

/**
 * 「切りのいい刻み幅」への丸め。1・2・2.5・5・10 の等級に丸める。
 *
 * **2.5 を等級に含めるのが重要**。[1,2,5] だけだと 2〜5 倍の範囲がすべて 5 に丸められ、
 * 目盛りが 1 本しか出ない（例: 値幅 21万 → 50万刻み → ラベルは「100万」だけ）／
 * 等高線が 3 本に減って地形が読めない、という描画事故が起きる。
 *
 * @param raw 目標の刻み幅（値幅 ÷ 目安の本数）
 */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !isFinite(raw)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return m * exp;
}

/**
 * [lo, hi] を覆う「切りのいい目盛り値」の列。target は目安の本数。
 * niceStep で刻みを決めてから lo 以上・hi 以下の格子点を返す。
 */
export function niceTicks(lo: number, hi: number, target = 5): number[] {
  const span = hi - lo;
  if (!(span > 0) || !isFinite(span)) return [lo];
  const step = niceStep(span / Math.max(target, 1));
  const out: number[] = [];
  // 刻みの丸め誤差が累積しないよう、乗算で格子点を作る
  const first = Math.ceil(lo / step);
  const last = Math.floor(hi / step);
  for (let k = first; k <= last; k++) out.push(k * step);
  return out;
}

/**
 * 矩形の重なり判定と、配置済み矩形の記録。
 * Canvas 上のラベルが互いに重ならないように置くための最小の道具。
 */
export interface LabelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectsOverlap(a: LabelRect, b: LabelRect, pad = 1): boolean {
  return (
    a.x - pad < b.x + b.w &&
    a.x + a.w + pad > b.x &&
    a.y - pad < b.y + b.h &&
    a.y + a.h + pad > b.y
  );
}

/**
 * 候補位置を順に試し、既に置かれたどの矩形とも重ならない最初の位置を返す。
 * どれも重なる場合は null（＝そのラベルは描かない、という判断を呼び出し側に委ねる）。
 * 採用した矩形は placed に push して次のラベルの判定に使う。
 */
export function placeRect(
  candidates: LabelRect[],
  placed: LabelRect[],
  pad = 2
): LabelRect | null {
  for (const c of candidates) {
    if (!placed.some((p) => rectsOverlap(c, p, pad))) {
      placed.push(c);
      return c;
    }
  }
  return null;
}
