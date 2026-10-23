// 「日付が厳密に小さい最新の行」の整合（asof）。
//
// 日本の立会日 t の判断時刻（朝7時 JST / 寄り付き直前）に使える海外の足は、
// **日付が t より厳密に小さい最新の行**である。米国の t−1 の終値は JST t の朝5〜6時に確定し、
// 同じ日付 t の米国の足はその日の夜まで閉じない。同日を使うと先読みになる。
//
// 同じ比較は `cross-asset-lead.ts` の `alignFeature()` と `us-spillover-core.ts` の
// `alignJpUs()` にもあるが、どちらも各自の構造体に結合していて再利用できない。
// ここは添字だけを返す最小の形にし、既存2箇所は置き換えない（壊れていないものを触らない。
// `docs/derisk-rule-design.md` §2.2）。

/**
 * 各 `jpTimes[k]` について、`usTimes[j] < jpTimes[k]` を満たす最大の j を返す（無ければ −1）。
 *
 * 両配列とも "YYYY-MM-DD" の**昇順**であること。日付は文字列比較で足りる（同じ桁数の ISO 表記）。
 * NaN を含む系列を渡すときは、呼び出し側で NaN の行を除いてから渡すこと（研究側の
 * `asof_us` は `dropna()` してから探索しており、未定義の行は「最新」の候補にならない）。
 */
export function asofIndex(jpTimes: readonly string[], usTimes: readonly string[]): Int32Array {
  const out = new Int32Array(jpTimes.length);
  let j = 0;
  for (let k = 0; k < jpTimes.length; k++) {
    const t = jpTimes[k];
    while (j < usTimes.length && usTimes[j] < t) j++;
    out[k] = j - 1;
  }
  return out;
}
