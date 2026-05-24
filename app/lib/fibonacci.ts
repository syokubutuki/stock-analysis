import { PricePoint } from "./types";

export interface FibLevel {
  ratio: number;
  label: string;
  price: number;
  isExtension: boolean;
}

export interface FibResult {
  swingHigh: { price: number; time: string; index: number };
  swingLow: { price: number; time: string; index: number };
  trend: "up" | "down";
  levels: FibLevel[];
  currentLevel: string; // e.g. "38.2% - 50.0%"
}

const RETRACE_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
const EXTENSION_RATIOS = [1.272, 1.618, 2.0, 2.618];

// Find the major swing high and swing low in the period
function findSwings(prices: PricePoint[]): {
  high: { price: number; time: string; index: number };
  low: { price: number; time: string; index: number };
} {
  let highIdx = 0;
  let lowIdx = 0;

  for (let i = 0; i < prices.length; i++) {
    if (prices[i].high > prices[highIdx].high) highIdx = i;
    if (prices[i].low < prices[lowIdx].low) lowIdx = i;
  }

  return {
    high: { price: prices[highIdx].high, time: prices[highIdx].time, index: highIdx },
    low: { price: prices[lowIdx].low, time: prices[lowIdx].time, index: lowIdx },
  };
}

export function computeFibonacci(prices: PricePoint[]): FibResult | null {
  if (prices.length < 10) return null;

  const { high, low } = findSwings(prices);
  const range = high.price - low.price;
  if (range <= 0) return null;

  // Determine trend: if low came before high → uptrend, otherwise downtrend
  const trend: "up" | "down" = low.index < high.index ? "up" : "down";
  const currentPrice = prices[prices.length - 1].close;

  const levels: FibLevel[] = [];

  if (trend === "up") {
    // Retracement from high: levels go downward from high
    for (const ratio of RETRACE_RATIOS) {
      levels.push({
        ratio,
        label: `${(ratio * 100).toFixed(1)}%`,
        price: high.price - range * ratio,
        isExtension: false,
      });
    }
    // Extensions above high
    for (const ratio of EXTENSION_RATIOS) {
      levels.push({
        ratio,
        label: `${(ratio * 100).toFixed(1)}%`,
        price: low.price + range * ratio,
        isExtension: true,
      });
    }
  } else {
    // Retracement from low: levels go upward from low
    for (const ratio of RETRACE_RATIOS) {
      levels.push({
        ratio,
        label: `${(ratio * 100).toFixed(1)}%`,
        price: low.price + range * ratio,
        isExtension: false,
      });
    }
    // Extensions below low
    for (const ratio of EXTENSION_RATIOS) {
      levels.push({
        ratio,
        label: `${(ratio * 100).toFixed(1)}%`,
        price: high.price - range * ratio,
        isExtension: true,
      });
    }
  }

  // Determine current level range
  const retraceLevels = levels.filter((l) => !l.isExtension);
  const sortedByPrice = [...retraceLevels].sort((a, b) => a.price - b.price);
  let currentLevel = "";
  for (let i = 0; i < sortedByPrice.length - 1; i++) {
    if (currentPrice >= sortedByPrice[i].price && currentPrice <= sortedByPrice[i + 1].price) {
      currentLevel = `${sortedByPrice[i].label} 〜 ${sortedByPrice[i + 1].label}`;
      break;
    }
  }
  if (!currentLevel) {
    if (currentPrice < sortedByPrice[0].price) {
      currentLevel = `${sortedByPrice[0].label} 以下`;
    } else {
      currentLevel = `${sortedByPrice[sortedByPrice.length - 1].label} 以上`;
    }
  }

  return {
    swingHigh: high,
    swingLow: low,
    trend,
    levels,
    currentLevel,
  };
}
