// 3.3/3.4/3.5 出来高系指標群。
// RVOL（相対出来高）、VPT/Chaikin A-D/MFI/Force/EOM、符号付き出来高（買い/売り需要）を計算する。
// 価格と出来高の乖離（ダイバージェンス）検出に使う。

import { PricePoint } from "./types";

function sma(a: number[], i: number, w: number): number {
  if (i < w - 1) return NaN;
  let s = 0;
  for (let j = i - w + 1; j <= i; j++) s += a[j];
  return s / w;
}

export interface RvolPoint { time: string; rvol: number; z: number; volume: number; }

export function computeRVOL(prices: PricePoint[], window = 20): RvolPoint[] {
  const vols = prices.map((p) => p.volume);
  const out: RvolPoint[] = [];
  for (let i = window; i < prices.length; i++) {
    const seg = vols.slice(i - window, i); // 当日を除く過去window
    const m = seg.reduce((s, v) => s + v, 0) / window;
    const sd = Math.sqrt(seg.reduce((s, v) => s + (v - m) ** 2, 0) / window) || 1;
    out.push({ time: prices[i].time, rvol: m > 0 ? vols[i] / m : 1, z: (vols[i] - m) / sd, volume: vols[i] });
  }
  return out;
}

export type VolIndicator = "vpt" | "ad" | "mfi" | "force" | "eom";

export interface VolIndPoint {
  time: string;
  vpt: number; ad: number; mfi: number; force: number; eom: number;
}

export function computeVolIndicators(prices: PricePoint[]): VolIndPoint[] {
  const n = prices.length;
  const out: VolIndPoint[] = [];
  let vpt = 0, ad = 0;
  const forceRaw: number[] = [];
  const eomRaw: number[] = [];
  const tp: number[] = [];
  const rawMF: number[] = [];
  const posMF: number[] = [];
  const negMF: number[] = [];

  for (let i = 0; i < n; i++) {
    const { high: H, low: L, close: C, volume: V } = prices[i];
    const prevC = i > 0 ? prices[i - 1].close : C;
    // VPT
    if (i > 0 && prevC > 0) vpt += V * ((C - prevC) / prevC);
    // Chaikin A/D
    const mfm = H > L ? ((C - L) - (H - C)) / (H - L) : 0;
    ad += mfm * V;
    // Force raw
    forceRaw.push(i > 0 ? (C - prevC) * V : 0);
    // EOM raw
    if (i > 0) {
      const dm = (H + L) / 2 - (prices[i - 1].high + prices[i - 1].low) / 2;
      const box = H > L ? (V / 1e6) / (H - L) : 0;
      eomRaw.push(box > 0 ? dm / box : 0);
    } else eomRaw.push(0);
    // MFI
    const t = (H + L + C) / 3;
    tp.push(t);
    const rmf = t * V;
    rawMF.push(rmf);
    if (i > 0) {
      if (t > tp[i - 1]) { posMF.push(rmf); negMF.push(0); }
      else if (t < tp[i - 1]) { posMF.push(0); negMF.push(rmf); }
      else { posMF.push(0); negMF.push(0); }
    } else { posMF.push(0); negMF.push(0); }

    // Force(13 EMA) / EOM(14 SMA) / MFI(14)
    const forceEMA = i === 0 ? 0 : emaStep(forceRaw[i], out.length ? out[out.length - 1].force : forceRaw[i], 13);
    const eom14 = sma(eomRaw, i, 14);
    let mfi = NaN;
    if (i >= 14) {
      let p = 0, ng = 0;
      for (let k = i - 13; k <= i; k++) { p += posMF[k]; ng += negMF[k]; }
      mfi = ng > 0 ? 100 - 100 / (1 + p / ng) : 100;
    }
    out.push({ time: prices[i].time, vpt, ad, mfi, force: forceEMA, eom: isNaN(eom14) ? 0 : eom14 });
  }
  return out;
}

function emaStep(x: number, prev: number, period: number): number {
  const k = 2 / (period + 1);
  return x * k + prev * (1 - k);
}

export interface SignedVolResult {
  series: { time: string; upRatio: number; efficiency: number }[]; // ローリング
  upVolShare: number; // 全期間: 上昇日出来高 / 全出来高
  efficiency: number; // |価格変化| / 出来高（流動性）全期間
}

export function computeSignedVolume(prices: PricePoint[], window = 20): SignedVolResult {
  const n = prices.length;
  const series: { time: string; upRatio: number; efficiency: number }[] = [];
  let upVolAll = 0, totVolAll = 0;
  for (let i = window; i < n; i++) {
    let upVol = 0, downVol = 0, effSum = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const up = prices[j].close >= prices[j - 1].close;
      if (up) upVol += prices[j].volume; else downVol += prices[j].volume;
      const dc = Math.abs(prices[j].close - prices[j - 1].close);
      effSum += prices[j].volume > 0 ? dc / prices[j].volume : 0;
    }
    series.push({
      time: prices[i].time,
      upRatio: upVol + downVol > 0 ? upVol / (upVol + downVol) : 0.5,
      efficiency: effSum / window,
    });
  }
  for (let i = 1; i < n; i++) {
    const up = prices[i].close >= prices[i - 1].close;
    if (up) upVolAll += prices[i].volume;
    totVolAll += prices[i].volume;
  }
  return {
    series,
    upVolShare: totVolAll > 0 ? upVolAll / totVolAll : 0.5,
    efficiency: series.length ? series[series.length - 1].efficiency : 0,
  };
}
