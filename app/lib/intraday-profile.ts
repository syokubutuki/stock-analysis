// 時間帯プロファイル分析（A1 ボラ/出来高U字, A2 方向ドリフト, A3 オープニングレンジ,
// D2 曜日×時刻ヒートマップ）。日中足を時刻ビンに畳み込み、いつ動くか・いつ約定しやすいか・
// 曜日×時刻の複合エッジを統計的有意性つきで抽出する。

import {
  IntradayBar, groupByDay, buildBinGrid, binIndexOfMinute, localMinute, logReturn,
} from "./intraday-core";
import { tTest, benjaminiHochberg } from "./stats-significance";

// ───────────────────────── A1/A2: 時間帯プロファイル ─────────────────────────

export interface ProfileBin {
  startMinute: number;
  label: string;
  rangePct: number;    // 平均値幅 (high-low)/open（%）
  absRetPct: number;   // 平均 |log(C/O)|（%）
  volumeShare: number; // 1日の出来高に占める平均割合
  driftPct: number;    // 平均 log(C/O)（符号付き, %）
  driftP: number;      // FDR補正後p値
  driftSignif: boolean;
  n: number;           // 集計バー数
}

export interface ProfileResult {
  nDays: number;
  binMinutes: number;
  bins: ProfileBin[];
  cumDriftPct: number[]; // 累積ドリフト（始値比の平均的な1日の形, %）
  sessionStart: number;
  sessionEnd: number;
}

export function computeIntradayProfile(
  bars: IntradayBar[], gmtoffset: number, binMinutes = 30
): ProfileResult | null {
  if (!bars || bars.length === 0) return null;
  const grid = buildBinGrid(bars, gmtoffset, binMinutes);
  if (!grid) return null;
  const nBins = grid.bins.length;
  const days = groupByDay(bars, gmtoffset);
  if (days.length === 0) return null;

  // ビンごとに各指標のサンプルを貯める
  const rangeAcc: number[] = new Array(nBins).fill(0);
  const absAcc: number[] = new Array(nBins).fill(0);
  const cnt: number[] = new Array(nBins).fill(0);
  const volShareAcc: number[] = new Array(nBins).fill(0); // 出来高シェアの日平均用
  const volShareDays: number[] = new Array(nBins).fill(0);
  const driftSamples: number[][] = Array.from({ length: nBins }, () => []);

  for (const day of days) {
    const dayVol = day.bars.reduce((s, b) => s + (b.volume || 0), 0);
    const binVol = new Array(nBins).fill(0);
    const binHasBar = new Array(nBins).fill(false);
    for (const b of day.bars) {
      const idx = binIndexOfMinute(localMinute(b.ts, gmtoffset), grid);
      if (b.open > 0) {
        rangeAcc[idx] += (b.high - b.low) / b.open;
        absAcc[idx] += Math.abs(logReturn(b.open, b.close));
        cnt[idx] += 1;
        driftSamples[idx].push(logReturn(b.open, b.close));
      }
      binVol[idx] += b.volume || 0;
      binHasBar[idx] = true;
    }
    if (dayVol > 0) {
      for (let i = 0; i < nBins; i++) {
        if (binHasBar[i]) {
          volShareAcc[i] += binVol[i] / dayVol;
          volShareDays[i] += 1;
        }
      }
    }
  }

  // FDR用に各ビンの生p値
  const rawP: number[] = new Array(nBins).fill(1);
  const tStats = driftSamples.map((s) => tTest(s));
  for (let i = 0; i < nBins; i++) rawP[i] = tStats[i]?.p ?? 1;
  const adjP = benjaminiHochberg(rawP);

  const bins: ProfileBin[] = [];
  const cumDriftPct: number[] = [];
  let cum = 0;
  for (let i = 0; i < nBins; i++) {
    const c = cnt[i] || 1;
    const drift = driftSamples[i].length
      ? driftSamples[i].reduce((s, v) => s + v, 0) / driftSamples[i].length : 0;
    cum += drift;
    cumDriftPct.push(cum * 100);
    bins.push({
      startMinute: grid.bins[i].startMinute,
      label: grid.bins[i].label,
      rangePct: (rangeAcc[i] / c) * 100,
      absRetPct: (absAcc[i] / c) * 100,
      volumeShare: volShareDays[i] ? volShareAcc[i] / volShareDays[i] : 0,
      driftPct: drift * 100,
      driftP: adjP[i],
      driftSignif: adjP[i] < 0.05 && driftSamples[i].length >= 10,
      n: cnt[i],
    });
  }

  return {
    nDays: days.length, binMinutes, bins, cumDriftPct,
    sessionStart: grid.sessionStart, sessionEnd: grid.sessionEnd,
  };
}

// ───────────────────────── A3: オープニングレンジ ─────────────────────────

export interface OpeningRangeResult {
  orMinutes: number;
  nDays: number;
  highInOrShare: number;   // 当日高値がOR内で確定した割合
  lowInOrShare: number;
  upBreakDays: number;
  upFollowThrough: number; // 上抜け日のうち引けもORH超で終えた割合
  downBreakDays: number;
  downFollowThrough: number;
  expUpRetPct: number;     // 上抜け日の (引け/ブレイク価格 - 1) 平均（%）
  expDownRetPct: number;
  reach1R: number;         // ブレイク日のうち 1×ORW 方向拡張に到達した割合
  reach2R: number;
  meanOrWidthPct: number;  // ORW/open 平均（%）
}

export function computeOpeningRange(
  bars: IntradayBar[], gmtoffset: number, orMinutes = 30
): OpeningRangeResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length === 0) return null;

  let highInOr = 0, lowInOr = 0;
  let upDays = 0, upFollow = 0, downDays = 0, downFollow = 0;
  const upRets: number[] = [], downRets: number[] = [];
  let reach1 = 0, reach2 = 0, breakDays = 0;
  const orWidths: number[] = [];

  for (const day of days) {
    const bs = day.bars;
    if (bs.length < 3) continue;
    const startMin = localMinute(bs[0].ts, gmtoffset);
    let orH = -Infinity, orL = Infinity, orEndIdx = 0;
    for (let i = 0; i < bs.length; i++) {
      const m = localMinute(bs[i].ts, gmtoffset);
      if (m - startMin < orMinutes) {
        if (bs[i].high > orH) orH = bs[i].high;
        if (bs[i].low < orL) orL = bs[i].low;
        orEndIdx = i;
      } else break;
    }
    if (!isFinite(orH) || !isFinite(orL) || orEndIdx >= bs.length - 1) continue;
    const orW = orH - orL;
    if (orW <= 0) continue;
    if (day.open > 0) orWidths.push(orW / day.open);

    // OR後のバー
    const rest = bs.slice(orEndIdx + 1);
    if (day.high <= orH + 1e-12) highInOr++;
    if (day.low >= orL - 1e-12) lowInOr++;

    // 最初のブレイク方向
    let brokeUp = false, brokeDown = false, breakPrice = NaN;
    let maxUpExt = 0, maxDownExt = 0;
    for (const b of rest) {
      if (!brokeUp && !brokeDown) {
        if (b.high > orH) { brokeUp = true; breakPrice = orH; }
        else if (b.low < orL) { brokeDown = true; breakPrice = orL; }
      }
      if (brokeUp) maxUpExt = Math.max(maxUpExt, b.high - orH);
      if (brokeDown) maxDownExt = Math.max(maxDownExt, orL - b.low);
    }

    if (brokeUp) {
      upDays++; breakDays++;
      if (day.close > orH) upFollow++;
      if (breakPrice > 0) upRets.push((day.close - breakPrice) / breakPrice);
      if (maxUpExt >= orW) reach1++;
      if (maxUpExt >= 2 * orW) reach2++;
    } else if (brokeDown) {
      downDays++; breakDays++;
      if (day.close < orL) downFollow++;
      if (breakPrice > 0) downRets.push((day.close - breakPrice) / breakPrice);
      if (maxDownExt >= orW) reach1++;
      if (maxDownExt >= 2 * orW) reach2++;
    }
  }

  const n = days.length;
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  return {
    orMinutes, nDays: n,
    highInOrShare: highInOr / n,
    lowInOrShare: lowInOr / n,
    upBreakDays: upDays,
    upFollowThrough: upDays ? upFollow / upDays : 0,
    downBreakDays: downDays,
    downFollowThrough: downDays ? downFollow / downDays : 0,
    expUpRetPct: mean(upRets) * 100,
    expDownRetPct: mean(downRets) * 100,
    reach1R: breakDays ? reach1 / breakDays : 0,
    reach2R: breakDays ? reach2 / breakDays : 0,
    meanOrWidthPct: mean(orWidths) * 100,
  };
}

// ───────────────────────── D2: 曜日 × 時刻 ─────────────────────────

export interface WeekdayTimeCell {
  driftPct: number;
  p: number;
  signif: boolean;
  n: number;
}
export interface WeekdayTimeResult {
  binLabels: string[];
  binStartMinutes: number[];
  weekdays: number[]; // 表示する曜日（実在するもの, 1..5想定）
  grid: WeekdayTimeCell[][]; // [weekdayRow][binCol]
  nDaysByWeekday: Record<number, number>;
  minNHidden: number; // この閾値未満のセルは参考外
}

export function computeWeekdayTimeProfile(
  bars: IntradayBar[], gmtoffset: number, binMinutes = 30, minN = 8
): WeekdayTimeResult | null {
  const grid = buildBinGrid(bars, gmtoffset, binMinutes);
  if (!grid) return null;
  const nBins = grid.bins.length;
  const days = groupByDay(bars, gmtoffset);
  if (days.length === 0) return null;

  const weekdaysSet = new Set<number>();
  for (const d of days) weekdaysSet.add(d.weekday);
  const weekdays = [...weekdaysSet].sort((a, b) => a - b);
  const wdIndex = new Map(weekdays.map((w, i) => [w, i]));

  // [wdRow][bin] → log(C/O) サンプル
  const samples: number[][][] = weekdays.map(() => Array.from({ length: nBins }, () => [] as number[]));
  const nDaysByWeekday: Record<number, number> = {};
  for (const w of weekdays) nDaysByWeekday[w] = 0;

  for (const day of days) {
    nDaysByWeekday[day.weekday] += 1;
    const row = wdIndex.get(day.weekday)!;
    for (const b of day.bars) {
      if (b.open <= 0) continue;
      const idx = binIndexOfMinute(localMinute(b.ts, gmtoffset), grid);
      samples[row][idx].push(logReturn(b.open, b.close));
    }
  }

  // 全セルの生p → FDR
  const flatP: number[] = [];
  const tCache: ({ t: number; p: number } | null)[][] = [];
  for (let r = 0; r < weekdays.length; r++) {
    tCache.push([]);
    for (let c = 0; c < nBins; c++) {
      const t = tTest(samples[r][c]);
      tCache[r].push(t);
      flatP.push(t?.p ?? 1);
    }
  }
  const adjFlat = benjaminiHochberg(flatP);

  const out: WeekdayTimeCell[][] = [];
  let k = 0;
  for (let r = 0; r < weekdays.length; r++) {
    const rowCells: WeekdayTimeCell[] = [];
    for (let c = 0; c < nBins; c++) {
      const s = samples[r][c];
      const drift = s.length ? s.reduce((a, v) => a + v, 0) / s.length : 0;
      const p = adjFlat[k++];
      rowCells.push({
        driftPct: drift * 100,
        p,
        signif: p < 0.05 && s.length >= minN,
        n: s.length,
      });
    }
    out.push(rowCells);
  }

  return {
    binLabels: grid.bins.map((b) => b.label),
    binStartMinutes: grid.bins.map((b) => b.startMinute),
    weekdays,
    grid: out,
    nDaysByWeekday,
    minNHidden: minN,
  };
}
