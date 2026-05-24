import { PricePoint } from "./types";

export interface IchimokuPoint {
  time: string;
  close: number;
  tenkan: number | null;    // 転換線 (9日)
  kijun: number | null;     // 基準線 (26日)
  senkouA: number | null;   // 先行スパン1
  senkouB: number | null;   // 先行スパン2
  chikou: number | null;    // 遅行スパン
}

function midpoint(prices: PricePoint[], end: number, period: number): number | null {
  if (end < period - 1) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let i = end - period + 1; i <= end; i++) {
    if (prices[i].high > high) high = prices[i].high;
    if (prices[i].low < low) low = prices[i].low;
  }
  return (high + low) / 2;
}

export function computeIchimoku(prices: PricePoint[]): {
  current: IchimokuPoint[];
  leading: { time: string; senkouA: number; senkouB: number }[];
} {
  const current: IchimokuPoint[] = [];
  const senkouAValues: (number | null)[] = [];
  const senkouBValues: (number | null)[] = [];

  for (let i = 0; i < prices.length; i++) {
    const tenkan = midpoint(prices, i, 9);
    const kijun = midpoint(prices, i, 26);
    const sA = tenkan !== null && kijun !== null ? (tenkan + kijun) / 2 : null;
    const sB = midpoint(prices, i, 52);

    senkouAValues.push(sA);
    senkouBValues.push(sB);

    // 遅行スパン: 当日終値を26日前にプロット → current[i] の chikou は prices[i+26].close
    // ただしここでは current[i] に chikou として 26日後の終値を入れるのではなく、
    // current[i].chikou = prices[i].close を 26日前の位置に置く
    // → 表示上は chikou[i] = prices[i+26].close (i+26 < n の場合)
    const chikouIdx = i + 26;
    const chikou = chikouIdx < prices.length ? prices[chikouIdx].close : null;

    current.push({
      time: prices[i].time,
      close: prices[i].close,
      tenkan,
      kijun,
      senkouA: i >= 26 ? senkouAValues[i - 26] : null,
      senkouB: i >= 26 ? senkouBValues[i - 26] : null,
      chikou,
    });
  }

  // 先行スパン（26日先に延長）
  const leading: { time: string; senkouA: number; senkouB: number }[] = [];
  for (let i = Math.max(0, prices.length - 26); i < prices.length; i++) {
    const sA = senkouAValues[i];
    const sB = senkouBValues[i];
    if (sA !== null && sB !== null) {
      // 日付を26営業日先に推定 (簡易: カレンダー日で36日先)
      const d = new Date(prices[i].time);
      d.setDate(d.getDate() + 36);
      const futureTime = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      leading.push({ time: futureTime, senkouA: sA, senkouB: sB });
    }
  }

  return { current, leading };
}

export type IchimokuSignal = "三役好転" | "三役逆転" | "好転気配" | "逆転気配" | "中立";

export interface IchimokuJudgment {
  signal: IchimokuSignal;
  conditions: { label: string; met: boolean }[];
  cloudStatus: "above" | "below" | "inside";
}

export function judgeIchimoku(points: IchimokuPoint[]): IchimokuJudgment {
  if (points.length < 52) {
    return {
      signal: "中立",
      conditions: [{ label: "データ不足", met: false }],
      cloudStatus: "inside",
    };
  }

  const last = points[points.length - 1];
  const conditions: { label: string; met: boolean }[] = [];

  // 1. 転換線 > 基準線
  const tenkanAboveKijun = last.tenkan !== null && last.kijun !== null && last.tenkan > last.kijun;
  conditions.push({ label: "転換線 > 基準線", met: tenkanAboveKijun });

  // 2. 遅行スパン > 26日前の株価
  // chikou at current position = close of 26 days later (already set)
  // We need: close[now] vs close[now - 26]
  const chikouAbove = points.length > 26 && last.close > points[points.length - 27].close;
  conditions.push({ label: "遅行スパン > 26日前株価", met: chikouAbove });

  // 3. 株価 > 雲上限
  const cloudTop = last.senkouA !== null && last.senkouB !== null
    ? Math.max(last.senkouA, last.senkouB)
    : null;
  const cloudBottom = last.senkouA !== null && last.senkouB !== null
    ? Math.min(last.senkouA, last.senkouB)
    : null;
  const aboveCloud = cloudTop !== null && last.close > cloudTop;
  const belowCloud = cloudBottom !== null && last.close < cloudBottom;
  conditions.push({ label: "株価 > 雲上限", met: aboveCloud });

  const cloudStatus: "above" | "below" | "inside" = aboveCloud
    ? "above"
    : belowCloud
    ? "below"
    : "inside";

  const bullCount = conditions.filter((c) => c.met).length;
  const bearConditions = [
    last.tenkan !== null && last.kijun !== null && last.tenkan < last.kijun,
    points.length > 26 && last.close < points[points.length - 27].close,
    belowCloud,
  ];
  const bearCount = bearConditions.filter(Boolean).length;

  let signal: IchimokuSignal;
  if (bullCount === 3) signal = "三役好転";
  else if (bearCount === 3) signal = "三役逆転";
  else if (bullCount >= 2) signal = "好転気配";
  else if (bearCount >= 2) signal = "逆転気配";
  else signal = "中立";

  return { signal, conditions, cloudStatus };
}
