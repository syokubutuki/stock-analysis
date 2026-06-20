// 2.5 レンジ由来ボラコーン。
// Yang-Zhang（窓込み・レンジ由来）の実現ボラを複数の窓長で計算し、各窓長での
// 分位（min/25/50/75/max）と現在値を並べる。現状ボラが過去比で割高/割安かを判定。

import { PricePoint } from "./types";
import { rollingOHLCVol } from "./ohlc-volatility";

export interface ConeRow {
  window: number;
  min: number; q25: number; median: number; q75: number; max: number;
  current: number;
  pctile: number; // 現在値の過去内パーセンタイル(0..1)
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function rangeVolCone(prices: PricePoint[], windows = [5, 10, 21, 42, 63, 126]): ConeRow[] {
  const rows: ConeRow[] = [];
  for (const w of windows) {
    const series = rollingOHLCVol(prices, w);
    if (series.length < 5) continue;
    const yz = series.map((s) => s.est.yangZhang).filter((v) => v > 0 && isFinite(v));
    if (yz.length < 5) continue;
    const sorted = [...yz].sort((a, b) => a - b);
    const current = yz[yz.length - 1];
    let below = 0;
    for (const v of sorted) if (v < current) below++;
    rows.push({
      window: w,
      min: sorted[0],
      q25: quantile(sorted, 0.25),
      median: quantile(sorted, 0.5),
      q75: quantile(sorted, 0.75),
      max: sorted[sorted.length - 1],
      current,
      pctile: below / sorted.length,
    });
  }
  return rows;
}
