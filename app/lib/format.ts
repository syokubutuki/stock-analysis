const SUMMARY_PRICE_SIGNIFICANT_DIGITS = 6;
const MAXIMUM_FRACTION_DIGITS = 20;

export function formatCurrency(value: number, currency: string = "JPY"): string {
  if (currency === "JPY") {
    return `${sign(value)}${Math.abs(Math.round(value)).toLocaleString()}`;
  }
  return `${sign(value)}$${Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function formatShares(shares: number): string {
  return shares.toLocaleString();
}

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

function sign(value: number): string {
  if (value > 0) return "+";
  if (value < 0) return "-";
  return "";
}
