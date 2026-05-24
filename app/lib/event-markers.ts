import { PricePoint } from "./types";

export interface EventMarker {
  time: string;
  type: "volumeSpike" | "gapUp" | "gapDown" | "bigUp" | "bigDown";
  label: string;
  description: string;
}

export function detectEventMarkers(prices: PricePoint[]): EventMarker[] {
  if (prices.length < 2) return [];

  // --- Precompute daily returns ---
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i].close - prices[i - 1].close) / prices[i - 1].close);
  }

  // Mean and standard deviation of daily returns
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
  const sigma = Math.sqrt(variance);

  // --- Precompute 20-day SMA of volume ---
  const volumeSma20: number[] = new Array(prices.length).fill(NaN);
  for (let i = 19; i < prices.length; i++) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) sum += prices[j].volume;
    volumeSma20[i] = sum / 20;
  }

  const markersMap = new Map<string, EventMarker>();

  // Priority order (higher index = more significant, will overwrite lower)
  const priority: Record<EventMarker["type"], number> = {
    volumeSpike: 1,
    gapUp: 2,
    gapDown: 2,
    bigUp: 3,
    bigDown: 3,
  };

  const addMarker = (candidate: EventMarker) => {
    const existing = markersMap.get(candidate.time);
    if (!existing || priority[candidate.type] > priority[existing.type]) {
      markersMap.set(candidate.time, candidate);
    }
  };

  for (let i = 1; i < prices.length; i++) {
    const cur = prices[i];
    const prev = prices[i - 1];
    const ret = returns[i - 1]; // return from prev to cur (index offset)

    // Volume spike: volume > 2x 20-day SMA of volume
    if (!isNaN(volumeSma20[i]) && cur.volume > 2 * volumeSma20[i]) {
      addMarker({
        time: cur.time,
        type: "volumeSpike",
        label: "出来高急増",
        description: `出来高が20日平均の${(cur.volume / volumeSma20[i]).toFixed(1)}倍に急増`,
      });
    }

    // Gap up: (open - prevClose) / prevClose > 1%
    const gapRatio = (cur.open - prev.close) / prev.close;
    if (gapRatio > 0.01) {
      addMarker({
        time: cur.time,
        type: "gapUp",
        label: "窓開け↑",
        description: `前日終値比+${(gapRatio * 100).toFixed(1)}%の窓開け上昇`,
      });
    } else if (gapRatio < -0.01) {
      // Gap down: (prevClose - open) / prevClose > 1%
      addMarker({
        time: cur.time,
        type: "gapDown",
        label: "窓開け↓",
        description: `前日終値比${(gapRatio * 100).toFixed(1)}%の窓開け下落`,
      });
    }

    // Big up move: daily return > +2σ
    if (sigma > 0 && ret > meanReturn + 2 * sigma) {
      addMarker({
        time: cur.time,
        type: "bigUp",
        label: "大幅上昇",
        description: `日次騰落率+${(ret * 100).toFixed(1)}%（+${((ret - meanReturn) / sigma).toFixed(1)}σ）`,
      });
    } else if (sigma > 0 && ret < meanReturn - 2 * sigma) {
      // Big down move: daily return < -2σ
      addMarker({
        time: cur.time,
        type: "bigDown",
        label: "大幅下落",
        description: `日次騰落率${(ret * 100).toFixed(1)}%（${((ret - meanReturn) / sigma).toFixed(1)}σ）`,
      });
    }
  }

  // Return sorted by time
  return Array.from(markersMap.values()).sort((a, b) =>
    a.time.localeCompare(b.time)
  );
}
