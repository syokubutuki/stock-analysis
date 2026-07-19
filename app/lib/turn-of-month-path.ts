// 月内位置(月初・中旬・月末) × 当日日内の平均累積パス。
//
// 月末リバランス・給与流入等に伴う「月替わり(turn-of-month)効果」が、日次リターンだけでなく
// 日内の値動きの“形”に現れるかを見る。各立会日をその月の営業日並びの中で
// 月初(先頭K日)/月末(末尾K日)/中旬(それ以外)に分類し、寄り基準の累積対数リターンを群別に平均する。
//
// 集計は intraday-path-core に委譲(曜日版と同じ枠組み。層別軸だけ月内位置に差し替え)。

import { DayData, BinGrid } from "./intraday-core";
import { dayCumPath } from "./us-spillover-core";
import { PathGroup, PathStat, PairDiff, buildPathStats, pairwiseEndDiffs } from "./intraday-path-core";

const GROUP_META = [
  { key: "start", label: "月初", color: "#16a34a" }, // 先頭K営業日
  { key: "mid", label: "中旬", color: "#9ca3af" },
  { key: "end", label: "月末", color: "#dc2626" }, // 末尾K営業日
] as const;

export type TomPathBin = PathStat & { group: string };

export interface TomPathDay {
  date: string;
  close: number;
  group: string; // "start" | "mid" | "end"
}

export interface TomPathResult {
  bins: TomPathBin[];
  timeLabels: string[];
  maxAbs: number;
  days: TomPathDay[];
  pairDiffs: PairDiff[];
  window: number; // 月初/月末とみなす営業日数K
}

// 各立会日を、その暦月の営業日並びの中での位置で月初/中旬/月末に分類する。
// K日以内が月初・月末の両方に該当する短い月は、より近い境界に寄せる。
function classifyByMonth(rows: DayData[], K: number): Map<string, string> {
  const byMonth = new Map<string, DayData[]>();
  for (const d of rows) {
    const key = d.date.slice(0, 7); // YYYY-MM
    const arr = byMonth.get(key);
    if (arr) arr.push(d); else byMonth.set(key, [d]);
  }
  const out = new Map<string, string>();
  for (const [, arr] of byMonth) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
    const n = arr.length;
    arr.forEach((d, p) => {
      const fromStart = p, fromEnd = n - 1 - p;
      let g: string;
      if (fromStart < K && fromEnd < K) g = fromStart <= fromEnd ? "start" : "end";
      else if (fromStart < K) g = "start";
      else if (fromEnd < K) g = "end";
      else g = "mid";
      out.set(d.date, g);
    });
  }
  return out;
}

export function computeTurnOfMonthPaths(
  days: DayData[], grid: BinGrid | null, gmtoffset: number, window = 3
): TomPathResult | null {
  if (!grid) return null;
  const rows = days.filter((d) => d.open > 0);
  if (rows.length < 8) return null;
  const G = grid.bins.length;
  const cls = classifyByMonth(rows, window);

  const groups: PathGroup[] = GROUP_META.map((m) => {
    const gRows = rows.filter((d) => cls.get(d.date) === m.key);
    return {
      key: m.key, label: m.label, color: m.color,
      paths: gRows.map((d) => dayCumPath(d, grid, gmtoffset)),
      dates: gRows.map((d) => d.date),
    };
  });

  const { stats, maxAbs } = buildPathStats(groups, G);
  const bins: TomPathBin[] = stats.map((s) => ({ ...s, group: s.key }));
  const pairDiffs = pairwiseEndDiffs(stats);

  const outDays: TomPathDay[] = rows
    .map((d) => ({ date: d.date, close: d.close, group: cls.get(d.date) ?? "mid" }))
    .sort((p, q) => p.date.localeCompare(q.date));

  return { bins, timeLabels: grid.bins.map((x) => x.label), maxAbs, days: outDays, pairDiffs, window };
}
