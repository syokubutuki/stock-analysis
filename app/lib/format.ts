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

function sign(value: number): string {
  if (value > 0) return "+";
  if (value < 0) return "-";
  return "";
}
