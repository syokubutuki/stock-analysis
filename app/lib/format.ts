// サマリーカード用の価格書式（Q1）。
//
// 呼び出し元は app/page.tsx（現在値・期間始値）・app/t/[ticker]/page.tsx・
// app/t/[ticker]/opengraph-image.tsx の3か所で、同じ関数を通しているので桁の規則は1つ。
//
// 以前ここにあった formatCurrency / formatPercent / formatShares は参照0件だったので
// S23（FU6）で削除した。formatCurrency は非JPYを一律 `$` で描く欠陥があり、使い手が無い
// 関数を推測で直さない判断（docs/display-details-inventory.md §4.2）。
// %表示が要るなら app/t/[ticker]/page.tsx のローカル formatPercent が現役の実装である。

const SUMMARY_PRICE_SIGNIFICANT_DIGITS = 6;
const MAXIMUM_FRACTION_DIGITS = 20;

function currencyMinorUnitDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * サマリーカード用の価格表示。
 * 通貨の最小桁を保ち、低位銘柄は有効な数字が残るまで小数部を表示する。
 *
 * カード間で桁が揃わないことがある（FU7・S23 で実測して**許容**と判断）:
 *   7203.T 10y  現在値 3,031   / 期間始値 900.872
 *   1306.T 1y   現在値 419.7   / 期間始値 312.104
 * 不揃いの正体は分割調整後の過去終値で、900.872 は 5 分割を遡って割った値である
 * （実際の呼値ではない）。現在値は実際の呼値なので桁が少ない。
 * 揃える手は2つあるが採らなかった:
 *   - 2枚のカードで小数桁を合わせる → 呼び出し側（page.tsx）の変更が要る
 *   - 通貨ごとに小数の上限を置く（JPY は呼値の最小 0.1 円＝1桁）→ 0桁 vs 1桁の差は残るうえ、
 *     /t/[ticker] と OG 画像の数値も一緒に動く
 * 低位銘柄の桁を保つ（419.7 を 420 にしない）ことを優先し、有効数字 6 桁の規則を維持する。
 */
export function formatSummaryPrice(value: number, currency: string): string {
  const minorUnitDigits = currencyMinorUnitDigits(currency);
  const magnitude = value === 0 ? 0 : Math.floor(Math.log10(Math.abs(value)));
  const significantFractionDigits = Math.max(
    0,
    SUMMARY_PRICE_SIGNIFICANT_DIGITS - magnitude - 1
  );
  const maximumFractionDigits = Math.min(
    MAXIMUM_FRACTION_DIGITS,
    Math.max(minorUnitDigits, significantFractionDigits)
  );

  return new Intl.NumberFormat("ja-JP", {
    minimumFractionDigits: minorUnitDigits,
    maximumFractionDigits,
  }).format(value);
}
