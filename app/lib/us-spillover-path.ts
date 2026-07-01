// 方法1: 前夜米国の方向ビン × 当日日内の平均累積パス(イベントスタディ)。
//
// 前夜米国リターンでその日を層別し、寄り(open)を基準にした累積対数リターン r(t)=ln(P_t/open) の
// 日内平均パスをビンごとに描く。米国高の翌日が「ギャップ継続型(上げ続ける)」か
// 「寄り天フェード型(寄り後に戻す)」か、その“形”を直接可視化する。

import { AlignedDay, dayCumPath, assignBins, binMeta, BinScheme } from "./us-spillover-core";
import { BinGrid } from "./intraday-core";
import { mean, std, tTest } from "./stats-significance";

export interface PathBin {
  bin: number;
  label: string;
  color: string;
  n: number;
  path: number[]; // 各時間ビンでの平均累積リターン
  lo: number[]; // 平均 ± 1.96·SE
  hi: number[];
  endMean: number; // 寄り→引けの平均(パス終端)
  endP: number; // 終端が0と異なるかのt検定p値
}

export interface PathResult {
  bins: PathBin[];
  timeLabels: string[];
  maxAbs: number; // 縦軸スケール
}

export function computePaths(
  aligned: AlignedDay[], grid: BinGrid | null, gmtoffset: number, scheme: BinScheme
): PathResult | null {
  const rows = aligned.filter((a) => isFinite(a.us.ret));
  if (rows.length < 8 || !grid) return null;
  const binIdx = assignBins(rows.map((a) => a.us.ret), scheme);
  const meta = binMeta(scheme);
  const G = grid.bins.length;

  const byBin: number[][][] = Array.from({ length: meta.count }, () => []);
  rows.forEach((a, i) => byBin[binIdx[i]].push(dayCumPath(a.jp, grid, gmtoffset)));

  const bins: PathBin[] = [];
  let maxAbs = 1e-6;
  for (let b = 0; b < meta.count; b++) {
    const mat = byBin[b];
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
      bin: b, label: meta.labels[b], color: meta.colors[b], n: mat.length,
      path, lo, hi, endMean: path[G - 1], endP: tt ? tt.p : 1,
    });
  }
  return { bins, timeLabels: grid.bins.map((x) => x.label), maxAbs };
}
