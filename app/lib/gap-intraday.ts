// D1: 寄りギャップ後の日中挙動。窓の方向・大小ごとに、窓埋め率・窓埋め時刻、
// gap-and-go（継続）か fade（窓埋め・反転）かを分足で実測する。

import { IntradayBar, groupByDay, localMinute, minuteToLabel, meanOf, medianOf, stdOf } from "./intraday-core";

export interface GapBucket {
  label: string;
  n: number;
  fillRate: number;     // 当日中に前日終値へ到達した割合
  medFillMin: number;   // 窓埋め時刻の中央値（到達した日のみ）
  contRate: number;     // gap方向に引けまで継続した割合
  closeMeanPct: number; // 寄り→引けの平均（%）
}
export interface GapIntradayResult {
  nDays: number;
  upGapDays: number;
  downGapDays: number;
  buckets: GapBucket[];
  fillTimeHist: { label: string; count: number }[];
}

export function computeGapIntraday(bars: IntradayBar[], gmtoffset: number): GapIntradayResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length < 5) return null;

  // ギャップの大きさ基準（中央絶対偏差的に）
  const gaps = days.map((d) => d.gap).filter((g) => !isNaN(g));
  if (gaps.length < 5) return null;
  const absMed = medianOf(gaps.map(Math.abs)) || stdOf(gaps) || 0.005;
  const bigTh = absMed * 1.5;

  type Row = { gap: number; fillMin: number | null; cont: boolean; closeRet: number };
  const rows: Row[] = [];
  const fillMins: number[] = [];
  let upDays = 0, downDays = 0;

  for (const day of days) {
    if (isNaN(day.gap) || day.gap === 0 || isNaN(day.prevClose)) continue;
    const up = day.gap > 0;
    if (up) upDays++; else downDays++;

    // 窓埋め: 前日終値水準への到達
    let fillMin: number | null = null;
    for (const b of day.bars) {
      const reached = up ? b.low <= day.prevClose : b.high >= day.prevClose;
      if (reached) { fillMin = localMinute(b.ts, gmtoffset); break; }
    }
    if (fillMin != null) fillMins.push(fillMin);

    const closeRet = day.open > 0 ? (day.close - day.open) / day.open : 0;
    const cont = up ? day.close > day.open : day.close < day.open;
    rows.push({ gap: day.gap, fillMin, cont, closeRet });
  }

  const classify = (g: number): number => {
    if (g <= -bigTh) return 0; // 大陰窓
    if (g < 0) return 1;       // 小陰窓
    if (g < bigTh) return 2;   // 小陽窓
    return 3;                  // 大陽窓
  };
  const labels = ["大きな下窓", "小さな下窓", "小さな上窓", "大きな上窓"];
  const buckets: GapBucket[] = labels.map((label, k) => {
    const grp = rows.filter((r) => classify(r.gap) === k);
    const filled = grp.filter((r) => r.fillMin != null).map((r) => r.fillMin as number);
    return {
      label, n: grp.length,
      fillRate: grp.length ? filled.length / grp.length : 0,
      medFillMin: filled.length ? medianOf(filled) : 0,
      contRate: grp.length ? grp.filter((r) => r.cont).length / grp.length : 0,
      closeMeanPct: meanOf(grp.map((r) => r.closeRet)) * 100,
    };
  });

  // 窓埋め時刻ヒストグラム（30分ビン）
  const map = new Map<number, number>();
  for (const m of fillMins) { const b = Math.floor(m / 30) * 30; map.set(b, (map.get(b) || 0) + 1); }
  const fillTimeHist = [...map.entries()].sort((a, b) => a[0] - b[0]).map(([m, c]) => ({ label: minuteToLabel(m), count: c }));

  return { nDays: days.length, upGapDays: upDays, downGapDays: downDays, buckets, fillTimeHist };
}
