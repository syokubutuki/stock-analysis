// A4: VWAP乖離の回帰・継続分析。
// 各営業日で寄りからの出来高加重平均(VWAP)を求め、価格の乖離を当日内の標準偏差で
// 標準化(Z)。Zの大きさ別に数バー先のリターンを集計し、「乖離は戻るか(平均回帰)/
// 伸びるか(トレンド)」を定量化する。日計りの押し目買い・乖離過大での利確に使う。

import { IntradayBar, groupByDay, logReturn, stdOf, minuteToLabel, localMinute } from "./intraday-core";

export interface VwapBucket {
  label: string;
  lo: number; // z下限（-Inf/+Infを含む）
  hi: number;
  n: number;
  meanFwdPct: number; // h バー先の平均リターン（%）
  winRate: number;
  medianFwdPct: number;
}

export interface VwapSampleDay {
  date: string;
  labels: string[];
  price: number[];
  vwap: number[];
  upper1: number[]; lower1: number[];
  upper2: number[]; lower2: number[];
}

export interface VwapResult {
  nDays: number;
  horizonBars: number;
  buckets: VwapBucket[];
  sample: VwapSampleDay | null;
  crossUpFollow: number;   // VWAP上抜け後 h バー先も上の割合
  crossDownFollow: number;
  crossUpN: number; crossDownN: number;
}

const BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: "Z<-2", lo: -Infinity, hi: -2 },
  { label: "-2..-1", lo: -2, hi: -1 },
  { label: "-1..0", lo: -1, hi: 0 },
  { label: "0..1", lo: 0, hi: 1 },
  { label: "1..2", lo: 1, hi: 2 },
  { label: "Z>2", lo: 2, hi: Infinity },
];

function bucketOf(z: number): number {
  for (let i = 0; i < BUCKETS.length; i++) {
    if (z >= BUCKETS[i].lo && z < BUCKETS[i].hi) return i;
  }
  return z >= 2 ? BUCKETS.length - 1 : 0;
}

export function computeVwap(
  bars: IntradayBar[], gmtoffset: number, horizonBars = 6
): VwapResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length === 0) return null;

  const fwdByBucket: number[][] = BUCKETS.map(() => []);
  let crossUpFollow = 0, crossUpN = 0, crossDownFollow = 0, crossDownN = 0;
  let sample: VwapSampleDay | null = null;

  days.forEach((day, di) => {
    const bs = day.bars;
    if (bs.length < horizonBars + 3) return;
    const vwap: number[] = [];
    let cumPV = 0, cumV = 0, cumTP = 0;
    for (let i = 0; i < bs.length; i++) {
      const tp = (bs[i].high + bs[i].low + bs[i].close) / 3;
      const v = bs[i].volume || 0;
      cumPV += tp * v; cumV += v; cumTP += tp;
      vwap.push(cumV > 0 ? cumPV / cumV : cumTP / (i + 1));
    }
    // 当日の乖離とその標準偏差
    const dev = bs.map((b, i) => (vwap[i] > 0 ? (b.close - vwap[i]) / vwap[i] : 0));
    const sigma = stdOf(dev);
    if (sigma <= 0) return;

    for (let i = 0; i < bs.length - horizonBars; i++) {
      const z = dev[i] / sigma;
      const fwd = logReturn(bs[i].close, bs[i + horizonBars].close);
      fwdByBucket[bucketOf(z)].push(fwd);
      // VWAPクロス
      if (i > 0) {
        const prevAbove = bs[i - 1].close >= vwap[i - 1];
        const curAbove = bs[i].close >= vwap[i];
        if (!prevAbove && curAbove) { crossUpN++; if (bs[i + horizonBars].close >= bs[i].close) crossUpFollow++; }
        if (prevAbove && !curAbove) { crossDownN++; if (bs[i + horizonBars].close <= bs[i].close) crossDownFollow++; }
      }
    }

    // 直近日を代表日サンプルに
    if (di === days.length - 1) {
      sample = {
        date: day.date,
        labels: bs.map((b) => minuteToLabel(localMinute(b.ts, gmtoffset))),
        price: bs.map((b) => b.close),
        vwap,
        upper1: vwap.map((v) => v * (1 + sigma)),
        lower1: vwap.map((v) => v * (1 - sigma)),
        upper2: vwap.map((v) => v * (1 + 2 * sigma)),
        lower2: vwap.map((v) => v * (1 - 2 * sigma)),
      };
    }
  });

  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const med = (a: number[]) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const buckets: VwapBucket[] = BUCKETS.map((b, i) => {
    const arr = fwdByBucket[i];
    return {
      label: b.label, lo: b.lo, hi: b.hi, n: arr.length,
      meanFwdPct: mean(arr) * 100,
      medianFwdPct: med(arr) * 100,
      winRate: arr.length ? arr.filter((v) => v > 0).length / arr.length : 0,
    };
  });

  return {
    nDays: days.length, horizonBars, buckets, sample,
    crossUpFollow: crossUpN ? crossUpFollow / crossUpN : 0,
    crossDownFollow: crossDownN ? crossDownFollow / crossDownN : 0,
    crossUpN, crossDownN,
  };
}
