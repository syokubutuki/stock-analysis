// B4: 当日内 MFE/MAE（最大含み益・最大含み損）と TP/SL グリッド最適化。
// 寄りでエントリーした場合の当日内の含み益/損の経路を測り、利確(TP)・損切り(SL)・
// 時間切りの期待値を格子探索して日計りのルールを最適化する。

import { IntradayBar, groupByDay, medianOf, meanOf, localMinute, minuteToLabel } from "./intraday-core";

export type Direction = "long" | "short";

export interface HistBin { center: number; count: number; }
export interface TimeBin { label: string; count: number; }
export interface GridCell { tpPct: number; slPct: number; expR: number; winRate: number; }

export interface ExcursionResult {
  nDays: number;
  direction: Direction;
  meanMfePct: number; medMfePct: number;
  meanMaePct: number; medMaePct: number;
  mfeHist: HistBin[];
  maeHist: HistBin[];
  mfeTimeHist: TimeBin[];
  maeTimeHist: TimeBin[];
  tpLevels: number[]; // %
  slLevels: number[]; // %
  grid: GridCell[][]; // [tpRow][slCol]
  best: { tpPct: number; slPct: number; expR: number; winRate: number } | null;
  medRangePct: number;
}

function histogram(values: number[], nBins = 16): HistBin[] {
  if (values.length === 0) return [];
  const lo = Math.min(...values), hi = Math.max(...values);
  if (hi <= lo) return [{ center: lo, count: values.length }];
  const w = (hi - lo) / nBins;
  const bins: HistBin[] = Array.from({ length: nBins }, (_, i) => ({ center: lo + w * (i + 0.5), count: 0 }));
  for (const v of values) {
    let idx = Math.floor((v - lo) / w);
    if (idx >= nBins) idx = nBins - 1;
    if (idx < 0) idx = 0;
    bins[idx].count++;
  }
  return bins;
}

export function computeExcursion(
  bars: IntradayBar[], gmtoffset: number, direction: Direction = "long"
): ExcursionResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length === 0) return null;

  const mfes: number[] = [], maes: number[] = [];
  const mfeTimes: number[] = [], maeTimes: number[] = [];
  const ranges: number[] = [];

  // 各日のバー列（TP/SL格子探索で再利用）
  type DayPath = { E: number; bars: IntradayBar[] };
  const paths: DayPath[] = [];

  for (const day of days) {
    const bs = day.bars;
    if (bs.length < 3) continue;
    const E = bs[0].open;
    if (E <= 0) continue;
    paths.push({ E, bars: bs });
    ranges.push((day.high - day.low) / E);

    let bestFav = -Infinity, worstAdv = Infinity, tFav = 0, tAdv = 0;
    for (const b of bs) {
      const fav = direction === "long" ? (b.high - E) / E : (E - b.low) / E;
      const adv = direction === "long" ? (b.low - E) / E : (E - b.high) / E;
      if (fav > bestFav) { bestFav = fav; tFav = localMinute(b.ts, gmtoffset); }
      if (adv < worstAdv) { worstAdv = adv; tAdv = localMinute(b.ts, gmtoffset); }
    }
    mfes.push(bestFav * 100);
    maes.push(worstAdv * 100);
    mfeTimes.push(tFav);
    maeTimes.push(tAdv);
  }

  if (paths.length === 0) return null;

  const medRange = medianOf(ranges); // 始値比の日中レンジ中央値
  const tpFracs = [0.25, 0.5, 0.75, 1.0, 1.5];
  const slFracs = [0.25, 0.5, 0.75, 1.0];
  const tpLevels = tpFracs.map((f) => f * medRange);
  const slLevels = slFracs.map((f) => f * medRange);

  // TP/SL 格子探索（保守的: 同一バーでTP/SL両ヒットはSL優先）
  const grid: GridCell[][] = [];
  let best: ExcursionResult["best"] = null;
  for (const tp of tpLevels) {
    const row: GridCell[] = [];
    for (const sl of slLevels) {
      const Rs: number[] = [];
      for (const { E, bars: bs } of paths) {
        const tpPrice = direction === "long" ? E * (1 + tp) : E * (1 - tp);
        const slPrice = direction === "long" ? E * (1 - sl) : E * (1 + sl);
        let resultRet = (bs[bs.length - 1].close - E) / E * (direction === "long" ? 1 : -1); // 時間切り(引け)
        for (const b of bs) {
          const hitSL = direction === "long" ? b.low <= slPrice : b.high >= slPrice;
          const hitTP = direction === "long" ? b.high >= tpPrice : b.low <= tpPrice;
          if (hitSL) { resultRet = -sl; break; }
          if (hitTP) { resultRet = tp; break; }
        }
        Rs.push(sl > 0 ? resultRet / sl : 0); // R倍数
      }
      const expR = meanOf(Rs);
      const winRate = Rs.length ? Rs.filter((r) => r > 0).length / Rs.length : 0;
      const cell: GridCell = { tpPct: tp * 100, slPct: sl * 100, expR, winRate };
      row.push(cell);
      if (!best || expR > best.expR) best = { tpPct: tp * 100, slPct: sl * 100, expR, winRate };
    }
    grid.push(row);
  }

  const toTimeBins = (mins: number[]): TimeBin[] => {
    const map = new Map<number, number>();
    for (const m of mins) {
      const b = Math.floor(m / 30) * 30;
      map.set(b, (map.get(b) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([m, c]) => ({ label: minuteToLabel(m), count: c }));
  };

  return {
    nDays: paths.length, direction,
    meanMfePct: meanOf(mfes), medMfePct: medianOf(mfes),
    meanMaePct: meanOf(maes), medMaePct: medianOf(maes),
    mfeHist: histogram(mfes), maeHist: histogram(maes),
    mfeTimeHist: toTimeBins(mfeTimes), maeTimeHist: toTimeBins(maeTimes),
    tpLevels: tpLevels.map((v) => v * 100), slLevels: slLevels.map((v) => v * 100),
    grid, best, medRangePct: medRange * 100,
  };
}
