import { PricePoint } from "./types";

export interface VolumeBar {
  time: string;
  volume: number;
  avgVolume: number;
  ratio: number; // volume / avgVolume
  priceChange: number;
  type: "up" | "down" | "flat";
}

// 出来高分析: 移動平均との乖離を計算
export function analyzeVolume(
  prices: PricePoint[],
  avgPeriod: number = 20
): VolumeBar[] {
  const result: VolumeBar[] = [];

  for (let i = 0; i < prices.length; i++) {
    const start = Math.max(0, i - avgPeriod + 1);
    const window = prices.slice(start, i + 1);
    const avgVolume =
      window.reduce((sum, p) => sum + p.volume, 0) / window.length;

    const priceChange =
      i > 0 ? prices[i].close - prices[i - 1].close : 0;

    result.push({
      time: prices[i].time,
      volume: prices[i].volume,
      avgVolume,
      ratio: avgVolume > 0 ? prices[i].volume / avgVolume : 1,
      priceChange,
      type: priceChange > 0 ? "up" : priceChange < 0 ? "down" : "flat",
    });
  }

  return result;
}

// 出来高急増の検出 (平均の threshold 倍以上)
export interface VolumeSurge {
  time: string;
  volume: number;
  avgVolume: number;
  ratio: number;
  priceChange: number;
  type: "up" | "down" | "flat";
}

export function detectVolumeSurges(
  volumeBars: VolumeBar[],
  threshold: number = 2.0
): VolumeSurge[] {
  return volumeBars
    .filter((bar) => bar.ratio >= threshold)
    .map((bar) => ({
      time: bar.time,
      volume: bar.volume,
      avgVolume: bar.avgVolume,
      ratio: bar.ratio,
      priceChange: bar.priceChange,
      type: bar.type,
    }));
}
