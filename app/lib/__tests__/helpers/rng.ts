// テスト用の決定的乱数。フィクスチャ生成と、乱数を使う関数（ブートストラップ・順列検定）の
// シード固定に使う。実装は app/lib 側の各所で使われている mulberry32 と同じもの。
//
// なぜテスト側に置くか: 乱数列そのものが黄金値の一部になるため、実装側の都合で
// アルゴリズムが差し替わるとテストの意味が変わってしまう。テストが握る定数として持つ。

/** mulberry32。同じ seed からは常に同じ列が出る。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Box-Muller による標準正規乱数。1回の呼び出しで一様乱数を必ず2個消費する
 * （残り1個をキャッシュする実装だと呼び出し順で列が変わり、再現性が壊れる）。
 */
export function makeNormal(rand: () => number): () => number {
  return () => {
    const u1 = Math.max(rand(), Number.MIN_VALUE);
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}

/**
 * `Math.random` を mulberry32 に差し替えて fn を実行する。
 * `blockBootstrapCI` のように内部で `Math.random` を直接呼ぶ関数を黄金値化するための唯一の手段。
 */
export function withSeededRandom<T>(seed: number, fn: () => T): T {
  const original = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}
