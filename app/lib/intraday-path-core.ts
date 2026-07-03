// 日内累積パスを「群(曜日・月内位置・条件セル等)」で層別集計する共通土台。
//
// weekday-intraday-path / turn-of-month-path / 曜日×米国交互作用 が共有する。
// 各群の平均パス・中央値パス・95%帯(平均±1.96SE)・ピーク/ボトム時刻・終端(寄り→引け)の
// 平均と有意性を算出し、さらに群間で終端が有意に異なるかのペア比較(Welch t + FDR)を行う。

import { mean, std, median, tTest, benjaminiHochberg } from "./stats-significance";
import { studentTwoSidedP } from "./us-spillover-core";

// 1群 = 同じラベルに属する日の累積パス集合。各 path は長さ G(時間ビン数)。
export interface PathGroup {
  key: string;
  label: string;
  color: string;
  paths: number[][];
}

export interface PathStat {
  key: string;
  label: string;
  color: string;
  n: number;
  mean: number[]; // 各時間ビンの平均累積リターン
  med: number[]; // 各時間ビンの中央値累積リターン(外れ値に頑健)
  lo: number[]; // 平均 − 1.96·SE
  hi: number[]; // 平均 + 1.96·SE
  endMean: number; // 寄り→引けの平均(平均パス終端)
  endMed: number; // 寄り→引けの中央値
  endP: number; // 終端平均が0と異なるかの1標本t検定p値
  endValues: number[]; // 各日の終端(寄り→引け)累積リターン。群間比較に使う
  peakIdx: number; // 平均パスが最大になる時間ビン
  troughIdx: number; // 平均パスが最小になる時間ビン
}

// 群間で終端リターンが異なるかのペア比較(Welchの2標本t検定 → BHでFDR補正)。
export interface PairDiff {
  i: number; // stats のインデックス
  j: number;
  diff: number; // endMean_i − endMean_j
  p: number; // 生p値
  pAdj: number; // FDR補正後p値
}

export function buildPathStats(groups: PathGroup[], G: number): { stats: PathStat[]; maxAbs: number } {
  let maxAbs = 1e-6;
  const stats: PathStat[] = groups.map((grp) => {
    const mat = grp.paths;
    const m = new Array(G).fill(0), md = new Array(G).fill(0), lo = new Array(G).fill(0), hi = new Array(G).fill(0);
    if (mat.length > 0) {
      for (let g = 0; g < G; g++) {
        const col = mat.map((p) => p[g]);
        const mm = mean(col), se = mat.length > 1 ? std(col) / Math.sqrt(mat.length) : 0;
        m[g] = mm; md[g] = median(col); lo[g] = mm - 1.96 * se; hi[g] = mm + 1.96 * se;
        maxAbs = Math.max(maxAbs, Math.abs(hi[g]), Math.abs(lo[g]), Math.abs(md[g]));
      }
    }
    // ピーク/ボトム(平均パスの最大・最小時間ビン)
    let peakIdx = 0, troughIdx = 0;
    for (let g = 1; g < G; g++) {
      if (m[g] > m[peakIdx]) peakIdx = g;
      if (m[g] < m[troughIdx]) troughIdx = g;
    }
    const endValues = mat.map((p) => p[G - 1]);
    const tt = tTest(endValues);
    return {
      key: grp.key, label: grp.label, color: grp.color, n: mat.length,
      mean: m, med: md, lo, hi,
      endMean: m[G - 1], endMed: md[G - 1], endP: tt ? tt.p : 1,
      endValues, peakIdx, troughIdx,
    };
  });
  return { stats, maxAbs };
}

// Welch(等分散を仮定しない)2標本t検定の両側p値。
function welchP(a: number[], b: number[]): { t: number; p: number } | null {
  const n1 = a.length, n2 = b.length;
  if (n1 < 3 || n2 < 3) return null;
  const m1 = mean(a), m2 = mean(b);
  const v1 = std(a) ** 2, v2 = std(b) ** 2;
  const s = v1 / n1 + v2 / n2;
  if (s <= 0) return null;
  const t = (m1 - m2) / Math.sqrt(s);
  const df = (s * s) / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
  return { t, p: studentTwoSidedP(t, df) };
}

// 全群ペアの終端リターン差を検定し、FDR補正後p値を付す。
export function pairwiseEndDiffs(stats: PathStat[]): PairDiff[] {
  const pairs: { i: number; j: number; diff: number; p: number }[] = [];
  for (let i = 0; i < stats.length; i++) {
    for (let j = i + 1; j < stats.length; j++) {
      if (stats[i].n < 3 || stats[j].n < 3) continue;
      const w = welchP(stats[i].endValues, stats[j].endValues);
      if (!w) continue;
      pairs.push({ i, j, diff: stats[i].endMean - stats[j].endMean, p: w.p });
    }
  }
  const adj = benjaminiHochberg(pairs.map((x) => x.p));
  return pairs.map((x, k) => ({ ...x, pAdj: adj[k] }));
}
