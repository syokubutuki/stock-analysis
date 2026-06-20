// 3.6 期間ボリュームプロファイル拡張。
// 価格帯ごとの出来高を集計し、POC（最大出来高価格）・バリューエリア（出来高70%が収まる帯）・
// HVN/LVN（出来高の濃淡＝支持抵抗の節）を求める。

import { PricePoint } from "./types";

export interface ProfileBin {
  priceLow: number;
  priceHigh: number;
  mid: number;
  volume: number;
  inValueArea: boolean;
  isPOC: boolean;
  isHVN: boolean;
  isLVN: boolean;
}

export interface VolumeProfileResult {
  bins: ProfileBin[];
  poc: number;
  vaHigh: number;
  vaLow: number;
  maxVol: number;
  currentPrice: number;
}

export function computeVolumeProfile(prices: PricePoint[], nBins = 40): VolumeProfileResult | null {
  if (prices.length < 10) return null;
  let lo = Infinity, hi = -Infinity;
  for (const p of prices) { lo = Math.min(lo, p.low); hi = Math.max(hi, p.high); }
  if (!(hi > lo)) return null;
  const step = (hi - lo) / nBins;
  const vol = new Array(nBins).fill(0);

  // 各日の出来高をその日のレンジに均等配分（H-L をまたぐビンに按分）
  for (const p of prices) {
    const span = p.high - p.low || step;
    const perPrice = p.volume / span;
    const b0 = Math.max(0, Math.floor((p.low - lo) / step));
    const b1 = Math.min(nBins - 1, Math.floor((p.high - lo) / step));
    for (let b = b0; b <= b1; b++) {
      const binLow = lo + b * step;
      const binHigh = binLow + step;
      const overlap = Math.min(p.high, binHigh) - Math.max(p.low, binLow);
      if (overlap > 0) vol[b] += perPrice * overlap;
    }
  }

  const total = vol.reduce((s, v) => s + v, 0);
  const maxVol = Math.max(...vol);
  const pocIdx = vol.indexOf(maxVol);

  // バリューエリア: POCから上下に広げ出来高70%を含む
  let vaVol = vol[pocIdx];
  let up = pocIdx + 1, dn = pocIdx - 1;
  const target = total * 0.7;
  while (vaVol < target && (up < nBins || dn >= 0)) {
    const upVol = up < nBins ? vol[up] : -1;
    const dnVol = dn >= 0 ? vol[dn] : -1;
    if (upVol >= dnVol) { if (up < nBins) { vaVol += vol[up]; up++; } }
    else { if (dn >= 0) { vaVol += vol[dn]; dn--; } }
  }
  const vaLowIdx = dn + 1, vaHighIdx = up - 1;
  const meanVol = total / nBins;

  const bins: ProfileBin[] = vol.map((v, b) => {
    const priceLow = lo + b * step;
    return {
      priceLow,
      priceHigh: priceLow + step,
      mid: priceLow + step / 2,
      volume: v,
      inValueArea: b >= vaLowIdx && b <= vaHighIdx,
      isPOC: b === pocIdx,
      isHVN: v > meanVol * 1.5,
      isLVN: v < meanVol * 0.5,
    };
  });

  return {
    bins,
    poc: lo + (pocIdx + 0.5) * step,
    vaHigh: lo + (vaHighIdx + 1) * step,
    vaLow: lo + vaLowIdx * step,
    maxVol,
    currentPrice: prices[prices.length - 1].close,
  };
}
