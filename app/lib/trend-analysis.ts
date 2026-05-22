import { PricePoint } from "./types";

export interface TrendPoint {
  time: string;
  close: number;
  sma5: number | null;
  sma25: number | null;
  sma75: number | null;
}

export type TrendDirection = "up" | "down" | "range";

export interface TrendJudgment {
  direction: TrendDirection;
  strength: number; // 0-100
  reasons: string[];
  smaAlignment: string; // 短期>中期>長期 = 上昇パーフェクトオーダー等
}

function sma(prices: PricePoint[], period: number, endIndex: number): number | null {
  if (endIndex < period - 1) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    sum += prices[i].close;
  }
  return sum / period;
}

export function computeTrendSeries(prices: PricePoint[]): TrendPoint[] {
  return prices.map((p, i) => ({
    time: p.time,
    close: p.close,
    sma5: sma(prices, 5, i),
    sma25: sma(prices, 25, i),
    sma75: sma(prices, 75, i),
  }));
}

export function judgeTrend(prices: PricePoint[]): TrendJudgment {
  if (prices.length < 75) {
    return { direction: "range", strength: 0, reasons: ["データ不足"], smaAlignment: "-" };
  }

  const last = prices.length - 1;
  const s5 = sma(prices, 5, last)!;
  const s25 = sma(prices, 25, last)!;
  const s75 = sma(prices, 75, last)!;
  const close = prices[last].close;

  const reasons: string[] = [];
  let score = 0;

  // SMAの並び順
  if (s5 > s25 && s25 > s75) {
    reasons.push("パーフェクトオーダー(上昇)");
    score += 40;
  } else if (s5 < s25 && s25 < s75) {
    reasons.push("パーフェクトオーダー(下降)");
    score -= 40;
  }

  // 価格とSMA75の位置関係
  if (close > s75) {
    reasons.push("株価 > SMA75");
    score += 20;
  } else {
    reasons.push("株価 < SMA75");
    score -= 20;
  }

  // SMA25の傾き（直近20日での変化）
  if (prices.length >= 45) {
    const s25_20ago = sma(prices, 25, last - 20);
    if (s25_20ago !== null) {
      const slope = ((s25 - s25_20ago) / s25_20ago) * 100;
      if (slope > 2) {
        reasons.push(`SMA25上昇中(${slope.toFixed(1)}%)`);
        score += 20;
      } else if (slope < -2) {
        reasons.push(`SMA25下降中(${slope.toFixed(1)}%)`);
        score -= 20;
      } else {
        reasons.push("SMA25横ばい");
      }
    }
  }

  // 直近20日の高値・安値更新
  const recent20 = prices.slice(-20);
  const high20 = Math.max(...recent20.map((p) => p.high));
  const low20 = Math.min(...recent20.map((p) => p.low));
  if (close >= high20 * 0.98) {
    reasons.push("直近20日高値圏");
    score += 10;
  }
  if (close <= low20 * 1.02) {
    reasons.push("直近20日安値圏");
    score -= 10;
  }

  let direction: TrendDirection;
  if (score >= 30) direction = "up";
  else if (score <= -30) direction = "down";
  else direction = "range";

  const strength = Math.min(100, Math.abs(score));

  let smaAlignment: string;
  if (s5 > s25 && s25 > s75) smaAlignment = "短期 > 中期 > 長期 (上昇配列)";
  else if (s5 < s25 && s25 < s75) smaAlignment = "短期 < 中期 < 長期 (下降配列)";
  else smaAlignment = "混在 (レンジ)";

  return { direction, strength, reasons, smaAlignment };
}
