// 曜日 × 当日日内の平均累積パス。
//
// 各立会日を曜日(月〜金)で層別し、寄り(open)を基準にした累積対数リターン
// r(t)=ln(P_t/open) の日内平均パスを曜日ごとに描く。「月曜は寄り天で垂れやすい」
// 「金曜は後場に伸びる」といった曜日固有の日内の“形”を直接可視化する。
//
// 集計は共通土台 intraday-path-core.buildPathStats に委譲し、平均/中央値/95%帯/
// ピーク・ボトム時刻/終端有意性/群間差(pairwiseEndDiffs)を得る。

import { DayData, BinGrid } from "./intraday-core";
import { dayCumPath } from "./us-spillover-core";
import { PathGroup, PathStat, PairDiff, buildPathStats, pairwiseEndDiffs } from "./intraday-path-core";

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

export type WeekdayPathBin = PathStat & { weekday: number };

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
  pairDiffs: PairDiff[]; // 曜日ペアの終端差(Welch t + FDR)
}

export function computeWeekdayPaths(
  days: DayData[], grid: BinGrid | null, gmtoffset: number
): WeekdayPathResult | null {
  if (!grid) return null;
  const rows = days.filter((d) => d.open > 0 && WD_ORDER.includes(d.weekday));
  if (rows.length < 8) return null;
  const G = grid.bins.length;

  const groups: PathGroup[] = WD_ORDER.map((wd) => ({
    key: String(wd), label: WD_LABELS[wd], color: WD_COLORS[wd],
    paths: rows.filter((d) => d.weekday === wd).map((d) => dayCumPath(d, grid, gmtoffset)),
  }));

  const { stats, maxAbs } = buildPathStats(groups, G);
  const bins: WeekdayPathBin[] = stats.map((s, i) => ({ ...s, weekday: WD_ORDER[i] }));
  const pairDiffs = pairwiseEndDiffs(stats);

  const outDays: WeekdayPathDay[] = rows
    .map((d) => ({ date: d.date, close: d.close, weekday: d.weekday }))
    .sort((p, q) => p.date.localeCompare(q.date));

  return { bins, timeLabels: grid.bins.map((x) => x.label), maxAbs, days: outDays, pairDiffs };
}
