// 曜日 × 当日日内の平均累積パス。
//
// 各立会日を曜日(月〜金)で層別し、寄り(open)を基準にした累積対数リターン
// r(t)=ln(P_t/open) の日内平均パスを曜日ごとに描く。「月曜は寄り天で垂れやすい」
// 「金曜は後場に伸びる」といった曜日固有の日内の“形”を直接可視化する。
//
// us-spillover-path.ts(前夜米国ビンで層別)の姉妹版。層別軸を米国リターンから
// 曜日に差し替えただけで、累積パスの中核 dayCumPath / 時間格子 BinGrid はそのまま流用する。

import { DayData, BinGrid } from "./intraday-core";
import { dayCumPath } from "./us-spillover-core";
import { mean, std, tTest } from "./stats-significance";

// 月曜=1 .. 金曜=5。土日は取引所日中足に現れない前提だが、混入しても対象外になる。
const WD_ORDER = [1, 2, 3, 4, 5];
const WD_LABELS: Record<number, string> = { 1: "月曜", 2: "火曜", 3: "水曜", 4: "木曜", 5: "金曜" };
const WD_COLORS: Record<number, string> = {
  1: "#2563eb", // 月 青
  2: "#16a34a", // 火 緑
  3: "#f59e0b", // 水 橙
  4: "#db2777", // 木 桃
  5: "#7c3aed", // 金 紫
};

export interface WeekdayPathBin {
  weekday: number; // 1..5
  label: string;
  color: string;
  n: number;
  path: number[]; // 各時間ビンでの平均累積リターン
  lo: number[]; // 平均 − 1.96·SE
  hi: number[]; // 平均 + 1.96·SE
  endMean: number; // 寄り→引けの平均(パス終端)
  endP: number; // 終端が0と異なるかのt検定p値
}

// 原系列タイムライン用: 各立会日と、その曜日。
export interface WeekdayPathDay {
  date: string; // 立会日 YYYY-MM-DD
  close: number; // 日次終値(日中足の最終バー終値=原系列ライン)
  weekday: number; // 1..5
}

export interface WeekdayPathResult {
  bins: WeekdayPathBin[];
  timeLabels: string[];
  maxAbs: number; // 縦軸スケール
  days: WeekdayPathDay[]; // 各立会日の曜日(原系列色分け用)、日付昇順
}

export function computeWeekdayPaths(
  days: DayData[], grid: BinGrid | null, gmtoffset: number
): WeekdayPathResult | null {
  if (!grid) return null;
  const rows = days.filter((d) => d.open > 0 && WD_ORDER.includes(d.weekday));
  if (rows.length < 8) return null;
  const G = grid.bins.length;

  // 曜日ごとに各日の累積パスを集める。
  const byWd = new Map<number, number[][]>();
  for (const wd of WD_ORDER) byWd.set(wd, []);
  for (const d of rows) byWd.get(d.weekday)!.push(dayCumPath(d, grid, gmtoffset));

  // 原系列(日次終値)上での色分け用に、各立会日の曜日を日付昇順で保持。
  const outDays: WeekdayPathDay[] = rows
    .map((d) => ({ date: d.date, close: d.close, weekday: d.weekday }))
    .sort((p, q) => p.date.localeCompare(q.date));

  const bins: WeekdayPathBin[] = [];
  let maxAbs = 1e-6;
  for (const wd of WD_ORDER) {
    const mat = byWd.get(wd)!;
    const path = new Array(G).fill(0), lo = new Array(G).fill(0), hi = new Array(G).fill(0);
    if (mat.length > 0) {
      for (let g = 0; g < G; g++) {
        const col = mat.map((p) => p[g]);
        const m = mean(col), se = mat.length > 1 ? std(col) / Math.sqrt(mat.length) : 0;
        path[g] = m; lo[g] = m - 1.96 * se; hi[g] = m + 1.96 * se;
        maxAbs = Math.max(maxAbs, Math.abs(hi[g]), Math.abs(lo[g]));
      }
    }
    const endCol = mat.map((p) => p[G - 1]);
    const tt = tTest(endCol);
    bins.push({
      weekday: wd, label: WD_LABELS[wd], color: WD_COLORS[wd], n: mat.length,
      path, lo, hi, endMean: path[G - 1], endP: tt ? tt.p : 1,
    });
  }
  return { bins, timeLabels: grid.bins.map((x) => x.label), maxAbs, days: outDays };
}
