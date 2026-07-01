// 方法4: ボラティリティ・スピルオーバー。
//
// 前夜米国の変動の「大きさ」|r_US| が、当日JPの日中実現ボラ/レンジをどれだけ膨らませるか。
// ボラのクラスタリング(荒れた日は荒れる)が国境を跨いで波及するかを検証し、建玉サイズや
// 日中ストラドル的判断の材料にする。加えて、|米|が大きい日ほどボラが寄り直後に前倒しされるか
// (日内ボラプロファイルの形)を層別して見る。

import { AlignedDay, ols, Regression, assignBins } from "./us-spillover-core";
import { BinGrid, garmanKlassVar, localMinute, binIndexOfMinute } from "./intraday-core";
import { mean } from "./stats-significance";

export interface VolSample { absUs: number; vol: number; range: number; date: string; }

export interface VolPathBin {
  label: string;
  color: string;
  n: number;
  path: number[]; // 各時間ビンの平均バーボラ(√GK分散)
}

export interface VolResult {
  n: number;
  volReg: Regression; // 実現ボラ ~ |r_US|
  rangeReg: Regression; // 高安レンジ ~ |r_US|
  samples: VolSample[];
  timeLabels: string[];
  volPaths: VolPathBin[]; // |US|大きさ3分位別の日内ボラプロファイル
  maxVol: number; // volPaths 縦軸スケール
}

// 1日のバー列を時間格子に写像し、各ビンのGK分散合計を返す。
function dayBinGk(day: AlignedDay["jp"], grid: BinGrid, gmtoffset: number): number[] {
  const arr = new Array(grid.bins.length).fill(0);
  for (const b of day.bars) {
    const m = localMinute(b.ts, gmtoffset);
    const bi = binIndexOfMinute(m, grid);
    arr[bi] += garmanKlassVar(b.open, b.high, b.low, b.close);
  }
  return arr;
}

const MAG_LABELS = ["米|変|小", "米|変|中", "米|変|大"];
const MAG_COLORS = ["#9ca3af", "#fb923c", "#dc2626"];

export function computeVol(
  aligned: AlignedDay[], grid: BinGrid | null, gmtoffset: number
): VolResult | null {
  const rows = aligned.filter((a) => isFinite(a.us.ret) && a.jp.high > 0 && a.jp.low > 0);
  if (rows.length < 8 || !grid) return null;
  const G = grid.bins.length;

  const absUs: number[] = [], vol: number[] = [], range: number[] = [];
  const gkByDay: number[][] = [];
  const samples: VolSample[] = [];
  for (const a of rows) {
    const gk = dayBinGk(a.jp, grid, gmtoffset);
    gkByDay.push(gk);
    const rv = gk.reduce((s, v) => s + v, 0);
    const rVol = Math.sqrt(Math.max(0, rv));
    const hl = Math.log(a.jp.high / a.jp.low);
    absUs.push(Math.abs(a.us.ret)); vol.push(rVol); range.push(hl);
    samples.push({ absUs: Math.abs(a.us.ret), vol: rVol, range: hl, date: a.jp.date });
  }

  const volReg = ols(absUs, vol);
  const rangeReg = ols(absUs, range);
  if (!volReg || !rangeReg) return null;

  // |US|大きさ3分位別 日内ボラプロファイル
  const magBin = assignBins(absUs, "tercile");
  const volPaths: VolPathBin[] = [];
  let maxVol = 1e-9;
  for (let b = 0; b < 3; b++) {
    const idxs = rows.map((_, i) => i).filter((i) => magBin[i] === b);
    const path = new Array(G).fill(0);
    for (let g = 0; g < G; g++) {
      const col = idxs.map((i) => Math.sqrt(Math.max(0, gkByDay[i][g])));
      path[g] = idxs.length ? mean(col) : 0;
      maxVol = Math.max(maxVol, path[g]);
    }
    volPaths.push({ label: MAG_LABELS[b], color: MAG_COLORS[b], n: idxs.length, path });
  }

  return { n: rows.length, volReg, rangeReg, samples, timeLabels: grid.bins.map((x) => x.label), volPaths, maxVol };
}
