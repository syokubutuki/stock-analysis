import { PricePoint } from "./types";

export interface OBVPoint {
  time: string;
  obv: number;
  obvMA: number;
}

export interface VWAPPoint {
  time: string;
  vwap: number;
  close: number;
}

export function computeOBV(prices: PricePoint[]): OBVPoint[] {
  if (prices.length === 0) return [];

  const MA_PERIOD = 20;
  const obvValues: number[] = [];
  let cumulative = 0;

  for (let i = 0; i < prices.length; i++) {
    if (i === 0) {
      cumulative = 0;
    } else {
      const prev = prices[i - 1];
      const curr = prices[i];
      if (curr.close > prev.close) {
        cumulative += curr.volume;
      } else if (curr.close < prev.close) {
        cumulative -= curr.volume;
      }
      // unchanged close: cumulative stays the same
    }
    obvValues.push(cumulative);
  }

  return prices.map((p, i) => {
    const start = Math.max(0, i - MA_PERIOD + 1);
    const slice = obvValues.slice(start, i + 1);
    const obvMA = slice.reduce((sum, v) => sum + v, 0) / slice.length;
    return {
      time: p.time,
      obv: obvValues[i],
      obvMA,
    };
  });
}

export function computeVWAP(prices: PricePoint[]): VWAPPoint[] {
  if (prices.length === 0) return [];

  let cumTypicalPriceVolume = 0;
  let cumVolume = 0;

  return prices.map((p) => {
    const typicalPrice = (p.high + p.low + p.close) / 3;
    cumTypicalPriceVolume += typicalPrice * p.volume;
    cumVolume += p.volume;
    const vwap = cumVolume === 0 ? typicalPrice : cumTypicalPriceVolume / cumVolume;
    return {
      time: p.time,
      vwap,
      close: p.close,
    };
  });
}

export function detectOBVDivergence(
  prices: PricePoint[],
  obv: OBVPoint[]
): { type: "bullish" | "bearish" | null; message: string } {
  const WINDOW = 20;
  if (prices.length < WINDOW || obv.length < WINDOW) {
    return { type: null, message: "データ不足のため判定できません" };
  }

  const recentPrices = prices.slice(-WINDOW);
  const recentOBV = obv.slice(-WINDOW);

  const priceHighs = recentPrices.map((p) => p.high);
  const priceLows = recentPrices.map((p) => p.low);
  const obvValues = recentOBV.map((o) => o.obv);

  const firstHalfEnd = Math.floor(WINDOW / 2);

  const firstHalfPriceHigh = Math.max(...priceHighs.slice(0, firstHalfEnd));
  const secondHalfPriceHigh = Math.max(...priceHighs.slice(firstHalfEnd));
  const firstHalfOBVHigh = Math.max(...obvValues.slice(0, firstHalfEnd));
  const secondHalfOBVHigh = Math.max(...obvValues.slice(firstHalfEnd));

  const firstHalfPriceLow = Math.min(...priceLows.slice(0, firstHalfEnd));
  const secondHalfPriceLow = Math.min(...priceLows.slice(firstHalfEnd));
  const firstHalfOBVLow = Math.min(...obvValues.slice(0, firstHalfEnd));
  const secondHalfOBVLow = Math.min(...obvValues.slice(firstHalfEnd));

  // Bearish divergence: price makes higher high, OBV makes lower high
  if (
    secondHalfPriceHigh > firstHalfPriceHigh &&
    secondHalfOBVHigh < firstHalfOBVHigh
  ) {
    return {
      type: "bearish",
      message:
        "弱気ダイバージェンス: 価格は高値更新もOBVは低下 — 上昇トレンドの弱体化が示唆されます",
    };
  }

  // Bullish divergence: price makes lower low, OBV makes higher low
  if (
    secondHalfPriceLow < firstHalfPriceLow &&
    secondHalfOBVLow > firstHalfOBVLow
  ) {
    return {
      type: "bullish",
      message:
        "強気ダイバージェンス: 価格は安値更新もOBVは上昇 — 下降トレンドの弱体化が示唆されます",
    };
  }

  return { type: null, message: "現在ダイバージェンスは検出されていません" };
}
